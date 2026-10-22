import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { testPlan } from "../../__fixtures__/plans";

/** The options of {@link onThisComputer}. */
export interface LocalhostPlanOptions {
  /** The environment's name; absent for prod. */
  environment?: string;
  edge?: "caddy" | "nginx";
  ports?: { https: 443 | 8443; http: 80 | 8080 };
}

/**
 * `plan` (an app named `shop`) moved to this computer's Docker: the localhost target, no DNS
 * record and no price. A named environment's app is `shop-<env>`.
 */
export function onThisComputer(plan: DeployPlan, o: LocalhostPlanOptions = {}): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: { ...plan.app, name: o.environment === undefined ? "shop" : `shop-${o.environment}` },
    target: {
      provider: "localhost",
      mode: "local-compose",
      arch: "amd64",
      ports: o.ports ?? { https: 443, http: 80 },
      image: "registry",
      edge: o.edge ?? "caddy",
    },
    dns: { provider: "none", proxied: false, www: false },
    cost: { ...plan.cost, monthly: { amount: 0, currency: "EUR" }, breakdown: [] },
    ...(o.environment === undefined ? {} : { environment: { name: o.environment } }),
  });
}

/** `shop` with PostgreSQL ({@link testPlan}) on this computer. */
export function localhostPlan(o: LocalhostPlanOptions = {}): DeployPlan {
  return onThisComputer(testPlan(), o);
}
