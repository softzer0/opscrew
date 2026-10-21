import type { DeployPlan, DesignOption } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  deploySentence,
  deployStrategyFor,
  keptDeploy,
  PORTAINER_RECREATE_NOTE,
  ROLLING_NOTE,
} from "./strategy";

function target(provider: DesignOption["target"]["provider"], memoryGb: number) {
  return {
    target: {
      provider,
      location: "nbg1",
      serverType: "cx",
      vcpus: 1,
      memoryGb,
      diskGb: 20,
      cpuType: "shared",
      architecture: "x86",
    },
  } satisfies Pick<DesignOption, "target">;
}

describe("deployStrategyFor", () => {
  it("rolls on a server with 1 GiB or more", () => {
    expect(deployStrategyFor(target("hetzner", 4))).toEqual({ strategy: "rolling" });
    expect(deployStrategyFor(target("digitalocean", 1))).toEqual({ strategy: "rolling" });
    expect(deployStrategyFor(target("own", 2))).toEqual({ strategy: "rolling" });
  });

  it("recreates below 1 GiB, saying why", () => {
    expect(deployStrategyFor(target("digitalocean", 0.5))).toEqual({
      strategy: "recreate",
      reason:
        "Each deploy stops the old version before the new one starts, because the server has 512 MB of memory, too little for two copies of the app. Requests wait meanwhile, so visitors see a short pause, not an error.",
    });
    // A server the user owns: the memory inspection read (a 1 GB machine reads as 0.9 GiB).
    expect(deployStrategyFor(target("own", 0.9)).strategy).toBe("recreate");
  });

  it("says so when the own server's memory could not be read", () => {
    expect(deployStrategyFor(target("own", 0.01)).reason).toBe(
      "Each deploy stops the old version before the new one starts, because OpsCrew could not read how much memory the server has. Requests wait meanwhile, so visitors see a short pause, not an error.",
    );
  });

  it("recreates an app on SQLite, saying that requests wait meanwhile", () => {
    expect(deployStrategyFor(target("hetzner", 4), true)).toEqual({
      strategy: "recreate",
      reason:
        "Each deploy stops the old version before the new one starts, because the app keeps its data in SQLite, which two copies must never write at once. Requests wait meanwhile, so visitors see a short pause, not an error.",
    });
  });

  it("always recreates in Portainer", () => {
    expect(deployStrategyFor(target("portainer", 0.01))).toEqual({
      strategy: "recreate",
      reason: PORTAINER_RECREATE_NOTE,
    });
  });
});

type PlanDeploy = Pick<DeployPlan, "target" | "deploy">;

const HETZNER = {
  provider: "hetzner",
  mode: "vps-compose",
  location: "nbg1",
  serverType: "cx23",
  image: "ubuntu-24.04",
  backups: false,
  edge: "caddy",
} as const;
const OWN = {
  provider: "own",
  mode: "vps-compose",
  arch: "amd64",
  access: "public",
  edge: "caddy",
} as const;

/** A plan's target and deploy settings, with design's reason for a recreate on 512 MB. */
function planOn(target: DeployPlan["target"], memoryGb: number, drainSeconds = 30): PlanDeploy {
  const option = { target: { ...target, memoryGb } } as unknown as Pick<DesignOption, "target">;
  return { target, deploy: { ...deployStrategyFor(option), drainSeconds } };
}

describe("keptDeploy", () => {
  it("keeps the user's strategy and drain on the same cloud server", () => {
    const fresh = planOn(HETZNER, 4);
    const user: PlanDeploy = {
      target: HETZNER,
      deploy: { strategy: "recreate", drainSeconds: 60 },
    };
    expect(keptDeploy(fresh, user)).toEqual({ strategy: "recreate", drainSeconds: 60 });
    const resized = planOn({ ...HETZNER, serverType: "cx33" }, 8);
    expect(keptDeploy(resized, user)).toEqual({ strategy: "rolling", drainSeconds: 60 });
  });

  it("rolls once the own server has more memory: the recreate was design's", () => {
    expect(keptDeploy(planOn(OWN, 2), planOn(OWN, 0.5, 45))).toEqual({
      strategy: "rolling",
      drainSeconds: 45,
    });
  });

  it("keeps a rolling the user set on their own server, however little memory it has", () => {
    const user: PlanDeploy = { target: OWN, deploy: { strategy: "rolling", drainSeconds: 45 } };
    expect(keptDeploy(planOn(OWN, 0.5), user)).toEqual({ strategy: "rolling", drainSeconds: 45 });
  });

  it("always recreates in Portainer", () => {
    const portainer = {
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 1,
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "tunnel" },
    } as const;
    const fresh = planOn(portainer, 0.01);
    const user: PlanDeploy = {
      target: portainer,
      deploy: { strategy: "rolling", drainSeconds: 30 },
    };
    expect(keptDeploy(fresh, user)).toEqual(fresh.deploy);
  });
});

describe("deploySentence", () => {
  it("names the user's choice, else design's reason", () => {
    const recreate = planOn(OWN, 0.5).deploy;
    const rolling = planOn(OWN, 2).deploy;
    expect(deploySentence(rolling, rolling)).toBe(ROLLING_NOTE);
    expect(deploySentence(recreate, recreate)).toBe(recreate.reason);
    expect(deploySentence({ strategy: "recreate", drainSeconds: 30 }, rolling)).toBe(
      "You chose recreate in opscrew/plan.yaml (deploy.strategy).",
    );
    expect(deploySentence({ strategy: "rolling", drainSeconds: 30 }, recreate)).toBe(
      "You chose rolling in opscrew/plan.yaml (deploy.strategy).",
    );
  });
});
