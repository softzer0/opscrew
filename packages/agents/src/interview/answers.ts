import { OpsCrewError } from "@opscrew/core";
import { normalizeAppDir } from "@opscrew/detect";
import {
  type Money,
  type ProjectFacts,
  type QuestionId,
  QuestionIdSchema,
  type Requirements,
  RequirementsSchema,
} from "@opscrew/plan-schema";
import { deepDomainProblem } from "../shared";
import { isBlank } from "./follow-ups";
import {
  defaultProvider,
  describesRoot,
  type InterviewAnswers,
  type InterviewContext,
  inferredAnswers,
} from "./questions";

/** Options for {@link answersToRequirements}. */
export interface AnswersToRequirementsOptions extends InterviewContext {
  /** Time written to `answeredAt`. */
  now: Date;
  /** Previous requirements; their values fill answers that were not given. */
  previous?: Requirements;
  /** Project facts; used to infer answers for questions that were not asked. */
  facts?: ProjectFacts;
  /**
   * Deployable app directories when the facts describe a repository root with several apps. With
   * more than one, `appDir` is required and must be one of them.
   */
  appCandidates?: readonly string[];
}

/** Requirements fields that must have an answer (from the answers, previous run or inference). */
const REQUIRED: readonly QuestionId[] = [
  "expectedMonthlyUsers",
  "budgetMonthly",
  "provider",
  "region",
  "uptime",
  "dataCriticality",
];

const DESCRIPTIONS: Record<QuestionId, string> = {
  expectedMonthlyUsers: "expected monthly users",
  budgetMonthly: "monthly hosting budget",
  provider: "cloud provider",
  region: "where most users are",
  uptime: "acceptable downtime",
  dataCriticality: "how bad losing data would be",
  domain: "domain",
  dnsProvider: "DNS provider",
  keepExternalServices: "external services to keep",
  contactEmail: "contact email",
  notes: "notes",
  appDir: "app to deploy",
};

/** Fields whose values are lower-cased enum strings. */
const ENUM_FIELDS: ReadonlySet<QuestionId> = new Set([
  "expectedMonthlyUsers",
  "provider",
  "region",
  "uptime",
  "dataCriticality",
  "dnsProvider",
]);

/** Keys of a requirements file that are not answers; accepted and ignored. */
const IGNORED_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "answeredAt"]);

const QUESTION_IDS: readonly QuestionId[] = QuestionIdSchema.options;

/**
 * Normalises a domain answer: trims, lower-cases and removes a scheme (`https://`), any path,
 * query or port, and trailing dots. `https://App.Example.com/` → `app.example.com`.
 */
export function normaliseDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.+$/, "");
}

const MONEY_TEXT =
  /^(€|\$|eur|usd)?\s*(\d+(?:[.,]\d{1,2})?)\s*(€|\$|eur|usd)?\s*(?:(?:\/|per\s+|a\s+)\s*mo(?:nth)?)?$/i;

function currencyOf(symbol: string | undefined): Money["currency"] | undefined {
  if (symbol === undefined) return undefined;
  const s = symbol.toLowerCase();
  return s === "$" || s === "usd" ? "USD" : "EUR";
}

/**
 * Parses a budget answer: `{ amount, currency }`, a number (EUR) or text such as `10`, `10 EUR`,
 * `€10`, `$20/month`. Returns `undefined` when the answer is not a recognisable amount.
 */
export function parseMoney(value: unknown): Money | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? { amount: value, currency: "EUR" } : undefined;
  }
  if (typeof value === "string") {
    const match = MONEY_TEXT.exec(value.trim());
    if (!match) return undefined;
    const [, before, amount, after] = match;
    if (before !== undefined && after !== undefined) return undefined;
    return {
      amount: Number((amount ?? "").replace(",", ".")),
      currency: currencyOf(before ?? after) ?? "EUR",
    };
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const amount = typeof record.amount === "string" ? Number(record.amount.trim()) : record.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
    const currency =
      record.currency === undefined
        ? "EUR"
        : typeof record.currency === "string"
          ? record.currency.trim().toUpperCase()
          : record.currency;
    if (currency !== "EUR" && currency !== "USD") return undefined;
    return { amount, currency };
  }
  return undefined;
}

function serviceList(value: unknown): unknown {
  if (typeof value === "boolean") return value ? ["supabase"] : [];
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== "");
  }
  if (Array.isArray(value)) {
    return [...new Set(value.map((s) => (typeof s === "string" ? s.trim().toLowerCase() : s)))];
  }
  return value;
}

/**
 * Turns interview answers into validated requirements. Answers that were not given fall back to
 * the previous requirements, then to answers inferred from `facts`. The domain is normalised; without
 * a domain the DNS provider is `none`. The app folder (`appDir`) is normalised and, when
 * `appCandidates` is given, must be one of them; without an answer it comes from facts that
 * describe a chosen app folder, then from the previous requirements. For a server the user already
 * has (`provider: own`) or an existing Portainer (`provider: portainer`) no region is needed and
 * none is recorded; their follow-up answers (`server.*`, `portainer.*`) are not requirements (see
 * `splitFollowUps`). Throws
 * `OpsCrewError("INVALID_INPUT")` listing unknown keys, missing required answers or invalid values.
 */
export function answersToRequirements(
  answers: InterviewAnswers,
  options: AnswersToRequirementsOptions,
): Requirements {
  const unknown = Object.keys(answers).filter(
    (key) => !IGNORED_KEYS.has(key) && !(QUESTION_IDS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Unknown answer${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      { hint: `Valid answer names are: ${QUESTION_IDS.join(", ")}.` },
    );
  }

  const context: InterviewContext =
    options.inferredProvider !== undefined ? { inferredProvider: options.inferredProvider } : {};
  const inferred: Partial<Record<QuestionId, unknown>> =
    options.facts !== undefined ? inferredAnswers(options.facts, context) : {};
  // The provider is always recorded: previous answer, else the token inference, else Hetzner.
  inferred.provider ??= defaultProvider(undefined, context);
  // An app folder chosen in the analysis (`opscrew analyze --app`) wins over an older answer.
  if (options.facts !== undefined && !describesRoot(options.facts)) {
    inferred.appDir = options.facts.appDir;
  }
  const appCandidates = options.appCandidates ?? [];
  const previous = options.previous as Partial<Record<QuestionId, unknown>> | undefined;
  const given = (id: QuestionId) => Object.hasOwn(answers, id) && !isBlank(answers[id]);
  // A server the user already has (or runs Portainer on) stays where it is: no region is asked
  // for or recorded.
  const provider = given("provider") ? answers.provider : (previous?.provider ?? inferred.provider);
  const chosenProvider = typeof provider === "string" ? provider.trim().toLowerCase() : undefined;
  const ownServer = chosenProvider === "own" || chosenProvider === "portainer";
  const required: readonly QuestionId[] = [
    ...REQUIRED.filter((id) => !(ownServer && id === "region")),
    ...(appCandidates.length > 1 ? (["appDir"] as const) : []),
  ];
  const pick = (id: QuestionId): unknown => {
    if (ownServer && id === "region") return undefined;
    if (given(id)) return answers[id];
    // An explicit empty answer clears an optional field instead of reusing the previous value.
    if (Object.hasOwn(answers, id) && !required.includes(id)) return undefined;
    if (id === "appDir") return inferred.appDir ?? previous?.appDir;
    return previous?.[id] ?? inferred[id];
  };

  const missing = required.filter((id) => isBlank(pick(id)));
  if (missing.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Some required answers are missing: ${missing.map((id) => `${id} (${DESCRIPTIONS[id]})`).join(", ")}.`,
      {
        hint: "Add them to the answers file, or run `opscrew interview` in a terminal to answer the questions.",
      },
    );
  }

  const problems: string[] = [];
  const draft: Record<string, unknown> = {
    schemaVersion: 1,
    answeredAt: options.now.toISOString(),
  };
  for (const id of QUESTION_IDS) {
    let value = pick(id);
    if (isBlank(value)) continue;
    if (ENUM_FIELDS.has(id) && typeof value === "string") value = value.trim().toLowerCase();
    if (id === "budgetMonthly") {
      const money = parseMoney(value);
      if (money === undefined) {
        problems.push("budgetMonthly: write an amount such as `10 EUR` or `20 USD`");
        continue;
      }
      value = money;
    }
    if (id === "domain" && typeof value === "string") value = normaliseDomain(value);
    if ((id === "contactEmail" || id === "notes") && typeof value === "string") {
      value = value.trim();
    }
    if (id === "keepExternalServices") value = serviceList(value);
    if (id === "appDir" && typeof value === "string") {
      value = normalizeAppDir(value);
      if (given(id) && appCandidates.length > 0 && !appCandidates.includes(value as string)) {
        problems.push(
          `appDir: ${JSON.stringify(String(answers[id]).trim().slice(0, 200))} is not one of the apps OpsCrew found (${appCandidates.join(", ")})`,
        );
        continue;
      }
    }
    if (isBlank(value)) continue;
    draft[id] = value;
  }
  draft.keepExternalServices ??= [];
  if (draft.domain === undefined) draft.dnsProvider = "none";
  else draft.dnsProvider ??= "cloudflare";

  const parsed = RequirementsSchema.safeParse(draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join(".") || "(answers)";
      if (field.startsWith("budgetMonthly") && problems.some((p) => p.startsWith("budgetMonthly")))
        continue;
      problems.push(
        issue.code === "invalid_value"
          ? `${field} must be one of ${issue.values.map(String).join(", ")}`
          : `${field}: ${issue.message}`,
      );
    }
  } else {
    // A Hetzner or DigitalOcean server is always served behind Cloudflare's proxy when its
    // domain is on Cloudflare; a server the user owns or a Portainer is checked with its serving
    // answer.
    const { provider: chosen, dnsProvider, domain } = parsed.data;
    const deep =
      chosen !== "own" &&
      chosen !== "portainer" &&
      dnsProvider === "cloudflare" &&
      domain !== undefined
        ? deepDomainProblem(
            domain,
            "answer other for dnsProvider to manage its DNS yourself, without Cloudflare's proxy",
          )
        : undefined;
    if (deep !== undefined) problems.push(`domain: ${deep.reason}; ${deep.next}`);
  }
  if (problems.length > 0) {
    throw new OpsCrewError("INVALID_INPUT", `Some answers are not valid: ${problems.join("; ")}.`, {
      hint: "Fix the answers shown above and run `opscrew interview` again.",
    });
  }
  return parsed.data as Requirements;
}
