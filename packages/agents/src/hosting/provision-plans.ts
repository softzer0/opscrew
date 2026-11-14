/**
 * Building provision's two hosting plans (027 plan 2) from what is on the account now and what
 * OpsCrew recorded: a run again plans only what differs, and never touches anything the record
 * doesn't list.
 */
import type { HostingFacts, HostingFiles, HostingPanel } from "@opscrew/contracts";
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  AGENT_SH,
  hostingKeptFolders,
  releaseBranch,
  renderAgentSettings,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  type HostingDeployTarget,
  snapshotsByDefault,
} from "@opscrew/plan-schema";
import { signingKeyId } from "./apply";
import { appStep } from "./apps";
import {
  AGENT_SCHEDULE,
  agentCronCommand,
  agentCronLine,
  appCronCommand,
  cronDetails,
  type PhpChoice,
} from "./php";
import type { AgentPlan, AgentStep, AppPlan, AppStep } from "./plan";
import { type HostingRecord, recordedObject } from "./record";

/** The plan's environment, `prod` for the plan without one. */
export const environmentOf = (plan: DeployPlan) => plan.environment?.name ?? "prod";

/** The app's name without its environment (a named environment's name is `<app>-<env>`). */
function appBase(plan: DeployPlan): string {
  const env = plan.environment?.name;
  return env !== undefined && plan.app.name.endsWith(`-${env}`)
    ? plan.app.name.slice(0, -(env.length + 1))
    : plan.app.name;
}

/** The app's folder on the account, from the home folder: `opscrew/<app>-<env>`. */
export function hostingFolder(plan: DeployPlan): string {
  return `opscrew/${appBase(plan)}-${environmentOf(plan)}`;
}

/** The document root a hostname serves: `<folder>/current`, and the web root inside a release. */
export function currentRoot(folder: string, webRoot: string): string {
  return `${folder}/current${webRoot === "." ? "" : `/${webRoot}`}`;
}

/** A path from the home folder as a panel gives it, without `./` or `/` at its start or end. */
export const cleanPath = (path: string) => path.replace(/^\.?\/+|\/+$/g, "");

/** The hosting target of `plan`. */
export function hostingTarget(plan: DeployPlan): HostingDeployTarget {
  if (plan.target.provider !== "hosting") throw new Error("Not a hosting account's plan.");
  return plan.target;
}

/**
 * Where the repository keeps the agent and each environment's settings: `opscrew/hosting`, or
 * `opscrew/apps/<key>/hosting` for a further app.
 */
export function committedHostingFolder(plan: DeployPlan): string {
  return plan.app.key === undefined ? "opscrew/hosting" : `opscrew/apps/${plan.app.key}/hosting`;
}

/** The plan's hostname (`dns.domain`, required with a hosting target). */
export function hostnameOf(plan: DeployPlan): string {
  const domain = plan.dns.domain;
  if (domain === undefined) throw new Error("A hosting account's plan has no hostname.");
  return domain.toLowerCase();
}

/** The database's full names, the account's prefix included; the user is named the same. */
export function databaseNames(
  target: HostingDeployTarget,
  facts: Pick<HostingFacts, "databases">,
): { name: string; user: string } | undefined {
  if (target.database === undefined) return undefined;
  const name = `${facts.databases.prefix ?? ""}${target.database.name}`;
  return { name, user: name };
}

/**
 * The paths the agent links into each release from `shared/`: `.env` for a Laravel, Node.js or
 * Python app (a Node.js or Python app reads its settings from its environment, which the selector
 * gives it, or from the linked file), Laravel's `storage`, and the plan's kept folders
 * (`hostingKeptFolders`), as a server's volumes. Each once, and none inside another (Laravel's
 * kept `storage/app` is in its `storage`): the agent would link it through the first one's link.
 */
function sharedPaths(plan: DeployPlan, laravel: boolean): string[] {
  const settings = laravel || hostingTarget(plan).runtime !== undefined ? [".env"] : [];
  const paths = [...settings, ...(laravel ? ["storage"] : []), ...hostingKeptFolders(plan)];
  return paths.filter(
    (path, i) => !paths.slice(0, i).some((p) => path === p || path.startsWith(`${p}/`)),
  );
}

/** The agent's `settings.sh` (`opscrew/hosting/<env>.sh` in the repository). */
export function agentSettingsText(
  plan: DeployPlan,
  input: { repository: string; php?: PhpChoice; database?: string; laravel: boolean },
): string {
  const target = hostingTarget(plan);
  const path = plan.app.healthPath;
  return renderAgentSettings({
    app: appBase(plan),
    environment: environmentOf(plan),
    hostname: hostnameOf(plan),
    repository: input.repository,
    releaseBranch: releaseBranch(plan),
    webRoot: target.webRoot,
    healthPath: path.startsWith("/") ? path : `/${path}`,
    appKind: target.app,
    // None before the agent's report lets plan B choose it: the agent runs no PHP until then.
    ...(input.php !== undefined ? { phpCli: input.php.cli } : {}),
    ...(input.php?.handler !== undefined ? { phpHandler: input.php.handler } : {}),
    ...(plan.app.releaseCommand !== undefined ? { releaseCommand: plan.app.releaseCommand } : {}),
    sharedPaths: sharedPaths(plan, input.laravel),
    // The snapshot before each release (ADR 0028 D7): `deploy.snapshots` when set, else on in
    // every environment but previews.
    snapshots: (plan.deploy.snapshots ?? snapshotsByDefault(plan)) && input.database !== undefined,
    ...(input.database !== undefined ? { database: input.database } : {}),
    ...(target.runtime !== undefined
      ? { runtimeVersion: target.runtime.version, startupFile: target.runtime.startup }
      : {}),
  });
}

/** What the plans' file steps write, by their path in the app's folder. */
export type FileContents = Map<string, string>;

/** A file step's fields for `content`. */
function fileStep(path: string, mode: number, content: string) {
  return { path, mode, sha256: sha256Hex(content) };
}

/**
 * The stop for something OpsCrew didn't make and won't take over; `stopped` says what was left as
 * it was, `otherwise` what to do when it isn't OpsCrew's (by default: remove it in the panel or
 * choose another hostname).
 */
export function notOurs(
  what: string,
  stopped: string,
  otherwise = "remove it in the panel, or choose another hostname with `opscrew interview`; then run `opscrew provision` again.",
): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${what}, and OpsCrew's record (.opscrew/hosting.json) doesn't list it as OpsCrew's. OpsCrew never changes or takes over what it didn't make: ${stopped}`,
    {
      hint: `If it is OpsCrew's from another computer, copy that computer's .opscrew/hosting.json here (or restore the recovery copy). Otherwise ${otherwise}`,
    },
  );
}

/**
 * True when the account serves `hostname` (among `domains`) and OpsCrew's record doesn't list it
 * as OpsCrew's: a hostname OpsCrew never takes over (FR-2705). Names compare lower-case.
 */
export function hostingHostnameTaken(
  domains: HostingFacts["domains"],
  record: Pick<HostingRecord, "objects"> | undefined,
  hostname: string,
): boolean {
  const host = hostname.toLowerCase();
  return (
    domains.some((domain) => domain.name.toLowerCase() === host) &&
    recordedObject(record, "hostname", host) === undefined
  );
}

/** Stops when the account serves `hostname` and OpsCrew didn't make it ({@link hostingHostnameTaken}). */
export function requireNewHostname(
  facts: Pick<HostingFacts, "domains">,
  record: Pick<HostingRecord, "objects"> | undefined,
  hostname: string,
): void {
  if (hostingHostnameTaken(facts.domains, record, hostname)) {
    throw notOurs(`The account already serves ${hostname}`, "nothing was changed.");
  }
}

/** What {@link buildAgentPlan} reads. */
interface AgentPlanInput {
  header: Omit<AgentPlan, "plan" | "steps">;
  panel: HostingPanel;
  files: HostingFiles;
  record: HostingRecord | undefined;
  /** The agent, its first settings and GitHub's host keys, by path in the app's folder. */
  contents: FileContents;
}

/**
 * Plan A (plan 2): the app's folder with the agent, its settings and GitHub's host keys, then the
 * agent's cron line. On a run again: only the agent's files that differ, and the cron line when
 * OpsCrew made none. A cron line the panel's API can't add is a step in the panel.
 */
export async function buildAgentPlan(input: AgentPlanInput): Promise<AgentPlan> {
  const { header, files, panel, record, contents } = input;
  const { folder } = header;
  const steps: AgentStep[] = [];
  const text = (path: string) => contents.get(path) ?? "";
  const made = recordedObject(record, "folder", folder) !== undefined;
  if (!made) {
    if ((await files.readFile(`${folder}/agent.sh`)) !== undefined) {
      throw notOurs(`The account already has the folder ~/${folder}`, "nothing was changed.");
    }
    steps.push({
      kind: "folder",
      files: [
        fileStep("agent.sh", 0o700, text("agent.sh")),
        fileStep("settings.sh", 0o600, text("settings.sh")),
        fileStep("keys/known_hosts", 0o600, text("keys/known_hosts")),
      ],
    });
  } else {
    for (const [path, mode] of [
      ["agent.sh", 0o700],
      ["keys/known_hosts", 0o600],
    ] as const) {
      const now = await files.readFile(`${folder}/${path}`);
      if (now !== text(path)) steps.push({ kind: "file", ...fileStep(path, mode, text(path)) });
    }
  }
  const command = agentCronCommand(folder);
  const line = agentCronLine(folder);
  const cron = record?.objects.some((o) => o.kind === "cron" && o.value === line) === true;
  if (!cron && recordedObject(record, "panel-step", "agent-cron") === undefined) {
    steps.push(
      panel.operations.has("addCron")
        ? { kind: "cron", schedule: AGENT_SCHEDULE, command }
        : {
            kind: "panel-step",
            id: "agent-cron",
            step: panel.panelStep("addCron", { schedule: AGENT_SCHEDULE, command }),
          },
    );
  }
  return { plan: "agent", ...header, steps };
}

/** The app's values for plan B, by name, and what the plan names of them. */
export interface PlannedValues {
  /** The values outside the database's, by name. */
  values: Record<string, string>;
  /** The keys the database fills. */
  database: string[];
  /** The generated keys (the database's password included). */
  generated: string[];
  digest: string;
}

/** What {@link buildAppPlan} reads. */
interface AppPlanInput {
  header: Omit<AppPlan, "plan" | "steps">;
  plan: DeployPlan;
  panel: HostingPanel;
  files: HostingFiles;
  record: HostingRecord | undefined;
  facts: HostingFacts;
  php: PhpChoice | undefined;
  values: PlannedValues | undefined;
  /** `settings.sh` and, for a plain PHP app, `shared/env.php`, by path in the app's folder. */
  contents: FileContents;
}

/**
 * Plan B (plan 2, plan 5): a new release signing key when the account's public half isn't the one
 * whose private half OpsCrew stored in GitHub, the database and its user, the app's settings file
 * (`.env.next` and an `env` request once one was written), `env.php` for a plain PHP app, the
 * agent's settings with the chosen PHP, the hostname with its document root (`direct`; a link in
 * `public_html` made before
 * it; or the panel's own empty root replaced by a link after it), its PHP version (cPanel's
 * MultiPHP, or a step in the panel on Plesk and DirectAdmin), a Node.js or Python app in
 * CloudLinux's selector (`apps.ts`), the app's cron lines with the
 * chosen PHP (and the removal of those OpsCrew made that the app no longer has), and the
 * certificate's request. A database that exists and that OpsCrew didn't make stops it.
 */
export async function buildAppPlan(input: AppPlanInput): Promise<AppPlan> {
  const { header, plan, panel, files, record, facts, php, values, contents } = input;
  const { folder, hostname } = header;
  const target = hostingTarget(plan);
  const steps: AppStep[] = [];
  const publicKey = await files.readFile(`${folder}/keys/release.pub`);
  const stored =
    publicKey !== undefined &&
    (record?.objects ?? []).some(
      (o) => o.kind === "signing-key" && o.key === signingKeyId(publicKey),
    );
  if (!stored) {
    steps.push({ kind: "signing-key" });
  }
  const names = databaseNames(target, facts);
  if (names !== undefined && recordedObject(record, "database", names.name) === undefined) {
    if ((await panel.listDatabases()).includes(names.name)) {
      throw notOurs(
        `The account already has the database ${names.name}`,
        "it stopped before the app's plan, with only its agent installed.",
      );
    }
    steps.push({ kind: "database", ...names });
  }
  if (values !== undefined) {
    const written = recordedObject(record, "file", `${folder}/shared/.env`);
    if (written?.value !== values.digest) {
      steps.push({
        kind: "values",
        file: written === undefined ? ".env" : ".env.next",
        keys: [...Object.keys(values.values), ...values.database].sort(),
        database: values.database,
        generated: values.generated,
        digest: values.digest,
      });
    }
  }
  for (const path of ["shared/env.php", "settings.sh"]) {
    const content = contents.get(path);
    if (content === undefined) continue;
    if ((await files.readFile(`${folder}/${path}`)) !== content) {
      steps.push({ kind: "file", ...fileStep(path, 0o600, content) });
    }
  }
  const served = currentRoot(folder, target.webRoot);
  const made = recordedObject(record, "hostname", hostname);
  if (made === undefined) {
    if (facts.documentRoots === "anywhere") {
      steps.push({ kind: "hostname", hostname, documentRoot: served });
    } else if (facts.documentRoots === "public_html") {
      const link = `public_html/${folder.replace("/", "-")}`;
      if (recordedObject(record, "link", link) === undefined) {
        steps.push({ kind: "link", path: link, target: `../${served}` });
      }
      steps.push({ kind: "hostname", hostname, documentRoot: link });
    } else {
      steps.push({ kind: "hostname", hostname }, { kind: "panel-root", hostname, target: served });
    }
  } else if (
    facts.documentRoots === "panel" &&
    made.value !== undefined &&
    recordedObject(record, "link", made.value) === undefined
  ) {
    // The hostname was made, and a stop came before its root became the link.
    steps.push({ kind: "panel-root", hostname, target: served });
  }
  if (php !== undefined && php.via === "multiphp") {
    if (php.panelStep === true) {
      const id = `php:${php.version}`;
      if (recordedObject(record, "panel-step", id) === undefined) {
        steps.push({
          kind: "panel-step",
          id,
          step: panel.panelStep("setPhpVersion", { hostname, version: php.version }),
        });
      }
    } else if (recordedObject(record, "php", hostname)?.value !== php.version) {
      steps.push({ kind: "php", hostname, version: php.version });
    }
  }
  // After the hostname, which the selector serves the app on, and the settings naming its runtime.
  const app = appStep(target, record);
  if (app !== undefined) steps.push(app);
  steps.push(
    ...cronSteps({ folder, panel, record, target, php, envPhp: contents.has("shared/env.php") }),
  );
  if (panel.operations.has("requestCertificate")) {
    const certificate = made === undefined ? undefined : await panel.certificate(hostname);
    if (made === undefined || (certificate?.installed === false && !certificate.inProgress)) {
      steps.push({ kind: "certificate", hostname });
    }
  }
  return { plan: "app", ...header, steps };
}

/**
 * The app's cron lines with the chosen PHP: those OpsCrew didn't make yet (a step in the panel
 * where its API can't add one), and the removal of those it made, or asked the user to add, that
 * the app no longer has (a step in the panel too, for one the user added).
 */
function cronSteps(input: {
  folder: string;
  panel: HostingPanel;
  record: HostingRecord | undefined;
  target: HostingDeployTarget;
  php: PhpChoice | undefined;
  envPhp: boolean;
}): AppStep[] {
  const { folder, panel, record, target } = input;
  const agent = agentCronLine(folder);
  const wanted = target.cron.map((job) => ({
    schedule: job.schedule,
    command: appCronCommand({
      folder,
      command: job.command,
      cli: input.php?.cli,
      envPhp: input.envPhp,
    }),
  }));
  const lines = wanted.map((job) => `${job.schedule} ${job.command}`);
  const ours = (record?.objects ?? []).filter((o) => o.kind === "cron" && o.value !== agent);
  const listed = new Set(
    (record?.objects ?? []).flatMap((o) => (o.kind === "panel-step" ? [o.key] : [])),
  );
  const steps: AppStep[] = [];
  for (const job of wanted) {
    const line = `${job.schedule} ${job.command}`;
    if (ours.some((o) => o.value === line) || listed.has(`cron:${line}`)) continue;
    steps.push(
      panel.operations.has("addCron")
        ? { kind: "cron", ...job }
        : { kind: "panel-step", id: `cron:${line}`, step: panel.panelStep("addCron", job) },
    );
  }
  for (const old of ours) {
    if (old.value === undefined || lines.includes(old.value)) continue;
    steps.push({ kind: "remove-cron", key: old.key, line: old.value });
  }
  for (const id of listed) {
    const line = id.startsWith("cron:") ? id.slice("cron:".length) : undefined;
    if (line === undefined || lines.includes(line) || listed.has(`remove-cron:${line}`)) continue;
    steps.push({
      kind: "panel-step",
      id: `remove-cron:${line}`,
      step: panel.panelStep("removeCron", cronDetails(line)),
    });
  }
  return steps;
}

/**
 * The panel steps the user took since the last run that end one: a cron line the user removed in
 * the panel (`remove-cron:<line>`), listed with the one that asked to add it (`cron:<line>`), both
 * to forget.
 */
export function removedByUser(record: HostingRecord | undefined): string[] {
  return (record?.objects ?? []).flatMap((o) =>
    o.kind === "panel-step" && o.key.startsWith("remove-cron:")
      ? [o.key, `cron:${o.key.slice("remove-cron:".length)}`]
      : [],
  );
}

/** The agent's own files: the agent, its first settings and GitHub's host keys. */
export function agentContents(settings: string, knownHosts: readonly string[]): FileContents {
  return new Map([
    ["agent.sh", AGENT_SH],
    ["settings.sh", settings],
    ["keys/known_hosts", `${knownHosts.join("\n")}\n`],
  ]);
}
