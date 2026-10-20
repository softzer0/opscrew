/**
 * The interview's questions about the app's components (FR-1303, FR-1315): for each hosted
 * service, keep it or let OpsCrew run one, with what running it on the server would add; and a
 * worker's command when no convention gives it.
 */
import type { ComputeCatalog } from "@opscrew/contracts";
import { formatMoney, isRecord, listText, OpsCrewError } from "@opscrew/core";
import { STORAGE_NAMES, serviceSpec } from "@opscrew/iac-templates";
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
import {
  defaultStorageOffer,
  expectedStorageUse,
  type StorageOffer,
  storageOffers,
  storageOfferText,
  storagePrice,
} from "../design/storage";
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
/** The answer choosing where OpsCrew creates the app's bucket. */
const STORAGE = "objectStorage";

/** A follow-up question about a component (same shape as a {@link Question}). */
export interface ComponentQuestion extends Omit<Question, "id"> {
  id: `${typeof KEEP}.${string}` | `${typeof WORKERS}.${string}` | typeof STORAGE;
}

/** The component answers, split from the rest. */
export interface ComponentAnswers {
  /** Whether to keep each hosted service, by kind. */
  keep: Partial<Record<string, unknown>>;
  /** Each worker's command, by its name in the plan. */
  workers: Partial<Record<string, unknown>>;
  /** Where OpsCrew creates the app's bucket (`objectStorage`), present only when answered. */
  objectStorage?: unknown;
  /** Answer ids under the prefixes that are not one of this app's. */
  unknown: string[];
  rest: InterviewAnswers;
}

/**
 * Takes the component answers out of `answers`: `keepExternalServices.<kind>` (any kind: `s3`
 * keeps the app's own storage) and `workerCommands.<worker>`, flat (answers files, the MCP tool)
 * or as nested mappings, and `objectStorage`. A plain `keepExternalServices` answer (yes or no for
 * every hosted service, or a list of kinds to keep) stays an answer of its own.
 */
export function splitComponentAnswers(
  answers: InterviewAnswers,
  facts: ProjectFacts,
): ComponentAnswers {
  const { [STORAGE]: storage, ...others } = answers;
  const list = Object.hasOwn(others, KEEP) && !isRecord(others[KEEP]);
  const { [KEEP]: kept, ...withoutList } = others;
  const keep = splitFollowUps(list ? withoutList : others, KEEP, ServiceKindSchema.options);
  const workers = splitFollowUps(keep.rest, WORKERS, workersWithoutCommand(facts));
  return {
    keep: keep.values,
    workers: workers.values,
    ...(Object.hasOwn(answers, STORAGE) ? { objectStorage: storage } : {}),
    unknown: [...keep.unknown, ...workers.unknown],
    rest: list ? { ...workers.rest, [KEEP]: kept } : workers.rest,
  };
}

/** True when any component answer was given. */
export function hasComponentAnswers(split: ComponentAnswers): boolean {
  return (
    split.unknown.length > 0 ||
    Object.keys(split.keep).length > 0 ||
    Object.keys(split.workers).length > 0 ||
    Object.hasOwn(split, STORAGE)
  );
}

/**
 * The requirements with the component answers applied: each hosted service kept or not
 * (`keepExternalServices`, in schema order), each worker's command (`workerCommands`; an empty
 * answer removes it), and where OpsCrew creates the bucket (`objectStorage`, one of the offers
 * where the app runs; kept only while `keepExternalServices.s3` is `false`).
 * @throws OpsCrewError `INVALID_INPUT` naming each unknown or invalid answer.
 */
export function applyComponentAnswers(
  requirements: Requirements,
  split: ComponentAnswers,
): Requirements {
  const problems = split.unknown.map(
    (key) => `${key}: not a question for this app (answer the ones opscrew interview lists)`,
  );
  const { workerCommands, objectStorage: earlierStorage, ...rest } = requirements;
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
  const offered: string[] = offersFor(requirements).map((offer) => offer.provider);
  // An earlier choice carries over only where the app runs now offers it.
  let storage: string | undefined =
    earlierStorage !== undefined && offered.includes(earlierStorage) ? earlierStorage : undefined;
  if (Object.hasOwn(split, STORAGE)) {
    const value = split.objectStorage;
    const choice = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    if (isBlank(value)) storage = undefined;
    else if (choice !== undefined && offered.includes(choice)) storage = choice;
    else {
      problems.push(
        `${STORAGE}: ${JSON.stringify(value)?.slice(0, 40)} is not offered where the app runs (choose one of ${offered.join(", ")})`,
      );
    }
  }
  const parsed = RequirementsSchema.safeParse({
    ...rest,
    keepExternalServices: inSchemaOrder(keep),
    ...(Object.keys(commands).length > 0 ? { workerCommands: commands } : {}),
    // Only a bucket OpsCrew creates needs a place.
    ...(storage !== undefined && keep.s3 === false ? { objectStorage: storage } : {}),
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
 * hosted, with `false` the ones OpsCrew runs on the server instead (`s3` aside: see
 * {@link storageAnswerText}).
 */
export function answeredKinds(requirements: Requirements, keep: boolean): ServiceKind[] {
  return ServiceKindSchema.options.filter(
    (kind) => requirements.keepExternalServices[kind] === keep && (keep || kind !== "s3"),
  );
}

/**
 * What the requirements say about the app's files when OpsCrew creates the bucket
 * (`keepExternalServices.s3: false`): `a new bucket in Garage on your server`; else undefined.
 */
export function storageAnswerText(requirements: Requirements): string | undefined {
  if (requirements.keepExternalServices.s3 !== false) return undefined;
  const storage = requirements.objectStorage;
  return storage === undefined
    ? "a new bucket, at the storage design picks"
    : `a new bucket in ${STORAGE_NAMES[storage]}`;
}

/**
 * The requirements' answers about the app's components, one summary line each, as `opscrew
 * interview` and the MCP server show them: the services kept where they are hosted, the ones
 * OpsCrew runs on the server, and the new bucket ({@link storageAnswerText}).
 */
export function componentAnswerLines(requirements: Requirements): string[] {
  const kept = answeredKinds(requirements, true);
  const run = answeredKinds(requirements, false);
  const storage = storageAnswerText(requirements);
  return [
    ...(kept.length > 0 ? [`Keep where hosted: ${kept.join(", ")}`] : []),
    ...(run.length > 0 ? [`Run on the server: ${run.join(", ")}`] : []),
    ...(storage === undefined ? [] : [`Object storage: ${storage}`]),
  ];
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
  // Valkey runs for an app on Redis, unless its client needs Redis 8 or its Compose file runs
  // Dragonfly.
  const title = choice.kind === "redis" ? "Redis" : spec.title;
  const instead = choice.runs === "valkey" ? "Valkey, Redis's open-source fork," : spec.title;
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

/** The object storage offered where the app runs, priced for its expected use. */
function offersFor(requirements: Requirements): StorageOffer[] {
  return storageOffers(requirements, expectedStorageUse(requirements.expectedMonthlyUsers));
}

/** Where each storage is offered, for questions asked before the target is known. */
const OFFERED_WHERE: Readonly<Record<StorageOffer["provider"], string>> = {
  garage: "on the app's server: on a cloud server only if you choose it",
  hetzner: "on Hetzner Cloud in Falkenstein, Nuremberg or Helsinki",
  digitalocean: "on DigitalOcean",
  r2: "with the domain on Cloudflare",
};

/**
 * For an app with an S3 client (FR-1316a): keep the storage it uses now (the default, named when
 * its endpoint is at a known host), or let OpsCrew create a bucket; and where, with each offer's
 * price for where the app runs, or every storage with where it is offered when `defaults` has no
 * target (before it is known, or when the same answers may change it). Garage on a cloud server
 * is listed, never the default.
 */
function storageQuestions(
  facts: ProjectFacts,
  defaults:
    | Requirements
    | Pick<Requirements, "keepExternalServices" | "workerCommands" | "objectStorage">,
): ComponentQuestion[] {
  const found = facts.objectStorage;
  if (found === undefined) return [];
  const hosted = (facts.hostedServices ?? []).filter((h) => h.kind === "s3");
  const hosts = listText([...new Set(hosted.map((h) => h.provider))]);
  const variables = listText(hosted.map((h) => h.variable));
  const where = hosted.length > 0 ? ` at ${hosts} (${variables})` : "";
  const keep: ComponentQuestion = {
    id: `${KEEP}.s3`,
    prompt:
      hosted.length > 0
        ? `Keep storing the app's files at ${hosts}?`
        : "Keep the storage the app uses now for its files?",
    help: `The app stores files through S3 (${found.client})${where}. Yes keeps that storage: OpsCrew creates no bucket, and you set its address and keys in the app's production environment. No lets OpsCrew create a private bucket for the app, at the storage you choose next${hosted.length > 0 ? ", and you move the files yourself" : ""}.`,
    kind: "confirm",
    default: defaults.keepExternalServices.s3 ?? true,
    required: false,
  };
  const known = "provider" in defaults;
  const expected = expectedStorageUse(known ? defaults.expectedMonthlyUsers : "<1k");
  const offers: StorageOffer[] = known
    ? storageOffers(defaults, expected)
    : (Object.keys(OFFERED_WHERE) as StorageOffer["provider"][]).map((provider) => ({
        provider,
        region: provider,
        price: storagePrice(provider, expected),
      }));
  const earlier = offers.find((offer) => offer.provider === defaults.objectStorage);
  const chosen = known ? (earlier ?? defaultStorageOffer(offers)) : earlier;
  const choose: ComponentQuestion = {
    id: STORAGE,
    prompt: "If OpsCrew creates the bucket, which storage should it use?",
    help: `Priced for ${expected.storageGb} GB stored and ${expected.egressGbPerMonth} GB sent a month, from the number of users (storage.objectStorage.expected in opscrew/plan.yaml changes it later). Used only when you let OpsCrew create a bucket.`,
    kind: "single-select",
    options: offers.map((offer) => ({
      value: offer.provider,
      label: storageOfferText(offer),
      ...(known
        ? offer.optIn
          ? { hint: "only if you choose it" }
          : {}
        : { hint: OFFERED_WHERE[offer.provider] }),
    })),
    ...(chosen === undefined ? {} : { default: chosen.provider }),
    required: false,
  };
  return [keep, choose];
}

/**
 * The component questions for a project: one per hosted service (keep it, or let OpsCrew run
 * one, with `additions` from {@link hostedAdditions}), the object storage questions for an app
 * with an S3 client, and one per worker no convention gives a command (BullMQ, asynq, river).
 * Defaults come from `defaults`: the answers so far with their target, or only some of them
 * without one (then the storage choices are every storage, with where each is offered).
 */
export function buildComponentQuestions(
  facts: ProjectFacts,
  defaults:
    | Requirements
    | Pick<Requirements, "keepExternalServices" | "workerCommands" | "objectStorage">,
  additions: ReadonlyMap<ServiceKind, string> = new Map(),
): ComponentQuestion[] {
  const questions: ComponentQuestion[] = hostedChoices(facts).map((choice) =>
    hostedQuestion(choice, defaults, additions.get(choice.kind)),
  );
  questions.push(...storageQuestions(facts, defaults));
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
