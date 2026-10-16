import { describe, expect, it } from "vitest";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { portainerPlan } from "../testing";
import { deploySetupPullRequestBody, portainerDnsRecordNote } from "./publish";

describe("the deploy pull request for the user's Portainer", () => {
  it("tunnel and updater: the Cloudflare root, the stack template, the deploy branch, the notes", () => {
    const body = deploySetupPullRequestBody(portainerPlan(), "1.2.3");
    expect(body).toContain("**shop**");
    expect(body).toContain(
      "`opscrew/infra/prod/` and `opscrew/infra/modules/`: the Cloudflare Tunnel that serves the app",
    );
    expect(body).toContain("`opscrew/runtime/compose.yaml`: the app's stack in your Portainer");
    expect(body).toContain("`opscrew-deploy` branch");
    expect(body).toContain("the updater stack in your Portainer");
    expect(body).toContain("**Merging this pull request deploys the app to shop.example.com.**");
    expect(body).toContain(PORTAINER_HOST_NOTE);
    expect(body).toContain(PORTAINER_BACKUPS_NOTE);
    expect(body).toContain("Portainer's address is not in the repository");
    // Nothing about servers OpsCrew creates.
    expect(body).not.toMatch(/firewall rules|server is already running|IP address/);
    expect(body).not.toContain("Point shop.example.com");
  });

  it("Cloudflare redeploys: names the tunnel and Access in front of Portainer's webhook", () => {
    const body = deploySetupPullRequestBody(
      portainerPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
      "1.2.3",
    );
    expect(body).toContain("Cloudflare Access");
    expect(body).toContain("Portainer's webhook");
    expect(body).not.toContain("the Cloudflare Tunnel that serves the app");
    expect(body).toContain(portainerDnsRecordNote(portainerPlan({ web: { mode: "caddy" } })));
  });

  it("proxy or Caddy with the updater: no infrastructure code, and the DNS record to create", () => {
    const proxy = portainerPlan({ web: { mode: "proxy", port: 8080 } });
    const body = deploySetupPullRequestBody(proxy, "1.2.3");
    expect(body).not.toContain("opscrew/infra/");
    expect(body).toContain(portainerDnsRecordNote(proxy));
    expect(portainerDnsRecordNote(proxy)).toBe(
      "OpsCrew creates no DNS record for shop.example.com: create one yourself that points it at your Portainer host (an A record, and AAAA for IPv6, to its public address, or a CNAME to its dynamic-DNS name), and let your reverse proxy forward shop.example.com to port 8080 of that host; your proxy manages the certificate.",
    );
    expect(portainerDnsRecordNote(portainerPlan({ web: { mode: "caddy" }, www: true }))).toBe(
      "OpsCrew creates no DNS record for shop.example.com and www.shop.example.com: create them yourself so they point at your Portainer host (an A record, and AAAA for IPv6, to its public address, or a CNAME to its dynamic-DNS name). Caddy gets their certificates once ports 80 and 443 of the host are reachable from the internet.",
    );
  });

  it("proxy without a domain: the port to route to, and nothing to merge-check", () => {
    const plan = portainerPlan({ web: { mode: "proxy", port: 8080 }, domain: null });
    const body = deploySetupPullRequestBody(plan, "1.2.3");
    expect(portainerDnsRecordNote(plan)).toBe(
      "Route your reverse proxy to port 8080 of your Portainer host; it manages the address and the certificate.",
    );
    expect(body).toContain(portainerDnsRecordNote(plan));
    expect(body).toContain("**Merging this pull request deploys the app to your Portainer.**");
  });

  it("no tunnel note in tunnel mode, and the terminal step when the deploy secrets are not stored", () => {
    expect(portainerDnsRecordNote(portainerPlan())).toBeUndefined();
    const body = deploySetupPullRequestBody(portainerPlan(), "1.2.3", { secretsStored: false });
    expect(body).toContain("**Before merging, run `opscrew provision` in a terminal");
  });
});
