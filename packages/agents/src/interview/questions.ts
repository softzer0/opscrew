import type { VpsProviderId } from "@opscrew/contracts";
import {
  type ProjectFacts,
  type Question,
  type QuestionId,
  QuestionSchema,
  type Requirements,
  type ServiceKind,
} from "@opscrew/plan-schema";
import { frameworkName, listText } from "../analyze/summary";

/** Answers keyed by question id (requirements field). Values come from a prompt or a YAML file. */
export type InterviewAnswers = Record<string, unknown>;

/** Services whose data loss matters; without one of them the data-criticality question is skipped. */
const DATA_SERVICES: ReadonlySet<ServiceKind> = new Set([
  "postgres",
  "mysql",
  "mongodb",
  "sqlite",
  "supabase",
  "firebase",
]);

const usesService = (facts: ProjectFacts, kind: ServiceKind) =>
  facts.services.some((s) => s.kind === kind);

/** True when the app stores data in a database, so data criticality must be asked. */
export function storesData(facts: ProjectFacts): boolean {
  return facts.services.some((s) => DATA_SERVICES.has(s.kind));
}

/** Context the interview cannot read from the facts. */
export interface InterviewContext {
  /**
   * The provider inferred from the API tokens that are set (`providerFromTokens(env)`); used as
   * the provider default when there is no previous answer. Without it the default is `hetzner`.
   */
  inferredProvider?: VpsProviderId;
}

/** The provider default: the previous answer, else the one inferred from tokens, else Hetzner. */
export function defaultProvider(
  previous: Pick<Requirements, "provider"> | undefined,
  context: InterviewContext = {},
): VpsProviderId {
  return previous?.provider ?? context.inferredProvider ?? "hetzner";
}

/**
 * Answers inferred from the facts for questions that are not asked (no database → data
 * criticality `none`; no Supabase → keep nothing), the provider inferred from tokens (else
 * `hetzner`) and defaults for optional questions.
 */
export function inferredAnswers(
  facts: ProjectFacts,
  context: InterviewContext = {},
): Partial<Record<QuestionId, unknown>> {
  const inferred: Partial<Record<QuestionId, unknown>> = {};
  inferred.provider = defaultProvider(undefined, context);
  if (!storesData(facts)) inferred.dataCriticality = "none";
  inferred.keepExternalServices = usesService(facts, "supabase") ? ["supabase"] : [];
  return inferred;
}

/** True when the facts describe the repository root (no app folder was chosen). */
export function describesRoot(facts: ProjectFacts): boolean {
  return facts.appDir === undefined || facts.appDir === ".";
}

/** Short description of a candidate app from the frameworks detected in its folder. */
function candidateHint(facts: ProjectFacts, dir: string): string | undefined {
  const names = [
    ...new Set(facts.frameworks.filter((f) => f.path === dir).map((f) => frameworkName(f.name))),
  ];
  return names.length > 0 ? listText(names) : undefined;
}

const withDefault = <T>(value: T | undefined) => (value === undefined ? {} : { default: value });

/**
 * The interview questions for a project: only those that cannot be inferred from the facts, with
 * previous answers pre-filled as defaults. When the facts describe the repository root and
 * `appCandidates` (from `detectProjectDetails`) lists several apps, the first question asks which
 * one to deploy (`appDir`). The provider question defaults to the previous answer, then
 * `context.inferredProvider`, then `hetzner`. Every question is validated with `QuestionSchema`.
 */
export function buildQuestions(
  facts: ProjectFacts,
  previous?: Requirements,
  appCandidates: readonly string[] = [],
  context: InterviewContext = {},
): Question[] {
  const questions: Question[] = [];
  if (describesRoot(facts) && appCandidates.length > 1) {
    const previousApp = previous?.appDir;
    questions.push({
      id: "appDir",
      prompt: "This repository contains several apps. Which one should OpsCrew deploy?",
      help: "OpsCrew deploys one app. It builds the app from the repository root, so code shared from other folders is included.",
      kind: "single-select",
      options: appCandidates.map((dir) => {
        const hint = candidateHint(facts, dir);
        return { value: dir, label: dir, ...(hint !== undefined ? { hint } : {}) };
      }),
      ...withDefault(
        previousApp !== undefined && appCandidates.includes(previousApp) ? previousApp : undefined,
      ),
      required: true,
    });
  }
  questions.push(
    {
      id: "expectedMonthlyUsers",
      prompt: "How many people will use the app each month?",
      help: "A rough guess is fine. It decides the server size.",
      kind: "single-select",
      options: [
        { value: "<1k", label: "Fewer than 1,000" },
        { value: "1k-10k", label: "1,000 to 10,000" },
        { value: "10k-100k", label: "10,000 to 100,000" },
        { value: ">100k", label: "More than 100,000" },
      ],
      default: previous?.expectedMonthlyUsers ?? "<1k",
      required: true,
    },
    {
      id: "budgetMonthly",
      prompt: "What is your monthly budget for hosting?",
      help: "In EUR or USD, for example 10 EUR. OpsCrew shows which options fit it.",
      kind: "money",
      ...withDefault(previous?.budgetMonthly),
      required: true,
    },
    {
      id: "provider",
      prompt: "Where should OpsCrew run your app?",
      kind: "single-select",
      options: [
        {
          value: "hetzner",
          label: "Hetzner Cloud",
          hint: "lowest prices; servers in Germany, Finland, the US and Singapore",
        },
        {
          value: "digitalocean",
          label: "DigitalOcean",
          hint: "use your DigitalOcean account; data centres in Germany, the Netherlands, the US and Singapore; prices in USD",
        },
      ],
      default: defaultProvider(previous, context),
      required: true,
    },
    {
      id: "region",
      prompt: "Where are most of your users?",
      help: "The server is placed close to them.",
      kind: "single-select",
      options: [
        { value: "eu-central", label: "Europe (Germany)" },
        { value: "eu-north", label: "Northern Europe (Finland)" },
        { value: "us-east", label: "United States, east coast" },
        { value: "us-west", label: "United States, west coast" },
        { value: "ap-southeast", label: "Asia Pacific (Singapore)" },
      ],
      default: previous?.region ?? "eu-central",
      required: true,
    },
    {
      id: "uptime",
      prompt: "How much downtime is acceptable?",
      kind: "single-select",
      options: [
        {
          value: "best-effort",
          label: "Some downtime is fine",
          hint: "side projects, demos",
        },
        { value: "standard", label: "Short outages are acceptable", hint: "most apps" },
        {
          value: "high",
          label: "It must stay up",
          hint: "paying customers; costs more",
        },
      ],
      default: previous?.uptime ?? "standard",
      required: true,
    },
  );

  if (storesData(facts)) {
    questions.push({
      id: "dataCriticality",
      prompt: "How bad would it be to lose the app's data?",
      help: "Anything other than 'not a problem' turns on automated backups.",
      kind: "single-select",
      options: [
        { value: "none", label: "Not a problem", hint: "the data can be recreated" },
        { value: "important", label: "Painful", hint: "daily backups" },
        { value: "critical", label: "Unacceptable", hint: "backups and extra care" },
      ],
      default: previous?.dataCriticality ?? "important",
      required: true,
    });
  }

  questions.push(
    {
      id: "domain",
      prompt: "Which domain should the app use? Leave empty to decide later.",
      help: "For example app.example.com. You can add one later.",
      kind: "text",
      ...withDefault(previous?.domain),
      required: false,
    },
    {
      id: "dnsProvider",
      prompt: "Where is the domain's DNS managed?",
      help: "Ignored when you leave the domain empty. With Cloudflare, OpsCrew can set up DNS for you.",
      kind: "single-select",
      options: [
        { value: "cloudflare", label: "Cloudflare" },
        { value: "other", label: "Another provider", hint: "you add the DNS record yourself" },
        { value: "none", label: "No domain yet" },
      ],
      default: previous?.dnsProvider ?? "cloudflare",
      required: false,
    },
  );

  if (usesService(facts, "supabase")) {
    questions.push({
      id: "keepExternalServices",
      prompt: "Keep using your hosted Supabase project?",
      help: "Yes (recommended) keeps the database and sign-in on Supabase. No runs PostgreSQL on your own server, and you move the data and replace Supabase features yourself.",
      kind: "confirm",
      default: previous !== undefined ? previous.keepExternalServices.includes("supabase") : true,
      required: false,
    });
  }

  return questions.map((q) => QuestionSchema.parse(q));
}
