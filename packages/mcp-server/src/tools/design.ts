import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type DesignPreview,
  type DesignResult,
  formatMoney,
  type PhaseDeps,
  previewDesignOptions,
  priceLabel,
  providerProfile,
  requestedProvider,
  runAnalyze,
  runDesign,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import { detectProject } from "@opscrew/detect";
import { type DesignOption, readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import { CollectingReporter, type ResolvedMcpDeps } from "../deps";
import { isMissingArtifact, projectDirInput, relativeTo, runTool, withHint } from "./shared";

const REQUIREMENTS_HINT =
  "Call opscrew_interview_questions, ask the user the questions, then call opscrew_save_requirements.";

/** Fails with a tool-oriented hint unless `opscrew/requirements.yaml` exists and is valid. */
async function requireRequirements(phase: PhaseDeps): Promise<void> {
  const file = relativeTo(phase.paths.root, phase.paths.files.requirements);
  try {
    await readArtifact("requirements", phase.paths.files.requirements);
  } catch (error) {
    if (isMissingArtifact(error)) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The deployment requirements are not saved yet (${file} does not exist).`,
        { hint: REQUIREMENTS_HINT },
      );
    }
    withHint(error, `Fix ${file}, or save the answers again with opscrew_save_requirements.`);
  }
}

/** Fails with a tool-oriented hint when `opscrew/architecture.json` exists but is invalid. */
async function checkArchitecture(phase: PhaseDeps): Promise<boolean> {
  try {
    await readArtifact("architecture", phase.paths.files.architecture);
    return true;
  } catch (error) {
    if (isMissingArtifact(error)) return false;
    const file = relativeTo(phase.paths.root, phase.paths.files.architecture);
    return withHint(
      error,
      `Fix ${file}, or delete it so OpsCrew detects the project again, then retry.`,
    );
  }
}

/**
 * Prices the options without writing anything to the project (`previewDesignOptions`). Without a
 * saved `architecture.json`, the facts come from a fresh deterministic detection.
 */
async function previewDesign(
  deps: ResolvedMcpDeps,
  phase: PhaseDeps,
  hasArchitecture: boolean,
): Promise<DesignPreview> {
  const quiet: PhaseDeps = { ...phase, reporter: new CollectingReporter(deps.redactor.redact) };
  const facts = hasArchitecture ? undefined : await detectProject(phase.paths.root);
  return previewDesignOptions(quiet, facts ? { facts } : {});
}

/** Plain-text block for one option. */
function renderOption(option: DesignOption): string {
  const marks = [
    option.fitsBudget ? "fits the budget" : "over budget",
    ...(option.recommended ? ["RECOMMENDED"] : []),
  ];
  const t = option.target;
  return [
    `${option.title} (id: ${option.id}) — ${formatMoney(option.cost.monthly)}/month, ${priceLabel(option.cost)}; ${marks.join(", ")}`,
    `  ${option.summary}`,
    `  Server: ${t.serverType} in ${t.location}, ${t.vcpus} vCPU (${t.cpuType}), ${t.memoryGb} GB RAM, ${t.diskGb} GB disk`,
    `  Cost: ${option.cost.breakdown.map((b) => `${b.item} ${formatMoney(b.monthly)}`).join("; ")}`,
    ...option.tradeoffs.map((tradeoff) => `  - ${tradeoff}`),
  ].join("\n");
}

/**
 * `opscrew_design_options` (read-only preview of 2–3 priced options on the chosen provider) and
 * `opscrew_select_design` (writes `opscrew/plan.yaml` for the chosen option).
 */
export function registerDesignTools(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_design_options",
    {
      title: "Deployment options",
      description:
        "Offer 2–3 concrete deployment options on the cloud provider chosen in the interview (Hetzner Cloud or DigitalOcean) for this app and the saved requirements, each with monthly cost and breakdown, whether it fits the budget and its trade-offs; exactly one is recommended. Prices are live when the provider's API token (HCLOUD_TOKEN or DIGITALOCEAN_TOKEN) is set, otherwise a dated price list labelled as an estimate. Needs opscrew_save_requirements first. Writes nothing; call opscrew_select_design with the option the user chooses.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_design_options", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        await requireRequirements(phase);
        const hasArchitecture = await checkArchitecture(phase);
        const result = await previewDesign(deps, phase, hasArchitecture);
        for (const warning of result.warnings) call.reporter.warn(warning);
        const recommended = result.options.find((o) => o.recommended);
        const requirements = await readArtifact("requirements", phase.paths.files.requirements);
        const fitting = result.options.some((o) => o.fitsBudget);
        const providerName = providerProfile(requestedProvider(requirements)).displayName;
        const text = [
          `Deployment options on ${providerName} (budget ${formatMoney(requirements.budgetMonthly)}/month, prices ${result.priceSource === "live" ? `live from ${providerName}` : "from a dated price list; estimates"}, excl. VAT):`,
          "",
          ...result.options.map(renderOption),
          "",
          ...(fitting ? [] : ["None of the options fits the budget."]),
          `OpsCrew recommends ${recommended?.id ?? "the first option"}. After the user chooses, call opscrew_select_design with the option id.`,
        ].join("\n");
        return {
          text,
          data: {
            options: result.options,
            recommendedId: recommended?.id,
            priceSource: result.priceSource,
            budget: requirements.budgetMonthly,
            fitsBudget: fitting,
            warnings: result.warnings,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_select_design",
    {
      title: "Choose a deployment option",
      description:
        "Write opscrew/plan.yaml for the deployment option the user chose (an id from opscrew_design_options), including the code changes the app needs before it can be deployed. Also writes opscrew/architecture.json from deterministic detection when it does not exist yet. Creates no infrastructure.",
      inputSchema: {
        ...projectDirInput,
        optionId: z
          .string()
          .min(1)
          .describe("Id of the chosen option, as returned by opscrew_design_options."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    ({ projectDir, optionId }) =>
      runTool(deps, "opscrew_select_design", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        await requireRequirements(phase);
        const hasArchitecture = await checkArchitecture(phase);
        const notes: string[] = [];
        if (!hasArchitecture) {
          await runAnalyze(phase, { ai: false });
          notes.push(
            `Wrote ${relativeTo(phase.paths.root, phase.paths.files.architecture)} from deterministic detection.`,
          );
        }
        let result: DesignResult;
        try {
          result = await runDesign(phase, { optionId });
        } catch (error) {
          if (error instanceof OpsCrewError && error.code === "INVALID_INPUT") {
            withHint(
              error,
              `${error.hint ?? ""} Call opscrew_design_options to see the current option ids.`.trim(),
            );
          }
          throw error;
        }
        const { chosen, plan } = result;
        const planFile = relativeTo(phase.paths.root, phase.paths.files.plan);
        const pending = plan.codeChanges.filter((change) => change.status === "pending");
        const text = [
          ...notes,
          `Saved ${planFile}: ${chosen.title} (${chosen.id}), ${formatMoney(chosen.cost.monthly)}/month, ${priceLabel(chosen.cost)}.`,
          "",
          plan.codeChanges.length === 0
            ? "The app needs no code changes."
            : `Code changes the app needs (${pending.length} pending):`,
          ...plan.codeChanges.map(
            (change) => `- [${change.status}] ${change.kind} (${change.path}): ${change.reason}`,
          ),
          "",
          "Next: apply the pending code changes (opscrew-adapt skill) and let the user review and commit them. Nothing has been created in the cloud.",
        ].join("\n");
        return {
          text,
          data: {
            chosen,
            planFile,
            plan,
            codeChanges: plan.codeChanges,
            priceSource: result.priceSource,
            warnings: result.warnings,
          },
        };
      }),
  );
}
