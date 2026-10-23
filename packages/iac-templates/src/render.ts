import { type DeployPlan, isServerlessTarget } from "@opscrew/plan-schema";
import { renderInfra } from "./infra";
import { renderPortainerDeployment } from "./portainer-target";
import { type RuntimeContext, renderCompose, renderEdgeSite, renderRuntimeFiles } from "./runtime";
import { renderHeadersEntry, renderWranglerConfig } from "./serverless";
import type { RenderedFile } from "./types";
import { renderWorkflow } from "./workflow";

/**
 * Everything `opscrew provision` writes into the repository for a plan: infrastructure (root module,
 * tfvars, vendored modules), runtime files (Compose, the services' settings files and the crontab,
 * the edge and the app's site files for the plan's proxy) and the deploy workflow; for a Portainer
 * target, {@link renderPortainerDeployment} (its Cloudflare root, if any, the stack template and
 * the workflow); for a server-less target, its infrastructure, on Cloudflare the Wrangler config
 * (and with `render: ssr` the headers wrapper), and its workflow. Deterministic: the same plan and
 * context always produce the same files. Lead-owned.
 */
export function renderDeployment(plan: DeployPlan, ctx: RuntimeContext): RenderedFile[] {
  if (isServerlessTarget(plan.target)) {
    const target = plan.target;
    return [
      ...renderInfra(plan, ctx),
      ...(target.provider === "cloudflare-workers"
        ? [
            renderWranglerConfig(plan),
            ...(target.render === "ssr" ? [renderHeadersEntry(plan)] : []),
          ]
        : []),
      renderWorkflow(plan, ctx),
    ];
  }
  if (plan.target.provider === "portainer") return renderPortainerDeployment(plan, ctx);
  return [
    ...renderInfra(plan, ctx),
    renderCompose(plan),
    ...renderRuntimeFiles(plan, ctx),
    ...renderEdgeSite(plan, ctx),
    renderWorkflow(plan, ctx),
  ];
}
