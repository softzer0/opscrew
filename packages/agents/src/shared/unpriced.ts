import type { DesignOption } from "@opscrew/plan-schema";

/**
 * True for a design option without a server price (FR-913, FR-1015): the user's own server, which
 * they already pay for, or their Portainer, which they already run.
 */
export function isUnpriced(option: Pick<DesignOption, "target">): boolean {
  return option.target.provider === "own" || option.target.provider === "portainer";
}
