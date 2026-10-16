import { canonicalJson, sha256Hex } from "@opscrew/core";
import type { HostPlan } from "./types";

/** SHA-256 (lower-case hex) of the canonical JSON of the plan: the hash `host-apply` binds. */
export function hostPlanHash(plan: HostPlan): string {
  return sha256Hex(canonicalJson(plan));
}
