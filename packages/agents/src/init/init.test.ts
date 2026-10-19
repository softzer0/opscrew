import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import type {
  AgentRuntime,
  CommandResult,
  FetchLike,
  RegistrarAccountCheck,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type Requirements, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDeps,
} from "../testing";
import { type TestPlanOptions, testPlan } from "../verify/__fixtures__/plan";
import { missingGitignoreEntries } from "./gitignore";
import {
  ensureGitignore,
  type InitCheck,
  type InitCheckId,
  type InitServices,
  initPassed,
  runInitChecks,
} from "./index";

const HCLOUD = fakeSecret("aws-secret-access-key", "hcloud");
const CLOUDFLARE = fakeSecret("aws-secret-access-key", "cloudflare");
const GITHUB = fakeSecret("github-token", "init");
const ANTHROPIC = fakeSecret("anthropic-key", "init");
const DIGITALOCEAN = fakeSecret("digitalocean-token", "init");
const TOKENS = [HCLOUD, CLOUDFLARE, GITHUB, ANTHROPIC, DIGITALOCEAN];

const ALL_TOOLS = ["git", "tofu", "ssh", "ssh-keyscan", "gitleaks", "osv-scanner", "trivy"];

function whichOf(installed: readonly string[]): (name: string) => string | undefined {
  return (name) => (installed.includes(name) ? `/usr/bin/${name}` : undefined);
}

interface RepoOptions {
  isRepo?: boolean;
  origin?: string | null;
  tofuVersion?: string;
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const failed = (stderr = ""): CommandResult => ({ exitCode: 1, stdout: "", stderr });

function repoRunner(o: RepoOptions = {}): ScriptedRunner {
  return new ScriptedRunner((command, args) => {
    if (command.endsWith("git")) {
      const sub = args.slice(2);
      if (sub[0] === "rev-parse") {
        return o.isRepo === false
          ? { exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }
          : ok("true\n");
      }
      if (sub[0] === "remote") {
        const origin = o.origin === undefined ? "git@github.com:acme/shop.git" : o.origin;
        return origin === null ? failed("error: No such remote 'origin'") : ok(`${origin}\n`);
      }
    }
    if (command.endsWith("tofu") && args[0] === "version") {
      return ok(JSON.stringify({ terraform_version: o.tofuVersion ?? "1.10.6" }));
    }
    return failed(`unexpected command ${command}`);
  });
}

interface NetOptions {
  hetzner?: 200 | 401 | "hang";
  /** Account status DigitalOcean reports for the token, or a refusal. */
  digitalocean?: "active" | "locked" | 401;
  cloudflare?: "active" | 401;
  /** Zone `example.com` is visible to the Cloudflare token. */
  zone?: boolean;
  github?: "push" | "read" | 404;
  /** Registrar answer to domain-check: allowed, refused (permission), or another error. */
  registrar?: "ok" | 403 | 400 | "hang";
  /** Accounts the Cloudflare token can see (default one). */
  accounts?: number;
  /** The zone's details and rulesets (default: a zone with none). */
  rules?: FakeZone;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeNet(o: NetOptions = {}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const rules = o.rules ?? new FakeZone();
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.pathname.startsWith(`/client/v4/zones/${FAKE_ZONE_ID}`))
      return rules.fetch(input, init);
    if (url.hostname === "api.hetzner.cloud") {
      const mode = o.hetzner ?? 200;
      if (mode === "hang") return new Promise<Response>(() => {});
      return mode === 200
        ? json(200, { locations: [{ id: 1, name: "fsn1", country: "DE" }] })
        : json(401, { error: { code: "unauthorized", message: "unable to authenticate" } });
    }
    if (url.hostname === "api.digitalocean.com" && url.pathname === "/v2/account") {
      const mode = o.digitalocean ?? "active";
      if (mode === 401) {
        return json(401, { id: "unauthorized", message: "Unable to authenticate you" });
      }
      return json(200, {
        account: {
          droplet_limit: 25,
          email: "owner@example.com",
          uuid: "00000000-0000-4000-8000-000000000001",
          email_verified: true,
          status: mode,
          status_message: mode === "locked" ? "Your account is locked for billing." : "",
          team: { uuid: "00000000-0000-4000-8000-000000000002", name: "Shop Team" },
        },
      });
    }
    if (url.hostname === "api.cloudflare.com") {
      const active = (o.cloudflare ?? "active") === "active";
      if (!active) {
        return json(401, {
          success: false,
          errors: [{ code: 1000, message: "Invalid API Token" }],
        });
      }
      if (url.pathname.endsWith("/user/tokens/verify")) {
        return json(200, { success: true, errors: [], result: { status: "active" } });
      }
      if (url.pathname.endsWith("/accounts")) {
        const count = o.accounts ?? 1;
        const accounts = Array.from({ length: count }, (_, i) => ({
          id: `acct-${i + 1}`,
          name: `Shop ${i + 1}`,
        }));
        return json(200, { success: true, errors: [], result: accounts });
      }
      if (url.pathname.endsWith("/registrar/domain-check")) {
        const mode = o.registrar ?? "ok";
        if (mode === "hang") return new Promise<Response>(() => {});
        if (mode === 403) {
          return json(403, {
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
          });
        }
        if (mode === 400) {
          return json(400, {
            success: false,
            errors: [{ code: 1001, message: "Registrar is not enabled on this account" }],
          });
        }
        return json(200, {
          success: true,
          errors: [],
          result: { domains: [{ name: "opscrew-registrar-check.com", registrable: false }] },
        });
      }
      if (url.pathname.endsWith("/zones")) {
        const name = url.searchParams.get("name");
        const zones =
          (o.zone ?? true) && name === "example.com"
            ? [{ id: FAKE_ZONE_ID, name: "example.com", status: "active", name_servers: [] }]
            : [];
        return json(200, { success: true, errors: [], result: zones });
      }
    }
    if (url.hostname === "api.github.com" && url.pathname === "/repos/acme/shop") {
      const mode = o.github ?? "push";
      if (mode === 404) return json(404, { message: `Not Found for ${GITHUB}` });
      return json(200, {
        default_branch: "main",
        private: true,
        permissions: { push: mode === "push" },
      });
    }
    return json(500, { message: `unexpected ${url}` });
  };
  return { fetch, calls };
}

interface Setup {
  env?: Record<string, string | undefined>;
  repo?: RepoOptions;
  net?: NetOptions;
  tools?: readonly string[];
  gitignore?: string;
  runtime?: AgentRuntime;
}

async function setup(o: Setup = {}): Promise<{ deps: TestPhaseDeps; calls: string[] }> {
  const { fetch, calls } = fakeNet(o.net);
  const deps = await createTestPhaseDeps({
    env: o.env ?? {
      HCLOUD_TOKEN: HCLOUD,
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      GITHUB_TOKEN: GITHUB,
      ANTHROPIC_API_KEY: ANTHROPIC,
    },
    runner: repoRunner(o.repo),
    fetch,
    ...(o.runtime ? { runtime: o.runtime } : {}),
  });
  await writeFile(
    join(deps.paths.root, ".gitignore"),
    o.gitignore ?? "node_modules/\n.opscrew/\n.terraform/\n",
  );
  return { deps, calls };
}

function services(o: Setup = {}, extra: InitServices = {}): InitServices {
  return { which: whichOf(o.tools ?? ALL_TOOLS), nodeVersion: "22.12.0", ...extra };
}

async function check(
  id: InitCheckId,
  o: Setup = {},
  options: { offline?: boolean; services?: InitServices } = {},
): Promise<InitCheck> {
  const { deps } = await setup(o);
  const checks = await runInitChecks(deps, {
    ...(options.offline ? { offline: true } : {}),
    services: options.services ?? services(o),
  });
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

function expectNoTokens(value: unknown): void {
  const text = JSON.stringify(value);
  for (const token of TOKENS) expect(text).not.toContain(token);
}

async function writeRequirements(deps: TestPhaseDeps, extra: Partial<Requirements>) {
  const requirements: Requirements = {
    schemaVersion: 1,
    answeredAt: "2026-10-11T12:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 20, currency: "EUR" },
    provider: "hetzner",
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "important",
    dnsProvider: "none",
    keepExternalServices: {},
    ...extra,
  };
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
}

describe("runInitChecks", () => {
  it("passes every check on a ready machine and verifies the tokens over the network", async () => {
    const { deps, calls } = await setup();
    await writeRequirements(deps, { dnsProvider: "cloudflare", domain: "shop.example.com" });
    const checks = await runInitChecks(deps, { services: services() });
    expect(checks.map((c) => c.id)).toEqual([
      "node",
      "git",
      "repository",
      "engine",
      "ssh",
      "provider",
      "cloudflare",
      "registrar",
      "github",
      "model",
      "scanners",
      "gitignore",
    ]);
    for (const c of checks)
      expect({ id: c.id, status: c.status }).toEqual({ id: c.id, status: "pass" });
    expect(initPassed(checks)).toBe(true);
    expect(checks.find((c) => c.id === "engine")?.message).toContain("OpenTofu 1.10.6");
    expect(checks.find((c) => c.id === "repository")?.message).toContain("acme/shop");
    expect(checks.find((c) => c.id === "cloudflare")?.message).toContain("example.com");
    expect(calls.some((u) => u.includes("api.hetzner.cloud"))).toBe(true);
    expect(calls.some((u) => u.includes("/user/tokens/verify"))).toBe(true);
    expect(calls.some((u) => u.includes("/repos/acme/shop"))).toBe(true);
    expectNoTokens(checks);
  });

  it("fails an old Node.js with install instructions", async () => {
    const node = await check("node", {}, { services: services({}, { nodeVersion: "20.18.1" }) });
    expect(node.status).toBe("fail");
    expect(node.message).toContain("20.18.1");
    expect(node.fix).toContain("https://nodejs.org");
    const recent = await check("node", {}, { services: services({}, { nodeVersion: "20.19.0" }) });
    expect(recent.status).toBe("pass");
  });

  it("fails without git and skips the repository check", async () => {
    const tools = ALL_TOOLS.filter((t) => t !== "git");
    const { deps } = await setup({ tools });
    const checks = await runInitChecks(deps, { services: services({ tools }) });
    const git = checks.find((c) => c.id === "git");
    expect(git?.status).toBe("fail");
    expect(git?.fix).toContain("https://git-scm.com/downloads");
    expect(checks.find((c) => c.id === "repository")?.status).toBe("skip");
    expect(initPassed(checks)).toBe(false);
  });

  it("fails outside a git repository, without origin and with a non-GitHub origin", async () => {
    const notRepo = await check("repository", { repo: { isRepo: false } });
    expect(notRepo.status).toBe("fail");
    expect(notRepo.fix).toContain("git init");
    const noOrigin = await check("repository", { repo: { origin: null } });
    expect(noOrigin.status).toBe("fail");
    expect(noOrigin.fix).toContain("git remote add origin");
    const gitlab = await check("repository", {
      repo: { origin: "https://gitlab.com/acme/shop.git" },
    });
    expect(gitlab.status).toBe("fail");
  });

  it("fails when neither OpenTofu nor Terraform is installed, or the version is too old", async () => {
    const tools = ALL_TOOLS.filter((t) => t !== "tofu");
    const missing = await check("engine", { tools });
    expect(missing.status).toBe("fail");
    expect(missing.fix).toContain("https://opentofu.org/docs/intro/install/");
    expect(missing.fix).toContain("OPSCREW_TOFU_BIN");
    const old = await check("engine", { repo: { tofuVersion: "1.5.7" } });
    expect(old.status).toBe("fail");
    expect(old.message).toContain("1.5.7");
    expect(old.message).toContain("1.6.0");
  });

  it("fails when ssh-keyscan is missing", async () => {
    const tools = ALL_TOOLS.filter((t) => t !== "ssh-keyscan");
    const ssh = await check("ssh", { tools });
    expect(ssh.status).toBe("fail");
    expect(ssh.message).toContain("ssh-keyscan");
    expect(ssh.message).not.toMatch(/^ssh and/);
    expect(ssh.fix).toContain("OpenSSH");
  });

  it("fails a missing or rejected Hetzner token with the env var and create link", async () => {
    const missing = await check("provider", { env: { GITHUB_TOKEN: GITHUB } });
    expect(missing.status).toBe("fail");
    expect(missing.fix).toContain("HCLOUD_TOKEN");
    expect(missing.fix).toContain("https://console.hetzner.cloud/");
    const rejected = await check("provider", { net: { hetzner: 401 } });
    expect(rejected.status).toBe("fail");
    expect(rejected.fix).toContain("Read & Write");
    expectNoTokens(rejected);
  });

  it("fails a network check that runs over its time budget", async () => {
    const started = Date.now();
    const slow = await check(
      "provider",
      { net: { hetzner: "hang" } },
      { services: services({}, { timeoutMs: 30 }) },
    );
    expect(slow.status).toBe("fail");
    expect(slow.message).toContain("did not answer");
    expect(slow.fix).toContain("--offline");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("falls back to the interview answers when opscrew/plan.yaml is invalid, without a failure of its own", async () => {
    const { deps } = await setup();
    await writeRequirements(deps, { dnsProvider: "cloudflare", domain: "shop.example.com" });
    await writeFile(deps.paths.files.plan, "schemaVersion: [not a plan\n");

    const checks = await runInitChecks(deps, { services: services() });

    const cf = checks.find((c) => c.id === "cloudflare");
    expect(cf?.status).toBe("pass");
    expect(cf?.message).toContain("example.com");
    expect(checks.find((c) => c.id === "provider")?.status).toBe("pass");
    expect(checks.every((c) => !c.message.includes("plan.yaml"))).toBe(true);
    expect(initPassed(checks)).toBe(true);
  });

  it("stops when opscrew/plan.yaml cannot be read for another reason", async () => {
    const { deps } = await setup();
    // A folder where the plan file should be: reading it fails with EISDIR, not ENOENT.
    await mkdir(deps.paths.files.plan, { recursive: true });

    await expect(runInitChecks(deps, { services: services() })).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  describe("cloud provider token", () => {
    const DO_TOKEN_PAGE = "https://cloud.digitalocean.com/account/api/tokens";
    const both = { HCLOUD_TOKEN: HCLOUD, DIGITALOCEAN_TOKEN: DIGITALOCEAN, GITHUB_TOKEN: GITHUB };

    async function providerCheck(
      o: Setup & { plan?: TestPlanOptions; requirements?: Partial<Requirements> },
      offline = false,
    ) {
      const { deps, calls } = await setup(o);
      if (o.plan) await writeArtifact("plan", deps.paths.files.plan, testPlan(o.plan));
      if (o.requirements) await writeRequirements(deps, o.requirements);
      const checks = await runInitChecks(deps, {
        ...(offline ? { offline: true } : {}),
        services: services(o),
      });
      const found = checks.find((c) => c.id === "provider");
      if (!found) throw new Error("no provider check");
      expectNoTokens(checks);
      const touched = (host: string) => calls.some((u) => new URL(u).hostname === host);
      return {
        check: found,
        hetznerCalled: touched("api.hetzner.cloud"),
        digitaloceanCalled: touched("api.digitalocean.com"),
      };
    }

    it("verifies only the DigitalOcean token for a DigitalOcean plan and lists its scopes", async () => {
      const { check, hetznerCalled, digitaloceanCalled } = await providerCheck({
        env: both,
        plan: { provider: "digitalocean" },
      });
      expect(check.title).toBe("DigitalOcean token");
      expect(check.status).toBe("pass");
      expect(check.message).toContain("DIGITALOCEAN_TOKEN works (Shop Team)");
      expect(check.message).toContain("droplet:create");
      expect(check.message).toContain("image:create");
      expect(check.message).not.toContain("owner@example.com");
      expect(digitaloceanCalled).toBe(true);
      expect(hetznerCalled).toBe(false);
    });

    it("fails a locked DigitalOcean account or a rejected token with the token page and scopes", async () => {
      const locked = await providerCheck({
        env: both,
        plan: { provider: "digitalocean" },
        net: { digitalocean: "locked" },
      });
      expect(locked.check.status).toBe("fail");
      expect(locked.check.message).toContain("locked");
      expect(locked.check.fix).toContain("https://cloud.digitalocean.com/account");
      expect(locked.check.fix).not.toContain(DO_TOKEN_PAGE);
      expect(locked.check.fix).not.toContain("droplet:create");
      const rejected = await providerCheck({
        env: both,
        plan: { provider: "digitalocean" },
        net: { digitalocean: 401 },
      });
      expect(rejected.check.status).toBe("fail");
      expect(rejected.check.fix).toContain(DO_TOKEN_PAGE);
      expect(rejected.check.fix).toContain("droplet:create");
      expect(rejected.check.fix).toContain("set DIGITALOCEAN_TOKEN to it");
      expect(rejected.hetznerCalled).toBe(false);
    });

    it("fails a missing DigitalOcean token and says the Hetzner token is not used", async () => {
      const { check, hetznerCalled } = await providerCheck({
        env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB },
        plan: { provider: "digitalocean" },
      });
      expect(check.title).toBe("DigitalOcean token");
      expect(check.status).toBe("fail");
      expect(check.message).toContain("DIGITALOCEAN_TOKEN is not set");
      expect(check.message).toContain("HCLOUD_TOKEN is not used");
      expect(check.fix).toContain(DO_TOKEN_PAGE);
      expect(check.fix).toContain("account:read");
      expect(check.fix).not.toMatch(/DIGITALOCEAN_TOKEN\s*:/);
      expect(hetznerCalled).toBe(false);
    });

    it("verifies only the Hetzner token for a Hetzner plan when both tokens are set", async () => {
      const { check, hetznerCalled, digitaloceanCalled } = await providerCheck({
        env: both,
        plan: { provider: "hetzner" },
      });
      expect(check).toMatchObject({
        title: "Hetzner Cloud token",
        status: "pass",
        message: "HCLOUD_TOKEN works.",
      });
      expect(hetznerCalled).toBe(true);
      expect(digitaloceanCalled).toBe(false);
    });

    it("follows the interview answer before a plan exists", async () => {
      const { check, hetznerCalled } = await providerCheck({
        env: both,
        requirements: { provider: "digitalocean" },
      });
      expect(check.title).toBe("DigitalOcean token");
      expect(check.status).toBe("pass");
      expect(hetznerCalled).toBe(false);
    });

    it("passes either token before a provider is chosen and says only one is needed", async () => {
      const { check, digitaloceanCalled } = await providerCheck({
        env: { DIGITALOCEAN_TOKEN: DIGITALOCEAN, GITHUB_TOKEN: GITHUB },
      });
      expect(check.title).toBe("DigitalOcean token");
      expect(check.status).toBe("pass");
      expect(check.message).toContain("only one cloud provider token");
      expect(digitaloceanCalled).toBe(true);

      const hetzner = await providerCheck({ env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB } });
      expect(hetzner.check.title).toBe("Hetzner Cloud token");
      expect(hetzner.check.status).toBe("pass");
      expect(hetzner.check.message).toContain("only one cloud provider token");
    });

    it("passes both tokens before a provider is chosen without checking either", async () => {
      const { check, hetznerCalled, digitaloceanCalled } = await providerCheck({ env: both });
      expect(check.title).toBe("Cloud provider token");
      expect(check.status).toBe("pass");
      expect(check.message).toContain("HCLOUD_TOKEN and DIGITALOCEAN_TOKEN are both set");
      expect(check.message).toContain("only one");
      expect(hetznerCalled).toBe(false);
      expect(digitaloceanCalled).toBe(false);
    });

    it("fails without any provider token and explains both", async () => {
      const { check } = await providerCheck({ env: { GITHUB_TOKEN: GITHUB } });
      expect(check.title).toBe("Cloud provider token");
      expect(check.status).toBe("fail");
      for (const text of [
        "HCLOUD_TOKEN",
        "https://console.hetzner.cloud/",
        "DIGITALOCEAN_TOKEN",
        DO_TOKEN_PAGE,
      ]) {
        expect(check.fix).toContain(text);
      }
    });

    it("offline: only looks for the planned provider's token and still lists the scopes", async () => {
      const present = await providerCheck({ env: both, plan: { provider: "digitalocean" } }, true);
      expect(present.check.status).toBe("pass");
      expect(present.check.message).toContain("DIGITALOCEAN_TOKEN is set");
      expect(present.check.message).toContain("only checked that it is set");
      expect(present.check.message).toContain("droplet:create");
      expect(present.digitaloceanCalled).toBe(false);
      const missing = await providerCheck(
        { env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB }, plan: { provider: "digitalocean" } },
        true,
      );
      expect(missing.check.status).toBe("fail");
    });
  });

  describe("Cloudflare", () => {
    it("fails a missing token when the requirements put the domain on Cloudflare", async () => {
      const { deps } = await setup({ env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB } });
      await writeRequirements(deps, { dnsProvider: "cloudflare", domain: "shop.example.com" });
      const checks = await runInitChecks(deps, { services: services() });
      const cf = checks.find((c) => c.id === "cloudflare");
      expect(cf?.status).toBe("fail");
      expect(cf?.message).toContain("shop.example.com");
      expect(cf?.fix).toContain("https://dash.cloudflare.com/profile/api-tokens");
      expect(cf?.fix).toContain("CLOUDFLARE_API_TOKEN");
      expect(initPassed(checks)).toBe(false);
    });

    it("names the missing permission when the token cannot see the planned zone", async () => {
      const { deps } = await setup({ net: { zone: false } });
      await writeArtifact("plan", deps.paths.files.plan, testPlan());
      const checks = await runInitChecks(deps, { services: services() });
      const cf = checks.find((c) => c.id === "cloudflare");
      expect(cf?.status).toBe("fail");
      expect(cf?.message).toContain("Zone → Zone → Read");
      expect(cf?.fix).toContain("https://dash.cloudflare.com/profile/api-tokens");
      expectNoTokens(checks);
    });

    it("reads both rulesets of OpsCrew's shared rules and changes nothing", async () => {
      const rules = new FakeZone();
      const { deps } = await setup({ net: { rules } });
      await writeArtifact("plan", deps.paths.files.plan, testPlan());
      const checks = await runInitChecks(deps, { services: services() });
      expect(checks.find((c) => c.id === "cloudflare")?.status).toBe("pass");
      expect(rules.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        `GET /zones/${FAKE_ZONE_ID}`,
        `GET /zones/${FAKE_ZONE_ID}/rulesets/phases/http_request_firewall_custom/entrypoint`,
        `GET /zones/${FAKE_ZONE_ID}/rulesets/phases/http_config_settings/entrypoint`,
      ]);
    });

    it.each([
      ["http_request_firewall_custom", "WAF custom rules", "Zone → Zone WAF → Edit"],
      ["http_config_settings", "configuration rules", "Zone → Config Rules → Edit"],
    ])(
      "names the missing permission when reading the %s ruleset answers 403",
      async (phase, rulesName, permission) => {
        const rules = new FakeZone();
        rules.denied.add(phase);
        const { deps } = await setup({ net: { rules } });
        await writeArtifact("plan", deps.paths.files.plan, testPlan());
        const checks = await runInitChecks(deps, { services: services() });
        const cf = checks.find((c) => c.id === "cloudflare");
        expect(cf?.status).toBe("fail");
        expect(cf?.message).toBe(
          `CLOUDFLARE_API_TOKEN can see the zone example.com, but OpsCrew cannot keep its shared rules there: The Cloudflare token may not read the zone's ${rulesName} (HTTP 403).`,
        );
        expect(cf?.fix).toBe(
          `Edit the token at https://dash.cloudflare.com/profile/api-tokens and give it ${permission} for this zone, then run the command again.`,
        );
        expect(rules.writes()).toEqual([]);
        expect(initPassed(checks)).toBe(false);
        expectNoTokens(checks);
      },
    );

    it("does not report OpsCrew's rule changed in the dashboard as a token problem", async () => {
      const rules = new FakeZone();
      // OpsCrew's probe block, its expression edited by hand: provision stops on it, init does not.
      const edited = {
        ref: "opscrew-block-probes",
        description: "Block probes for secrets and admin panels",
        expression: '(http.host eq "shop.example.com")',
        action: "block",
      };
      rules.seedRule("http_request_firewall_custom", edited);
      const { deps } = await setup({ net: { rules } });
      await writeArtifact("plan", deps.paths.files.plan, testPlan());
      const checks = await runInitChecks(deps, { services: services() });
      const cf = checks.find((c) => c.id === "cloudflare");
      expect(cf?.status).toBe("pass");
      expect(cf?.message).toBe("CLOUDFLARE_API_TOKEN works and can see the zone example.com.");
    });

    it("only warns about a missing token before the DNS choice is known", async () => {
      const cf = await check("cloudflare", { env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB } });
      expect(cf.status).toBe("warn");
      expect(cf.fix).toContain("CLOUDFLARE_API_TOKEN");
    });

    it("skips a missing token when the plan does not use Cloudflare", async () => {
      const { deps } = await setup({ env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB } });
      await writeRequirements(deps, { dnsProvider: "none" });
      const checks = await runInitChecks(deps, { services: services() });
      expect(checks.find((c) => c.id === "cloudflare")?.status).toBe("skip");
    });

    it("warns about a rejected optional token", async () => {
      const cf = await check("cloudflare", { net: { cloudflare: 401 } });
      expect(cf.status).toBe("warn");
      expect(cf.message).toContain("rejected");
      expectNoTokens(cf);
    });
  });

  describe("Cloudflare Registrar", () => {
    const CF_TOKEN = fakeSecret("cloudflare-token", "registrar");
    const env = { HCLOUD_TOKEN: HCLOUD, CLOUDFLARE_API_TOKEN: CF_TOKEN, GITHUB_TOKEN: GITHUB };

    function expectNoCfToken(value: unknown): void {
      expect(JSON.stringify(value)).not.toContain(CF_TOKEN);
      expectNoTokens(value);
    }

    it("passes when the token can use the Registrar, with a cheap read that buys nothing", async () => {
      const { deps, calls } = await setup({ env });
      const checks = await runInitChecks(deps, { services: services() });
      const reg = checks.find((c) => c.id === "registrar");
      expect(reg?.status).toBe("pass");
      // only a read was checked: it never claims the token can buy
      expect(reg?.message).toContain("can use Cloudflare Registrar (read)");
      expect(reg?.message).not.toContain("can buy domains");
      expect(reg?.message).toContain("Buying also needs Account → Registrar (edit) and");
      expect(reg?.message).toContain("Zone → Zone → Edit");
      expect(reg?.message).toContain("OpsCrew cannot check these without buying");
      expect(reg?.message).not.toContain("CLOUDFLARE_API_TOKEN:");
      expect(calls.some((u) => u.includes("/accounts/acct-1/registrar/domain-check"))).toBe(true);
      const registrarCalls = calls.filter((u) => u.includes("/registrar"));
      expect(registrarCalls.every((u) => u.endsWith("/registrar/domain-check"))).toBe(true);
      expect(initPassed(checks)).toBe(true);
      expectNoCfToken(checks);
    });

    it("warns with the missing permissions when the Registrar refuses the token", async () => {
      const reg = await check("registrar", { env, net: { registrar: 403 } });
      expect(reg.status).toBe("warn");
      expect(reg.fix).toContain("Buying domains is optional");
      expect(reg.fix).toContain("Account → Registrar (edit)");
      expect(reg.fix).toContain("https://dash.cloudflare.com/profile/api-tokens");
      // the zone permissions must also cover the zone of a domain bought later
      expect(reg.fix).toContain("for all zones of the account, not only the zone you use today");
      expectNoCfToken(reg);
    });

    it("warns with the missing permissions when the token sees no account", async () => {
      const reg = await check("registrar", { env, net: { accounts: 0 } });
      expect(reg.status).toBe("warn");
      expect(reg.fix).toContain("Account → Registrar (edit)");
    });

    it("warns with the plain cause on other errors and never fails init", async () => {
      const { deps } = await setup({ env, net: { registrar: 400 } });
      const checks = await runInitChecks(deps, { services: services() });
      const reg = checks.find((c) => c.id === "registrar");
      expect(reg?.status).toBe("warn");
      expect(reg?.message).toContain("Registrar is not enabled on this account");
      expect(initPassed(checks)).toBe(true);
      expectNoCfToken(checks);
    });

    it("stays a warning even when the plan needs Cloudflare", async () => {
      const { deps } = await setup({ env, net: { registrar: 403 } });
      await writeArtifact("plan", deps.paths.files.plan, testPlan());
      const checks = await runInitChecks(deps, { services: services() });
      expect(checks.find((c) => c.id === "cloudflare")?.status).toBe("pass");
      expect(checks.find((c) => c.id === "registrar")?.status).toBe("warn");
      expect(initPassed(checks)).toBe(true);
    });

    it("warns within the time budget when the Registrar does not answer", async () => {
      const reg = await check(
        "registrar",
        { env, net: { registrar: "hang" } },
        { services: services({}, { timeoutMs: 50 }) },
      );
      expect(reg.status).toBe("warn");
      expect(reg.message).toContain("did not answer");
    });

    it("is not checked without a token or when the token does not work", async () => {
      const none = await check("registrar", {
        env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB },
      });
      expect(none.status).toBe("skip");
      const rejected = await check("registrar", { env, net: { cloudflare: 401 } });
      expect(rejected.status).toBe("skip");
      expect(rejected.message).toContain("does not work");
    });

    it("offline: says it was not checked and makes no call", async () => {
      const { deps, calls } = await setup({ env });
      const checks = await runInitChecks(deps, { offline: true, services: services() });
      const reg = checks.find((c) => c.id === "registrar");
      expect(reg?.status).toBe("skip");
      expect(reg?.message).toContain("not checked");
      expect(calls).toEqual([]);
    });
  });

  describe("GitHub", () => {
    it("fails without a token", async () => {
      const gh = await check("github", { env: { HCLOUD_TOKEN: HCLOUD } });
      expect(gh.status).toBe("fail");
      expect(gh.fix).toContain("GITHUB_TOKEN");
      expect(gh.fix).toContain("gh auth login");
      expect(gh.fix).toContain("Contents: Read and write");
      expect(gh.fix).toContain("https://github.com/settings/personal-access-tokens/new");
    });

    it("names both variables in the missing-token message, unmasked by the redactor", async () => {
      const { deps } = await setup({ env: { HCLOUD_TOKEN: HCLOUD } });
      const checks = await runInitChecks(deps, { services: services() });
      const gh = checks.find((c) => c.id === "github");
      const expected =
        "No GitHub token is set (GITHUB_TOKEN and GH_TOKEN are empty) and the GitHub CLI is not logged in.";
      expect(gh?.message).toBe(expected);
      expect(deps.redactor.redact(expected)).toBe(expected);
    });

    it("fails when the token cannot push", async () => {
      const gh = await check("github", { net: { github: "read" } });
      expect(gh.status).toBe("fail");
      expect(gh.message).toContain("cannot push to acme/shop");
      expect(gh.fix).toContain("acme/shop");
    });

    it("fails when the token cannot read the repository, without echoing the token", async () => {
      const gh = await check("github", { net: { github: 404 } });
      expect(gh.status).toBe("fail");
      expect(gh.message).toContain("cannot read acme/shop");
      expectNoTokens(gh);
    });

    it("reads GH_TOKEN too", async () => {
      const gh = await check("github", { env: { HCLOUD_TOKEN: HCLOUD, GH_TOKEN: GITHUB } });
      expect(gh.status).toBe("pass");
      expect(gh.message).toContain("GH_TOKEN");
    });
  });

  describe("model credentials", () => {
    it("warns when none are configured, with the env vars to set", async () => {
      const model = await check("model", { env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB } });
      expect(model.status).toBe("warn");
      expect(model.fix).toContain("ANTHROPIC_API_KEY");
    });

    it("accepts a cloud provider flag", async () => {
      const model = await check("model", {
        env: { HCLOUD_TOKEN: HCLOUD, GITHUB_TOKEN: GITHUB, CLAUDE_CODE_USE_BEDROCK: "1" },
      });
      expect(model.status).toBe("pass");
    });

    it("asks the runtime when one is configured", async () => {
      const runtime = (ok: boolean): AgentRuntime => ({
        id: "fake",
        isConfigured: async () =>
          ok ? { ok: true } : { ok: false, reason: "No key.", hint: "Set THE_KEY." },
        runPhase: async () => {
          throw new Error("not used");
        },
      });
      expect((await check("model", { runtime: runtime(true) })).status).toBe("pass");
      const missing = await check("model", { runtime: runtime(false) });
      expect(missing.status).toBe("warn");
      expect(missing.fix).toBe("Set THE_KEY.");
    });
  });

  it("warns about missing optional scanners with install hints", async () => {
    const tools = ALL_TOOLS.filter((t) => t !== "trivy" && t !== "gitleaks");
    const scanners = await check("scanners", { tools });
    expect(scanners.status).toBe("warn");
    expect(scanners.message).toContain("gitleaks, trivy");
    expect(scanners.fix).toContain("https://trivy.dev");
  });

  it("warns when .opscrew/ is not in .gitignore", async () => {
    const gi = await check("gitignore", { gitignore: "node_modules/\n" });
    expect(gi.status).toBe("warn");
    expect(gi.fix).toContain("opscrew init --fix");
    expect(gi.fix).toContain(".opscrew/ and .terraform/");
  });

  it("warns when .terraform/ (provider binaries under opscrew/infra/) is not in .gitignore", async () => {
    const gi = await check("gitignore", { gitignore: ".opscrew/\n/.terraform/\n" });
    expect(gi.status).toBe("warn");
    expect(gi.message).toBe(
      ".gitignore does not ignore .terraform/, so the provider binaries OpenTofu or Terraform download under opscrew/infra/ could be committed.",
    );
    expect(gi.fix).toBe(
      "Run `opscrew init --fix` to add .terraform/ to .gitignore, or add it yourself.",
    );
    const covered = await check("gitignore", { gitignore: ".opscrew/\n**/.terraform/*\n" });
    expect(covered).toMatchObject({
      status: "pass",
      message: ".gitignore ignores .opscrew/ and .terraform/.",
    });
  });

  it("offline: never touches the network and says tokens were only checked for presence", async () => {
    const { deps } = await setup();
    // createTestPhaseDeps' default fetch throws; replace the fake with it to prove no call happens.
    deps.fetch = async (input) => {
      throw new Error(`network call in offline mode: ${String(input)}`);
    };
    await writeRequirements(deps, { dnsProvider: "cloudflare", domain: "shop.example.com" });
    const checks = await runInitChecks(deps, { offline: true, services: services() });
    for (const id of ["provider", "cloudflare", "github"] as const) {
      const c = checks.find((x) => x.id === id);
      expect(c?.status).toBe("pass");
      expect(c?.message).toContain("only checked that it is set");
    }
    const registrar = checks.find((x) => x.id === "registrar");
    expect(registrar?.status).toBe("skip");
    expect(registrar?.message).toContain("not checked");
    expect(initPassed(checks)).toBe(true);
    expectNoTokens(checks);

    const { deps: empty } = await setup({ env: {} });
    const missing = await runInitChecks(empty, { offline: true, services: services() });
    expect(missing.find((c) => c.id === "provider")?.status).toBe("fail");
    expect(missing.find((c) => c.id === "github")?.status).toBe("fail");
  });
});

describe("initPassed", () => {
  it("passes with warnings and skips, fails on any failure", () => {
    const base = { title: "t", message: "m" };
    expect(
      initPassed([
        { ...base, id: "model", status: "warn" },
        { ...base, id: "cloudflare", status: "skip" },
        { ...base, id: "node", status: "pass" },
      ]),
    ).toBe(true);
    expect(initPassed([{ ...base, id: "node", status: "fail" }])).toBe(false);
  });
});

describe("missingGitignoreEntries", () => {
  const covers = (text: string, entry: ".opscrew/" | ".terraform/") =>
    !missingGitignoreEntries(text).includes(entry);

  it("recognises the usual spellings of .opscrew/ and honours negation", () => {
    for (const line of [".opscrew", ".opscrew/", "/.opscrew/", ".opscrew/*", "/.opscrew/**"]) {
      expect(covers(`dist\n${line}\n`, ".opscrew/")).toBe(true);
    }
    const bom = String.fromCharCode(0xfeff);
    expect(covers(`${bom}.opscrew/\r\n`, ".opscrew/")).toBe(true);
    expect(covers("# .opscrew/\nopscrew/\n", ".opscrew/")).toBe(false);
    expect(covers(".opscrew/\n!.opscrew/\n", ".opscrew/")).toBe(false);
  });

  it("recognises .terraform at any depth and honours negation", () => {
    for (const line of [".terraform", ".terraform/", "**/.terraform/", "**/.terraform/*"]) {
      expect(covers(`dist\n${line}\n`, ".terraform/")).toBe(true);
    }
    // A rooted pattern does not reach opscrew/infra/prod/.terraform/.
    expect(covers("/.terraform/\n", ".terraform/")).toBe(false);
    expect(covers(".terraform/\n!.terraform/\n", ".terraform/")).toBe(false);
    expect(missingGitignoreEntries(undefined)).toEqual([".opscrew/", ".terraform/"]);
    expect(missingGitignoreEntries(".terraform/\n")).toEqual([".opscrew/"]);
  });
});

describe("ensureGitignore", () => {
  async function deps(answers: boolean[] = [true]) {
    const handler = new ScriptedApprovalHandler(answers);
    const d = await createTestPhaseDeps({ approvalHandler: handler });
    return { d, handler, file: join(d.paths.root, ".gitignore") };
  }

  it("leaves the file alone when the approval is refused", async () => {
    const { d, handler, file } = await deps([false]);
    await writeFile(file, "node_modules/\n");
    expect(await ensureGitignore(d)).toEqual([]);
    expect(await readFile(file, "utf8")).toBe("node_modules/\n");
    expect(handler.requests[0]?.kind).toBe("repo-write");
    expect(handler.requests[0]?.title).toBe("Add .opscrew/ and .terraform/ to .gitignore");
    expect(handler.requests[0]?.details).toContain("provider binaries");
    expect(d.reporter.text()).toContain("opscrew init --fix");
  });

  it("appends after approval, keeping CRLF line endings, and is idempotent", async () => {
    const { d, handler, file } = await deps([true]);
    await writeFile(file, "node_modules/\r\ndist/");
    expect(await ensureGitignore(d)).toEqual([".opscrew/", ".terraform/"]);
    expect(await readFile(file, "utf8")).toBe(
      "node_modules/\r\ndist/\r\n.opscrew/\r\n.terraform/\r\n",
    );
    expect(await ensureGitignore(d)).toEqual([]);
    expect(handler.requests).toHaveLength(1);
  });

  it("creates .gitignore when missing", async () => {
    const { d, file } = await deps([true]);
    expect(await ensureGitignore(d)).toEqual([".opscrew/", ".terraform/"]);
    expect(await readFile(file, "utf8")).toBe(".opscrew/\n.terraform/\n");
  });

  it("adds only what is missing", async () => {
    const { d, handler, file } = await deps([true]);
    await writeFile(file, "/.opscrew/\n");
    expect(await ensureGitignore(d)).toEqual([".terraform/"]);
    expect(await readFile(file, "utf8")).toBe("/.opscrew/\n.terraform/\n");
    expect(handler.requests[0]?.title).toBe("Add .terraform/ to .gitignore");
    expect(d.reporter.text()).toContain("Added .terraform/ to .gitignore.");
  });

  it("does nothing and asks nothing when both are present", async () => {
    const { d, handler, file } = await deps([true]);
    await writeFile(file, "/.opscrew/\n**/.terraform/*\n");
    expect(await ensureGitignore(d)).toEqual([]);
    expect(handler.requests).toHaveLength(0);
  });

  it("changes the file without asking with fix", async () => {
    const { d, handler, file } = await deps([false]);
    await writeFile(file, "node_modules/\n");
    expect(await ensureGitignore(d, { fix: true })).toEqual([".opscrew/", ".terraform/"]);
    expect(await readFile(file, "utf8")).toBe("node_modules/\n.opscrew/\n.terraform/\n");
    expect(handler.requests).toHaveLength(0);
  });
});

describe("registrar account checks", () => {
  const PORKBUN_KEY = fakeSecret("aws-secret-access-key", "porkbun-key");
  const PORKBUN_SECRET = fakeSecret("aws-secret-access-key", "porkbun-secret");
  const NAMECHEAP_KEY = fakeSecret("aws-secret-access-key", "namecheap-key");
  const GODADDY_TOKEN = fakeSecret("aws-secret-access-key", "godaddy-token");
  const SECRETS = [PORKBUN_KEY, PORKBUN_SECRET, NAMECHEAP_KEY, GODADDY_TOKEN];
  const all = {
    HCLOUD_TOKEN: HCLOUD,
    GITHUB_TOKEN: GITHUB,
    PORKBUN_API_KEY: PORKBUN_KEY,
    PORKBUN_SECRET_API_KEY: PORKBUN_SECRET,
    NAMECHEAP_API_USER: "shopowner",
    NAMECHEAP_API_KEY: NAMECHEAP_KEY,
    GODADDY_API_TOKEN: GODADDY_TOKEN,
  };
  const REGISTRAR_CHECKS: InitCheckId[] = ["porkbun", "namecheap", "godaddy"];

  function expectNoSecrets(value: unknown): void {
    const text = JSON.stringify(value);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    // No colon right after an environment variable name.
    expect(text).not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+:/);
  }

  async function run(
    env: Record<string, string | undefined>,
    registrarCheck: InitServices["registrarCheck"],
    offline = false,
  ) {
    const { deps } = await setup({ env });
    const asked: string[] = [];
    const extra: InitServices = registrarCheck
      ? {
          registrarCheck: (id) => {
            asked.push(id);
            return registrarCheck(id);
          },
        }
      : {};
    const checks = await runInitChecks(deps, {
      ...(offline ? { offline: true } : {}),
      services: services({}, extra),
    });
    const byId = (id: InitCheckId) => checks.find((c) => c.id === id);
    return { checks, byId, asked };
  }

  it("adds no registrar line when no other registrar is configured", async () => {
    const { checks, asked } = await run({ HCLOUD_TOKEN: HCLOUD }, async () => ({
      ok: true,
      message: "unused",
    }));
    expect(checks.some((c) => REGISTRAR_CHECKS.includes(c.id))).toBe(false);
    expect(asked).toEqual([]);
  });

  it("checks every configured registrar and shows the message and balance", async () => {
    const results: Record<string, RegistrarAccountCheck> = {
      porkbun: { ok: true, message: "The Porkbun API keys work and can buy domains." },
      namecheap: {
        ok: true,
        message: "Namecheap API access works from 203.0.113.7.",
        balance: { amount: 12.3, currency: "USD" },
      },
      godaddy: { ok: true, message: "GoDaddy API access works." },
    };
    const { checks, byId, asked } = await run(all, async (id) => {
      const result = results[id];
      if (!result) throw new Error(`unexpected ${id}`);
      return result;
    });
    expect([...asked].sort()).toEqual(["godaddy", "namecheap", "porkbun"]);
    const ids = checks.map((c) => c.id);
    const after = ids.indexOf("registrar") + 1;
    expect(ids.slice(after, after + 3)).toEqual(REGISTRAR_CHECKS);
    for (const id of REGISTRAR_CHECKS) expect(byId(id)?.status).toBe("pass");
    expect(byId("porkbun")?.title).toContain("Porkbun");
    expect(byId("porkbun")?.message).toContain("can buy domains");
    expect(byId("namecheap")?.message).toContain("balance 12.30 USD");
    expect(initPassed(checks)).toBe(true);
    expectNoSecrets(checks);
  });

  it("warns with the IPv4 to whitelist when Namecheap refuses this address", async () => {
    const { checks, byId } = await run(
      { ...all, PORKBUN_API_KEY: undefined, PORKBUN_SECRET_API_KEY: undefined },
      async (id) =>
        id === "namecheap"
          ? {
              ok: false,
              message: "Namecheap refused the API call from 198.51.100.4 (not whitelisted).",
              fix: "Add 198.51.100.4 to the whitelisted IPs at https://ap.www.namecheap.com/settings/tools/apiaccess/.",
            }
          : { ok: true, message: "GoDaddy API access works." },
    );
    const nc = byId("namecheap");
    expect(nc?.status).toBe("warn");
    expect(nc?.message).toContain("not whitelisted");
    expect(nc?.fix).toContain("198.51.100.4");
    expect(initPassed(checks)).toBe(true);
    expectNoSecrets(checks);
  });

  it("names Porkbun's missing permissions in the fix", async () => {
    const { byId } = await run(all, async (id) =>
      id === "porkbun"
        ? {
            ok: false,
            message: "The Porkbun API keys cannot buy domains.",
            fix: "Turn on API access for your domains and allow domain registration at https://porkbun.com/account/api.",
          }
        : { ok: true, message: "Works." },
    );
    expect(byId("porkbun")?.status).toBe("warn");
    expect(byId("porkbun")?.fix).toContain("allow domain registration");
  });

  it("warns with the fix when the account works with a caveat (a Porkbun key without purchase)", async () => {
    const { checks, byId } = await run(all, async (id) =>
      id === "porkbun"
        ? {
            ok: true,
            message:
              "The Porkbun API keys work. They do not allow buying domains (the purchase permission).",
            fix: "Give the key the purchase permission at https://porkbun.com/account/api (the gear icon next to the key), or create a key that has it.",
            balance: { amount: 5, currency: "USD" },
          }
        : { ok: true, message: "Works." },
    );
    const pb = byId("porkbun");
    expect(pb?.status).toBe("warn");
    expect(pb?.message).toContain("the purchase permission");
    expect(pb?.message).toContain("(balance 5.00 USD)");
    expect(pb?.fix).toContain("Give the key the purchase permission");
    expect(initPassed(checks)).toBe(true);
  });

  it("does not repeat a balance the message already states", async () => {
    const { byId } = await run(all, async (id) =>
      id === "namecheap"
        ? {
            ok: true,
            message:
              "Namecheap API access works from 203.0.113.7; the account balance is 12.30 USD (API purchases are paid from it).",
            balance: { amount: 12.3, currency: "USD" },
          }
        : { ok: true, message: "Works." },
    );
    const nc = byId("namecheap");
    expect(nc?.status).toBe("pass");
    expect(nc?.message).toBe(
      "Namecheap API access works from 203.0.113.7; the account balance is 12.30 USD (API purchases are paid from it).",
    );
  });

  it("turns an exception into a warning with the plain message and hint; init still passes", async () => {
    const { checks, byId } = await run(all, async (id) => {
      if (id === "godaddy") {
        throw new OpsCrewError(
          "CREDENTIALS_INVALID",
          `GoDaddy rejected the token ${GODADDY_TOKEN}.`,
          { hint: "Create a new production key." },
        );
      }
      if (id === "porkbun") throw new Error("socket hang up");
      return { ok: true, message: "Namecheap API access works." };
    });
    const gd = byId("godaddy");
    expect(gd?.status).toBe("warn");
    expect(gd?.message).toContain("GoDaddy rejected the token");
    expect(gd?.message).toContain("Create a new production key.");
    expect(gd?.fix).toContain("https://");
    expect(byId("porkbun")?.status).toBe("warn");
    expect(byId("porkbun")?.message).toContain("socket hang up");
    expect(byId("namecheap")?.status).toBe("pass");
    expect(initPassed(checks)).toBe(true);
    expectNoSecrets(checks);
  });

  it("uses the real registrar adapters by default and never fails init on their errors", async () => {
    const { checks, byId } = await run({ ...all, NAMECHEAP_CLIENT_IP: "203.0.113.7" }, undefined);
    for (const id of REGISTRAR_CHECKS) expect(["pass", "warn"]).toContain(byId(id)?.status);
    expect(initPassed(checks)).toBe(true);
    expectNoSecrets(checks);
  });

  it("offline: says the credentials are set and makes no call", async () => {
    const { byId, asked } = await run(
      all,
      async () => {
        throw new Error("must not be called offline");
      },
      true,
    );
    expect(asked).toEqual([]);
    expect(byId("porkbun")?.message).toContain("Porkbun API keys are set");
    for (const id of REGISTRAR_CHECKS) {
      expect(byId(id)?.status).toBe("pass");
      expect(byId(id)?.message).toContain("not checked offline");
    }
  });

  it("names the missing variable when a registrar is only partly set up", async () => {
    const { byId, asked, checks } = await run(
      {
        HCLOUD_TOKEN: HCLOUD,
        GITHUB_TOKEN: GITHUB,
        PORKBUN_API_KEY: PORKBUN_KEY,
        NAMECHEAP_API_USER: "shopowner",
      },
      async () => ({ ok: true, message: "unused" }),
    );
    expect(asked).toEqual([]);
    const pb = byId("porkbun");
    expect(pb?.status).toBe("warn");
    expect(pb?.message).toContain("PORKBUN_SECRET_API_KEY is not set");
    expect(pb?.fix).toContain("https://");
    expect(byId("namecheap")?.message).toContain("NAMECHEAP_API_KEY is not set");
    expect(byId("godaddy")).toBeUndefined();
    expect(initPassed(checks)).toBe(true);
    expectNoSecrets(checks);
  });
});
