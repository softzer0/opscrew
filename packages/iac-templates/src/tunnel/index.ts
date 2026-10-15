import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { stringify } from "yaml";
import type { RenderContext, RenderedFile } from "../types";

/**
 * cloudflared release the deploy workflow and the server's connector use. 2026.6.0 ignores service
 * tokens for `access ssh` and falls back to a browser login (cloudflare/cloudflared#1673), so CI
 * would hang; replace the pin only after a smoke test proves service tokens work.
 */
export const CLOUDFLARED_VERSION = "2026.5.1";

/**
 * SHA-256 of the cloudflared 2026.5.1 Linux binaries, read on 2026-10-14 from the GitHub release
 * (`digest` of the assets `cloudflared-linux-amd64` and `cloudflared-linux-arm64`, identical to the
 * checksums listed in the release notes).
 */
export const CLOUDFLARED_SHA256 = {
  amd64: "3c6a5ba995a258dbe90f98e5fdb2c2620b7be72c3ca761614f6eb52aee252cea",
  arm64: "7b7a8b9a2764acab0fecda633cb54a6c0df42d7f8ca1ec45c78333c2227d8d91",
} as const;

/** Download URL of a cloudflared Linux binary of {@link CLOUDFLARED_VERSION}. */
export function cloudflaredUrl(arch: keyof typeof CLOUDFLARED_SHA256): string {
  return `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}`;
}

/**
 * Image of the tunnel connector on the server, pinned by the digest of the multi-arch index of tag
 * 2026.5.1 (read on 2026-10-14 from `registry-1.docker.io/v2/cloudflare/cloudflared/manifests/2026.5.1`).
 */
export const CLOUDFLARED_IMAGE =
  "cloudflare/cloudflared:2026.5.1@sha256:a5b5e6fd9a372f054b9a843c219bfbcdceb54691605312a8b1ee72978bdf1aa1";

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

/**
 * Every hostname the tunnel serves for the plan, in route order: the app's hostnames (tunnel
 * mode), the SSH hostname (tunnel mode) and Portainer's (subdomain opt-in). Empty without a tunnel.
 */
export function tunnelHostnames(plan: DeployPlan): {
  app: string[];
  ssh?: string;
  portainer?: string;
} {
  const ssh = sshHostname(plan);
  const portainer = portainerHostname(plan);
  const domain = plan.dns.domain;
  const app =
    tunnelMode(plan) && domain ? (plan.dns.www ? [domain, `www.${domain}`] : [domain]) : [];
  return {
    app,
    ...(ssh === undefined ? {} : { ssh }),
    ...(portainer === undefined ? {} : { portainer }),
  };
}

/**
 * Log rotation for one of OpsCrew's Compose services: the values of the Docker daemon settings on
 * servers OpsCrew creates (json-file, 10m, 3 files), set per service so that on a server the user
 * already runs containers on, Docker's daemon settings (and those containers) stay as they are.
 * A fresh object each time, so the YAML has no anchors.
 */
export function serviceLogging(): {
  driver: "json-file";
  options: { "max-size": string; "max-file": string };
} {
  return { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } };
}

const CONNECTOR_HEADER = [
  "# Generated by OpsCrew from opscrew/plan.yaml. The Cloudflare Tunnel connector: it runs on the host",
  "# network so it reaches the app (127.0.0.1:18080), SSH and Portainer on localhost, and it opens",
  "# no port. tunnel.env next to this file holds TUNNEL_TOKEN (root-only; never committed).",
].join("\n");

/**
 * `opscrew/runtime/cloudflared/compose.yaml`: the tunnel connector as its own Compose project
 * (`opscrew-tunnel`). The token comes from `tunnel.env` in the same directory on the server
 * (`TUNNEL_TOKEN=<terraform output tunnel_token>`, mode 0600), which this file never contains.
 */
export function renderTunnelConnectorCompose(
  _plan: DeployPlan,
  _ctx?: RenderContext,
): RenderedFile {
  const document = {
    name: "opscrew-tunnel",
    services: {
      cloudflared: {
        image: CLOUDFLARED_IMAGE,
        restart: "unless-stopped",
        // Metrics, diagnostics and pprof on loopback only: on the host network the image default
        // would listen on every interface.
        command: ["tunnel", "--no-autoupdate", "--metrics", CLOUDFLARED_METRICS, "run"],
        env_file: ["tunnel.env"],
        network_mode: "host",
        read_only: true,
        security_opt: ["no-new-privileges:true"],
        logging: serviceLogging(),
        cap_drop: ["ALL"],
      },
    },
  };
  return {
    path: "opscrew/runtime/cloudflared/compose.yaml",
    content: `${CONNECTOR_HEADER}\n${stringify(document, { lineWidth: 0 })}`,
    kind: "runtime",
  };
}
