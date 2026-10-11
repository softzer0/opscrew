import type { DeployPlan } from "@opscrew/plan-schema";
import { renderInfra } from "./infra";
import { renderCaddyfile, renderCompose } from "./runtime";
import type { RenderContext, RenderedFile } from "./types";
import { renderWorkflow } from "./workflow";

/**
 * Everything `opscrew provision` writes into the repository for a plan: infrastructure (root module,
 * tfvars, vendored modules), runtime files (Compose, Caddyfile) and the deploy workflow.
 * Deterministic: the same plan and context always produce the same files. Lead-owned.
 */
export function renderDeployment(plan: DeployPlan, ctx: RenderContext): RenderedFile[] {
  return [
    ...renderInfra(plan, ctx),
    renderCompose(plan, ctx),
    renderCaddyfile(plan, ctx),
    renderWorkflow(plan, ctx),
  ];
}
