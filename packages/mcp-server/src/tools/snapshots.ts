import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listSnapshots,
  readOwnServer,
  type SnapshotServices,
  snapshotListLines,
} from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { hostKeyNeedsTerminal } from "./elicitation";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/**
 * `opscrew_snapshots` (024 US8): the environment's snapshots as `opscrew snapshot list` reads them
 * (read-only): each one's id, kind, time, the version that ran, size, services and where it is,
 * and whether its off-server copy exists. Taking, restoring and deleting one stay terminal
 * commands. On the user's own server it connects only once the server's SSH host key was
 * confirmed in a terminal. `options` (the machines' and providers' fakes) is for tests only.
 */
export function registerSnapshotsTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: { services?: SnapshotServices } = {},
): void {
  server.registerTool(
    "opscrew_snapshots",
    {
      title: "List the snapshots",
      description:
        "List an environment's snapshots of its data, newest first, read where they are: on the app's servers (each part on the server that holds it), on this computer, in the user's Portainer, and the whole-server snapshots at Hetzner or DigitalOcean. Each has its id, kind (by hand, before a release, scheduled, whole server), time, the version that ran, size, its services (copied, left out or failed), where it is, and whether its encrypted copy off the server exists. Reads read-only and changes nothing; never a dumped value, password or address. Taking, restoring and deleting a snapshot, and turning the schedule or the off-server copy on or off, stay in the user's terminal because they ask for approval: `npx opscrew snapshot`, `npx opscrew restore <id>`, `npx opscrew snapshot delete <id>`, `npx opscrew snapshot schedule on|off`, `npx opscrew snapshot offsite on|off`.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_snapshots", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        // The model cannot confirm a host key: an own server never confirmed is left to the terminal.
        if (plan.target.provider === "own") {
          const recorded = await readOwnServer(phase.paths).catch(() => undefined);
          if (recorded !== undefined && recorded.hostKey === undefined) {
            throw hostKeyNeedsTerminal("snapshot list", "Nothing was read.");
          }
        }
        const snapshots = await listSnapshots(
          phase,
          options.services === undefined ? {} : { services: options.services },
        );
        return { text: snapshotListLines(snapshots).join("\n"), data: { snapshots } };
      }),
  );
}
