import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderCaddyfile, renderCompose } from "../runtime";
import {
  CLOUDFLARED_IMAGE,
  CLOUDFLARED_METRICS,
  renderTunnelConnectorCompose,
  sshHostname,
  TUNNEL_ORIGIN_PORT,
  tunnelHostnames,
  usesTunnel,
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
    expect(sshHostname(tunnelPlan({ domain: "app.shop.example.com" }))).toBe(
      "ssh-shop.example.com",
    );
    expect(sshHostname(testPlan({ provider: "own", domain: "shop.example.com" }))).toBeUndefined();
    expect(sshHostname(testPlan({ domain: "shop.example.com" }))).toBeUndefined();
  });

  it("lists the app, SSH and Portainer hostnames the tunnel serves", () => {
    expect(tunnelHostnames(tunnelPlan({ www: true, portainer: PORTAINER }))).toEqual({
      app: ["shop.example.com", "www.shop.example.com"],
      ssh: "ssh-shop.example.com",
      portainer: "portainer.example.com",
    });
    expect(tunnelHostnames(testPlan({ domain: "shop.example.com", portainer: PORTAINER }))).toEqual(
      { app: [], portainer: "portainer.example.com" },
    );
    expect(tunnelHostnames(testPlan({ domain: "shop.example.com" }))).toEqual({ app: [] });
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
  it("publishes Caddy only on the loopback port the connector reaches", () => {
    const compose = parse(renderCompose(tunnelPlan(), testContext()).content);
    expect(compose.services.caddy.ports).toEqual([`127.0.0.1:${TUNNEL_ORIGIN_PORT}:80`]);
    for (const [name, service] of Object.entries(compose.services)) {
      if (name !== "caddy") expect((service as { ports?: unknown }).ports).toBeUndefined();
    }
  });

  it("serves plain HTTP for the domain (Cloudflare terminates TLS) and keeps HSTS", () => {
    const caddyfile = renderCaddyfile(
      tunnelPlan({ www: true }),
      testContext({ acmeEmail: "ops@example.com" }),
    ).content;
    expect(caddyfile).toContain("http://shop.example.com, http://www.shop.example.com {");
    expect(caddyfile).not.toContain("email ops@example.com");
    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).toMatchSnapshot();
  });

  it("keeps public-mode runtime files identical to OpsCrew-created servers", () => {
    const own = testPlan({ provider: "own", domain: "shop.example.com" });
    const hetzner = testPlan({ domain: "shop.example.com" });
    const context = testContext({ acmeEmail: "ops@example.com" });
    expect(renderCompose(own, context)).toEqual(renderCompose(hetzner, context));
    expect(renderCaddyfile(own, context)).toEqual(renderCaddyfile(hetzner, context));
  });
});

describe("renderTunnelConnectorCompose", () => {
  const file = renderTunnelConnectorCompose(tunnelPlan());
  const compose = parse(file.content);

  it("runs the pinned connector on the host network with the token from a file", () => {
    expect(file.path).toBe("opscrew/runtime/cloudflared/compose.yaml");
    expect(compose.name).toBe("opscrew-tunnel");
    const service = compose.services.cloudflared;
    expect(service.image).toBe(CLOUDFLARED_IMAGE);
    expect(service.image).toMatch(/^cloudflare\/cloudflared:2026\.5\.1@sha256:[0-9a-f]{64}$/);
    expect(service.command).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--metrics",
      "127.0.0.1:20241",
      "run",
    ]);
    expect(service.env_file).toEqual(["tunnel.env"]);
    expect(service.network_mode).toBe("host");
    expect(service.ports).toBeUndefined();
    expect(service.restart).toBe("unless-stopped");
  });

  it("serves metrics, diagnostics and pprof on loopback only (it shares the host's network)", () => {
    const command: string[] = compose.services.cloudflared.command;
    const flag = command.indexOf("--metrics");
    expect(flag).toBeGreaterThan(-1);
    expect(flag).toBeLessThan(command.indexOf("run"));
    expect(command[flag + 1]).toBe(CLOUDFLARED_METRICS);
    expect(CLOUDFLARED_METRICS).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(file.content).not.toMatch(/0\.0\.0\.0|\[::\]/);
  });

  it("is hardened and never contains the token", () => {
    const service = compose.services.cloudflared;
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    expect(file.content).not.toMatch(/TUNNEL_TOKEN=|--token/);
  });
});
