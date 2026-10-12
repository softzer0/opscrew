import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { renderDriftReport, runDrift } from "@opscrew/agents";
import type { ResolvedMcpDeps } from "../deps";
import { projectDirInput, runTool } from "./shared";

/**
 * `opscrew_drift`: the `opscrew drift` report: resources changed outside OpsCrew, changes not
 * applied yet and generated files that differ. Never changes infrastructure or repository files
 * (temporary plan files under `.opscrew/plans` are deleted).
 */
export function registerDriftTool(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_drift",
    {
      title: "Infrastructure drift",
      description:
        "Check whether the deployment still matches opscrew/plan.yaml: resources someone changed in the cloud provider (Hetzner Cloud or DigitalOcean) or Cloudflare console (with the changed attribute names, never values), infrastructure changes not applied yet, and generated files that were edited or are missing. Needs a provisioned deployment and its state on this computer. Never changes anything; to undo drift the user runs `npx opscrew provision` in a terminal.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_drift", projectDir, async (call) => {
        const report = await runDrift(await call.phaseDeps());
        return {
          text: renderDriftReport(report),
          data: { ...report },
        };
      }),
  );
}
