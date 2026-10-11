import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext, RenderedFile } from "../types";

/** Placeholders until task 002/T205 lands. */
export function renderCompose(_plan: DeployPlan, _ctx: RenderContext): RenderedFile {
  throw new Error("renderCompose is not implemented yet (task T205)");
}
export function renderCaddyfile(_plan: DeployPlan, _ctx: RenderContext): RenderedFile {
  throw new Error("renderCaddyfile is not implemented yet (task T205)");
}
