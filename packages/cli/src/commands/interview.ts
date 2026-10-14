import { readFile } from "node:fs/promises";
import path from "node:path";
import { type InterviewAnswers, runInterview } from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { Requirements } from "@opscrew/plan-schema";
import type { Command } from "commander";
import { parse } from "yaml";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf } from "../deps";
import { printNextSteps } from "../ui/output";
import { askQuestions } from "../ui/questions";

interface InterviewFlags {
  answers?: string;
}

/**
 * Reads an answers file (YAML or JSON, keyed by question id; a previous `requirements.yaml` works
 * too). Throws a user-facing error when it cannot be read or is not a mapping.
 */
export async function readAnswersFile(file: string): Promise<InterviewAnswers> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new OpsCrewError("INVALID_INPUT", `Could not read the answers file ${file}.`, {
      hint: "Check the path passed to --answers.",
    });
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    throw new OpsCrewError("INVALID_INPUT", `The answers file ${file} is not valid YAML or JSON.`, {
      hint: "Write one answer per line, for example `expectedMonthlyUsers: <1k`.",
    });
  }
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The answers file ${file} must map question names to answers.`,
      { hint: "Write one answer per line, for example `region: eu-central`." },
    );
  }
  return value as InterviewAnswers;
}

function describe(requirements: Requirements): string[] {
  const budget = requirements.budgetMonthly;
  return [
    `Monthly users: ${requirements.expectedMonthlyUsers}`,
    `Budget: ${budget.amount} ${budget.currency} per month`,
    ...(requirements.region === undefined ? [] : [`Region: ${requirements.region}`]),
    `Uptime: ${requirements.uptime}`,
    `Data criticality: ${requirements.dataCriticality}`,
    `Domain: ${requirements.domain ?? "none yet"}${requirements.domain === undefined ? "" : ` (DNS: ${requirements.dnsProvider})`}`,
    ...(requirements.keepExternalServices.length > 0
      ? [`Keep using: ${requirements.keepExternalServices.join(", ")}`]
      : []),
  ];
}

/**
 * `opscrew interview`: asks only the questions that cannot be inferred (previous answers
 * pre-filled) or takes them from `--answers <file>`, and writes `opscrew/requirements.yaml`
 * (FR-106). Without a terminal and without `--answers`, previous answers are reused.
 */
export function register(program: Command, ctx: CliContext): void {
  program
    .command("interview")
    .description("Ask a few questions about traffic, budget and your domain")
    .option("--answers <file>", "Read the answers from a YAML or JSON file instead of asking")
    .action(async (flags: InterviewFlags) => {
      const deps = createPhaseDeps(ctx, { ai: false });
      let answers: InterviewAnswers | undefined;
      if (flags.answers !== undefined) {
        answers = await readAnswersFile(path.resolve(ctx.cwd, flags.answers));
      }
      const prompts = promptsOf(ctx);
      const ask =
        answers === undefined && ctx.isInteractive
          ? (questions: Parameters<typeof askQuestions>[0]) => askQuestions(questions, { prompts })
          : undefined;
      if (answers === undefined && ask === undefined) {
        ctx.reporter.info(
          "This terminal cannot ask questions, so OpsCrew uses your previous answers, if there are any. Pass --answers <file> to give new ones.",
        );
      }
      const { requirements } = await runInterview(deps, {
        ...(answers === undefined ? {} : { answers }),
        ...(ask === undefined ? {} : { ask }),
      });
      ctx.stdout(
        `\n${describe(requirements)
          .map((line) => `  ${line}`)
          .join("\n")}\n`,
      );
      printNextSteps(ctx, [
        "run `opscrew design` to compare server options and their monthly cost.",
      ]);
    });
}
