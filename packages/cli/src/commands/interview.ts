import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  componentAnswerLines,
  type InterviewAnswers,
  repositoryPrivate,
  runInterview,
} from "@opscrew/agents";
import { OpsCrewError } from "@opscrew/core";
import type { Requirements } from "@opscrew/plan-schema";
import type { Command } from "commander";
import { parse } from "yaml";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf } from "../deps";
import { addAppOption, chooseApp } from "../ui/app";
import { printNextSteps } from "../ui/output";
import {
  checkPortainerCert,
  PORTAINER_CERT_DESCRIPTION,
  portainerInterviewOptions,
} from "../ui/portainer";
import { askQuestions } from "../ui/questions";

interface InterviewFlags {
  /** `--app <key>`: the repository's app. */
  app?: string;
  answers?: string;
  /** `--portainer-cert SHA256:…`: Portainer's certificate fingerprint, trusted without a prompt. */
  portainerCert?: string;
}

/**
 * Reads an answers file (YAML or JSON, keyed by question id; a previous `requirements.yaml` works
 * too). Throws a user-facing error when it cannot be read or is not a mapping.
 */
async function readAnswersFile(file: string): Promise<InterviewAnswers> {
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
    ...(requirements.provider === "own"
      ? ["Server: a server you already have (how to reach it is saved on this computer only)"]
      : []),
    ...(requirements.provider === "portainer"
      ? [
          "Runs in: your existing Portainer (its address and environment are saved on this computer only; the token stays in PORTAINER_API_KEY)",
        ]
      : []),
    `Monthly users: ${requirements.expectedMonthlyUsers}`,
    `Budget: ${budget.amount} ${budget.currency} per month`,
    ...(requirements.region === undefined ? [] : [`Region: ${requirements.region}`]),
    `Uptime: ${requirements.uptime}`,
    `Data criticality: ${requirements.dataCriticality}`,
    `Domain: ${requirements.domain ?? "none yet"}${requirements.domain === undefined ? "" : ` (DNS: ${requirements.dnsProvider})`}`,
    ...componentAnswerLines(requirements),
  ];
}

/** The next step after the interview, by where the app runs; `flag` is the app's `--app`. */
function nextStep(requirements: Requirements, flag: string): string {
  const design = `\`opscrew design${flag}\``;
  switch (requirements.provider) {
    case "own":
      return `run ${design} to check that your server fits the app (it connects to the server and asks you to confirm its host key the first time).`;
    case "portainer":
      return `run ${design} to plan the app's stacks in your Portainer (there is no server price: you already run it).`;
    default:
      return `run ${design} to compare server options and their monthly cost.`;
  }
}

/**
 * `opscrew interview`: asks only the questions that cannot be inferred (previous answers
 * pre-filled) or takes them from `--answers <file>`, and writes `opscrew/requirements.yaml`
 * (FR-106). Without a terminal and without `--answers`, previous answers are reused. For an
 * existing Portainer (FR-1001) it asks for its address, shows its certificate's fingerprint and
 * asks the user to trust it (`--portainer-cert SHA256:…` in scripts; a changed certificate is
 * confirmed the same way), then lists its environments with `PORTAINER_API_KEY`. The signing
 * question says what signing makes public for the repository, as GitHub reports its visibility.
 * `--app` picks the repository's app; a further app's folder comes from its record.
 */
export function register(program: Command, ctx: CliContext): void {
  const command = program
    .command("interview")
    .description("Ask a few questions about traffic, budget and your domain")
    .option("--answers <file>", "Read the answers from a YAML or JSON file instead of asking")
    .option("--portainer-cert <fingerprint>", PORTAINER_CERT_DESCRIPTION);
  addAppOption(command).action(async (flags: InterviewFlags) => {
    const certFingerprint = checkPortainerCert(flags.portainerCert);
    const app = await chooseApp(ctx, flags.app, "interview");
    const deps = createPhaseDeps(ctx, { ai: false, app: app.key });
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
    // The follow-ups for a server the user already has (address, SSH port, user, key, reachable)
    // or an existing Portainer (address, environment, redeploy and web modes) are asked in the
    // terminal too; they are saved on this computer only, never in the repo.
    const isPrivate = await repositoryPrivate(deps);
    const { requirements } = await runInterview(deps, {
      ...(answers === undefined ? {} : { answers }),
      ...(isPrivate === undefined ? {} : { repositoryPrivate: isPrivate }),
      ...(ask === undefined ? {} : { ask, askServer: ask, askPortainer: ask, askComponents: ask }),
      portainer: portainerInterviewOptions(ctx, prompts, certFingerprint),
    });
    ctx.stdout(
      `\n${describe(requirements)
        .map((line) => `  ${line}`)
        .join("\n")}\n`,
    );
    printNextSteps(ctx, [nextStep(requirements, app.flag)]);
  });
}
