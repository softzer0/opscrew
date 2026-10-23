import type { DeployPlan } from "@opscrew/plan-schema";
import { renderInfra } from "./infra";
import { renderPortainerDeployment } from "./portainer-target";
import { assertServerTarget } from "./providers";
import { type RuntimeContext, renderCompose, renderEdgeSite, renderRuntimeFiles } from "./runtime";
import type { RenderedFile } from "./types";
import { renderWorkflow } from "./workflow";

/**
 * Everything `opscrew provision` writes into the repository for a plan: infrastructure (root module,
 * tfvars, vendored modules), runtime files (Compose, the services' settings files and the crontab,
 * the edge and the app's site files for the plan's proxy) and the deploy workflow; for a Portainer
 * target, {@link renderPortainerDeployment} (its Cloudflare root, if any, the stack template and
 * the workflow). Deterministic: the same plan and context always produce the same files.
 * Lead-owned.
 */
export function renderDeployment(plan: DeployPlan, ctx: RuntimeContext): RenderedFile[] {
  assertServerTarget(plan.target, "server files to render");
  if (plan.target.provider === "portainer") return renderPortainerDeployment(plan, ctx);
  return [
    ...renderInfra(plan, ctx),
    renderCompose(plan),
    ...renderRuntimeFiles(plan, ctx),
    ...renderEdgeSite(plan, ctx),
    renderWorkflow(plan, ctx),
  ];
}
