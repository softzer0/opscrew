import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { webOnlyFromCloudflare } from "../predicates";

/**
 * Loopback port the shared edge's Caddy publishes on in tunnel mode (`127.0.0.1:18080` → Caddy's
 * port 80). The connector runs on the host network and reaches the apps there; ports 80 and 443
 * stay free (another web server may use them) and nothing listens on a public interface.
 */
export const TUNNEL_ORIGIN_PORT = 18080;

/**
 * Where cloudflared serves its metrics, diagnostics and pprof endpoints: loopback only. The
 * official image listens on 0.0.0.0:20241 by default, which on the host network is every interface.
 */
export const CLOUDFLARED_METRICS = "127.0.0.1:20241";

/**
 * Where an app's tunnel connector on a server's host network serves its metrics: loopback only,
 * on a free port of its own (port 0), so the connectors of several apps on one server never take
 * the same port. The port is in the connector's log (`Starting metrics server on 127.0.0.1:…`).
 */
export const CONNECTOR_METRICS = "127.0.0.1:0";

/**
 * The memory limit of an app's tunnel connector on a server, in MB. The shared edge's 128 MB that
 * design counts on every server includes one; each further tunnelled app adds its own.
 */
export const CONNECTOR_MEMORY_MB = 32;

/** Port Portainer listens on, bound to the server's loopback interface only. */
export const PORTAINER_PORT = 9443;

/** Port Beszel's hub (its dashboard) listens on, bound to the server's loopback interface only. */
export const BESZEL_PORT = 8090;

/** True when an own-server plan serves the app through a Cloudflare Tunnel. */
export function tunnelMode(plan: DeployPlan): boolean {
  return plan.target.provider === "own" && plan.target.access === "tunnel";
}

/**
 * True when a server the user owns serves the site directly behind Cloudflare's proxy with
 * OpsCrew's web filter (public mode, a proxied Cloudflare domain, `security.httpAllowedFrom:
 * cloudflare`). The site is then published on IPv4 only: Docker serves an IPv6 host port of a
 * container without IPv6 through docker-proxy, around the filter in `DOCKER-USER`.
 */
export function webFilterMode(plan: DeployPlan): boolean {
  return (
    plan.target.provider === "own" && plan.target.access === "public" && webOnlyFromCloudflare(plan)
  );
}

/** Portainer's hostname when the plan serves Portainer on a subdomain (behind Access). */
export function portainerHostname(plan: DeployPlan): string | undefined {
  const portainer = plan.portainer;
  return portainer?.enabled && portainer.access === "subdomain" ? portainer.hostname : undefined;
}

/** Beszel's hostname when the plan serves Beszel's hub on a subdomain (behind Access). */
export function beszelHostname(plan: DeployPlan): string | undefined {
  const beszel = plan.observability?.beszel;
  return beszel?.enabled && beszel.access === "subdomain" ? beszel.hostname : undefined;
}

/**
 * True when the plan needs a Cloudflare Tunnel and Access: an own server in tunnel mode, or
 * Portainer or Beszel's hub on a subdomain.
 */
export function usesTunnel(plan: DeployPlan): boolean {
  return (
    tunnelMode(plan) || portainerHostname(plan) !== undefined || beszelHostname(plan) !== undefined
  );
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
