/**
 * @opscrew/mcp-server: the deterministic OpsCrew MCP server (`opscrew mcp`). Exposes the planning
 * tools (scan, detect, interview questions, save requirements, design options, select design,
 * status) and the deploy tools; tools never call a model and all output is redacted.
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
