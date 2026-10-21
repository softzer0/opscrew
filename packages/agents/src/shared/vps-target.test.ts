import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloudTarget } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { previewDesignOptions, runDesign } from "../design/run";
import { runDestroy } from "../destroy/run";
import { runDns } from "../dns/run";
import { buyDomain, connectDomain } from "../domain";
import { runDrift } from "../drift/run";
import { runInitChecks } from "../init";
import { defaultProvider } from "../interview/questions";
import { runInterview } from "../interview/run";
import { portainerDisable, portainerEnable } from "../portainer/run";
import { planProvider, requestedProvider } from "../providers";
import { runProvision } from "../provision/run";
import { runRetarget } from "../retarget/run";
import { runSecure } from "../secure/run";
import { readServerContainers } from "../status/run";
import {
  createTestPhaseDeps,
  FakeCloudflare,
  ScriptedRunner,
  TOKEN,
  testPlan,
  testRequirements,
  writeArchitecture,
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

  it("is refused plainly by every command that acts on a deployment", async () => {
    const runner = new ScriptedRunner();
    const deps = await localhostProject(runner);
    const cf = new FakeCloudflare();
    const services = cf.services();
    const commands: [string, () => Promise<unknown>][] = [
      ["`opscrew provision`", () => runProvision(deps)],
      ["`opscrew dns`", () => runDns(deps, { domain: "shop.example.com" })],
      ["`opscrew destroy`", () => runDestroy(deps)],
      ["`opscrew drift`", () => runDrift(deps)],
      ["`opscrew verify`", () => runVerify(deps)],
      ["`opscrew secure`", () => runSecure(deps, { offline: true })],
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

  it("is not offered by design or the interview yet", async () => {
    const deps = await createTestPhaseDeps();
    await writeArchitecture(deps.paths.files.architecture, "shop");
    const { region: _region, ...requirements } = testRequirements();
    await writeArtifact("requirements", deps.paths.files.requirements, {
      ...requirements,
      provider: "localhost",
    });
    await expect(runDesign(deps)).rejects.toMatchObject(notYet("`opscrew design`"));
    await expect(previewDesignOptions(deps)).rejects.toMatchObject(notYet("`opscrew design`"));
    await expect(
      runInterview(deps, { answers: { ...requirements, provider: "localhost" } }),
    ).rejects.toMatchObject(notYet("`opscrew interview`"));
    // A previous localhost answer is no default for a question that does not offer it.
    expect(defaultProvider({ provider: "localhost" })).toBe("hetzner");
  });

  it("needs no provider token in opscrew init", async () => {
    const deps = await localhostProject();
    const checks = await runInitChecks(deps, {
      offline: true,
      services: { which: () => undefined, nodeVersion: "22.12.0" },
    });
    expect(checks.find((check) => check.id === "provider")).toMatchObject({
      title: "This computer",
      status: "skip",
      message: "Not needed: the app runs on this computer (the localhost target), with no token.",
    });
  });
});
