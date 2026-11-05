import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type RunAdviseOptions, renderAdviceReport, runAdvise } from "@opscrew/agents";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { appInput, environmentInput, projectDirInput, runTool, toolEnvironment } from "./shared";

/**
 * `opscrew_advise`: the `opscrew advise` report, read only: what to change in a deployed
 * environment, the most urgent first, each with its figures, its monthly price before and after and
 * how to apply it, as text and structured content. Applying stays a terminal command
 * (`opscrew advise --apply <id>`). `options` (the servers', GitHub's and Cloudflare's fakes) is
 * for tests only.
 */
export function registerAdviseTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: RunAdviseOptions = {},
): void {
  server.registerTool(
    "opscrew_advise",
    {
      title: "Advise",
      description:
        "Propose what to change in a deployed environment, the most urgent first: a server's size (from 14 days of figures with self-hosted monitoring, else one reading, which never proposes a smaller server), cost against the interview's budget and the providers' live prices, backups and the scheduled check, security updates, Dependabot alerts and tokens about to expire. Each proposal has an id, its reasons with their figures, its monthly price before and after, and how to apply it. Reads the servers, GitHub and Cloudflare read-only and changes nothing. Applying is a terminal command only: give the user `npx opscrew advise --apply <id>` (it writes the plan; `npx opscrew provision` then applies it after the user approves its hash) or the command the proposal names. Suggest it when the user asks whether the app is the right size, why it is slow or whether it can cost less, or after opscrew_status shows high memory or a filling disk.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_advise", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const report = await runAdvise(phase, plan, options);
        return { text: renderAdviceReport(report, flag), data: { ...report } };
      }),
  );
}
