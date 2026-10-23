import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudTarget, edgeProxy, renderDeployment } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design/run";
import { runDestroy } from "../destroy/run";
import { runDns } from "../dns/run";
import { buyDomain, connectDomain } from "../domain";
import { recordDomain } from "../domain/project";
import { runDrift } from "../drift/run";
import { addEnvironment } from "../environments/add";
import { runInitChecks } from "../init";
import { answersToRequirements } from "../interview/answers";
import { defaultProvider } from "../interview/questions";
import { portainerDisable, portainerEnable } from "../portainer/run";
import { planProvider, requestedProvider } from "../providers";
import { previewDeploymentFiles, runProvision } from "../provision";
import { runRetarget } from "../retarget/run";
import { runSecure } from "../secure/run";
import { tlsStatusReport } from "../status";
import { readServerContainers } from "../status/run";
import {
  createTestPhaseDeps,
  FakeCloudflare,
  makeRequirements,
  nextPostgresFacts,
  ScriptedRunner,
  TOKEN,
  testPlan,
} from "../testing";
import { runVerify } from "../verify/run";
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
  const site = { tool: "none", outputDir: "." } as const;
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

  it("is a bug in OpsCrew where a server's provider, files or proxy are needed", () => {
    const plan = serverlessPlan();
    const provider = plan.target.provider;
    for (const attempt of [
      () => planProvider(plan),
      () => requestedProvider({ provider }),
      () => cloudTarget(plan.target),
      () => edgeProxy(plan),
      () =>
        renderDeployment(plan, {
          opscrewVersion: "0.0.0-test",
          github: { owner: "example", repo: "example-app" },
          deploySshPublicKey: "",
        }),
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
    const commands: [string, () => Promise<unknown>][] = [
      ["`opscrew provision`", () => runProvision(deps)],
      ["`opscrew dns`", () => runDns(deps, { domain: "docs.example.com" })],
      ["Previewing the deployment files", () => previewDeploymentFiles(deps)],
      ["`opscrew verify`", () => runVerify(deps)],
      ["`opscrew drift`", () => runDrift(deps)],
      ["`opscrew secure`", () => runSecure(deps, { scanners: [], offline: true })],
      ["`opscrew destroy`", () => runDestroy(deps)],
      ["`opscrew portainer enable`", () => portainerEnable(deps)],
      ["`opscrew portainer disable`", () => portainerDisable(deps)],
      ["Reading the app's containers", () => readServerContainers(deps, serverlessPlan())],
    ];
    for (const [what, run] of commands) {
      await expect(run(), what).rejects.toMatchObject(notYet(what));
    }
    // Nothing ran a command (no engine, no SSH, no git), and the plan is as it was.
    expect(runner.calls).toEqual([]);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(serverlessPlan());
    expect(provider).toBe(github ? "github-pages" : "cloudflare-workers");
  });

  it("is not offered by the interview, design or a new environment yet", async () => {
    const provider = serverlessPlan().target.provider;
    const now = new Date("2026-10-23T10:00:00.000Z");
    expect(refusal(() => answersToRequirements({ provider }, { now }))).toMatchObject(
      notYet("`opscrew interview`"),
    );
    // A previous answer for it is no default: the question does not offer it.
    expect(defaultProvider({ provider })).toBe("hetzner");

    const deps = await createTestPhaseDeps();
    await writeArtifact("architecture", deps.paths.files.architecture, {
      schemaVersion: 1,
      generatedAt: "2026-10-23T10:00:00.000Z",
      generator: { tool: "opscrew", version: "0.0.0-test" },
      facts: nextPostgresFacts({ name: "example-app" }),
      summary: "A site.",
      risks: [],
      aiEnriched: false,
    });
    const { region: _region, ...requirements } = makeRequirements({ provider });
    await writeArtifact("requirements", deps.paths.files.requirements, requirements);
    await expect(runDesign(deps)).rejects.toMatchObject(notYet("`opscrew design`"));

    await writeArtifact("plan", deps.paths.files.plan, testPlan());
    const staging = await createTestPhaseDeps({ root: deps.paths.root, environment: "staging" });
    await expect(addEnvironment(staging, { answers: { provider } })).rejects.toMatchObject(
      notYet("`opscrew env add`"),
    );
  });

  it("shows no proxy of OpsCrew's in opscrew status", async () => {
    const deps = await serverlessProject();
    const { lines } = await tlsStatusReport(deps, serverlessPlan());
    expect(lines[0]).toBe(`Proxy: none (${github ? "GitHub" : "Cloudflare"} serves the site)`);
  });

  it("needs no server provider token in opscrew init", async () => {
    const deps = await serverlessProject();
    const checks = await runInitChecks(deps, {
      offline: true,
      services: { which: () => undefined, nodeVersion: "22.12.0" },
    });
    expect(checks.find((check) => check.id === "provider")).toMatchObject({
      title: name,
      status: "skip",
      message: `Not needed: the app has no server on ${name}, so it needs no server provider token.`,
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
