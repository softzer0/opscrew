import type { DeployPlan } from "@opscrew/plan-schema";
import { renderInfra } from "../infra";
import { portainerTarget } from "../providers";
import type { RuntimeContext } from "../runtime";
import type { RenderedFile } from "../types";
import { renderWorkflow } from "../workflow";
import { renderPortainerStack } from "./stack";

/**
 * Everything `opscrew provision` writes into the repository for a Portainer target: the Cloudflare
 * root module (with its vendored modules), the app stack's template
 * (`<runtimeDir>/compose.yaml`) and the deploy workflow. What lives only in Portainer (the
 * updater and connector stacks) and the deploy branch's first file are not repository files:
 * {@link renderUpdaterStack}, {@link renderPortainerConnectorStack} and
 * {@link renderPlaceholderStack} render them. Deterministic; contains no secrets.
 */
export function renderPortainerDeployment(plan: DeployPlan, ctx: RuntimeContext): RenderedFile[] {
  portainerTarget(plan.target);
  return [...renderInfra(plan, ctx), renderPortainerStack(plan, ctx), renderWorkflow(plan, ctx)];
}
