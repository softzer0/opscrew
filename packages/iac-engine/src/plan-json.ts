import type {
  PlanSummary,
  ResourceAction,
  ResourceChange,
  ResourceDrift,
  ResourceMove,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";

/** What `parsePlanJson` extracts from a machine-readable plan (`show -json`). */
export interface ParsedPlan {
  /** Every change except `no-op` and `read`, in the order the engine reported them. */
  changes: ResourceChange[];
  counts: PlanSummary["counts"];
  /** True when any change is a `delete` or `replace`. */
  hasDestroy: boolean;
  /**
   * Managed resources changed outside the engine (`resource_drift`), in the engine's order.
   * Present only when there is any. Carries attribute names, never values.
   */
  drift?: ResourceDrift[];
  /**
   * Resources whose state address changes (`previous_address`, from `moved` blocks), in the
   * engine's order. Present only when there is any. A pure move is not a change; a moved and
   * changed resource is also listed in `changes` at its new address.
   */
  moves?: ResourceMove[];
}

function invalid(detail: string): OpsCrewError {
  return new OpsCrewError(
    "ENGINE_FAILED",
    `The engine's plan output could not be read: ${detail}.`,
    {
      hint: "Check that the installed OpenTofu or Terraform version is 1.6 or newer, then create the plan again.",
    },
  );
}

/**
 * Maps a `change.actions` list to one action. `forget` (remove from state without destroying)
 * is treated as `delete` so that it needs the same explicit `allowDestroy` approval.
 */
function toAction(actions: readonly string[]): ResourceAction {
  const key = actions.join(",");
  switch (key) {
    case "create":
    case "update":
    case "delete":
    case "read":
    case "no-op":
      return key;
    case "delete,create":
    case "create,delete":
      return "replace";
    case "forget":
      return "delete";
    default:
      throw invalid(`unknown resource action "${key}"`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural JSON equality; object key order does not matter. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]))
    );
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  );
}

/** Sorted top-level attribute names whose values differ. Only names are returned. */
function changedAttributes(before: unknown, after: unknown): string[] {
  const from = isRecord(before) ? before : {};
  const to = isRecord(after) ? after : {};
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...keys].filter((key) => !sameJson(from[key], to[key])).sort();
}

/**
 * Maps `resource_drift[]` to `ResourceDrift`. Only managed resources count; `no-op` entries are
 * skipped. A deleted resource lists no attributes (every attribute is gone).
 */
function parseDrift(raw: unknown): ResourceDrift[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw invalid("resource_drift is not a list");
  const drift: ResourceDrift[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) throw invalid("malformed resource drift");
    if (entry.mode !== undefined && entry.mode !== "managed") continue;
    const { address, type, name, provider_name: provider, change } = entry;
    const actions = isRecord(change) ? change.actions : undefined;
    if (
      !isRecord(change) ||
      typeof address !== "string" ||
      typeof type !== "string" ||
      typeof name !== "string" ||
      !Array.isArray(actions) ||
      !actions.every((a): a is string => typeof a === "string")
    ) {
      throw invalid("malformed resource drift");
    }
    const key = actions.join(",");
    if (key === "no-op" || key === "read" || key === "") continue;
    const action = key === "delete" ? "delete" : "update";
    drift.push({
      address,
      type,
      name,
      provider: typeof provider === "string" ? provider : "",
      action,
      attributes: action === "delete" ? [] : changedAttributes(change.before, change.after),
    });
  }
  return drift;
}

/**
 * Summarises a plan produced by `tofu show -json` / `terraform show -json`, including any drift
 * the engine found while refreshing (`resource_drift`) and resources it moves in the state
 * (`previous_address`). Accepts the parsed
 * object or the raw JSON text. Throws `OpsCrewError` (`ENGINE_FAILED`) when the input is not a
 * plan or contains an action it does not understand.
 */
export function parsePlanJson(json: unknown): ParsedPlan {
  let plan: unknown = json;
  if (typeof json === "string") {
    try {
      plan = JSON.parse(json);
    } catch {
      throw invalid("it is not valid JSON");
    }
  }
  if (!isRecord(plan)) throw invalid("expected a JSON object");
  const rawChanges = plan.resource_changes ?? [];
  if (!Array.isArray(rawChanges)) throw invalid("resource_changes is not a list");

  const changes: ResourceChange[] = [];
  const counts = { create: 0, update: 0, delete: 0, replace: 0 };
  const moves: ResourceMove[] = [];
  for (const entry of rawChanges) {
    if (!isRecord(entry) || !isRecord(entry.change)) throw invalid("malformed resource change");
    const { address, type, name, provider_name: provider, previous_address: previous } = entry;
    const actions = entry.change.actions;
    if (
      typeof address !== "string" ||
      typeof type !== "string" ||
      typeof name !== "string" ||
      !Array.isArray(actions) ||
      !actions.every((a): a is string => typeof a === "string") ||
      (previous !== undefined && previous !== null && typeof previous !== "string")
    ) {
      throw invalid("malformed resource change");
    }
    const action = toAction(actions);
    if (typeof previous === "string" && previous !== address) {
      moves.push({ from: previous, to: address, type });
    }
    if (action === "no-op" || action === "read") continue;
    counts[action]++;
    changes.push({
      address,
      type,
      name,
      provider: typeof provider === "string" ? provider : "",
      action,
    });
  }
  const drift = parseDrift(plan.resource_drift);
  return {
    changes,
    counts,
    hasDestroy: counts.delete + counts.replace > 0,
    ...(drift.length > 0 ? { drift } : {}),
    ...(moves.length > 0 ? { moves } : {}),
  };
}
