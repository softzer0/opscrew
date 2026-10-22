/** Projects with several environments for the CLI tests. Tests only. */
import path from "node:path";
import { testPlan } from "@opscrew/agents/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { type TempProject, tempProject } from "./harness";

/** `prod` as the plan of the environment `name`, as design writes it. */
export function inEnvironment(
  prod: DeployPlan,
  name: string,
  block: Record<string, unknown> = {},
): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name, ...block },
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
  });
}

/** The plan of the environment `name` on this computer (the localhost target). */
export function localPlan(name: string, block: Record<string, unknown> = {}): DeployPlan {
  const base = testPlan({ userSecret: false });
  return inEnvironment(
    DeployPlanSchema.parse({
      ...base,
      target: {
        provider: "localhost",
        mode: "local-compose",
        arch: "amd64",
        ports: { https: 8443, http: 8080 },
        image: "registry",
        edge: "caddy",
      },
      dns: { provider: "none", proxied: false },
      cost: { ...base.cost, monthly: { amount: 0, currency: "EUR" }, breakdown: [] },
    }),
    name,
    block,
  );
}

/** The plan file of the environment `name` in `root`. */
export function planFile(root: string, name: string): string {
  return name === "prod"
    ? path.join(root, "opscrew", "plan.yaml")
    : path.join(root, "opscrew", "environments", name, "plan.yaml");
}

/** A project with prod (`prod`, deployed by default) and these environments' plans beside it. */
export async function withEnvironments(
  plans: Record<string, DeployPlan>,
  prod: DeployPlan = testPlan({ deployed: true }),
): Promise<TempProject> {
  const created = await tempProject();
  await writeArtifact("plan", planFile(created.root, "prod"), prod);
  for (const [name, plan] of Object.entries(plans)) {
    await writeArtifact("plan", planFile(created.root, name), plan);
  }
  return created;
}
