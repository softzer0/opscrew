// Feature 027 (T2710): design for a hosting account, read through each panel's fakes.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type FakeCpanelOptions, fakeCpanel } from "@opscrew/connector-cpanel";
import { FakeDirectAdmin } from "@opscrew/connector-directadmin";
import { fakePlesk } from "@opscrew/connector-plesk";
import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret, materializeFixture } from "@opscrew/core/testing";
import { detectProject } from "@opscrew/detect";
import {
  type HostingDeployTarget,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  readOptionalArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type HostingRecord, updateHostingRecord } from "../hosting/record";
import { createTestPhaseDeps, makeRequirements, type TestPhaseDeps } from "../testing";
import { runDesign } from "./run";

const EXAMPLES = fileURLToPath(new URL("../../../../examples/", import.meta.url));
const TOKEN = fakeSecret("generic-password", "hosting-design");
const CPANEL = { kind: "cpanel", url: "https://panel.example.com:2083", user: "acct" } as const;

interface ProjectOptions {
  example: string;
  requirements?: Partial<Requirements>;
  facts?: Partial<ProjectFacts>;
  record?: Omit<HostingRecord, "schemaVersion" | "objects"> & Partial<HostingRecord>;
  env?: Record<string, string>;
  fetch?: FetchLike;
  /** Files written over the example's (repo-relative path → content). */
  files?: Record<string, string>;
}

/** An example analysed as `opscrew analyze` writes it, its interview answered for an account. */
async function project(o: ProjectOptions): Promise<TestPhaseDeps> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-hosting-design-"));
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew"), ...o.env },
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
  });
  await materializeFixture(join(EXAMPLES, o.example), root);
  for (const [path, content] of Object.entries(o.files ?? {})) {
    await writeFile(join(root, ...path.split("/")), content);
  }
  await writeArtifact("architecture", deps.paths.files.architecture, {
    schemaVersion: 1,
    generatedAt: "2026-11-12T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: { ...(await detectProject(root)), name: "notes", ...o.facts },
    summary: "An app.",
    risks: [],
    aiEnriched: false,
  });
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    makeRequirements({
      provider: "hosting",
      region: undefined,
      domain: "notes.example.com",
      dnsProvider: "other",
      ...o.requirements,
    }),
  );
  if (o.record !== undefined) {
    await updateHostingRecord(deps.paths, () => ({ schemaVersion: 1, objects: [], ...o.record }));
  }
  return deps;
}

/** The account's main domain answers with `server`; everything else goes to the panel's `api`. */
function account(api: FetchLike, main = "example.com", server = "LiteSpeed"): FetchLike {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === main) return new Response("", { status: 301, headers: { server } });
    return api(input, init);
  };
}

/** A project on a fake cPanel account. */
async function onCpanel(
  example: string,
  options: Partial<FakeCpanelOptions> = {},
  more: Partial<ProjectOptions> = {},
) {
  const fake = fakeCpanel({ user: "acct", token: TOKEN, mainDomain: "example.com", ...options });
  const deps = await project({
    example,
    record: { panel: CPANEL },
    env: {
      OPSCREW_HOSTING_URL: "https://panel.example.com:2083",
      OPSCREW_HOSTING_USER: "acct",
      OPSCREW_HOSTING_TOKEN: TOKEN,
    },
    fetch: account(fake.fetch),
    ...more,
  });
  return { deps, fake };
}

const lines = (deps: TestPhaseDeps) => deps.reporter.lines.map((line) => line.message);

describe("design on a cPanel account", () => {
  it("fills the target from the app and the account, at no price", async () => {
    const { deps, fake } = await onCpanel("php-plain-mysql");
    const result = await runDesign(deps);
    expect(result.plan.target).toEqual({
      provider: "hosting",
      panel: "cpanel",
      app: "php",
      webRoot: "public",
      database: { engine: "mariadb", name: "notes" },
      cron: [{ schedule: "* * * * *", command: "php bin/cron.php" }],
      docroot: "direct",
    } satisfies HostingDeployTarget);
    expect(result.plan.dns).toMatchObject({
      provider: "none",
      domain: "notes.example.com",
      proxied: false,
    });
    // The database and the cron jobs are the account's, not containers on a server.
    expect(result.plan.services).toEqual([]);
    expect(result.plan.processes).toEqual({ workers: [], cron: [] });
    expect(result.plan.supplyChain.sign).toBe(false);
    expect(result.plan.app.env.filter((v) => v.name.startsWith("DB_"))).toEqual([
      { name: "DB_DATABASE", secret: false, source: "derived" },
      { name: "DB_HOST", secret: false, source: "derived" },
      { name: "DB_PASSWORD", secret: true, source: "derived" },
      { name: "DB_PORT", secret: false, source: "derived" },
      { name: "DB_USERNAME", secret: false, source: "derived" },
    ]);
    expect(result.plan.codeChanges.map((change) => change.id)).not.toContain("dockerfile");
    expect(result.chosen).toMatchObject({ id: "hosting-cpanel", title: "Your cPanel account" });
    expect(result.chosen.cost.monthly.amount).toBe(0);
    const said = lines(deps);
    expect(said).toEqual(
      expect.arrayContaining([
        "Your cPanel account (hosting-cpanel) — recommended",
        "The account: cPanel. Web server: LiteSpeed, from example.com's Server header.",
        "Databases: MariaDB, every name starting with acct_. Disk: 9,728 MB left of 10,240 MB. Apps: Node.js and Python through the panel, 4 slots left.",
        "Hostname: notes.example.com, a new subdomain of example.com. Its document root: the release OpsCrew switches itself, in a folder of its own under ~/opscrew.",
        "Database: MariaDB, acct_notes with a user of its own. Its password is generated at provision and kept only in the app's settings on the account, outside the web root.",
        "Cron jobs: php bin/cron.php (* * * * *), each with the app's PHP version.",
        "PHP: the app needs PHP >=8.3 with pdo_mysql. OpsCrew checks the account's PHP versions and their extensions when it sets the account up (`opscrew provision`), and shows the version the app gets.",
        "No price: you already pay for this account.",
      ]),
    );
    expect(said.find((line) => line.startsWith("Wrote opscrew/plan.yaml"))).toContain(
      "Your cPanel account, no price (you already pay for this account)",
    );
    expect(
      said.some((line) =>
        line.startsWith("Deploys: each push to the deploy branch builds a release"),
      ),
    ).toBe(true);
    // Design reads the account; it never changes it.
    expect(
      fake.calls.some((call) => /^(add|create|delete|set|save|upload|fileop)/.test(call.func)),
    ).toBe(false);
    expect(deps.reporter.text()).not.toContain(TOKEN);
  });

  it("serves through a link in public_html where the panel restricts document roots", async () => {
    const { deps } = await onCpanel("php-plain-mysql", { docrootsInPublicHtmlOnly: true });
    const { plan } = await runDesign(deps);
    expect(plan.target).toMatchObject({ provider: "hosting", docroot: "link" });
    expect(lines(deps)).toContain(
      "Hostname: notes.example.com, a new subdomain of example.com. Its document root: a link in public_html to the release OpsCrew switches (the panel takes document roots inside public_html only), and every other hostname is refused there.",
    );
  });

  it("keeps a hostname on Cloudflare DNS only, as the account serves it with its own certificate", async () => {
    const { deps } = await onCpanel(
      "php-plain-mysql",
      {},
      {
        requirements: { domain: "notes.shop.example.com", dnsProvider: "cloudflare" },
      },
    );
    const { plan } = await runDesign(deps);
    expect(plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: "notes.shop.example.com",
      proxied: false,
    });
  });

  it("names a further environment's database after it", async () => {
    const { deps } = await onCpanel("php-plain-mysql");
    await runDesign(deps);
    const staging = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      fetch: deps.fetch,
      environment: "staging",
    });
    await updateHostingRecord(staging.paths, () => ({
      schemaVersion: 1,
      objects: [],
      panel: CPANEL,
    }));
    await mkdir(dirname(staging.paths.files.requirements), { recursive: true });
    await writeFile(staging.paths.files.requirements, "domain: notes-staging.example.com\n");
    const { plan } = await runDesign(staging);
    expect(plan.app.name).toBe("notes-staging");
    expect(plan.target).toMatchObject({ database: { name: "notes_staging" } });
  });

  it("keeps the PHP version provision chose and the database's name on a later design", async () => {
    const { deps } = await onCpanel("php-plain-mysql");
    const first = await runDesign(deps);
    const target = first.plan.target as HostingDeployTarget;
    await writeArtifact("plan", deps.paths.files.plan, {
      ...first.plan,
      target: {
        ...target,
        php: { version: "8.3", via: "handler" },
        database: { engine: "mariadb", name: "notes_v1" },
      },
    });
    const again = await runDesign(deps);
    expect(again.plan.target).toMatchObject({
      php: { version: "8.3", via: "handler" },
      database: { engine: "mariadb", name: "notes_v1" },
    });
  });

  it("warns that provision stops for a hostname the account serves and OpsCrew didn't make", async () => {
    const { deps, fake } = await onCpanel("php-plain-mysql");
    fake.state.domains.push({
      name: "notes.example.com",
      kind: "subdomain",
      documentRoot: "notes",
    });
    const result = await runDesign(deps);
    expect(result.warnings).toContain(
      "The account already serves notes.example.com, and OpsCrew never takes over a hostname it didn't make: `opscrew provision` stops before changing anything. Choose a new hostname with `opscrew interview`.",
    );
  });

  it("takes a static site's build as the release", async () => {
    const { deps } = await onCpanel("static-vite");
    const { plan } = await runDesign(deps);
    expect(plan.target).toMatchObject({
      provider: "hosting",
      app: "static",
      webRoot: ".",
      site: { tool: "node", packageManager: "npm", command: "npm run build", outputDir: "dist" },
      cron: [],
      docroot: "direct",
    });
    expect(plan.target).not.toHaveProperty("database");
  });

  it("runs a Node.js app through the panel's selector", async () => {
    const { deps } = await onCpanel(
      "express-api",
      {},
      {
        requirements: { keepExternalServices: { postgres: true } },
      },
    );
    const { plan } = await runDesign(deps);
    expect(plan.target).toMatchObject({
      provider: "hosting",
      app: "node",
      webRoot: "public",
      runtime: { interpreter: "nodejs", startup: "index.js" },
    });
    expect(
      lines(deps).some((line) =>
        /^Runtime: Node\.js \d+ through the panel's selector, started from index\.js\.$/.test(line),
      ),
    ).toBe(true);
  });
});

describe("design's refusals, through each panel", () => {
  it("refuses Redis on cPanel, writing nothing, and names a server target", async () => {
    const { deps } = await onCpanel(
      "php-plain-mysql",
      {},
      {
        facts: {
          services: [
            { kind: "mysql", evidence: ["dependency:ext-pdo_mysql"] },
            { kind: "redis", evidence: ["dependency:predis/predis"] },
          ],
        },
      },
    );
    const error = await runDesign(deps).catch((e) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.message).toBe(
      "A hosting account doesn't fit this app: the app uses Redis, which a hosting account doesn't run. Nothing was written.",
    );
    expect(error.hint).toContain(
      "Otherwise choose a server target with `opscrew interview`: Hetzner Cloud",
    );
    expect(await readOptionalArtifact("plan", deps.paths.files.plan)).toBeUndefined();
  });

  const worker = {
    name: "queue-worker",
    command: "php artisan queue:work",
    source: "library" as const,
    single: false,
    evidence: ["file:app/Jobs"],
  };
  it.each([
    [
      "a worker",
      { facts: { workers: [worker] } },
      "the app runs queue-worker (php artisan queue:work), a worker that keeps running",
    ],
    [
      "a queue",
      { facts: { services: [{ kind: "amqp" as const, evidence: ["dependency:ext-amqp"] }] } },
      "the app uses a queue (RabbitMQ), whose worker keeps running",
    ],
    [
      "WebSockets from PHP",
      {
        files: {
          "composer.json": JSON.stringify({ require: { php: ">=8.3", "cboden/ratchet": "^0.4" } }),
        },
      },
      "the app serves WebSockets from PHP (cboden/ratchet)",
    ],
    [
      "a service that runs only in a container",
      {
        facts: {
          services: [
            { kind: "meilisearch" as const, evidence: ["dependency:meilisearch/meilisearch-php"] },
          ],
        },
      },
      "the app uses Meilisearch, which runs only in a container",
    ],
  ])("refuses %s on cPanel", async (_what, more, reason) => {
    const { deps } = await onCpanel("php-plain-mysql", {}, more);
    const error = await runDesign(deps).catch((e) => e);
    expect(error.message).toContain(`A hosting account doesn't fit this app: ${reason}`);
    expect(error.hint).toContain("server target with `opscrew interview`");
  });

  it("refuses a Node.js app on cPanel when the account's app slots are used up", async () => {
    const { deps, fake } = await onCpanel(
      "express-api",
      {},
      { requirements: { keepExternalServices: { postgres: true } } },
    );
    fake.state.maximumPassengerApps = 0;
    await expect(runDesign(deps)).rejects.toThrow(
      "the account's app slots are used up, so the panel can't run another Node.js app",
    );
  });

  it("refuses an app larger than the disk left", async () => {
    const { deps, fake } = await onCpanel("php-plain-mysql");
    fake.state.quota = { usedMb: 10_240, limitMb: 10_240 };
    await expect(runDesign(deps)).rejects.toThrow(
      "the app's source (without vendor/, node_modules/ and its build output) takes about 1 MB, and the account has 0 MB of disk left",
    );
  });

  it("designs on Plesk, whose facts have no app selectors: a Node.js app is refused there", async () => {
    const fake = fakePlesk({ token: TOKEN });
    const env = {
      OPSCREW_HOSTING_URL: fake.url,
      OPSCREW_HOSTING_USER: fake.login,
      OPSCREW_HOSTING_TOKEN: TOKEN,
    };
    const record = { panel: { kind: "plesk" as const, url: fake.url, user: fake.login } };
    const php = await project({
      example: "php-plain-mysql",
      record,
      env,
      fetch: account(fake.fetch),
    });
    const { plan } = await runDesign(php);
    expect(plan.target).toMatchObject({
      provider: "hosting",
      panel: "plesk",
      database: { engine: "mysql", name: "notes" },
      docroot: "direct",
    });
    const node = await project({
      example: "express-api",
      record,
      env,
      fetch: account(fake.fetch),
      requirements: { keepExternalServices: { postgres: true } },
    });
    await expect(runDesign(node)).rejects.toThrow(
      "A hosting account doesn't fit this app: the account's panel runs no Node.js apps. Nothing was written.",
    );
  });

  it("designs on DirectAdmin, which puts the document root itself, and refuses PostgreSQL", async () => {
    const fake = new FakeDirectAdmin({ token: TOKEN });
    const env = {
      OPSCREW_HOSTING_URL: fake.access.url,
      OPSCREW_HOSTING_USER: fake.access.user,
      OPSCREW_HOSTING_TOKEN: TOKEN,
    };
    const record = {
      panel: { kind: "directadmin" as const, url: fake.access.url, user: fake.access.user },
    };
    const php = await project({
      example: "php-plain-mysql",
      record,
      env,
      fetch: account(fake.fetch),
    });
    const { plan } = await runDesign(php);
    expect(plan.target).toMatchObject({ panel: "directadmin", docroot: "link" });
    expect(lines(php)).toContain(
      "Hostname: notes.example.com, a new subdomain of example.com. Its document root: the folder DirectAdmin makes for it, replaced by a link to the release OpsCrew switches.",
    );
    const postgres = await project({
      example: "express-api",
      record,
      env,
      fetch: account(fake.fetch),
    });
    await expect(runDesign(postgres)).rejects.toThrow(
      "the app uses PostgreSQL, and the account has no PostgreSQL databases",
    );
  });

  it.each([
    ["mysql", "8.0.36", "mysql"],
    ["mariadb", "10.11.9-MariaDB", "mariadb"],
    ["mariadb", "8.0.36", "mysql"],
    ["mysql", "10.11.9-MariaDB", "mariadb"],
  ] as const)(
    "gives an app on %s the account's engine where it runs %s: %s",
    async (uses, version, engine) => {
      const fake = new FakeDirectAdmin({ token: TOKEN, databaseVersion: version });
      const deps = await project({
        example: "php-plain-mysql",
        record: {
          panel: { kind: "directadmin", url: fake.access.url, user: fake.access.user },
        },
        env: {
          OPSCREW_HOSTING_URL: fake.access.url,
          OPSCREW_HOSTING_USER: fake.access.user,
          OPSCREW_HOSTING_TOKEN: TOKEN,
        },
        fetch: account(fake.fetch),
        facts: { services: [{ kind: uses, evidence: ["dependency:ext-pdo_mysql"] }] },
      });
      const { plan } = await runDesign(deps);
      expect(plan.target).toMatchObject({ database: { engine } });
    },
  );
});

describe("design on an SFTP host", () => {
  it("leaves the hostname's setup, the database and the cron jobs to the user", async () => {
    const sftp = {
      host: "sftp.example.net",
      port: 22,
      user: "deploy",
      hostKey: `SHA256:${"B".repeat(43)}`,
      folder: "opscrew",
      phpPath: "/home/deploy/opscrew",
    };
    const deps = await project({ example: "php-plain-mysql", record: { sftp } });
    const { plan } = await runDesign(deps);
    expect(plan.target).toEqual({
      provider: "hosting",
      panel: "sftp",
      app: "php",
      webRoot: "public",
      cron: [],
      docroot: "direct",
    });
    expect(plan.app.env.find((v) => v.name === "DB_PASSWORD")?.source).toBe("user");
    expect(lines(deps)).toEqual(
      expect.arrayContaining([
        "The host: SFTP at sftp.example.net, as deploy. OpsCrew uploads each release into opscrew and switches it there; the hostname, its document root, the database and the certificate are yours to set in your host's panel.",
        "Hostname: notes.example.com. Point its document root at opscrew/current/public, the release OpsCrew switches.",
        "Database: the app uses MySQL. On an SFTP host you make it in your host's panel and give the app its values as settings.",
        "Cron jobs: an SFTP host has no panel OpsCrew sets them up through, so add them in your host's panel: php bin/cron.php (* * * * *).",
        "No price: you already pay for this account.",
      ]),
    );
  });

  it("stops when the interview recorded no account on this computer", async () => {
    const deps = await project({ example: "php-plain-mysql" });
    await expect(runDesign(deps)).rejects.toThrow(
      "opscrew/requirements.yaml says the app runs on a hosting account, but OpsCrew has no record of the account on this computer. Nothing was written.",
    );
    expect(await readArtifact("requirements", deps.paths.files.requirements)).toBeDefined();
  });
});
