/**
 * Design for a hosting account (feature 027, ADR 0030; FR-2704, US1 scenarios 2 and 3, US5
 * scenario 2): the account's facts, read through its panel and never changed; whether the app fits
 * it; the plan's target (plan 1); and what design says of the account and of what the app gets
 * there. An SFTP host has no panel to read: the hostname, its document root, the database and the
 * certificate are the user's to set there.
 */
import { join } from "node:path";
import type { HostingFacts } from "@opscrew/contracts";
import {
  isRecord,
  listText,
  normalizeHostName,
  OpsCrewError,
  readTextIfExists,
} from "@opscrew/core";
import {
  detectPhpNeeds,
  detectSite,
  listProjectFiles,
  normalizeAppDir,
  type PhpNeeds,
  type SiteDetection,
} from "@opscrew/detect";
import { RUNTIME_DEFAULTS } from "@opscrew/iac-templates";
import {
  CostEstimateSchema,
  type DeployPlan,
  type DesignOption,
  DesignOptionSchema,
  type HostingDeployTarget,
  isHostingTarget,
  type ProjectFacts,
  type Requirements,
  type ServiceKind,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { RUNTIME_NAMES } from "../hosting/apps";
import {
  ENGINE_NAMES,
  type HostingAccount,
  hostingAccountLines,
  quotaLeftMb,
  readHostingAccount,
} from "../hosting/facts";
import { hostingMisfit, hostingRefusal, INTERPRETERS, SCHEDULER } from "../hosting/fit";
import { connectPanel, PANEL_NAMES } from "../hosting/panels";
import { currentRoot, hostingHostnameTaken } from "../hosting/provision-plans";
import { readHostingRecord, type SftpRecord } from "../hosting/record";
import { appDirOf } from "./code-changes";
import { appNameFor, selfHostedServices } from "./components";
import { resolveRuntime } from "./runtime-version";
import { siteBlock } from "./serverless";

/** What design learned for a hosting account, which the plan's target is written from. */
export interface HostingDesignChoice {
  target: HostingDeployTarget;
  /** The folder a release is built from (`app.buildContext`). */
  buildContext: string;
  /** What design says of the account and of what the app gets there. */
  lines: string[];
}

/** Said of every hosting account (US1 scenario 2). */
const HOSTING_PRICE_NOTE = "No price: you already pay for this account.";

/** The startup file CloudLinux's Python selector runs (Passenger's WSGI file). */
const PYTHON_STARTUP = "passenger_wsgi.py";
/** The startup file CloudLinux's Node.js selector runs when the app names none. */
const NODE_STARTUP = "app.js";

/** The variables a split database's settings fill (FR-1337), which provision writes here. */
const DATABASE_SETTINGS = /^DB_(?:HOST|PORT|DATABASE|NAME|USERNAME|USER|PASSWORD|PASS)$/;
const DATABASE_SECRETS = /^DB_PASS(?:WORD)?$/;

/** What {@link designHosting} needs besides the phase's deps. */
export interface HostingDesignInput {
  facts: ProjectFacts;
  requirements: Requirements;
  previous: DeployPlan | undefined;
  /** The services the app keeps using where they are hosted. */
  externalServices: readonly ServiceKind[];
  warn: (text: string) => void;
}

/**
 * The account recorded by the interview, its facts read through its panel (an SFTP host has none),
 * the refusal of an app that doesn't fit ({@link hostingMisfit}), the plan's target, the lines
 * design says, and the single option: no price, since the user already pays for the account.
 * @throws OpsCrewError `PHASE_PRECONDITION` (nothing written) when the interview recorded no
 * account on this computer, the requirements give no hostname, or the app doesn't fit.
 */
export async function designHosting(
  deps: PhaseDeps,
  input: HostingDesignInput,
): Promise<{ choice: HostingDesignChoice; option: DesignOption }> {
  const { facts, requirements, previous } = input;
  const record = await readHostingRecord(deps.paths);
  const sftp = record?.panel === undefined ? record?.sftp : undefined;
  if (record === undefined || (record.panel === undefined && sftp === undefined)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/requirements.yaml says the app runs on a hosting account, but OpsCrew has no record of the account on this computer. Nothing was written.",
      {
        hint: "Run `opscrew interview`: it finds your panel (or confirms your SFTP host's key) and records the account in .opscrew/hosting.json. Then run `opscrew design` again.",
      },
    );
  }
  const hostname = requirements.domain;
  if (hostname === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A hosting account serves the app on a hostname, and opscrew/requirements.yaml names none. Nothing was written.",
      { hint: "Run `opscrew interview` and give the hostname, then run `opscrew design` again." },
    );
  }
  const account =
    record.panel === undefined
      ? undefined
      : await readHostingAccount((await connectPanel(deps, record.panel)).panel, deps.fetch);
  const { root } = deps.paths;
  const php = facts.languages.includes("php");
  const site = php ? undefined : await detectSite(root, facts);
  const app = appKind(facts, site);
  const needs = app === "php" ? await detectPhpNeeds(root, facts.appDir) : undefined;
  const sizeMb =
    account !== undefined && quotaLeftMb(account.facts) !== undefined
      ? await appSizeMb(root, facts.appDir)
      : undefined;
  const before =
    previous !== undefined && isHostingTarget(previous.target) ? previous.target : undefined;
  const interpreter = app === "node" || app === "python" ? INTERPRETERS[app] : undefined;
  const misfit = hostingMisfit({
    facts,
    keep: requirements.keepExternalServices,
    app,
    siteWithoutFolder: app === "static" && site?.outputDir === undefined,
    ...(needs === undefined ? {} : { needs }),
    ...(account === undefined ? {} : { account: account.facts }),
    ...(sizeMb === undefined ? {} : { sizeMb }),
    hasSlot: interpreter !== undefined && before?.runtime?.interpreter === interpreter,
  });
  if (misfit !== undefined) throw hostingRefusal(misfit);
  if (app === undefined)
    throw new Error("hostingMisfit refuses an app the account runs as nothing.");

  const sql = selfHostedServices(facts, requirements.keepExternalServices).find(
    (service): service is { kind: "mysql" | "mariadb"; title: string } =>
      service.kind === "mysql" || service.kind === "mariadb",
  );
  const cron = scheduledCommands(facts);
  const runtime =
    app === "node" || app === "python"
      ? runtimeFor(app, facts, before, {
          startup: app === "node" ? await nodeStartup(root, facts) : PYTHON_STARTUP,
          warn: input.warn,
        })
      : undefined;
  const nodeVersion =
    app === "static" && site?.tool === "node"
      ? nodeFor(facts, before?.site?.nodeVersion, input.warn)
      : undefined;
  const panel = record.panel?.kind ?? "sftp";
  const target: HostingDeployTarget = {
    provider: "hosting",
    panel,
    app,
    webRoot: webRootFor(app, facts),
    ...(app === "static" && site !== undefined
      ? { site: siteBlock({ site, ...(nodeVersion === undefined ? {} : { nodeVersion }) }) }
      : {}),
    // The version the second plan chose at provision, while the app is still a PHP app.
    ...(app === "php" && before?.php !== undefined ? { php: before.php } : {}),
    ...(account !== undefined && sql !== undefined
      ? {
          database: {
            // The app's own engine where the account has it; MariaDB serves MySQL's clients too.
            engine: account.facts.databases.engines.includes(sql.kind)
              ? sql.kind
              : account.facts.databases.engines.includes("mariadb")
                ? "mariadb"
                : "mysql",
            name:
              before?.database?.name ??
              databaseName(
                `${deps.paths.app ?? appNameFor(facts)}${deps.paths.environment === "prod" ? "" : `_${deps.paths.environment}`}`,
                account.facts.databases,
              ),
          },
        }
      : {}),
    cron: account === undefined ? [] : cron,
    ...(runtime === undefined ? {} : { runtime }),
    docroot:
      account === undefined || account.facts.documentRoots === "anywhere" ? "direct" : "link",
  };
  if (account !== undefined) {
    if (hostingHostnameTaken(account.facts.domains, record, normalizeHostName(hostname))) {
      input.warn(
        `The account already serves ${hostname}, and OpsCrew never takes over a hostname it didn't make: \`opscrew provision\` stops before changing anything. Choose a new hostname with \`opscrew interview\`.`,
      );
    }
  }
  const lines = [
    ...(account !== undefined
      ? hostingAccountLines(account)
      : sftp !== undefined
        ? sftpLines(sftp)
        : []),
    hostnameLine(hostname, target, account, sftp),
    ...databaseLines(target, account, sql?.title),
    ...cronLines(cron, account === undefined),
    ...(runtime === undefined
      ? []
      : [
          `Runtime: ${RUNTIME_NAMES[runtime.interpreter]} ${runtime.version} through the panel's selector, started from ${runtime.startup}.`,
        ]),
    ...(needs === undefined ? [] : [phpLine(needs, account === undefined)]),
    HOSTING_PRICE_NOTE,
  ];
  const choice: HostingDesignChoice = {
    target,
    buildContext: app === "static" && site !== undefined ? site.dir : appDirOf(facts),
    lines,
  };
  return { choice, option: hostingOption(choice, input, account, deps.clock.now()) };
}

/**
 * What the account runs the app as: a PHP app, a static site (a site with no server process, its
 * built files served as they are), else a Node.js or Python app; `undefined` for anything else.
 */
function appKind(
  facts: ProjectFacts,
  site: SiteDetection | undefined,
): HostingDeployTarget["app"] | undefined {
  if (facts.languages.includes("php")) return "php";
  if (site !== undefined && site.render === "static" && site.serverNeeds.length === 0) {
    return "static";
  }
  if (facts.languages.includes("javascript") || facts.languages.includes("typescript")) {
    return "node";
  }
  if (facts.languages.includes("python")) return "python";
  return undefined;
}

/**
 * The folder a release serves (plan 1): `public` for Laravel, a plain PHP app's web root
 * (`public` with `public/index.php`), and a Node.js or Python app's `public/` (the selector's
 * app root is the release, which the hostname never serves); else the release itself.
 */
function webRootFor(app: HostingDeployTarget["app"], facts: ProjectFacts): string {
  if (app === "node" || app === "python") return "public";
  if (app !== "php") return ".";
  if (facts.frameworks.some((framework) => framework.name === "laravel")) return "public";
  return facts.webRoot ?? ".";
}

/**
 * The app's scheduled commands as cron lines: a plain PHP app's `cron.php`, and Laravel's
 * scheduler (`schedule:work`, a worker on a server) as `schedule:run` every minute.
 */
function scheduledCommands(facts: ProjectFacts): HostingDeployTarget["cron"] {
  const jobs: HostingDeployTarget["cron"] = (facts.cronJobs ?? []).flatMap((job) =>
    job.source === "cron.php" ? [{ schedule: job.schedule, command: job.command }] : [],
  );
  for (const worker of facts.workers ?? []) {
    if (worker.command === undefined || !SCHEDULER.test(worker.command)) continue;
    jobs.push({
      schedule: "* * * * *",
      command: worker.command.replace(/\bschedule:work\b/, "schedule:run"),
    });
  }
  return jobs;
}

/** The Node.js version a static site is built with, kept from the earlier plan as the rules say. */
function nodeFor(
  facts: ProjectFacts,
  recorded: string | undefined,
  warn: (text: string) => void,
): string | undefined {
  const resolved = resolveRuntime(
    "node",
    facts,
    recorded === undefined ? undefined : { language: "node", version: recorded },
  );
  for (const warning of resolved.warnings) warn(warning);
  return resolved.runtime.version;
}

/** A Node.js or Python app's interpreter, version (an earlier plan's kept) and startup file. */
function runtimeFor(
  app: "node" | "python",
  facts: ProjectFacts,
  before: HostingDeployTarget | undefined,
  { startup, warn }: { startup: string; warn: (text: string) => void },
): NonNullable<HostingDeployTarget["runtime"]> {
  const interpreter = INTERPRETERS[app];
  const recorded = before?.runtime?.interpreter === interpreter ? before.runtime : undefined;
  const resolved = resolveRuntime(
    app,
    facts,
    recorded === undefined ? undefined : { language: app, version: recorded.version },
  );
  for (const warning of resolved.warnings) warn(warning);
  return { interpreter, version: resolved.runtime.version ?? RUNTIME_DEFAULTS[app], startup };
}

/** `node <file>` in a start command. */
const NODE_FILE = /\bnode\s+(?:-\S+\s+)*([\w./-]+\.[cm]?js)\b/;

/**
 * The file a Node.js app starts from: what its start command, or its package.json's `start`
 * script, runs with `node`; else its package.json's `main`; else the selector's default.
 */
async function nodeStartup(root: string, facts: ProjectFacts): Promise<string> {
  const text = await readTextIfExists(join(root, appDirOf(facts), "package.json"));
  let manifest: unknown;
  try {
    manifest = text === undefined ? undefined : JSON.parse(text);
  } catch {
    manifest = undefined;
  }
  const scripts = isRecord(manifest) && isRecord(manifest.scripts) ? manifest.scripts : {};
  for (const command of [facts.build.startCommand, scripts.start]) {
    const file = typeof command === "string" ? NODE_FILE.exec(command)?.[1] : undefined;
    if (file !== undefined) return file;
  }
  return isRecord(manifest) && typeof manifest.main === "string" ? manifest.main : NODE_STARTUP;
}

/**
 * The database's name without the account's prefix, from `base` (the app's name): lower-case
 * letters, digits and underscores, short enough for the panel's limits on the database's and its
 * user's names with the prefix. An underscore counts twice, as cPanel counts it (research R1).
 */
function databaseName(base: string, databases: HostingFacts["databases"]): string {
  const prefix = databases.prefix ?? "";
  const room = Math.min(databases.maxDatabaseName ?? 64, databases.maxUserName ?? 64);
  const cost = (name: string) =>
    `${prefix}${name}`.length + `${prefix}${name}`.split("_").length - 1;
  let name =
    base
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "app";
  while (name.length > 1 && cost(name) > room) name = name.slice(0, -1).replace(/_+$/, "");
  return name;
}

/**
 * The size of the app's source in MB: what git keeps of its folder, without `vendor/`,
 * `node_modules/` and its build output, which a release adds.
 */
async function appSizeMb(root: string, appDir: string): Promise<number> {
  const folder = join(root, ...normalizeAppDir(appDir).split("/"));
  const { bytes } = await listProjectFiles(folder, { maxFileBytes: Number.POSITIVE_INFINITY });
  return bytes / (1024 * 1024);
}

/** What design says of an SFTP host, which has no panel for OpsCrew to read or set up. */
function sftpLines(sftp: SftpRecord): string[] {
  return [
    `The host: SFTP at ${sftp.host}, as ${sftp.user}. OpsCrew uploads each release into ${sftp.folder} and switches it there; the hostname, its document root, the database and the certificate are yours to set in your host's panel.`,
  ];
}

/** The hostname, what it is on the account, and its document root (plan 5). */
function hostnameLine(
  hostname: string,
  target: HostingDeployTarget,
  account: HostingAccount | undefined,
  sftp: SftpRecord | undefined,
): string {
  const release = "the release OpsCrew switches";
  if (account === undefined) {
    return `Hostname: ${hostname}. Point its document root at ${currentRoot(sftp?.folder ?? "", target.webRoot)}, ${release}.`;
  }
  const name = normalizeHostName(hostname);
  const parent = account.facts.domains
    .filter((domain) => name.endsWith(`.${domain.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  const what = account.facts.domains.some((domain) => domain.name === name)
    ? "which the account serves already"
    : parent === undefined
      ? "a domain the account doesn't serve yet, added as an addon domain"
      : `a new subdomain of ${parent.name}`;
  const root =
    target.docroot === "direct"
      ? `${release} itself, in a folder of its own under ~/opscrew`
      : account.facts.documentRoots === "panel"
        ? `the folder ${PANEL_NAMES[account.facts.panel]} makes for it, replaced by a link to ${release}`
        : `a link in public_html to ${release} (the panel takes document roots inside public_html only), and every other hostname is refused there`;
  return `Hostname: ${hostname}, ${what}. Its document root: ${root}.`;
}

/** The database and its user, or why there is none on the account. */
function databaseLines(
  target: HostingDeployTarget,
  account: HostingAccount | undefined,
  uses: string | undefined,
): string[] {
  if (uses === undefined) return [];
  if (account === undefined || target.database === undefined) {
    return [
      `Database: the app uses ${uses}. On an SFTP host you make it in your host's panel and give the app its values as settings.`,
    ];
  }
  const { engine, name } = target.database;
  const full = `${account.facts.databases.prefix ?? ""}${name}`;
  return [
    `Database: ${ENGINE_NAMES[engine]}, ${full} with a user of its own. Its password is generated at provision and kept only in the app's settings on the account, outside the web root.`,
  ];
}

/** The app's cron lines, or on an SFTP host the ones to add in the host's panel. */
function cronLines(cron: HostingDeployTarget["cron"], sftp: boolean): string[] {
  if (cron.length === 0) return [];
  const jobs = listText(cron.map((job) => `${job.command} (${job.schedule})`));
  return [
    sftp
      ? `Cron jobs: an SFTP host has no panel OpsCrew sets them up through, so add them in your host's panel: ${jobs}.`
      : `Cron jobs: ${jobs}, each with the app's PHP version.`,
  ];
}

/** What the app needs from PHP, and when the account's PHP is checked against it. */
function phpLine(needs: PhpNeeds, sftp: boolean): string {
  const wants = `the app needs PHP${needs.php === undefined ? "" : ` ${needs.php}`}${needs.extensions.length === 0 ? "" : ` with ${listText(needs.extensions)}`}`;
  return sftp
    ? `PHP: ${wants}. The host's own PHP runs it, and OpsCrew can't read it over SFTP: check its version and extensions in your host's panel.`
    : `PHP: ${wants}. OpsCrew checks the account's PHP versions and their extensions when it sets the account up (\`opscrew provision\`), and shows the version the app gets.`;
}

/** The variables the account's database fills when the plan makes one: its URL and its settings. */
export function hostingDatabaseVariables(
  facts: ProjectFacts,
  target: HostingDeployTarget,
): Map<string, boolean> {
  const filled = new Map<string, boolean>();
  if (target.database === undefined) return filled;
  for (const service of facts.services) {
    if (
      (service.kind === "mysql" || service.kind === "mariadb") &&
      service.variable !== undefined
    ) {
      filled.set(service.variable, true);
    }
  }
  for (const variable of facts.envVars) {
    if (DATABASE_SETTINGS.test(variable.name)) {
      filled.set(variable.name, DATABASE_SECRETS.test(variable.name));
    }
  }
  return filled;
}

/** What design says of deploys on a hosting account, instead of a server's strategy (ADR 0030). */
export function hostingDeployLine(panel: HostingDeployTarget["panel"]): string {
  return panel === "sftp"
    ? "Deploys: each push to the deploy branch builds a release in GitHub Actions, uploads it over SFTP and switches the hostname's folder to it in one step, switching back if the app doesn't answer."
    : "Deploys: each push to the deploy branch builds a release in GitHub Actions and publishes it signed; the agent OpsCrew installs on the account fetches it within about a minute, checks its signature, switches the hostname to it in one step and switches back if the app doesn't answer.";
}

/** The single option: the account, at no price. There is no server: the sizes are placeholders. */
function hostingOption(
  choice: HostingDesignChoice,
  input: HostingDesignInput,
  account: HostingAccount | undefined,
  now: Date,
): DesignOption {
  const { panel } = choice.target;
  const name = panel === "sftp" ? "SFTP host" : `${PANEL_NAMES[panel]} account`;
  const monthly = { amount: 0, currency: input.requirements.budgetMonthly.currency };
  return DesignOptionSchema.parse({
    id: `hosting-${panel}`,
    title: `Your ${name}`,
    summary: `OpsCrew deploys the app to your ${name}${panel === "sftp" ? " over SFTP" : ", set up through the panel"}; nothing is created or priced as a server. ${HOSTING_PRICE_NOTE}`,
    target: {
      provider: "hosting",
      location: account?.mainDomain ?? "your hosting account",
      serverType: panel === "sftp" ? "SFTP" : PANEL_NAMES[panel],
      vcpus: 1,
      memoryGb: 0.01,
      diskGb: 0.01,
      cpuType: "shared",
      architecture: "x86",
    },
    services: [],
    externalServices: [...input.externalServices],
    backups: false,
    cost: CostEstimateSchema.parse({
      monthly,
      breakdown: [{ item: `Your ${name}, which you already pay for`, monthly }],
      pricesIncludeVat: false,
      source: "static",
      asOf: now.toISOString(),
    }),
    fitsBudget: true,
    recommended: true,
    tradeoffs: [],
  });
}
