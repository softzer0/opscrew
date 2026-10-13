import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type OpscrewMcpDeps, resolveMcpDeps } from "./deps";
import { registerDeployTools } from "./tools/deploy";
import { registerDesignTools } from "./tools/design";
import { registerDetectTool } from "./tools/detect";
import { registerDriftTool } from "./tools/drift";
import { registerInitCheckTool } from "./tools/init";
import { registerInterviewTools } from "./tools/interview";
import { registerScanTool } from "./tools/scan";
import { registerStatusTool } from "./tools/status";

/** Names of the planning tools (FR-110). */
export const PLANNING_TOOLS = [
  "opscrew_scan",
  "opscrew_detect",
  "opscrew_interview_questions",
  "opscrew_save_requirements",
  "opscrew_design_options",
  "opscrew_select_design",
  "opscrew_status",
] as const;

const INSTRUCTIONS =
  "OpsCrew's deterministic tools take an app from its repository to a production deployment on the user's own cloud. Planning flow: opscrew_scan → opscrew_detect → opscrew_interview_questions → opscrew_save_requirements → opscrew_design_options → opscrew_select_design; opscrew_status shows progress. Deploy flow (after the app is adapted and merged): opscrew_render → opscrew_plan → show the user the plan, its cost and policy results → opscrew_apply with the plan hash (the user approves in a dialog; never claim approval yourself) → the user merges the pull request → opscrew_verify and opscrew_secure. The tools never call a model and never print secrets. Moving a live deployment to another cloud provider is terminal-only: no tool does it; tell the user to run `npx opscrew retarget --to <provider>` in their own terminal, and while a move is in progress pass on the commands the tools name to continue, finish or abort it. Never run tofu, terraform, hcloud or doctl yourself, and never ask the user to paste tokens or .env values.";

/**
 * Creates the OpsCrew MCP server with the planning tools and the deploy tools registered. The
 * server is not connected; pass it a transport (`StdioServerTransport` in production,
 * `InMemoryTransport` in tests). Every tool takes an optional absolute `projectDir` (default
 * `deps.cwd`), returns text plus `structuredContent`, redacts all output and maps errors to
 * `isError: true` results with a plain-English message and next step.
 */
export function createOpscrewMcpServer(deps: OpscrewMcpDeps): McpServer {
  const resolved = resolveMcpDeps(deps);
  const server = new McpServer(
    { name: "opscrew", title: "OpsCrew", version: deps.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerScanTool(server, resolved);
  registerDetectTool(server, resolved);
  registerInterviewTools(server, resolved);
  registerDesignTools(server, resolved);
  registerStatusTool(server, resolved);
  registerDeployTools(server, resolved);
  registerDriftTool(server, resolved);
  registerInitCheckTool(server, resolved);
  return server;
}
