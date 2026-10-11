import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext, RenderedFile } from "../types";

/** Placeholder until task 002/T204 lands. */
export function renderInfra(_plan: DeployPlan, _ctx: RenderContext): RenderedFile[] {
  throw new Error("renderInfra is not implemented yet (task T204)");
}
