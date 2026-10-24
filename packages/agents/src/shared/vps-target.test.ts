import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudTarget, edgeProxy } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDns } from "../dns/run";
import { buyDomain, connectDomain } from "../domain";
import { recordDomain } from "../domain/project";
import { runInitChecks } from "../init";
import { answersToRequirements } from "../interview/answers";
import { defaultProvider } from "../interview/questions";
import { portainerDisable, portainerEnable } from "../portainer/run";
import { planProvider, requestedProvider } from "../providers";
import { previewDeploymentFiles, runProvision } from "../provision";
import { runRetarget } from "../retarget/run";
import { tlsStatusReport } from "../status";
import { readServerContainers } from "../status/run";
import {
  createTestPhaseDeps,
  FakeCloudflare,
  makeRequirements,
  ScriptedRunner,
  TOKEN,
  testPlan,
} from "../testing";
import { moveProvider, ownServerNoMove } from "./vps-target";

const BUG = {
  code: "PHASE_PRECONDITION",
  hint: "This is a bug in OpsCrew: please report it with the command you ran.",
};
const NO_MOVE = {
  code: "PHASE_PRECONDITION",
  message:
    "Moving an app to or from a Portainer target is not supported; destroy it and provision again.",
};

function portainerPlan(): DeployPlan {
  return DeployPlanSchema.parse({
    ...testPlan(),
    target: {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 3,
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "proxy", port: 8080 },
    },
  });
}

function refusal(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("a Portainer target in steps that only know single servers", () => {
  it("is a bug in OpsCrew where a server's provider is needed", () => {
    const plan = portainerPlan();
    for (const attempt of [
      () => planProvider(plan),
      () => requestedProvider({ provider: "portainer" }),
      () => cloudTarget(plan.target),
    ]) {
      expect(refusal(attempt)).toMatchObject(BUG);
    }
    expect(refusal(() => moveProvider(plan.target))).toMatchObject(NO_MOVE);
    // The interview handles a Portainer target (T1004): its previous answer is the default.
    expect(defaultProvider({ provider: "portainer" })).toBe("portainer");
  });

  it("leaves Hetzner, DigitalOcean and own servers as they were", () => {
    expect(planProvider(testPlan())).toBe("hetzner");
    expect(planProvider(testPlan({ provider: "digitalocean" }))).toBe("digitalocean");
    expect(requestedProvider({ provider: "hetzner" })).toBe("hetzner");
    expect(requestedProvider({ provider: "own" })).toBe("own");
    expect(defaultProvider(undefined)).toBe("hetzner");
    expect(moveProvider(testPlan().target)).toBe("hetzner");
  });

  it("never moves: opscrew retarget refuses a Portainer target before anything else", async () => {
    const deps = await createTestPhaseDeps();
    await writeArtifact("plan", deps.paths.files.plan, portainerPlan());
    await expect(runRetarget(deps, { to: "hetzner" })).rejects.toMatchObject(NO_MOVE);
  });

  it("says plainly that a server the user owns never moves", () => {
    expect(ownServerNoMove()).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("to or from a server you already own is not supported"),
    });
  });
});

// Feature 015: the localhost target is in the schema (T1501a) before its flows (T1510).
describe("the localhost target in steps that do not support it yet", () => {
  function localhostPlan(): DeployPlan {
    return DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      target: {
        provider: "localhost",
        mode: "local-compose",
        arch: "amd64",
        ports: { https: 443, http: 80 },
        image: "registry",
      },
    });
  }
  const notYet = (what: string) => ({
    code: "PHASE_PRECONDITION",
    message: `${what} is not supported for the localhost target yet.`,
    hint: "Choose a server or your Portainer as the target: run `opscrew interview`, then `opscrew design`.",
  });
  const NO_LOCAL_MOVE = {
    code: "PHASE_PRECONDITION",
    message:
      "Moving an app to or from the localhost target is not supported; OpsCrew moves apps only between cloud providers.",
  };
  async function localhostProject(runner = new ScriptedRunner()) {
    const root = await mkdtemp(join(tmpdir(), "opscrew-test-"));
    const env = { OPSCREW_HOME: join(root, ".home-opscrew"), CLOUDFLARE_API_TOKEN: TOKEN };
    const deps = await createTestPhaseDeps({ root, env, runner });
    await writeArtifact("plan", deps.paths.files.plan, localhostPlan());
    return deps;
  }

  it("is a bug in OpsCrew where a server's provider is needed", () => {
    const plan = localhostPlan();
    for (const attempt of [
      () => planProvider(plan),
      () => requestedProvider({ provider: "localhost" }),
      () => cloudTarget(plan.target),
    ]) {
      expect(refusal(attempt)).toMatchObject({
        ...BUG,
        message: expect.stringContaining("not to an app on this computer (the localhost target)"),
      });
    }
  });

  it("never moves: opscrew retarget refuses it before anything else", async () => {
    expect(refusal(() => moveProvider(localhostPlan().target))).toMatchObject(NO_LOCAL_MOVE);
    const deps = await localhostProject();
    await expect(runRetarget(deps, { to: "hetzner" })).rejects.toMatchObject(NO_LOCAL_MOVE);
  });

  it("is refused plainly by the commands it has no use for, or that do not support it yet", async () => {
    const runner = new ScriptedRunner();
    const deps = await localhostProject(runner);
    const cf = new FakeCloudflare();
    const services = cf.services();
    // Provision, verify, drift, status, secure and destroy run on this computer (T1510).
    const commands: [string, () => Promise<unknown>][] = [
      ["`opscrew dns`", () => runDns(deps, { domain: "shop.example.com" })],
      ["`opscrew portainer enable`", () => portainerEnable(deps)],
      ["`opscrew portainer disable`", () => portainerDisable(deps)],
      ["Reading the app's containers", () => readServerContainers(deps, localhostPlan())],
      ["`opscrew domain buy`", () => buyDomain(deps, { domain: "shopapp.com", services })],
      [
        "`opscrew domain connect`",
        () => connectDomain(deps, { domain: "shopapp.com", registrar: "porkbun", services }),
      ],
    ];
    for (const [what, run] of commands) {
      await expect(run(), what).rejects.toMatchObject(notYet(what));
    }
    // Nothing ran a command (no engine, no SSH, no git) or reached a registrar or Cloudflare.
    expect(runner.calls).toEqual([]);
    expect(cf.events).toEqual([]);
  });

  it("needs no provider token in opscrew init", async () => {
    const deps = await localhostProject();
    const checks = await runInitChecks(deps, {
      offline: true,
      services: {
        which: (name) => (name === "docker" ? "/usr/bin/docker" : undefined),
        nodeVersion: "22.12.0",
      },
    });
    expect(checks.find((check) => check.id === "provider")).toMatchObject({
      title: "This computer",
      status: "pass",
      message:
        "Docker found at /usr/bin/docker. The app runs on this computer (the localhost target), with no token.",
    });
  });
});

// Feature 016: the server-less targets are in the schema (T1601a) before their flows (T1607-T1610).
describe.each([
  ["Cloudflare hosting", "an app on Cloudflare's hosting"],
  ["GitHub Pages", "a site on GitHub Pages"],
] as const)("%s in steps that do not support it yet", (name, words) => {
  const github = name === "GitHub Pages";
  const site = { tool: "none", outputDir: "site" } as const;
  function serverlessPlan(): DeployPlan {
    return DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      app: { ...testPlan().app, name: "example-app", env: [] },
      target: github
        ? { provider: "github-pages", mode: "pages-workflow", site }
        : {
            provider: "cloudflare-workers",
            mode: "workers-assets",
            worker: "example-app",
            render: "static",
            notFound: "404-page",
            site,
          },
      services: [],
      dns: { provider: "cloudflare", domain: "docs.example.com", proxied: !github },
      security: { wafCustomRules: !github },
    });
  }
  const notYet = (what: string) => ({
    code: "PHASE_PRECONDITION",
    message: `${what} is not available for ${name} yet.`,
    hint: "Choose a server, your Portainer or this computer as the target: run `opscrew interview`, then `opscrew design`.",
  });
  const NO_MOVE = {
    code: "PHASE_PRECONDITION",
    message: `Moving an app to or from ${name} is not available yet: moving to and from server-less targets comes with retarget anywhere.`,
  };
  async function serverlessProject(runner = new ScriptedRunner()) {
    const root = await mkdtemp(join(tmpdir(), "opscrew-test-"));
    const env = { OPSCREW_HOME: join(root, ".home-opscrew"), CLOUDFLARE_API_TOKEN: TOKEN };
    const deps = await createTestPhaseDeps({ root, env, runner });
    await writeArtifact("plan", deps.paths.files.plan, serverlessPlan());
    return deps;
  }

  // `renderDeployment` renders these targets since T1605 and T1606 (iac-templates tests them).
  it("is a bug in OpsCrew where a server's provider or proxy is needed", () => {
    const plan = serverlessPlan();
    const provider = plan.target.provider;
    for (const attempt of [
      () => planProvider(plan),
      () => requestedProvider({ provider }),
      () => cloudTarget(plan.target),
      () => edgeProxy(plan),
    ]) {
      expect(refusal(attempt)).toMatchObject({
        ...BUG,
        message: expect.stringContaining(`not to ${words}`),
      });
    }
  });

  it("never moves: opscrew retarget refuses it before anything else", async () => {
    expect(refusal(() => moveProvider(serverlessPlan().target))).toMatchObject(NO_MOVE);
    const deps = await serverlessProject();
    await expect(runRetarget(deps, { to: "hetzner" })).rejects.toMatchObject(NO_MOVE);
  });

  it("is refused plainly by every command that does not support it yet", async () => {
    const runner = new ScriptedRunner();
    const deps = await serverlessProject(runner);
    const provider = serverlessPlan().target.provider;
    const what = "Reading the app's containers";
    await expect(readServerContainers(deps, serverlessPlan())).rejects.toMatchObject(notYet(what));
    // A site has no server files to preview: it is told what to read instead.
    const files = github
      ? ".github/workflows/opscrew-deploy.yml"
      : ".github/workflows/opscrew-deploy.yml and opscrew/cloudflare/wrangler.jsonc";
    await expect(previewDeploymentFiles(deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `OpsCrew previews the deployment files of an app on a server; a site on ${name} has none to preview.`,
      hint: `To see how the site deploys, read ${files} in the repository.`,
    });
    // Nothing ran a command (no engine, no SSH, no git), and the plan is as it was.
    expect(runner.calls).toEqual([]);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(serverlessPlan());
    expect(provider).toBe(github ? "github-pages" : "cloudflare-workers");
  });

  it("has its DNS records managed by opscrew provision, so opscrew dns refuses", async () => {
    const runner = new ScriptedRunner();
    const deps = await serverlessProject(runner);
    await expect(runDns(deps, { domain: "docs.example.com" })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `\`opscrew dns\` does not change the DNS records of a site on ${name}: \`opscrew provision\` manages them with the site.`,
      hint: "To move the site to another domain, change dns.domain in opscrew/plan.yaml (or answer `opscrew interview` again, then run `opscrew design`), then run `opscrew provision`.",
    });
    expect(runner.calls).toEqual([]);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(serverlessPlan());
  });

  it("has no server to run Portainer on, so portainer enable and disable refuse", async () => {
    const runner = new ScriptedRunner();
    const deps = await serverlessProject(runner);
    for (const [what, run] of [
      ["`opscrew portainer enable`", () => portainerEnable(deps)],
      ["`opscrew portainer disable`", () => portainerDisable(deps)],
    ] as const) {
      await expect(run(), what).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: `${what} does not apply to a site on ${name}: there is no server to run Portainer on.`,
        hint: "Nothing changes for the site. To run the app under Portainer, deploy it to a server instead: run `opscrew interview`, then `opscrew design`.",
      });
    }
    expect(runner.calls).toEqual([]);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(serverlessPlan());
  });

  // Both targets have their provision since T1608 and T1609 (`serverless/*/provision.test.ts`).
  // GitHub Pages' starts with its GitHub checks, so without a GitHub remote it stops there.
  it.runIf(github)(
    "reaches its own provision after the repository checks, with no Dockerfile, and stops at the GitHub remote",
    async () => {
      const runner = new ScriptedRunner((_command, args) => ({
        exitCode: 0,
        stdout: args.includes("--is-inside-work-tree") ? "true\n" : "",
        stderr: "",
      }));
      const deps = await serverlessProject(runner);
      await expect(runProvision(deps)).rejects.toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("no GitHub remote"),
      });
      // Only git ran: no engine, no SSH, no Dockerfile check.
      expect(runner.calls.every((call) => call.command === "git")).toBe(true);
      expect(runner.calls.some((call) => call.args.includes("ls-files"))).toBe(false);
      expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(serverlessPlan());
    },
  );

  it("is an interview answer with no region", async () => {
    const provider = serverlessPlan().target.provider;
    const now = new Date("2026-10-23T10:00:00.000Z");
    const answered = answersToRequirements(
      { ...makeRequirements({ provider }), domain: "docs.example.com", dnsProvider: "cloudflare" },
      { now },
    );
    expect(answered).toMatchObject({ provider, domain: "docs.example.com" });
    expect(answered.region).toBeUndefined();
    // A previous answer for it is the default only while the question offers it.
    expect(defaultProvider({ provider })).toBe("hetzner");
    const offered = github ? "github-pages" : "cloudflare-workers";
    expect(defaultProvider({ provider }, { serverless: [offered] })).toBe(provider);
  });

  it("shows no proxy of OpsCrew's in opscrew status", async () => {
    const deps = await serverlessProject();
    const { lines } = await tlsStatusReport(deps, serverlessPlan());
    expect(lines[0]).toBe(`Proxy: none (${github ? "GitHub" : "Cloudflare"} serves the site)`);
  });

  it("checks its own tokens in opscrew init, never a server provider's", async () => {
    const deps = await serverlessProject();
    const checks = await runInitChecks(deps, {
      offline: true,
      services: { which: () => undefined, nodeVersion: "22.12.0" },
    });
    expect(checks.find((check) => check.id === "provider")).toMatchObject({
      title: name,
      status: "fail",
      message: github
        ? expect.stringContaining("No GitHub token is set")
        : "OPSCREW_CLOUDFLARE_DEPLOY_TOKEN is not set: the deploy workflow needs a token of its own that holds only Account → Workers Scripts → Edit.",
    });
  });

  it("keeps a GitHub Pages site DNS-only when a domain is recorded, and a Worker's proxied", async () => {
    const deps = await serverlessProject();
    const plan = serverlessPlan();
    const info = { domain: "example.org", registrar: "cloudflare", autoRenew: true } as const;
    await recordDomain(
      deps,
      { plan },
      { domain: "example.org", hostname: "example.org", info, dnssec: false },
    );
    const recorded = await readArtifact("plan", deps.paths.files.plan);
    expect(recorded.dns).toMatchObject({
      provider: "cloudflare",
      domain: "example.org",
      zone: "example.org",
      proxied: !github,
    });
  });
});
