// Feature 027 (T2710): design refuses an app a hosting account can't run, naming a server target.
import type { HostingFacts } from "@opscrew/contracts";
import type { ProjectFacts } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { makeFacts } from "../testing";
import { type HostingFitInput, hostingMisfit, hostingRefusal } from "./fit";

const ACCOUNT: HostingFacts = {
  panel: "cpanel",
  domains: [{ name: "example.com", kind: "main", documentRoot: "public_html" }],
  addresses: ["192.0.2.10"],
  quota: { usedMb: 512, limitMb: 10_240 },
  databases: { engines: ["mariadb"], prefix: "acct_", maxDatabaseName: 64, maxUserName: 47 },
  apps: { selectors: ["nodejs", "python"], slotsLeft: 4 },
  phpPerHostname: [],
  documentRoots: "anywhere",
};

const php = (overrides: Partial<ProjectFacts> = {}) =>
  makeFacts({ name: "notes", languages: ["php"], appKind: "fullstack", ...overrides });

const fit = (input: Partial<HostingFitInput> & Pick<HostingFitInput, "facts">) =>
  hostingMisfit({ keep: {}, app: "php", account: ACCOUNT, ...input });

const reason = (input: Partial<HostingFitInput> & Pick<HostingFitInput, "facts">) =>
  fit(input)?.reason;

describe("what fits a hosting account", () => {
  it("takes a PHP app on MySQL with a cron job, and Laravel's scheduler as a cron line", () => {
    const facts = php({
      services: [{ kind: "mysql", evidence: ["dependency:ext-pdo_mysql"] }],
      cronJobs: [{ schedule: "* * * * *", command: "php bin/cron.php", source: "cron.php" }],
      workers: [
        {
          name: "scheduler",
          command: "php artisan schedule:work",
          source: "library",
          single: true,
          evidence: ["file:routes/console.php"],
        },
      ],
    });
    expect(fit({ facts, sizeMb: 20 })).toBeUndefined();
    // A hosted service the app keeps reaching by URL fits too.
    const kept = php({ services: [{ kind: "redis", evidence: ["dependency:predis/predis"] }] });
    expect(fit({ facts: kept, keep: { redis: true } })).toBeUndefined();
  });

  it("takes a Node.js app where the panel runs it, and one that already has its slot", () => {
    const node = makeFacts({ name: "api" });
    expect(fit({ facts: node, app: "node" })).toBeUndefined();
    const full = { ...ACCOUNT, apps: { selectors: ["nodejs" as const], slotsLeft: 0 } };
    expect(fit({ facts: node, app: "node", account: full, hasSlot: true })).toBeUndefined();
  });
});

describe("design's refusals", () => {
  it("refuses a worker that keeps running", () => {
    const facts = php({
      workers: [
        {
          name: "queue-worker",
          command: "php artisan queue:work",
          source: "library",
          single: false,
          evidence: ["file:app/Jobs"],
        },
      ],
    });
    expect(reason({ facts })).toBe(
      "the app runs queue-worker (php artisan queue:work), a worker that keeps running, and a hosting account runs nothing between requests",
    );
  });

  it("refuses a queue", () => {
    expect(
      reason({ facts: php({ services: [{ kind: "amqp", evidence: ["dependency:ext-amqp"] }] }) }),
    ).toBe(
      "the app uses a queue (RabbitMQ), whose worker keeps running, and a hosting account runs nothing between requests",
    );
    expect(
      reason({
        facts: php({ services: [{ kind: "queue", evidence: ["dependency:laravel/horizon"] }] }),
      }),
    ).toBe(
      "the app uses a queue, whose worker keeps running, and a hosting account runs nothing between requests",
    );
  });

  it("refuses Redis unless the app keeps a hosted one", () => {
    const facts = php({ services: [{ kind: "redis", evidence: ["dependency:predis/predis"] }] });
    expect(fit({ facts })).toEqual({
      reason: "the app uses Redis, which a hosting account doesn't run",
      fix: "Keep a hosted Redis the app reaches by URL (answer keepExternalServices.redis: true in `opscrew interview`).",
    });
  });

  it("refuses WebSockets served from PHP", () => {
    const needs = { extensions: [], websockets: ["laravel/reverb"] };
    expect(reason({ facts: php(), needs })).toBe(
      "the app serves WebSockets from PHP (laravel/reverb), which needs a PHP process that keeps running, and a hosting account runs PHP only for each request",
    );
  });

  it("refuses a service that runs only in a container, and a bucket OpsCrew would create", () => {
    const facts = php({
      services: [{ kind: "mongodb", evidence: ["dependency:mongodb/mongodb"] }],
    });
    expect(fit({ facts })).toEqual({
      reason:
        "the app uses MongoDB, which runs only in a container, and a hosting account runs none",
      fix: "Keep a hosted MongoDB the app reaches by URL (answer keepExternalServices.mongodb: true in `opscrew interview`).",
    });
    const bucket = php({
      objectStorage: { client: "aws/aws-sdk-php", presignedUploads: false, variables: [] },
    });
    expect(reason({ facts: bucket, keep: { s3: false } })).toContain(
      "the bucket OpsCrew would create",
    );
    expect(fit({ facts: bucket })).toBeUndefined();
  });

  it("refuses PostgreSQL where the account has none, and where it has it for now", () => {
    const facts = php({ services: [{ kind: "postgres", evidence: ["dependency:ext-pdo_pgsql"] }] });
    expect(reason({ facts })).toBe(
      "the app uses PostgreSQL, and the account has no PostgreSQL databases",
    );
    const withPostgres = {
      ...ACCOUNT,
      databases: { ...ACCOUNT.databases, engines: ["mariadb" as const, "postgres" as const] },
    };
    expect(reason({ facts, account: withPostgres })).toBe(
      "the app uses PostgreSQL, and OpsCrew makes only MySQL and MariaDB databases on a hosting account so far",
    );
    const mysql = php({ services: [{ kind: "mysql", evidence: ["dependency:ext-pdo_mysql"] }] });
    const none = { ...ACCOUNT, databases: { engines: [] } };
    expect(reason({ facts: mysql, account: none })).toBe(
      "the app uses MySQL, and the account has no MySQL or MariaDB databases",
    );
  });

  it("refuses a Node.js or Python app without the panel's selector or an app slot left", () => {
    const node = makeFacts({ name: "api" });
    const noSelector = { ...ACCOUNT, apps: { selectors: ["python" as const] } };
    expect(reason({ facts: node, app: "node", account: noSelector })).toBe(
      "the account's panel runs no Node.js apps",
    );
    const full = {
      ...ACCOUNT,
      apps: { selectors: ["nodejs" as const, "python" as const], slotsLeft: 0 },
    };
    expect(
      fit({ facts: makeFacts({ languages: ["python"] }), app: "python", account: full }),
    ).toEqual({
      reason: "the account's app slots are used up, so the panel can't run another Python app",
      fix: "Remove an app you no longer need in the panel, then run `opscrew design` again.",
    });
    const { account: _none, ...sftp } = { facts: node, app: "node" as const, account: undefined };
    expect(hostingMisfit({ keep: {}, ...sftp })?.reason).toBe(
      "an SFTP host runs no Node.js apps: OpsCrew only uploads files there",
    );
  });

  it("refuses an app larger than the disk left", () => {
    const tight = { ...ACCOUNT, quota: { usedMb: 990, limitMb: 1000 } };
    expect(reason({ facts: php(), account: tight, sizeMb: 10.5 })).toBe(
      "the app's source (without vendor/, node_modules/ and its build output) takes about 11 MB, and the account has 10 MB of disk left",
    );
    expect(fit({ facts: php(), account: tight, sizeMb: 9 })).toBeUndefined();
  });

  it("refuses an app of no kind the account runs, a site it can't find, and route cron jobs", () => {
    expect(reason({ facts: makeFacts({ languages: ["go"] }), app: undefined })).toBe(
      "a hosting account runs static sites and PHP, Node.js and Python apps, and this app is written in Go",
    );
    expect(reason({ facts: php(), app: "static", siteWithoutFolder: true })).toContain(
      "OpsCrew can't tell which folder holds the site's files",
    );
    const routes = makeFacts({
      cronJobs: [{ schedule: "0 * * * *", route: "/api/cron/sync", source: "vercel.json" }],
    });
    expect(reason({ facts: routes, app: "node" })).toBe(
      "the app's cron jobs call its routes (vercel.json: /api/cron/sync) with a secret, which OpsCrew sends only from a server",
    );
  });

  it("says why and names a server target every time", () => {
    const refusal = hostingRefusal({ reason: "the app runs a worker" });
    expect(refusal.code).toBe("PHASE_PRECONDITION");
    expect(refusal.message).toBe(
      "A hosting account doesn't fit this app: the app runs a worker. Nothing was written.",
    );
    expect(refusal.hint).toBe(
      "Choose a server target with `opscrew interview`: Hetzner Cloud, DigitalOcean, Contabo or a server you already have.",
    );
    const withFix = hostingRefusal({ reason: "x", fix: "Keep a hosted Redis." });
    expect(withFix.hint).toBe(
      "Keep a hosted Redis. Otherwise choose a server target with `opscrew interview`: Hetzner Cloud, DigitalOcean, Contabo or a server you already have.",
    );
  });
});
