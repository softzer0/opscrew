import {
  ADDON_MEMORY_DEFAULTS,
  type DeployPlan,
  DeployPlanSchema,
  type Network,
} from "@opscrew/plan-schema";
import { ownPlan, testPlan } from "../../testing";

/** Postgres (`db`) on a Hetzner server `data`; the app on its Hetzner server (or the user's own). */
export function splitPlan(
  options: { app?: "cloud" | "own" | "own-tunnel"; data?: "cloud" | "own" } = {},
): Omit<DeployPlan, "network"> {
  const base =
    options.app === "own" || options.app === "own-tunnel"
      ? ownPlan({ access: options.app === "own" ? "public" : "tunnel" })
      : testPlan();
  const { network: _none, ...rest } = base;
  return {
    ...rest,
    servers: [
      {
        name: "data",
        target:
          options.data === "own"
            ? { provider: "own", mode: "vps-compose", arch: "amd64" }
            : {
                provider: "hetzner",
                mode: "vps-compose",
                location: "nbg1",
                serverType: "cx23",
                backups: true,
              },
      },
    ],
    services: base.services.map((s) => (s.name === "db" ? { ...s, server: "data" } : s)),
  };
}

/** `plan` with `network`, checked by the plan's schema and its rules across fields. */
export function withNetwork(plan: Omit<DeployPlan, "network">, network: Network): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, network });
}

/** Monitoring on, without `where`: the owner's versions, retention and limits. */
const MONITORING = {
  enabled: true,
  versions: { prometheus: "3.15.1", loki: "3.7.9", grafana: "13.3.0", alloy: "1.21.3" },
  retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 },
  memoryMb: { ...ADDON_MEMORY_DEFAULTS.monitoring },
};

/** The owner's plan file, which a sender names. */
export const OWNER_PLAN = "opscrew/plan.yaml";

/**
 * {@link splitPlan} with monitoring on: the stack on the app's server (`on: "app"`), or on an extra
 * Hetzner server `monitoring` of its own (the owner of the repository's monitoring server).
 */
export function monitoredPlan(
  options: { on?: "app" | "server"; app?: "cloud" | "own-tunnel" } = {},
): Omit<DeployPlan, "network"> {
  const base = splitPlan({ app: options.app ?? "cloud" });
  if (options.on === "app") {
    return {
      ...base,
      observability: { ...base.observability, monitoring: { ...MONITORING, where: { kind: "app" } } },
    };
  }
  return {
    ...base,
    servers: [
      ...(base.servers ?? []),
      {
        name: "monitoring",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "fsn1",
          serverType: "cx23",
          backups: false,
        },
      },
    ],
    observability: {
      ...base.observability,
      monitoring: { ...MONITORING, where: { kind: "server", server: "monitoring" } },
    },
  };
}

/**
 * {@link splitPlan}'s staging environment, which sends to the owner's server `monitoring`
 * ({@link OWNER_PLAN}): that server is its network's outside member.
 */
export function senderPlan(): Omit<DeployPlan, "network"> {
  const base = splitPlan();
  return {
    ...base,
    app: { ...base.app, name: "shop-staging" },
    environment: { name: "staging", deploySource: { from: "main" }, runner: "github" },
    observability: {
      ...base.observability,
      monitoring: {
        ...MONITORING,
        where: { kind: "shared", owner: { plan: OWNER_PLAN, server: "monitoring" } },
      },
    },
  };
}
