import { lookup } from "node:dns/promises";
import type { ApprovalRecord, FetchLike, ResourceChange } from "@opscrew/contracts";
import { OpsCrewError, upperFirst } from "@opscrew/core";
import {
  EDGE_PROXIES,
  edgeProxy,
  moveAaaaRecord,
  portainerStackName,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { isCloudProvider } from "@opscrew/plan-schema";
import { z } from "zod";
import {
  committableUrl,
  pollUntil,
  recordServerAddress,
  type ServerAddress,
  sameIp,
} from "../shared";
import { codeOf, hintOf, reasonOf } from "../shared/errors";
import { oldSideTarget } from "./layouts";
import { pointMonitoringAfterWindow } from "./network";
import { applyInfraPlan, type InfraPlanInput, planBounded, prepareInfraPlan } from "./plans";
import {
  auditMove,
  auditStep,
  type MoveSession,
  moveOf,
  newServer,
  recordAdopted,
  saveMove,
  useLayout,
  waitsOf,
  withApply,
} from "./session";
import { moveSide, placeWords, sideWords } from "./sides";
import { pendingStop } from "./steps";
import { ABORT_COMMAND, FINISH_COMMAND, managedDns, RUN_COMMAND, untilSwitched } from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";
import { asOpsCrewError, copiesData, maintenanceWindow, restartOldApp } from "./window";

const URL_WAIT_MS = 5 * 60_000;
const URL_INTERVAL_MS = 10_000;

/** Where the app answers after the switch: its domain, else the new side's address. */
function publicUrl(plan: DeployPlan, ipv4: string): string {
  return plan.dns.domain !== undefined ? `https://${plan.dns.domain}` : `http://${ipv4}`;
}

/**
 * True for an in-place `update` of a record under `module.dns.`. A record the plan adopts with an
 * `import` block (a Portainer old side's, still the user's) is updated in place too.
 */
const dnsUpdate = (change: ResourceChange): boolean =>
  change.address.startsWith("module.dns.") && change.action === "update";

/** The app's AAAA record in the DNS module. */
const AAAA_RECORD = "module.dns.cloudflare_dns_record.aaaa[0]";

/**
 * What a DNS switch or restore plan may change when the records go from one side to the other
 * (`from`, `to`: whether the records have the AAAA record on that side, {@link sideAaaa}): the
 * records' in-place updates, plus what a change of address family needs, the AAAA record's delete
 * when only `from` has it or its create when only `to` has. Nothing else: no other create, delete
 * or replacement, nothing outside DNS, no moves.
 */
export function dnsSwitchChange(from: boolean, to: boolean): (change: ResourceChange) => boolean {
  const family = from === to ? undefined : from ? "delete" : "create";
  return (change) =>
    dnsUpdate(change) || (change.address === AAAA_RECORD && change.action === family);
}

/**
 * Whether the app's AAAA record exists while its DNS records point at the `which` side of the move
 * (`moveAaaaRecord`), from the address OpsCrew recorded of that side: the layouts' address
 * variables come from the same record.
 */
export function sideAaaa(
  session: Pick<MoveSession, "plan" | "servers">,
  which: "old" | "new",
): boolean {
  const side = which === "new" ? session.plan.target : oldSideTarget(moveOf(session));
  const address = which === "new" ? session.servers.next : session.servers.from;
  return moveAaaaRecord(session.plan, side, address?.ipv6 !== undefined);
}

/** The lead of a DNS plan's stop: the `what` plan would do more than update the records. */
export const dnsOnlyLead = (what: string): string =>
  `The ${what} plan would do more than update the DNS records in place, so OpsCrew stopped. Nothing was changed.`;

/**
 * A DNS plan that points the records at the `to` side of the move (the switch: `new`; an abort's
 * restore: `old`): its check, {@link dnsSwitchChange} between both sides' {@link sideAaaa}
 * (stopping with the `what` plan's lead and `hint`), and the approval note when it creates or
 * deletes the AAAA record.
 */
export function dnsSwitchPlan(
  session: Pick<MoveSession, "plan" | "servers">,
  to: "old" | "new",
  what: string,
  hint: string,
): Pick<InfraPlanInput, "check"> & { notes: string[] } {
  const from = sideAaaa(session, to === "new" ? "old" : "new");
  const next = sideAaaa(session, to);
  const target = to === "new" ? session.plan.target : moveOf(session).from.target;
  const where = sideWords(target, to);
  const domain = session.plan.dns.domain;
  const note = next
    ? `The AAAA record of ${domain} is created: ${where} is reached on IPv6 too.`
    : `The AAAA record of ${domain} is deleted: ${where} is reached on IPv4 only.`;
  return {
    check: planBounded({ lead: dnsOnlyLead(what), change: dnsSwitchChange(from, next), hint }),
    notes: from === next ? [] : [note],
  };
}

/**
 * A failed (or refused) switch: the app on the old side runs again (when OpsCrew stopped it) and
 * the move goes back to `deployed`, so users are served while the cause is fixed. Returns the
 * error to throw.
 */
async function rollBackSwitch(session: MoveSession, cause: unknown): Promise<OpsCrewError> {
  const { plan } = session;
  const refused = cause instanceof OpsCrewError && cause.code === "APPROVAL_REFUSED";
  const what = refused ? "The switch was not approved" : `The switch failed: ${reasonOf(cause)}`;
  const copied = moveOf(session).step === "migrated";
  await auditMove(session, {
    kind: "phase",
    action: "retarget switch",
    decision: "refused",
    detail: refused ? "switch not approved" : `switch failed: ${reasonOf(cause)}`,
  });
  // Back before the window first: even if the old app cannot be started now, the next run starts
  // it (an open window before `migrated`) and copies the data again before switching.
  await saveMove(session, { ...moveOf(session), step: "deployed" });
  await auditStep(session, "deployed", "back to the step before the maintenance window");
  try {
    await restartOldApp(session, `${what}, and `);
  } catch (error) {
    return asOpsCrewError(error);
  }
  const again = copied
    ? `run \`${RUN_COMMAND}\` again (it repeats the maintenance window)`
    : `run \`${RUN_COMMAND}\` again`;
  // A failed apply may have updated some records before it stopped; they point at the new side,
  // whose web server is stopped. Continuing completes the switch; aborting points them back first.
  const partly =
    !refused && managedDns(plan)
      ? ` Some DNS records of ${dnsHosts(plan).join(" and ")} may already point at ${sideWords(plan.target, "new")}, where the web server is stopped, so some visitors may get errors until you continue or abort: \`${RUN_COMMAND}\` completes the switch, \`${ABORT_COMMAND}\` points them back first.`
      : "";
  // The cause's hint (the command that approves the switch) ends as a sentence of its own.
  const earlier = hintOf(cause).trim();
  const before = earlier === "" || /[.!?]$/.test(earlier) ? earlier : `${earlier}.`;
  return new OpsCrewError(
    codeOf(cause),
    `${what}. The app on ${sideWords(moveOf(session).from.target, "old")} runs again, and the move went back to the step before the maintenance window.${partly}`,
    {
      hint: `${before === "" ? "" : `${before} `}When you are ready, ${again}, or \`${ABORT_COMMAND}\` to undo the move.`,
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
 * Records the switch: the new side receives the traffic (its address in OpsCrew's local state
 * first, then the domain URL in `deployment`) and the step is `switched` (abort is over).
 */
async function recordSwitched(
  session: MoveSession,
  input: { url: string; applied?: { planHash: string; approval?: ApprovalRecord } },
): Promise<void> {
  const { deps } = session;
  const move = moveOf(session);
  await recordServerAddress(deps.paths, newServer(session));
  const at = deps.clock.now().toISOString();
  const recorded = input.applied
    ? withApply(session.plan, input.applied, at)
    : { approvals: session.plan.approvals, deployment: session.plan.deployment };
  const { url: _previous, ...deployment } = recorded.deployment;
  // Without a domain the URL is the new side's IP address, which is never committed.
  const url = committableUrl(input.url);
  await saveMove(
    session,
    { ...move, step: "switched" },
    {
      approvals: recorded.approvals,
      deployment: { ...deployment, ...(url !== undefined ? { url } : {}) },
    },
  );
  await auditStep(session, "switched", `traffic goes to ${sideWords(session.plan.target, "new")}`);
}

const UrlSchema = z.url({ protocol: /^https?$/ });

/** The DNS change to make by hand, line by line: the user points the records at the new side. */
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

/** The web server the new side starts at the switch, in words. */
function edgeWords(plan: DeployPlan): string {
  return plan.target.provider === "portainer"
    ? "the stack's Caddy"
    : EDGE_PROXIES[edgeProxy(plan)].label;
}

/**
 * Step 6 with Cloudflare: the switch plan (an update-only DNS plan over the move's layout; a
 * Portainer old side's records, still the user's, adopted into it with `import` blocks) is made
 * (and, in scripts, approved by hash) before the maintenance window, so no plan or prompt fails
 * while the app is offline; then the window, then the apply. A failed or refused apply rolls back
 * to `deployed`.
 */
async function switchManagedDns(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime">,
  windowAhead: boolean,
  next: ServerAddress,
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const fresh = sideWords(plan.target, "new");
  const old = sideWords(move.from.target, "old");
  // Past the window (or without one): the other servers' Alloy sends to the new stack.
  if (!windowAhead) {
    const monitored = await pointMonitoringAfterWindow(session);
    if (monitored !== undefined) return monitored;
  }
  deps.reporter.step(`Planning the switch of ${plan.dns.domain} to ${fresh}`);
  const files = await useLayout(session, "switched");
  const dns = dnsSwitchPlan(
    session,
    "new",
    "DNS switch",
    `The infrastructure no longer matches what OpsCrew applied. Run \`${ABORT_COMMAND}\` to undo the move, then \`opscrew drift\` to see the differences.`,
  );
  const adopted =
    session.adoptRecords !== undefined
      ? [
          `The records of ${plan.dns.domain} were yours: OpsCrew adopts them (an import changes nothing in Cloudflare) and manages them from now on.`,
        ]
      : [];
  const input: InfraPlanInput = {
    action: "switch",
    files,
    check: dns.check,
    // DNS records are not billed: the new side's price was shown with the plan that created it.
    costDelta: null,
    notes: [
      `This points ${plan.dns.domain} at ${fresh}; the records are updated in place.`,
      ...dns.notes,
      ...adopted,
      `Then OpsCrew starts ${edgeWords(plan)} on ${fresh}, checks the app through its domain and keeps the app on ${old} stopped. After this the move can no longer be aborted.`,
    ],
  };
  const prepared = await prepareInfraPlan(session, input);
  if (prepared.kind === "pending") {
    // Resumed after the copy (`migrated`): the old app is stopped, so users are offline meanwhile.
    const offline =
      !windowAhead && moveOf(session).oldAppStoppedAt !== undefined
        ? [
            `The app on ${old} is stopped (its data was copied to ${fresh}), so your users are offline until this switch is applied. Apply it soon, or run \`${ABORT_COMMAND}\` to start the old app again and undo the move.`,
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
        `The DNS switch is planned (hash ${prepared.planHash}) and checked; OpsCrew shows it for your approval right after the copy.`,
      );
    }
    const window = await maintenanceWindow(
      session,
      options,
      prepared.kind === "ready" ? prepared.planHash : undefined,
    );
    if (window !== "done") return window;
    const monitored = await pointMonitoringAfterWindow(session);
    if (monitored !== undefined) return monitored;
  }
  if (prepared.kind === "unchanged") {
    deps.reporter.info(`The DNS records of ${plan.dns.domain} already point to ${fresh}.`);
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
  await recordAdopted(session);
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
  // The other servers' Alloy sends to the new stack from now on.
  const monitored = await pointMonitoringAfterWindow(session);
  if (monitored !== undefined) return monitored;
  const fresh = sideWords(plan.target, "new");
  const old = sideWords(move.from.target, "old");
  const records = manualRecords(plan, next);
  const url = publicUrl(plan, next.ipv4);
  if (options.dnsSwitched === true) {
    await auditMove(session, {
      kind: "approval",
      actor: "user",
      action: "dns-switched",
      target: fresh,
      decision: "approved",
      detail: `the user confirmed the switch to ${fresh} with --dns-switched`,
    });
  } else if (deps.interactive) {
    const approval = await deps.approvals.request({
      kind: "remote-exec",
      title: `Switch ${plan.app.name} to ${fresh}`,
      details: [
        ...records,
        "",
        ...(moveOf(session).oldAppStoppedAt !== undefined
          ? [
              `The app on ${old} is stopped (its data was copied), so your users are offline ${untilSwitched(plan)}.`,
            ]
          : []),
        `Confirm once you made this change. OpsCrew then starts ${edgeWords(plan)} on ${fresh}, checks the app at ${url} and keeps the app on ${old} stopped. After this the move can no longer be aborted.`,
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
            `The app on ${old} is stopped (its data was copied), so users see an error until ${fresh} takes over.`,
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
 * Step 6: the switch from `deployed` (the maintenance window first, when the move copies data) or
 * from `migrated` (the window is done). Returns a stop, or `undefined` once the step is
 * `switched`.
 */
export async function switchStep(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime" | "dnsSwitched">,
): Promise<RetargetResult | undefined> {
  // Stops before the window and the switch when the new side's address is unknown here.
  const next = newServer(session);
  const windowAhead = moveOf(session).step === "deployed" && copiesData(session.plan);
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
 * the new side and no longer to the old one (when its address is known). Returns `undefined` when
 * it does, else the problem.
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
        problem = `${hostname} does not resolve only to ${sideWords(session.plan.target, "new")} from this computer yet`;
      } catch (error) {
        problem = `${hostname} could not be resolved from this computer (${reasonOf(error)})`;
      }
      return undefined;
    },
    { timeoutMs: URL_WAIT_MS, intervalMs: URL_INTERVAL_MS, ...waitsOf(session.services) },
  );
  return settled ? undefined : problem;
}

/** Why the new side is not settled yet, and what to do about it. */
interface Unsettled {
  problem: string;
  hint: string;
}

/** Where to look when the new side does not serve the app yet, without its address. */
function logsHint(session: MoveSession): string {
  const { plan } = session;
  const where = sideWords(plan.target, "new");
  if (plan.target.provider === "portainer") {
    return `See what happens in your Portainer (the stack ${portainerStackName(plan)}: its caddy and app containers' logs), then run \`${RUN_COMMAND}\` to check again.`;
  }
  const edge = edgeProxy(plan);
  return `See what happens as deploy on ${where}: \`cd /srv/edge && docker compose logs --tail 100 ${edge}\` and \`docker compose logs --tail 100 app\` in the app's folder, then run \`${RUN_COMMAND}\` to check again.`;
}

/**
 * The end of a switch, done again on every later run (and before `--finish`): the new side's edge
 * starts (`startEdge`; a shared edge reloads); without managed DNS the app's domain must resolve
 * to the new side (and no longer to the old one), so the check below reaches the new side and
 * not the old app; the app must answer through its URL within 5 minutes; then the old side's app
 * stops (`stopApp`) when it still runs. With Cloudflare the applied DNS plan is the proof (a
 * proxied domain resolves to Cloudflare's edge). Returns the site, or stops with `refuse(…)`: the
 * old side is kept.
 */
async function settleSwitch(
  session: MoveSession,
  refuse: (unsettled: Unsettled) => OpsCrewError,
): Promise<string> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const next = newServer(session);
  const fresh = sideWords(plan.target, "new");
  const old = sideWords(move.from.target, "old");
  const label = edgeWords(plan);
  const site = publicUrl(plan, next.ipv4);
  const check = `${site}${plan.app.healthPath}`;
  const logs = logsHint(session);
  deps.reporter.step(`Starting ${label} on ${fresh}`);
  try {
    await moveSide(session, "new").startEdge(session);
  } catch (error) {
    throw refuse({ problem: `starting ${label} there failed (${reasonOf(error)})`, hint: logs });
  }
  await auditMove(session, {
    kind: "remote-exec",
    action: "start edge",
    target: fresh,
    decision: "approved",
  });
  const domain = plan.dns.domain;
  if (domain !== undefined && !managedDns(plan)) {
    deps.reporter.step(`Checking that ${domain} resolves to ${fresh} (up to 5 minutes)`);
    const from = session.servers.from;
    const problem = await waitForDns(session, domain, {
      fresh: [next.ipv4, next.ipv6],
      old: [from?.ipv4, from?.ipv6],
    });
    if (problem !== undefined) {
      throw refuse({
        problem,
        hint: `Change the DNS records of ${dnsHosts(plan).join(" and ")} to ${fresh}'s address at your DNS provider (and remove the old addresses), wait until the change reaches this computer, then run \`${RUN_COMMAND}\` to check again.`,
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
        ? `${label} on ${fresh} may still be getting its TLS certificate${managedDns(plan) ? ", or the DNS change has not reached this computer yet" : ""}. `
        : "";
    throw refuse({
      problem: `the app did not answer at ${check} within 5 minutes${why}`,
      hint: `${tls}${logs}`,
    });
  }
  if (move.oldAppStoppedAt === undefined) {
    deps.reporter.step(`Stopping the app on ${old} (traffic goes to the new side)`);
    try {
      await moveSide(session, "old").stopApp(session);
      await saveMove(session, {
        ...moveOf(session),
        oldAppStoppedAt: deps.clock.now().toISOString(),
      });
      await auditMove(session, {
        kind: "remote-exec",
        action: "stop app",
        target: old,
        decision: "approved",
      });
    } catch (error) {
      deps.reporter.warn(
        `OpsCrew could not stop the app on ${old}: ${reasonOf(error)}. It keeps running until \`${FINISH_COMMAND}\` removes it.`,
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
  const fresh = sideWords(plan.target, "new");
  const from = moveOf(session).from.target;
  const old = sideWords(from, "old");
  const site = await settleSwitch(
    session,
    ({ problem, hint }) =>
      new OpsCrewError(
        "COMMAND_FAILED",
        `The switch to ${fresh} is recorded, but it does not serve the app yet: ${problem}. ${upperFirst(old)} is kept.`,
        { hint: `${hint} The move can no longer be aborted.` },
      ),
  );
  // The new side receives the traffic (again in the local state if that record was lost).
  await recordServerAddress(deps.paths, newServer(session));
  deps.reporter.success(`${plan.app.name} now runs on ${placeWords(plan.target)} at ${site}.`);
  const cloud = isCloudProvider(from.provider);
  return {
    step: "switched",
    done: true,
    next: [
      `Check your app at ${site}.`,
      cloud
        ? `When you are happy with it, run \`${FINISH_COMMAND}\` to delete ${old} (it is billed until then).`
        : `When you are happy with it, run \`${FINISH_COMMAND}\` to remove the app from ${old}.`,
    ],
  };
}

/**
 * Before `--finish` removes anything: {@link settleSwitch} must succeed, so the old side is never
 * removed while the new one does not serve the app (or DNS still leads to the old one).
 */
export async function requireSwitchSettled(session: MoveSession): Promise<void> {
  const fresh = sideWords(session.plan.target, "new");
  const old = sideWords(moveOf(session).from.target, "old");
  await settleSwitch(
    session,
    ({ problem, hint }) =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `${upperFirst(fresh)} does not serve the app yet: ${problem}. OpsCrew keeps ${old}; nothing was removed.`,
        { hint: `${hint} It tells you when the move can be finished.` },
      ),
  );
}
