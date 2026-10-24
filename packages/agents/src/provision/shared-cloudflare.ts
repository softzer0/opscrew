/**
 * The resources several OpsCrew apps share in Cloudflare (ADR 0014): OpsCrew's two rules in the
 * zone and the account's Zero Trust organization and one-time PIN login. Each app adds and removes
 * only the hostnames it recorded in `.opscrew/cloudflare.json`, through a Cloudflare plan approved
 * by its hash (`cloudflare-apply`) before the infrastructure plan.
 */
import {
  applyShared,
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
import { portainerHostname, tunnelMode, usesTunnel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { listsRedirect, siteRulesDesired } from "../serverless/cloudflare/rules";
import {
  type AdapterPlanItem,
  adapterBlocked,
  describeAdapterPlan,
  PlanRefusedError,
} from "../shared";
import { type CloudflareSetup, cloudflareTokenMissing, portainerCloudflare } from "./credentials";
import { approveLaterHint } from "./plan-apply";
import type { ProvisionResult, ProvisionServices } from "./types";

/** OpsCrew's shared rules, by their fixed `ref`. */
export const REFS = Object.keys(SHARED_RULES) as SharedRuleRef[];

/** True when the record lists a hostname of this app in any of OpsCrew's shared rules. */
export function listsHostnames(record: SharedRecord): boolean {
  return REFS.some((ref) => (record.hostnames[ref] ?? []).length > 0);
}

/** Team domain OpsCrew gives a Zero Trust organization it creates: `<zone>-opscrew.cloudflareaccess.com`. */
export function zeroTrustAuthDomain(zone: string): string {
  return `${zone.replaceAll(".", "-")}-opscrew.cloudflareaccess.com`;
}

/** Each shared rule in words, and the zone's rules it is one of. */
export const RULES: Record<SharedRuleRef, { name: string; kind: string }> = {
  "opscrew-block-probes": {
    name: "Block probes for secrets and admin panels",
    kind: "WAF custom rules",
  },
  "opscrew-strict-tls": {
    name: "Verify the origin certificate (Full (strict) TLS)",
    kind: "configuration rules",
  },
  "opscrew-www-redirect": {
    name: "Redirect www to the domain",
    kind: "single redirect rules",
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

/**
 * Writes this app's record of its hostnames in OpsCrew's shared Cloudflare rules, its keys in the
 * schema's order: the same record gives the same bytes, whether a plan or an apply made it. A
 * record the schema refuses is written as it is, so what reached Cloudflare is still recorded.
 */
export async function writeCloudflareRecord(
  paths: Pick<ProjectPaths, "files">,
  record: SharedRecord,
): Promise<void> {
  const normalized = SharedRecordSchema.safeParse(record).data ?? record;
  await writeFileAtomic(paths.files.cloudflareRecord, `${JSON.stringify(normalized, null, 2)}\n`);
}

/**
 * What this plan needs from the shared resources in the zone `zone`: the app's hostnames in the
 * probe block wherever OpsCrew blocks probes (`security.wafCustomRules`, not on the user's
 * Portainer unless it serves the app through its tunnel) and in the strict-TLS rule wherever the
 * origin has its own certificate (not through a tunnel, not on the user's Portainer); the Zero
 * Trust organization whenever the plan has Cloudflare Access (a tunnel's SSH or Portainer
 * hostname, Portainer's webhook), and the one-time PIN login with Portainer on a subdomain. A site
 * on Cloudflare's hosting has rules of its own ({@link siteRulesDesired}).
 */
export function sharedDesired(plan: DeployPlan, zone: string): SharedDesired {
  if (plan.target.provider === "cloudflare-workers") return siteRulesDesired(plan);
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
    case "delete-entrypoint":
      // Only the ruleset this app created is left (an interrupted destroy, or a rule deleted by hand).
      return {
        title: `${name}: delete the zone's ${kind}, which hold no rule`,
        state: "change",
        reason: "OpsCrew created them for this app, and they hold no rule any more.",
      };
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

/** A change to the app's origin TLS or the zone's minimum TLS in words; `undefined` for the others. */
function tlsItem(change: SharedChange): AdapterPlanItem | undefined {
  switch (change.kind) {
    case "upload-client-certificate":
      return {
        title: `Upload this app's client certificate to Cloudflare (SHA-256 ${change.sha256})`,
        state: "change",
        reason:
          "Cloudflare presents it to the server, so the server can tell this zone from every other Cloudflare customer. Its private key goes to Cloudflare in this upload only.",
      };
    case "enable-client-certificate":
      return {
        title: `Turn on this app's client certificate for ${change.hostnames.join(", ")} (SHA-256 ${change.sha256})`,
        state: "change",
        reason:
          "Cloudflare then presents it to the server for these hostnames (Authenticated Origin Pulls). OpsCrew waits until Cloudflare has turned it on before the server requires it, so no request fails.",
      };
    case "create-origin-certificate":
      return {
        title: `Create a Cloudflare origin certificate for ${change.hostnames.join(", ")} (15 years)`,
        state: "change",
        reason:
          "The server serves it to Cloudflare for these hostnames. Its private key was made on this computer and never goes to Cloudflare.",
      };
    case "disable-client-certificate":
      return {
        title: `Turn off this app's client certificate for ${change.hostnames.join(", ")}`,
        state: "change",
        reason: "The server no longer requires it for these hostnames.",
      };
    case "delete-client-certificate":
      return {
        title: "Delete this app's client certificate from Cloudflare",
        state: "change",
        reason: "No hostname uses it any more.",
      };
    case "revoke-origin-certificate":
      return {
        title: "Revoke an origin certificate of this app that the server no longer serves",
        state: "change",
        reason: "A revoked certificate is of no use to anyone holding a copy of its key.",
      };
    case "set-min-tls":
      return {
        title: `Raise the zone's minimum TLS version from ${change.from} to ${change.to}`,
        state: "change",
        reason:
          "Every proxied hostname in the zone belongs to an OpsCrew app, so no other site there needs TLS 1.0 or 1.1. OpsCrew never lowers it, and destroy leaves it.",
      };
    // 011's rule and Zero Trust changes are described by their own items.
    case "create-entrypoint":
    case "add-rule":
    case "update-hostnames":
    case "delete-rule":
    case "delete-entrypoint":
    case "create-organization":
    case "create-identity-provider":
      return undefined;
    default: {
      // A new kind must be described here, or the approval text would leave it out.
      const unknown: never = change;
      return unknown;
    }
  }
}

/**
 * The plain-English Cloudflare plan shown before its `cloudflare-apply` approval: its changes to
 * the app's origin TLS and the zone's minimum TLS, what it does with this app's hostnames in each
 * shared rule (other apps' hostnames only as a count) and with the account's Zero Trust
 * organization and one-time PIN login, the findings, the advice (which never blocks), then the
 * hash. Hostnames and fingerprints are public; no token, key, id or address is shown.
 */
export function describeCloudflarePlan(
  plan: SharedPlan,
  desired: SharedDesired,
  zone: string,
  notes: readonly string[] = [],
): string {
  const items = [
    ...plan.changes.flatMap((change) => tlsItem(change) ?? []),
    ...REFS.flatMap((ref) => ruleItem(plan, ref) ?? []),
  ];
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
  // After the findings and before the note: advice, each with its next step.
  const advice = plan.advice.flatMap((item) => [`  Advice: ${item.message}`, `      ${item.hint}`]);
  return describeAdapterPlan({
    heading: `Cloudflare plan for ${zone}`,
    items,
    findings: plan.findings,
    note: [
      ...advice,
      ...notes,
      "OpsCrew keeps one rule of its own per kind of rule in the zone, listing the hostnames of every OpsCrew app there, and changes only this app's hostnames in it. Rules OpsCrew did not create stay exactly as they are, in the same order.",
    ].join("\n"),
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
export interface ZonePlan {
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

/**
 * One zone's plan, reading the app's origin TLS and the zone's minimum TLS when `desired` asks
 * for them, and the `www` redirect rule's phase with `redirect` (a site on Cloudflare's hosting);
 * stops (`PHASE_PRECONDITION`, nothing changed) on its findings. `notes` adds lines to the plan's
 * text.
 */
export async function zonePlan(
  deps: Pick<PhaseDeps, "reporter" | "clock">,
  input: {
    client: CloudflareClient;
    zoneId: string;
    accountId: string;
    zone: string;
    desired: SharedDesired;
    record: SharedRecord | undefined;
    command: string;
    redirect?: boolean;
    notes?: (plan: SharedPlan) => string[];
  },
): Promise<ZonePlan> {
  const { desired } = input;
  const facts = await inspectShared(input.client, {
    zoneId: input.zoneId,
    accountId: input.accountId,
    access: desired.access !== undefined,
    ...(input.redirect === true ? { redirect: true } : {}),
    ...(desired.tls !== undefined
      ? { tls: { proxied: desired.tls.proxied, record: input.record } }
      : {}),
    ...(desired.minTls === true ? { minTls: true } : {}),
    clock: deps.clock,
  });
  const plan = planShared(facts, desired, input.record);
  const details = describeCloudflarePlan(plan, desired, input.zone, input.notes?.(plan));
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

/**
 * Plans the shared Cloudflare change, read-only (ADR 0014): this app's hostnames and the Zero
 * Trust pieces ({@link sharedDesired}) against its record, in the plan's zone (`cloudflare`, from
 * `setupCloudflare`). When the record names another zone that still lists this app's hostnames
 * (the app moved, or the plan uses no Cloudflare zone any more), their removal from that zone is
 * planned too. The `www` redirect rule's phase is read in a zone where the plan or the record
 * lists hostnames there (a site on Cloudflare's hosting). `undefined` when there is nothing to
 * plan. Stops on the plans' findings before anything changes.
 */
export async function planSharedCloudflare(
  deps: Pick<PhaseDeps, "reporter" | "paths" | "env" | "fetch" | "redactor" | "version" | "clock">,
  input: {
    services: Pick<ProvisionServices, "sharedCloudflare">;
    plan: DeployPlan;
    cloudflare: Pick<CloudflareSetup, "zoneId" | "zoneName" | "accountId"> | undefined;
    command: string;
    /** The app's origin TLS and the minimum-TLS decision in the plan's zone (provision). */
    tls?: Pick<SharedDesired, "tls" | "minTls">;
    /** Lines added to the text of the plan's zone plan. */
    notes?: (plan: SharedPlan) => string[];
  },
): Promise<PlannedCloudflare | undefined> {
  const { cloudflare, command } = input;
  const record = await readCloudflareRecord(deps.paths);
  const left =
    record !== undefined && record.zoneId !== cloudflare?.zoneId && listsHostnames(record)
      ? record
      : undefined;
  if (cloudflare === undefined && left === undefined) return undefined;
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
          redirect: listsRedirect(left),
        });
  let main: ZonePlan | undefined;
  if (cloudflare !== undefined) {
    const desired = { ...sharedDesired(input.plan, cloudflare.zoneName), ...input.tls };
    const mine = record?.zoneId === cloudflare.zoneId ? record : undefined;
    main = await zonePlan(deps, {
      client,
      zoneId: cloudflare.zoneId,
      accountId: cloudflare.accountId,
      zone: cloudflare.zoneName,
      desired,
      record: mine,
      command,
      redirect: listsRedirect(desired) || listsRedirect(mine),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
  }
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
  /**
   * Ask with `allowDestroy` and the typed app name even when the plan deletes nothing in
   * Cloudflare (destroy: removing this app's hostnames takes their protection away).
   */
  allowDestroy?: boolean;
  /** The client certificate and its key `upload-client-certificate` sends (never in the plan). */
  keys?: { clientCertificate: string; clientKey: string };
  /** Waits between Cloudflare's reads while a setting deploys (default: real time). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Keeps the origin certificate the apply created, with its key, before anything else happens:
   * also when the apply stops after creating it.
   */
  keepOriginCertificate?: (certificate: string) => Promise<void>;
}
/** The outcome of {@link applySharedCloudflare}. */
export interface SharedCloudflareResult {
  /**
   * The phase result's fields: the hash of the Cloudflare plan with changes this run ended with
   * (applied, or with `planOnly` the one to approve; absent when nothing in Cloudflare changes),
   * and `cloudflarePlanDeletes` when that plan deletes OpsCrew's rule or a ruleset it created, so
   * approving it needs the typed app name (`--confirm <app>` in scripts).
   */
  fields: Pick<ProvisionResult, "cloudflarePlanHash" | "cloudflarePlanDeletes">;
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
export async function applyZonePlan(
  deps: PhaseDeps,
  client: CloudflareClient,
  zone: ZonePlan,
  input: SharedCloudflareInput,
): Promise<{ applied?: SharedApplyResult; approval?: ApprovalRecord; deletes: boolean }> {
  const { plan, details } = zone;
  // A destroy showed the plan in its deletion preview already.
  if (input.allowDestroy !== true) deps.reporter.info(details);
  // Deleting OpsCrew's rule (or a ruleset it created) needs the typed app name.
  const deletes =
    input.allowDestroy === true ||
    plan.changes.some(
      (change) => change.kind === "delete-rule" || change.kind === "delete-entrypoint",
    );
  if (plan.changes.length === 0) {
    deps.reporter.success(
      listsHostnames(plan.record) || zone.desired.access !== undefined
        ? "OpsCrew's shared Cloudflare resources are already set up for this app; nothing in Cloudflare changes."
        : "None of this app's hostnames are in OpsCrew's shared Cloudflare rules there; nothing in Cloudflare changes.",
    );
    // Hostnames removed from OpsCrew's rules by hand and no longer wanted leave the record; a
    // `--plan-only` run writes nothing.
    if (!input.planOnly) await writeCloudflareRecord(deps.paths, plan.record);
    return { deletes: false };
  }
  if (input.planOnly) {
    deps.reporter.info(
      `The Cloudflare plan (hash ${plan.hash}) is not applied; nothing in Cloudflare was changed.`,
    );
    return { deletes };
  }
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
    applied = await applyShared(client, plan, {
      approvedHash: plan.hash,
      ...(input.keys !== undefined ? { keys: input.keys } : {}),
      ...(plan.csr !== undefined ? { csr: plan.csr } : {}),
      clock: deps.clock,
      ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    });
  } catch (error) {
    // What reached Cloudflare before the failure is this app's: recorded before the error shows.
    const done = error instanceof SharedApplyError ? error.applied : [];
    if (error instanceof SharedApplyError) {
      if (error.originCertificate !== undefined) {
        await input.keepOriginCertificate?.(error.originCertificate);
      }
      await writeCloudflareRecord(deps.paths, error.record);
    }
    await audit(
      "cloudflare apply failed",
      "refused",
      `changes applied before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  if (applied.originCertificate !== undefined) {
    await input.keepOriginCertificate?.(applied.originCertificate);
  }
  await writeCloudflareRecord(deps.paths, applied.record);
  for (const id of applied.applied) await audit(`cloudflare change ${id}`, "approved", id);
  deps.reporter.success(
    `Changed OpsCrew's shared Cloudflare resources (${plural(applied.applied.length, "change")} applied).`,
  );
  return { applied, approval, deletes };
}

/**
 * The shared Cloudflare change, before the infrastructure plan: each plan of
 * {@link planSharedCloudflare} is shown, approved by its hash (`cloudflare-apply`, with the typed
 * app name when it deletes OpsCrew's rule; `--yes` never grants it) and applied, and
 * `.opscrew/cloudflare.json` is written, also when nothing changes (which asks nothing). The
 * removal from a zone the app leaves goes first; without a zone of its own the record then lists
 * no hostnames. With `planOnly` the plans are only shown, and nothing is written.
 */
export async function applySharedCloudflare(
  deps: PhaseDeps,
  planned: PlannedCloudflare,
  input: SharedCloudflareInput,
): Promise<SharedCloudflareResult> {
  const { command } = input;
  const approvals: ApprovalRecord[] = [];
  let fields: SharedCloudflareResult["fields"] = {};
  let applied = false;
  let oneTimePinId: string | undefined;
  for (const zone of [planned.leave, planned.main]) {
    if (zone === undefined) continue;
    const { plan } = zone;
    const change = await applyZonePlan(deps, planned.client, zone, input);
    if (plan.changes.length > 0) {
      fields = {
        cloudflarePlanHash: plan.hash,
        ...(change.deletes ? { cloudflarePlanDeletes: true as const } : {}),
      };
    }
    // The new zone's plan is shown once this one is applied: one Cloudflare plan per run.
    if (input.planOnly && plan.changes.length > 0 && zone === planned.leave && planned.main) {
      deps.reporter.info(
        `After this Cloudflare plan is applied (\`${command} --approve ${plan.hash}\`), run \`${command}\` again for the plans that follow.`,
      );
      return { fields, applied: false, approvals, infrastructureWaits: true };
    }
    if (change.approval !== undefined) approvals.push(change.approval);
    applied ||= change.applied !== undefined;
    // Only the plan's own zone (the last) reads the one-time PIN login.
    oneTimePinId = change.applied?.oneTimePinId ?? plan.oneTimePinId;
  }
  const { main } = planned;
  const waits =
    input.planOnly && main?.desired.access?.oneTimePin === true && oneTimePinId === undefined;
  if (waits) {
    deps.reporter.info(
      `The infrastructure plan follows once this Cloudflare plan is applied, because it needs the one-time PIN login the Cloudflare plan adds (in scripts: run \`${command} --approve ${main.plan.hash}\`, then again with \`--approve\` and the infrastructure plan's hash).`,
    );
  }
  return {
    fields,
    applied,
    approvals,
    ...(oneTimePinId !== undefined ? { oneTimePinId } : {}),
    infrastructureWaits: waits,
  };
}
