import type { PlanSummary, ResourceAction, ResourceChange } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";

/** What `parsePlanJson` extracts from a machine-readable plan (`show -json`). */
export interface ParsedPlan {
  /** Every change except `no-op` and `read`, in the order the engine reported them. */
  changes: ResourceChange[];
  counts: PlanSummary["counts"];
  /** True when any change is a `delete` or `replace`. */
  hasDestroy: boolean;
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

/**
 * Summarises a plan produced by `tofu show -json` / `terraform show -json`. Accepts the parsed
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
  for (const entry of rawChanges) {
    if (!isRecord(entry) || !isRecord(entry.change)) throw invalid("malformed resource change");
    const { address, type, name, provider_name: provider } = entry;
    const actions = entry.change.actions;
    if (
      typeof address !== "string" ||
      typeof type !== "string" ||
      typeof name !== "string" ||
      !Array.isArray(actions) ||
      !actions.every((a): a is string => typeof a === "string")
    ) {
      throw invalid("malformed resource change");
    }
    const action = toAction(actions);
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
  return { changes, counts, hasDestroy: counts.delete + counts.replace > 0 };
}
