import { type DeployPlan, DeployPlanSchema, type Network } from "@opscrew/plan-schema";
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
