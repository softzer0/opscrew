/**
 * `opscrew destroy` for an app on a hosting account with a panel (027 plan 6, FR-2707): a hosting
 * plan of fixed step kinds listing only what `.opscrew/hosting.json` records as OpsCrew's, approved
 * by its SHA-256 hash (`hosting-apply`) with `allowDestroy` and the typed hostname, and applied in
 * plan 6's order through the panel's connector, the account's files and GitHub; the DNS record on
 * Cloudflare through the IaC approval, the release signing key through the deploy secrets' usual
 * removal. What the panel's API can't do is a step the user takes in the panel.
 */
import { join, posix } from "node:path";
import type {
  ApprovalRecord,
  HostingFiles,
  HostingOperation,
  HostingPanel,
  ResourceChange,
} from "@opscrew/contracts";
import {
  canonicalJson,
  exists,
  isPlanHash,
  OpsCrewError,
  plural,
  realSleep,
  sha256Hex,
  tfstateFile,
  writeFileAtomic,
} from "@opscrew/core";
import { releaseBranch } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  applyCloudflareRemoval,
  approveCloudflareRemoval,
  type CloudflareRemovalWords,
  COMMAND,
  checkCloudflare,
  deploymentFiles,
  deploySecretsLeft,
  type GitHubTarget,
  nothingDeployed,
  previewCloudflareRemoval,
  recordTeardown,
  removeDeploySecrets,
  requireInfraCode,
  resolveGitHub,
  setupEngine,
  typeNameHint,
} from "../destroy/common";
import {
  type DeletionScope,
  type DeletionSession,
  deletionSession,
  discardPlan,
} from "../destroy/deletion";
import type { DestroyOptions, DestroyResult } from "../destroy/types";
import { type AdapterPlanItem, describeAdapterPlan, hasDeployment, refusalReason } from "../shared";
import { RUNTIME_NAMES, selectorApp } from "./apps";
import { HOSTING_TOKEN_VAR, PANEL_NAMES } from "./panels";
import { AGENT_SCHEDULE, agentCronCommand } from "./php";
import { HostnameSchema, PanelStepSchema, PathSchema } from "./plan";
import { environmentOf, hostingTarget } from "./provision-plans";
import {
  type HostingObject,
  type HostingRecord,
  readHostingRecord,
  recordObject,
  updateHostingRecord,
} from "./record";
import { sendRequest } from "./requests";
import { destroySftp } from "./sftp-destroy";
import { type HostingAccountServices, reachHostingAccount } from "./status";

const NameSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
const InterpreterSchema = z.enum(["nodejs", "python"]);

/** The recorded object a step ends. */
const ObjectRefSchema = z.strictObject({
  kind: z.enum(["cron", "folder", "link", "certificate", "database", "hostname", "panel-step"]),
  key: z.string().min(1),
});

/** A destroy plan's steps, in plan 6's order. */
const DestroyStepSchema = z.discriminatedUnion("kind", [
  // The final dump of the database, by the agent (a `snapshot` request), kept in `dumps/`.
  z.strictObject({ kind: z.literal("dump"), database: NameSchema }),
  // The Node.js or Python app in CloudLinux's selector, removed by the agent (an `app` request)
  // with what the selector leaves, while the agent still runs.
  z.strictObject({ kind: z.literal("app"), interpreter: InterpreterSchema }),
  // A cron line OpsCrew made, by the panel's key; the agent's comes first.
  z.strictObject({
    kind: z.literal("cron"),
    key: z.string().min(1),
    line: z.string().min(1),
    agent: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("hostname"), hostname: HostnameSchema }),
  // A link OpsCrew made for the document root (in `public_html`, or DirectAdmin's own root).
  z.strictObject({ kind: z.literal("link"), path: PathSchema }),
  // The hostname's certificate, unless it is installed for another site.
  z.strictObject({ kind: z.literal("certificate"), id: z.string().min(1) }),
  z.strictObject({ kind: z.literal("database"), name: NameSchema, user: NameSchema }),
  // The app's folder (with the final dump: all but it), then `~/opscrew` when it is empty.
  z.strictObject({ kind: z.literal("folder"), path: PathSchema, keepDump: z.boolean() }),
  // The hostname's DNS record on Cloudflare, through its own IaC approval.
  z.strictObject({ kind: z.literal("dns"), records: z.int().min(1) }),
  z.strictObject({
    kind: z.literal("deploy-key"),
    id: z.string().regex(/^\d+$/),
    repository: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("branch"),
    branch: z.string().min(1),
    repository: z.string().min(1),
  }),
  // A step the user takes in the panel, which ends the recorded `object`.
  z.strictObject({
    kind: z.literal("panel-step"),
    object: ObjectRefSchema,
    step: PanelStepSchema,
  }),
]);

/** A hosting destroy plan, as saved in `.opscrew/plans/hosting-<env>-destroy.json`. */
export const HostingDestroyPlanSchema = z.strictObject({
  plan: z.literal("destroy"),
  panel: z.enum(["cpanel", "plesk", "directadmin"]),
  /** The account: its user at the panel's host. */
  account: z.string().min(1),
  environment: z.string().min(1),
  hostname: HostnameSchema,
  /** The app's folder from the home folder, `opscrew/<app>-<env>`. */
  folder: PathSchema,
  steps: z.array(DestroyStepSchema),
});

export type HostingDestroyPlan = z.infer<typeof HostingDestroyPlanSchema>;
export type DestroyStep = HostingDestroyPlan["steps"][number];

/** SHA-256 of the destroy plan's canonical JSON: the hash `hosting-apply` binds. */
export function hostingDestroyHash(plan: HostingDestroyPlan): string {
  return sha256Hex(canonicalJson(HostingDestroyPlanSchema.parse(plan)));
}

/** One step in plain English, as the plan shows it. */
function stepItem(plan: HostingDestroyPlan, step: DestroyStep): AdapterPlanItem {
  const { folder, hostname } = plan;
  const panel = PANEL_NAMES[plan.panel];
  switch (step.kind) {
    case "dump":
      return {
        title: `Take a final dump of the database ${step.database} into ~/${folder}/dumps/, which stays after the destroy`,
        state: "change",
        reason:
          "The agent takes it. To remove the app without it, run `opscrew destroy --no-snapshot`.",
      };
    case "app":
      return {
        title: `Remove the ${RUNTIME_NAMES[step.interpreter]} app ~/${folder}/app from CloudLinux's selector, then that folder, its empty folder in ~/${step.interpreter === "nodejs" ? "nodevenv" : "virtualenv"}/ and its section of ~/.cl.selector/htaccess_cache`,
        state: "change",
        reason:
          "The agent runs the selector's destroy while it still runs. The app ran current/<startup file> from that folder through its link current, so the releases stay. The file's other sections stay byte for byte; if OpsCrew can't tell which section is the app's, the file stays as it is and OpsCrew says so.",
      };
    case "cron":
      return step.agent
        ? {
            title: `Remove the agent's cron line: ${step.line}`,
            state: "change",
            reason: "First, so the agent stops before its folder goes.",
          }
        : { title: `Remove the cron line ${step.line}`, state: "change" };
    case "hostname":
      return {
        title: `Remove the hostname ${step.hostname}`,
        state: "change",
        reason: "The account's other sites and domains stay.",
      };
    case "link":
      return { title: `Remove the link ~/${step.path} to the app's release`, state: "change" };
    case "certificate":
      return {
        title: `Remove ${hostname}'s certificate (${step.id}), with its key when no other certificate uses it`,
        state: "change",
        reason: "Kept if it is still installed for another site.",
      };
    case "database":
      return {
        title: `Remove the database ${step.name} and its user ${step.user}`,
        state: "change",
        reason:
          "Checked again once everything else is removed: a panel can list a removed database again for a while, and then it is removed once more.",
      };
    case "folder":
      return step.keepDump
        ? {
            title: `Remove ~/${step.path}/ but the final dump in its dumps/ folder`,
            state: "change",
            reason: "~/opscrew/ stays, since it holds the dump.",
          }
        : {
            title: `Remove ~/${step.path}/ with everything in it, then ~/${posix.dirname(step.path)}/ when nothing else is in it`,
            state: "change",
          };
    case "dns":
      return {
        title: `Delete ${hostname}'s DNS ${step.records === 1 ? "record" : "records"} on Cloudflare`,
        state: "change",
        reason: "Through the infrastructure plan, approved on its own next.",
      };
    case "deploy-key":
      return {
        title: `Remove the agent's read-only deploy key (GitHub's id ${step.id}) from ${step.repository}`,
        state: "change",
      };
    case "branch":
      return {
        title: `Delete the release branch ${step.branch} in ${step.repository}`,
        state: "change",
        reason: "It holds the releases GitHub Actions built for the account.",
      };
    case "panel-step":
      return {
        title: `You, in ${panel}: ${step.step.what}${step.step.value === undefined ? "" : `: ${step.step.value}`}`,
        state: "change",
        reason: `Where: ${step.step.where}. ${panel}'s API can't do this, so OpsCrew lists it for you and forgets it.`,
      };
  }
}

/** The destroy plan in plain English, as shown before its approval, ending with its hash. */
function describeHostingDestroy(plan: HostingDestroyPlan, hash: string): string {
  const panel = PANEL_NAMES[plan.panel];
  return describeAdapterPlan({
    heading: `Hosting destroy plan for ${plan.hostname} on the ${panel} account ${plan.account}`,
    items: plan.steps.map((step) => stepItem(plan, step)),
    findings: [],
    note: `OpsCrew removes only what .opscrew/hosting.json lists as made by OpsCrew; everything else on the account stays as it is.`,
    hashLabel: "Hosting plan hash",
    hash,
  });
}

/** What {@link buildHostingDestroyPlan} reads. */
interface DestroyPlanInput {
  header: Omit<HostingDestroyPlan, "plan" | "steps">;
  panel: HostingPanel;
  files: HostingFiles | undefined;
  record: HostingRecord;
  /** Take a final dump of the recorded database, unless one was taken already. */
  finalDump: boolean;
  /** The records the DNS plan deletes (0: none). */
  dnsRecords: number;
  github: GitHubTarget;
  releaseBranch: string;
}

/** The final dumps a destroy recorded in the app's `dumps/` folder (one, unless it was run again). */
function finalDumps(objects: readonly HostingObject[], folder: string): HostingObject[] {
  return objects.filter((o) => o.kind === "file" && o.key.startsWith(`${folder}/dumps/`));
}

/** The interpreter the record names for the app in CloudLinux's selector. */
function recordedInterpreter(app: HostingObject): z.infer<typeof InterpreterSchema> {
  const parsed = InterpreterSchema.safeParse(app.key);
  if (parsed.success) return parsed.data;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `.opscrew/hosting.json records the app in CloudLinux's selector as ${JSON.stringify(app.key)}, which is neither nodejs nor python, so OpsCrew can't tell how to remove it. Nothing was changed.`,
    {
      hint: 'Restore .opscrew/hosting.json from the recovery copy, or set the key of its entry of kind "app" to nodejs or python; then run `opscrew destroy` again.',
    },
  );
}

/** The app in CloudLinux's selector that no agent runs to remove: the user removes it in the panel. */
function appLeft(record: HostingRecord, plan: HostingDestroyPlan): string[] {
  const app = record.objects.find((o) => o.kind === "app");
  if (app === undefined || plan.steps.some((step) => step.kind === "app")) return [];
  const name = RUNTIME_NAMES[recordedInterpreter(app)];
  return [
    `The ${name} app in CloudLinux's selector: no agent runs on the account to remove it, so remove it on the panel's Setup ${name} App page.`,
  ];
}

/** `<schedule> <command>` as a panel's cron step names it. */
function cronDetails(line: string): Record<string, string> {
  const [, schedule = "", command = ""] = /^(\S+(?: \S+){4}) (.+)$/.exec(line) ?? [];
  return { key: line, schedule, command };
}

type DestroyStepObject = z.infer<typeof ObjectRefSchema>;

/**
 * The destroy plan from the record, in plan 6's order: the final dump (when wanted, a database and
 * the agent's cron line recorded, and the account's files reachable); every cron line, the
 * agent's first; the hostname and its links; its certificate; the database and its user; the app's
 * folder; the DNS records; GitHub's deploy key and the release branch (when GitHub is reachable).
 * What the panel's API can't do is a step in the panel.
 */
function buildHostingDestroyPlan(input: DestroyPlanInput): HostingDestroyPlan {
  const { header, panel, files, record } = input;
  const { folder } = header;
  const { objects } = record;
  const of = (kind: HostingObject["kind"]) => objects.filter((o) => o.kind === kind);
  const inPanel = (
    object: DestroyStepObject,
    operation: HostingOperation,
    details: Record<string, string>,
  ): DestroyStep => ({ kind: "panel-step", object, step: panel.panelStep(operation, details) });
  const steps: DestroyStep[] = [];

  const agentLine = `${AGENT_SCHEDULE} ${agentCronCommand(folder)}`;
  const agentCron = of("cron").find((o) => o.value === agentLine);
  const agentStep = of("panel-step").find((o) => o.key === "agent-cron");
  const database = of("database")[0];
  const dumped = finalDumps(objects, folder).length > 0;
  const agentRuns = agentCron !== undefined || agentStep !== undefined;
  if (input.finalDump && !dumped && database !== undefined && files !== undefined && agentRuns) {
    steps.push({ kind: "dump", database: database.key });
  }
  const app = of("app")[0];
  if (app !== undefined && files !== undefined && agentRuns) {
    steps.push({ kind: "app", interpreter: recordedInterpreter(app) });
  }
  const agentFirst = (agent: HostingObject | undefined) => (a: HostingObject, b: HostingObject) =>
    Number(b === agent) - Number(a === agent);
  for (const cron of of("cron").sort(agentFirst(agentCron))) {
    const line = cron.value ?? cron.key;
    steps.push({ kind: "cron", key: cron.key, line, agent: cron === agentCron });
  }
  const listed = of("panel-step").filter(
    (o) => o.key === "agent-cron" || o.key.startsWith("cron:"),
  );
  for (const step of listed.sort(agentFirst(agentStep))) {
    const line = step === agentStep ? agentLine : step.key.slice("cron:".length);
    steps.push(inPanel({ kind: "panel-step", key: step.key }, "removeCron", cronDetails(line)));
  }
  for (const { key } of of("hostname")) {
    steps.push(
      panel.operations.has("removeHostname")
        ? { kind: "hostname", hostname: key }
        : inPanel({ kind: "hostname", key }, "removeHostname", { hostname: key }),
    );
  }
  for (const { key } of of("link")) {
    steps.push(
      files !== undefined
        ? { kind: "link", path: key }
        : inPanel({ kind: "link", key }, "remove", { path: key }),
    );
  }
  for (const { key } of of("certificate")) {
    steps.push(
      panel.operations.has("removeCertificate")
        ? { kind: "certificate", id: key }
        : inPanel({ kind: "certificate", key }, "removeCertificate", {
            id: key,
            hostname: header.hostname,
          }),
    );
  }
  // Its user is named as the database (`databaseNames`).
  for (const { key } of of("database")) {
    steps.push(
      panel.operations.has("removeDatabase")
        ? { kind: "database", name: key, user: key }
        : inPanel({ kind: "database", key }, "removeDatabase", { name: key, user: key }),
    );
  }
  const keepDump = dumped || steps.some((step) => step.kind === "dump");
  for (const { key } of of("folder")) {
    steps.push(
      files !== undefined
        ? { kind: "folder", path: key, keepDump }
        : inPanel({ kind: "folder", key }, "remove", { path: key }),
    );
  }
  if (input.dnsRecords > 0) steps.push({ kind: "dns", records: input.dnsRecords });
  const { api, owner, repo } = input.github;
  if (api !== undefined && owner !== undefined && repo !== undefined) {
    const repository = `${owner}/${repo}`;
    if (api.removeDeployKey !== undefined) {
      for (const { key } of of("deploy-key")) {
        steps.push({ kind: "deploy-key", id: key, repository });
      }
    }
    if (api.deleteBranch !== undefined) {
      steps.push({ kind: "branch", branch: input.releaseBranch, repository });
    }
  }
  return { plan: "destroy", ...header, steps };
}

/** What applying a destroy plan needs besides the plan. */
export interface HostingDestroyContext {
  panel: HostingPanel;
  files: HostingFiles | undefined;
  github: GitHubTarget;
  /** Records an object right after OpsCrew made it (the final dump). */
  made: (object: HostingObject) => Promise<void>;
  /** The objects recorded now. */
  recorded: () => Promise<HostingObject[]>;
  /** Forgets every recorded object `match` takes, once it is gone. */
  forget: (match: (object: HostingObject) => boolean) => Promise<void>;
  /** Applies the approved removal of the DNS records (the `dns` step). */
  dns: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

/** What an apply did besides its steps. */
export interface HostingDestroyOutcome {
  applied: DestroyStep["kind"][];
  /** The final dumps kept in the app's `dumps/` folder, by name. */
  dumps: string[];
  /** Why each certificate kept was: another site still uses it. */
  kept: string[];
  /** What the selector's removal left as it was, and why. */
  left: string[];
}

/** A destroy that stopped at a failure: `applied` lists the steps taken before it. */
class HostingDestroyError extends OpsCrewError {
  readonly applied: DestroyStep["kind"][];

  constructor(cause: unknown, applied: DestroyStep["kind"][]) {
    const known = cause instanceof OpsCrewError;
    super(
      known ? cause.code : "PROVIDER_ERROR",
      `${known ? cause.message : "The panel's answer was unexpected."} ${
        applied.length === 0
          ? "Nothing was removed before it."
          : `OpsCrew took ${plural(applied.length, "step")} of the destroy plan before it; .opscrew/hosting.json lists what is left.`
      }`,
      {
        hint: `${known && cause.hint !== undefined ? `${cause.hint} ` : ""}Then run \`${COMMAND}\` again: it continues with what is left.`,
        cause,
      },
    );
    this.name = "HostingDestroyError";
    this.applied = applied;
  }
}

/** How the connector refuses a certificate still installed for a site (`removeCertificate`). */
const STILL_INSTALLED =
  /^The certificate is still installed for [a-z0-9.-]+; nothing was removed\.$/;

/** A dump's name in `dumps/`, as the agent writes it. */
const DUMP = /^[A-Za-z0-9][A-Za-z0-9._-]*\.sql\.gz$/;

/** The name of a snapshot's copy of the shared files in `dumps/`, as the agent writes it. */
const SHARED_COPY = /^[A-Za-z0-9][A-Za-z0-9_-]*\.shared\.tar\.gz$/;

/** The account's files, which a plan step that uses them was only made with. */
function filesOf(ctx: HostingDestroyContext): HostingFiles {
  if (ctx.files === undefined) throw new Error("A file step without the account's files.");
  return ctx.files;
}

/** GitHub's API and repository, which a plan step that uses them was only made with. */
function githubOf(ctx: HostingDestroyContext) {
  const { api, owner, repo } = ctx.github;
  if (api === undefined || owner === undefined || repo === undefined) {
    throw new Error("A GitHub step without GitHub.");
  }
  return { api, owner, repo };
}

/**
 * Applies an approved destroy plan: refuses with `PLAN_HASH_MISMATCH` before any change when its
 * hash isn't `approvedHash`. The steps then run in order, each recorded object forgotten once it is
 * gone, and the first failure stops with a {@link HostingDestroyError}. A certificate another site
 * still uses is kept. A panel step is the user's: OpsCrew forgets its object. Then, even after a
 * failure, each database removed is looked for again and, if the panel lists it again, removed
 * once more.
 */
export async function applyHostingDestroy(
  plan: HostingDestroyPlan,
  ctx: HostingDestroyContext & { approvedHash: string },
): Promise<HostingDestroyOutcome> {
  if (
    !isPlanHash(ctx.approvedHash) ||
    ctx.approvedHash.toLowerCase() !== hostingDestroyHash(plan)
  ) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This hosting destroy plan is not the one that was approved, so OpsCrew removes nothing from the account.",
      { hint: "Look at the current destroy plan and approve it by its hash." },
    );
  }
  const outcome: HostingDestroyOutcome = { applied: [], dumps: [], kept: [], left: [] };
  const databases: { name: string; user: string }[] = [];
  let failure: { error: unknown } | undefined;
  try {
    for (const step of plan.steps) {
      await destroyStep(plan, step, ctx, { outcome, databases });
      outcome.applied.push(step.kind);
    }
  } catch (error) {
    failure = { error };
  } finally {
    // A database removed comes back for a while on some panels (R10): looked for again, even when
    // a later step failed.
    try {
      const listed = databases.length === 0 ? [] : await ctx.panel.listDatabases();
      for (const database of databases) {
        if (listed.includes(database.name)) await ctx.panel.removeDatabase(database);
      }
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== undefined) throw new HostingDestroyError(failure.error, outcome.applied);
  // Removals of cron lines the user was asked for at an earlier provision: nothing left to end.
  await ctx.forget((o) => o.kind === "panel-step" && o.key.startsWith("remove-cron:"));
  return outcome;
}

async function destroyStep(
  plan: HostingDestroyPlan,
  step: DestroyStep,
  ctx: HostingDestroyContext & { approvedHash: string },
  state: { outcome: HostingDestroyOutcome; databases: { name: string; user: string }[] },
): Promise<void> {
  const { panel } = ctx;
  const { folder } = plan;
  switch (step.kind) {
    case "dump": {
      let answer: Awaited<ReturnType<typeof sendRequest>>;
      try {
        answer = await sendRequest(
          filesOf(ctx),
          folder,
          { kind: "snapshot" },
          { hash: ctx.approvedHash, now: ctx.now(), sleep: ctx.sleep },
        );
      } catch (error) {
        if (!(error instanceof OpsCrewError)) throw error;
        const hint = (error.hint ?? "Fix the cause shown above.").replace(/\.$/, "");
        throw new OpsCrewError(error.code, error.message, {
          hint: `${hint}, or \`${COMMAND} --no-snapshot\` to remove it without the final dump.`,
          cause: error,
        });
      }
      if (answer.result !== "done" || answer.dump === undefined || !DUMP.test(answer.dump)) {
        const why =
          answer.reason ?? (answer.result === "done" ? "it named no dump" : answer.result);
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `The agent didn't take the final dump of the database: ${why}.`,
          {
            hint: "`opscrew logs` shows the agent's lines. To remove the app without the dump, run `opscrew destroy --no-snapshot`.",
          },
        );
      }
      await ctx.made({ kind: "file", key: `${folder}/dumps/${answer.dump}` });
      // The snapshot's copy of the shared files, when it has one, is kept with its dump.
      if (answer.shared !== undefined && SHARED_COPY.test(answer.shared)) {
        await ctx.made({ kind: "file", key: `${folder}/dumps/${answer.shared}` });
      }
      return;
    }
    case "app": {
      const note = await selectorApp(filesOf(ctx), folder, "destroy", {
        hash: ctx.approvedHash,
        now: ctx.now(),
        sleep: ctx.sleep,
      });
      if (note !== undefined) state.outcome.left.push(note);
      return ctx.forget((o) => o.kind === "app");
    }
    case "cron":
      await panel.removeCron(step.key);
      return ctx.forget((o) => o.kind === "cron" && o.key === step.key);
    case "hostname":
      await panel.removeHostname(step.hostname);
      // Its PHP version goes with it, set by OpsCrew or by the user at OpsCrew's request.
      return ctx.forget(
        (o) =>
          ((o.kind === "hostname" || o.kind === "php") && o.key === step.hostname) ||
          (o.kind === "panel-step" && o.key.startsWith("php:")),
      );
    case "link":
      await filesOf(ctx).remove(step.path);
      return ctx.forget((o) => o.kind === "link" && o.key === step.path);
    case "certificate":
      try {
        await panel.removeCertificate(step.id);
      } catch (error) {
        // The connector refuses one still installed for another site: it stays that site's.
        const installed =
          error instanceof OpsCrewError &&
          error.code === "INVALID_INPUT" &&
          STILL_INSTALLED.test(error.message);
        if (!installed) throw error;
        state.outcome.kept.push(error.message);
      }
      return ctx.forget((o) => o.kind === "certificate" && o.key === step.id);
    case "database":
      await panel.removeDatabase({ name: step.name, user: step.user });
      state.databases.push({ name: step.name, user: step.user });
      return ctx.forget((o) => o.kind === "database" && o.key === step.name);
    case "folder": {
      const files = filesOf(ctx);
      const kept = step.keepDump
        ? finalDumps(await ctx.recorded(), step.path).map((o) => posix.basename(o.key))
        : [];
      if (step.keepDump && kept.length === 0) {
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          `OpsCrew can't tell which file in ~/${step.path}/dumps/ is the final dump: the final dump isn't recorded; nothing in the folder was removed.`,
          {
            hint: `Download what you want to keep from ~/${step.path}/dumps/ in the panel's File Manager, then run \`${COMMAND} --no-snapshot\` to remove the folder.`,
          },
        );
      }
      if (step.keepDump) {
        for (const name of (await files.list(step.path)) ?? []) {
          if (name !== "dumps") await files.remove(`${step.path}/${name}`);
        }
        for (const name of (await files.list(`${step.path}/dumps`)) ?? []) {
          if (!kept.includes(name)) await files.remove(`${step.path}/dumps/${name}`);
        }
        state.outcome.dumps.push(...kept);
      } else {
        await files.remove(step.path);
        const parent = posix.dirname(step.path);
        if ((await files.list(parent))?.length === 0) await files.remove(parent);
      }
      return ctx.forget(
        (o) =>
          (o.kind === "folder" && o.key === step.path) ||
          (o.kind === "file" && o.key.startsWith(`${step.path}/`)),
      );
    }
    case "dns":
      return ctx.dns();
    case "deploy-key": {
      const { api, owner, repo } = githubOf(ctx);
      if (api.removeDeployKey === undefined) throw new Error("GitHub can't remove deploy keys.");
      await api.removeDeployKey(owner, repo, Number(step.id));
      return ctx.forget((o) => o.kind === "deploy-key" && o.key === step.id);
    }
    case "branch": {
      const { api, owner, repo } = githubOf(ctx);
      if (api.deleteBranch === undefined) throw new Error("GitHub can't delete branches.");
      await api.deleteBranch(owner, repo, step.branch);
      return;
    }
    case "panel-step":
      return ctx.forget((o) => o.kind === step.object.kind && o.key === step.object.key);
    default:
      return step satisfies never;
  }
}

/** How the Cloudflare part of the teardown words the hosting account. */
const DNS_WORDS: CloudflareRemovalWords = {
  what: "DNS record on Cloudflare",
  place: "the hosting account",
  tunnelAfter: "",
  stays: "Everything on the hosting account that OpsCrew didn't make stays as it is.",
};

/**
 * `opscrew destroy` for an app on a hosting account with a panel (027 plan 6, FR-2707), each change
 * only after the one before it succeeded:
 * 1. something to remove: the record lists objects OpsCrew made, or the plan is provisioned;
 * 2. the panel (the account recorded at provision), Cloudflare when the domain is there, and
 *    GitHub (optional: without it, what it holds is listed under what remains);
 * 3. a preview of the DNS records' destroy plan, when there is infrastructure state here;
 * 4. the destroy plan ({@link buildHostingDestroyPlan}): saved as
 *    `.opscrew/plans/hosting-<env>-destroy.json`, shown, and approved by its hash
 *    (`hosting-apply`, `allowDestroy`, the hostname typed). The final dump is offered in it
 *    (`snapshot: false`, `--no-snapshot`, leaves it out); a database no agent can dump any more is
 *    said before the approval;
 * 5. the DNS records' destroy plan approved (`iac-apply`, `allowDestroy`, the hostname typed);
 * 6. the destroy plan applied ({@link applyHostingDestroy}), the DNS records at its `dns` step;
 * 7. the release signing key in GitHub (`removeDeploySecrets`, its own `github-secrets` approval),
 *    then OpsCrew's record of the deployment.
 * A refusal or failure leaves everything after it as it was; running it again continues. An
 * SFTP-only host has its own (`destroySftp`).
 */
export async function destroyHosting(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
  services: HostingAccountServices = {},
): Promise<DestroyResult> {
  if (hostingTarget(plan).panel === "sftp") return destroySftp(deps, plan, options);
  const destroyServices = options.services ?? {};
  const sleep = destroyServices.sleep ?? realSleep;

  // 1.–2. Something to remove, and the access.
  const recorded = await readHostingRecord(deps.paths);
  if (!hasDeployment(plan) && (recorded?.objects.length ?? 0) === 0) throw nothingDeployed(plan);
  const cloudflare = plan.dns.provider === "cloudflare";
  deps.reporter.step(
    `Checking your hosting account${cloudflare ? ", Cloudflare" : ""} and GitHub access`,
  );
  const reach = await reachHostingAccount(deps, plan, services);
  const { panel, files, record, folder, hostname, account } = reach;
  await checkCloudflare(deps, plan, destroyServices);
  const github = await resolveGitHub(deps, destroyServices);
  const name = PANEL_NAMES[panel.kind];

  // 3. The DNS records' destroy plan, previewed.
  const scope: DeletionScope = {
    deps,
    provider: "hosting",
    app: hostname,
    command: COMMAND,
    what: "teardown",
    phase: "provision",
  };
  let dns:
    | { session: DeletionSession; confirmed: ReadonlySet<string>; records: number }
    | undefined;
  if (cloudflare && (await exists(tfstateFile(deps.paths)))) {
    await requireInfraCode(deps, plan, "the removal of the hostname's DNS record");
    const setup = await setupEngine(deps, plan, options);
    const session = deletionSession(scope, {
      ...setup,
      dir: join(deps.paths.root, plan.infra.dir),
    });
    const preview = await previewCloudflareRemoval(session, DNS_WORDS);
    dns = { session, confirmed: preview.confirmed, records: preview.resources.length };
  }

  // 4. The destroy plan, approved with the hostname typed.
  const finalDump = options.snapshot !== false;
  const destroyPlan = buildHostingDestroyPlan({
    header: { panel: panel.kind, account, environment: environmentOf(plan), hostname, folder },
    panel,
    files,
    record,
    finalDump,
    dnsRecords: dns?.records ?? 0,
    github,
    releaseBranch: releaseBranch(plan),
  });
  const database = record.objects.find((o) => o.kind === "database");
  if (
    finalDump &&
    database !== undefined &&
    finalDumps(record.objects, folder).length === 0 &&
    !destroyPlan.steps.some((step) => step.kind === "dump")
  ) {
    deps.reporter.warn(
      `OpsCrew can't take a final dump of the database ${database.key}: ${files === undefined ? `${name}'s API can't reach the account's files` : "the agent's cron line is gone, so no agent runs to take it"}. The destroy removes it without one; cancel now and export it in ${name} first if you want to keep its data.`,
    );
  }
  const hash = hostingDestroyHash(destroyPlan);
  let approval: ApprovalRecord | undefined;
  if (destroyPlan.steps.length > 0) {
    const details = describeHostingDestroy(destroyPlan, hash);
    deps.reporter.info(details);
    await writeFileAtomic(
      join(deps.paths.files.plansDir, `hosting-${destroyPlan.environment}-destroy.json`),
      `${JSON.stringify(destroyPlan, null, 2)}\n`,
    );
    approval = await deps.approvals.request({
      kind: "hosting-apply",
      title: `Remove ${hostname} from the ${name} account ${account} (${plural(destroyPlan.steps.length, "step")})`,
      details,
      planHash: hash,
      allowDestroy: true,
      confirmPhrase: hostname,
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The teardown was not approved${refusalReason(approval)}. Nothing was changed.`,
        { hint: typeNameHint(hostname) },
      );
    }
    await deps.approvals.assertApprovedHostingPlan(hash, { allowDestroy: true });
  } else {
    deps.reporter.info(
      "Nothing OpsCrew made is left on the hosting account; it finishes the cleanup.",
    );
  }

  // 5. The DNS records' destroy plan, approved before anything changes.
  const removal =
    dns !== undefined && dns.records > 0
      ? await approveCloudflareRemoval(dns.session, {
          confirmed: dns.confirmed,
          appChanges: false,
          words: DNS_WORDS,
        })
      : undefined;

  // 6. The destroy plan, applied in its order.
  let destroyed: ResourceChange[] = [];
  let outcome: HostingDestroyOutcome = { applied: [], dumps: [], kept: [], left: [] };
  if (destroyPlan.steps.length > 0) {
    deps.reporter.step(`Removing the app from the ${name} account`);
    const audit = (action: string, decision: "approved" | "refused", detail: string) =>
      deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action,
        phase: "provision",
        target: hash,
        decision,
        detail,
      });
    await audit(
      "hosting destroy started",
      "approved",
      destroyPlan.steps.map((step) => step.kind).join(", "),
    );
    let dnsDone = false;
    try {
      outcome = await applyHostingDestroy(destroyPlan, {
        panel,
        files,
        github,
        made: async (object) => {
          await recordObject(deps.paths, object);
        },
        recorded: async () => (await readHostingRecord(deps.paths))?.objects ?? [],
        forget: async (match) => {
          await updateHostingRecord(deps.paths, (current) => ({
            ...current,
            objects: current.objects.filter((object) => !match(object)),
          }));
        },
        dns: async () => {
          if (dns === undefined || removal === undefined) return;
          dnsDone = true;
          destroyed = await applyCloudflareRemoval(dns.session, removal, sleep);
        },
        sleep,
        now: () => deps.clock.now(),
        approvedHash: hash,
      });
    } catch (error) {
      if (removal !== undefined && !dnsDone) await discardPlan(removal.summary);
      const done = error instanceof HostingDestroyError ? error.applied : [];
      for (const kind of done) await audit(`hosting removal ${kind}`, "approved", "destroy");
      await audit(
        "hosting destroy failed",
        "refused",
        `steps taken before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
      );
      throw error;
    }
    for (const kind of outcome.applied) {
      await audit(`hosting removal ${kind}`, "approved", "destroy");
    }
    deps.reporter.success(`Removed ${hostname} from the ${name} account.`);
  }

  // 7. The release signing key in GitHub, and OpsCrew's record.
  const secretsRemoved = await removeDeploySecrets(deps, github, {
    plan,
    done: `${hostname} is removed from the ${name} account.`,
    reach: "the agent on the hosting account",
  });
  if (github.api !== undefined) {
    await updateHostingRecord(deps.paths, (current) => ({
      ...current,
      objects: current.objects.filter((object) => object.kind !== "signing-key"),
    }));
  }
  await recordTeardown(deps, plan, [approval, removal?.approval], {
    summary: "app removed from the hosting account",
    forgetAddress: false,
  });
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: plan.app.name,
    detail: `app removed from the hosting account: ${plural(outcome.applied.length, "step")} taken, ${plural(secretsRemoved.length, "deploy secret")} removed`,
  });

  // What remains.
  const repoFiles = await deploymentFiles(deps, plan);
  const remaining = [
    ...outcome.dumps.map(
      (dump) =>
        `${SHARED_COPY.test(dump) ? "The final copy of the app's shared files" : "The final dump of the database"}, ~/${folder}/dumps/${dump}: download it in ${name}'s File Manager. ~/${folder}/ and ~/${posix.dirname(folder)}/ stay because they hold it.`,
    ),
    ...outcome.kept.map((why) => `A certificate the hostname had stays: ${why}`),
    ...outcome.left.map((note) => `Of the app in CloudLinux's selector: ${note}.`),
    ...appLeft(record, destroyPlan),
    ...destroyPlan.steps.flatMap((step) =>
      step.kind === "panel-step"
        ? [
            `In ${name}, unless you did it already: ${step.step.what}${step.step.value === undefined ? "" : `: ${step.step.value}`} (${step.step.where}).`,
          ]
        : [],
    ),
    ...deploySecretsLeft(github, { plan, removed: secretsRemoved }),
    ...(github.skipReason === undefined
      ? []
      : [
          `On GitHub, the agent's read-only deploy key (the repository's Settings → Deploy keys) and the release branch ${releaseBranch(plan)}: OpsCrew did not remove them because ${github.skipReason}.`,
        ]),
    `The deployment files in the repository (${repoFiles.folder}/ and ${plan.cicd.workflowPath}). Pushes still run the workflow, but nothing on the account deploys them until \`${repoFiles.provision}\` sets it up again.`,
    `The panel's token (${HOSTING_TOKEN_VAR}): OpsCrew never deletes tokens. Delete it in ${name} if nothing else uses it.`,
  ];
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return { destroyed, secretsRemoved, remaining };
}
