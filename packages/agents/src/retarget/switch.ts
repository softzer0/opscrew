import { lookup } from "node:dns/promises";
import type { ApprovalRecord, FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { EDGE_DIR, EDGE_PROXIES, edgeProxy } from "@opscrew/iac-templates";
import { type DeployPlan, serviceOf } from "@opscrew/plan-schema";
import { z } from "zod";
import type { SavedPlan } from "../provision";
import {
  committableUrl,
  planStop,
  pollUntil,
  recordServerAddress,
  type ServerAddress,
  sameIp,
} from "../shared";
import { moveProvider } from "../shared/vps-target";
import { applyInfraPlan, type InfraPlanInput, prepareInfraPlan } from "./plans";
import { serverOps, startService, stopService } from "./server-ops";
import { oldServer } from "./servers";
import {
  auditMove,
  auditStep,
  type MoveSession,
  moveOf,
  newServer,
  saveMove,
  useLayout,
  waitsOf,
  withApply,
} from "./session";
import { pendingStop, reasonOf } from "./steps";
import {
  ABORT_COMMAND,
  FINISH_COMMAND,
  managedDns,
  providerWords,
  RUN_COMMAND,
  untilSwitched,
} from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";
import {
  asOpsCrewError,
  codeOf,
  hintOf,
  maintenanceWindow,
  newRemote,
  oldRemote,
  restartOldApp,
} from "./window";

const URL_WAIT_MS = 5 * 60_000;
const URL_INTERVAL_MS = 10_000;

/** Where the app answers after the switch: its domain, else the new server's address. */
function publicUrl(plan: DeployPlan, ipv4: string): string {
  return plan.dns.domain !== undefined ? `https://${plan.dns.domain}` : `http://${ipv4}`;
}

/** The DNS switch plan may only update the DNS records, in place. */
function assertDnsOnly(saved: Pick<SavedPlan, "changes" | "moves">): void {
  assertDnsUpdatesOnly(saved, {
    what: "DNS switch",
    hint: `The infrastructure no longer matches what OpsCrew applied. Run \`${ABORT_COMMAND}\` to undo the move, then \`opscrew drift\` to see the differences.`,
  });
}

/**
 * Stops unless every change of a plan is an in-place `update` of a record under `module.dns.`
 * (no creates, deletes or replacements, nothing outside DNS, no moves).
 */
export function assertDnsUpdatesOnly(
  saved: Pick<SavedPlan, "changes" | "moves">,
  wording: { what: string; hint: string },
): void {
  const problems = [
    ...saved.changes
      .filter((change) => !change.address.startsWith("module.dns.") || change.action !== "update")
      .map((change) => `${change.action} ${change.address}`),
    ...(saved.moves ?? []).map((move) => `move ${move.from} → ${move.to}`),
  ];
  if (problems.length === 0) return;
  throw planStop(
    `The ${wording.what} plan would do more than update the DNS records in place, so OpsCrew stopped. Nothing was changed.`,
    problems,
    wording.hint,
  );
}

/**
 * A failed (or refused) switch: the app on the old server runs again (when OpsCrew stopped it)
 * and the move goes back to `deployed`, so users are served while the cause is fixed. Returns the
 * error to throw.
 */
async function rollBackSwitch(session: MoveSession, cause: unknown): Promise<OpsCrewError> {
  const { plan } = session;
  const refused = cause instanceof OpsCrewError && cause.code === "APPROVAL_REFUSED";
  const what = refused ? "The switch was not approved" : `The switch failed: ${reasonOf(cause)}`;
  await auditMove(session, {
    kind: "phase",
    action: "retarget switch",
    decision: "refused",
    detail: refused ? "switch not approved" : `switch failed: ${reasonOf(cause)}`,
  });
  // Back before the window first: even if the old app cannot be started now, the next run starts
  // it (an open window before `migrated`) and copies the database again before switching.
  await saveMove(session, { ...moveOf(session), step: "deployed" });
  await auditStep(session, "deployed", "back to the step before the maintenance window");
  try {
    await restartOldApp(session, `${what}, and `);
  } catch (error) {
    return asOpsCrewError(error);
  }
  const again = serviceOf(plan, "postgres")
    ? `run \`${RUN_COMMAND}\` again (it repeats the maintenance window)`
    : `run \`${RUN_COMMAND}\` again`;
  // A failed apply may have updated some records before it stopped; they point at the new server,
  // whose web server is stopped. Continuing completes the switch; aborting points them back first.
  const next = session.servers.next;
  const partly =
    !refused && managedDns(plan) && next !== undefined
      ? ` Some DNS records of ${dnsHosts(plan).join(" and ")} may already point at the new server (${[next.ipv4, next.ipv6].filter(Boolean).join(", ")}), where the web server is stopped, so some visitors may get errors until you continue or abort: \`${RUN_COMMAND}\` completes the switch, \`${ABORT_COMMAND}\` points them back to the old server first.`
      : "";
  return new OpsCrewError(
    codeOf(cause),
    `${what}. The app on the old server runs again, and the move went back to the step before the maintenance window.${partly}`,
    {
      hint: `${hintOf(cause)}When you are ready, ${again}, or \`${ABORT_COMMAND}\` to undo the move.`,
    },
  );
}

/** The hostnames the DNS records serve. */
function dnsHosts(plan: DeployPlan): string[] {
  const domain = plan.dns.domain;
  if (domain === undefined) return [];
  return plan.dns.www ? [domain, `www.${domain}`] : [domain];
}

/**
 * Records the switch: the new server receives the traffic (its address in OpsCrew's local state
 * first, then the domain URL in `deployment`) and the step is `switched` (abort is over).
 */
async function recordSwitched(
  session: MoveSession,
  input: { url: string; applied?: { planHash: string; approval?: ApprovalRecord } },
): Promise<void> {
  const { deps } = session;
  const move = moveOf(session);
  const next = newServer(session);
  await recordServerAddress(deps.paths, next);
  const at = deps.clock.now().toISOString();
  const recorded = input.applied
    ? withApply(session.plan, input.applied, at)
    : { approvals: session.plan.approvals, deployment: session.plan.deployment };
  const { url: _previous, ...deployment } = recorded.deployment;
  // Without a domain the URL is the new server's IP address, which is never committed.
  const url = committableUrl(input.url);
  await saveMove(
    session,
    { ...move, step: "switched" },
    {
      approvals: recorded.approvals,
      deployment: { ...deployment, ...(url !== undefined ? { url } : {}) },
    },
  );
  await auditStep(session, "switched", `traffic goes to the new server ${next.ipv4}`);
}

const UrlSchema = z.url({ protocol: /^https?$/ });

/** The DNS change to make by hand, line by line. */
function manualRecords(plan: DeployPlan, next: ServerAddress) {
  const domain = plan.dns.domain;
  if (domain === undefined) {
    return [
      `The app's new address is http://${next.ipv4}. Tell your users (or update the links) to use it.`,
    ];
  }
  const hosts = plan.dns.www ? [domain, `www.${domain}`] : [domain];
  return [
    "Change these DNS records at your DNS provider:",
    ...hosts.flatMap((host) => [
      `  A     ${host} → ${next.ipv4}`,
      ...(next.ipv6 !== undefined ? [`  AAAA  ${host} → ${next.ipv6}`] : []),
    ]),
  ];
}

/**
 * Step 6 with Cloudflare: the switch plan is made (and, in scripts, approved by hash) before the
 * maintenance window, so no plan or prompt fails while the app is offline; then the window (with a
 * self-hosted database), then the apply. A failed or refused apply rolls back to `deployed`.
 */
async function switchManagedDns(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime">,
  windowAhead: boolean,
  next: ServerAddress,
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const fresh = providerWords(moveProvider(plan.target));
  const old = providerWords(move.from.target.provider);
  deps.reporter.step(`Planning the switch of ${plan.dns.domain} to the new ${fresh.noun}`);
  const files = await useLayout(session, "switched");
  const input: InfraPlanInput = {
    action: "switch",
    files,
    check: assertDnsOnly,
    // DNS records are not billed: the new server's price was shown with the plan that created it.
    costDelta: null,
    notes: [
      `This points ${plan.dns.domain} at the new ${fresh.noun}; the records are updated in place.`,
      `Then OpsCrew starts ${EDGE_PROXIES[edgeProxy(plan)].label} on the new ${fresh.noun}, checks the app through its domain and keeps the app on the old ${old.noun} stopped. After this the move can no longer be aborted.`,
    ],
  };
  const prepared = await prepareInfraPlan(session, input);
  if (prepared.kind === "pending") {
    // Resumed after the copy (`migrated`): the old app is stopped, so users are offline meanwhile.
    const offline =
      !windowAhead && moveOf(session).oldAppStoppedAt !== undefined
        ? [
            `The app on the old ${old.noun} is stopped (its database was copied to the new ${fresh.noun}), so your users are offline until this switch is applied. Apply it soon, or run \`${ABORT_COMMAND}\` to start the old app again and undo the move.`,
          ]
        : [];
    return pendingStop(
      session,
      prepared.planHash,
      windowAhead ? ["--allow-downtime"] : [],
      offline,
    );
  }
  if (windowAhead) {
    if (prepared.kind === "ready" && deps.interactive) {
      deps.reporter.info(
        `The DNS switch is planned (hash ${prepared.planHash}) and checked; OpsCrew shows it for your approval right after the database copy.`,
      );
    }
    const window = await maintenanceWindow(
      session,
      options,
      prepared.kind === "ready" ? prepared.planHash : undefined,
    );
    if (window !== "done") return window;
  }
  if (prepared.kind === "unchanged") {
    deps.reporter.info(`The DNS records of ${plan.dns.domain} already point to the new server.`);
    const url = UrlSchema.safeParse(prepared.outputs.url);
    await recordSwitched(session, { url: url.success ? url.data : publicUrl(plan, next.ipv4) });
    return undefined;
  }
  let applied: Awaited<ReturnType<typeof applyInfraPlan>>;
  try {
    applied = await applyInfraPlan(session, input, prepared.planHash);
  } catch (error) {
    throw await rollBackSwitch(session, error);
  }
  const url = UrlSchema.safeParse(applied.outputs.url);
  await recordSwitched(session, {
    url: url.success ? url.data : publicUrl(plan, next.ipv4),
    applied: {
      planHash: prepared.planHash,
      ...(applied.approval ? { approval: applied.approval } : {}),
    },
  });
  return undefined;
}

/**
 * Step 6 without managed DNS (`dns.provider` none, with or without a domain): after the window
 * the user changes the records (or the address users reach) and confirms: `dnsSwitched` in
 * scripts, an approval in a terminal. A refused confirmation rolls back to `deployed`.
 */
async function switchByHand(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime" | "dnsSwitched">,
  windowAhead: boolean,
  next: ServerAddress,
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  if (windowAhead) {
    const window = await maintenanceWindow(session, options);
    if (window !== "done") return window;
  }
  const fresh = providerWords(moveProvider(plan.target));
  const old = providerWords(move.from.target.provider);
  const records = manualRecords(plan, next);
  const url = publicUrl(plan, next.ipv4);
  if (options.dnsSwitched === true) {
    await auditMove(session, {
      kind: "approval",
      actor: "user",
      action: "dns-switched",
      target: next.ipv4,
      decision: "approved",
      detail: "the user confirmed the switch to the new server with --dns-switched",
    });
  } else if (deps.interactive) {
    const approval = await deps.approvals.request({
      kind: "remote-exec",
      title: `Switch ${plan.app.name} to the new ${fresh.noun} (${next.ipv4})`,
      details: [
        ...records,
        "",
        ...(moveOf(session).oldAppStoppedAt !== undefined
          ? [
              `The app on the old ${old.noun} is stopped (its database was copied), so your users are offline ${untilSwitched(plan)}.`,
            ]
          : []),
        `Confirm once you made this change. OpsCrew then starts ${EDGE_PROXIES[edgeProxy(plan)].label} on the new ${fresh.noun}, checks the app at ${url} and keeps the app on the old ${old.noun} stopped. After this the move can no longer be aborted.`,
      ].join("\n"),
    });
    if (!approval.approved) {
      throw await rollBackSwitch(
        session,
        new OpsCrewError("APPROVAL_REFUSED", "The switch was not confirmed."),
      );
    }
  } else {
    deps.reporter.info(records.join("\n"));
    const stoppedNote =
      moveOf(session).oldAppStoppedAt !== undefined
        ? [
            `The app on the old ${old.noun} is stopped (its database was copied), so users see an error until the new ${fresh.noun} takes over.`,
          ]
        : [];
    return {
      step: moveOf(session).step,
      done: false,
      next: [...stoppedNote, ...records, `Then run \`${RUN_COMMAND} --dns-switched\`.`],
    };
  }
  await recordSwitched(session, { url: `http://${next.ipv4}` });
  return undefined;
}

/**
 * Step 6: the switch from `deployed` (maintenance window first, with a self-hosted database) or
 * from `migrated` (the window is done). Returns a stop, or `undefined` once the step is
 * `switched`.
 */
export async function switchStep(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime" | "dnsSwitched">,
): Promise<RetargetResult | undefined> {
  // Stops before the window and the switch when the new server's address is unknown here.
  const next = newServer(session);
  const windowAhead =
    serviceOf(session.plan, "postgres") !== undefined && moveOf(session).step === "deployed";
  return managedDns(session.plan)
    ? switchManagedDns(session, options, windowAhead, next)
    : switchByHand(session, options, windowAhead, next);
}

/** Polls `url` until it answers with a 2xx status; false (with the last answer) on timeout. */
async function waitForUrl(
  fetch: FetchLike,
  url: string,
  waits: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<{ ok: boolean; last?: string }> {
  let last: string | undefined;
  const ok = await pollUntil(
    async () => {
      try {
        const response = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return true;
        last = `HTTP ${response.status}`;
      } catch (error) {
        last = reasonOf(error);
      }
      return undefined;
    },
    { timeoutMs: URL_WAIT_MS, intervalMs: URL_INTERVAL_MS, ...waits },
  );
  return ok ? { ok: true } : { ok: false, ...(last !== undefined ? { last } : {}) };
}

/** The system resolver: every address `hostname` resolves to from this computer. */
async function systemResolve(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true })).map((entry) => entry.address);
}

/**
 * Without managed DNS the user changed the records: polls (5 minutes) until `hostname` resolves to
 * the new server and no longer to the old one. Returns `undefined` when it does, else the problem.
 */
async function waitForDns(
  session: MoveSession,
  hostname: string,
  addresses: { fresh: readonly (string | undefined)[]; old: readonly (string | undefined)[] },
): Promise<string | undefined> {
  const resolve = session.services.resolve ?? systemResolve;
  const known = (list: readonly (string | undefined)[]) =>
    list.filter((a): a is string => a !== undefined);
  const fresh = known(addresses.fresh);
  const old = known(addresses.old);
  const among = (list: readonly string[], address: string) =>
    list.some((item) => sameIp(item, address));
  let problem = "";
  const settled = await pollUntil(
    async () => {
      try {
        const seen = await resolve(hostname);
        if (seen.some((a) => among(fresh, a)) && !seen.some((a) => among(old, a))) return true;
        problem = `${hostname} resolves to ${seen.length > 0 ? seen.join(", ") : "no address"} from this computer, not only to the new server (${fresh.join(", ")})`;
      } catch (error) {
        problem = `${hostname} could not be resolved from this computer (${reasonOf(error)})`;
      }
      return undefined;
    },
    { timeoutMs: URL_WAIT_MS, intervalMs: URL_INTERVAL_MS, ...waitsOf(session.services) },
  );
  return settled ? undefined : problem;
}

/** Why the new server is not settled yet, and what to do about it. */
interface Unsettled {
  problem: string;
  hint: string;
}

/**
 * The end of a switch, done again on every later run (and before `--finish`): the edge's proxy starts on the
 * new server; without managed DNS the app's domain must resolve to the new server (and no longer
 * to the old one), so the check below reaches the new server and not the old app; the app must
 * answer through its URL within 5 minutes; then the app on the old server is stopped when it still
 * runs (no self-hosted database). With Cloudflare the applied DNS plan is the proof (a proxied
 * domain resolves to Cloudflare's edge). Returns the site, or stops with `refuse(…)`: the old
 * server is kept.
 */
async function settleSwitch(
  session: MoveSession,
  refuse: (unsettled: Unsettled) => OpsCrewError,
): Promise<string> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const next = newServer(session);
  const fresh = providerWords(moveProvider(plan.target));
  const old = providerWords(move.from.target.provider);
  const ops = serverOps(plan, deps.redactor);
  const edge = edgeProxy(plan);
  const { label } = EDGE_PROXIES[edge];
  const remote = newRemote(session);
  const site = publicUrl(plan, next.ipv4);
  const check = `${site}${plan.app.healthPath}`;
  const logs = `See what happens with \`ssh deploy@${next.ipv4}\`, \`cd ${EDGE_DIR} && docker compose logs --tail 100 ${edge}\` and \`cd ${ops.folder} && docker compose logs --tail 100 app\`, then run \`${RUN_COMMAND}\` to check again.`;
  deps.reporter.step(`Starting ${label} on the new ${fresh.noun}`);
  try {
    await startService(remote, edge, ops);
  } catch (error) {
    throw refuse({ problem: `starting ${label} there failed (${reasonOf(error)})`, hint: logs });
  }
  await auditMove(session, {
    kind: "remote-exec",
    action: `start ${edge}`,
    target: remote.host,
    decision: "approved",
  });
  const domain = plan.dns.domain;
  if (domain !== undefined && !managedDns(plan)) {
    deps.reporter.step(
      `Checking that ${domain} resolves to the new ${fresh.noun} (up to 5 minutes)`,
    );
    const problem = await waitForDns(session, domain, {
      fresh: [next.ipv4, next.ipv6],
      old: [oldServer(session).ipv4, oldServer(session).ipv6],
    });
    if (problem !== undefined) {
      throw refuse({
        problem,
        hint: `Change the DNS records of ${dnsHosts(plan).join(" and ")} to ${[next.ipv4, next.ipv6].filter(Boolean).join(" and ")} at your DNS provider (and remove the old addresses), wait until the change reaches this computer, then run \`${RUN_COMMAND}\` to check again.`,
      });
    }
  }
  deps.reporter.step(`Checking the app at ${check} (up to 5 minutes)`);
  const answer = await waitForUrl(deps.fetch, check, waitsOf(session.services));
  if (!answer.ok) {
    const why =
      answer.last !== undefined ? ` (last answer: ${deps.redactor.redact(answer.last)})` : "";
    const tls =
      domain !== undefined
        ? `${label} on the new ${fresh.noun} may still be getting its TLS certificate${managedDns(plan) ? ", or the DNS change has not reached this computer yet" : ""}. `
        : "";
    throw refuse({
      problem: `the app did not answer at ${check} within 5 minutes${why}`,
      hint: `${tls}${logs}`,
    });
  }
  if (move.oldAppStoppedAt === undefined) {
    deps.reporter.step(`Stopping the app on the old ${old.noun} (traffic goes to the new one)`);
    try {
      await stopService(oldRemote(session), "app", ops);
      await saveMove(session, {
        ...moveOf(session),
        oldAppStoppedAt: deps.clock.now().toISOString(),
      });
      await auditMove(session, {
        kind: "remote-exec",
        action: "stop app",
        target: oldServer(session).ipv4,
        decision: "approved",
      });
    } catch (error) {
      deps.reporter.warn(
        `OpsCrew could not stop the app on the old ${old.noun}: ${reasonOf(error)}. It keeps running until \`${FINISH_COMMAND}\` deletes the ${old.noun}.`,
      );
    }
  }
  return site;
}

/**
 * `opscrew retarget` once the step is `switched` (right after the switch and on every later run):
 * {@link settleSwitch}, then the move waits for `--finish`.
 */
export async function completeSwitch(session: MoveSession): Promise<RetargetResult> {
  const { deps, plan } = session;
  const fresh = providerWords(moveProvider(plan.target));
  const old = providerWords(moveOf(session).from.target.provider);
  const site = await settleSwitch(
    session,
    ({ problem, hint }) =>
      new OpsCrewError(
        "COMMAND_FAILED",
        `The switch to the new ${fresh.noun} is recorded, but it does not serve the app yet: ${problem}. The old ${old.noun} is kept.`,
        { hint: `${hint} The move can no longer be aborted.` },
      ),
  );
  // The new server receives the traffic (again in the local state if that record was lost).
  await recordServerAddress(deps.paths, newServer(session));
  deps.reporter.success(`${plan.app.name} now runs on ${fresh.name} at ${site}.`);
  return {
    step: "switched",
    done: true,
    next: [
      `Check your app at ${site}.`,
      `When you are happy with it, run \`${FINISH_COMMAND}\` to delete the old ${old.noun} on ${old.name} (it is billed until then).`,
    ],
  };
}

/**
 * Before `--finish` deletes anything: {@link settleSwitch} must succeed, so the old server is never
 * deleted while the new one does not serve the app (or DNS still leads to the old one).
 */
export async function requireSwitchSettled(session: MoveSession): Promise<void> {
  const fresh = providerWords(moveProvider(session.plan.target));
  const old = providerWords(moveOf(session).from.target.provider);
  await settleSwitch(
    session,
    ({ problem, hint }) =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `The new ${fresh.noun} does not serve the app yet: ${problem}. OpsCrew keeps the old ${old.noun}; nothing was deleted.`,
        { hint: `${hint} It tells you when the move can be finished.` },
      ),
  );
}
