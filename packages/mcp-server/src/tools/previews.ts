import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listPreviews, type PreviewServices, previewListLines } from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/**
 * `opscrew_preview_list` (spec.md US7): the previews of a preview environment, as
 * `opscrew preview list` reads them from the preview server (read-only): each preview's pull
 * request, address, state, commit and times, and how many run against the cap. Removing one stays
 * a terminal command. `options` (the deploy user's shell) is for tests only.
 */
export function registerPreviewTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: { services?: PreviewServices } = {},
): void {
  server.registerTool(
    "opscrew_preview_list",
    {
      title: "List the previews",
      description:
        "List the previews of pull requests in a preview environment, read from its preview server: each preview's pull request number, address (https://pr-<number>.<name>), state (running; running with a failed seed; failed), commit and age, and how many run against the cap. Reads the server read-only and changes nothing. Pass the preview environment as environment (opscrew_env_list names it). Removing a preview stays in the user's terminal: `npx opscrew preview destroy <n>` (the user types pr-<n>); its logs are `npx opscrew preview logs <n>`.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_preview_list", projectDir, async (call) => {
        const { appKey, name } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const list = await listPreviews(phase, plan, options);
        return { text: previewListLines(list, phase.clock.now()).join("\n"), data: { ...list } };
      }),
  );
}
