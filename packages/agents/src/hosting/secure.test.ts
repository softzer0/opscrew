// Feature 027 (T2718): `opscrew secure` on a hosting account, with the cPanel fake.
import { readFile } from "node:fs/promises";
import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema, type HostingDeployTarget } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runSecure } from "../secure/run";
import type { TestPhaseDeps } from "../testing";
import {
  hostedApp,
  hostingTestPlan,
  MemoryFiles,
  PANEL_TOKEN,
  pleskAccount,
} from "./__fixtures__/account";
import { updateHostingRecord } from "./record";
import { hostingSecurityChecks } from "./secure";

/** The running release's served `.htaccess`, as the agent composes it. */
const HTACCESS = [
  "# BEGIN OpsCrew",
  "RewriteEngine On",
  "RewriteCond %{HTTP_HOST} !^notes\\.example\\.com(:[0-9]+)?$ [NC]",
  "RewriteRule ^ - [F]",
  "RewriteCond %{HTTPS} !=on",
  "RewriteRule ^ https://notes.example.com%{REQUEST_URI} [R=301,L]",
  "Options -Indexes",
  '<FilesMatch "^\\.">',
  "Require all denied",
  "</FilesMatch>",
  'Header always set X-OpsCrew-Release "812-1"',
  "# END OpsCrew",
  "",
].join("\n");

/** The hostname's HTTP answer: a redirect to HTTPS unless `redirects` is false. */
function http(redirects = true): FetchLike {
  return async () =>
    redirects
      ? new Response(null, { status: 301, headers: { location: "https://notes.example.com/" } })
      : new Response("ok", { status: 200 });
}

const byId = (checks: readonly CheckResult[]) =>
  Object.fromEntries(checks.map((check) => [check.id, check]));

function withTarget(plan: DeployPlan, change: Partial<HostingDeployTarget>): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, target: { ...plan.target, ...change } });
}

/** `deps` whose fetch answers the app's hostname with `site`, and the panel as before. */
function reaching(deps: TestPhaseDeps, site: FetchLike): TestPhaseDeps {
  const panel = deps.fetch;
  deps.fetch = (input, init) =>
    new URL(String(input)).hostname === "notes.example.com"
      ? site(input, init)
      : panel(input, init);
  return deps;
}

describe("secure on a hosting account", () => {
  it("checks PHP's support, the settings' place, OpsCrew's .htaccess block and HTTPS, in the report", async () => {
    const app = await hostedApp();
    app.account.write(`${app.folder}/current/public/.htaccess`, HTACCESS);
    const deps = reaching(await app.deps(), http());
    const result = await runSecure(deps, { scanners: [], offline: true });
    expect(result.hostChecks.map((check) => [check.id, check.status])).toEqual([
      ["hosting-php-supported", "pass"],
      ["hosting-settings-place", "pass"],
      ["hosting-file-modes", "skip"],
      ["hosting-directory-listings", "pass"],
      ["hosting-dotfiles", "pass"],
      ["hosting-https-forced", "pass"],
    ]);
    const checks = byId(result.hostChecks);
    // The test's clock is 2026-10-11: PHP 8.3 gets security fixes only.
    expect(checks["hosting-php-supported"]?.message).toBe(
      "PHP 8.3 gets security fixes only, until 2027-12-31 (php.net, read 2026-11-12).",
    );
    expect(checks["hosting-settings-place"]?.message).toBe(
      "notes.example.com serves ~/opscrew/notes-prod/current/public; the app's settings are in ~/opscrew/notes-prod/shared/, outside it.",
    );
    expect(checks["hosting-file-modes"]?.message).toMatch(
      /^OpsCrew reads no file modes on the account \(the panel's API and its file calls don't show them\), so it can't check them\./,
    );
    expect(result.probes).toEqual([]);
    expect(result.passed).toBe(true);
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    expect(report).toContain("## The site on your cPanel account");
    expect(report).toContain(
      "OpsCrew runs no server for this app: your cPanel account is the host's",
    );
    expect(report).toContain(
      "Skipped: OpsCrew probes no port: the account shares its host's addresses",
    );
    expect(report).not.toContain("Server hardening");
    expect(report).not.toContain(PANEL_TOKEN);
    expect(deps.reporter.text()).not.toContain(PANEL_TOKEN);
  });

  it("fails an end-of-life PHP, a document root above the settings, a block without its rules, and no redirect", async () => {
    const app = await hostedApp();
    app.account.write(
      `${app.folder}/current/public/.htaccess`,
      "# BEGIN OpsCrew\nRewriteEngine On\n# END OpsCrew\nOptions +Indexes\n",
    );
    const hostname = app.account.cpanel?.state.domains.find((d) => d.name === "notes.example.com");
    if (hostname === undefined) throw new Error("the hostname");
    hostname.documentRoot = "opscrew/notes-prod";
    const deps = await app.deps();
    const plan = withTarget(app.plan, { php: { version: "7.4", via: "account" } });
    const { checks } = await hostingSecurityChecks(deps, plan, { fetch: http(false) });
    const by = byId(checks);
    expect(by["hosting-php-supported"]).toMatchObject({
      status: "fail",
      message:
        "PHP 7.4 gets no security fixes since 2022-11-28 (php.net, read 2026-11-12): holes found in it since stay open.",
      remediation:
        "Raise the PHP version the app needs in composer.json (require.php) to a supported one (https://www.php.net/supported-versions.php), then run `opscrew design` and `opscrew provision`: they give notes.example.com that version where the account has it, or say what to ask the host.",
    });
    expect(by["hosting-settings-place"]).toMatchObject({
      status: "fail",
      severity: "critical",
      message:
        "notes.example.com serves ~/opscrew/notes-prod/, which holds ~/opscrew/notes-prod/shared/: the app's settings and its database's login may be read from the web.",
      remediation:
        "Set notes.example.com's document root back to ~/opscrew/notes-prod/current/public in the panel, then change every value in ~/opscrew/notes-prod/shared/.env.",
    });
    expect(by["hosting-directory-listings"]).toMatchObject({
      status: "fail",
      message:
        "OpsCrew's block in ~/opscrew/notes-prod/current/public/.htaccess has no Options -Indexes, so folders without an index are listed.",
    });
    expect(by["hosting-dotfiles"]?.status).toBe("fail");
    expect(by["hosting-https-forced"]).toMatchObject({ status: "fail", title: "HTTPS is forced" });
  });

  it("before the first release, on a static site, and with a PHP its table doesn't know", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    app.account.remove(`${app.folder}/state/status`);
    const before = byId((await hostingSecurityChecks(deps, app.plan, { fetch: http() })).checks);
    expect(before["hosting-directory-listings"]).toMatchObject({
      status: "skip",
      message: "No release runs yet: the agent writes OpsCrew's block with the first one.",
    });
    app.setStatus({ running: "812-1", kept: [] });
    const gone = byId((await hostingSecurityChecks(deps, app.plan, { fetch: http() })).checks);
    expect(gone["hosting-dotfiles"]).toMatchObject({
      status: "fail",
      message:
        "~/opscrew/notes-prod/current/public/.htaccess isn't there, so nothing refuses listings or dotfiles.",
    });

    const unknown = withTarget(app.plan, { php: { version: "9.1", via: "account" } });
    const php = byId((await hostingSecurityChecks(deps, unknown, { fetch: http() })).checks);
    expect(php["hosting-php-supported"]).toMatchObject({
      status: "warn",
      message:
        "OpsCrew's table of PHP's supported versions (php.net, read 2026-11-12) doesn't list PHP 9.1.",
    });

    const staticSite = withTarget(hostingTestPlan({ database: false }), {
      app: "static",
      webRoot: ".",
      php: undefined,
      cron: [],
    });
    const ids = (await hostingSecurityChecks(deps, staticSite, { fetch: http() })).checks.map(
      (check) => check.id,
    );
    expect(ids).not.toContain("hosting-php-supported");
  });

  it("on Plesk without SFTP, and without the panel's token: what it can't reach is skipped with why", async () => {
    const app = await hostedApp({ account: pleskAccount() });
    const deps = await app.deps();
    const plesk = byId((await hostingSecurityChecks(deps, app.plan, { fetch: http() })).checks);
    expect(plesk["hosting-dotfiles"]).toMatchObject({
      status: "skip",
      message:
        "OpsCrew can't read the account's files here (the panel's API has no file calls, and no SFTP access is given), so it can't read the release's .htaccess.",
    });
    app.account.write(`${app.folder}/current/public/.htaccess`, HTACCESS);
    const sftp = byId(
      (
        await hostingSecurityChecks(deps, app.plan, {
          fetch: http(),
          services: { files: app.account.files },
        })
      ).checks,
    );
    expect(sftp["hosting-dotfiles"]?.status).toBe("pass");

    const cpanel = await hostedApp();
    const without = await cpanel.deps();
    without.env.OPSCREW_HOSTING_TOKEN = undefined;
    const checks = byId(
      (await hostingSecurityChecks(without, cpanel.plan, { fetch: http() })).checks,
    );
    expect(checks["hosting-settings-place"]?.status).toBe("skip");
    expect(checks["hosting-settings-place"]?.message).toMatch(
      /^OpsCrew could not reach the hosting account\. OPSCREW_HOSTING_TOKEN isn't set/,
    );
    expect(checks["hosting-php-supported"]?.status).toBe("pass");
    expect(checks["hosting-https-forced"]?.status).toBe("pass");
  });

  it("on an SFTP host: the release's block over SFTP, the document root the user's", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    await updateHostingRecord(deps.paths, () => ({
      schemaVersion: 1,
      objects: [],
      sftp: {
        host: "sftp.example.net",
        port: 22,
        user: "notes",
        hostKey: `SHA256:${"A".repeat(43)}`,
        folder: "www/notes-prod",
        phpPath: "/var/www/notes-prod",
      },
    }));
    const plan = withTarget(hostingTestPlan({ database: false }), {
      panel: "sftp",
      cron: [],
      php: { version: "8.3", via: "account" },
    });
    const files = new MemoryFiles();
    files.files.set("www/notes-prod/current/public/.htaccess", HTACCESS);
    const result = await hostingSecurityChecks(deps, plan, { fetch: http(), services: { files } });
    expect(result.host).toBe("your SFTP host");
    const checks = byId(result.checks);
    expect(checks["hosting-settings-place"]).toMatchObject({
      status: "skip",
      message:
        "On an SFTP host the hostname's document root is yours to set, and OpsCrew can't read it: point it at the release's folder, never at ~/www/notes-prod/ itself, where ~/www/notes-prod/shared/ holds the app's settings.",
    });
    expect(checks["hosting-dotfiles"]?.status).toBe("pass");
    expect(checks["hosting-directory-listings"]?.status).toBe("pass");
  });
});
