// Feature 027 (T2711): applying a hosting plan, bound to its hash (ADR 0030 D3, ADR 0011).
import { CpanelPanel, fakeCpanel } from "@opscrew/connector-cpanel";
import { DirectAdminPanel, FakeDirectAdmin } from "@opscrew/connector-directadmin";
import type { HostingFiles } from "@opscrew/contracts";
import { OpsCrewError, Redactor, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderEnvPhp } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import {
  applyHostingPlan,
  databaseValues,
  type HostingApplyContext,
  HostingApplyError,
  requireEmptyPanelRoot,
  signingKeyId,
  valuesDigest,
  valuesLine,
} from "./apply";
import { type AppPlan, hostingPlanHash } from "./plan";
import type { HostingObject } from "./record";

const TOKEN = fakeSecret("generic-password", "hosting-apply");
const FOLDER = "opscrew/notes-prod";
const HEADER = {
  panel: "cpanel",
  account: "acct at panel.example.com",
  environment: "prod",
  hostname: "notes.example.com",
  folder: FOLDER,
} as const;

/** A cPanel account and what an apply needs, every object made recorded in `made`. */
function context() {
  const fake = fakeCpanel({ user: "acct", token: TOKEN });
  const panel = new CpanelPanel(
    { url: "https://panel.example.com:2083", user: "acct", token: TOKEN },
    { fetch: fake.fetch, redactor: new Redactor() },
  );
  const made: HostingObject[] = [];
  const ctx: HostingApplyContext = {
    panel,
    files: panel,
    made: async (object) => {
      made.push(object);
    },
    forget: async () => undefined,
    replace: async (object) => {
      made.push(object);
    },
    contents: new Map(),
    otherRoots: ["public_html"],
    redactor: new Redactor(),
    sleep: async () => undefined,
    now: () => new Date("2026-11-12T12:00:00.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(7),
  };
  return { fake, panel, ctx, made };
}

const appPlan = (steps: AppPlan["steps"]): AppPlan => ({ plan: "app", ...HEADER, steps });

describe("applyHostingPlan", () => {
  it("refuses a plan that isn't the approved one before any call to the panel", async () => {
    const { fake, ctx } = context();
    const approved = appPlan([{ kind: "hostname", hostname: "notes.example.com" }]);
    const changed = appPlan([{ kind: "hostname", hostname: "admin.example.com" }]);
    const error = await applyHostingPlan(changed, {
      ...ctx,
      approvedHash: hostingPlanHash(approved),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect(fake.calls).toEqual([]);
  });

  it("makes the database with a generated password written only into mysql.cnf and the settings file", async () => {
    const { fake, ctx, made } = context();
    const values = { NOTES_API_KEY: "kept" };
    const plan = appPlan([
      { kind: "database", name: "acct_notes", user: "acct_notes" },
      {
        kind: "values",
        file: ".env",
        keys: ["DB_PASSWORD", "NOTES_API_KEY"],
        database: ["DB_PASSWORD"],
        generated: ["DB_PASSWORD"],
        digest: valuesDigest(values),
      },
    ]);
    const result = await applyHostingPlan(plan, {
      ...ctx,
      values,
      database: { name: "acct_notes", user: "acct_notes" },
      approvedHash: hostingPlanHash(plan),
    });
    expect(result.applied).toEqual(["database", "values"]);
    const password = /^DB_PASSWORD=(.+)$/m.exec(fake.readText(`${FOLDER}/shared/.env`) ?? "")?.[1];
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(fake.readText(`${FOLDER}/shared/mysql.cnf`)).toBe(
      `[client]\nuser=acct_notes\npassword=${password}\nhost=localhost\n`,
    );
    expect(JSON.stringify(plan)).not.toContain(password);
    expect(made).toEqual([
      { kind: "database", key: "acct_notes" },
      { kind: "file", key: `${FOLDER}/shared/.env`, value: valuesDigest(values) },
    ]);
    expect(ctx.redactor.redact(`x ${password} y`)).not.toContain(password);
  });

  it("refuses values that changed after the plan, and says what it made before", async () => {
    const { ctx } = context();
    const plan = appPlan([
      { kind: "database", name: "acct_notes", user: "acct_notes" },
      {
        kind: "values",
        file: ".env",
        keys: ["NOTES_API_KEY"],
        database: [],
        generated: [],
        digest: valuesDigest({ NOTES_API_KEY: "planned" }),
      },
    ]);
    const error = await applyHostingPlan(plan, {
      ...ctx,
      values: { NOTES_API_KEY: "changed" },
      approvedHash: hostingPlanHash(plan),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostingApplyError);
    expect((error as HostingApplyError).applied).toEqual(["database"]);
    expect((error as HostingApplyError).message).toContain(
      "The app's values changed after this hosting plan was made",
    );
  });

  it("stores a new signing key in GitHub first, then its public half on the account", async () => {
    const { fake, ctx, made } = context();
    const plan = appPlan([{ kind: "signing-key" }]);
    const stored: string[] = [];
    await applyHostingPlan(plan, {
      ...ctx,
      storeSigningKey: async (privatePem) => {
        // GitHub gets it before the account changes.
        expect(fake.readText(`${FOLDER}/keys/release.pub`)).toBeUndefined();
        stored.push(privatePem);
      },
      approvedHash: hostingPlanHash(plan),
    });
    expect(stored[0]).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const publicPem = fake.readText(`${FOLDER}/keys/release.pub`) ?? "";
    expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(made).toEqual([{ kind: "signing-key", key: signingKeyId(publicPem) }]);
    expect(ctx.redactor.redact(`x ${stored[0]} y`)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("leaves the account's key as it was when GitHub's secret is refused", async () => {
    const { fake, ctx, made } = context();
    const plan = appPlan([{ kind: "signing-key" }]);
    const error = await applyHostingPlan(plan, {
      ...ctx,
      storeSigningKey: async () => {
        throw new OpsCrewError("APPROVAL_REFUSED", "The deploy secrets were not stored.");
      },
      approvedHash: hostingPlanHash(plan),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(fake.readText(`${FOLDER}/keys/release.pub`)).toBeUndefined();
    expect(made).toEqual([]);
  });

  it("writes a file only with the content the plan was approved with", async () => {
    const { ctx } = context();
    const plan = appPlan([
      { kind: "file", path: "settings.sh", mode: 0o600, sha256: sha256Hex("approved\n") },
    ]);
    const error = await applyHostingPlan(plan, {
      ...ctx,
      contents: new Map([["settings.sh", "other\n"]]),
      approvedHash: hostingPlanHash(plan),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INTERNAL" });
  });
});

describe("requireEmptyPanelRoot", () => {
  const files = (names: string[] | undefined) =>
    ({ list: async () => names }) as unknown as HostingFiles;

  it("takes the panel's default page and an empty folder", async () => {
    await requireEmptyPanelRoot(
      files(["index.html", "logo.png"]),
      "domains/a.example.com/public_html",
      [],
    );
    await requireEmptyPanelRoot(files([]), "domains/a.example.com/public_html", []);
  });

  it("refuses anything else there, and a root inside another site's folder", async () => {
    await expect(
      requireEmptyPanelRoot(
        files(["index.html", ".htaccess"]),
        "domains/a.example.com/public_html",
        [],
      ),
    ).rejects.toThrow("holds files OpsCrew didn't put there (.htaccess)");
    await expect(
      requireEmptyPanelRoot(files([]), "domains/example.com/public_html/a", [
        "domains/example.com/public_html",
      ]),
    ).rejects.toThrow("inside another site's folder (~/domains/example.com/public_html)");
  });

  it("refuses DirectAdmin answering the main domain's own public_html, default page and all", async () => {
    const fake = new FakeDirectAdmin({ token: TOKEN });
    const panel = new DirectAdminPanel(fake.access, { fetch: fake.fetch });
    const facts = await panel.inspect();
    const main = facts.domains.find((domain) => domain.kind === "main")?.documentRoot ?? "";
    expect(main).toBe("domains/example.com/public_html");
    fake.files.set(`${main}/index.html`, {
      type: "file",
      content: new TextEncoder().encode("<h1>Default</h1>"),
      mode: 0o644,
    });
    const roots = facts.domains.flatMap((domain) =>
      domain.documentRoot === undefined ? [] : [domain.documentRoot],
    );
    await expect(requireEmptyPanelRoot(panel, main, roots)).rejects.toThrow(
      "which is another site's own folder, so OpsCrew won't replace it",
    );
    expect(fake.text(`${main}/index.html`)).toBe("<h1>Default</h1>");
  });
});

describe("the settings file", () => {
  it("quotes each value as env.php and Laravel read it", () => {
    expect(valuesLine("A", "plain-value_1.2:3/4@5+6=7,8")).toBe("A=plain-value_1.2:3/4@5+6=7,8");
    expect(valuesLine("B", "two words $HOME")).toBe("B='two words $HOME'");
    expect(valuesLine("C", 'it\'s "quoted"\n\t$x\\')).toBe('C="it\'s \\"quoted\\"\\n\\t\\$x\\\\"');
    // env.php reads the escapes this writes.
    expect(renderEnvPhp(["C"])).toContain("'\\\\$' => '$'");
  });

  it("fills the database's split settings and its URL", () => {
    expect(
      databaseValues(["DATABASE_URL", "DB_HOST", "DB_NAME", "DB_PASS", "DB_PORT", "DB_USER"], {
        name: "acct_notes",
        user: "acct_notes",
        password: "p4ss",
      }),
    ).toEqual({
      DATABASE_URL: "mysql://acct_notes:p4ss@localhost:3306/acct_notes",
      DB_HOST: "localhost",
      DB_NAME: "acct_notes",
      DB_PASS: "p4ss",
      DB_PORT: "3306",
      DB_USER: "acct_notes",
    });
  });
});
