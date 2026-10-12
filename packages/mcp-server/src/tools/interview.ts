import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  buildQuestions,
  inferredAnswers,
  providerFromTokens,
  providerProfile,
  requestedProvider,
  runInterview,
} from "@opscrew/agents";
import type { ProjectPaths } from "@opscrew/core";
import { detectProject, detectProjectDetails } from "@opscrew/detect";
import {
  type ProjectFacts,
  type Question,
  QuestionIdSchema,
  type Requirements,
  readArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { isMissingArtifact, projectDirInput, relativeTo, runTool, withHint } from "./shared";

/** Facts from `opscrew/architecture.json` when it is valid, otherwise fresh detection. */
export async function loadFacts(
  paths: ProjectPaths,
): Promise<{ facts: ProjectFacts; source: "architecture" | "detected" }> {
  try {
    return {
      facts: (await readArtifact("architecture", paths.files.architecture)).facts,
      source: "architecture",
    };
  } catch {
    return { facts: await detectProject(paths.root), source: "detected" };
  }
}

/** Previous requirements when `opscrew/requirements.yaml` exists and is valid. */
async function loadPrevious(paths: ProjectPaths): Promise<Requirements | undefined> {
  try {
    return await readArtifact("requirements", paths.files.requirements);
  } catch {
    return undefined;
  }
}

function formatDefault(value: Question["default"]): string {
  if (value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value))
    return `${value.amount} ${value.currency}`;
  return Array.isArray(value) ? value.join(", ") : String(value);
}

/** One question as plain text: prompt, help, choices and default. */
function renderQuestion(question: Question, index: number): string {
  const lines = [`${index + 1}. ${question.prompt} (answer id: ${question.id})`];
  if (question.help) lines.push(`   ${question.help}`);
  if (question.options && question.options.length > 0) {
    lines.push(
      `   Choices: ${question.options.map((o) => `${o.value} = ${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("; ")}`,
    );
  }
  if (question.default !== undefined) lines.push(`   Default: ${formatDefault(question.default)}`);
  if (!question.required) lines.push("   Optional.");
  return lines.join("\n");
}

/** Loose value schema for one answer; `answersToRequirements` does the real validation. */
const AnswerValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.object({ amount: z.union([z.number(), z.string()]), currency: z.string().optional() }),
  z.null(),
]);

const ANSWER_HELP: Record<string, string> = {
  provider:
    'Cloud provider for the server: "hetzner" (Hetzner Cloud) or "digitalocean" (DigitalOcean).',
  expectedMonthlyUsers: "One of <1k, 1k-10k, 10k-100k, >100k.",
  budgetMonthly:
    'Monthly hosting budget, for example "10 EUR", "$20" or { amount: 10, currency: "EUR" }.',
  region: "Where most users are, for example eu-central.",
  uptime: "Acceptable downtime (a choice value from the question).",
  dataCriticality: "How bad losing data would be (a choice value from the question).",
  domain: "Domain name, for example app.example.com.",
  dnsProvider: "DNS provider (a choice value from the question).",
  keepExternalServices: 'External services to keep, for example ["supabase"].',
  contactEmail: "Contact email for certificates and alerts.",
  notes: "Anything else the user wants to note.",
};

const answersShape = Object.fromEntries(
  QuestionIdSchema.options.map((id) => [
    id,
    AnswerValueSchema.optional().describe(ANSWER_HELP[id] ?? `Answer for ${id}.`),
  ]),
);

/**
 * `opscrew_interview_questions` (read-only) and `opscrew_save_requirements` (writes
 * `opscrew/requirements.yaml`): the deterministic interview in two steps, so the user's own agent
 * asks the questions.
 */
export function registerInterviewTools(server: McpServer, deps: ResolvedMcpDeps): void {
  server.registerTool(
    "opscrew_interview_questions",
    {
      title: "Interview questions",
      description:
        "List the deployment questions OpsCrew needs answered for this project (which app to deploy when the repository has several, the cloud provider (Hetzner Cloud or DigitalOcean), expected users, monthly budget, region, acceptable downtime, data criticality, domain, DNS, external services). Questions that can be inferred from the code are left out; previous answers are pre-filled as defaults. Ask the user each question, then call opscrew_save_requirements with the answers keyed by answer id. Writes nothing.",
      inputSchema: { ...projectDirInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir }) =>
      runTool(deps, "opscrew_interview_questions", projectDir, async (call) => {
        const { paths } = await call.phaseDeps();
        const { facts, source } = await loadFacts(paths);
        const previous = await loadPrevious(paths);
        // In a repository with several apps, the first question is which one to deploy.
        const { appCandidates } = await detectProjectDetails(paths.root);
        // The provider default follows the token that is set, as in `opscrew init`/`interview`.
        const inferredProvider = providerFromTokens(deps.env);
        const context = inferredProvider !== undefined ? { inferredProvider } : {};
        const questions = buildQuestions(facts, previous, appCandidates, context);
        const inferred = inferredAnswers(facts, context);
        const text = [
          `Ask the user these ${questions.length} question${questions.length === 1 ? "" : "s"}, then call opscrew_save_requirements with the answers keyed by answer id.`,
          ...(previous !== undefined
            ? ["Previous answers from opscrew/requirements.yaml are shown as defaults."]
            : []),
          "",
          ...questions.map(renderQuestion),
        ].join("\n");
        return {
          text,
          data: {
            questions,
            inferred,
            prefilled: previous !== undefined,
            factsSource: source,
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_save_requirements",
    {
      title: "Save the deployment requirements",
      description:
        "Validate the user's interview answers and write opscrew/requirements.yaml. Pass the answers keyed by the answer ids returned by opscrew_interview_questions. Answers that are not given fall back to the previous requirements, then to values inferred from the code. Returns the saved requirements, or which answers are missing or invalid.",
      inputSchema: {
        ...projectDirInput,
        answers: z
          .looseObject(answersShape)
          .describe(
            "Answers keyed by answer id (the question ids from opscrew_interview_questions).",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ projectDir, answers }) =>
      runTool(deps, "opscrew_save_requirements", projectDir, async (call) => {
        const phase = await call.phaseDeps();
        let result: Awaited<ReturnType<typeof runInterview>>;
        try {
          result = await runInterview(phase, { answers: answers as Record<string, unknown> });
        } catch (error) {
          if (isMissingArtifact(error)) throw error;
          withHint(
            error,
            "Ask the user for the missing or invalid answers and call opscrew_save_requirements again.",
          );
        }
        const { requirements } = result;
        const file = relativeTo(phase.paths.root, phase.paths.files.requirements);
        const budget = requirements.budgetMonthly;
        const text = [
          `Saved ${file}.`,
          `- Cloud provider: ${providerProfile(requestedProvider(requirements)).displayName}`,
          `- Expected monthly users: ${requirements.expectedMonthlyUsers}`,
          `- Budget: ${budget.amount} ${budget.currency} per month`,
          `- Region: ${requirements.region}`,
          `- Acceptable downtime: ${requirements.uptime}`,
          `- Data criticality: ${requirements.dataCriticality}`,
          ...(requirements.domain !== undefined
            ? [`- Domain: ${requirements.domain} (DNS: ${requirements.dnsProvider})`]
            : ["- Domain: none yet"]),
          ...(requirements.keepExternalServices.length > 0
            ? [`- Keep external services: ${requirements.keepExternalServices.join(", ")}`]
            : []),
          "",
          "Next: call opscrew_design_options to see deployment options with monthly costs.",
        ].join("\n");
        return { text, data: { requirements, file } };
      }),
  );
}
