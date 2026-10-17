/**
 * Cloudflare resources several OpsCrew apps share (feature 011, ADR 0014): one OpsCrew rule per
 * phase in a zone, found by its fixed `ref` and listing the hostnames of every OpsCrew app there,
 * and the account's Zero Trust organization and one-time PIN login. `inspectShared` reads them,
 * `planShared` plans one app's change, `applyShared` applies a plan approved by its hash
 * (`cloudflare-apply`). A rule OpsCrew did not create is never written. See
 * `specs/011-shared-cloudflare-zone/contracts/cloudflare-shared.md`.
 */
import {
  canonicalJson,
  isPlanHash,
  listText,
  normalizeHostName,
  OpsCrewError,
  plural,
  sha256Hex,
} from "@opscrew/core";
import { z } from "zod";
import {
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareClient,
  type CloudflareRuleInput,
  type EntrypointRuleset,
  type RulesetRule,
} from "./client";

/** The phases OpsCrew keeps one shared rule in, and the rule's fixed `ref`. */
export const SHARED_RULES = {
  "opscrew-block-probes": { phase: "http_request_firewall_custom" },
  "opscrew-strict-tls": { phase: "http_config_settings" },
} as const;
export type SharedRuleRef = keyof typeof SHARED_RULES;
type SharedPhase = (typeof SHARED_RULES)[SharedRuleRef]["phase"];

const REFS = Object.keys(SHARED_RULES) as SharedRuleRef[];

/** Cloudflare refuses longer rule expressions (research R3). */
const MAX_EXPRESSION_LENGTH = 4096;

/** The paths the block rule matches, as today's `cloudflare-waf` module wrote them. */
const PROBE_PATHS = [
  'http.request.uri.path contains "/.env"',
  'starts_with(http.request.uri.path, "/.git")',
  'http.request.uri.path contains "/wp-admin"',
  'http.request.uri.path contains "/wp-login.php"',
  'http.request.uri.path contains "/xmlrpc.php"',
  'http.request.uri.path contains "/phpmyadmin"',
].join(" or ");

interface RuleTemplate {
  description: string;
  action: string;
  parameters?: Record<string, string>;
  /** What follows the hostname set in the expression. */
  suffix: string;
  /** The phase's rules as the dashboard names them. */
  label: string;
  /** The token permission that reads and edits them. */
  permission: string;
  /** How a user puts a changed rule back. */
  restore: string;
}

const TEMPLATES: Record<SharedRuleRef, RuleTemplate> = {
  "opscrew-block-probes": {
    description: "OpsCrew: block probes for secrets and admin panels",
    action: "block",
    suffix: ` and (${PROBE_PATHS})`,
    label: "WAF custom rules",
    permission: "Zone → Zone WAF → Edit",
    restore: `set it back to the action Block, turned on, with the expression (http.host in {…its quoted hostnames…}) and (${PROBE_PATHS})`,
  },
  "opscrew-strict-tls": {
    description: "OpsCrew: verify the origin certificate (Full (strict) TLS)",
    action: "set_config",
    parameters: { ssl: "strict" },
    suffix: "",
    label: "configuration rules",
    permission: "Zone → Config Rules → Edit",
    restore:
      "set it back to turned on, with only the SSL setting Strict and the expression (http.host in {…its quoted hostnames…})",
  },
};

/** A Cloudflare plan's name and how many rules a zone on it may hold in each OpsCrew phase. */
interface PlanLimits {
  name: string;
  limits: Record<SharedRuleRef, number>;
}

/**
 * The rule limits by the zone's plan (`plan.legacy_id`). For a plan not listed, OpsCrew does not
 * count, and Cloudflare's own refusal stops the apply.
 */
const RULE_LIMITS = new Map<string, PlanLimits>([
  ["free", { name: "Free", limits: { "opscrew-block-probes": 5, "opscrew-strict-tls": 10 } }],
  ["pro", { name: "Pro", limits: { "opscrew-block-probes": 20, "opscrew-strict-tls": 25 } }],
  [
    "business",
    { name: "Business", limits: { "opscrew-block-probes": 100, "opscrew-strict-tls": 50 } },
  ],
  [
    "enterprise",
    { name: "Enterprise", limits: { "opscrew-block-probes": 1000, "opscrew-strict-tls": 300 } },
  ],
]);

/** A hostname OpsCrew writes into an expression: lower-case labels joined by dots. */
const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** The hostname set at the start of an OpsCrew expression: quoted names, separated by spaces. */
const HOST_SET = /^\(http\.host in \{("[a-z0-9.-]+"(?: "[a-z0-9.-]+")*)\}\)/;

/** What `inspectShared` read. */
export interface SharedFacts {
  zoneId: string;
  accountId: string;
  /** The zone's plan (`free`, `pro`, `business`, `enterprise`), when Cloudflare says. */
  zonePlan?: string;
  /** Per phase: the entrypoint ruleset (absent when Cloudflare answered 404). */
  entrypoints: Record<string, EntrypointRuleset | undefined>;
  /** Phases whose entrypoint the token may not read (HTTP 403). */
  deniedPhases?: string[];
  /** Present only when Access is wanted. */
  organization?: { authDomain: string } | undefined;
  oneTimePinId?: string | undefined;
}

export interface SharedDesired {
  /** This app's hostnames, lower case (empty on destroy). */
  hostnames: string[];
  /** Access wanted: ensure the organization (with this auth domain) and the one-time PIN. */
  access?: { authDomain: string; oneTimePin: boolean };
}

/** `.opscrew/cloudflare.json` (data-model.md), or undefined when the app has none yet. */
export interface SharedRecord {
  zoneId: string;
  hostnames: Partial<Record<SharedRuleRef, string[]>>;
  createdEntrypoints: string[];
}

const Hostnames = z.array(z.string().regex(HOSTNAME)).optional();

/**
 * `.opscrew/cloudflare.json` as read from disk: a 32-hex zone id, OpsCrew's two rule refs with
 * lower-case hostnames, and phases. Unknown keys are refused, so a damaged file stops the command.
 */
export const SharedRecordSchema: z.ZodType<SharedRecord> = z.strictObject({
  zoneId: z.string().regex(/^[0-9a-f]{32}$/),
  hostnames: z.strictObject({ "opscrew-block-probes": Hostnames, "opscrew-strict-tls": Hostnames }),
  createdEntrypoints: z.array(z.enum(["http_request_firewall_custom", "http_config_settings"])),
});

/** One change of a shared plan; rule bodies and ids are exactly what is sent. */
export type SharedChange =
  | { kind: "create-entrypoint"; phase: SharedPhase; rule: CloudflareRuleInput }
  | { kind: "add-rule"; phase: SharedPhase; rulesetId: string; rule: CloudflareRuleInput }
  | {
      kind: "update-hostnames";
      phase: SharedPhase;
      rulesetId: string;
      ruleId: string;
      add: string[];
      remove: string[];
    }
  | { kind: "delete-rule"; phase: SharedPhase; rulesetId: string; ruleId: string }
  | { kind: "delete-entrypoint"; phase: SharedPhase; rulesetId: string }
  | { kind: "create-organization"; authDomain: string }
  | { kind: "create-identity-provider"; type: "onetimepin" };

type RuleChange = Extract<SharedChange, { phase: SharedPhase }>;

/** A blocking finding: what OpsCrew found and the next step, in plain English. */
export interface SharedFinding {
  code:
    | "hostname-claimed"
    | "no-rule-slot"
    | "expression-too-long"
    | "rule-changed"
    | "permission-missing";
  message: string;
  hint: string;
}

/** One app's change to the shared resources. */
export interface SharedPlan {
  zoneId: string;
  accountId: string;
  changes: SharedChange[];
  /** Per phase the plan changes: OpsCrew's rule as it was read (`null` when absent). */
  expect: Partial<Record<SharedPhase, { id: string; hostnames: string[] } | null>>;
  /** Any finding means the plan cannot be applied. */
  findings: SharedFinding[];
  /**
   * The app's record before the plan, and once it is applied (also write `record` after a plan
   * with no changes and no findings). Local only, never sent to Cloudflare, so not in the hash.
   */
  previous: SharedRecord | undefined;
  record: SharedRecord;
  /** The Zero Trust pieces that already exist (returned by the apply). */
  organization?: { authDomain: string };
  oneTimePinId?: string;
  /** SHA-256 of the canonical JSON of `zoneId`, `accountId`, `changes` and `expect`. */
  hash: string;
}

export interface SharedApplyResult {
  /** The changes made, in order: `<kind> <phase>` for rules, `<kind>` for Zero Trust. */
  applied: string[];
  record: SharedRecord;
  organization?: { authDomain: string };
  oneTimePinId?: string;
}

/**
 * An apply that stopped part-way: `applied` lists the changes made before the failure and
 * `record` is the app's record after them (save it). A hostname of the write that failed counts
 * as this app's, as that write may have reached Cloudflare.
 */
export class SharedApplyError extends OpsCrewError {
  readonly applied: string[];
  readonly record: SharedRecord;

  constructor(
    code: OpsCrewError["code"],
    message: string,
    options: { hint?: string; cause?: unknown },
    applied: string[],
    record: SharedRecord,
  ) {
    super(code, message, options);
    this.name = "SharedApplyError";
    this.applied = applied;
    this.record = record;
  }
}

// --- Inspect -------------------------------------------------------------------------------------

/**
 * Reads the zone's plan and its two entrypoint rulesets and, when `access` is set, the account's
 * Zero Trust organization and its one-time PIN login method. Read-only.
 */
export async function inspectShared(
  client: CloudflareClient,
  opts: { zoneId: string; accountId: string; access: boolean },
): Promise<SharedFacts> {
  const zonePlan = await client.zonePlan(opts.zoneId);
  const entrypoints: Record<string, EntrypointRuleset | undefined> = {};
  const deniedPhases: string[] = [];
  for (const ref of REFS) {
    const { phase } = SHARED_RULES[ref];
    const read = await client.entrypointRuleset(opts.zoneId, phase);
    if (read === "forbidden") deniedPhases.push(phase);
    else entrypoints[phase] = read;
  }
  const facts: SharedFacts = {
    zoneId: opts.zoneId,
    accountId: opts.accountId,
    ...(zonePlan ? { zonePlan } : {}),
    entrypoints,
  };
  if (deniedPhases.length > 0) facts.deniedPhases = deniedPhases;
  if (!opts.access) return facts;
  const organization = await client.accessOrganization(opts.accountId);
  if (!organization) return facts;
  const providers = await client.accessIdentityProviders(opts.accountId);
  const oneTimePinId = providers.find((provider) => provider.type === "onetimepin")?.id;
  return { ...facts, organization, ...(oneTimePinId ? { oneTimePinId } : {}) };
}

// --- Plan ----------------------------------------------------------------------------------------

/** Pure: the changes, blocking findings and the plan's SHA-256 (`plan.hash`). */
export function planShared(
  facts: SharedFacts,
  desired: SharedDesired,
  record: SharedRecord | undefined,
): SharedPlan {
  if (record && record.zoneId !== facts.zoneId) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `This app's Cloudflare record is for the zone ${record.zoneId}, not ${facts.zoneId}.`,
      {
        hint: "Plan the removal of this app's hostnames in the zone of its record first, then plan again.",
      },
    );
  }
  const hostnames = appHostnames(desired.hostnames);
  const changes: SharedChange[] = [];
  const findings: SharedFinding[] = [];
  const expect: SharedPlan["expect"] = {};
  for (const ref of REFS) {
    const { phase } = SHARED_RULES[ref];
    if (facts.deniedPhases?.includes(phase)) {
      findings.push(permissionMissing(ref));
      continue;
    }
    const entrypoint = facts.entrypoints[phase];
    const planned = planRule(
      ref,
      entrypoint,
      hostnames,
      record?.hostnames[ref] ?? [],
      facts.zonePlan,
    );
    if ("finding" in planned) {
      findings.push(planned.finding);
      continue;
    }
    if (planned.changes.length === 0) continue;
    changes.push(...planned.changes);
    const rule = ownRule(ref, entrypoint);
    expect[phase] = rule ? { id: rule.id, hostnames: hostnamesOf(ref, rule) ?? [] } : null;
  }
  if (desired.access) {
    if (!facts.organization) {
      changes.push({ kind: "create-organization", authDomain: desired.access.authDomain });
    }
    if (desired.access.oneTimePin && !facts.oneTimePinId) {
      changes.push({ kind: "create-identity-provider", type: "onetimepin" });
    }
  }
  const plan: Omit<SharedPlan, "hash"> = {
    zoneId: facts.zoneId,
    accountId: facts.accountId,
    changes,
    expect,
    findings,
    previous: record,
    record: {
      zoneId: facts.zoneId,
      hostnames: hostnames.length === 0 ? {} : Object.fromEntries(REFS.map((r) => [r, hostnames])),
      createdEntrypoints: createdAfter(record, changes),
    },
    ...(facts.organization ? { organization: facts.organization } : {}),
    ...(facts.oneTimePinId ? { oneTimePinId: facts.oneTimePinId } : {}),
  };
  return { ...plan, hash: sharedPlanHash(plan) };
}

/** The changes to one shared rule, or the finding that stops them. */
function planRule(
  ref: SharedRuleRef,
  entrypoint: EntrypointRuleset | undefined,
  hostnames: readonly string[],
  mine: readonly string[],
  zonePlan: string | undefined,
): { changes: RuleChange[] } | { finding: SharedFinding } {
  const { phase } = SHARED_RULES[ref];
  const rule = ownRule(ref, entrypoint);
  let current: string[] = [];
  if (rule) {
    const differences = ruleDifferences(ref, rule);
    if (differences.length > 0) return { finding: ruleChanged(ref, differences) };
    current = hostnamesOf(ref, rule) ?? [];
  }
  const claimed = hostnames.filter((h) => current.includes(h) && !mine.includes(h));
  if (claimed.length > 0) return { finding: hostnameClaimed(ref, claimed) };
  const add = hostnames.filter((h) => !current.includes(h));
  const remove = mine.filter((h) => !hostnames.includes(h) && current.includes(h)).sort();
  if (add.length === 0 && remove.length === 0) return { changes: [] };
  const next = [...current, ...add].filter((h) => !remove.includes(h)).sort();
  const body = ruleBody(ref, next);
  if (next.length > 0 && body.expression.length > MAX_EXPRESSION_LENGTH) {
    return { finding: expressionTooLong(ref, body.expression.length, current.length) };
  }
  if (!entrypoint) return { changes: [{ kind: "create-entrypoint", phase, rule: body }] };
  const rulesetId = entrypoint.id;
  if (!rule) {
    const plan = zonePlan === undefined ? undefined : RULE_LIMITS.get(zonePlan);
    if (plan && entrypoint.rules.length >= plan.limits[ref]) {
      return { finding: noRuleSlot(ref, entrypoint.rules.length, plan) };
    }
    return { changes: [{ kind: "add-rule", phase, rulesetId, rule: body }] };
  }
  if (next.length > 0) {
    return {
      changes: [{ kind: "update-hostnames", phase, rulesetId, ruleId: rule.id, add, remove }],
    };
  }
  const changes: RuleChange[] = [{ kind: "delete-rule", phase, rulesetId, ruleId: rule.id }];
  if (entrypoint.rules.length === 1) changes.push({ kind: "delete-entrypoint", phase, rulesetId });
  return { changes };
}

/** The plan's hash: SHA-256 of the canonical JSON of what the apply sends and expects. */
function sharedPlanHash(plan: Pick<SharedPlan, "zoneId" | "accountId" | "changes" | "expect">) {
  const { zoneId, accountId, changes, expect } = plan;
  return sha256Hex(canonicalJson({ zoneId, accountId, changes, expect }));
}

/** The app's hostnames: lower case, unique, sorted; anything that is not a hostname is refused. */
function appHostnames(hostnames: readonly string[]): string[] {
  const names = [...new Set(hostnames.map(normalizeHostName))].sort();
  const invalid = names.filter((name) => !HOSTNAME.test(name));
  if (invalid.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(invalid.map((name) => JSON.stringify(name)))} cannot go into a Cloudflare rule: a hostname has only letters, digits, hyphens and dots.`,
      { hint: "Check the app's domain and hostnames, then run the command again." },
    );
  }
  return names;
}

// --- Rules ---------------------------------------------------------------------------------------

/** The rule OpsCrew writes for `hostnames` (sorted, lower case). */
function ruleBody(ref: SharedRuleRef, hostnames: readonly string[]): CloudflareRuleInput {
  const template = TEMPLATES[ref];
  return {
    ref,
    description: template.description,
    expression: `(http.host in {${hostnames.map((h) => `"${h}"`).join(" ")}})${template.suffix}`,
    action: template.action,
    ...(template.parameters ? { action_parameters: { ...template.parameters } } : {}),
    enabled: true,
  };
}

function ownRule(ref: SharedRuleRef, entrypoint: EntrypointRuleset | undefined) {
  return entrypoint?.rules.find((rule) => rule.ref === ref);
}

/** The hostname set of an OpsCrew expression, or undefined when the rest is not the template's. */
function hostnamesOf(ref: SharedRuleRef, rule: RulesetRule): string[] | undefined {
  const match = HOST_SET.exec(rule.expression);
  if (!match?.[1] || rule.expression.slice(match[0].length) !== TEMPLATES[ref].suffix) {
    return undefined;
  }
  return [...new Set(match[1].slice(1, -1).split('" "'))].sort();
}

/** How OpsCrew's rule differs from its template, apart from its hostnames (none: as written). */
function ruleDifferences(ref: SharedRuleRef, rule: RulesetRule): string[] {
  const template = TEMPLATES[ref];
  const out: string[] = [];
  if (rule.action !== template.action) {
    out.push(`its action is "${rule.action}" instead of "${template.action}"`);
  }
  if (canonicalJson(rule.actionParameters ?? null) !== canonicalJson(template.parameters ?? null)) {
    out.push(
      template.parameters
        ? "its settings are not just the SSL setting Strict"
        : "it has settings OpsCrew does not set",
    );
  }
  if (!rule.enabled) out.push("it is turned off");
  if (!hostnamesOf(ref, rule)) out.push("its expression is not the one OpsCrew writes");
  return out;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

// --- Findings ------------------------------------------------------------------------------------

function permissionMissing(ref: SharedRuleRef): SharedFinding {
  const { label, permission } = TEMPLATES[ref];
  return {
    code: "permission-missing",
    message: `The Cloudflare token may not read the zone's ${label} (HTTP 403).`,
    hint: `Edit the token at ${CLOUDFLARE_TOKEN_PAGE} and give it ${permission} for this zone, then run the command again.`,
  };
}

function hostnameClaimed(ref: SharedRuleRef, hostnames: readonly string[]): SharedFinding {
  const { description, label } = TEMPLATES[ref];
  const one = hostnames.length === 1;
  return {
    code: "hostname-claimed",
    message: `${listText([...hostnames])} ${one ? "is" : "are"} already in OpsCrew's shared rule "${description}" in this zone, but this app did not add ${one ? "it" : "them"}: another OpsCrew app uses ${one ? "it" : "them"}, or one whose project folder is gone.`,
    hint: `OpsCrew never takes a hostname from another app. Use another hostname; or, if the app that added ${one ? "it" : "them"} is gone, remove ${one ? "it" : "them"} from that rule's hostname list in the zone's ${label} in the Cloudflare dashboard, then run the command again.`,
  };
}

function noRuleSlot(ref: SharedRuleRef, count: number, plan: PlanLimits): SharedFinding {
  const { description, label } = TEMPLATES[ref];
  const upgrade = plan.name === "Enterprise" ? "" : ", or move the zone to a higher plan";
  return {
    code: "no-rule-slot",
    message: `The zone's ${label} already hold ${plural(count, "rule")}, the most Cloudflare's ${plan.name} plan allows (${plan.limits[ref].toLocaleString("en-US")}), so OpsCrew cannot add its rule "${description}".`,
    hint: `Delete or merge one of the zone's ${label} in the Cloudflare dashboard${upgrade}, then run the command again. OpsCrew needs one rule there for all its apps in the zone.`,
  };
}

function expressionTooLong(ref: SharedRuleRef, length: number, listed: number): SharedFinding {
  const { description } = TEMPLATES[ref];
  return {
    code: "expression-too-long",
    message: `With this app's hostnames, OpsCrew's shared rule "${description}" would be ${length.toLocaleString("en-US")} characters long, over Cloudflare's limit of 4,096. It already lists ${plural(listed, "hostname")}.`,
    hint: "Give this app fewer hostnames, or destroy OpsCrew apps in this zone you no longer need (opscrew destroy), then run the command again.",
  };
}

function ruleChanged(ref: SharedRuleRef, differences: readonly string[]): SharedFinding {
  const { description, label, restore } = TEMPLATES[ref];
  return {
    code: "rule-changed",
    message: `OpsCrew's shared rule "${description}" in the zone's ${label} was changed outside OpsCrew: ${listText([...differences])}. OpsCrew does not overwrite it.`,
    hint: `In the Cloudflare dashboard, ${restore}; or delete the rule so OpsCrew creates it again (other OpsCrew apps in the zone add their hostnames back on their next provision). Then run the command again.`,
  };
}

// --- Apply ---------------------------------------------------------------------------------------

/**
 * Applies an approved plan: throws OpsCrewError PLAN_HASH_MISMATCH when `approvedHash` differs,
 * PHASE_PRECONDITION when the plan has findings or OpsCrew's rule changed since the plan (nothing
 * written), and SharedApplyError {applied, record} when a write fails part-way. Every phase the
 * plan changes is read again before the first write and before each write; every write is sent
 * once and checked against the ruleset Cloudflare returns.
 */
export async function applyShared(
  client: CloudflareClient,
  plan: SharedPlan,
  opts: { approvedHash: string },
): Promise<SharedApplyResult> {
  if (!isPlanHash(opts.approvedHash) || opts.approvedHash.toLowerCase() !== sharedPlanHash(plan)) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This Cloudflare plan is not the one that was approved, so OpsCrew changes nothing in Cloudflare.",
      { hint: "Look at the current Cloudflare plan and approve it by its hash." },
    );
  }
  if (plan.findings.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew cannot change the shared Cloudflare rules yet: ${plan.findings.map((f) => f.message).join(" ")}`,
      { hint: plan.findings.map((f) => f.hint).join(" ") },
    );
  }
  const ruleChanges = plan.changes.filter((c): c is RuleChange => "phase" in c);
  for (const phase of new Set(ruleChanges.map((c) => c.phase))) {
    const first = ruleChanges.find((c) => c.phase === phase) as RuleChange;
    const reason = staleReason(plan, first, await readPhase(client, plan.zoneId, phase));
    if (reason) throw staleError(phase, reason, "OpsCrew changed nothing.");
  }

  const done: SharedChange[] = [];
  let sent: SharedChange | undefined;
  let organization = plan.organization;
  let oneTimePinId = plan.oneTimePinId;
  for (const change of plan.changes) {
    try {
      if (change.kind === "create-organization") {
        sent = change;
        organization = await client.createAccessOrganization(plan.accountId, change.authDomain);
      } else if (change.kind === "create-identity-provider") {
        sent = change;
        oneTimePinId = await client.createOneTimePinProvider(plan.accountId);
      } else {
        const reason = staleReason(
          plan,
          change,
          await readPhase(client, plan.zoneId, change.phase),
        );
        if (reason) throw staleError(change.phase, reason, "OpsCrew stopped before changing them.");
        sent = change;
        await writeRule(client, plan, change);
      }
      done.push(change);
      sent = undefined;
    } catch (error) {
      const record = recordAfter(plan, done, sent);
      const applied = done.map(changeId);
      if (error instanceof OpsCrewError) {
        throw new SharedApplyError(
          error.code,
          error.message,
          { ...(error.hint === undefined ? {} : { hint: error.hint }), cause: error },
          applied,
          record,
        );
      }
      throw new SharedApplyError(
        "INTERNAL",
        "OpsCrew stopped on an error it did not expect while changing the shared Cloudflare rules.",
        { hint: "Run the command again to see the current state.", cause: error },
        applied,
        record,
      );
    }
  }
  return {
    applied: done.map(changeId),
    record: plan.record,
    ...(organization ? { organization } : {}),
    ...(oneTimePinId ? { oneTimePinId } : {}),
  };
}

function changeId(change: SharedChange): string {
  return "phase" in change ? `${change.kind} ${change.phase}` : change.kind;
}

function refOf(phase: SharedPhase): SharedRuleRef {
  return REFS.find((ref) => SHARED_RULES[ref].phase === phase) as SharedRuleRef;
}

/** The phase's entrypoint, read again; a refused read stops with the permission to add. */
async function readPhase(
  client: CloudflareClient,
  zoneId: string,
  phase: SharedPhase,
): Promise<EntrypointRuleset | undefined> {
  const read = await client.entrypointRuleset(zoneId, phase);
  if (read !== "forbidden") return read;
  const finding = permissionMissing(refOf(phase));
  throw new OpsCrewError("CREDENTIALS_INVALID", finding.message, { hint: finding.hint });
}

/** Why the phase no longer is what the plan expected before `change` (undefined: it is). */
function staleReason(
  plan: SharedPlan,
  change: RuleChange,
  current: EntrypointRuleset | undefined,
): string | undefined {
  if (change.kind === "create-entrypoint") {
    return current ? "the zone has a ruleset for them now" : undefined;
  }
  if (!current || current.id !== change.rulesetId) return "their ruleset was deleted or replaced";
  if (change.kind === "delete-entrypoint") {
    return current.rules.length > 0 ? "their ruleset holds a rule again" : undefined;
  }
  const ref = refOf(change.phase);
  const rule = ownRule(ref, current);
  if (change.kind === "add-rule") return rule ? "OpsCrew's rule was added since" : undefined;
  const expected = plan.expect[change.phase];
  if (!rule || !expected || rule.id !== expected.id) {
    return "OpsCrew's rule was deleted or replaced";
  }
  if (ruleDifferences(ref, rule).length > 0) {
    return "OpsCrew's rule was changed beyond its hostnames";
  }
  if (!sameList(hostnamesOf(ref, rule) ?? [], expected.hostnames)) {
    return "another OpsCrew app added or removed hostnames in OpsCrew's rule";
  }
  const deletesRuleset = plan.changes.some(
    (c) => c.kind === "delete-entrypoint" && c.phase === change.phase,
  );
  if (deletesRuleset && current.rules.length > 1) return "their ruleset holds another rule now";
  return undefined;
}

function staleError(phase: SharedPhase, reason: string, outcome: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The zone's ${TEMPLATES[refOf(phase)].label} changed after this Cloudflare plan was made: ${reason}. ${outcome}`,
    {
      hint: "Run the command again to make a new plan from the current rules, and approve that one.",
    },
  );
}

/** Sends one rule change and checks the ruleset Cloudflare returns. */
async function writeRule(
  client: CloudflareClient,
  plan: SharedPlan,
  change: RuleChange,
): Promise<void> {
  const ref = refOf(change.phase);
  switch (change.kind) {
    case "delete-entrypoint":
      await client.deleteRuleset(plan.zoneId, change.rulesetId);
      return;
    case "delete-rule": {
      const after = await client.deleteRulesetRule(plan.zoneId, change.rulesetId, change.ruleId);
      if (after.id !== change.rulesetId || ownRule(ref, after)) {
        throw notShown(ref, "still lists OpsCrew's rule");
      }
      return;
    }
    case "create-entrypoint":
      return checkWritten(
        ref,
        change.rule,
        await client.createEntrypointRuleset(plan.zoneId, change.phase, change.rule),
      );
    case "add-rule":
      return checkWritten(
        ref,
        change.rule,
        await client.addRulesetRule(plan.zoneId, change.rulesetId, change.rule),
        change.rulesetId,
      );
    case "update-hostnames": {
      const before = plan.expect[change.phase]?.hostnames ?? [];
      const next = [...before, ...change.add].filter((h) => !change.remove.includes(h)).sort();
      const body = ruleBody(ref, next);
      return checkWritten(
        ref,
        body,
        await client.updateRulesetRule(plan.zoneId, change.rulesetId, change.ruleId, body),
        change.rulesetId,
      );
    }
  }
}

/** Throws unless `after` holds OpsCrew's rule exactly as `body` wrote it. */
function checkWritten(
  ref: SharedRuleRef,
  body: CloudflareRuleInput,
  after: EntrypointRuleset,
  rulesetId?: string,
): void {
  const rule = ownRule(ref, after);
  if (rulesetId !== undefined && after.id !== rulesetId) throw notShown(ref, "is another ruleset");
  if (!rule || rule.expression !== body.expression || ruleDifferences(ref, rule).length > 0) {
    throw notShown(ref, "does not hold OpsCrew's rule as it was sent");
  }
}

function notShown(ref: SharedRuleRef, what: string): OpsCrewError {
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `Cloudflare accepted the change to OpsCrew's rule "${TEMPLATES[ref].description}", but the ruleset it returned ${what}.`,
    {
      hint: "Run the command again to see the current state; if this repeats, report it to OpsCrew.",
    },
  );
}

/**
 * The app's record after the changes in `done`: a phase whose change was made, or that had none,
 * has the plan's hostnames; the phase of the write `sent` (which may have reached Cloudflare)
 * has the hostnames of both records; any other keeps the previous record's.
 */
function recordAfter(
  plan: SharedPlan,
  done: readonly SharedChange[],
  sent: SharedChange | undefined,
): SharedRecord {
  const hostnames: SharedRecord["hostnames"] = {};
  for (const ref of REFS) {
    const before = plan.previous?.hostnames[ref] ?? [];
    const after = plan.record.hostnames[ref] ?? [];
    const change = plan.changes.find(
      (c) => "phase" in c && c.phase === SHARED_RULES[ref].phase && c.kind !== "delete-entrypoint",
    );
    const list =
      !change || done.includes(change)
        ? after
        : change === sent
          ? [...new Set([...before, ...after])].sort()
          : before;
    if (list.length > 0) hostnames[ref] = list;
  }
  return { zoneId: plan.zoneId, hostnames, createdEntrypoints: createdAfter(plan.previous, done) };
}

/** The record's `createdEntrypoints` after `changes`: a deleted entrypoint leaves, a created one joins. */
function createdAfter(previous: SharedRecord | undefined, changes: readonly SharedChange[]) {
  const phases = (kind: SharedChange["kind"]) =>
    changes.flatMap((c): string[] => (c.kind === kind && "phase" in c ? [c.phase] : []));
  const deleted = phases("delete-entrypoint");
  return [
    ...(previous?.createdEntrypoints ?? []).filter((p) => !deleted.includes(p)),
    ...phases("create-entrypoint"),
  ];
}
