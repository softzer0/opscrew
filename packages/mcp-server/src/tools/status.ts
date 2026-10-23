import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildStatusLines,
  type ComponentStatusOptions,
  componentStatusReport,
  moveInProgress,
  moveProvider,
  type PhaseDeps,
  phaseStatusLines,
  providerProfile,
  readOwnServer,
  supplyChainLines,
  type TlsStatusOptions,
  tlsStatusReport,
} from "@opscrew/agents";
import { exists, toPosixRelative } from "@opscrew/core";
import { type DeployPlan, type Retarget, readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { hostKeyNeedsTerminal } from "./elicitation";
import {
  appInput,
  environmentInput,
  projectDirInput,
  runTool,
  toolEnvironment,
  withHint,
} from "./shared";

/**
 * The next planning step for the plugin flow, given which artefacts exist; `flag` is the app's
 * and environment's flags for the terminal command (`ToolEnvironment.flag`).
 */
function nextStep(have: Record<string, boolean>, flag: string): string {
  if (!have.scanReport) return "Call opscrew_scan to check the repository for security problems.";
  if (!have.requirements) {
    return "Call opscrew_detect, then opscrew_interview_questions and opscrew_save_requirements.";
  }
  if (!have.plan) return "Call opscrew_design_options and then opscrew_select_design.";
  return `Apply the pending code changes from opscrew/plan.yaml (opscrew-adapt skill), then provision with \`npx opscrew provision${flag}\` in a terminal.`;
}

/**
 * Which servers a move keeps billed: only the current one before the new one is created
 * (`started`, `renamed`) and once an abort deleted it (`new-removed` and later); both otherwise.
 */
function billing(move: Retarget): string {
  if (move.abort !== undefined && move.abort.step !== "started") {
    return "The new server was deleted by the abort; only the previous server is billed.";
  }
  if (move.step === "started" || move.step === "renamed") {
    return "The new server is not created yet; only the current server is billed.";
  }
  if (move.abort !== undefined) {
    return "Both servers are billed until the abort deletes the new one.";
  }
  return move.step === "switched"
    ? "Both servers are billed until `opscrew retarget --finish` deletes the old one."
    : "Both servers are billed until the move is finished or aborted.";
}

/** Test-only collaborators for `opscrew_status` (production connects over SSH). */
export interface StatusToolOptions {
  /** The deploy user's shell on a server OpsCrew created, and own-server fakes. */
  services?: ComponentStatusOptions["services"];
  /** Reads the certificate a DNS-only hostname presents (production: `node:tls`). */
  tlsConnect?: TlsStatusOptions["tlsConnect"];
}

/**
 * The server's proxy, each certificate OpsCrew manages with its expiry, and the recovery copy's
 * last update, key count and whether it is behind (FR-1462).
 */
function tlsOf(phase: PhaseDeps, plan: DeployPlan, options: StatusToolOptions) {
  return tlsStatusReport(phase, plan, {
    ...(options.tlsConnect === undefined ? {} : { tlsConnect: options.tlsConnect }),
    ...(options.services === undefined ? {} : { services: options.services }),
  });
}

/**
 * The plan's components, and once the app was deployed whether each runs, read over SSH on a
 * server or through Portainer's API (FR-1331). A server the user owns is read only with its
 * pinned host key; when the deployment cannot be read, a note says why.
 */
function componentsOf(phase: PhaseDeps, plan: DeployPlan, options: StatusToolOptions) {
  return componentStatusReport(phase, plan, {
    ...(options.services === undefined ? {} : { services: options.services }),
    // The model cannot confirm a host key: an own server never confirmed is left to the terminal.
    check: async () => {
      if (plan.target.provider !== "own") return;
      const recorded = await readOwnServer(phase.paths).catch(() => undefined);
      if (recorded !== undefined && recorded.hostKey === undefined) {
        throw hostKeyNeedsTerminal("status", "OpsCrew did not check whether the components run.");
      }
    },
  });
}

/**
 * `opscrew_status`: which phases have run (from `.opscrew/state.json`), which artefacts exist, the
 * plan's image builder and deploy strategy, its supply-chain settings (signing, deploy tags,
 * image retention), the app's components and whether each runs, the proxy, certificates and
 * recovery copy (`tlsStatusReport`), and the next step. Writes
 * nothing. `options` is for tests only.
 */
export function registerStatusTool(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: StatusToolOptions = {},
): void {
  server.registerTool(
    "opscrew_status",
    {
      title: "OpsCrew status",
      description:
        "Show which OpsCrew phases have run in this project (with result, time and summary), which OpsCrew files exist (security scan report, architecture, requirements, plan), the planned image builder and deploy strategy with their reasons, the image signing, deploy tag and image retention settings, the app's components (web process, workers, cron jobs, services) and, once the app was deployed, whether each runs (read over SSH on a server, on the user's own server only after its SSH host key was confirmed; through Portainer's API with PORTAINER_API_KEY in the user's Portainer), the server's reverse proxy (Caddy or nginx), each certificate OpsCrew manages with its expiry and a warning when fewer than 30 days remain, the encrypted recovery copy of the app's secrets (last update, how many keys open it, whether it is behind), where a move to another provider stands (moves run only in the user's terminal with `npx opscrew retarget`) and the next step. Writes nothing.",
      inputSchema: { ...projectDirInput, ...appInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir, app, environment }) =>
      runTool(deps, "opscrew_status", projectDir, async (call) => {
        const { appKey, name, flag } = await toolEnvironment(call.projectDir, app, environment);
        const phase = await call.phaseDeps({ app: appKey, environment: name });
        const { paths, state } = phase;
        const current = await state
          .read()
          .catch((error: unknown) =>
            withHint(
              error,
              `Delete ${toPosixRelative(paths.root, paths.files.state)} to reset the phase history; it is rebuilt on the next run.`,
            ),
          );
        const files = {
          scanReport: paths.files.scanReportMd,
          architecture: paths.files.architecture,
          requirements: paths.files.requirements,
          plan: paths.files.plan,
        };
        const artifacts: Record<string, { path: string; exists: boolean }> = {};
        const have: Record<string, boolean> = {};
        for (const [name, file] of Object.entries(files)) {
          const present = await exists(file);
          have[name] = present;
          artifacts[name] = { path: toPosixRelative(paths.root, file), exists: present };
        }
        const phases = current.phases;
        const lines = phaseStatusLines(phases);
        // A move to another provider in progress (`opscrew retarget`): where it stands and the
        // terminal command to continue it. An unreadable plan is not this tool's concern.
        const plan = have.plan
          ? await readArtifact("plan", paths.files.plan).catch(() => undefined)
          : undefined;
        const move = plan === undefined ? undefined : moveInProgress(plan);
        const moveData =
          plan?.retarget === undefined
            ? undefined
            : {
                from: plan.retarget.from.target.provider,
                to: moveProvider(plan.target),
                step: plan.retarget.step,
                abortStep: plan.retarget.abort?.step,
                startedAt: plan.retarget.startedAt,
              };
        const moveLines =
          plan?.retarget === undefined || moveData === undefined
            ? []
            : [
                "",
                `Move: from ${providerProfile(moveData.from).displayName} to ${providerProfile(moveData.to).displayName}, last completed step: ${moveData.step}${plan.retarget.abort === undefined ? "" : ` (being aborted, last abort step: ${plan.retarget.abort.step})`}.`,
                billing(plan.retarget),
              ];
        const step =
          move === undefined
            ? nextStep(have, flag)
            : `${move.message} ${move.hint} Moves are terminal-only: ask the user to run these commands with npx in a terminal in the project directory.`;
        const components =
          plan === undefined ? undefined : await componentsOf(phase, plan, options);
        const tls = plan === undefined ? undefined : await tlsOf(phase, plan, options);
        const text = [
          `OpsCrew phases in ${paths.root}:`,
          ...lines,
          "",
          "Files:",
          ...Object.values(artifacts).map(
            (a) => `  ${a.path}: ${a.exists ? "present" : "missing"}`,
          ),
          ...(plan === undefined ? [] : ["", ...buildStatusLines(plan), ...supplyChainLines(plan)]),
          ...(components === undefined ? [] : ["", ...components.lines]),
          ...(tls === undefined ? [] : ["", ...tls.lines]),
          ...moveLines,
          "",
          `Next: ${step}`,
        ].join("\n");
        return {
          text,
          data: {
            projectDir: paths.root,
            phases,
            artifacts,
            nextStep: step,
            move: moveData,
            ...(components?.status === undefined ? {} : { components: components.status }),
            ...(tls === undefined ? {} : { tls: tls.lines }),
          },
        };
      }),
  );
}
