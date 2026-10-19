/**
 * The interview's questions about the app's components (FR-1303, FR-1315): for each hosted
 * service, keep it or let OpsCrew run one, with what running it on the server would add; and a
 * worker's command when no convention gives it.
 */
import type { ComputeCatalog } from "@opscrew/contracts";
import { formatMoney, isRecord, listText, OpsCrewError } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import {
  type DesignOption,
  type ProjectFacts,
  type Question,
  type Requirements,
  RequirementsSchema,
  type ServiceKind,
  ServiceKindSchema,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  type HostedChoice,
  hostedChoices,
  workerName,
  workersWithoutCommand,
} from "../design/components";
import { priceLabel } from "../design/cost";
import { buildDesignOptions } from "../design/options";
import { vpsConnector } from "../providers";
import {
  booleanAnswer,
  FIX_ANSWERS_HINT,
  isBlank,
  splitFollowUps,
  withDefault,
} from "./follow-ups";
import type { InterviewAnswers } from "./questions";

/** The prefix of the answers keeping a hosted service: `keepExternalServices.<kind>`. */
const KEEP = "keepExternalServices";
/** The prefix of the answers giving a worker's command: `workerCommands.<worker>`. */
const WORKERS = "workerCommands";

/** A follow-up question about a component (same shape as a {@link Question}). */
export interface ComponentQuestion extends Omit<Question, "id"> {
  id: `${typeof KEEP}.${string}` | `${typeof WORKERS}.${string}`;
}

/** The component answers, split from the rest. */
export interface ComponentAnswers {
  /** Whether to keep each hosted service, by kind. */
  keep: Partial<Record<string, unknown>>;
  /** Each worker's command, by its name in the plan. */
  workers: Partial<Record<string, unknown>>;
  /** Answer ids under the prefixes that are not one of this app's. */
  unknown: string[];
  rest: InterviewAnswers;
}

/**
 * Takes the component answers out of `answers`: `keepExternalServices.<kind>` (any kind: `s3`
 * keeps the app's own storage) and `workerCommands.<worker>`, flat (answers files, the MCP tool)
 * or as nested mappings. A plain `keepExternalServices` answer (yes or no for every hosted
 * service, or a list of kinds to keep) stays an answer of its own.
 */
export function splitComponentAnswers(
  answers: InterviewAnswers,
  facts: ProjectFacts,
): ComponentAnswers {
  const list = Object.hasOwn(answers, KEEP) && !isRecord(answers[KEEP]);
  const { [KEEP]: kept, ...withoutList } = answers;
  const keep = splitFollowUps(list ? withoutList : answers, KEEP, ServiceKindSchema.options);
  const workers = splitFollowUps(keep.rest, WORKERS, workersWithoutCommand(facts));
  return {
    keep: keep.values,
    workers: workers.values,
    unknown: [...keep.unknown, ...workers.unknown],
    rest: list ? { ...workers.rest, [KEEP]: kept } : workers.rest,
  };
}

/** True when any component answer was given. */
export function hasComponentAnswers(split: ComponentAnswers): boolean {
  return (
    split.unknown.length > 0 ||
    Object.keys(split.keep).length > 0 ||
    Object.keys(split.workers).length > 0
  );
}

/**
 * The requirements with the component answers applied: each hosted service kept or not
 * (`keepExternalServices`, in schema order), and each worker's command (`workerCommands`; an
 * empty answer removes it).
 * @throws OpsCrewError `INVALID_INPUT` naming each unknown or invalid answer.
 */
export function applyComponentAnswers(
  requirements: Requirements,
  split: ComponentAnswers,
): Requirements {
  const problems = split.unknown.map(
    (key) => `${key}: not a question for this app (answer the ones opscrew interview lists)`,
  );
  const { workerCommands, ...rest } = requirements;
  const keep: Requirements["keepExternalServices"] = { ...rest.keepExternalServices };
  for (const [kind, value] of Object.entries(split.keep)) {
    if (isBlank(value)) continue;
    const answer = booleanAnswer(value);
    if (answer === undefined) problems.push(`${KEEP}.${kind}: answer yes or no`);
    else keep[kind as ServiceKind] = answer;
  }
  const commands = { ...workerCommands };
  for (const [name, value] of Object.entries(split.workers)) {
    if (isBlank(value)) delete commands[name];
    else if (typeof value === "string") commands[name] = value.trim();
    else problems.push(`${WORKERS}.${name}: write the command as text`);
  }
  const parsed = RequirementsSchema.safeParse({
    ...rest,
    keepExternalServices: inSchemaOrder(keep),
    ...(Object.keys(commands).length > 0 ? { workerCommands: commands } : {}),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join(".")}: ${issue.message}`);
    }
  }
  if (problems.length > 0 || !parsed.success) {
    throw new OpsCrewError("INVALID_INPUT", `Some answers are not valid: ${problems.join("; ")}.`, {
      hint: FIX_ANSWERS_HINT,
    });
  }
  return parsed.data;
}

/**
 * The kinds the requirements answer `keep` for: with `true` the services kept where they are
 * hosted, with `false` the ones OpsCrew runs on the server instead.
 */
export function answeredKinds(requirements: Requirements, keep: boolean): ServiceKind[] {
  return ServiceKindSchema.options.filter(
    (kind) => requirements.keepExternalServices[kind] === keep,
  );
}

/** The keep answers in schema order, so requirements.yaml lists them the same way each time. */
export function inSchemaOrder(
  keep: Requirements["keepExternalServices"],
): Requirements["keepExternalServices"] {
  return Object.fromEntries(
    ServiceKindSchema.options.flatMap((kind) => (kind in keep ? [[kind, keep[kind]]] : [])),
  );
}

/** The cheapest option for `requirements`, or undefined when no server fits. */
async function cheapest(
  facts: ProjectFacts,
  requirements: Requirements,
  catalog: ComputeCatalog,
): Promise<DesignOption | undefined> {
  try {
    const options = await buildDesignOptions({ facts, requirements, catalog });
    return [...options].sort((a, b) => a.cost.monthly.amount - b.cost.monthly.amount)[0];
  } catch {
    return undefined;
  }
}

/**
 * What running each hosted service on the server would add besides its container's memory
 * (FR-1315), by kind, to end the question's sentence: on a cloud server whether the cheapest
 * server for the app grows, with its published price; on a server the user owns, that it must
 * have room. OpsCrew cannot see the hosted service's own bill, so it shows no difference.
 */
export async function hostedAdditions(
  deps: Pick<PhaseDeps, "fetch" | "redactor" | "version">,
  facts: ProjectFacts,
  requirements: Requirements,
): Promise<Map<ServiceKind, string>> {
  const additions = new Map<ServiceKind, string>();
  const choices = hostedChoices(facts);
  if (choices.length === 0) return additions;
  const { provider } = requirements;
  if (provider === "own" || provider === "portainer") {
    const where = provider === "portainer" ? "your Portainer host" : "your server";
    for (const choice of choices) additions.set(choice.kind, `, which ${where} must have room for`);
    return additions;
  }
  const catalog = vpsConnector(provider, {
    env: {},
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  }).catalog();
  const answers = requirements.keepExternalServices;
  for (const choice of choices) {
    const [before, after] = await Promise.all(
      [true, false].map((keep) =>
        cheapest(
          facts,
          { ...requirements, keepExternalServices: { ...answers, [choice.kind]: keep } },
          catalog,
        ),
      ),
    );
    if (before === undefined || after === undefined) continue;
    const price = (option: DesignOption) =>
      `${option.target.serverType} at ${formatMoney(option.cost.monthly)}/month`;
    const label = priceLabel(after.cost);
    additions.set(
      choice.kind,
      after.cost.monthly.amount > before.cost.monthly.amount
        ? `, which needs a bigger server: ${price(after)} instead of ${price(before)} (${label})`
        : `, and the app still fits the ${price(before)} (${label})`,
    );
  }
  return additions;
}

/** One question about a hosted service: kept unless answered otherwise. */
function hostedQuestion(
  choice: HostedChoice,
  defaults: Pick<Requirements, "keepExternalServices">,
  addition: string | undefined,
): ComponentQuestion {
  const spec = serviceSpec(choice.runs);
  // Valkey runs for an app on Redis.
  const title = choice.kind === "redis" ? "Redis" : spec.title;
  const instead = choice.kind === "redis" ? "Valkey, Redis's open-source fork," : spec.title;
  const providers = listText(choice.providers);
  const adds = `Running ${spec.title} on your server adds a container with ${spec.memory.defaultMb} MB of memory${addition ?? ""}.`;
  const after = `${adds} OpsCrew cannot see what ${providers} charges you, so it shows no difference.`;
  const supabase = choice.kind === "supabase";
  return {
    id: `${KEEP}.${choice.kind}`,
    prompt: supabase
      ? "Keep using your hosted Supabase project?"
      : `Keep using ${providers} for ${title}?`,
    help: supabase
      ? `Yes (recommended) keeps the database and sign-in on Supabase. No runs PostgreSQL on your own server, and you move the data and replace Supabase features yourself. ${after}`
      : `Yes (recommended) keeps the app on ${providers} (${listText(choice.variables)}). No runs ${instead} on your server instead, and you move the data yourself. ${after}`,
    kind: "confirm",
    default: defaults.keepExternalServices[choice.kind] ?? true,
    required: false,
  };
}

/**
 * The component questions for a project: one per hosted service (keep it, or let OpsCrew run
 * one, with `additions` from {@link hostedAdditions}), and one per worker no convention gives a
 * command (BullMQ, asynq, river). Defaults come from `defaults` (the answers so far).
 */
export function buildComponentQuestions(
  facts: ProjectFacts,
  defaults: Pick<Requirements, "keepExternalServices" | "workerCommands">,
  additions: ReadonlyMap<ServiceKind, string> = new Map(),
): ComponentQuestion[] {
  const questions: ComponentQuestion[] = hostedChoices(facts).map((choice) =>
    hostedQuestion(choice, defaults, additions.get(choice.kind)),
  );
  for (const worker of facts.workers ?? []) {
    if (worker.command !== undefined) continue;
    const name = workerName(worker.name);
    questions.push({
      id: `${WORKERS}.${name}`,
      prompt: `Which command starts the worker ${name}?`,
      help: `OpsCrew found ${worker.evidence.join(", ")}, but no convention gives the command that starts its worker, for example node dist/worker.js. It runs in the app's image, with the app's settings. Leave it empty to add the worker to processes.workers in opscrew/plan.yaml later.`,
      kind: "text",
      ...withDefault(defaults.workerCommands?.[name]),
      required: false,
    });
  }
  return questions;
}
