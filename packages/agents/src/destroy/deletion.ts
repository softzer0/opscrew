import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApprovalRecord,
  AppServer,
  IacEngine,
  PhaseName,
  PlanSummary,
  ResourceChange,
  ServerSnapshotApi,
  SnapshotRequest,
  VpsProviderId,
} from "@opscrew/contracts";
import {
  isUserFacingError,
  listText,
  OpsCrewError,
  plural,
  readTextIfExists,
  upperFirst,
  writeFileAtomic,
} from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { providerProfile, type VpsConnectorOptions, vpsConnector } from "../providers";
import {
  describeChanges,
  nothingDeletedHint,
  type ProjectEngine,
  planStop,
  readValidJson,
  refusalReason,
} from "../shared";
import {
  type DeletionBounds,
  deletesServer,
  deletesUnconfirmedServer,
  deletionPlanProblems,
  type ExtraServerPrefix,
  type ModulePrefix,
  onServer,
  planHeading,
  removeHostKeys,
  serverIdsInPlan,
  unprotectPlanProblems,
} from "./checks";
import { type DestroyTexts, destroyTexts } from "./texts";
import type { DeletionProvider, DestroyPreview } from "./types";

const SNAPSHOT_TIMEOUT_MS = 15 * 60_000;

/**
 * Who deletes what, for the shared deletion steps of `opscrew destroy` and of a move's finish and
 * abort. Nothing here assumes the server is `module.server` or that the whole root is deleted.
 */
export interface DeletionScope {
  deps: PhaseDeps;
  /**
   * Where the deletion happens: the provider of the server being deleted (during a move: the old
   * or the new server's), a server the user owns, or the user's Portainer.
   */
  provider: DeletionProvider;
  /** The app name: typed to confirm, used to find the server and to name its snapshot. */
  app: string;
  /** The command that continues after a stop, e.g. `opscrew destroy` or `opscrew retarget --finish`. */
  command: string;
  /** The deletion in plain English, as in "the teardown deletes", e.g. `teardown`. */
  what: string;
  /** Phase recorded in audit entries. */
  phase: PhaseName;
}

/** A deletion of a provider's server, which may have snapshots and delete protection. */
type ServerScope = DeletionScope & { provider: VpsProviderId };

/** A deletion scope with an initialised engine for one root module. */
export interface DeletionSession extends DeletionScope {
  engine: IacEngine;
  /** Engine environment: provider tokens and `TF_ENCRYPTION`. Never logged. */
  env: Record<string, string | undefined>;
  /** Absolute root module directory. */
  dir: string;
  /** Prefix of this run's plan file names under `.opscrew/plans/`. */
  stamp: string;
}

/** The session of `scope` with the root module `dir` and its engine, stamped with this run's time. */
export function deletionSession<S extends DeletionScope>(
  scope: S,
  setup: ProjectEngine & { dir: string },
): S & DeletionSession {
  return {
    ...scope,
    ...setup,
    stamp: scope.deps.clock.now().toISOString().replace(/[:.]/g, "-"),
  };
}

/** Saves a plan under `.opscrew/plans/<stamp>-<suffix>.tfplan`; removes the file on failure. */
export async function savePlan(
  session: DeletionSession,
  suffix: string,
  options: { vars?: Readonly<Record<string, string>>; destroy?: boolean } = {},
): Promise<PlanSummary> {
  const file = join(session.deps.paths.files.plansDir, `${session.stamp}-${suffix}.tfplan`);
  try {
    return await session.engine.plan(session.dir, file, {
      env: session.env,
      ...(options.vars ? { vars: { ...options.vars } } : {}),
      ...(options.destroy ? { destroy: true } : {}),
    });
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
}

/** Deletes a plan file so it can never be applied later. */
export async function discardPlan(summary: PlanSummary): Promise<void> {
  await rm(summary.planFile, { force: true });
}

function lastLines(text: string, count = 8): string {
  return text.trim().split(/\r?\n/).slice(-count).join("\n");
}

/**
 * Applies an approved saved plan (the caller has asked for the approval and checked it with
 * `assertApprovedPlan`), audits the outcome and stops with the redacted log tail on failure.
 */
export async function applyApprovedPlan(
  session: DeletionSession,
  summary: Pick<PlanSummary, "planFile" | "planHash">,
  options: { allowDestroy: boolean; what: string; hint: string },
): Promise<void> {
  const { deps } = session;
  const audit = (ok: boolean) =>
    deps.audit.append({
      kind: "iac",
      actor: "opscrew",
      action: "apply",
      phase: session.phase,
      target: summary.planHash,
      decision: ok ? "approved" : "refused",
      detail: `${options.what}: ${ok ? "apply finished" : "apply failed"}`,
    });
  let result: Awaited<ReturnType<IacEngine["apply"]>>;
  try {
    result = await session.engine.apply(
      session.dir,
      summary.planFile,
      { approvedPlanHash: summary.planHash, allowDestroy: options.allowDestroy },
      { env: session.env },
    );
  } catch (error) {
    await audit(false);
    throw error;
  }
  await audit(result.ok);
  if (!result.ok) {
    const log = deps.redactor.redact(lastLines(result.log));
    throw new OpsCrewError("ENGINE_FAILED", `${upperFirst(options.what)} failed:\n${log}`, {
      hint: options.hint,
    });
  }
}

/** What a deletion would delete, from a preview plan that was discarded. */
export interface DeletionPreview {
  /** The planned changes (all deletes under the prefix when one was given). */
  changes: ResourceChange[];
  /** Their addresses: the set the user confirms ({@link DeletionBounds.confirmed}). */
  addresses: ReadonlySet<string>;
  /** True when the plan deletes (or replaces) the provider's server. */
  serverInState: boolean;
  /** That server's ids as the state records them (`serverIdsInPlan`); empty when not said. */
  serverIds: string[];
  /** The preview plan's JSON (`show -json`), for the ids under one module. */
  planJson: unknown;
}

/**
 * Plans the deletion to show what it deletes, then discards the plan file (a preview is never
 * applied). With `bounded`, the plan may only delete resources under its prefix (else it stops
 * with nothing changed and its hint); without, it is not checked here (a whole-root `destroy` plan
 * only deletes).
 */
export async function previewDeletion(
  session: DeletionSession,
  options: {
    suffix: string;
    vars?: Readonly<Record<string, string>>;
    destroy?: boolean;
    bounded?: { prefix: ModulePrefix; hint: string };
  },
): Promise<DeletionPreview> {
  const summary = await savePlan(session, options.suffix, {
    ...(options.vars ? { vars: options.vars } : {}),
    ...(options.destroy ? { destroy: true } : {}),
  });
  await discardPlan(summary);
  if (options.bounded !== undefined) {
    assertDeletionPlan(
      session,
      summary,
      { prefix: options.bounded.prefix },
      { note: "Nothing was changed.", hint: options.bounded.hint },
    );
  }
  const serverInState = deletesServer(summary.changes, session.provider);
  return {
    changes: summary.changes,
    addresses: new Set(summary.changes.map((change) => change.address)),
    serverInState,
    serverIds: serverInState ? serverIdsInPlan(summary.planJson, session.provider) : [],
    planJson: summary.planJson,
  };
}

/** Which bound a deletion plan broke (see {@link assertDeletionPlan}). */
export type DeletionProblem = "unbounded" | "unconfirmed" | "server";

/** What a stop of {@link assertDeletionPlan} says after its first sentence, and its hint. */
export interface DeletionStop {
  /** Follows the first sentence, for example `Nothing was deleted.` */
  note: string;
  hint: string;
}

/**
 * Stops with `PHASE_PRECONDITION` unless the deletion plan only deletes, only under
 * `bounds.prefix`, only addresses in `bounds.confirmed` and (when `serverIds` is non-empty) no
 * server other than those. `stop` words the stop: the same for every problem, or per problem.
 */
export function assertDeletionPlan(
  scope: Pick<DeletionScope, "provider" | "what">,
  summary: { changes: readonly ResourceChange[]; planJson?: unknown },
  bounds: DeletionBounds & { serverIds?: readonly string[] },
  stop: DeletionStop | ((problem: DeletionProblem) => DeletionStop),
): void {
  const problems = deletionPlanProblems(summary.changes, bounds);
  const fail = (problem: DeletionProblem, lead: string, lines: readonly string[] = []) => {
    const { note, hint } = typeof stop === "function" ? stop(problem) : stop;
    return planStop(`${lead}, so OpsCrew stopped. ${note}`, lines, hint);
  };
  const unbounded = [...new Set([...problems.notDeletes, ...problems.outsidePrefix])];
  if (unbounded.length > 0) {
    throw fail(
      "unbounded",
      bounds.prefix === undefined
        ? `The ${scope.what} plan would do more than delete`
        : `The ${scope.what} plan would do more than delete resources under ${bounds.prefix}`,
      unbounded,
    );
  }
  if (problems.unconfirmed.length > 0) {
    throw fail(
      "unconfirmed",
      `The ${scope.what} plan now deletes resources that were not in the list you confirmed`,
      problems.unconfirmed,
    );
  }
  const ids = bounds.serverIds ?? [];
  // A Portainer or server-less root holds no server to compare.
  if (onServer(scope.provider) && deletesUnconfirmedServer(summary, scope.provider, ids)) {
    const noun = destroyTexts(scope.provider).noun;
    throw fail(
      "server",
      `The ${scope.what} plan now deletes a ${noun} other than the one you confirmed (id ${ids.join(", ")})`,
    );
  }
}

/**
 * The typed confirmation: asks `confirm` once with the preview (skipped without a hook or when
 * nothing would be deleted or changed), audits the answer and stops with `APPROVAL_REFUSED`
 * (nothing changed) when it is not given. On a server the user owns, in their Portainer and on a
 * server-less target the app's name is typed, and the changes there (`hostSteps`, `stackChanges`,
 * `pagesChanges`) count as well, as does the Cloudflare plan for OpsCrew's shared rules
 * (`cloudflarePlan`).
 */
export async function confirmDeletion(
  scope: DeletionScope,
  preview: DestroyPreview,
  confirm: ((preview: DestroyPreview) => Promise<boolean>) | undefined,
): Promise<void> {
  const elsewhere =
    preview.hostSteps !== undefined
      ? { changes: preview.hostSteps, where: "on your server" }
      : preview.stackChanges !== undefined
        ? { changes: preview.stackChanges, where: "in your Portainer" }
        : preview.pagesChanges !== undefined
          ? { changes: preview.pagesChanges, where: "in GitHub Pages" }
          : undefined;
  const changes = elsewhere?.changes.length ?? 0;
  const shared = preview.cloudflarePlan !== undefined;
  if (confirm === undefined || (preview.resources.length === 0 && changes === 0 && !shared)) return;
  const confirmed = await confirm(preview);
  const resources = plural(preview.resources.length, "resource");
  const rules = shared ? ", and this app's hostnames in OpsCrew's shared Cloudflare rules" : "";
  await scope.deps.audit.append({
    kind: "approval",
    actor: "user",
    action: "destroy-confirm",
    phase: scope.phase,
    target: preview.name,
    decision: confirmed ? "approved" : "refused",
    detail:
      elsewhere === undefined
        ? `typed confirmation for deleting ${resources}${rules}`
        : `typed confirmation for deleting ${resources} and ${plural(changes, "change")} ${elsewhere.where}${rules}`,
  });
  if (!confirmed) {
    const noun =
      onServer(preview.provider) && preview.provider !== "own"
        ? destroyTexts(preview.provider).noun
        : "app";
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The ${noun} name was not confirmed, so nothing was deleted and nothing was changed.`,
      { hint: `Run \`${scope.command}\` again and type ${preview.name} when asked.` },
    );
  }
}

/**
 * Which run's snapshot record a snapshot belongs to. Each purpose has its own record
 * (`.opscrew/<purpose>-snapshot.json`), so a move's finish never reuses a snapshot an earlier,
 * stopped `opscrew destroy` took of the same server (it would miss everything written since).
 */
export type SnapshotPurpose = "destroy" | "retarget";

/**
 * Where a run of `purpose` remembers its snapshot so that a re-run reuses it: the app's server's,
 * or with `server` (an extra server's name at the provider) that server's.
 */
export function snapshotRecordPath(
  deps: Pick<PhaseDeps, "paths">,
  purpose: SnapshotPurpose,
  server?: string,
) {
  const suffix = server === undefined ? "" : `-${server}`;
  return join(deps.paths.stateDir, `${purpose}-snapshot${suffix}.json`);
}

/** Forgets the snapshot record of `purpose` (after the deletion completed): the app's or `server`'s. */
export async function removeSnapshotRecord(
  deps: Pick<PhaseDeps, "paths">,
  purpose: SnapshotPurpose,
  server?: string,
): Promise<void> {
  await rm(snapshotRecordPath(deps, purpose, server), { force: true });
}

/** The snapshot record, `{ provider, serverId, snapshotId, takenAt }`. */
const SnapshotRecordSchema = z.looseObject({
  provider: z.string(),
  serverId: z.string().min(1),
  snapshotId: z.string().min(1),
});

/** The snapshot an earlier run recorded, or `undefined` when there is none or it is damaged. */
function readSnapshotRecord(
  deps: PhaseDeps,
  purpose: SnapshotPurpose,
  server: string | undefined,
): Promise<z.infer<typeof SnapshotRecordSchema> | undefined> {
  return readValidJson(snapshotRecordPath(deps, purpose, server), SnapshotRecordSchema);
}

/** Whether a snapshot is taken first (`auto`: when data lives only on the server). */
export function snapshotWanted(
  choice: "auto" | boolean | undefined,
  data: { serverData: boolean; backups: boolean },
): boolean {
  const resolved = choice ?? "auto";
  return resolved === "auto" ? data.serverData || data.backups : resolved;
}

/** `20261011T120000Z`: a Hetzner label value (no colons), also used in the snapshot name. */
function labelTime(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

/** Plain-English reason of a failed call (`unexpected error` for a bug), without a trailing full stop. */
export function failureReason(error: unknown): string {
  return (isUserFacingError(error) ? error.message : "unexpected error").replace(/[.\s]+$/, "");
}

/** ` The snapshot (…) was kept; …` after a stop, or nothing without a snapshot. */
export function snapshotKeptNote(texts: DestroyTexts, snapshotId: string | undefined): string {
  return snapshotId === undefined
    ? ""
    : ` The snapshot (${texts.snapshotRef(snapshotId)}) was kept; delete it in ${texts.console} if you do not need it.`;
}

/** Input of {@link takeSnapshotBeforeDelete}. */
export interface SnapshotBeforeDeleteInput {
  /** Whether the confirmed deletion deletes the server, and its ids from the plan JSON. */
  server: { inState: boolean; ids: readonly string[] };
  /** `--snapshot` (true), `--no-snapshot` (false) or `auto` (default). */
  choice?: "auto" | boolean;
  /**
   * What lives only on the server: a component's data (`serverData`) and the provider's
   * backups; with `auto` a snapshot is taken when either is true.
   */
  data: { serverData: boolean; backups: boolean };
  /** Which record to reuse and write. */
  purpose: SnapshotPurpose;
  /**
   * An extra server's name at the provider (`<app>-<name>`): matched when the plan does not say
   * its id, named in the snapshot and its texts, with a snapshot record of its own. Default the
   * app's server.
   */
  name?: string;
  /** Server lookup and snapshots (default: the provider connector's `servers`). */
  servers?: ServerSnapshotApi;
  /** Delay between snapshot status polls (passed to the default connector). */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in epoch milliseconds for the snapshot wait (passed to the default connector). */
  now?: () => number;
}

/**
 * The snapshot step failed, so nothing is deleted. After `snapshotServer` was called, whether the
 * provider had already started the snapshot is unknown (the connector starts and waits in one
 * call), so the hint covers both; `started` is false when the step failed before that call.
 */
function snapshotFailed(scope: ServerScope, error: unknown, started = true): OpsCrewError {
  const texts = destroyTexts(scope.provider);
  const { command } = scope;
  return new OpsCrewError(
    "PROVIDER_ERROR",
    scope.deps.redactor.redact(
      `The snapshot of ${scope.app} failed: ${failureReason(error)}. Nothing was deleted.`,
    ),
    {
      hint: started
        ? `Check the ${texts.noun} and its snapshots in ${texts.console} (a snapshot may still be finishing). Then run \`${command}\` again, or \`${command} --no-snapshot\` once you have a snapshot or do not need one.`
        : `Check the ${texts.noun} in ${texts.console}, then run \`${command}\` again, or \`${command} --no-snapshot\` to delete without a snapshot.`,
    },
  );
}

/** The provider's server API and the app's servers as it reports them; a failed lookup stops. */
async function findServers(
  scope: ServerScope,
  input: SnapshotBeforeDeleteInput,
): Promise<{ api: ServerSnapshotApi; found: AppServer[] }> {
  const { deps, provider } = scope;
  const texts = destroyTexts(provider);
  const options: VpsConnectorOptions = {
    ...(input.sleep ? { sleep: input.sleep } : {}),
    ...(input.now ? { now: () => new Date((input.now as () => number)()) } : {}),
  };
  const api = input.servers ?? vpsConnector(provider, deps, options).servers;
  if (!api) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No ${texts.displayName} token found: set ${providerProfile(provider).tokenVars.join(" or ")}.`,
      { hint: texts.tokenHint(scope.command) },
    );
  }
  try {
    return { api, found: await api.findAppServers(scope.app) };
  } catch (error) {
    throw snapshotFailed(scope, error, false);
  }
}

/**
 * The server to snapshot: the one with the id the infrastructure state records for the server
 * the deletion deletes. Names need not be unique (an orphan from lost state, a second checkout),
 * so the name is only used when the plan does not say the id, and only when exactly one server has
 * it. Anything else stops the run before anything is changed.
 */
function serverToSnapshot(
  scope: ServerScope,
  found: readonly AppServer[],
  stateId: string | undefined,
): AppServer {
  const texts = destroyTexts(scope.provider);
  const { noun, displayName } = texts;
  const { app: name, what } = scope;
  const lookup = texts.lookup(name);
  const yourself = `take a snapshot there yourself, then run \`${scope.command} --no-snapshot\`.`;
  if (stateId !== undefined) {
    const server = found.find((s) => s.id === stateId);
    if (server) return server;
  } else {
    const named = found.filter((s) => s.name === name);
    if (named.length === 1 && named[0]) return named[0];
    if (named.length > 1 || found.length > 1) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        named.length > 1
          ? `Several ${noun}s ${lookup} are named ${name}, and the infrastructure state does not say which one the ${what} deletes, so OpsCrew cannot tell which one to snapshot. Nothing was changed.`
          : `Several ${noun}s are ${lookup} and none is named ${name}, so OpsCrew cannot tell which one to snapshot. Nothing was changed.`,
        { hint: `Check the ${noun}s in ${texts.console}, ${yourself}` },
      );
    }
  }
  // The confirmed deletion deletes the server, so going on without its snapshot loses data.
  const missing =
    stateId !== undefined
      ? `no ${noun} ${lookup} has the id ${stateId} that the infrastructure state records`
      : `no ${noun} ${lookup} has that name`;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew could not find the ${noun} ${name} in ${displayName}: ${missing}, so it cannot take the snapshot before the ${what} deletes it. Nothing was changed.`,
    {
      hint: `Check the ${noun} in ${texts.console} (\`opscrew drift\` shows what changed outside OpsCrew). If it still exists, ${yourself}`,
    },
  );
}

/**
 * Snapshot of the server through the provider's `ServerSnapshotApi` before it is deleted, when one
 * is wanted and the confirmed deletion deletes the server, chosen by the id the infrastructure
 * state records (`input.server.ids`). Reuses the snapshot an earlier run of the same purpose took
 * of the same server on the same provider, and still reports it when that run already deleted the
 * server. Every snapshot attempt is audited, the record is written once the snapshot is ready, and
 * any failure stops the run before anything is deleted. Returns the snapshot id.
 */
export async function takeSnapshotBeforeDelete(
  appScope: ServerScope,
  input: SnapshotBeforeDeleteInput,
): Promise<string | undefined> {
  // The app's servers are looked up by the app (`appScope`); an extra server is named on its own.
  const scope = input.name === undefined ? appScope : { ...appScope, app: input.name };
  const { deps, provider, app: name, what } = scope;
  const texts = destroyTexts(provider);
  const { noun, displayName } = texts;
  const target = input.server;
  const recorded = await readSnapshotRecord(deps, input.purpose, input.name);
  const earlier = recorded?.provider === provider ? recorded : undefined;

  if (!target.inState && earlier) {
    // An earlier run took the snapshot and deleted the server, then stopped (for example at the
    // secret cleanup): the snapshot still exists and stays in the report.
    deps.reporter.info(
      `The snapshot taken by the earlier run is kept (${texts.snapshotRef(earlier.snapshotId)}).`,
    );
    return earlier.snapshotId;
  }
  if (!snapshotWanted(input.choice, input.data)) {
    deps.reporter.info(
      input.choice === false
        ? "Skipping the snapshot, as requested."
        : `No snapshot: no service keeps data on the ${noun} and ${texts.company} backups are off.`,
    );
    return undefined;
  }
  if (!target.inState) {
    // Nothing deletes it, and a snapshot that was not announced before the confirmation is not
    // taken. The lookup only words the note, so a failed one never blocks the cleanup of the rest.
    const found = await findServers(appScope, input).then(
      (result) => result.found,
      () => undefined,
    );
    deps.reporter.info(
      found === undefined
        ? `No snapshot: the ${what} does not delete the ${noun} ${name}, so no snapshot is taken.`
        : found.length === 0
          ? `No snapshot: the ${noun} ${name} no longer exists in ${displayName}, so there is nothing to keep.`
          : `No snapshot: the ${what} does not delete the ${noun} ${name}, so its data stays where it is.`,
    );
    return undefined;
  }
  if (target.ids.length > 1) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The ${what} deletes ${target.ids.length} ${noun}s (ids ${target.ids.join(", ")}), but OpsCrew only knows how to snapshot one, so it stopped. Nothing was changed.`,
      {
        hint: `Take snapshots in ${texts.console} yourself, then run \`${scope.command} --no-snapshot\`.`,
      },
    );
  }
  const { api, found } = await findServers(appScope, input);
  const server = serverToSnapshot(scope, found, target.ids[0]);

  // A run that stopped after its snapshot (refused, failed apply) reuses it on the next try.
  if (earlier && earlier.serverId === server.id) {
    deps.reporter.info(
      `Reusing the snapshot taken by the earlier run (${texts.snapshotRef(earlier.snapshotId)}).`,
    );
    return earlier.snapshotId;
  }

  deps.reporter.step(
    `Taking a snapshot of the ${noun} ${server.name} (this can take several minutes)`,
  );
  const takenAt = deps.clock.now();
  const stamp = labelTime(takenAt);
  const request: SnapshotRequest = {
    name: `opscrew-${name}-before-${input.purpose}-${stamp}`,
    description: `OpsCrew snapshot of ${name} before ${scope.command} (${takenAt.toISOString()})`,
    // Never `managed-by`, so that cleanups by that label keep the snapshot.
    labels: { app: name, "created-by": "opscrew", reason: input.purpose, "taken-at": stamp },
    timeoutMs: SNAPSHOT_TIMEOUT_MS,
  };
  // Audited before the call (so the log names it even if this process dies while waiting) and
  // again with the outcome: the snapshot id, or why it failed.
  const audit = (action: string, detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: scope.phase,
      target: `${provider} server ${server.id}`,
      detail: deps.redactor.redact(detail),
    });
  await audit("create snapshot", `snapshot ${request.name} of ${name} before ${input.purpose}`);
  let snapshotId: string;
  try {
    const result = await api.snapshotServer(server.id, request);
    snapshotId = typeof result?.snapshotId === "string" ? result.snapshotId.trim() : "";
    if (snapshotId === "") {
      throw new OpsCrewError("PROVIDER_ERROR", `${displayName} did not report the snapshot's id.`);
    }
  } catch (error) {
    await audit("snapshot failed", `snapshot ${request.name} of ${name}: ${failureReason(error)}`);
    throw snapshotFailed(scope, error);
  }
  await audit("snapshot ready", `snapshot ${snapshotId} of ${name} (${request.name})`);
  deps.reporter.success(`The snapshot of ${name} is ready (${texts.snapshotRef(snapshotId)}).`);
  const record = { provider, serverId: server.id, snapshotId, takenAt: takenAt.toISOString() };
  await writeFileAtomic(
    snapshotRecordPath(deps, input.purpose, input.name),
    `${JSON.stringify(record)}\n`,
  );
  return snapshotId;
}

/** How the approval request of {@link liftProtection} is titled, before the servers' names. */
export const LIFT_PROTECTION_TITLE = "Lift delete protection on ";

/** Input of {@link liftProtection}. */
export interface LiftProtectionInput {
  /**
   * The root module variables that turn the protection off, each `false`: `delete_protection` of
   * the app's server and `<name>_delete_protection` of each extra Hetzner server. None: nothing to
   * lift (DigitalOcean has no delete protection).
   */
  vars: Readonly<Record<string, string>>;
  /** The servers it lifts the protection of, by their names at the provider (default the app's). */
  names?: readonly string[];
  /** False when no protected server is in the state any more: nothing to lift, no plan. */
  serverInState: boolean;
  /** The modules of the extra servers it lifts: the plan may change nothing outside them. */
  within?: readonly ExtraServerPrefix[];
  /** The snapshot taken first, mentioned when the user refuses. */
  snapshotId?: string;
  /** Hint when the plan would change more than the protection. */
  mismatchHint: string;
}

/**
 * Lifts delete protection with a normal plan that sets `input.vars` and may only turn off
 * `delete_protection`/`rebuild_protection` of `hcloud_server` resources (values known only after
 * apply count as changes), after an `iac-apply` approval bound to its hash.
 * Returns whether protection is off now and the approval, when one was given. Without variables
 * (DigitalOcean has no delete protection) there is nothing to lift: no plan, no approval.
 */
export async function liftProtection(
  session: DeletionSession & ServerScope,
  input: LiftProtectionInput,
): Promise<{ off: boolean; approval?: ApprovalRecord }> {
  const { deps, command } = session;
  const name = listText([...(input.names ?? [session.app])]);
  if (Object.keys(input.vars).length === 0) return { off: false };
  if (!input.serverInState) {
    deps.reporter.info(
      "The server is no longer in the infrastructure state, so there is no delete protection to lift.",
    );
    return { off: false };
  }
  deps.reporter.step(`Planning to lift delete protection on ${name}`);
  const summary = await savePlan(session, "unprotect", { vars: input.vars });
  try {
    if (summary.changes.length === 0) {
      deps.reporter.info(`Delete protection on ${name} is already off.`);
      return { off: true };
    }
    const problems = unprotectPlanProblems(
      summary.changes,
      summary.planJson,
      input.within !== undefined ? { within: input.within } : {},
    );
    if (problems.length > 0) {
      throw planStop(
        `Lifting the delete protection on ${name} would also change other things, so OpsCrew stopped. Nothing was changed.`,
        problems,
        input.mismatchHint,
      );
    }
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `${LIFT_PROTECTION_TITLE}${name}`,
      details: [
        planHeading(summary),
        ...describeChanges(summary.changes),
        "This only turns off the server's delete and rebuild protection so that the next plan can delete it. Nothing is deleted yet.",
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `Delete protection on ${name} was not lifted${refusalReason(approval)}. Nothing was deleted.${snapshotKeptNote(destroyTexts(session.provider), input.snapshotId)}`,
        { hint: `Run \`${command}\` again when you are ready.` },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash);
    deps.reporter.step(`Lifting delete protection on ${name}`);
    await applyApprovedPlan(session, summary, {
      allowDestroy: false,
      what: "lifting delete protection",
      hint: nothingDeletedHint(command),
    });
    deps.reporter.success(`Delete protection on ${name} is off.`);
    return { off: true, approval };
  } finally {
    await discardPlan(summary);
  }
}

/**
 * Forgets the pinned SSH host keys of `hosts` (empty entries are ignored) in OpsCrew's
 * known_hosts; other hosts in the file are kept. Returns how many lines were removed.
 */
export async function forgetHostKeys(
  deps: Pick<PhaseDeps, "paths">,
  hosts: readonly (string | undefined)[],
): Promise<number> {
  const wanted = hosts.filter((host): host is string => host !== undefined && host !== "");
  if (wanted.length === 0) return 0;
  const file = deps.paths.files.knownHosts;
  const text = await readTextIfExists(file);
  if (text === undefined) return 0;
  const result = removeHostKeys(text, wanted);
  if (result.removed === 0) return 0;
  await writeFileAtomic(file, result.text, { mode: 0o644 });
  return result.removed;
}

/**
 * What the provider still keeps after a server was deleted, in plain English: the snapshot taken
 * first, and automatic backups the provider keeps after the deletion (DigitalOcean).
 */
export function remainingAfterDeletion(input: {
  provider: VpsProviderId;
  app: string;
  snapshotId?: string | undefined;
  /** Whether the deleted server had the provider's automatic backups on. */
  backups: boolean;
}): string[] {
  const texts = destroyTexts(input.provider);
  const items: string[] = [];
  if (input.snapshotId !== undefined) {
    items.push(
      `The snapshot of ${input.app} (${texts.snapshotRef(input.snapshotId)}). ${texts.snapshotBilling} and OpsCrew never deletes them; delete it in ${texts.console} when you no longer need it.`,
    );
  }
  if (input.backups && texts.keptBackupsRemaining) items.push(texts.keptBackupsRemaining);
  return items;
}
