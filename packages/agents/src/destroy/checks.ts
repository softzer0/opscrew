import type { ResourceAction, ResourceChange, VpsProviderId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { cloudTarget } from "@opscrew/iac-templates";
import type { CloudDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import { providerProfile } from "../providers";
import { destroyTexts } from "./texts";

/**
 * Terraform type of the Hetzner server, the only resource the protection-lifting plan may change.
 * Only Hetzner has delete protection, so that plan (and this check) exists only there.
 */
export const PROTECTED_SERVER_TYPE = providerProfile("hetzner").serverResourceType;

/** Server attributes the protection-lifting plan is allowed to change. */
export const PROTECTION_ATTRIBUTES: readonly string[] = ["delete_protection", "rebuild_protection"];

const SYMBOL: Record<ResourceAction, string> = {
  create: "+",
  update: "~",
  delete: "-",
  replace: "±",
  read: "?",
  "no-op": " ",
};

/** One line per change, for example `  - delete  module.server.hcloud_server.this`. */
export function describeChanges(changes: readonly ResourceChange[]): string[] {
  return changes.map((c) => `  ${SYMBOL[c.action]} ${c.action.padEnd(7)} ${c.address}`);
}

/**
 * True when the changes delete (or replace) the provider's server, for example an `hcloud_server`
 * on Hetzner or a `digitalocean_droplet` on DigitalOcean.
 */
export function deletesServer(
  changes: readonly ResourceChange[],
  provider: VpsProviderId,
): boolean {
  const type = providerProfile(provider).serverResourceType;
  return changes.some((c) => c.type === type && (c.action === "delete" || c.action === "replace"));
}

/** A provider resource id: a string, or a number (written as a string). */
export const ProviderIdSchema = z.union([
  z.string().trim().min(1),
  z.number().int().nonnegative().transform(String),
]);

const PlanServerIdsSchema = z.looseObject({
  resource_changes: z
    .array(
      z.looseObject({
        type: z.string().optional(),
        change: z
          .looseObject({ actions: z.array(z.string()), before: z.unknown().optional() })
          .optional(),
      }),
    )
    .optional(),
});
const BeforeIdSchema = z.looseObject({ id: ProviderIdSchema });

/**
 * The provider ids (`change.before.id`) of the servers a destroy plan deletes, as the
 * infrastructure state knows them, without duplicates. Empty when the plan JSON does not say.
 * These ids, not the names (names need not be unique), say which server the teardown deletes.
 */
export function serverIdsInPlan(planJson: unknown, provider: VpsProviderId): string[] {
  const parsed = PlanServerIdsSchema.safeParse(planJson);
  if (!parsed.success) return [];
  const type = providerProfile(provider).serverResourceType;
  const ids = new Set<string>();
  for (const rc of parsed.data.resource_changes ?? []) {
    if (rc.type !== type || rc.change?.actions.includes("delete") !== true) continue;
    const before = BeforeIdSchema.safeParse(rc.change.before);
    if (before.success) ids.add(before.data.id);
  }
  return [...ids];
}

const PlanChangesSchema = z.looseObject({
  resource_changes: z
    .array(
      z.looseObject({
        address: z.string(),
        change: z.looseObject({
          actions: z.array(z.string()),
          before: z.unknown(),
          after: z.unknown(),
          after_unknown: z.unknown().optional(),
        }),
      }),
    )
    .optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when an `after_unknown` entry marks any part of the attribute as unknown. */
function containsUnknown(value: unknown): boolean {
  if (value === true) return true;
  if (Array.isArray(value)) return value.some(containsUnknown);
  if (isRecord(value)) return Object.values(value).some(containsUnknown);
  return false;
}

/** JSON with sorted object keys; `undefined` and `null` compare equal. */
function stable(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Sorted top-level attribute names whose known values differ between `before` and `after`. */
function changedAttributes(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  afterUnknown: Record<string, unknown>,
): string[] {
  const names = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
    ...Object.keys(afterUnknown),
  ]);
  // A value only known after apply counts as a change: OpsCrew cannot show it is unchanged.
  return [...names]
    .filter(
      (name) => containsUnknown(afterUnknown[name]) || stable(before[name]) !== stable(after[name]),
    )
    .sort();
}

/**
 * Checks the protection-lifting plan (a normal plan with `delete_protection=false`, or
 * `previous_delete_protection=false` during a move). It may only update `hcloud_server`
 * resources, and only their delete and rebuild protection, turning delete protection off; with
 * `prefix` (for example `module.server_previous.`) only resources whose address starts with it.
 * Returns one plain-English line per violation (attribute names, never values); an empty list
 * means the plan is safe to offer for approval.
 */
export function unprotectPlanProblems(
  changes: readonly ResourceChange[],
  planJson: unknown,
  options: { prefix?: string } = {},
): string[] {
  if (options.prefix !== undefined) assertModulePrefix(options.prefix);
  const parsed = PlanChangesSchema.safeParse(planJson);
  const details = new Map(
    parsed.success ? (parsed.data.resource_changes ?? []).map((rc) => [rc.address, rc.change]) : [],
  );
  const problems: string[] = [];
  for (const change of changes) {
    if (
      change.type !== PROTECTED_SERVER_TYPE ||
      change.action !== "update" ||
      !underPrefix(change.address, options.prefix)
    ) {
      problems.push(`${change.action} ${change.address}`);
      continue;
    }
    const detail = details.get(change.address);
    const before = detail?.before;
    const after = detail?.after;
    if (!isRecord(before) || !isRecord(after)) {
      problems.push(`update ${change.address} (OpsCrew could not tell which settings change)`);
      continue;
    }
    const unknown = isRecord(detail?.after_unknown) ? detail.after_unknown : {};
    const other = changedAttributes(before, after, unknown).filter(
      (name) => !PROTECTION_ATTRIBUTES.includes(name),
    );
    if (other.length > 0) {
      problems.push(`update ${change.address} (${other.join(", ")})`);
    } else if (after.delete_protection !== false) {
      problems.push(`update ${change.address} (does not turn delete protection off)`);
    }
  }
  return problems;
}

/** A destroy plan only deletes; anything else is listed as a problem. */
export function destroyPlanProblems(changes: readonly ResourceChange[]): string[] {
  return changes.filter((c) => c.action !== "delete").map((c) => `${c.action} ${c.address}`);
}

/** True when `address` starts with `prefix`, or there is no prefix. */
function underPrefix(address: string, prefix: string | undefined): boolean {
  if (prefix === undefined) return true;
  assertModulePrefix(prefix);
  return address.startsWith(prefix);
}

const MODULE_PREFIX = /^module\.[A-Za-z0-9_-]+\.$/;

/**
 * Throws `INTERNAL` unless `prefix` is exactly one module's address prefix with its trailing dot
 * (`module.server.`, `module.server_previous.`). Without the dot `module.server` would also match
 * `module.server_previous.…`, and `""` would match everything while looking bounded. Every
 * prefix-bounded check goes through this; callers that plan first call it before planning.
 */
export function assertModulePrefix(prefix: string): void {
  if (!MODULE_PREFIX.test(prefix)) {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew refused an invalid module address prefix ${JSON.stringify(prefix)}; it must look like module.<name>. with the trailing dot. Nothing was changed.`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
}

/** What a deletion plan may delete. */
export interface DeletionBounds {
  /**
   * Address prefix every change must start with, including the trailing dot (for example
   * `module.server_previous.`, so that `module.server_previous_x.…` does not match). Omitted for
   * a teardown of the whole root module.
   */
  prefix?: string;
  /** The addresses the user confirmed in the preview; omitted before the confirmation. */
  confirmed?: ReadonlySet<string>;
}

/** Why a deletion plan may not be applied; every list empty means it may. */
export interface DeletionPlanProblems {
  /** Changes that are not deletes, as `<action> <address>`. */
  notDeletes: string[];
  /** Changes (of any action) outside the prefix, as `<action> <address>`. */
  outsidePrefix: string[];
  /** Deletes under the prefix that were not in the confirmed preview (addresses). */
  unconfirmed: string[];
}

/**
 * Checks a deletion plan: a `destroy` plan of the whole root module, or a normal plan of a root
 * module that no longer declares the module to delete (a move's finish or abort). Every change
 * must be a delete under `bounds.prefix`, and among `bounds.confirmed` when given.
 */
export function deletionPlanProblems(
  changes: readonly ResourceChange[],
  bounds: DeletionBounds = {},
): DeletionPlanProblems {
  const { prefix, confirmed } = bounds;
  if (prefix !== undefined) assertModulePrefix(prefix);
  return {
    notDeletes: destroyPlanProblems(changes),
    outsidePrefix: changes
      .filter((c) => !underPrefix(c.address, prefix))
      .map((c) => `${c.action} ${c.address}`),
    unconfirmed:
      confirmed === undefined
        ? []
        : changes
            .filter(
              (c) =>
                c.action === "delete" &&
                underPrefix(c.address, prefix) &&
                !confirmed.has(c.address),
            )
            .map((c) => c.address),
  };
}

/** True when {@link deletionPlanProblems} found nothing. */
export function deletionPlanIsBounded(problems: DeletionPlanProblems): boolean {
  return (
    problems.notDeletes.length === 0 &&
    problems.outsidePrefix.length === 0 &&
    problems.unconfirmed.length === 0
  );
}

/**
 * True when a deletion plan deletes a provider server other than the confirmed ones: its plan JSON
 * names another id, or none while the confirmed preview did. False when the preview named no id
 * (the state did not say) or the plan deletes no server.
 */
export function deletesUnconfirmedServer(
  summary: { changes: readonly ResourceChange[]; planJson?: unknown },
  provider: VpsProviderId,
  confirmedServerIds: readonly string[],
): boolean {
  const confirmed = new Set(confirmedServerIds);
  if (confirmed.size === 0 || !deletesServer(summary.changes, provider)) return false;
  const ids = serverIdsInPlan(summary.planJson, provider);
  return ids.length === 0 || ids.some((id) => !confirmed.has(id));
}

function knownHostName(entry: string): string {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(entry);
  if (bracketed) return bracketed[2] === "22" ? (bracketed[1] as string) : entry;
  return entry;
}

/**
 * Removes every known_hosts line that names one of `hosts` (plain or `[host]:22` form, marker
 * lines such as `@cert-authority` included) and keeps all other lines and comments.
 */
export function removeHostKeys(
  text: string,
  hosts: readonly string[],
): { text: string; removed: number } {
  const wanted = new Set(hosts.map((h) => h.toLowerCase()));
  let removed = 0;
  const kept = text.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    if (trimmed === "") return false;
    if (trimmed.startsWith("#")) return true;
    const fields = trimmed.split(/\s+/);
    const hostField = (trimmed.startsWith("@") ? fields[1] : fields[0]) ?? "";
    const names = hostField.split(",").map((name) => knownHostName(name).toLowerCase());
    if (names.some((name) => wanted.has(name))) {
      removed++;
      return false;
    }
    return true;
  });
  return { text: kept.length > 0 ? `${kept.join("\n")}\n` : "", removed };
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * Plain-English warning about data that exists only on the server, or `undefined` when the plan
 * does not delete the server. Automatic backups are lost with a Hetzner server but kept for a
 * while by DigitalOcean, and the warning says which. `target` is the deleted server's target
 * (default `plan.target`; during a move the old server's is `plan.retarget.from.target`).
 */
export function dataWarning(
  plan: Pick<DeployPlan, "services" | "target">,
  serverDeleted: boolean,
  target: Pick<CloudDeployTarget, "provider" | "backups"> = cloudTarget(plan.target),
): string | undefined {
  if (!serverDeleted) return undefined;
  const texts = destroyTexts(target.provider);
  const lost: string[] = [];
  if (plan.services.postgres) lost.push("the PostgreSQL database");
  if (plan.services.redis) lost.push("the Redis data");
  lost.push(`any files the app stored on the ${texts.noun}`);
  if (target.backups && texts.deletedBackups) lost.push(texts.deletedBackups);
  const deleted = `Deleting the ${texts.noun} also deletes ${joinList(lost)}.`;
  if (target.backups && texts.keptBackups) {
    return `${deleted} ${texts.keptBackups}; only a snapshot keeps a copy for longer.`;
  }
  return `${deleted} Only a snapshot keeps a copy.`;
}
