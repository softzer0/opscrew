import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { IMAGES, TOOLS, toolDownloadUrl } from "../pins";

/** cloudflared release the deploy workflow installs in tunnel mode: `TOOLS.cloudflared` in pins.ts. */
export const CLOUDFLARED_VERSION = TOOLS.cloudflared.version;

/** SHA-256 of the cloudflared Linux binaries per architecture, from pins.ts. */
export const CLOUDFLARED_SHA256 = TOOLS.cloudflared.sha256;

/** Download URL of a cloudflared Linux binary of {@link CLOUDFLARED_VERSION}. */
export function cloudflaredUrl(arch: keyof typeof CLOUDFLARED_SHA256): string {
  return toolDownloadUrl("cloudflared", arch);
}

/** Image of the tunnel connector on the server, from `pins.ts`. */
export const CLOUDFLARED_IMAGE = IMAGES.cloudflared.ref;

/**
 * Loopback port Caddy publishes on in tunnel mode (`127.0.0.1:18080` → Caddy's port 80). The
 * connector runs on the host network and reaches the app there; ports 80 and 443 stay free (another
 * web server may use them) and nothing listens on a public interface.
 */
export const TUNNEL_ORIGIN_PORT = 18080;

/**
 * Where the connector serves its metrics, diagnostics and pprof endpoints: loopback only. The
 * official image listens on 0.0.0.0:20241 by default, which on the host network is every interface.
 */
export const CLOUDFLARED_METRICS = "127.0.0.1:20241";

/** Port Portainer listens on, bound to the server's loopback interface only. */
export const PORTAINER_PORT = 9443;

/** True when an own-server plan serves the app through a Cloudflare Tunnel. */
export function tunnelMode(plan: DeployPlan): boolean {
  return plan.target.provider === "own" && plan.target.access === "tunnel";
}

/** Portainer's hostname when the plan serves Portainer on a subdomain (behind Access). */
export function portainerHostname(plan: DeployPlan): string | undefined {
  const portainer = plan.portainer;
  return portainer?.enabled && portainer.access === "subdomain" ? portainer.hostname : undefined;
}

/**
 * True when the plan needs a Cloudflare Tunnel and Access: an own server in tunnel mode, or
 * Portainer on a subdomain (on any target).
 */
export function usesTunnel(plan: DeployPlan): boolean {
  return tunnelMode(plan) || portainerHostname(plan) !== undefined;
}

/**
 * Hostname the deploy workflow reaches SSH on in tunnel mode: `ssh-<app>.<zone>`. It sits directly
 * under the zone so Cloudflare's Universal SSL certificate covers it. `undefined` outside tunnel
 * mode. Throws when the plan has no Cloudflare domain and zone.
 */
export function sshHostname(plan: DeployPlan): string | undefined {
  if (!tunnelMode(plan)) return undefined;
  return `ssh-${plan.app.name}.${tunnelZone(plan)}`;
}

/** The plan's Cloudflare zone, required for a tunnel. */
function tunnelZone(plan: DeployPlan): string {
  const { dns } = plan;
  if (dns.provider !== "cloudflare" || dns.domain === undefined || dns.zone === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "A server without a public address is served through a Cloudflare Tunnel, which needs a domain on your Cloudflare account, and this plan has none.",
      {
        hint: "Add a domain whose DNS is on Cloudflare with `opscrew design` (or `opscrew domain`), then run `opscrew provision` again.",
      },
    );
  }
  return dns.zone;
}
