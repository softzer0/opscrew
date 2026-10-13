import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { moveInProgress, providerProfile } from "@opscrew/agents";
import { PHASES, type PhaseName } from "@opscrew/contracts";
import type { PhaseRecord } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { ResolvedMcpDeps } from "../deps";
import { exists, projectDirInput, relativeTo, runTool, withHint } from "./shared";

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
              `Delete ${relativeTo(paths.root, paths.files.state)} to reset the phase history; it is rebuilt on the next run.`,
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
          artifacts[name] = { path: relativeTo(paths.root, file), exists: present };
        }
        const phases: Partial<Record<PhaseName, PhaseRecord>> = current.phases;
        const width = Math.max(...PHASES.map((phase) => phase.length));
        const lines = PHASES.map((phase) => {
          const record = phases[phase];
          const name = phase.padEnd(width);
          if (record === undefined) return `  ${name}  not run`;
          const summary = record.summary === undefined ? "" : `  ${record.summary}`;
          return `  ${name}  ${record.status.padEnd(7)}  ${record.at}${summary}`;
        });
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
                to: plan.target.provider,
                step: plan.retarget.step,
                startedAt: plan.retarget.startedAt,
              };
        const moveLines =
          moveData === undefined
            ? []
            : [
                "",
                `Move: from ${providerProfile(moveData.from).displayName} to ${providerProfile(moveData.to).displayName}, last completed step: ${moveData.step}.`,
                "Both servers are billed until the move is finished.",
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
            ...(moveData === undefined ? {} : { move: moveData }),
          },
        };
      }),
  );
}
