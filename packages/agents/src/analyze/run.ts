import type { PhaseResult } from "@opscrew/contracts";
import {
  ensureStateDir,
  errorMessage,
  OpsCrewError,
  plural,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import { detectProjectDetails, normalizeAppDir } from "@opscrew/detect";
import {
  AppKindSchema,
  type Architecture,
  ArchitectureSchema,
  PortSchema,
  type ProjectFacts,
  ProjectFactsSchema,
  readArtifact,
  UrlPathSchema,
  writeArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { recordedAppDir } from "../apps/record";
import type { PhaseDeps } from "../context";
import { runPhase } from "../shared/phase-status";
import { renderArchitectureMarkdown } from "./markdown";
import { ANALYST_SYSTEM_PROMPT, buildAnalystPrompt } from "./prompts";
import { APP_KIND_LABELS, summarizeFacts } from "./summary";

/** Default model of the Analyst. */
export const DEFAULT_ANALYST_MODEL = "claude-haiku-5-5";

/** Structured output the Analyst must return; validated before any of it is used. */
export const AnalystOutputSchema = z.object({
  summary: z.string().min(1).max(3000),
  risks: z.array(z.string().min(1).max(600)).max(20),
  corrections: z
    .object({
      appKind: AppKindSchema.optional(),
      port: PortSchema.optional(),
      startCommand: z.string().min(1).max(500).optional(),
      healthEndpoint: UrlPathSchema.optional(),
    })
    .optional(),
});
export type AnalystOutput = z.infer<typeof AnalystOutputSchema>;

export interface AnalyzeOptions {
  /** Let the Analyst refine the result when a model is configured (default true). */
  ai?: boolean;
  /** Model id for the Analyst (default {@link DEFAULT_ANALYST_MODEL}). */
  model?: string;
  /**
   * Repo-relative directory of the app to describe in a repository with several apps (CLI
   * `--dir`). Default: `appDir` from `opscrew/requirements.yaml` when it is set there. An unknown
   * directory fails with `INVALID_INPUT` listing the apps OpsCrew found. A further app is always
   * the one in its record's folder (`opscrew/apps/<key>/app.yaml`): another folder is refused.
   */
  appDir?: string;
}

export interface AnalyzeResult {
  architecture: Architecture;
  /** Contents written to `opscrew/ARCHITECTURE.md`. */
  markdown: string;
  /** Model spend in USD (0 when no model ran). */
  costUsd: number;
  /** Why the AI step did not refine the result, when it was requested but skipped or failed. */
  aiSkippedReason?: string;
}

const MAX_TURNS = 25;
const MAX_BUDGET_USD = 0.5;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** ` in apps/api` for an app in a subfolder, empty for the repository root. */
const inFolder = (facts: ProjectFacts) => (facts.appDir !== "." ? ` in ${facts.appDir}` : "");

/**
 * The analyze phase: detects the project, builds the deterministic architecture, optionally lets
 * the read-only Analyst refine the summary, risks and a few facts (app kind, port, start command,
 * health endpoint), then writes `opscrew/architecture.json` and `opscrew/ARCHITECTURE.md`, records
 * the phase in `.opscrew/state.json` and the model cost in `.opscrew/costs.jsonl`. Any AI failure
 * falls back to the deterministic result with a warning.
 */
export async function runAnalyze(
  deps: PhaseDeps,
  options: AnalyzeOptions = {},
): Promise<AnalyzeResult> {
  const { ai = true, model = DEFAULT_ANALYST_MODEL } = options;
  const { reporter, paths } = deps;
  return runPhase(deps, "analyze", async () => {
    await ensureStateDir(paths);
    reporter.step("Analysing the project");
    // A further app is the one in its record's folder (`opscrew app add`), never another.
    const recorded = await recordedAppDir(paths);
    if (
      recorded !== undefined &&
      options.appDir !== undefined &&
      normalizeAppDir(options.appDir) !== recorded
    ) {
      const asked = normalizeAppDir(options.appDir);
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The app ${paths.app} is the one in ${recorded} (opscrew/apps/${paths.app}/app.yaml), so OpsCrew does not describe ${asked} for it. Nothing was written.`,
        {
          hint: `Leave the folder out to describe ${recorded}, or add the app in ${asked} with \`opscrew app add <key> --dir ${asked}\`.`,
        },
      );
    }
    const appDir = recorded ?? options.appDir ?? (await chosenAppDir(deps));
    if (appDir !== undefined && normalizeAppDir(appDir) !== ".") {
      const source =
        recorded !== undefined
          ? ` (opscrew/apps/${paths.app}/app.yaml)`
          : options.appDir !== undefined
            ? ""
            : " (chosen earlier; `--dir .` describes the whole repository)";
      reporter.info(`Describing the app in ${normalizeAppDir(appDir)}${source}.`);
    }
    const detection = await detectProjectDetails(
      paths.root,
      appDir !== undefined ? { appDir } : {},
    );
    if (detection.truncated) {
      reporter.warn(
        "The repository has more files than OpsCrew inspects (20,000); detection may be incomplete.",
      );
    }
    const summarizeOptions = { appCandidates: detection.appCandidates };
    const deterministic = summarizeFacts(detection.facts, summarizeOptions);
    let architecture: Architecture = {
      schemaVersion: 1,
      generatedAt: deps.clock.now().toISOString(),
      generator: { tool: "opscrew", version: deps.version },
      facts: detection.facts,
      summary: deterministic.summary,
      risks: deterministic.risks,
      aiEnriched: false,
    };

    let costUsd = 0;
    let aiSkippedReason: string | undefined;
    if (ai) {
      const enriched = await enrich(deps, architecture, deterministic, model, summarizeOptions);
      costUsd = enriched.costUsd;
      if (enriched.architecture !== undefined) architecture = enriched.architecture;
      else aiSkippedReason = enriched.reason;
    }

    const markdown = renderArchitectureMarkdown(architecture);
    await writeArtifact("architecture", paths.files.architecture, architecture);
    await writeFileAtomic(paths.files.architectureMd, markdown, { mode: 0o644 });
    const written = [paths.files.architecture, paths.files.architectureMd];
    reporter.success(
      `Wrote ${written.map((file) => toPosixRelative(paths.root, file)).join(" and ")}.`,
    );
    // A further app's requirements take its folder from its record (the interview).
    if (options.appDir !== undefined && recorded === undefined) {
      await recordAppChoice(deps, architecture.facts.appDir);
    }

    const { facts } = architecture;
    await deps.state.markPhase(
      "analyze",
      "ok",
      `${APP_KIND_LABELS[facts.appKind]}${inFolder(facts)}; ${plural(architecture.risks.length, "risk")}` +
        (architecture.aiEnriched ? "; refined by the Analyst" : ""),
    );
    return {
      architecture,
      markdown,
      costUsd,
      ...(aiSkippedReason !== undefined ? { aiSkippedReason } : {}),
    };
  });
}

/**
 * The app directory chosen earlier: `appDir` in `opscrew/requirements.yaml`, else the one the
 * previous `opscrew/architecture.json` describes (so `opscrew analyze --dir <folder>` sticks until
 * the user picks another app or `--dir .`). Missing or invalid files mean no choice.
 */
async function chosenAppDir(deps: PhaseDeps): Promise<string | undefined> {
  try {
    const fromRequirements = (await readArtifact("requirements", deps.paths.files.requirements))
      .appDir;
    if (fromRequirements !== undefined) return fromRequirements;
  } catch {
    // no requirements yet
  }
  try {
    const previous = (await readArtifact("architecture", deps.paths.files.architecture)).facts
      .appDir;
    return previous !== undefined && previous !== "." ? previous : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An explicit app choice also updates `opscrew/requirements.yaml` when it exists, so design never
 * sees requirements and facts describing different apps.
 */
async function recordAppChoice(deps: PhaseDeps, appDir: string): Promise<void> {
  let requirements: Awaited<ReturnType<typeof readArtifact<"requirements">>>;
  try {
    requirements = await readArtifact("requirements", deps.paths.files.requirements);
  } catch {
    return;
  }
  if ((requirements.appDir ?? ".") === appDir) return;
  const { appDir: _previous, ...rest } = requirements;
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    appDir === "." ? rest : { ...rest, appDir },
  );
  deps.reporter.info("Updated the app to deploy in opscrew/requirements.yaml.");
}

interface Enrichment {
  architecture?: Architecture;
  reason?: string;
  costUsd: number;
}

async function enrich(
  deps: PhaseDeps,
  base: Architecture,
  deterministic: { summary: string; risks: string[] },
  model: string,
  summarizeOptions: { appCandidates: string[] },
): Promise<Enrichment> {
  const { reporter, redactor, runtime } = deps;
  const skip = (reason: string, costUsd = 0): Enrichment => {
    reporter.warn(`Skipped the AI step: ${reason} The deterministic analysis was written instead.`);
    return { reason, costUsd };
  };

  if (runtime === undefined) {
    const reason = "No model is configured for this run.";
    reporter.info(`${reason} Using the deterministic analysis.`);
    return { reason, costUsd: 0 };
  }
  const availability = await runtime.isConfigured();
  if (!availability.ok) {
    const hint = availability.hint !== undefined ? ` ${availability.hint}` : "";
    return skip(redactor.redact(`${availability.reason ?? "The model is not available."}${hint}`));
  }

  reporter.step(`Asking the Analyst (${model}) to review the code (read-only)`);
  let result: PhaseResult<AnalystOutput>;
  try {
    result = await runtime.runPhase<AnalystOutput>({
      phase: "analyze",
      systemPrompt: ANALYST_SYSTEM_PROMPT,
      prompt: redactor.redact(buildAnalystPrompt(base.facts, deterministic)),
      projectRoot: deps.paths.root,
      profile: "read-only",
      builtinTools: ["Read", "Glob", "Grep"],
      output: {
        name: "architecture_summary",
        description: "Plain-English summary, extra deployment risks and corrected facts.",
        schema: AnalystOutputSchema,
      },
      model,
      maxTurns: MAX_TURNS,
      maxBudgetUsd: MAX_BUDGET_USD,
    });
  } catch (error) {
    return skip(redactor.redact(`the Analyst failed (${errorMessage(error)}).`));
  }

  const { costUsd } = result;
  await deps.costs.append({ phase: "analyze", model: result.model ?? model, costUsd });
  reporter.info(
    `The Analyst used ${plural(result.turns, "turn")} and cost $${costUsd.toFixed(4)}.`,
  );

  if (!result.ok || result.output === undefined) {
    const why = result.error ?? `the Analyst stopped early (${result.stopReason}).`;
    return skip(redactor.redact(why), costUsd);
  }
  // Re-validate: never trust the runtime alone with model output.
  const parsed = AnalystOutputSchema.safeParse(result.output);
  if (!parsed.success) {
    return skip("the Analyst's answer did not match the expected format.", costUsd);
  }
  const output = parsed.data;

  const facts = applyCorrections(deps, base.facts, output.corrections);
  const factRisks = summarizeFacts(facts, summarizeOptions).risks;
  const seen = new Set(factRisks.map((r) => r.toLowerCase()));
  const modelRisks: string[] = [];
  for (const raw of output.risks) {
    const risk = oneLine(redactor.redact(raw));
    if (risk === "" || seen.has(risk.toLowerCase())) continue;
    seen.add(risk.toLowerCase());
    modelRisks.push(risk);
  }
  const candidate = ArchitectureSchema.safeParse({
    ...base,
    facts,
    summary: redactor.redact(output.summary.trim()),
    risks: [...factRisks, ...modelRisks],
    aiEnriched: true,
  });
  if (!candidate.success) {
    return skip("the refined architecture did not pass validation.", costUsd);
  }
  reporter.success("The Analyst refined the summary and risks.");
  return { architecture: candidate.data, costUsd };
}

const CORRECTABLE = ["appKind", "port", "startCommand", "healthEndpoint"] as const;

/** Applies the Analyst's corrections to the four correctable fields; invalid results are ignored. */
function applyCorrections(
  deps: PhaseDeps,
  facts: ProjectFacts,
  corrections: AnalystOutput["corrections"],
): ProjectFacts {
  if (corrections === undefined) return facts;
  const next: ProjectFacts = structuredClone(facts);
  const changes: string[] = [];
  if (corrections.appKind !== undefined && corrections.appKind !== facts.appKind) {
    next.appKind = corrections.appKind;
    changes.push(`app kind ${facts.appKind} → ${corrections.appKind}`);
  }
  if (corrections.port !== undefined && corrections.port !== facts.port) {
    next.port = corrections.port;
    changes.push(`port ${facts.port ?? "unknown"} → ${corrections.port}`);
  }
  const startCommand = corrections.startCommand?.trim();
  if (startCommand && startCommand !== facts.build.startCommand) {
    // Secrets only: a registered name (the user's server, for example `nas`) can be a path here.
    next.build.startCommand = deps.redactor.redactSecrets(startCommand);
    changes.push(`start command → \`${next.build.startCommand}\``);
  }
  if (
    corrections.healthEndpoint !== undefined &&
    corrections.healthEndpoint !== facts.healthEndpoint
  ) {
    next.healthEndpoint = corrections.healthEndpoint;
    changes.push(`health endpoint → ${corrections.healthEndpoint}`);
  }
  if (changes.length === 0) return facts;
  const valid = ProjectFactsSchema.safeParse(next);
  if (!valid.success) {
    deps.reporter.warn(
      `Ignored the Analyst's corrections (${CORRECTABLE.join(", ")}) because they were not valid.`,
    );
    return facts;
  }
  deps.reporter.info(`The Analyst corrected: ${changes.join("; ")}.`);
  return valid.data;
}
