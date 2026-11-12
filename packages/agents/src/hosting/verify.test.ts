// Feature 027 (T2718): `opscrew verify` on a hosting account, over HTTP and HTTPS, with the cPanel
// fake for the account's hostnames.
import type { CheckResult, FetchLike } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema, type HostingDeployTarget } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runVerify } from "../verify/run";
import { hostedApp, hostingTestPlan, PANEL_TOKEN } from "./__fixtures__/account";
import { verifyHosting } from "./verify";

/** One answer of the fake site. */
type Answer = () => Response;

const release = { "x-opscrew-release": "812-1" };

/** The app on its hostname as the agent's block serves it, with `overrides` by URL. */
function site(overrides: Record<string, Answer> = {}): FetchLike & { urls: string[] } {
  const answers: Record<string, Answer> = {
    "https://notes.example.com/": () =>
      new Response("<html>notes</html>", {
        status: 200,
        headers: { ...release, "x-powered-by": "PHP/8.3.12" },
      }),
    "http://notes.example.com/": () =>
      new Response(null, {
        status: 301,
        headers: { ...release, location: "https://notes.example.com/" },
      }),
    "https://notes.example.com/.env": () =>
      new Response("Forbidden", { status: 403, headers: release }),
    "https://notes.example.com/.htaccess": () =>
      new Response("Forbidden", { status: 403, headers: release }),
    ...overrides,
  };
  const urls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = String(input);
    urls.push(url);
    return (answers[url] ?? (() => new Response("Not Found", { status: 404, headers: release })))();
  };
  return Object.assign(fetch, { urls });
}

const byId = (checks: readonly CheckResult[]) =>
  Object.fromEntries(checks.map((check) => [check.id, check]));

/** `plan` with its hosting target changed by `change`, validated again. */
function withTarget(plan: DeployPlan, change: Partial<HostingDeployTarget>): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, target: { ...plan.target, ...change } });
}

describe("verify on a hosting account", () => {
  it("passes when the app answers over HTTPS with its release, refuses what it must, and runs its PHP", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    const fetch = site();
    const result = await verifyHosting(deps, app.plan, { fetch });
    expect(result.passed).toBe(true);
    expect(result.url).toBe("https://notes.example.com");
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([
      ["hosting-https", "pass"],
      ["hosting-http-redirect", "pass"],
      ["hosting-env-file", "pass"],
      ["hosting-htaccess", "pass"],
      ["hosting-release-folders", "pass"],
      ["hosting-other-hostnames", "pass"],
      ["hosting-php-version", "pass"],
    ]);
    const checks = byId(result.checks);
    expect(checks["hosting-https"]?.message).toBe(
      "https://notes.example.com/ answered 200 with release 812-1.",
    );
    expect(checks["hosting-php-version"]?.message).toBe("The app answers from PHP 8.3.12.");
    expect(checks["hosting-other-hostnames"]?.message).toBe(
      "No other hostname of the account has the app's document root (~/opscrew/notes-prod/current/public) or a folder above it.",
    );
    // The release folder asked for is the one the app answered with.
    expect(fetch.urls).toContain("https://notes.example.com/releases/812-1/");
    expect((await deps.state.read()).phases.verify?.status).toBe("ok");
    expect(deps.reporter.text()).not.toContain(PANEL_TOKEN);
    expect(deps.reporter.text()).toContain(
      "https://notes.example.com is live on the hosting account",
    );
  });

  it("fails what visitors could read, a missing redirect, no release, and another PHP", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    const result = await verifyHosting(deps, app.plan, {
      fetch: site({
        "https://notes.example.com/": () =>
          new Response("ok", { status: 200, headers: { "x-powered-by": "PHP/7.0.33" } }),
        "http://notes.example.com/": () => new Response("ok", { status: 200 }),
        "https://notes.example.com/.env": () =>
          new Response("APP_KEY=base64:x\nDB_PASSWORD=y\n", { status: 200 }),
        "https://notes.example.com/.htaccess": () =>
          new Response("# BEGIN OpsCrew\nRewriteEngine On\n", { status: 200 }),
        "https://notes.example.com/releases/": () =>
          new Response("<html><title>Index of /releases</title></html>", { status: 200 }),
      }),
    });
    expect(result.passed).toBe(false);
    const checks = byId(result.checks);
    expect(checks["hosting-https"]).toMatchObject({
      status: "fail",
      message:
        "https://notes.example.com/ answered 200 without OpsCrew's release header, so the hostname doesn't serve a release the agent deployed.",
    });
    expect(checks["hosting-http-redirect"]).toMatchObject({
      status: "fail",
      message:
        "http://notes.example.com/ answered HTTP 200 instead of redirecting to https://notes.example.com.",
      remediation:
        "The agent forces HTTPS once notes.example.com's certificate verifies from the account: `opscrew status` shows the certificate.",
    });
    expect(checks["hosting-env-file"]).toMatchObject({
      status: "fail",
      severity: "critical",
      message:
        "https://notes.example.com/.env serves the app's settings file: anyone can read its values.",
    });
    expect(checks["hosting-htaccess"]?.status).toBe("fail");
    // Without a release header, the release folders themselves are asked for.
    expect(checks["hosting-release-folders"]).toMatchObject({
      status: "fail",
      target: "https://notes.example.com/releases/",
    });
    expect(checks["hosting-php-version"]).toMatchObject({
      status: "fail",
      message: "The app answers from PHP 7.0.33, not 8.3, the version provision chose for it.",
      remediation:
        "The handler line in OpsCrew's block (AddHandler) gives notes.example.com PHP 8.3: check that the panel didn't change the release's .htaccess, then deploy again; `opscrew provision` chooses again if the app needs another version now.",
    });
    expect((await deps.state.read()).phases.verify?.status).toBe("failed");
    // The settings file's values are never shown.
    expect(JSON.stringify(result.checks)).not.toContain("DB_PASSWORD");
  });

  it("takes the app's own page for an unknown path as refused, and skips a PHP it can't see", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    const page = () =>
      new Response("<!doctype html><p>Not here</p>", { status: 200, headers: release });
    const result = await verifyHosting(deps, app.plan, {
      fetch: site({
        "https://notes.example.com/": () => new Response("ok", { status: 200, headers: release }),
        "https://notes.example.com/.env": page,
        "https://notes.example.com/releases/812-1/": () =>
          new Response("<!doctype html><p>Not here</p>", { status: 200 }),
      }),
    });
    const checks = byId(result.checks);
    expect(checks["hosting-env-file"]).toMatchObject({
      status: "pass",
      message:
        "https://notes.example.com/.env answered 200 with the app's own page, not the thing itself.",
    });
    expect(checks["hosting-release-folders"]?.status).toBe("pass");
    expect(checks["hosting-php-version"]).toMatchObject({
      status: "skip",
      message:
        "The app's answer doesn't say which PHP runs it (the account doesn't send X-Powered-By), so OpsCrew can't check PHP 8.3 from outside.",
    });
    expect(result.passed).toBe(true);
  });

  it("takes a release folder answering 2xx with a release header as served", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    const result = await verifyHosting(deps, app.plan, {
      fetch: site({
        "https://notes.example.com/releases/812-1/": () =>
          new Response("notes", { status: 200, headers: release }),
      }),
    });
    expect(byId(result.checks)["hosting-release-folders"]).toMatchObject({
      status: "fail",
      message:
        "https://notes.example.com/releases/812-1/ serves a release folder: the hostname's document root is above the release it should serve.",
    });
  });

  it("asks every other hostname that reaches the app's folder, and fails one that serves it", async () => {
    const app = await hostedApp();
    const fake = app.account.cpanel;
    if (fake === undefined) throw new Error("a cPanel account");
    // A restricted account: the hostname's root is a link in public_html, the main domain's folder.
    const hostname = fake.state.domains.find((d) => d.name === "notes.example.com");
    if (hostname === undefined) throw new Error("the hostname");
    hostname.documentRoot = "public_html/opscrew-notes-prod";
    fake.state.domains.push({
      name: "notes-alias.example.com",
      kind: "subdomain",
      documentRoot: "public_html/opscrew-notes-prod",
    });
    const deps = await app.deps();
    const refused = () => new Response("Forbidden", { status: 403, headers: release });
    const fetch = site({
      "http://example.com/opscrew-notes-prod/": refused,
      "http://notes-alias.example.com/": refused,
    });
    const ok = byId((await verifyHosting(deps, app.plan, { fetch })).checks);
    expect(ok["hosting-other-hostnames"]).toMatchObject({
      status: "pass",
      message:
        "http://example.com/opscrew-notes-prod/, http://notes-alias.example.com/ refused the app.",
    });

    const served = byId(
      (
        await verifyHosting(deps, app.plan, {
          fetch: site({
            "http://example.com/opscrew-notes-prod/": () =>
              new Response("notes", { status: 200, headers: release }),
            "http://notes-alias.example.com/": refused,
          }),
        })
      ).checks,
    );
    expect(served["hosting-other-hostnames"]).toMatchObject({
      status: "fail",
      message:
        "http://example.com/opscrew-notes-prod/ serves the app as well as https://notes.example.com.",
    });
  });

  it("checks Composer's packages when a release's root is served", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    const plan = withTarget(app.plan, { webRoot: "." });
    const result = await verifyHosting(deps, plan, {
      fetch: site({
        "https://notes.example.com/vendor/composer/installed.json": () =>
          new Response('{"packages": [{"name": "monolog/monolog"}]}', { status: 200 }),
      }),
    });
    expect(byId(result.checks)["hosting-composer-packages"]).toMatchObject({
      status: "fail",
      message:
        "https://notes.example.com/vendor/composer/installed.json serves Composer's list of the app's packages: anyone can read them and their versions.",
    });
  });

  it("on an SFTP host and without the panel's token: the other hostnames are skipped with why", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    const sftp = withTarget(hostingTestPlan({ database: false }), {
      panel: "sftp",
      cron: [],
      php: { version: "8.3", via: "account" },
    });
    const checks = byId((await verifyHosting(deps, sftp, { fetch: site() })).checks);
    expect(checks["hosting-other-hostnames"]).toMatchObject({
      status: "skip",
      message:
        "OpsCrew can't list an SFTP host's other hostnames; the agent's block in the release's .htaccess refuses every hostname but notes.example.com.",
    });

    const without = await app.deps();
    without.env.OPSCREW_HOSTING_TOKEN = undefined;
    const skipped = byId((await verifyHosting(without, app.plan, { fetch: site() })).checks);
    expect(skipped["hosting-other-hostnames"]).toMatchObject({ status: "skip" });
    expect(skipped["hosting-other-hostnames"]?.message).toMatch(
      /^OpsCrew could not read the account's hostnames from the panel\. OPSCREW_HOSTING_TOKEN isn't set/,
    );
  });

  it("stops before provision, and runs through `opscrew verify`", async () => {
    const app = await hostedApp();
    const deps = await app.deps();
    await expect(
      verifyHosting(deps, hostingTestPlan({ deployed: false }), { fetch: site() }),
    ).rejects.toMatchObject({ code: "PHASE_PRECONDITION" });
    const result = await runVerify(deps, { fetch: site() });
    expect(result.passed).toBe(true);
    expect(result.checks[0]?.id).toBe("hosting-https");
  });
});
