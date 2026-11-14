/**
 * Whether an app fits a hosting account (feature 027, FR-2704, US1 scenario 3, US5 scenario 2):
 * an account serves requests and runs cron jobs, and nothing in between. Design refuses an app
 * that doesn't fit, with the reason and a server target named.
 */
import type { HostingFacts } from "@opscrew/contracts";
import { listText, OpsCrewError, orText } from "@opscrew/core";
import type { PhpNeeds } from "@opscrew/detect";
import type { HostingDeployTarget, ProjectFacts, Requirements } from "@opscrew/plan-schema";
import { CLOUD_PROVIDERS } from "@opscrew/providers";
import { languageName } from "../analyze/summary";
import { selfHostedServices } from "../design/components";
import { RUNTIME_NAMES } from "./apps";
import { quotaLeftMb } from "./facts";

/** Why an app doesn't fit a hosting account, and what to do besides choosing a server target. */
export interface HostingMisfit {
  /** One clause, for "A hosting account doesn't fit this app: <reason>." */
  reason: string;
  /** A way to make the app fit, as a sentence; the server targets are named after it. */
  fix?: string;
}

/** Laravel's scheduler, which a hosting account runs as a cron line every minute instead. */
export const SCHEDULER = /\bschedule:(?:work|run)\b/;

/** The services a hosting account has no counterpart of, each refused in its own words below. */
const QUEUES = new Set(["amqp", "kafka", "nats"]);
const DATABASES = new Set(["mysql", "mariadb", "postgres"]);

/** The interpreter of each kind of app the panel's selectors run. */
export const INTERPRETERS = { node: "nodejs", python: "python" } as const;

/** What {@link hostingMisfit} looks at. */
export interface HostingFitInput {
  facts: ProjectFacts;
  keep: Requirements["keepExternalServices"];
  /** What the account runs the app as; `undefined` when it runs none of the app's kind. */
  app: HostingDeployTarget["app"] | undefined;
  /** A static site whose built files OpsCrew can't find (`detectSite` gave no folder). */
  siteWithoutFolder?: boolean;
  /** A PHP app's needs (`detectPhpNeeds`). */
  needs?: PhpNeeds;
  /** The account's facts; `undefined` on an SFTP host, whose panel OpsCrew can't read. */
  account?: HostingFacts;
  /** The size of the app's source, in MB: without `vendor/`, `node_modules/` and build output. */
  sizeMb?: number;
  /** The app already has its app slot: an earlier hosting plan runs it with the same interpreter. */
  hasSlot?: boolean;
}

/**
 * Why the app doesn't fit the account, or `undefined` when it does: a kind of app the account
 * doesn't run (or a site whose files OpsCrew can't find); cron jobs that call the app's routes; a
 * worker that keeps running (Laravel's scheduler aside, which becomes a cron line);
 * a queue; Redis; WebSockets served from PHP; a service that runs only in a container (or a
 * bucket OpsCrew would create); a database engine the account lacks (PostgreSQL included, which
 * OpsCrew doesn't make on an account yet); a Node.js or Python app where the panel has no selector
 * for it or no app slot left (an SFTP host runs none); an app larger than the disk left.
 */
export function hostingMisfit(input: HostingFitInput): HostingMisfit | undefined {
  const { facts, keep, app, account } = input;
  if (input.siteWithoutFolder) {
    return {
      reason:
        "OpsCrew can't tell which folder holds the site's files: they are at the repository root, or OpsCrew can't tell where its build writes them",
      fix: "Move the site's files into a folder of their own, such as public/, then run `opscrew analyze` and `opscrew design` again.",
    };
  }
  if (app === undefined) {
    const languages = facts.languages.filter((language) => language !== "other");
    return {
      reason: `a hosting account runs static sites and PHP, Node.js and Python apps, and ${languages.length === 0 ? "OpsCrew finds none of them in this app" : `this app is written in ${listText(languages.map(languageName))}`}`,
    };
  }
  const worker = (facts.workers ?? []).find(
    (found) => found.command === undefined || !SCHEDULER.test(found.command),
  );
  if (worker !== undefined) {
    return {
      reason: `the app runs ${worker.name}${worker.command === undefined ? "" : ` (${worker.command})`}, a worker that keeps running, and a hosting account runs nothing between requests`,
    };
  }
  const route = (facts.cronJobs ?? []).flatMap((job) =>
    job.source === "vercel.json" ? [job.route] : [],
  )[0];
  if (route !== undefined) {
    return {
      reason: `the app's cron jobs call its routes (vercel.json: ${route}) with a secret, which OpsCrew sends only from a server`,
    };
  }
  const services = selfHostedServices(facts, keep);
  const queue = services.find((service) => QUEUES.has(service.kind))?.title;
  if (queue !== undefined || facts.services.some((service) => service.kind === "queue")) {
    return {
      reason: `the app uses a queue${queue === undefined ? "" : ` (${queue})`}, whose worker keeps running, and a hosting account runs nothing between requests`,
    };
  }
  if (services.some((service) => service.kind === "redis")) {
    return {
      reason: "the app uses Redis, which a hosting account doesn't run",
      fix: "Keep a hosted Redis the app reaches by URL (answer keepExternalServices.redis: true in `opscrew interview`).",
    };
  }
  const websockets = input.needs?.websockets ?? [];
  if (websockets.length > 0) {
    return {
      reason: `the app serves WebSockets from PHP (${listText(websockets)}), which needs a PHP process that keeps running, and a hosting account runs PHP only for each request`,
    };
  }
  const container = services.find(
    (service) => !QUEUES.has(service.kind) && !DATABASES.has(service.kind),
  );
  if (container !== undefined) {
    return {
      reason: `the app uses ${container.title}, which runs only in a container, and a hosting account runs none`,
      fix: `Keep a hosted ${container.title} the app reaches by URL (answer keepExternalServices.${container.kind}: true in \`opscrew interview\`).`,
    };
  }
  if (facts.objectStorage !== undefined && keep.s3 === false) {
    return {
      reason:
        "the bucket OpsCrew would create for the app's files gives its keys to the app on a server, and a hosting account is none",
      fix: "Keep the storage the app uses now (answer keepExternalServices.s3: true in `opscrew interview`).",
    };
  }
  if (account !== undefined) {
    const misfit = databaseMisfit(services, account) ?? appsMisfit(input, account);
    if (misfit !== undefined) return misfit;
  } else if (app === "node" || app === "python") {
    return {
      reason: `an SFTP host runs no ${RUNTIME_NAMES[INTERPRETERS[app]]} apps: OpsCrew only uploads files there`,
      fix: "Use a hosting account whose panel runs them (set OPSCREW_HOSTING_URL, OPSCREW_HOSTING_USER and OPSCREW_HOSTING_TOKEN, then run `opscrew interview` again).",
    };
  }
  const left = account === undefined ? undefined : quotaLeftMb(account);
  if (left !== undefined && input.sizeMb !== undefined && input.sizeMb > left) {
    return {
      reason: `the app's source (without vendor/, node_modules/ and its build output) takes about ${Math.ceil(input.sizeMb).toLocaleString("en-US")} MB, and the account has ${left.toLocaleString("en-US")} MB of disk left`,
      fix: "Free some disk on the account, or ask your host for a larger plan, then run `opscrew design` again.",
    };
  }
  return undefined;
}

/** The app's database engine where the account has none of it; PostgreSQL in any case. */
function databaseMisfit(
  services: ReturnType<typeof selfHostedServices>,
  account: HostingFacts,
): HostingMisfit | undefined {
  const { engines } = account.databases;
  if (services.some((service) => service.kind === "postgres")) {
    return engines.includes("postgres")
      ? {
          reason:
            "the app uses PostgreSQL, and OpsCrew makes only MySQL and MariaDB databases on a hosting account so far",
        }
      : { reason: "the app uses PostgreSQL, and the account has no PostgreSQL databases" };
  }
  const sql = services.find((service) => service.kind === "mysql" || service.kind === "mariadb");
  if (sql !== undefined && !engines.includes("mysql") && !engines.includes("mariadb")) {
    return {
      reason: `the app uses ${sql.title}, and the account has no MySQL or MariaDB databases`,
    };
  }
  return undefined;
}

/** A Node.js or Python app where the panel has no selector for it, or no app slot left. */
function appsMisfit(input: HostingFitInput, account: HostingFacts): HostingMisfit | undefined {
  const { app } = input;
  if (app !== "node" && app !== "python") return undefined;
  const name = RUNTIME_NAMES[INTERPRETERS[app]];
  if (!account.apps.selectors.includes(INTERPRETERS[app])) {
    return { reason: `the account's panel runs no ${name} apps` };
  }
  if (account.apps.slotsLeft === 0 && input.hasSlot !== true) {
    return {
      reason: `the account's app slots are used up, so the panel can't run another ${name} app`,
      fix: "Remove an app you no longer need in the panel, then run `opscrew design` again.",
    };
  }
  return undefined;
}

/** The server targets a refusal names. */
const SERVER_TARGETS = `a server target with \`opscrew interview\`: ${orText([...CLOUD_PROVIDERS.map((provider) => provider.displayName), "a server you already have"])}`;

/** Design's plain refusal of an app that doesn't fit the account; nothing is written. */
export function hostingRefusal(misfit: HostingMisfit): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `A hosting account doesn't fit this app: ${misfit.reason}. Nothing was written.`,
    {
      hint:
        misfit.fix === undefined
          ? `Choose ${SERVER_TARGETS}.`
          : `${misfit.fix} Otherwise choose ${SERVER_TARGETS}.`,
    },
  );
}
