import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type OpscrewMcpDeps, resolveMcpDeps } from "./deps";
import { registerDeployTools } from "./tools/deploy";
import { registerDesignTools } from "./tools/design";
import { registerDetectTool } from "./tools/detect";
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
  "OpsCrew's deterministic tools take an app from its repository to a production deployment on the user's own cloud. Planning flow: opscrew_scan → opscrew_detect → opscrew_interview_questions → opscrew_save_requirements → opscrew_design_options → opscrew_select_design; opscrew_status shows progress. The tools never call a model and never print secrets. Never run tofu, terraform or hcloud yourself, and never ask the user to paste tokens or .env values.";

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
  return server;
}
