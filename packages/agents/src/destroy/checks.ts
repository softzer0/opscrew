import type { ResourceAction, ResourceChange } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";

/** Terraform type of the server; the only resource the protection-lifting plan may change. */
export const SERVER_RESOURCE_TYPE = "hcloud_server";

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

/** True when the changes delete (or replace) an `hcloud_server`. */
export function deletesServer(changes: readonly ResourceChange[]): boolean {
  return changes.some(
    (c) => c.type === SERVER_RESOURCE_TYPE && (c.action === "delete" || c.action === "replace"),
  );
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
 * Checks the protection-lifting plan (a normal plan with `delete_protection=false`). It may only
 * update `hcloud_server` resources, and only their delete and rebuild protection, turning delete
 * protection off. Returns one plain-English line per violation (attribute names, never values);
 * an empty list means the plan is safe to offer for approval.
 */
export function unprotectPlanProblems(
  changes: readonly ResourceChange[],
  planJson: unknown,
): string[] {
  const parsed = PlanChangesSchema.safeParse(planJson);
  const details = new Map(
    parsed.success ? (parsed.data.resource_changes ?? []).map((rc) => [rc.address, rc.change]) : [],
  );
  const problems: string[] = [];
  for (const change of changes) {
    if (change.type !== SERVER_RESOURCE_TYPE || change.action !== "update") {
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
 * does not delete the server.
 */
export function dataWarning(plan: DeployPlan, serverDeleted: boolean): string | undefined {
  if (!serverDeleted) return undefined;
  const lost: string[] = [];
  if (plan.services.postgres) lost.push("the PostgreSQL database");
  if (plan.services.redis) lost.push("the Redis data");
  lost.push("any files the app stored on the server");
  if (plan.target.backups) lost.push("Hetzner's automatic backups of the server");
  return `Deleting the server also deletes ${joinList(lost)}. Only a snapshot keeps a copy.`;
}
