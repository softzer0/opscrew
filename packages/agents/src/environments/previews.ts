import { join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import {
  ensureStateDir,
  exists,
  listText,
  normalizeHostName,
  OpsCrewError,
  toPosixRelative,
} from "@opscrew/core";
import {
  type DeployPlan,
  isServerlessTarget,
  likelyCloudflareZone,
  PREVIEW_APP_NAME_MAX,
  PreviewsSchema,
  type ProjectFacts,
  previewEnvironmentOf,
  type Question,
  type QuestionId,
  type Requirements,
} from "@opscrew/plan-schema";
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
import { appZoneWarning, requireAppZonePreviews } from "../previews/app-zone";
import {
  refusedBeforeChange,
  requireHostApps,
  shareableHost,
  shareableHosts,
  sharedServerWarning,
} from "../previews/host";
import { missing } from "../provision/credentials";
import { inspectOwnServerForDesign, sharedServerDesign } from "../shared/own-server-design";
import {
  type AddContext,
  type AddEnvironmentOptions,
  type AddEnvironmentResult,
  answersWithDefaults,
  type EnvironmentQuestion,
} from "./add";
import { writeEnvironmentRequirements } from "./requirements";

/** Where previews run: a server OpsCrew creates, or one the user has (FR-2201). */
const PREVIEW_TARGETS: ReadonlySet<string> = new Set(["hetzner", "digitalocean", "own"]);

/** The command that buys a domain, which the preview domain's refusals name. */
const BUY = "`opscrew domain buy <name>`";

/** The record types that would serve a site in the preview zone besides the previews. */
const WEB_RECORDS: ReadonlySet<string> = new Set(["A", "AAAA", "CNAME"]);

/** The flag of each previews setting, in refusals. */
const FLAGS: Record<string, string> = {
  cap: "--cap",
  lifetimeDays: "--lifetime",
  domain: "--domain",
  seed: "--seed",
};

/** The prefix of the answer that picks another environment's server (`share:dev`). */
const SHARE = "share:";

/**
 * The questions of `opscrew env add <name> --previews` (spec.md US1, US8, US9): where the previews
 * run (a new server on prod's provider by default, a server the user has, or the server of one of
 * `hosts`, environments whose server previews may share), the region, how many run at once (3),
 * the preview domain (a Cloudflare zone of its own, no default), the seed command (the detected
 * one) and how long an idle preview lives (7 days).
 */
export function previewQuestions(
  name: string,
  context: { prodPlan: DeployPlan; base: Requirements; hosts?: readonly string[] },
  facts: ProjectFacts,
): EnvironmentQuestion[] {
  const interview = buildQuestions(facts, context.base);
  const asked = (id: QuestionId) => interview.find((q) => q.id === id) as Question;
  const provider = asked("provider");
  const { seedCommand, seedNote } = facts.build;
  const hosts = context.hosts ?? [];
  return [
    {
      ...provider,
      id: "provider",
      prompt: `Where should the ${name} environment's previews run?`,
      help: `On a small server of their own: a new one, or a server you already have with a public address and nothing else on it.${hosts.length > 0 ? " Or on another environment's server, beside it, after a warning." : ""}`,
      options: [
        ...(provider.options ?? []).filter((option) => PREVIEW_TARGETS.has(option.value)),
        ...hosts.map((host) => ({
          value: `${SHARE}${host}`,
          label: `On the ${host} environment's server`,
          hint: "beside it, only when it holds test data and test keys",
        })),
      ],
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
      prompt: "Which domain should previews use? A domain of their own, on Cloudflare.",
      help: `Each preview gets an address nobody can guess, pr-<number>-<random>.<domain>, behind Cloudflare's proxy. Use a domain used only for previews, not your app's: a second domain costs about $10 a year, and ${BUY} buys one. A name below your app's domain works too, with Cloudflare's paid Advanced Certificate Manager, after a warning.`,
      kind: "text",
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

/** The confirmation of previews on `host`'s server, which defaults to no. */
function shareQuestion(host: string, warning: string): EnvironmentQuestion {
  return {
    id: "share",
    prompt: `Run the previews on ${host}'s server?`,
    help: warning,
    kind: "confirm",
    default: false,
    required: true,
  };
}

/** The confirmation of previews below the app's zone `zone`, which defaults to no. */
function appZoneQuestion(zone: string, warning: string): EnvironmentQuestion {
  return {
    id: "appZone",
    prompt: `Put the previews below ${zone}?`,
    help: warning,
    kind: "confirm",
    default: false,
    required: true,
  };
}

/**
 * Why `--runner` or `--build` (`flag`) `value` is refused with `--previews`, without the ending
 * every refusal has: previews run on GitHub's machines only.
 */
export function previewRunnerRefusal(flag: "runner" | "build", value: string): string {
  return `Previews are built and deployed on GitHub's machines only, never on a runner of yours: a pull request's code runs in the job, so --${flag} ${value} is not available with --previews.`;
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
 * The preview domain `domain` once it is a Cloudflare zone of its own (FR-2202, research R6): not
 * the app's own zone (prod's `dns.zone`, else the likely zone of prod's domain), a zone itself and
 * not a name inside one, and without A, AAAA or CNAME records, which would serve something else
 * beside the proxied wildcard `*.<zone>`. The refusals name `opscrew domain buy` for a domain of
 * its own. Records are named by name and type only, never their content.
 *
 * A name below the app's zone (spec.md US10) only with the opt-in (`optIn.appZone`, or the
 * confirmation `optIn.ask` asks, which defaults to no), after the warning, and once
 * `requireAppZonePreviews` finds the zone ready for it; then the app's zone is the preview zone.
 * @throws OpsCrewError `INVALID_INPUT` for the app's own zone (or a name in it without the
 * opt-in), `APPROVAL_REFUSED` when the confirmation is declined, `CREDENTIALS_MISSING` without a
 * Cloudflare token, `PHASE_PRECONDITION` for a domain that is no zone of the token's or a zone
 * with such records.
 */
async function previewZone(
  deps: PhaseDeps,
  domain: string,
  prodPlan: DeployPlan,
  command: string,
  optIn: Pick<AddEnvironmentOptions, "appZone" | "ask">,
): Promise<string> {
  const again = `then run \`${command}\` again`;
  const { dns } = prodPlan;
  const appZone =
    dns.zone ?? (dns.domain === undefined ? undefined : likelyCloudflareZone(dns.domain));
  const inAppZone = appZone !== undefined && (domain === appZone || domain.endsWith(`.${appZone}`));
  const below = inAppZone && domain !== appZone;
  if (inAppZone && (!below || (optIn.appZone !== true && optIn.ask === undefined))) {
    throw refusedBeforeChange(
      "INVALID_INPUT",
      `${domain} is in your app's own domain ${appZone}, and previews need a domain of their own: behind its proxy Cloudflare would name the app's domain on every preview, and a preview's records would sit beside the app's.`,
      below
        ? `Give a domain used only for previews with --domain (${BUY} buys one), or add --app-zone to put the previews below ${appZone} with Cloudflare's paid Advanced Certificate Manager, ${again}.`
        : `Give a domain used only for previews with --domain (${BUY} buys one), ${again}.`,
    );
  }
  const connector = cloudflareConnector(deps);
  const client = connector.client;
  if (below) {
    // The opt-in (FR-2231): the warning both ways; without --app-zone, a confirmation too.
    const warning = appZoneWarning(domain, appZone);
    deps.reporter.warn(warning);
    if (optIn.appZone !== true && optIn.ask !== undefined) {
      const confirmed = await optIn.ask([appZoneQuestion(appZone, warning)]);
      if (confirmed.appZone !== true) {
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          `The previews were not set up below ${appZone}. Nothing was changed.`,
          { hint: `Run \`${command}\` again with a domain of the previews' own, or confirm.` },
        );
      }
    }
    if (client === undefined) throw missing("Cloudflare", connector.credentials);
    const zone = await client.findZone(domain);
    if (zone?.name !== appZone) {
      throw refusedBeforeChange(
        "PHASE_PRECONDITION",
        `Previews below ${appZone} go in its Cloudflare zone, and no Cloudflare zone your token sees is ${appZone}.`,
        `Give the Cloudflare token access to ${appZone}, ${again}.`,
      );
    }
    await requireAppZonePreviews(deps.paths, client, {
      zoneId: zone.id,
      zone: zone.name,
      domain,
      again: command,
    });
    return zone.name;
  }
  if (client === undefined) throw missing("Cloudflare", connector.credentials);
  const zone = await client.findZone(domain);
  if (zone === undefined) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `Previews need a domain of their own on Cloudflare, and no Cloudflare zone your token sees is ${domain}.`,
      `Add ${domain} to your Cloudflare account, or buy a domain for previews with ${BUY}, ${again}.`,
    );
  }
  if (zone.name !== domain) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${domain} is a name inside your Cloudflare zone ${zone.name}, and previews need a zone of their own, used for nothing else.`,
      `Give a domain used only for previews with --domain (${BUY} buys one), ${again}.`,
    );
  }
  const web = (await client.listDnsRecords(zone.id)).filter((r) => WEB_RECORDS.has(r.type));
  if (web.length > 0) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `Your Cloudflare zone ${zone.name} already has ${listText(web.map((r) => `${r.name} (${r.type})`))}, and previews need a zone used for nothing else: the proxied wildcard *.${zone.name} and the previews' certificate cover every name in it.`,
      `Give a domain used only for previews with --domain (${BUY} buys one), or delete those records in Cloudflare if nothing uses them, ${again}.`,
    );
  }
  return zone.name;
}

/**
 * `opscrew env add <name> --previews` (FR-2201, spec.md US1): asks only what previews need
 * ({@link previewQuestions}, defaults filling what `answers` leaves out), refuses before any change
 * what previews cannot have (FR-2202: a site, Portainer, this computer, a runner or build other
 * than GitHub's, a second preview environment, no preview domain or one that is not a Cloudflare
 * zone of its own ({@link previewZone}), a server of the user's that is not public or runs an
 * app), records a server of the user's as served behind Cloudflare's proxy, writes the
 * environment's own answers (`dataCriticality: none`, `uptime: best-effort`, the fewest users),
 * says where the previews' values and seed come from, and designs it (`runDesign`, which shows its
 * monthly cost against the budget). A server the user owns is recorded and inspected first, as
 * `opscrew design` inspects it, since only its inspection shows the apps on it.
 *
 * Previews on another environment's server (FR-2228, `shareServer` or picked in the question):
 * refused before any change for prod or a server prod runs on, a host whose plan allows none
 * (`shareableHost`), a server with apps besides the host's (`requireHostApps`, from its
 * inspection) and, in design, a cap that doesn't fit what the host leaves; the warning is printed,
 * picked interactively a confirmation that defaults to no follows, and the plan is an own target's
 * with `previews.server`, with nothing of the host's address or logins recorded here.
 *
 * Previews below the app's zone (FR-2231, `appZone` or the confirmation): see
 * {@link previewZone}.
 */
export async function addPreviewEnvironment(
  deps: PhaseDeps,
  context: AddContext,
  options: AddEnvironmentOptions,
): Promise<AddEnvironmentResult> {
  const { paths, reporter } = deps;
  const { name, app, prodPlan, base, facts } = context;
  const command = `opscrew env add ${name}${app} --previews`;
  if (isServerlessTarget(prodPlan.target)) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `The app is a site without a server, and previews run on a server of their own, as a copy of the app beside its own databases.`,
      "Check a site's changes in their pull request before you merge them, or move the app to a server with `opscrew interview` and `opscrew design` first.",
    );
  }
  const other = await previewEnvironmentOf(paths.root, paths.app);
  if (other !== undefined) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `The app already has a preview environment, ${other}, and an app has one.`,
      `Change it with \`opscrew design${app} --env ${other}\`, or remove it with \`opscrew env remove ${other}${app}\` first.`,
    );
  }
  const appName = `${prodPlan.app.name}-${name}`;
  if (appName.length > PREVIEW_APP_NAME_MAX) {
    throw refusedBeforeChange(
      "INVALID_INPUT",
      `The ${name} environment's app would be named ${appName}, and a preview environment's app name has at most ${PREVIEW_APP_NAME_MAX} characters, so that each preview's (${appName}-pr-<number>) fits.`,
      `Choose a shorter environment name, for example preview, then run \`opscrew env add <name>${app} --previews\` again.`,
    );
  }
  const ask = options.answers === undefined ? options.ask : undefined;
  // Interactively, the servers of the app's other environments that previews may share.
  const hosts =
    ask === undefined || options.shareServer !== undefined
      ? []
      : await shareableHosts(paths, context.environments);
  // With --share-server, where previews run is answered: no question takes it for --target.
  const questions = previewQuestions(name, { prodPlan, base, hosts }, facts).filter(
    (question) => options.shareServer === undefined || question.id !== "provider",
  );
  const given = options.answers ?? (ask === undefined ? {} : await ask(questions));
  const answers = answersWithDefaults(questions, given);
  for (const field of ["runner", "build"] as const) {
    const value = textOf(answers, field);
    if (value === undefined || value === "github") continue;
    throw refusedBeforeChange(
      "INVALID_INPUT",
      previewRunnerRefusal(field, value),
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
  // Another environment's server: `--share-server <env>`, or picked in the question.
  const picked = textOf(rest, "provider");
  const chosenHost = picked?.startsWith(SHARE) ? picked.slice(SHARE.length) : undefined;
  if (options.shareServer !== undefined && textOf(given, "provider") !== undefined) {
    throw refusedBeforeChange(
      "INVALID_INPUT",
      `--share-server runs previews on ${options.shareServer}'s server, and --target names a server of their own.`,
      `Give one of them, then run \`${command}\` again.`,
    );
  }
  const host = options.shareServer?.trim() ?? chosenHost;
  const target = host === undefined ? picked?.toLowerCase() : "own";
  if (target === undefined || !PREVIEW_TARGETS.has(target)) {
    throw refusedBeforeChange(
      "INVALID_INPUT",
      `Previews run on a server of their own that GitHub's machines reach over SSH: a new server at Hetzner or DigitalOcean, or a server you already have, not ${target ?? "no target"}.`,
      `Run \`${command}\` with --target hetzner, digitalocean or own.`,
    );
  }
  // The server previews share, once its plan allows it (FR-2228).
  const shared =
    host === undefined
      ? undefined
      : await shareableHost(deps, host, { preview: name, again: command });
  const size = textOf(answers, "size");
  if (size !== undefined && target === "own") {
    throw refusedBeforeChange(
      "INVALID_INPUT",
      `--size picks a new server's type, and ${host === undefined ? "your own server" : `${host}'s server`} has its own size.`,
      `Give --cap instead (how many previews run at once), then run \`${command}\` again.`,
    );
  }
  const domain = textOf(answers, "domain");
  if (domain === undefined) {
    throw refusedBeforeChange(
      "INVALID_INPUT",
      "Previews need a domain of their own on Cloudflare, where each preview gets an address nobody can guess (pr-<number>-<random>.<domain>), and none was given.",
      `Give it with --domain (${BUY} buys one), then run \`${command}\` again.`,
    );
  }
  const parsed = PreviewsSchema.safeParse({
    // With a server type, the cap is what it holds (design computes it).
    cap: size === undefined ? numberOf(answers, "cap") : 3,
    lifetimeDays: numberOf(answers, "lifetime"),
    domain: normalizeHostName(domain),
    ...(host === undefined ? {} : { server: { environment: host } }),
    seed: seedOf(answers),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    throw refusedBeforeChange(
      "INVALID_INPUT",
      `${FLAGS[field] ?? field} ${issue?.message ?? "is not valid"}.`,
      `Fix it, then run \`${command}\` again.`,
    );
  }
  const previews = parsed.data;
  const zone = await previewZone(deps, previews.domain, prodPlan, command, {
    ...(options.appZone !== undefined ? { appZone: options.appZone } : {}),
    ...(ask !== undefined ? { ask } : {}),
  });
  const requirements = answersToRequirements(
    {
      ...rest,
      provider: target,
      expectedMonthlyUsers: "<1k",
      uptime: "best-effort",
      dataCriticality: "none",
    },
    { now: deps.clock.now(), facts, previous: base },
  );

  let inspected: OwnServerDesignInput | undefined;
  if (shared !== undefined) {
    // The opt-in (FR-2228): the warning both ways; picked interactively, a confirmation too.
    const warning = sharedServerWarning(shared.host);
    reporter.warn(warning);
    if (chosenHost !== undefined && ask !== undefined) {
      const confirmed = await ask([shareQuestion(shared.host, warning)]);
      if (confirmed.share !== true) {
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          `The previews were not set up on ${shared.host}'s server. Nothing was changed.`,
          {
            hint: `Run \`${command}\` again and choose a server of the previews' own, or confirm.`,
          },
        );
      }
    }
    // Inspected now, before anything is written; nothing of its login is copied here.
    inspected = options.design?.ownServer ?? (await sharedServerDesign(shared, options.ownServer));
    requireHostApps(
      (inspected.apps ?? []).map((app) => app.name),
      shared,
      {
        previewApp: appName,
        prodApp: prodPlan.app.name,
        again: command,
      },
    );
    inspected = { ...inspected, access: "public", serving: "proxy" };
  }
  await ensureStateDir(paths);
  if (shared === undefined && requirements.provider === "own") {
    // Served directly behind Cloudflare's proxy with OpsCrew's web filter; GitHub's machines
    // reach it over SSH.
    const ownContext = { cloudflareDomain: true };
    let follow = server;
    if (!hasFollowUps(follow) && options.askServer !== undefined) {
      const asked = buildServerQuestions(ownContext).filter((q) => q.id !== "server.serve");
      follow = splitFollowUps(await options.askServer(asked), "server", SERVER_FIELDS);
    }
    const own = answersToOwnServer(
      { ...follow, values: { ...follow.values, serve: "proxy" } },
      ownContext,
    );
    if (!own.reachable) {
      throw refusedBeforeChange(
        "INVALID_INPUT",
        "Previews need a server the internet reaches: GitHub's machines connect to it over SSH, and Cloudflare's proxy sends visitors to it.",
        `Use a server with a public address, or a new one (--target hetzner or digitalocean), then run \`${command}\` again.`,
      );
    }
    await recordOwnServerAnswers(paths, own);
    inspected =
      options.design?.ownServer ?? (await inspectOwnServerForDesign(deps, options.ownServer));
    const apps = inspected.apps ?? [];
    if (apps.length > 0) {
      throw refusedBeforeChange(
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
