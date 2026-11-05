import { join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import {
  ensureStateDir,
  exists,
  isRecord,
  listText,
  normalizeHostName,
  OpsCrewError,
  readTextIfExists,
  stripBom,
  toPosixRelative,
} from "@opscrew/core";
import {
  type DeployPlan,
  isServerlessTarget,
  PREVIEW_APP_NAME_MAX,
  PreviewsSchema,
  type ProjectFacts,
  type Question,
  type QuestionId,
  type Requirements,
} from "@opscrew/plan-schema";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { type OwnServerDesignInput, runDesign } from "../design/run";
import { answersToRequirements } from "../interview/answers";
import { hasFollowUps, splitFollowUps } from "../interview/follow-ups";
import {
  answersToOwnServer,
  buildServerQuestions,
  recordOwnServerAnswers,
  SERVER_FIELDS,
} from "../interview/own-server";
import { buildQuestions, type InterviewAnswers } from "../interview/questions";
import { missing } from "../provision/credentials";
import { inspectOwnServerForDesign } from "../shared/own-server-design";
import type {
  AddContext,
  AddEnvironmentOptions,
  AddEnvironmentResult,
  EnvironmentQuestion,
} from "./add";
import { environmentPaths } from "./paths";
import { writeEnvironmentRequirements } from "./requirements";

/** Where previews run: a server OpsCrew creates, or one the user has (FR-2201). */
const PREVIEW_TARGETS: ReadonlySet<string> = new Set(["hetzner", "digitalocean", "own"]);

/** The flag of each previews setting, in refusals. */
const FLAGS: Record<string, string> = {
  cap: "--cap",
  lifetimeDays: "--lifetime",
  domain: "--domain",
  seed: "--seed",
};

/**
 * The questions of `opscrew env add <name> --previews` (spec.md US1): where the previews run (a
 * new server on prod's provider by default, or a server the user has), the region, how many run at
 * once (3), the base of their addresses (prod's hostname), the seed command (the detected one) and
 * how long an idle preview lives (7 days).
 */
export function previewQuestions(
  name: string,
  context: { prodPlan: DeployPlan; base: Requirements },
  facts: ProjectFacts,
): EnvironmentQuestion[] {
  const interview = buildQuestions(facts, context.base);
  const asked = (id: QuestionId) => interview.find((q) => q.id === id) as Question;
  const provider = asked("provider");
  const domain = context.prodPlan.dns.domain;
  const { seedCommand, seedNote } = facts.build;
  return [
    {
      ...provider,
      id: "provider",
      prompt: `Where should the ${name} environment's previews run?`,
      help: "On a small server of their own: a new one, or a server you already have with a public address and nothing else on it.",
      options: (provider.options ?? []).filter((option) => PREVIEW_TARGETS.has(option.value)),
      default: context.prodPlan.target.provider === "digitalocean" ? "digitalocean" : "hetzner",
    },
    { ...asked("region"), id: "region" },
    {
      id: "cap",
      prompt: "How many previews may run at once?",
      help: "From 1 to 20. The server's size follows from it: each preview runs the app and its own services.",
      kind: "text",
      default: "3",
      required: true,
    },
    {
      id: "domain",
      prompt: "Under which name should previews get their addresses (pr-<number>.<name>)?",
      help: "A name in a Cloudflare zone of yours: OpsCrew creates the wildcard record *.<name> there, DNS only.",
      kind: "text",
      ...(domain === undefined ? {} : { default: domain }),
      required: true,
    },
    {
      id: "seed",
      prompt: "Which command should fill a new preview's database, once?",
      help:
        seedCommand === undefined
          ? `${seedNote ?? "OpsCrew found no seed command."} Answer none for empty databases.`
          : "The seed command OpsCrew found. Give another command, or answer none for empty databases.",
      kind: "text",
      default: seedCommand ?? "none",
      required: true,
    },
    {
      id: "lifetime",
      prompt: "After how many days without a push should a preview be removed?",
      help: "From 1 to 30. A push to its pull request brings it back.",
      kind: "text",
      default: "7",
      required: true,
    },
  ];
}

/** A refusal before any change, ending as every one does. */
function refuse(code: "INVALID_INPUT" | "PHASE_PRECONDITION", message: string, hint: string) {
  return new OpsCrewError(code, `${message} Nothing was changed.`, { hint });
}

/** The answer `id` as trimmed text, `undefined` when absent or blank. */
function textOf(answers: InterviewAnswers, id: string): string | undefined {
  const value = answers[id];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === "" ? undefined : text;
}

/** A whole-number answer as a number (`NaN` when it is not one, for the schema to refuse). */
function numberOf(answers: InterviewAnswers, id: string): number | undefined {
  const text = textOf(answers, id);
  return text === undefined ? undefined : Number(text);
}

/** The seed answer: `false`, blank or `none` for none, else the command. */
function seedOf(answers: InterviewAnswers): string | null {
  if (answers.seed === false) return null;
  const text = textOf(answers, "seed");
  return text === undefined || text.toLowerCase() === "none" ? null : text;
}

/**
 * The Cloudflare zone that holds `base`, once the wildcard record `*.<base>` is known to be free
 * (FR-2202); says so when `base` is the zone's apex, where the wildcard catches every name without
 * a record of its own.
 * @throws OpsCrewError `CREDENTIALS_MISSING` without a Cloudflare token, `PHASE_PRECONDITION` when
 * no zone holds `base` or a record is already at `*.<base>`.
 */
async function previewZone(deps: PhaseDeps, base: string, command: string): Promise<string> {
  const connector = cloudflareConnector(deps);
  const client = connector.client;
  if (client === undefined) throw missing("Cloudflare", connector.credentials);
  const zone = await client.findZone(base);
  if (zone === undefined) {
    throw refuse(
      "PHASE_PRECONDITION",
      `Previews get their addresses (pr-<number>.${base}) from a wildcard record OpsCrew creates in your Cloudflare zone, and no Cloudflare zone your token sees holds ${base}.`,
      `Move the domain's DNS to Cloudflare (\`opscrew domain connect\`), or give a name in a Cloudflare zone of yours with --domain, then run \`${command}\` again.`,
    );
  }
  const wildcard = `*.${base}`;
  const taken = await client.listDnsRecords(zone.id, { name: wildcard });
  if (taken.length > 0) {
    throw refuse(
      "PHASE_PRECONDITION",
      `Your Cloudflare zone ${zone.name} already has a record at ${wildcard} (${listText([...new Set(taken.map((r) => r.type))])}), the name OpsCrew would give the previews.`,
      `Give the previews another name with --domain (for example previews.${base}), or delete that record in Cloudflare if nothing uses it, then run \`${command}\` again.`,
    );
  }
  if (base === zone.name) {
    deps.reporter.info(
      `The previews' name ${base} is your zone's apex, so the wildcard record ${wildcard} sends every name in the zone without a record of its own to the preview server, which answers none of them. To keep the rest of the zone apart, give the previews a name below it with --domain (for example previews.${base}).`,
    );
  }
  return zone.name;
}

/**
 * `opscrew env add <name> --previews` (FR-2201, spec.md US1): asks only what previews need
 * ({@link previewQuestions}, defaults filling what `answers` leaves out), refuses before any change
 * what previews cannot have (FR-2202: a site, Portainer, this computer, a runner or build other
 * than GitHub's, a second preview environment, a base name in no Cloudflare zone or with a record
 * at `*.<base>` already, a server of the user's that is not public or runs an app), writes the
 * environment's own answers (`dataCriticality: none`, `uptime: best-effort`, the fewest users),
 * says where the previews' values and seed come from, and designs it (`runDesign`, which shows its
 * monthly cost against the budget). A server the user owns is recorded and inspected first, as
 * `opscrew design` inspects it, since only its inspection shows the apps on it.
 */
export async function addPreviewEnvironment(
  deps: PhaseDeps,
  context: AddContext,
  options: AddEnvironmentOptions,
): Promise<AddEnvironmentResult> {
  const { paths, reporter } = deps;
  const { name, environments, app, prodPlan, base, facts } = context;
  const command = `opscrew env add ${name}${app} --previews`;
  if (isServerlessTarget(prodPlan.target)) {
    throw refuse(
      "PHASE_PRECONDITION",
      `The app is a site without a server, and previews run on a server of their own, as a copy of the app beside its own databases.`,
      "Check a site's changes in their pull request before you merge them, or move the app to a server with `opscrew interview` and `opscrew design` first.",
    );
  }
  // Only each plan's `environment.previews` is read, as `environmentsOf` does.
  for (const other of environments) {
    const text = await readTextIfExists(environmentPaths(paths, other).files.plan);
    const plan: unknown = text === undefined ? undefined : parse(stripBom(text));
    if (!isRecord(plan) || !isRecord(plan.environment) || plan.environment.previews === undefined) {
      continue;
    }
    throw refuse(
      "PHASE_PRECONDITION",
      `The app already has a preview environment, ${other}, and an app has one.`,
      `Change it with \`opscrew design${app} --env ${other}\`, or remove it with \`opscrew env remove ${other}${app}\` first.`,
    );
  }
  const appName = `${prodPlan.app.name}-${name}`;
  if (appName.length > PREVIEW_APP_NAME_MAX) {
    throw refuse(
      "INVALID_INPUT",
      `The ${name} environment's app would be named ${appName}, and a preview environment's app name has at most ${PREVIEW_APP_NAME_MAX} characters, so that each preview's (${appName}-pr-<number>) fits.`,
      `Choose a shorter environment name, for example preview, then run \`opscrew env add <name>${app} --previews\` again.`,
    );
  }
  const questions = previewQuestions(name, { prodPlan, base }, facts);
  const ask = options.answers === undefined ? options.ask : undefined;
  const given = options.answers ?? (ask === undefined ? {} : await ask(questions));
  const answers: InterviewAnswers = {
    ...Object.fromEntries(
      questions.flatMap((q) => (q.default === undefined ? [] : [[q.id, q.default]])),
    ),
    ...given,
  };
  for (const field of ["runner", "build"] as const) {
    const value = textOf(answers, field);
    if (value === undefined || value === "github") continue;
    throw refuse(
      "INVALID_INPUT",
      `Previews are built and deployed on GitHub's machines only, never on a runner of yours: a pull request's code runs in the job, so --${field} ${value} is not available with --previews.`,
      `Leave --${field} out, then run \`${command}\` again.`,
    );
  }
  const server = splitFollowUps(answers, "server", SERVER_FIELDS);
  const {
    cap: _cap,
    size: _size,
    lifetime: _lifetime,
    domain: _domain,
    seed: _seed,
    runner: _runner,
    build: _build,
    ...rest
  } = server.rest;
  const target = textOf(rest, "provider")?.toLowerCase();
  if (target === undefined || !PREVIEW_TARGETS.has(target)) {
    throw refuse(
      "INVALID_INPUT",
      `Previews run on a server of their own that GitHub's machines reach over SSH: a new server at Hetzner or DigitalOcean, or a server you already have, not ${target ?? "no target"}.`,
      `Run \`${command}\` with --target hetzner, digitalocean or own.`,
    );
  }
  const size = textOf(answers, "size");
  if (size !== undefined && target === "own") {
    throw refuse(
      "INVALID_INPUT",
      "--size picks a new server's type, and your own server has its own size.",
      `Give --cap instead (how many previews run at once), then run \`${command}\` again.`,
    );
  }
  const domain = textOf(answers, "domain");
  if (domain === undefined) {
    throw refuse(
      "INVALID_INPUT",
      "Previews get their addresses (pr-<number>.<name>) under a name in a Cloudflare zone of yours, and prod has no hostname to take it from.",
      `Give the name with --domain, then run \`${command}\` again.`,
    );
  }
  const parsed = PreviewsSchema.safeParse({
    // With a server type, the cap is what it holds (design computes it).
    cap: size === undefined ? numberOf(answers, "cap") : 3,
    lifetimeDays: numberOf(answers, "lifetime"),
    domain: normalizeHostName(domain),
    seed: seedOf(answers),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    throw refuse(
      "INVALID_INPUT",
      `${FLAGS[field] ?? field} ${issue?.message ?? "is not valid"}.`,
      `Fix it, then run \`${command}\` again.`,
    );
  }
  const previews = parsed.data;
  const zone = await previewZone(deps, previews.domain, command);
  const requirements = answersToRequirements(
    { ...rest, expectedMonthlyUsers: "<1k", uptime: "best-effort", dataCriticality: "none" },
    { now: deps.clock.now(), facts, previous: base },
  );

  let inspected: OwnServerDesignInput | undefined;
  await ensureStateDir(paths);
  if (requirements.provider === "own") {
    // Served directly with DNS only: GitHub's machines and Let's Encrypt reach it.
    const ownContext = { cloudflareDomain: false };
    let follow = server;
    if (!hasFollowUps(follow) && options.askServer !== undefined) {
      const asked = buildServerQuestions(ownContext).filter((q) => q.id !== "server.serve");
      follow = splitFollowUps(await options.askServer(asked), "server", SERVER_FIELDS);
    }
    const own = answersToOwnServer(follow, ownContext);
    if (!own.reachable) {
      throw refuse(
        "INVALID_INPUT",
        "Previews need a server the internet reaches: GitHub's machines connect to it over SSH, and Let's Encrypt reaches it for each preview's certificate.",
        `Use a server with a public address, or a new one (--target hetzner or digitalocean), then run \`${command}\` again.`,
      );
    }
    await recordOwnServerAnswers(paths, own);
    inspected =
      options.design?.ownServer ??
      (await inspectOwnServerForDesign(deps, {
        ...(options.ownServer?.hostKey !== undefined ? { hostKey: options.ownServer.hostKey } : {}),
        ...(options.ownServer?.services !== undefined
          ? { services: options.ownServer.services }
          : {}),
      }));
    const apps = inspected.apps ?? [];
    if (apps.length > 0) {
      throw refuse(
        "PHASE_PRECONDITION",
        `Your server runs ${listText(apps.map((a) => `"${a.name}"`))}, and previews run pull requests' code: it would run beside ${apps.length === 1 ? "it" : "them"}, so previews need a server with nothing else on it.`,
        `Use another server of yours, or a new one (--target hetzner or digitalocean), then run \`${command}\` again.`,
      );
    }
  }

  await writeEnvironmentRequirements(paths, requirements);
  reporter.success(
    `Wrote ${toPosixRelative(paths.root, paths.files.requirements)}: the ${name} environment's own answers.`,
  );
  const { seedCommand, seedNote } = facts.build;
  if (previews.seed === null && seedCommand === undefined) {
    reporter.info(
      seedNote ??
        "OpsCrew found no seed command, so each preview starts with empty databases (after the release command). Give --seed <command> to fill them.",
    );
  } else if (previews.seed === seedCommand) {
    reporter.info(
      `Each new preview runs \`${seedCommand}\` once, the seed command OpsCrew found; --seed <command> or --no-seed changes it.`,
    );
  }
  // The previews' values come from the environment's own file, as for every environment.
  const file = `.env.${name}`;
  const values = (await exists(join(paths.root, file)))
    ? `The previews' own values come from ${file}, which \`opscrew provision --env ${name}\` reads.`
    : `There is no ${file} yet: put the values previews need there before \`opscrew provision --env ${name}\`.`;
  reporter.info(
    `${values} Use test keys only: anyone who can push a branch can read them. Prod's .env never goes to previews.`,
  );
  const design = await runDesign(deps, {
    ...options.design,
    ...(inspected !== undefined ? { ownServer: inspected } : {}),
    environment: { deploySource: { from: "main" }, runner: "github", previews },
    preview: { zone, ...(size !== undefined ? { serverType: size } : {}) },
  });
  return { requirements, design };
}
