import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { CommandResult, FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedRunner } from "../testing";
import { type InitCheck, runInitChecks } from "./index";

const CLOUDFLARE = fakeSecret("cloudflare-token", "init-hosting");
const DEPLOY = fakeSecret("cloudflare-token", "init-deploy");
const GITHUB = fakeSecret("github-token", "init-pages");
const TOKENS = [CLOUDFLARE, DEPLOY, GITHUB];
const WORKERS = "Account → Workers Scripts → Edit";

/** A plan on one of the server-less targets for `docs.example.com`, in the zone `example.com`. */
function plan(provider: "cloudflare-workers" | "github-pages", www = false): DeployPlan {
  const pages = provider === "github-pages";
  const site = { tool: "none", outputDir: "site" } as const;
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    app: { name: "example-app", port: 3000, env: [] },
    target: pages
      ? { provider, mode: "pages-workflow", site }
      : {
          provider,
          mode: "workers-assets",
          worker: "example-app",
          render: "static",
          notFound: "none",
          site,
        },
    processes: { workers: [], cron: [] },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "USD" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-23T00:00:00.000Z",
    },
    codeChanges: [],
    dns: { provider: "cloudflare", domain: "docs.example.com", proxied: !pages, www },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: { wafCustomRules: !pages },
  });
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

/** A git checkout of github.com/acme/site, with OpenTofu installed. */
function repoRunner(): ScriptedRunner {
  return new ScriptedRunner((command, args) => {
    if (args.includes("rev-parse")) return ok("true\n");
    if (args.includes("remote")) return ok("git@github.com:acme/site.git\n");
    if (command.endsWith("tofu")) return ok(JSON.stringify({ terraform_version: "1.10.6" }));
    return { exitCode: 1, stdout: "", stderr: `unexpected ${command}` };
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Net {
  /** The Cloudflare account as OpsCrew's token and the deploy token see it. */
  main: FakeZone;
  deploy: FakeZone;
  /** The repository on GitHub, and its owner's plan when the token may read it. */
  github: { private: boolean; plan?: string; pagesRead?: false };
}

function net(o: Partial<Net> = {}): Net & { fetch: FetchLike } {
  const main = o.main ?? new FakeZone();
  const deploy = o.deploy ?? new FakeZone();
  const github = o.github ?? { private: false };
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname.endsWith("/user/tokens/verify")) {
        return json(200, { success: true, errors: [], result: { status: "active" } });
      }
      // The optional Registrar check: no account to buy domains with.
      if (url.pathname === "/client/v4/accounts") {
        return json(200, { success: true, errors: [], result: [] });
      }
      if (url.pathname === "/client/v4/zones") {
        const zones =
          url.searchParams.get("name") === "example.com"
            ? [
                {
                  id: FAKE_ZONE_ID,
                  name: "example.com",
                  status: "active",
                  name_servers: [],
                  account: { id: FAKE_ACCOUNT_ID },
                },
              ]
            : [];
        return json(200, { success: true, errors: [], result: zones });
      }
      return (token === DEPLOY ? deploy : main).fetch(input, init);
    }
    if (url.hostname === "api.github.com" && token === GITHUB) {
      if (url.pathname === "/repos/acme/site") {
        return json(200, {
          default_branch: "main",
          private: github.private,
          permissions: { push: true },
          owner: { login: "acme", type: "User" },
        });
      }
      if (url.pathname === "/repos/acme/site/pages") {
        return github.pagesRead === false
          ? json(
              403,
              { message: "Resource not accessible by personal access token" },
              { "x-accepted-github-permissions": "pages=read" },
            )
          : json(404, { message: "Not Found" });
      }
      if (url.pathname === "/user") {
        return json(200, {
          login: "acme",
          ...(github.plan === undefined ? {} : { plan: { name: github.plan } }),
        });
      }
    }
    return json(500, { message: `unexpected ${url}` });
  };
  return { main, deploy, github, fetch };
}

async function checks(
  target: DeployPlan,
  o: { env?: Record<string, string>; net?: ReturnType<typeof net>; offline?: boolean } = {},
): Promise<InitCheck[]> {
  const deps = await createTestPhaseDeps({
    env: o.env ?? {
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      OPSCREW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY,
      GITHUB_TOKEN: GITHUB,
    },
    runner: repoRunner(),
    fetch: (o.net ?? net()).fetch,
  });
  await writeArtifact("plan", deps.paths.files.plan, target);
  const found = await runInitChecks(deps, {
    ...(o.offline ? { offline: true } : {}),
    services: {
      which: (name) =>
        ["git", "tofu", "ssh", "ssh-keyscan"].includes(name) ? `/usr/bin/${name}` : undefined,
      nodeVersion: "22.12.0",
    },
  });
  // No token ever reaches a check's message or fix.
  const text = JSON.stringify(found);
  for (const token of TOKENS) expect(text).not.toContain(token);
  return found;
}

const provider = (list: InitCheck[]) => list.find((check) => check.id === "provider");

describe("opscrew init with Cloudflare hosting", () => {
  it("passes when OpsCrew's token and the deploy token both hold the Workers permission", async () => {
    expect(provider(await checks(plan("cloudflare-workers")))).toEqual({
      id: "provider",
      title: "Cloudflare hosting",
      status: "pass",
      message: `CLOUDFLARE_API_TOKEN and OPSCREW_CLOUDFLARE_DEPLOY_TOKEN both hold ${WORKERS} for the account that holds example.com.`,
    });
  });

  it("names each token that lacks the Workers permission, and where to add it", async () => {
    const both = net();
    both.main.denied.add("workers");
    both.deploy.denied.add("workers");
    const found = provider(await checks(plan("cloudflare-workers"), { net: both }));
    expect(found).toMatchObject({
      status: "fail",
      message: `CLOUDFLARE_API_TOKEN lacks ${WORKERS}; OPSCREW_CLOUDFLARE_DEPLOY_TOKEN lacks ${WORKERS} for the account that holds example.com.`,
    });
    expect(found?.fix).toContain(
      `Add ${WORKERS} (only for Cloudflare hosting) and Zone → Single Redirect → Edit (only for Cloudflare hosting with www) to CLOUDFLARE_API_TOKEN at https://dash.cloudflare.com/profile/api-tokens.`,
    );
    expect(found?.fix).toContain(
      `with only ${WORKERS} for the account that holds docs.example.com, and set OPSCREW_CLOUDFLARE_DEPLOY_TOKEN to it`,
    );
    const deployOnly = net();
    deployOnly.deploy.denied.add("workers");
    expect(provider(await checks(plan("cloudflare-workers"), { net: deployOnly }))?.message).toBe(
      `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN lacks ${WORKERS} for the account that holds example.com.`,
    );
  });

  it("fails without the deploy token, and only looks for both tokens offline", async () => {
    const missing = provider(
      await checks(plan("cloudflare-workers"), {
        env: { CLOUDFLARE_API_TOKEN: CLOUDFLARE, GITHUB_TOKEN: GITHUB },
      }),
    );
    expect(missing).toMatchObject({
      status: "fail",
      message: `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN is not set: the deploy workflow needs a token of its own that holds only ${WORKERS}.`,
      fix: expect.stringContaining("`opscrew provision` stores it as a GitHub secret"),
    });
    expect(provider(await checks(plan("cloudflare-workers"), { offline: true }))).toMatchObject({
      status: "pass",
      message: `CLOUDFLARE_API_TOKEN and OPSCREW_CLOUDFLARE_DEPLOY_TOKEN are set (offline: only checked that it is set, not that it works). Both need ${WORKERS}.`,
    });
  });

  it("reads the www redirect rule's phase, naming its permission when the token may not", async () => {
    const denied = net();
    denied.main.denied.add("http_request_dynamic_redirect");
    const list = await checks(plan("cloudflare-workers", true), { net: denied });
    const cloudflare = list.find((check) => check.id === "cloudflare");
    expect(cloudflare).toMatchObject({ status: "fail" });
    expect(cloudflare?.fix).toContain("Zone → Single Redirect → Edit");
    // Without www the redirect phase is never read.
    const without = await checks(plan("cloudflare-workers"), { net: denied });
    expect(without.find((check) => check.id === "cloudflare")?.status).toBe("pass");
  });
});

describe("opscrew init with GitHub Pages", () => {
  it("passes for a public repository whose Pages settings the token reads", async () => {
    expect(provider(await checks(plan("github-pages")))).toMatchObject({
      title: "GitHub Pages",
      status: "pass",
      message: expect.stringContaining(
        "can read the GitHub Pages settings of acme/site, and GitHub allows Pages for it.",
      ),
    });
  });

  it("fails a private repository on GitHub's free plan, and warns when the plan cannot be read", async () => {
    const free = provider(
      await checks(plan("github-pages"), { net: net({ github: { private: true, plan: "free" } }) }),
    );
    expect(free).toMatchObject({
      status: "fail",
      message:
        "GitHub Pages is not available for acme/site: the repository is private, and its owner's GitHub plan has GitHub Pages for public repositories only.",
      fix: "Make the repository public, or move to GitHub Pro, Team or Enterprise (the site is public even then); or choose Cloudflare hosting with `opscrew interview`.",
    });
    const unknown = provider(
      await checks(plan("github-pages"), { net: net({ github: { private: true } }) }),
    );
    expect(unknown).toMatchObject({
      status: "warn",
      fix: expect.stringContaining("Give the token Plan: Read"),
    });
  });

  it("names the Pages permission GitHub refused", async () => {
    const found = provider(
      await checks(plan("github-pages"), {
        net: net({ github: { private: false, pagesRead: false } }),
      }),
    );
    expect(found).toMatchObject({
      status: "fail",
      fix: "Give the token Pages: Read on this repository (https://github.com/settings/personal-access-tokens), then run the command again.",
    });
  });
});
