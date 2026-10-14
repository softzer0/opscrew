import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import type { RenderContext } from "../types";
import { renderRunbook } from "./index";

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";
const PORTAINER = {
  access: "subdomain",
  hostname: "portainer.example.com",
  allowedEmails: ["ops@example.com"],
} as const;

const ctx: RenderContext = testContext({
  projectId: "shop-0123456789ab",
  serverIpv4: IPV4,
  serverIpv6: IPV6,
});

function runbook(o: Parameters<typeof testPlan>[0], context: RenderContext = ctx): string {
  return renderRunbook(testPlan({ provider: "own", ...o }), context).content;
}

describe("renderRunbook for a server the user owns", () => {
  it("shows no server price and says backups are the user's responsibility", () => {
    const text = runbook({ domain: "shop.example.com" });
    expect(text).toContain("no server price: you already pay for this server");
    expect(text).not.toMatch(/€|\$\d|per month/);
    expect(text).toContain("## Backups are your responsibility");
    expect(text).toContain("OpsCrew cannot turn on backups or snapshots on a server you own");
    expect(text).toContain("pg_dump");
    expect(text).not.toMatch(/Hetzner|DigitalOcean|Droplet/);
  });

  it("shows the address only in public mode without Cloudflare's proxy", () => {
    const direct = runbook({});
    expect(direct).toContain(`| IPv4 / IPv6 | ${IPV4} / ${IPV6} |`);
    expect(direct).toContain(
      `ssh -i ~/.opscrew/projects/shop-0123456789ab/deploy_key deploy@${IPV4}`,
    );
    expect(direct).toContain(`| App | http://${IPV4} |`);

    const proxied = runbook({ domain: "shop.example.com" });
    expect(proxied).not.toContain(IPV4);
    expect(proxied).not.toContain(IPV6);
    expect(proxied).toContain("kept private behind Cloudflare");
    expect(proxied).toContain("deploy@<server>");

    const tunnel = runbook({ access: "tunnel", domain: "shop.example.com" });
    expect(tunnel).not.toContain(IPV4);
    expect(tunnel).not.toContain(IPV6);
  });

  it("explains the tunnel and its SSH hostname in tunnel mode", () => {
    const text = runbook({ access: "tunnel", arch: "arm64", domain: "shop.example.com" });
    expect(text).toContain(
      "| SSH for deploys | `ssh-shop.example.com`, through the tunnel and Cloudflare Access",
    );
    expect(text).toContain("none needed: the server is reached through a Cloudflare Tunnel");
    expect(text).toContain("connects to `ssh-shop.example.com`");
    expect(text).toContain("built on GitHub's arm64 runner");
    expect(text).toContain("No inbound web port is open");
    expect(text).toContain("allows only SSH.");
    expect(text).toContain("tunnel, Access applications and DNS records");
  });

  it("explains how to undo OpsCrew's host changes and that the server is never deleted", () => {
    const text = runbook({ domain: "shop.example.com" });
    expect(text).toContain("`opscrew destroy --undo-host`");
    expect(text).toContain("It **never** deletes, rebuilds or reinstalls your server.");
    expect(text).toContain("`--confirm shop` in scripts");
    expect(text).toContain("/etc/opscrew/host.json");
  });

  it("says that switching between direct access and the tunnel runs in two steps", () => {
    for (const access of ["public", "tunnel"] as const) {
      const text = runbook({ access, domain: "shop.example.com" });
      expect(text).toContain(
        "**Switching between direct access and the tunnel** runs in two steps",
      );
      expect(text).toContain("first removes the current way in");
    }
  });

  it("tells how to reach Portainer without ever containing the password", () => {
    const local = runbook({ domain: "shop.example.com", portainer: { access: "local" } });
    expect(local).toContain("## Portainer");
    expect(local).toContain(
      "ssh -i ~/.opscrew/projects/shop-0123456789ab/deploy_key -N -L 9443:127.0.0.1:9443 deploy@<server>",
    );
    expect(local).toContain("`~/.opscrew/projects/shop-0123456789ab/portainer_password`");
    expect(local).toContain("| Portainer | through an SSH tunnel only |");
    expect(local).not.toContain("portainer.example.com");

    const subdomain = runbook({
      access: "tunnel",
      domain: "shop.example.com",
      portainer: PORTAINER,
    });
    expect(subdomain).toContain("https://portainer.example.com, behind Cloudflare Access");
    expect(subdomain).toContain("one-time PIN");

    expect(runbook({ domain: "shop.example.com" })).not.toContain("Portainer");
  });

  it("matches the snapshots", () => {
    expect(runbook({ domain: "shop.example.com", www: true })).toMatchSnapshot("public");
    expect(
      runbook({
        access: "tunnel",
        arch: "arm64",
        domain: "shop.example.com",
        portainer: PORTAINER,
      }),
    ).toMatchSnapshot("tunnel with Portainer");
  });
});
