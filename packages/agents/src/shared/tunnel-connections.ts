import { CLOUDFLARE_API } from "@opscrew/connector-cloudflare";
import type { ApprovalRecord, IacEngine, ResourceChange } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { PlanRefusedError } from "./approvals";

/**
 * Cloudflare refuses to delete a tunnel while its connector (`cloudflared`) is still connected
 * (error 1022). Wherever an approved plan deletes the app's tunnel, OpsCrew therefore removes the
 * connector on the server first (its own host approval, asked after the plan's approval and before
 * anything changes), then waits here with read-only calls until Cloudflare reports no active
 * connections, and only then applies the deletion.
 */

/** The resource type of a Cloudflare Tunnel in the infrastructure code. */
export const TUNNEL_RESOURCE_TYPE = "cloudflare_zero_trust_tunnel_cloudflared";

/** How long OpsCrew waits for the tunnel's connections to close (3 minutes). */
export const TUNNEL_CLOSE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;
const PROGRESS_EVERY_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when the plan deletes the Cloudflare Tunnel itself (not only its routes or records). */
export function deletesTunnel(
  changes: readonly Pick<ResourceChange, "type" | "action">[],
): boolean {
  return changes.some(
    (change) => change.type === TUNNEL_RESOURCE_TYPE && change.action === "delete",
  );
}

/** A tunnel as Cloudflare's API names it. */
export interface TunnelRef {
  accountId: string;
  tunnelId: string;
}

const ResourceChangeJson = z.looseObject({
  type: z.string(),
  mode: z.string().optional(),
  change: z.looseObject({
    actions: z.array(z.string()),
    before: z.looseObject({ id: z.string().min(1), account_id: z.string().min(1) }).nullish(),
  }),
});

/**
 * The tunnel the plan deletes, from the plan JSON (`resource_changes[].change.before`: the
 * tunnel's `id` and `account_id`, neither of them sensitive). `undefined` when it deletes none or
 * the plan JSON does not say.
 */
export function deletedTunnel(planJson: unknown): TunnelRef | undefined {
  const list = (planJson as { resource_changes?: unknown } | null)?.resource_changes;
  if (!Array.isArray(list)) return undefined;
  for (const entry of list) {
    const parsed = ResourceChangeJson.safeParse(entry);
    if (!parsed.success) continue;
    const { type, mode, change } = parsed.data;
    if (type !== TUNNEL_RESOURCE_TYPE || (mode !== undefined && mode !== "managed")) continue;
    if (!change.actions.includes("delete") || change.actions.includes("create")) continue;
    if (change.before == null) continue;
    return { accountId: change.before.account_id, tunnelId: change.before.id };
  }
  return undefined;
}

const TunnelResponse = z.looseObject({
  result: z
    .looseObject({
      status: z.string().nullish(),
      connections: z.array(z.unknown()).nullish(),
      conns_active_at: z.string().nullish(),
      conns_inactive_at: z.string().nullish(),
      deleted_at: z.string().nullish(),
    })
    .nullish(),
});

const ErrorResponse = z.looseObject({
  errors: z.array(z.looseObject({ code: z.number().optional(), message: z.string() })).optional(),
});

/** What Cloudflare reports about a tunnel's connections right now. */
export type TunnelConnections =
  | { state: "active" | "closed" | "gone" }
  | { state: "unknown"; problem: string };

/**
 * Reads the tunnel's connections with one read-only call
 * (`GET /accounts/{account}/cfd_tunnel/{id}`). Active while Cloudflare lists a connection or the
 * status is `healthy` or `degraded`; closed once the status is `down` or `inactive` (or, without a
 * status, once the tunnel has no connection since it was last active); gone when the tunnel is
 * deleted already. Only the state is kept: the response also holds the server's address.
 */
export async function readTunnelConnections(
  deps: Pick<PhaseDeps, "fetch" | "redactor" | "version">,
  tunnel: TunnelRef,
  token: string,
  baseUrl = CLOUDFLARE_API,
): Promise<TunnelConnections> {
  const url = `${baseUrl.replace(/\/$/, "")}/accounts/${encodeURIComponent(tunnel.accountId)}/cfd_tunnel/${encodeURIComponent(tunnel.tunnelId)}`;
  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": `opscrew/${deps.version}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { state: "unknown", problem: deps.redactor.redact(`the request failed: ${reason}`) };
  }
  if (response.status === 404) return { state: "gone" };
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const errors = ErrorResponse.safeParse(body);
    const message = errors.success ? errors.data.errors?.[0]?.message : undefined;
    return {
      state: "unknown",
      problem: deps.redactor.redact(
        `HTTP ${response.status}${message !== undefined ? `: ${message.slice(0, 200)}` : ""}`,
      ),
    };
  }
  const parsed = TunnelResponse.safeParse(body);
  if (!parsed.success || parsed.data.result == null) {
    return { state: "unknown", problem: "Cloudflare's answer did not describe the tunnel" };
  }
  const result = parsed.data.result;
  if (result.deleted_at != null) return { state: "gone" };
  const status = result.status ?? undefined;
  if (status === "healthy" || status === "degraded" || (result.connections ?? []).length > 0) {
    return { state: "active" };
  }
  if (status === "down" || status === "inactive") return { state: "closed" };
  if (result.conns_active_at == null || result.conns_inactive_at != null) {
    return { state: "closed" };
  }
  return { state: "active" };
}

/** Options of {@link waitForTunnelToClose}; the defaults are the real ones. */
export interface TunnelWaitOptions {
  sleep?: Sleep;
  timeoutMs?: number;
  intervalMs?: number;
  progressEveryMs?: number;
  baseUrl?: string;
}

/** Outcome of {@link waitForTunnelToClose}. */
export interface TunnelWaitResult {
  closed: boolean;
  /** Why the last read told nothing (when every read until the timeout failed). */
  problem?: string;
}

/**
 * Polls the tunnel's connections (read-only, with `CLOUDFLARE_API_TOKEN`, which is registered
 * with the redactor) until Cloudflare reports none, for at most {@link TUNNEL_CLOSE_TIMEOUT_MS},
 * with a progress line about every 20 seconds. Without a token there is nothing to ask, so it
 * returns at once (the engine needs the token as well and says so).
 */
export async function waitForTunnelToClose(
  deps: Pick<PhaseDeps, "fetch" | "redactor" | "version" | "env" | "clock" | "reporter">,
  tunnel: TunnelRef,
  options: TunnelWaitOptions = {},
): Promise<TunnelWaitResult> {
  const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) return { closed: true };
  deps.redactor.addLiteral(token, "cloudflare-token");
  const sleep = options.sleep ?? realSleep;
  const timeoutMs = options.timeoutMs ?? TUNNEL_CLOSE_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const progressEveryMs = options.progressEveryMs ?? PROGRESS_EVERY_MS;
  const start = deps.clock.now().getTime();
  let slept = 0;
  // Slept time counts even when the clock stands still (a fixed clock in tests).
  const elapsed = () => Math.max(slept, deps.clock.now().getTime() - start);
  let lastProgress = 0;
  deps.reporter.step(
    `Waiting until Cloudflare reports no active connections for the app's Cloudflare Tunnel (up to ${minutes(timeoutMs)})`,
  );
  for (;;) {
    const read = await readTunnelConnections(deps, tunnel, token, options.baseUrl);
    if (read.state === "closed" || read.state === "gone") {
      deps.reporter.success("Cloudflare reports no active connections for the tunnel.");
      return { closed: true };
    }
    const problem = read.state === "unknown" ? read.problem : undefined;
    if (elapsed() >= timeoutMs)
      return problem !== undefined ? { closed: false, problem } : { closed: false };
    if (elapsed() - lastProgress >= progressEveryMs) {
      lastProgress = elapsed();
      deps.reporter.info(
        `Still waiting for Cloudflare to close the tunnel's connections (${Math.round(elapsed() / 1000)} s so far, up to ${minutes(timeoutMs)}).`,
      );
    }
    const wait = Math.max(1, Math.min(intervalMs, timeoutMs - elapsed()));
    await sleep(wait);
    slept += wait;
  }
}

function minutes(ms: number): string {
  const count = Math.max(1, Math.round(ms / 60_000));
  return `${count} minute${count === 1 ? "" : "s"}`;
}

/** Engine log text of Cloudflare refusing to delete a tunnel that still has connections. */
const ACTIVE_CONNECTIONS =
  /"code"\s*:\s*1022\b|\b1022\b[^\n]*active connections|tunnel has active connections/i;

/** True when an engine log (or error text) holds Cloudflare's error 1022. */
export function isTunnelBusyText(text: string): boolean {
  return ACTIVE_CONNECTIONS.test(text);
}

/**
 * The plain error when the tunnel still has active connections: after the wait timed out
 * (`reason: "timeout"`, nothing in Cloudflare was deleted), when OpsCrew could not read the
 * connections (`problem`), or when Cloudflare refused the deletion during the apply
 * (`reason: "refused"`, error 1022). `already` says what this run changed before (for example
 * "The app is removed from your server; its Cloudflare resources are still there.").
 */
export function tunnelBusyError(input: {
  command: string;
  reason: "timeout" | "refused";
  already?: string;
  problem?: string;
  timeoutMs?: number;
  cause?: unknown;
}): OpsCrewError {
  const wait = minutes(input.timeoutMs ?? TUNNEL_CLOSE_TIMEOUT_MS);
  const first =
    input.reason === "refused"
      ? "Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there."
      : input.problem !== undefined
        ? `OpsCrew could not read from Cloudflare whether the app's Cloudflare Tunnel still has active connections (${input.problem}), so it stopped before deleting it. Nothing in Cloudflare was deleted.`
        : `Cloudflare still reports active connections for the app's Cloudflare Tunnel after ${wait}, so OpsCrew stopped before deleting it. Nothing in Cloudflare was deleted.`;
  return new OpsCrewError(
    "PROVIDER_ERROR",
    [first, input.already].filter((part) => part !== undefined && part !== "").join(" "),
    {
      hint: `Run \`${input.command}\` again in a few minutes (the connections close on their own once the connector is gone); it continues with what is left.`,
      ...(input.cause !== undefined ? { cause: input.cause } : {}),
    },
  );
}

/** What the hooks know about the plan being approved and applied (a `SavedPlan` fits). */
export interface PlanToApply {
  /** The plan's hash (the one approved). */
  planHash: string;
  changes: readonly Pick<ResourceChange, "type" | "action">[];
  /** The plan JSON (sensitive values masked): names the tunnel's id and account. */
  planJson?: unknown;
}

/** An engine that notes an apply Cloudflare refused with error 1022 (see below). */
export interface TunnelSafeEngine extends IacEngine {
  /** True once an apply failed with Cloudflare's error 1022 (the tunnel still had connections). */
  readonly refusedBusyTunnel: boolean;
  /** True when that apply failed with nothing but the 1022 (every other change went through). */
  readonly onlyBusyTunnel: boolean;
}

/**
 * Wraps an engine for applies outside `planAndApply` (destroy's approved plans) so that an apply
 * that failed with Cloudflare's error 1022 is noted and the caller can say so in plain words.
 * Every call goes to `engine` unchanged.
 */
export function tunnelSafeEngine(engine: IacEngine): TunnelSafeEngine {
  let refused = false;
  let only = false;
  return {
    get info() {
      return engine.info;
    },
    get refusedBusyTunnel() {
      return refused;
    },
    get onlyBusyTunnel() {
      return only;
    },
    init: (dir, options) => engine.init(dir, options),
    validate: (dir, options) => engine.validate(dir, options),
    output: (dir, options) => engine.output(dir, options),
    plan: (dir, planFile, options) => engine.plan(dir, planFile, options),
    apply: async (dir, planFile, approval, options) => {
      const result = await engine.apply(dir, planFile, approval, options);
      if (!result.ok && isTunnelBusyText(result.log)) {
        refused = true;
        only = onlyTunnelBusy(result.log);
      }
      return result;
    },
  };
}

/**
 * Waits until the tunnel the plan deletes has no active connections; throws
 * {@link tunnelBusyError} when they do not close in time. Returns at once when the plan JSON does
 * not name the tunnel (then the apply itself tells, and a 1022 is translated by the caller).
 */
export async function requireTunnelClosed(
  deps: Pick<PhaseDeps, "fetch" | "redactor" | "version" | "env" | "clock" | "reporter">,
  plan: Pick<PlanToApply, "planJson">,
  input: { command: string; already?: string; options?: TunnelWaitOptions },
): Promise<void> {
  const tunnel = deletedTunnel(plan.planJson);
  if (tunnel === undefined) return;
  const result = await waitForTunnelToClose(deps, tunnel, input.options);
  if (result.closed) return;
  throw tunnelBusyError({
    command: input.command,
    reason: "timeout",
    ...(input.already !== undefined ? { already: input.already } : {}),
    ...(result.problem !== undefined ? { problem: result.problem } : {}),
    ...(input.options?.timeoutMs !== undefined ? { timeoutMs: input.options.timeoutMs } : {}),
  });
}

/** True when every error block of an engine log is Cloudflare's 1022 (nothing else failed). */
export function onlyTunnelBusy(log: string): boolean {
  const blocks: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    if (/^[\s│╷]*Error:/.test(line)) blocks.push(line);
    else if (blocks.length > 0) blocks[blocks.length - 1] += `\n${line}`;
  }
  return blocks.length > 0 && blocks.every((block) => isTunnelBusyText(block));
}

/** The outcome of a host change (a host plan shown, approved by its hash and applied). */
export interface HostChangeResult {
  hash: string;
  applied: boolean;
  approval?: ApprovalRecord;
}

/** Said before the host change that goes first. */
export const SERVER_GOES_FIRST =
  "Before applying it: the change on your server goes first, because Cloudflare deletes a tunnel only after its connector has stopped.";

/** The `planAndApply` hooks of {@link connectorFirst} (spread them into its options). */
export interface TunnelPlanHooks {
  /**
   * The approval's notes: the given ones, plus, when the plan deletes the tunnel, that the change
   * on the server is shown next and applied first.
   */
  approvalNotes: (plan: PlanToApply) => readonly string[];
  /** After the approval of a plan that deletes the tunnel: the host change, then the wait. */
  beforeApply: (plan: PlanToApply) => Promise<void>;
  /** Notes an apply Cloudflare refused with error 1022. */
  applyFailed: (log: string) => void;
}

/** {@link connectorFirst}: the hooks to plan and apply with, and what happened around them. */
export interface ConnectorFirst {
  hooks: TunnelPlanHooks;
  /** The host change, once it finished (in this run it may have had nothing left to change). */
  readonly host: HostChangeResult | undefined;
  /**
   * The error to show when the plan-and-apply stopped: Cloudflare's 1022 in plain words, and what
   * is already done once the host change finished.
   */
  stopped(error: unknown): unknown;
}

/**
 * `planAndApply` hooks so that a plan deleting the Cloudflare Tunnel is applied after the host
 * change that removes its connector: its approval says so; once it is approved, OpsCrew says so
 * again, shows the host change, asks for its own `host-apply` approval (by its hash) and applies
 * it (`hostChange`), then waits until Cloudflare reports no active connections and only then lets
 * the plan be applied. A plan that deletes no tunnel is approved and applied as usual. A refused
 * host change names both hashes to approve later; `done` is said whenever the host change
 * finished (even with nothing left to change in this run) but the deletion did not follow.
 */
export function connectorFirst(
  deps: Pick<PhaseDeps, "fetch" | "redactor" | "version" | "env" | "clock" | "reporter">,
  input: {
    command: string;
    app: string;
    /** Where the host change happens: `on your server`, `on the server`, `in your Portainer`. */
    where: string;
    /** The host change; a refused approval throws a {@link PlanRefusedError}. */
    hostChange: () => Promise<HostChangeResult>;
    /** The host change's plan hash once it was shown (for the hint after a refusal). */
    hostHash: () => string | undefined;
    done: string;
    sleep?: Sleep;
    notes?: readonly string[];
  },
): ConnectorFirst {
  const notes = input.notes ?? [];
  const note = `The change ${input.where} is shown next and applied first: Cloudflare deletes a tunnel only after its connector has stopped, so OpsCrew applies this plan after that.`;
  let host: HostChangeResult | undefined;
  let refusedBusy = false;
  /** True once {@link ConnectorFirst.stopped} added `done` to an engine error (said once). */
  let doneSaid = false;
  const refusedFirst = (error: unknown, planHash: string): unknown => {
    if (!(error instanceof PlanRefusedError)) return error;
    const hostHash = input.hostHash();
    return new PlanRefusedError(
      {
        ...error.refusal,
        unchanged: `Nothing ${input.where} was changed and nothing in Cloudflare was deleted.`,
        hint:
          hostHash !== undefined
            ? `Run \`${input.command} --approve ${planHash} --approve ${hostHash}\` when you are ready, typing ${input.app} to confirm: the change ${input.where} goes first, because Cloudflare deletes a tunnel only after its connector has stopped.`
            : `Run \`${input.command}\` again when you are ready; it shows both plans again.`,
      },
      error,
    );
  };
  const hooks: TunnelPlanHooks = {
    approvalNotes: (plan) =>
      deletesTunnel(plan.changes) && !notes.includes(note) ? [...notes, note] : notes,
    beforeApply: async (plan) => {
      if (!deletesTunnel(plan.changes)) return;
      deps.reporter.info(SERVER_GOES_FIRST);
      try {
        host = await input.hostChange();
      } catch (error) {
        throw refusedFirst(error, plan.planHash);
      }
      await requireTunnelClosed(deps, plan, {
        command: input.command,
        already: input.done,
        ...(input.sleep !== undefined ? { options: { sleep: input.sleep } } : {}),
      });
    },
    applyFailed: (log) => {
      if (isTunnelBusyText(log)) refusedBusy = true;
    },
  };
  return {
    hooks,
    get host() {
      return host;
    },
    stopped: (error) => {
      if (!(error instanceof OpsCrewError)) return error;
      if (refusedBusy) {
        return tunnelBusyError({
          command: input.command,
          reason: "refused",
          ...(host !== undefined ? { already: input.done } : {}),
          cause: error,
        });
      }
      if (host !== undefined && error.code === "ENGINE_FAILED" && !doneSaid) {
        doneSaid = true;
        return new OpsCrewError(error.code, `${error.message}\n${input.done}`, {
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
          cause: error,
        });
      }
      return error;
    },
  };
}
