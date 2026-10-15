/**
 * @opscrew/mcp-server: the deterministic OpsCrew MCP server (`opscrew mcp`). Exposes the planning
 * tools (scan, detect, interview questions, save requirements, design options, select design,
 * status), the deploy tools, the read-only drift, preflight and domain checks, and the Portainer
 * tools; moving a deployment, removing it and buying a domain are terminal-only. Tools never call a
 * model, all output is redacted, and the address of a server the user owns never leaves a result.
 */
export {
  CollectingReporter,
  createDefaultPhaseDepsFactory,
  type OpscrewMcpDeps,
  type PhaseDepsExtras,
  type PhaseDepsFactory,
  RefusingApprovalHandler,
  type ReportedMessage,
  type ResolvedMcpDeps,
  resolveMcpDeps,
} from "./deps";
export { createOpscrewMcpServer, PLANNING_TOOLS } from "./server";
export { type RunningStdioServer, type StdioServerOptions, startStdioServer } from "./stdio";
