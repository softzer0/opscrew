import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type PhaseDeps,
  type ProvisionServices,
  readOwnServer,
  renderDriftReport,
  runDrift,
} from "@opscrew/agents";
import { OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { clientSupportsElicitation, ElicitationApprovalHandler } from "./deploy";
import { projectDirInput, runTool, type ToolCall } from "./shared";

/** Test-only collaborators for `opscrew_drift` (production uses the real ones). */
export interface DriftToolOptions {
  /** Engine, cloud provider, Cloudflare and own-server fakes (same shape as provision's). */
  services?: ProvisionServices;
}

/** Per-call context the SDK passes to a tool callback. */
interface CallExtra {
  requestId?: string | number;
  signal?: AbortSignal;
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
): Promise<PhaseDeps> {
  const paths = resolveProjectPaths(call.projectDir, { env: deps.env });
  const plan = await readArtifact("plan", paths.files.plan).catch(() => undefined);
  if (plan?.target.provider !== "own") return call.phaseDeps();
  const recorded = await readOwnServer(paths).catch(() => undefined);
  if (recorded === undefined || recorded.hostKey !== undefined) return call.phaseDeps();
  if (!clientSupportsElicitation(server)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew must confirm the SSH host key of the user's server once before it connects, and this MCP client cannot show the confirmation dialog. Nothing was checked.",
      {
        hint: "Ask the user to run `npx opscrew drift` in a terminal in the project directory: it shows the server's fingerprint to check against the server and pins it. Then call this tool again.",
      },
    );
  }
  const phase = await call.phaseDeps({
    approvalHandler: new ElicitationApprovalHandler(server, {
      clock: deps.clock,
      redact: deps.redactor.redact,
      extra,
    }),
  });
  // Only the first connection asks (a dialog for the user); a pinned key is checked silently.
  return { ...phase, interactive: true };
}

/**
 * `opscrew_drift`: the `opscrew drift` report: resources changed outside OpsCrew, changes not
 * applied yet and generated files that differ; on a server the user owns, also how the server
 * differs from what OpsCrew set up (never its address). Never changes infrastructure, the server
 * or repository files (temporary plan files under `.opscrew/plans` are deleted). `options` is for
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
        "Check whether the deployment still matches opscrew/plan.yaml: resources someone changed in the cloud provider (Hetzner Cloud or DigitalOcean) or Cloudflare console (with the changed attribute names, never values), infrastructure changes not applied yet, and generated files that were edited or are missing. On a server the user already owns it also connects over SSH, inspects the server read-only and compares it with what OpsCrew set up (SSH settings, firewall, deploy user, runtime directories, containers); the first time from this computer the user confirms its SSH host key in a dialog. Needs a provisioned deployment and its state on this computer. Never changes anything; to undo drift the user runs `npx opscrew provision` in a terminal.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir }, extra: CallExtra) =>
      runTool(deps, "opscrew_drift", projectDir, async (call) => {
        const report = await runDrift(await driftPhaseDeps(server, deps, call, extra), services);
        return {
          text: renderDriftReport(report),
          data: { ...report },
        };
      }),
  );
}
