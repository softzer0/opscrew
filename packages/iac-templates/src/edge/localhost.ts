/**
 * The edge on the user's own computer (the localhost target, contracts/localhost.md "Localhost
 * Compose and edge"): the app's hostname there, and the leaf certificate from OpsCrew's local CA
 * that both proxies serve it with.
 */
import type { DeployPlan } from "@opscrew/plan-schema";

/** What the localhost edge's site and scripts need besides the plan. */
export interface LocalhostSite {
  /** The app's hostname on this computer ({@link localhostHostname}). */
  hostname: string;
}

/** The app's leaf certificate and key in its TLS folder on the edge (`tls/<app>/`). */
export const LOCALHOST_TLS = { certificate: "local.pem", key: "local.key" } as const;

/**
 * The app's hostname on this computer (FR-1505): `<app>.localhost` for the app's only localhost
 * environment, `<env>.<app>.localhost` (`prod` for prod) `beside` another of its localhost
 * environments. `<app>` is the app's name without the environment's (`<app>-<env>`).
 */
export function localhostHostname(plan: DeployPlan, beside: boolean): string {
  const env = plan.environment?.name;
  const app = env === undefined ? plan.app.name : plan.app.name.slice(0, -`-${env}`.length);
  return beside ? `${env ?? "prod"}.${app}.localhost` : `${app}.localhost`;
}

/**
 * Where the localhost deploy leaves the app's leaf certificate and key, relative to the edge's
 * folder: `tls/<app>/local.pem.new` and `local.key.new` (a 0700 folder, files 0600), as a server's
 * deploy leaves the origin files. The start script puts them in place under the edge's lock.
 */
export function localhostTlsUpload(app: string): { certificate: string; key: string } {
  return {
    certificate: `tls/${app}/${LOCALHOST_TLS.certificate}.new`,
    key: `tls/${app}/${LOCALHOST_TLS.key}.new`,
  };
}

/** The localhost site `given` for a localhost plan; without it the caller has a bug. */
export function localhostSite(given: LocalhostSite | undefined): LocalhostSite {
  if (given === undefined) {
    throw new Error(
      "The localhost target's edge needs the app's hostname on this computer (localhostHostname).",
    );
  }
  return given;
}

/** `:<port>` in an `https://` address for a port other than 443. */
export function httpsPortSuffix(port: number): string {
  return port === 443 ? "" : `:${port}`;
}
