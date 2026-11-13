/**
 * The hosting plans (027 plan 2, ADR 0030 D3, ADR 0011's pattern): every change OpsCrew makes on a
 * hosting account is a step of fixed kind in a plan approved by the SHA-256 of its canonical JSON
 * (`hosting-apply`). Provision has two: plan A installs the agent and its cron line; plan B, built
 * from the agent's first report, sets the app up. Values never enter a plan: the settings file is
 * listed by its keys and a digest of the values, and generated values are named as generated.
 */
import { join } from "node:path";
import type { HostingOperation } from "@opscrew/contracts";
import {
  canonicalJson,
  ENVIRONMENT_NAME_PATTERN,
  listText,
  type ProjectPaths,
  plural,
  sha256Hex,
} from "@opscrew/core";
import { z } from "zod";
import { type AdapterPlanItem, describeAdapterPlan } from "../shared";
import { RUNTIME_NAMES } from "./apps";
import { PANEL_NAMES } from "./panels";

/** A path below the home folder (or the app's folder): names of `[A-Za-z0-9._-]`, never `.` or `..`. */
export const PathSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/)
  .refine((path) => path.split("/").every((part) => part !== "." && part !== ".."), {
    message: "must not contain . or ..",
  });
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const ModeSchema = z.int().min(0).max(0o777);
/** A hostname, lower-case. */
export const HostnameSchema = z.string().regex(/^[a-z0-9.-]+$/);
const ScheduleSchema = z.string().regex(/^\S+(?: \S+){4}$/);
const CommandSchema = z
  .string()
  .min(1)
  .max(1000)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a cron line's command has none.
  .regex(/^[^\u0000-\u001f\u007f]+$/);

/** The changes a panel's API can make (`HostingOperation`). */
export const OPERATIONS = [
  "addHostname",
  "removeHostname",
  "addDatabase",
  "removeDatabase",
  "addCron",
  "removeCron",
  "writeFile",
  "uploadTar",
  "remove",
  "requestCertificate",
  "removeCertificate",
  "setPhpVersion",
] as const satisfies readonly HostingOperation[];

/** A step the user takes in the panel, as the panel's connector words it (`panelStep`). */
export const PanelStepSchema = z.strictObject({
  operation: z.enum(OPERATIONS),
  what: z.string().min(1),
  where: z.string().min(1),
  value: z.string().min(1).optional(),
});

/** A step the panel's API can't take: the user takes it, and provision stops after listing it. */
const PanelStepStep = z.strictObject({
  kind: z.literal("panel-step"),
  /** What it is, stable across runs: `agent-cron`, `php`, `cron:<schedule> <command>`. */
  id: z.string().min(1),
  step: PanelStepSchema,
});

/** A file of the app's folder: its path there, its mode and the SHA-256 of its content. */
const FileShape = { path: PathSchema, mode: ModeSchema, sha256: Sha256Schema };

/** Plan A: the agent's folder, its files, and its cron line. */
const AgentStepSchema = z.discriminatedUnion("kind", [
  // Makes the app's folder (`keys/`, `state/`, `requests/`, `dumps/` 0700; `releases/`, `shared/`
  // 0711) with these files, in one archive unpacked in the home folder.
  z.strictObject({ kind: z.literal("folder"), files: z.array(z.strictObject(FileShape)).min(1) }),
  // Replaces a file of the folder that differs.
  z.strictObject({ kind: z.literal("file"), ...FileShape }),
  // The agent's cron line.
  z.strictObject({ kind: z.literal("cron"), schedule: ScheduleSchema, command: CommandSchema }),
  PanelStepStep,
]);

/** Plan B: the app's part, built from the facts and the agent's report. */
const AppStepSchema = z.discriminatedUnion("kind", [
  // A new release signing key pair (ECDSA P-256), made at apply: its private half goes straight
  // to GitHub as the deploy environment's secret (its own approval), then its public half becomes
  // `keys/release.pub`. The private half is never written on this computer or the account.
  z.strictObject({ kind: z.literal("signing-key") }),
  // The database and its user (full names), its password generated at apply and written only into
  // the settings file and `shared/mysql.cnf`, both 0600.
  z.strictObject({
    kind: z.literal("database"),
    name: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
    user: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  }),
  // The app's settings file (`shared/.env`, 0600), or on a later run `shared/.env.next` and an
  // `env` request the agent carries out. `digest` is the SHA-256 of the values outside the
  // database's; `database` names the keys the database fills, `generated` the generated ones.
  z.strictObject({
    kind: z.literal("values"),
    file: z.enum([".env", ".env.next"]),
    keys: z.array(z.string()),
    database: z.array(z.string()),
    generated: z.array(z.string()),
    digest: Sha256Schema,
  }),
  // A file of the app's folder: `settings.sh`, `shared/env.php`.
  z.strictObject({ kind: z.literal("file"), ...FileShape }),
  // A link at `path` (from the home folder) to `target` (relative to the link's folder): the
  // document root inside `public_html` on a restricted cPanel, made before the hostname.
  z.strictObject({ kind: z.literal("link"), path: PathSchema, target: z.string().min(1) }),
  // The hostname with its document root; without one, where the panel puts it.
  z.strictObject({
    kind: z.literal("hostname"),
    hostname: HostnameSchema,
    documentRoot: PathSchema.optional(),
  }),
  // DirectAdmin's own document root for the hostname, empty but for the panel's default page,
  // replaced by a link to `target` (from the home folder).
  z.strictObject({ kind: z.literal("panel-root"), hostname: HostnameSchema, target: PathSchema }),
  // The hostname's PHP version through cPanel's MultiPHP.
  z.strictObject({
    kind: z.literal("php"),
    hostname: HostnameSchema,
    version: z.string().regex(/^\d+\.\d+$/),
  }),
  // A Node.js or Python app in CloudLinux's selector, made by the agent on an `app` request
  // (`apps.ts`): its interpreter, version and startup file, as the agent's settings name them.
  z.strictObject({
    kind: z.literal("app"),
    interpreter: z.enum(["nodejs", "python"]),
    version: z.string().regex(/^\d+(?:\.\d+){0,2}$/),
    startup: PathSchema,
  }),
  // One of the app's cron lines.
  z.strictObject({ kind: z.literal("cron"), schedule: ScheduleSchema, command: CommandSchema }),
  // A cron line OpsCrew made that the app no longer has, by the panel's key.
  z.strictObject({ kind: z.literal("remove-cron"), key: z.string().min(1), line: z.string() }),
  // The hostname's free certificate, asked of the panel.
  z.strictObject({ kind: z.literal("certificate"), hostname: HostnameSchema }),
  PanelStepStep,
]);

const HeaderShape = {
  panel: z.enum(["cpanel", "plesk", "directadmin"]),
  /** The account: its user at the panel's host. */
  account: z.string().min(1),
  environment: z.string().regex(ENVIRONMENT_NAME_PATTERN),
  hostname: HostnameSchema,
  /** The app's folder from the home folder, `opscrew/<app>-<env>`. */
  folder: PathSchema,
};

/** A hosting plan as saved in `.opscrew/plans/hosting-<env>-{agent,app}.json`. */
export const HostingPlanSchema = z.discriminatedUnion("plan", [
  z.strictObject({ plan: z.literal("agent"), ...HeaderShape, steps: z.array(AgentStepSchema) }),
  z.strictObject({ plan: z.literal("app"), ...HeaderShape, steps: z.array(AppStepSchema) }),
]);

export type HostingPlan = z.infer<typeof HostingPlanSchema>;
export type AgentPlan = Extract<HostingPlan, { plan: "agent" }>;
export type AppPlan = Extract<HostingPlan, { plan: "app" }>;
export type AgentStep = AgentPlan["steps"][number];
export type AppStep = AppPlan["steps"][number];
export type HostingStep = AgentStep | AppStep;
export type PanelStepStep = z.infer<typeof PanelStepStep>;

/** SHA-256 (lower-case hex) of the plan's canonical JSON: the hash `hosting-apply` binds. */
export function hostingPlanHash(plan: HostingPlan): string {
  return sha256Hex(canonicalJson(HostingPlanSchema.parse(plan)));
}

/** Where a hosting plan is saved: `.opscrew/plans/hosting-<env>-agent.json` or `-app.json`. */
export function hostingPlanFile(
  paths: Pick<ProjectPaths, "files">,
  environment: string,
  plan: HostingPlan["plan"],
): string {
  return join(paths.files.plansDir, `hosting-${environment}-${plan}.json`);
}

/** A mode as `0600`. */
const octal = (mode: number) => `0${mode.toString(8).padStart(3, "0")}`;

/** One step in plain English, as the plan shows it. */
function stepItem(plan: HostingPlan, step: HostingStep): AdapterPlanItem {
  const { folder } = plan;
  const panel = PANEL_NAMES[plan.panel];
  switch (step.kind) {
    case "folder":
      return {
        title: `Make ~/${folder}/ with ${listText(step.files.map((file) => `${file.path} (${octal(file.mode)})`))}`,
        state: "change",
        reason:
          "agent.sh is OpsCrew's agent, the same as opscrew/hosting/agent.sh in your repository; settings.sh holds the app's settings, no secret; keys/known_hosts holds GitHub's SSH host keys.",
      };
    case "file":
      return { title: `Write ~/${folder}/${step.path} (${octal(step.mode)})`, state: "change" };
    case "signing-key":
      return {
        title: `Make a new release signing key (ECDSA P-256): its private half into GitHub, its public half into ~/${folder}/keys/release.pub`,
        state: "change",
        reason:
          "The private half goes straight to GitHub as a secret of the deploy environment, after its own approval, and is never written on this computer or the account: nothing on the account can sign a release.",
      };
    case "cron":
      return plan.plan === "agent"
        ? {
            title: `Add the agent's cron line (every minute): ${step.command}`,
            state: "change",
            reason:
              "It runs as the account's user and deploys the releases signed for this environment.",
          }
        : { title: `Add the cron line ${step.schedule} ${step.command}`, state: "change" };
    case "database":
      return {
        title: `Make the database ${step.name} and its user ${step.user}, with every privilege on it`,
        state: "change",
        reason: `Its password is generated now and written only into ~/${folder}/shared/.env and shared/mysql.cnf (0600, outside every web root).`,
      };
    case "values": {
      const own = step.keys.filter((key) => !step.database.includes(key));
      const generated = step.generated.filter((key) => !step.database.includes(key));
      return {
        title:
          step.file === ".env"
            ? `Write the app's settings into ~/${folder}/shared/.env (0600): ${step.keys.length === 0 ? "no values" : listText(step.keys)}`
            : `Change the app's settings: write ~/${folder}/shared/.env.next (0600) and ask the agent to put it in place (${listText(step.keys)})`,
        state: "change",
        reason: [
          own.length > 0 ? `The values have the digest ${step.digest.slice(0, 12)}…` : "",
          step.database.length > 0 ? `The database fills ${listText(step.database)}.` : "",
          generated.length > 0 ? `Generated: ${listText(generated)}.` : "",
        ]
          .filter((part) => part !== "")
          .join(" "),
      };
    }
    case "link":
      return {
        title: `Make the link ~/${step.path} to ${step.target}`,
        state: "change",
        reason: `${panel} takes document roots inside public_html only: the link leads to the release OpsCrew switches, and OpsCrew's rules refuse every other hostname there.`,
      };
    case "hostname":
      return {
        title:
          step.documentRoot === undefined
            ? `Add the hostname ${step.hostname}, where ${panel} puts its document root`
            : `Add the hostname ${step.hostname} with the document root ~/${step.documentRoot}`,
        state: "change",
      };
    case "panel-root":
      return {
        title: `Replace the empty document root ${panel} made for ${step.hostname} with a link to ~/${step.target}`,
        state: "change",
        reason:
          "OpsCrew stops instead if the folder holds anything but the panel's default page, or lies inside another site's folder.",
      };
    case "php":
      return { title: `Set ${step.hostname}'s PHP version to ${step.version}`, state: "change" };
    case "app":
      return {
        title: `Make the ${RUNTIME_NAMES[step.interpreter]} ${step.version} app ~/${folder}/app in CloudLinux's selector, started from current/${step.startup} and served at https://${plan.hostname}/`,
        state: "change",
        reason: `The agent runs the selector's create on the account. The selector keeps the app's one environment for ~/${folder}/app, and the app runs current/${step.startup} from there, through the link ~/${folder}/app/current to the running release. Each release whose package files changed has them installed into that environment just before its switch, so the running release gets them a moment early.`,
      };
    case "remove-cron":
      return {
        title: `Remove the cron line OpsCrew made, which the app no longer has: ${step.line}`,
        state: "change",
      };
    case "certificate":
      return { title: `Ask ${panel} for ${step.hostname}'s free certificate`, state: "change" };
    case "panel-step":
      return {
        title: `You, in ${panel}: ${step.step.what}${step.step.value === undefined ? "" : `: ${step.step.value}`}`,
        state: "change",
        reason: `Where: ${step.step.where}. ${panel}'s API can't do this, so OpsCrew stops after this plan; run \`opscrew provision\` again once you did it.`,
      };
  }
}

/** The hosting plan in plain English, as shown before its approval, ending with its hash. */
export function describeHostingPlan(plan: HostingPlan, hash: string): string {
  const panel = PANEL_NAMES[plan.panel];
  return describeAdapterPlan({
    heading:
      plan.plan === "agent"
        ? `Hosting plan A (the agent) for ${plan.hostname} on the ${panel} account ${plan.account}`
        : `Hosting plan B (the app) for ${plan.hostname} on the ${panel} account ${plan.account}`,
    items: plan.steps.map((step) => stepItem(plan, step)),
    findings: [],
    note: `OpsCrew makes only what this plan lists, through ${panel}'s API, records each object it makes in .opscrew/hosting.json, and never changes or removes anything it didn't make.`,
    hashLabel: "Hosting plan hash",
    hash,
  });
}

/** The approval's title for `plan`. */
export function hostingPlanTitle(plan: HostingPlan): string {
  const changes = plural(plan.steps.length, "change");
  return plan.plan === "agent"
    ? `Apply hosting plan A to the ${PANEL_NAMES[plan.panel]} account ${plan.account}: OpsCrew's agent (${changes})`
    : `Apply hosting plan B to the ${PANEL_NAMES[plan.panel]} account ${plan.account}: ${plan.hostname} (${changes})`;
}

/** The panel steps of `plan`, which the user takes. */
export function panelSteps(plan: HostingPlan): PanelStepStep[] {
  return plan.steps.filter((step): step is PanelStepStep => step.kind === "panel-step");
}
