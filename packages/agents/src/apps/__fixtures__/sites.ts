import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeFixture } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { testPlan } from "../../testing";

const EXAMPLES = fileURLToPath(new URL("../../../../../examples/", import.meta.url));

/**
 * A repository with two static sites in npm workspaces, `sites/web` and `sites/docs` (each a copy
 * of `examples/static-vite`), and nothing of OpsCrew's yet. Returns its root.
 */
export async function twoSites(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-apps-"));
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "sites", private: true, workspaces: ["sites/*"] }, null, 2)}\n`,
  );
  for (const site of ["web", "docs"]) {
    await materializeFixture(join(EXAMPLES, "static-vite"), join(root, "sites", site));
  }
  return root;
}

/**
 * `plan` (a Hetzner app named `shop` by default) as design writes it for the app `key` (a further
 * app's; none: the first app) at its environment `env` (prod by default): the key, the app name
 * (a further app's key, `<name>-<env>` in another environment), and the folder and workflow the
 * schema derives from them (never `plan`'s: the transform fills only what is missing).
 */
export function appPlan(
  key: string | undefined,
  env?: string,
  plan: DeployPlan = testPlan(),
): DeployPlan {
  const { dir: _dir, ...infra } = plan.infra;
  const { workflowPath: _workflowPath, ...cicd } = plan.cicd;
  const { key: _key, ...app } = plan.app;
  const name = key ?? app.name;
  return DeployPlanSchema.parse({
    ...plan,
    ...(env === undefined ? {} : { environment: { name: env } }),
    app: {
      ...app,
      ...(key === undefined ? {} : { key }),
      name: env === undefined ? name : `${name}-${env}`,
    },
    infra,
    cicd,
  });
}
