import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { moveInProgress, moveProvider, phaseStatusLines, providerProfile } from "@opscrew/agents";
import { exists, toPosixRelative } from "@opscrew/core";
import { type Retarget, readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { projectDirInput, runTool, withHint } from "./shared";

/** The next planning step for the plugin flow, given which artefacts exist. */
function nextStep(have: Record<string, boolean>): string {
  if (!have.scanReport) return "Call opscrew_scan to check the repository for security problems.";
  if (!have.requirements) {
    return "Call opscrew_detect, then opscrew_interview_questions and opscrew_save_requirements.";
  }
  if (!have.plan) return "Call opscrew_design_options and then opscrew_select_design.";
  return "Apply the pending code changes from opscrew/plan.yaml (opscrew-adapt skill), then provision with `npx opscrew provision` in a terminal.";
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

/**
 * `opscrew_status`: which phases have run (from `.opscrew/state.json`), which artefacts exist and
 * the next step. Read-only.
 */
export function registerStatusTool(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_status",
    {
      title: "OpsCrew status",
      description:
        "Show which OpsCrew phases have run in this project (with result, time and summary), which OpsCrew files exist (security scan report, architecture, requirements, plan), where a move to another provider stands (moves run only in the user's terminal with `npx opscrew retarget`) and the next step. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_status", projectDir, async (call) => {
        const { paths, state } = await call.phaseDeps();
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
            ? nextStep(have)
            : `${move.message} ${move.hint} Moves are terminal-only: ask the user to run these commands with npx in a terminal in the project directory.`;
        const text = [
          `OpsCrew phases in ${paths.root}:`,
          ...lines,
          "",
          "Files:",
          ...Object.values(artifacts).map(
            (a) => `  ${a.path}: ${a.exists ? "present" : "missing"}`,
          ),
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
          },
        };
      }),
  );
}
