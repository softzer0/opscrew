/**
 * The resources several OpsCrew apps share in Cloudflare (ADR 0014): OpsCrew's two rules in the
 * zone and the account's Zero Trust organization and one-time PIN login. Each app adds and removes
 * only the hostnames it recorded in `.opscrew/cloudflare.json`, through a Cloudflare plan approved
 * by its hash (`cloudflare-apply`) before the infrastructure plan.
 */
import {
  applyShared,
  CLOUDFLARE_TOKEN_PERMISSIONS,
  type CloudflareClient,
  cloudflareConnector,
  inspectShared,
  planShared,
  SHARED_RULES,
  SharedApplyError,
  type SharedApplyResult,
  type SharedChange,
  type SharedDesired,
  type SharedPlan,
  type SharedRecord,
  SharedRecordSchema,
  type SharedRuleRef,
} from "@opscrew/connector-cloudflare";
import type { ApprovalRecord, PhaseName } from "@opscrew/contracts";
import {
  listText,
  OpsCrewError,
  type ProjectPaths,
  plural,
  readTextIfExists,
  writeFileAtomic,
} from "@opscrew/core";
import {
  portainerHostname,
  tunnelMode,
  usesTunnel,
  zeroTrustAuthDomain,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { cloudflareTokenHint } from "../domain/common";
import {
  type AdapterPlanItem,
  adapterBlocked,
  describeAdapterPlan,
  PlanRefusedError,
} from "../shared";
import { type CloudflareSetup, cloudflareTokenMissing, portainerCloudflare } from "./credentials";
import { approveLaterHint } from "./plan-apply";
import type { ProvisionServices } from "./types";

const REFS = Object.keys(SHARED_RULES) as SharedRuleRef[];

/** Each shared rule in words, and the zone's rules it is one of. */
const RULES: Record<SharedRuleRef, { name: string; kind: string }> = {
  "opscrew-block-probes": {
    name: "Block probes for secrets and admin panels",
    kind: "WAF custom rules",
  },
  "opscrew-strict-tls": {
    name: "Verify the origin certificate (Full (strict) TLS)",
    kind: "configuration rules",
  },
};

const RECORD_FILE = ".opscrew/cloudflare.json";

/**
 * This app's record of its hostnames in OpsCrew's shared Cloudflare rules
 * (`.opscrew/cloudflare.json`), or `undefined` before its first Cloudflare plan. A damaged file
 * stops: without it OpsCrew cannot tell which hostnames there are this app's.
 */
export async function readCloudflareRecord(
  paths: Pick<ProjectPaths, "files">,
): Promise<SharedRecord | undefined> {
  const text = await readTextIfExists(paths.files.cloudflareRecord);
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = SharedRecordSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${RECORD_FILE}, OpsCrew's record of this app's hostnames in its shared Cloudflare rules, is damaged, so OpsCrew cannot tell which hostnames there are this app's. Nothing was changed.`,
    {
      hint: `Copy ${RECORD_FILE} back from the computer that deployed this app, then run the command again. If it is lost, delete it: OpsCrew then plans as for a new app and stops if the app's hostnames are already in OpsCrew's rules (remove them there in the Cloudflare dashboard first).`,
    },
  );
}

async function writeCloudflareRecord(
  paths: Pick<ProjectPaths, "files">,
  record: SharedRecord,
): Promise<void> {
  await writeFileAtomic(paths.files.cloudflareRecord, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * What this plan needs from the shared resources in the zone `zone`: the app's hostnames in the
 * probe block wherever OpsCrew blocks probes (`security.wafCustomRules`, not on the user's
 * Portainer unless it serves the app through its tunnel) and in the strict-TLS rule wherever the
 * origin has its own certificate (not through a tunnel, not on the user's Portainer); the Zero
 * Trust organization whenever the plan has Cloudflare Access (a tunnel's SSH or Portainer
 * hostname, Portainer's webhook), and the one-time PIN login with Portainer on a subdomain.
 */
export function sharedDesired(plan: DeployPlan, zone: string): SharedDesired {
  const domain = plan.dns.domain;
  const hosts = domain === undefined ? [] : plan.dns.www ? [domain, `www.${domain}`] : [domain];
  const portainer = portainerCloudflare(plan);
  const block = plan.security.wafCustomRules && (portainer === undefined || portainer.appTunnel);
  const tls = !tunnelMode(plan) && portainer === undefined;
  const access = usesTunnel(plan) || portainer?.webhook === true;
  return {
    hostnames: {
      "opscrew-block-probes": block ? hosts : [],
      "opscrew-strict-tls": tls ? hosts : [],
    },
    ...(access
      ? {
          access: {
            authDomain: zeroTrustAuthDomain(zone),
            oneTimePin: portainerHostname(plan) !== undefined,
          },
        }
      : {}),
  };
}

/** The ruleset changes of one rule's phase in words: what it does with this app's hostnames. */
function ruleItem(plan: SharedPlan, ref: SharedRuleRef): AdapterPlanItem | undefined {
  const { phase } = SHARED_RULES[ref];
  const { name, kind } = RULES[ref];
  const mine = plan.record.hostnames[ref] ?? [];
  const changes = plan.changes.filter(
    (change): change is Extract<SharedChange, { phase: string }> =>
      "phase" in change && change.phase === phase,
  );
  const [first] = changes;
  if (first === undefined) {
    // Shown as in place only when the plan can be applied: a finding may concern this rule.
    if (mine.length === 0 || plan.findings.length > 0) return undefined;
    return { title: `${name}: ${listText(mine)}`, state: "in-place" };
  }
  const before = plan.previous?.hostnames[ref] ?? [];
  const others = (plan.expect[phase]?.hostnames ?? []).filter((host) => !before.includes(host));
  const keeps =
    others.length > 0
      ? `OpsCrew's rule keeps the ${plural(others.length, "hostname")} of other OpsCrew apps there.`
      : undefined;
  switch (first.kind) {
    case "create-entrypoint":
      return {
        title: `${name}: add ${listText(mine)}`,
        state: "change",
        reason: `The zone has no ${kind} yet: OpsCrew creates them with only its own rule.`,
      };
    case "add-rule":
      return {
        title: `${name}: add ${listText(mine)}`,
        state: "change",
        reason: `OpsCrew adds its rule after the zone's own ${kind}, which stay as they are.`,
      };
    case "update-hostnames": {
      const parts = [
        ...(first.add.length > 0 ? [`add ${listText(first.add)}`] : []),
        ...(first.remove.length > 0 ? [`remove ${listText(first.remove)}`] : []),
      ];
      return {
        title: `${name}: ${parts.join("; ")}`,
        state: "change",
        ...(keeps !== undefined ? { reason: keeps } : {}),
      };
    }
    default: {
      const ruleset = changes.some((change) => change.kind === "delete-entrypoint");
      return {
        title: `${name}: remove ${listText(plan.expect[phase]?.hostnames ?? [])}`,
        state: "change",
        reason: `No other OpsCrew app is in OpsCrew's rule, so OpsCrew deletes it${ruleset ? `, and the zone's ${kind}, which then hold no rule` : ""}.`,
      };
    }
  }
}

/**
 * The plain-English Cloudflare plan shown before its `cloudflare-apply` approval: what it does
 * with this app's hostnames in each shared rule (other apps' hostnames only as a count) and with
 * the account's Zero Trust organization and one-time PIN login, the findings, then the hash.
 * Hostnames are public; no token, id or address is shown.
 */
function describeCloudflarePlan(plan: SharedPlan, desired: SharedDesired, zone: string): string {
  const items = REFS.flatMap((ref) => ruleItem(plan, ref) ?? []);
  const creates = (kind: SharedChange["kind"]) => plan.changes.some((c) => c.kind === kind);
  if (desired.access !== undefined) {
    items.push(
      creates("create-organization")
        ? {
            title: `Create the account's Zero Trust organization (team domain ${desired.access.authDomain})`,
            state: "change",
            reason:
              "Cloudflare Access needs it. Every OpsCrew app in the account uses it, so OpsCrew never deletes it.",
          }
        : {
            title: `The account's Zero Trust organization${plan.organization ? ` (team domain ${plan.organization.authDomain})` : ""}`,
            state: "in-place",
          },
    );
    if (desired.access.oneTimePin) {
      items.push(
        creates("create-identity-provider")
          ? {
              title: "Add the one-time PIN login to the account's Zero Trust organization",
              state: "change",
              reason:
                "Portainer's login sends a code by email. Every OpsCrew app in the account uses it, so OpsCrew never deletes it.",
            }
          : { title: "The account's one-time PIN login", state: "in-place" },
      );
    }
  }
  return describeAdapterPlan({
    heading: `Cloudflare plan for ${zone}`,
    items,
    findings: plan.findings,
    note: "OpsCrew keeps one rule of its own per kind of rule in the zone, listing the hostnames of every OpsCrew app there, and changes only this app's hostnames in it. Rules OpsCrew did not create stay exactly as they are, in the same order.",
    hashLabel: "Cloudflare plan hash",
    hash: plan.hash,
  });
}

/** The client for the shared resources: `services.sharedCloudflare`, else `CLOUDFLARE_API_TOKEN`'s. */
export function sharedCloudflareClient(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  services: Pick<ProvisionServices, "sharedCloudflare">,
): CloudflareClient {
  const client = services.sharedCloudflare ?? cloudflareConnector(deps).client;
  if (client === undefined) throw cloudflareTokenMissing(deps);
  return client;
}

/** One zone's Cloudflare plan, with what it was planned for and its text. */
interface ZonePlan {
  plan: SharedPlan;
  desired: SharedDesired;
  details: string;
}

/**
 * This app's Cloudflare plans ({@link planSharedCloudflare}) and the client they go through: the
 * one for the plan's zone (none when the plan uses no Cloudflare zone any more) and, when the
 * record names another zone that still lists this app's hostnames, their removal from it.
 */
export interface PlannedCloudflare {
  client: CloudflareClient;
  leave?: ZonePlan;
  main?: ZonePlan;
}

/** The hashes of the Cloudflare plans, for telling them apart from the `--approve` hashes. */
export function cloudflarePlanHashes(planned: PlannedCloudflare | undefined): string[] {
  if (planned === undefined) return [];
  return [planned.leave?.plan.hash, planned.main?.plan.hash].filter(
    (hash): hash is string => hash !== undefined,
  );
}

/** One zone's plan; stops (`PHASE_PRECONDITION`, nothing changed) on its findings. */
async function zonePlan(
  deps: Pick<PhaseDeps, "reporter">,
  input: {
    client: CloudflareClient;
    zoneId: string;
    accountId: string;
    zone: string;
    desired: SharedDesired;
    record: SharedRecord | undefined;
    command: string;
  },
): Promise<ZonePlan> {
  const facts = await inspectShared(input.client, {
    zoneId: input.zoneId,
    accountId: input.accountId,
    access: input.desired.access !== undefined,
  });
  const plan = planShared(facts, input.desired, input.record);
  const details = describeCloudflarePlan(plan, input.desired, input.zone);
  if (plan.findings.length > 0) {
    deps.reporter.info(details);
    throw adapterBlocked({
      cannot: "OpsCrew cannot apply the Cloudflare plan",
      findings: plan.findings,
      blocked: [],
      fallbackHint: `Fix what blocks the Cloudflare plan, then run \`${input.command}\` again.`,
    });
  }
  return { plan, desired: input.desired, details };
}

/** The stop when this app's hostnames must leave a zone's rules and there is no Cloudflare token. */
function leftInZoneTokenMissing(): OpsCrewError {
  return new OpsCrewError(
    "CREDENTIALS_MISSING",
    "This app's hostnames are still in OpsCrew's shared rules of a Cloudflare zone the plan no longer uses, and CLOUDFLARE_API_TOKEN is not set, so OpsCrew cannot remove them. Nothing was changed.",
    {
      hint: cloudflareTokenHint(
        CLOUDFLARE_TOKEN_PERMISSIONS.join(", "),
        "Then set CLOUDFLARE_API_TOKEN to it and run the command again.",
      ),
    },
  );
}

/**
 * Plans the shared Cloudflare change, read-only (ADR 0014): this app's hostnames and the Zero
 * Trust pieces ({@link sharedDesired}) against its record, in the plan's zone (`cloudflare`, from
 * `setupCloudflare`). When the record names another zone that still lists this app's hostnames
 * (the app moved, or the plan uses no Cloudflare zone any more), their removal from that zone is
 * planned too. `undefined` when there is nothing to plan. Stops on the plans' findings before
 * anything changes.
 */
export async function planSharedCloudflare(
  deps: Pick<PhaseDeps, "reporter" | "paths" | "env" | "fetch" | "redactor" | "version">,
  input: {
    services: Pick<ProvisionServices, "sharedCloudflare">;
    plan: DeployPlan;
    cloudflare: Pick<CloudflareSetup, "zoneId" | "zoneName" | "accountId"> | undefined;
    command: string;
  },
): Promise<PlannedCloudflare | undefined> {
  const { cloudflare, command } = input;
  const record = await readCloudflareRecord(deps.paths);
  const left =
    record !== undefined &&
    record.zoneId !== cloudflare?.zoneId &&
    REFS.some((ref) => (record.hostnames[ref] ?? []).length > 0)
      ? record
      : undefined;
  if (cloudflare === undefined && left === undefined) return undefined;
  if (
    cloudflare === undefined &&
    input.services.sharedCloudflare === undefined &&
    !deps.env.CLOUDFLARE_API_TOKEN?.trim()
  ) {
    throw leftInZoneTokenMissing();
  }
  const client = sharedCloudflareClient(deps, input.services);
  const leave =
    left === undefined
      ? undefined
      : await zonePlan(deps, {
          client,
          zoneId: left.zoneId,
          // A removal changes only the rules of the zone it leaves: no account is involved.
          accountId: "",
          zone: "the zone this app leaves",
          desired: { hostnames: {} },
          record: left,
          command,
        });
  const main =
    cloudflare === undefined
      ? undefined
      : await zonePlan(deps, {
          client,
          zoneId: cloudflare.zoneId,
          accountId: cloudflare.accountId,
          zone: cloudflare.zoneName,
          desired: sharedDesired(input.plan, cloudflare.zoneName),
          record: record?.zoneId === cloudflare.zoneId ? record : undefined,
          command,
        });
  return {
    client,
    ...(leave !== undefined ? { leave } : {}),
    ...(main !== undefined ? { main } : {}),
  };
}

/** What {@link applySharedCloudflare} needs besides the plans. */
export interface SharedCloudflareInput {
  /** The app's name, typed to approve a plan that deletes OpsCrew's rule. */
  app: string;
  /** Show the Cloudflare plans only. */
  planOnly: boolean;
  /** The command that applies them later (`--approve <hash>`). */
  command: string;
  phase: PhaseName;
}
/** The outcome of {@link applySharedCloudflare}. */
export interface SharedCloudflareResult {
  /**
   * The hash of the Cloudflare plan with changes this run ended with: applied, or with `planOnly`
   * the one to approve; absent when nothing in Cloudflare changes.
   */
  hash?: string;
  /** True when this run changed something in Cloudflare. */
  applied: boolean;
  /** The `cloudflare-apply` approvals of this run. */
  approvals: ApprovalRecord[];
  /** The id of the account's one-time PIN login, when the plan uses it and it exists. */
  oneTimePinId?: string;
  /**
   * With `planOnly`: the infrastructure plan cannot be made before this Cloudflare plan is applied
   * (it needs the one-time PIN login the Cloudflare plan adds, or the app leaves another zone for
   * a new one first); the step already said so.
   */
  infrastructureWaits: boolean;
}

/** One zone's plan shown, then approved by its hash, applied and recorded (unless `planOnly`). */
async function applyZonePlan(
  deps: PhaseDeps,
  client: CloudflareClient,
  zone: ZonePlan,
  input: SharedCloudflareInput,
): Promise<{ applied?: SharedApplyResult; approval?: ApprovalRecord }> {
  const { plan, details } = zone;
  deps.reporter.info(details);
  if (plan.changes.length === 0) {
    deps.reporter.success(
      "OpsCrew's shared Cloudflare resources are already set up for this app; nothing in Cloudflare changes.",
    );
    // Hostnames removed from OpsCrew's rules by hand and no longer wanted leave the record.
    await writeCloudflareRecord(deps.paths, plan.record);
    return {};
  }
  if (input.planOnly) {
    deps.reporter.info(
      `The Cloudflare plan (hash ${plan.hash}) is not applied; nothing in Cloudflare was changed.`,
    );
    return {};
  }
  const deletes = plan.changes.some(
    (change) => change.kind === "delete-rule" || change.kind === "delete-entrypoint",
  );
  const approval = await deps.approvals.request({
    kind: "cloudflare-apply",
    title: `Apply the Cloudflare plan to OpsCrew's shared Cloudflare resources (${plural(plan.changes.length, "change")})`,
    details,
    planHash: plan.hash,
    ...(deletes ? { allowDestroy: true, confirmPhrase: input.app } : {}),
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "Cloudflare plan",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: "Nothing in Cloudflare was changed.",
      hint: approveLaterHint(input.command, plan.hash, deletes ? input.app : undefined),
    });
  }
  await deps.approvals.assertApprovedCloudflarePlan(plan.hash, { allowDestroy: deletes });
  deps.reporter.step(
    `Changing OpsCrew's shared Cloudflare resources (${plural(plan.changes.length, "change")})`,
  );
  const audit = (action: string, decision: "approved" | "refused", detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: input.phase,
      target: plan.hash,
      decision,
      detail,
    });
  const changeId = (c: SharedChange) => ("phase" in c ? `${c.kind} ${c.phase}` : c.kind);
  await audit(
    "cloudflare apply started",
    "approved",
    `changes: ${plan.changes.map(changeId).join(", ")}`,
  );
  let applied: SharedApplyResult;
  try {
    applied = await applyShared(client, plan, { approvedHash: plan.hash });
  } catch (error) {
    // What reached Cloudflare before the failure is this app's: recorded before the error shows.
    const done = error instanceof SharedApplyError ? error.applied : [];
    if (error instanceof SharedApplyError) await writeCloudflareRecord(deps.paths, error.record);
    await audit(
      "cloudflare apply failed",
      "refused",
      `changes applied before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  await writeCloudflareRecord(deps.paths, applied.record);
  for (const id of applied.applied) await audit(`cloudflare change ${id}`, "approved", id);
  deps.reporter.success(
    `Changed OpsCrew's shared Cloudflare resources (${plural(applied.applied.length, "change")} applied).`,
  );
  return { applied, approval };
}

/**
 * The shared Cloudflare change, before the infrastructure plan: each plan of
 * {@link planSharedCloudflare} is shown, approved by its hash (`cloudflare-apply`, with the typed
 * app name when it deletes OpsCrew's rule; `--yes` never grants it) and applied, and
 * `.opscrew/cloudflare.json` is written, also when nothing changes (which asks nothing). The
 * removal from a zone the app leaves goes first; without a zone of its own the record then lists
 * no hostnames. With `planOnly` the plans are only shown.
 */
export async function applySharedCloudflare(
  deps: PhaseDeps,
  planned: PlannedCloudflare,
  input: SharedCloudflareInput,
): Promise<SharedCloudflareResult> {
  const { command } = input;
  const approvals: ApprovalRecord[] = [];
  /** The hash of the removal from the zone the app leaves, when it changes something. */
  let left: string | undefined;
  let leftApplied = false;
  if (planned.leave !== undefined) {
    const { plan } = planned.leave;
    const leave = await applyZonePlan(deps, planned.client, planned.leave, input);
    // The new zone's plan is shown once this one is applied: one Cloudflare plan per run.
    if (input.planOnly && plan.changes.length > 0 && planned.main !== undefined) {
      deps.reporter.info(
        `After this Cloudflare plan is applied (\`${command} --approve ${plan.hash}\`), run \`${command}\` again for the plans that follow.`,
      );
      return { hash: plan.hash, applied: false, approvals, infrastructureWaits: true };
    }
    if (leave.approval !== undefined) approvals.push(leave.approval);
    if (plan.changes.length > 0) left = plan.hash;
    leftApplied = leave.applied !== undefined;
  }
  const { main } = planned;
  if (main === undefined) {
    return {
      ...(left !== undefined ? { hash: left } : {}),
      applied: leftApplied,
      approvals,
      infrastructureWaits: false,
    };
  }
  const change = await applyZonePlan(deps, planned.client, main, input);
  if (change.approval !== undefined) approvals.push(change.approval);
  const oneTimePinId = change.applied?.oneTimePinId ?? main.plan.oneTimePinId;
  const waits =
    input.planOnly && main.desired.access?.oneTimePin === true && oneTimePinId === undefined;
  if (waits) {
    deps.reporter.info(
      `The infrastructure plan follows once this Cloudflare plan is applied, because it needs the one-time PIN login the Cloudflare plan adds (in scripts: run \`${command} --approve ${main.plan.hash}\`, then again with \`--approve\` and the infrastructure plan's hash).`,
    );
  }
  const hash = main.plan.changes.length > 0 ? main.plan.hash : left;
  return {
    ...(hash !== undefined ? { hash } : {}),
    applied: leftApplied || change.applied !== undefined,
    approvals,
    ...(oneTimePinId !== undefined ? { oneTimePinId } : {}),
    infrastructureWaits: waits,
  };
}
