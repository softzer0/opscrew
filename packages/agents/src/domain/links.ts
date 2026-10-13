import type { RegistrarId } from "@opscrew/contracts";
import { DASHBOARD } from "./common";
import { REGISTRAR_NAMES, registrarLinks } from "./registrars";

/**
 * Where the user checks registrations and billing by hand, as a phrase: `the Cloudflare dashboard
 * (https://dash.cloudflare.com, Domain Registration)`, `the Porkbun dashboard (https://…)`.
 */
export function registrarDashboard(
  id: RegistrarId,
  env: Record<string, string | undefined> = {},
): string {
  if (id === "cloudflare") return DASHBOARD;
  return `the ${REGISTRAR_NAMES[id]} dashboard (${registrarLinks(id, env).domains})`;
}

/** `opscrew domain buy <domain>`, with `--registrar <id>` for registrars other than Cloudflare. */
export function buyCommandOf(domain: string, id: RegistrarId): string {
  return `opscrew domain buy ${domain}${id === "cloudflare" ? "" : ` --registrar ${id}`}`;
}
