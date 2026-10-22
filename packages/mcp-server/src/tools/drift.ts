import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type PhaseDeps,
  type ProvisionServices,
  readOwnServer,
  renderDriftReport,
  runDrift,
} from "@opscrew/agents";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import {
  type CallExtra,
  clientSupportsElicitation,
  dialogHandler,
  hostKeyNeedsTerminal,
} from "./elicitation";
import {
  environmentInput,
  projectDirInput,
  runTool,
  type ToolCall,
  toolEnvironment,
} from "./shared";

/** Test-only collaborators for `opscrew_drift` (production uses the real ones). */
export interface DriftToolOptions {
  /** Engine, cloud provider, Cloudflare and own-server fakes (same shape as provision's). */
  services?: ProvisionServices;
}

/**
 * The phase deps of a drift check. On a server the user owns whose SSH host key this computer
 * never confirmed, the user confirms it in a dialog (MCP elicitation); the model cannot supply
 * one, and a client without dialogs gets the terminal command instead. Every other deployment
 * gets the plain, non-interactive deps.
 */
async function driftPhaseDeps(
  server: McpServer,
  deps: ResolvedMcpDeps,
  call: ToolCall,
  extra: CallExtra,
  environment: string,
): Promise<PhaseDeps> {
  const paths = resolveProjectPaths(call.projectDir, { env: deps.env, environment });
  const plan = await readArtifact("plan", paths.files.plan).catch(() => undefined);
  if (plan?.target.provider !== "own") return call.phaseDeps({ environment });
  const recorded = await readOwnServer(paths).catch(() => undefined);
  if (recorded === undefined || recorded.hostKey !== undefined) {
    return call.phaseDeps({ environment });
  }
  if (!clientSupportsElicitation(server))
    throw hostKeyNeedsTerminal("drift", "Nothing was checked.");
  const phase = await call.phaseDeps({
    approvalHandler: dialogHandler(server, deps, extra),
    environment,
  });
  // Only the first connection asks (a dialog for the user); a pinned key is checked silently.
  return { ...phase, interactive: true };
}

/**
 * `opscrew_drift`: the `opscrew drift` report: resources changed outside OpsCrew, changes not
 * applied yet and generated files that differ; on a server the user owns, also how the server
 * differs from what OpsCrew set up (never its address); in the user's Portainer, how its stacks,
 * registry entry and deploy branch differ (never Portainer's address or a value). Never changes
 * infrastructure, the server, Portainer or repository files (temporary plan files under `.opscrew/plans` are deleted). `options` is for
 * tests only.
 */
export function registerDriftTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: DriftToolOptions = {},
): void {
  const services = options.services === undefined ? {} : { services: options.services };
  server.registerTool(
    "opscrew_drift",
    {
      title: "Infrastructure drift",
      description:
        "Check whether the deployment still matches opscrew/plan.yaml: resources someone changed in the cloud provider (Hetzner Cloud or DigitalOcean) or Cloudflare console (with the changed attribute names, never values), infrastructure changes not applied yet, and generated files that were edited or are missing. On a server the user already owns it also connects over SSH, inspects the server read-only and compares it with what OpsCrew set up (SSH settings, firewall, deploy user, runtime directories, containers); the first time from this computer the user confirms its SSH host key in a dialog. In a Portainer the user already runs it compares the app's stacks with what OpsCrew would set up now: the stack file, the environment keys (never values; changed values by key name only), the redeploy setting, the registry entry and the opscrew-deploy branch, plus the Cloudflare resources (Portainer's address never appears). Needs a provisioned deployment and its state on this computer. Never changes anything; to undo drift the user runs `npx opscrew provision` in a terminal.",
      inputSchema: { ...projectDirInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, environment }, extra: CallExtra) =>
      runTool(deps, "opscrew_drift", projectDir, async (call) => {
        const { name, flag } = await toolEnvironment(call.projectDir, environment);
        const phase = await driftPhaseDeps(server, deps, call, extra, name);
        const report = await runDrift(phase, services);
        const plan = await readArtifact("plan", phase.paths.files.plan);
        return {
          text: renderDriftReport(report, plan, flag),
          data: { ...report },
        };
      }),
  );
}
