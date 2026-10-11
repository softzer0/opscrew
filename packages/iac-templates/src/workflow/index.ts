import type { DeployPlan } from "@opscrew/plan-schema";
import type { RenderContext, RenderedFile } from "../types";

/** Placeholder until task 002/T205 lands. */
export function renderWorkflow(_plan: DeployPlan, _ctx: RenderContext): RenderedFile {
  throw new Error("renderWorkflow is not implemented yet (task T205)");
}
