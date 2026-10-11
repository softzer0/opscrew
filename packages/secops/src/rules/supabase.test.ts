import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, ScanContext } from "@opscrew/contracts";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupabaseScanner } from "./supabase";

const FIXTURES = fileURLToPath(new URL("../../test/fixtures/supabase/", import.meta.url));
const temps: string[] = [];

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, relative)));
    else out.push(relative);
  }
  return out.sort();
}

/**
 * `.env*` files are gitignored repository-wide, so they are written at runtime (with generated
 * fake keys) instead of living in the fixture tree.
 */
const ENV_FILES: Record<string, Record<string, () => string>> = {
  app: {
    ".env.local": () =>
      [
        "NEXT_PUBLIC_SUPABASE_URL=https://fakeprojectref00.supabase.co",
        `NEXT_PUBLIC_SUPABASE_ANON_KEY=${fakeSecret("supabase-anon-jwt")}`,
        `NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=${fakeSecret("supabase-service-role-jwt", "env")}`,
        `SUPABASE_SERVICE_ROLE_KEY=${fakeSecret("supabase-service-role-jwt", "server-env")}`,
        "",
      ].join("\n"),
  },
  "static-site": { ".env": () => "VITE_SUPABASE_SERVICE_ROLE_KEY=\n" },
};

/** Minimal offline `ScanContext` over a materialised copy of `test/fixtures/supabase/<name>`. */
async function fixtureContext(name: string): Promise<ScanContext> {
  const rootDir = await mkdtemp(join(tmpdir(), `opscrew-supabase-${name}-`));
  temps.push(rootDir);
  await materializeFixture(join(FIXTURES, name), rootDir);
  for (const [file, content] of Object.entries(ENV_FILES[name] ?? {})) {
    await writeFile(join(rootDir, file), content());
  }
  return {
    rootDir,
    files: await listFiles(rootDir),
    readFile: (relativePath) => readFile(join(rootDir, relativePath), "utf8"),
    offline: true,
    fetch: async () => {
      throw new Error("network is not allowed in this test");
    },
    runner: {
      run: async () => {
        throw new Error("subprocesses are not allowed in this test");
      },
    },
  };
}

/** In-memory context for small inline cases; `tracked` becomes `gitTracked` when given. */
function memoryContext(files: Record<string, string>, tracked?: readonly string[]): ScanContext {
  const context: ScanContext = {
    rootDir: "/virtual",
    files: Object.keys(files).sort(),
    readFile: async (relativePath) => {
      const text = files[relativePath];
      if (text === undefined) throw new Error(`missing ${relativePath}`);
      return text;
    },
    offline: true,
    fetch: async () => {
      throw new Error("network is not allowed in this test");
    },
    runner: {
      run: async () => {
        throw new Error("subprocesses are not allowed in this test");
      },
    },
  };
  if (tracked) context.gitTracked = new Set(tracked);
  return context;
}

/** A synthetic `sb_secret_` key, generated at runtime so no secret-shaped literal is committed. */
const sbSecret = (seed: string) => `sb_secret_${fakeSecret("cloudflare-token", seed)}`;
const serviceJwt = (seed: string) => fakeSecret("supabase-service-role-jwt", seed);

const scanner = createSupabaseScanner();
const byRule = (findings: Finding[], ruleId: string) => findings.filter((f) => f.ruleId === ruleId);
const at = (findings: Finding[]) => findings.map((f) => `${f.file}:${f.line}`).sort();

afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createSupabaseScanner", () => {
  it("is a builtin scanner that is always available", async () => {
    expect(scanner.id).toBe("opscrew-supabase");
    expect(scanner.kind).toBe("builtin");
    expect(await scanner.isAvailable(memoryContext({}))).toBe(true);
  });

  it("returns nothing for an empty project", async () => {
    expect(await scanner.scan(memoryContext({}))).toEqual([]);
  });
});

describe("Supabase fixture app", () => {
  let findings: Finding[];
  let rawJwts: string[];

  beforeAll(async () => {
    const context = await fixtureContext("app");
    findings = await scanner.scan(context);
    rawJwts = [
      fakeSecret("supabase-service-role-jwt"),
      fakeSecret("supabase-service-role-jwt", "env"),
      fakeSecret("supabase-service-role-jwt", "server"),
      fakeSecret("supabase-anon-jwt"),
    ];
  });

  it("flags a service-role JWT in frontend source as critical (positive)", () => {
    const hits = byRule(findings, "supabase/service-role-in-client");
    expect(at(hits)).toContain("src/lib/admin-client.ts:5");
    const hit = hits.find((f) => f.file === "src/lib/admin-client.ts");
    expect(hit).toMatchObject({
      severity: "critical",
      category: "supabase",
      source: "opscrew-supabase",
    });
    expect(hit?.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("flags a service-role JWT assigned to a client-prefixed env variable (positive)", () => {
    const hit = byRule(findings, "supabase/service-role-in-client").find(
      (f) => f.file === ".env.local",
    );
    expect(hit).toMatchObject({ line: 3, severity: "critical" });
  });

  it("flags client-exposed env names containing SERVICE_ROLE (positive)", () => {
    const hits = byRule(findings, "supabase/service-role-env-exposed");
    expect(at(hits)).toEqual(["src/components/AdminPanel.tsx:4"]);
    expect(hits[0]).toMatchObject({
      severity: "critical",
      evidence: "NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY",
    });
  });

  it("never reports anon keys (negative)", () => {
    expect(findings.some((f) => f.file === "src/lib/client.ts")).toBe(false);
    expect(findings.filter((f) => f.file === ".env.local").map((f) => f.line)).toEqual([3]);
  });

  it("reports a service-role key hard-coded in server code as a secret, not as client code (positive)", () => {
    const hits = findings.filter((f) => f.file === "server/admin.ts");
    expect(hits.map((f) => `${f.ruleId}:${f.line}`)).toEqual(["supabase/secret-key-in-source:3"]);
    // Not git-tracked in this fixture: high (critical once committed).
    expect(hits[0]).toMatchObject({ severity: "high", category: "secret" });
    expect(hits[0]?.evidence).toMatch(/^eyJh…\(\d+ chars\)$/);
  });

  it("leaves server-only env names in a real .env file to the secrets scanner (negative)", () => {
    expect(findings.some((f) => f.file === ".env.local" && f.line === 4)).toBe(false);
  });

  it("masks evidence and never leaks the raw key anywhere in a finding", () => {
    const serialised = JSON.stringify(findings);
    for (const jwt of rawJwts) expect(serialised).not.toContain(jwt);
    const hit = byRule(findings, "supabase/service-role-in-client")[0];
    expect(hit?.evidence).toMatch(/^eyJh…\(\d+ chars\)$/);
  });

  it("flags public tables without RLS at the create line, including unqualified and quoted names (positive)", () => {
    const hits = byRule(findings, "supabase/rls-disabled");
    expect(at(hits)).toEqual([
      "supabase/migrations/20240101000000_init.sql:10",
      "supabase/migrations/20240101000000_init.sql:16",
    ]);
    expect(hits.map((f) => f.title).sort()).toEqual([
      'Row-level security is not enabled on table "Orders"',
      'Row-level security is not enabled on table "todos"',
    ]);
    expect(hits.every((f) => f.severity === "high")).toBe(true);
  });

  it("accepts RLS enabled in the same or a later migration, and skips non-public, temporary, dropped, commented and quoted tables (negative)", () => {
    const titles = byRule(findings, "supabase/rls-disabled").map((f) => f.title);
    for (const table of [
      "profiles",
      "posts",
      "audit_log",
      "scratch",
      "dropped_later",
      "commented_out",
      "also_commented",
      "inside_function",
      "in_string",
    ]) {
      expect(titles.join("\n")).not.toContain(`"${table}"`);
    }
  });

  it("flags `with check (true)` write policies as high (positive)", () => {
    const hits = byRule(findings, "supabase/permissive-write-policy");
    expect(at(hits)).toEqual(["supabase/migrations/20240101000000_init.sql:43"]);
    expect(hits[0]?.severity).toBe("high");
    expect(hits[0]?.title).toContain("anyone can add todos");
  });

  it("ignores owner-scoped and service_role-only policies (negative)", () => {
    const titles = byRule(findings, "supabase/permissive-write-policy").map((f) => f.title);
    expect(titles.join("\n")).not.toMatch(/owners update posts|service role manages profiles/);
  });

  it("flags `using (true)` reads on tables with sensitive columns as medium (positive)", () => {
    const hits = byRule(findings, "supabase/public-read-sensitive");
    expect(at(hits)).toEqual(["supabase/migrations/20240101000000_init.sql:37"]);
    expect(hits[0]?.severity).toBe("medium");
    expect(hits[0]?.description).toContain("email, phone");
  });

  it("does not flag public reads of tables without sensitive columns (negative)", () => {
    const titles = byRule(findings, "supabase/public-read-sensitive").map((f) => f.title);
    expect(titles.join("\n")).not.toContain("posts are public");
  });

  it("flags write grants to anon as high but not read grants (positive and negative)", () => {
    const hits = byRule(findings, "supabase/anon-write-grant");
    expect(at(hits)).toEqual(["supabase/migrations/20240101000000_init.sql:51"]);
    expect(hits[0]?.severity).toBe("high");
  });

  it("flags public storage buckets as medium but not private ones (positive and negative)", () => {
    const hits = byRule(findings, "supabase/public-bucket");
    expect(hits.map((f) => f.title)).toEqual(['Public storage bucket "avatars"']);
    expect(hits[0]).toMatchObject({ severity: "medium", line: 54 });
  });

  it("is deterministic", async () => {
    const again = await scanner.scan(await fixtureContext("app"));
    expect(again.map((f) => f.id).sort()).toEqual(findings.map((f) => f.id).sort());
  });
});

describe("Supabase scanner on other project shapes", () => {
  it("flags a service-role key in a plain static site and a client-prefixed SERVICE_ROLE name in .env (positive)", async () => {
    const findings = await scanner.scan(await fixtureContext("static-site"));
    expect(findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`).sort()).toEqual([
      "supabase/service-role-env-exposed .env:1",
      "supabase/service-role-in-client index.html:5",
    ]);
  });

  it("ignores generic migrations in a project that does not use Supabase, and labels backend keys as hard-coded, not client code", async () => {
    const findings = await scanner.scan(await fixtureContext("plain-postgres"));
    expect(findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`)).toEqual([
      "supabase/secret-key-in-source index.js:3",
    ]);
  });

  it("parses SQL tolerantly: case, block comments, quoted identifiers, policies for all (positive)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "supabase/migrations/1.sql": [
          'CREATE TABLE "public"."Accounts" (id INT, /* note */ password TEXT);',
          'CREATE POLICY "open" ON "public"."Accounts" AS PERMISSIVE FOR ALL USING ((true));',
          "GRANT ALL ON ALL TABLES IN SCHEMA public TO anon;",
          "select storage.create_bucket('media', public => true);",
        ].join("\n"),
      }),
    );
    expect(findings.map((f) => `${f.ruleId}:${f.line}`).sort()).toEqual([
      "supabase/anon-write-grant:3",
      "supabase/permissive-write-policy:2",
      "supabase/public-bucket:4",
      "supabase/rls-disabled:1",
    ]);
  });

  it("treats RLS disabled after being enabled as disabled (positive) and restrictive policies as safe (negative)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "supabase/migrations/1.sql":
          "create table items (id int);\nalter table items enable row level security;\n" +
          "create policy p on items as restrictive for insert with check (true);\n",
        "supabase/migrations/2.sql": "alter table public.items disable row level security;\n",
      }),
    );
    expect(findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`)).toEqual([
      "supabase/rls-disabled supabase/migrations/1.sql:1",
    ]);
  });

  it("counts generic migrations folders once the project uses Supabase (positive)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "package.json": JSON.stringify({ dependencies: { "@supabase/supabase-js": "^2" } }),
        "db/migrations/001.sql": "create table notes (id int);\n",
      }),
    );
    expect(byRule(findings, "supabase/rls-disabled").map((f) => f.file)).toEqual([
      "db/migrations/001.sql",
    ]);
  });

  it("ignores grants of read-only or non-table privileges to anon (negative)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "supabase/migrations/1.sql":
          "grant usage on schema public to anon;\n" +
          "grant execute on all functions in schema public to anon;\n" +
          "grant select on public.feed to anon;\n" +
          "grant all on public.feed to authenticated;\n",
      }),
    );
    expect(findings).toEqual([]);
  });

  it("ignores placeholder secret keys and non-JWT strings in client code (negative)", async () => {
    const findings = await scanner.scan(
      memoryContext({
        "package.json": JSON.stringify({ dependencies: { react: "^19" } }),
        "src/config.ts":
          'export const key = "sb_secret_your-key-goes-here-xxxxxx";\n' +
          'export const token = "eyJnot.eyJajwt.at-all";\n',
      }),
    );
    expect(findings).toEqual([]);
  });
});

describe("Supabase secret keys outside client code", () => {
  const NEXT = JSON.stringify({ dependencies: { next: "^15", react: "^19" } });

  it("reports service-role JWTs and sb_secret_ keys in server files: critical when tracked, high otherwise (positive)", async () => {
    const files = {
      "package.json": JSON.stringify({ dependencies: { express: "^5" } }),
      "server/admin.js": `const key = "${serviceJwt("admin")}";\n`,
      "scripts/seed.py": `\nSUPABASE_SECRET_KEY = "${sbSecret("seed")}"\n`,
      "README.md": `Use \`${sbSecret("docs")}\` to connect.\n`,
    };
    const findings = await scanner.scan(memoryContext(files, ["server/admin.js", "README.md"]));
    expect(findings.map((f) => `${f.ruleId} ${f.file}:${f.line} ${f.severity}`).sort()).toEqual([
      "supabase/secret-key-in-source README.md:1 critical",
      "supabase/secret-key-in-source scripts/seed.py:2 high",
      "supabase/secret-key-in-source server/admin.js:1 critical",
    ]);
    const serialised = JSON.stringify(findings);
    for (const value of [serviceJwt("admin"), sbSecret("seed"), sbSecret("docs")]) {
      expect(serialised).not.toContain(value);
    }
    expect(findings.every((f) => f.category === "secret" && f.source === "opscrew-supabase")).toBe(
      true,
    );
  });

  it("labels Next.js route handlers and other server-only files inside frontend folders as server code (positive)", async () => {
    const line = `export const key = "${serviceJwt("route")}";\n`;
    const findings = await scanner.scan(
      memoryContext({
        "package.json": NEXT,
        "app/api/admin/route.ts": line,
        "src/app/api/users/route.ts": line,
        "app/(admin)/export/route.js": line,
        "pages/api/admin.ts": line,
        "src/lib/server/admin.ts": line,
        "app/routes/admin.server.ts": line,
        "src/middleware.ts": line,
        "app/page.tsx": line,
      }),
    );
    expect(findings.map((f) => `${f.ruleId} ${f.file}`).sort()).toEqual([
      "supabase/secret-key-in-source app/(admin)/export/route.js",
      "supabase/secret-key-in-source app/api/admin/route.ts",
      "supabase/secret-key-in-source app/routes/admin.server.ts",
      "supabase/secret-key-in-source pages/api/admin.ts",
      "supabase/secret-key-in-source src/app/api/users/route.ts",
      "supabase/secret-key-in-source src/lib/server/admin.ts",
      "supabase/secret-key-in-source src/middleware.ts",
      "supabase/service-role-in-client app/page.tsx",
    ]);
  });

  it("keeps Vite client folders named api or supabase as client code (negative for the server rule)", async () => {
    const line = `export const key = "${serviceJwt("vite")}";\n`;
    const findings = await scanner.scan(
      memoryContext({
        "package.json": JSON.stringify({ dependencies: { vite: "^7", react: "^19" } }),
        "src/api/admin.ts": line,
        "src/integrations/supabase/client.ts": line,
      }),
    );
    expect(findings.map((f) => `${f.ruleId} ${f.file}`).sort()).toEqual([
      "supabase/service-role-in-client src/api/admin.ts",
      "supabase/service-role-in-client src/integrations/supabase/client.ts",
    ]);
  });

  it("reports each line once, and a committed example env file as source (positive)", async () => {
    const findings = await scanner.scan(
      memoryContext(
        {
          "server/keys.ts": `const a = "${serviceJwt("a")}", b = "${sbSecret("b")}"; // NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY\n`,
          ".env.example": `SUPABASE_SERVICE_ROLE_KEY=${serviceJwt("example")}\n`,
        },
        [".env.example", "server/keys.ts"],
      ),
    );
    expect(findings.map((f) => `${f.ruleId} ${f.file}:${f.line}`).sort()).toEqual([
      "supabase/secret-key-in-source .env.example:1",
      "supabase/secret-key-in-source server/keys.ts:1",
    ]);
  });

  it("ignores anon keys, the CLI's public demo keys, placeholders, real .env files and binary files (negative)", async () => {
    const part = (claims: object) => Buffer.from(JSON.stringify(claims)).toString("base64url");
    const demo = [
      part({ alg: "HS256", typ: "JWT" }),
      part({ iss: "supabase-demo", role: "service_role", exp: 1983812996 }),
      "FAKEsignatureFAKEsignature",
    ].join(".");
    const findings = await scanner.scan(
      memoryContext(
        {
          "docker/test-env.ts": `const local = "${demo}";\n`,
          "server/client.ts": `const anon = "${fakeSecret("supabase-anon-jwt")}";\n`,
          "server/placeholder.ts": 'const key = "sb_secret_your-key-goes-here-xxxxxx";\n',
          ".env": `SUPABASE_SERVICE_ROLE_KEY=${serviceJwt("dotenv")}\n`,
          ".env.production": `SUPABASE_SECRET_KEY=${sbSecret("prod")}\n`,
          "assets/logo.png": `${serviceJwt("png")}\n`,
          "server/blob.dat": `\0${serviceJwt("bin")}\n`,
        },
        [".env", ".env.production", "server/client.ts"],
      ),
    );
    expect(findings).toEqual([]);
  });
});
