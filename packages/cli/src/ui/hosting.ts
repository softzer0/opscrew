import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";

/**
 * What to use instead of each command that needs a server, on a hosting account (feature 027):
 * the refusal's hint.
 */
export const ON_HOSTING_INSTEAD = {
  logs: "Run `opscrew logs` without it: it shows the agent's last lines on the account (its deploys and their checks). The app's own errors are in your panel (cPanel's Errors, or the error_log file in the app's folder).",
  addons:
    "Your panel shows the account's traffic and errors (cPanel's Metrics), and `opscrew status` shows the release the account runs, the agent's last attempt and the certificate.",
  previews:
    "Previews need a server of their own: add an environment for them on a server with `opscrew env add preview --previews --target <provider>` (or `own`).",
  runners:
    "Nothing to set up: GitHub's own runners build each release, and the agent on the account deploys it.",
  vpn: "Use your panel's own access to the database instead (phpMyAdmin, or Remote MySQL with your address allowed).",
  portainer:
    "Your panel shows the account's files, databases and cron jobs, and `opscrew status` shows the release the account runs.",
  retarget:
    "Run `opscrew destroy`, then `opscrew interview`, `opscrew design` and `opscrew provision` for the new target.",
} as const;

/**
 * The plain refusal of a command that needs a server (`what`, such as "`opscrew vpn`") on a
 * hosting account, with what to use instead (`instead`).
 */
export function hostingRefusal(what: string, instead: string): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${what} doesn't apply to a hosting account: it needs a server, and the app runs on your hosting account, which has none. Nothing was changed.`,
    { hint: instead },
  );
}

/** Stops `what` when `plan` deploys to a hosting account (see {@link hostingRefusal}). */
export function requireServer(
  plan: Pick<DeployPlan, "target">,
  what: string,
  instead: string,
): void {
  if (plan.target.provider === "hosting") throw hostingRefusal(what, instead);
}

/**
 * The name a deletion on `plan`'s target is confirmed with: a hosting account's hostname (its
 * `dns.domain`), the app's name everywhere else.
 */
export function confirmNameOf(plan: Pick<DeployPlan, "app" | "dns" | "target">): string {
  return plan.target.provider === "hosting" ? (plan.dns.domain ?? plan.app.name) : plan.app.name;
}
