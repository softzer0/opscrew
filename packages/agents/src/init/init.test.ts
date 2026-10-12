import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntime, CommandResult, FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type Requirements, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createTestPhaseDeps,
  ScriptedApprovalHandler,
  ScriptedRunner,
  type TestPhaseDeps,
} from "../testing";
import { testPlan } from "../verify/__fixtures__/plan";
import {
  ensureGitignore,
  gitignoreCoversOpsCrew,
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
const TOKENS = [HCLOUD, CLOUDFLARE, GITHUB, ANTHROPIC];

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
  cloudflare?: "active" | 401;
  /** Zone `example.com` is visible to the Cloudflare token. */
  zone?: boolean;
  github?: "push" | "read" | 404;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeNet(o: NetOptions = {}): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "api.hetzner.cloud") {
      const mode = o.hetzner ?? 200;
      if (mode === "hang") return new Promise<Response>(() => {});
      return mode === 200
        ? json(200, { locations: [{ id: 1, name: "fsn1", country: "DE" }] })
        : json(401, { error: { code: "unauthorized", message: "unable to authenticate" } });
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
      if (url.pathname.endsWith("/zones")) {
        const name = url.searchParams.get("name");
        const zones =
          (o.zone ?? true) && name === "example.com"
            ? [{ id: "zone-1", name: "example.com", status: "active", name_servers: [] }]
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
  await writeFile(join(deps.paths.root, ".gitignore"), o.gitignore ?? "node_modules/\n.opscrew/\n");
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
    region: "eu-central",
    uptime: "standard",
    dataCriticality: "important",
    dnsProvider: "none",
    keepExternalServices: [],
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
      "hetzner",
      "cloudflare",
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
    const missing = await check("hetzner", { env: { GITHUB_TOKEN: GITHUB } });
    expect(missing.status).toBe("fail");
    expect(missing.fix).toContain("HCLOUD_TOKEN");
    expect(missing.fix).toContain("https://console.hetzner.cloud/");
    const rejected = await check("hetzner", { net: { hetzner: 401 } });
    expect(rejected.status).toBe("fail");
    expect(rejected.fix).toContain("Read & Write");
    expectNoTokens(rejected);
  });

  it("fails a network check that runs over its time budget", async () => {
    const started = Date.now();
    const slow = await check(
      "hetzner",
      { net: { hetzner: "hang" } },
      { services: services({}, { timeoutMs: 30 }) },
    );
    expect(slow.status).toBe("fail");
    expect(slow.message).toContain("did not answer");
    expect(slow.fix).toContain("--offline");
    expect(Date.now() - started).toBeLessThan(5_000);
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

  describe("GitHub", () => {
    it("fails without a token", async () => {
      const gh = await check("github", { env: { HCLOUD_TOKEN: HCLOUD } });
      expect(gh.status).toBe("fail");
      expect(gh.fix).toContain("GITHUB_TOKEN");
      expect(gh.fix).toContain("gh auth login");
      expect(gh.fix).toContain("Contents: Read and write");
      expect(gh.fix).toContain("https://github.com/settings/personal-access-tokens/new");
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
  });

  it("offline: never touches the network and says tokens were only checked for presence", async () => {
    const { deps } = await setup();
    // createTestPhaseDeps' default fetch throws; replace the fake with it to prove no call happens.
    deps.fetch = async (input) => {
      throw new Error(`network call in offline mode: ${String(input)}`);
    };
    await writeRequirements(deps, { dnsProvider: "cloudflare", domain: "shop.example.com" });
    const checks = await runInitChecks(deps, { offline: true, services: services() });
    for (const id of ["hetzner", "cloudflare", "github"] as const) {
      const c = checks.find((x) => x.id === id);
      expect(c?.status).toBe("pass");
      expect(c?.message).toContain("only checked that it is set");
    }
    expect(initPassed(checks)).toBe(true);
    expectNoTokens(checks);

    const { deps: empty } = await setup({ env: {} });
    const missing = await runInitChecks(empty, { offline: true, services: services() });
    expect(missing.find((c) => c.id === "hetzner")?.status).toBe("fail");
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

describe("gitignoreCoversOpsCrew", () => {
  it("recognises the usual spellings and honours negation", () => {
    for (const line of [".opscrew", ".opscrew/", "/.opscrew/", ".opscrew/*", "/.opscrew/**"]) {
      expect(gitignoreCoversOpsCrew(`dist\n${line}\n`)).toBe(true);
    }
    const bom = String.fromCharCode(0xfeff);
    expect(gitignoreCoversOpsCrew(`${bom}.opscrew/\r\n`)).toBe(true);
    expect(gitignoreCoversOpsCrew("# .opscrew/\nopscrew/\n")).toBe(false);
    expect(gitignoreCoversOpsCrew(".opscrew/\n!.opscrew/\n")).toBe(false);
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
    expect(await ensureGitignore(d)).toBe(false);
    expect(await readFile(file, "utf8")).toBe("node_modules/\n");
    expect(handler.requests[0]?.kind).toBe("repo-write");
    expect(d.reporter.text()).toContain("opscrew init --fix");
  });

  it("appends after approval, keeping CRLF line endings, and is idempotent", async () => {
    const { d, handler, file } = await deps([true]);
    await writeFile(file, "node_modules/\r\ndist/");
    expect(await ensureGitignore(d)).toBe(true);
    expect(await readFile(file, "utf8")).toBe("node_modules/\r\ndist/\r\n.opscrew/\r\n");
    expect(await ensureGitignore(d)).toBe(false);
    expect(handler.requests).toHaveLength(1);
  });

  it("creates .gitignore when missing", async () => {
    const { d, file } = await deps([true]);
    expect(await ensureGitignore(d)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(".opscrew/\n");
  });

  it("does nothing and asks nothing when already present", async () => {
    const { d, handler, file } = await deps([true]);
    await writeFile(file, "/.opscrew/\n");
    expect(await ensureGitignore(d)).toBe(false);
    expect(handler.requests).toHaveLength(0);
  });

  it("changes the file without asking with fix", async () => {
    const { d, handler, file } = await deps([false]);
    await writeFile(file, "node_modules/\n");
    expect(await ensureGitignore(d, { fix: true })).toBe(true);
    expect(await readFile(file, "utf8")).toBe("node_modules/\n.opscrew/\n");
    expect(handler.requests).toHaveLength(0);
  });
});
