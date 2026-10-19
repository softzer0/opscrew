import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderEdgeCompose } from "../edge";
import { IMAGES } from "../pins";
import { renderCaddyfile, renderCompose, renderTunnelConnectorCompose } from "../runtime";
import {
  CONNECTOR_METRICS,
  sshHostname,
  TUNNEL_ORIGIN_PORT,
  usesTunnel,
  webFilterMode,
} from "./index";

const PORTAINER = {
  access: "subdomain",
  hostname: "portainer.example.com",
  allowedEmails: ["ops@example.com"],
} as const;
const tunnelPlan = (o: Parameters<typeof testPlan>[0] = {}) =>
  testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com", ...o });

describe("tunnel hostnames", () => {
  it("puts the SSH hostname directly under the zone, also for a subdomain app", () => {
    expect(sshHostname(tunnelPlan())).toBe("ssh-shop.example.com");
    expect(sshHostname(tunnelPlan({ domain: "app.example.com" }))).toBe("ssh-shop.example.com");
    expect(sshHostname(testPlan({ provider: "own", domain: "shop.example.com" }))).toBeUndefined();
    expect(sshHostname(testPlan({ domain: "shop.example.com" }))).toBeUndefined();
  });

  it("uses a tunnel only in tunnel mode or for a Portainer subdomain", () => {
    expect(usesTunnel(tunnelPlan())).toBe(true);
    expect(usesTunnel(testPlan({ domain: "shop.example.com", portainer: PORTAINER }))).toBe(true);
    expect(usesTunnel(testPlan({ provider: "own", domain: "shop.example.com" }))).toBe(false);
    expect(
      usesTunnel(testPlan({ domain: "shop.example.com", portainer: { access: "local" } })),
    ).toBe(false);
  });
});

describe("runtime files in tunnel mode", () => {
  it("publishes the edge's Caddy only on the loopback port the connector reaches", () => {
    const edge = parse(renderEdgeCompose(tunnelPlan()).content);
    expect(edge.services.caddy.ports).toEqual([`127.0.0.1:${TUNNEL_ORIGIN_PORT}:80`]);
    const compose = parse(renderCompose(tunnelPlan()).content);
    for (const service of [edge.services["kamal-proxy"], ...Object.values(compose.services)]) {
      expect((service as { ports?: unknown }).ports).toBeUndefined();
    }
  });

  it("serves plain HTTP for the domain (Cloudflare terminates TLS) and keeps HSTS", () => {
    const caddyfile = renderCaddyfile(
      tunnelPlan({ domain: "example.com", www: true }),
      testContext({ acmeEmail: "ops@example.com" }),
    ).content;
    expect(caddyfile).toContain("http://example.com, http://www.example.com {");
    expect(caddyfile).not.toContain("email ops@example.com");
    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).toMatchSnapshot();
  });

  it("redirects visitors who used plain HTTP (Cf-Visitor) to HTTPS before proxying", () => {
    const lines = renderCaddyfile(
      tunnelPlan({ domain: "example.com", www: true }),
      testContext(),
    ).content.split("\n");
    const matcher = lines.indexOf('\t@http_visitor header Cf-Visitor `*"http"*`');
    const redirect = lines.indexOf("\tredir @http_visitor https://{host}{uri} 308");
    expect(matcher).toBeGreaterThan(0);
    expect(redirect).toBeGreaterThan(matcher);
    expect(redirect).toBeLessThan(lines.findIndex((line) => line.includes("reverse_proxy")));
  });

  it("keeps DNS-only runtime files identical to OpsCrew-created servers", () => {
    const filtered = testPlan({ provider: "own", domain: "shop.example.com" });
    const own = DeployPlanSchema.parse({
      ...filtered,
      dns: { ...filtered.dns, proxied: false },
      security: { ...filtered.security, httpAllowedFrom: "any" },
    });
    const hetzner = testPlan({ domain: "shop.example.com" });
    const context = testContext({ acmeEmail: "ops@example.com" });
    expect(renderCompose(own)).toEqual(renderCompose(hetzner));
    expect(renderCaddyfile(own, context)).toEqual(renderCaddyfile(hetzner, context));
  });

  it("publishes the edge's Caddy on IPv4 only behind OpsCrew's web filter; the site is unchanged", () => {
    const filtered = testPlan({ provider: "own", domain: "shop.example.com" });
    const hetzner = testPlan({ domain: "shop.example.com" });
    const context = testContext({ acmeEmail: "ops@example.com" });
    expect(webFilterMode(filtered)).toBe(true);
    expect(webFilterMode(hetzner)).toBe(false);
    expect(webFilterMode(tunnelPlan())).toBe(false);
    const edge = parse(renderEdgeCompose(filtered).content);
    expect(edge.services.caddy.ports).toEqual([
      "0.0.0.0:80:80",
      "0.0.0.0:443:443",
      "0.0.0.0:443:443/udp",
    ]);
    // Hetzner and DigitalOcean (their cloud firewall filters both families) are unchanged.
    expect(parse(renderEdgeCompose(hetzner).content).services.caddy.ports).toEqual([
      "80:80",
      "443:443",
      "443:443/udp",
    ]);
    expect(renderCaddyfile(filtered, context)).toEqual(renderCaddyfile(hetzner, context));
  });
});

describe("renderTunnelConnectorCompose", () => {
  const file = renderTunnelConnectorCompose(tunnelPlan());
  const compose = parse(file.content);

  it("runs the app's own pinned connector on the host network with the token from a file", () => {
    expect(file.path).toBe("opscrew/runtime/cloudflared/compose.yaml");
    // Each app's connector is a Compose project of its own, next to other apps' on the server.
    expect(compose.name).toBe("shop-tunnel");
    const blog = { ...tunnelPlan(), app: { ...tunnelPlan().app, name: "blog" } };
    expect(parse(renderTunnelConnectorCompose(blog).content).name).toBe("blog-tunnel");
    const service = compose.services.cloudflared;
    expect(service.image).toBe(IMAGES.cloudflared.ref);
    expect(service.image).toMatch(/^cloudflare\/cloudflared:2026\.5\.1@sha256:[0-9a-f]{64}$/);
    expect(service.command).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:0",
      "run",
    ]);
    expect(service.env_file).toEqual(["tunnel.env"]);
    expect(service.network_mode).toBe("host");
    expect(service.ports).toBeUndefined();
    expect(service.restart).toBe("unless-stopped");
    // A memory limit like every container OpsCrew runs (FR-1325), without swap.
    expect(service).toMatchObject({ mem_limit: "32m", memswap_limit: "32m" });
  });

  it("serves metrics, diagnostics and pprof on loopback only, on a free port of its own", () => {
    const command: string[] = compose.services.cloudflared.command;
    const flag = command.indexOf("--metrics");
    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(command.indexOf("run"));
    expect(command[flag + 1]).toBe(CONNECTOR_METRICS);
    // Port 0: the system picks a free one, so two apps' connectors on one host never collide.
    expect(CONNECTOR_METRICS).toBe("127.0.0.1:0");
    expect(file.content).not.toMatch(/0\.0\.0\.0|\[::\]/);
  });

  it("is hardened and never contains the token", () => {
    const service = compose.services.cloudflared;
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    expect(file.content).not.toMatch(/TUNNEL_TOKEN=|--token/);
  });

  it("rotates its own logs, so Docker's daemon settings on the server can stay as they are", () => {
    expect(compose.services.cloudflared.logging).toEqual({
      driver: "json-file",
      options: { "max-size": "10m", "max-file": "3" },
    });
  });
});
