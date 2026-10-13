import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderRunbook } from "./index";

const ctx = testContext({ projectId: "shop-0123456789ab" });
const doPlan = (o: Parameters<typeof testPlan>[0] = {}) =>
  testPlan({ provider: "digitalocean", ...o });

describe("renderRunbook for DigitalOcean", () => {
  it("names the Droplet, the control panel and USD prices, never Hetzner", () => {
    const content = renderRunbook(doPlan({ domain: "shop.example.com" }), ctx).content;
    expect(content).not.toMatch(/hetzner/i);
    expect(content).toContain("shop — DigitalOcean Droplet s-1vcpu-2gb in fra1");
    expect(content).toContain(
      "$15.60 per month (excl. tax, estimate from DigitalOcean's price list of 2026-10-12)",
    );
    expect(content).toContain("https://cloud.digitalocean.com/");
    expect(content).toContain("DigitalOcean daily backups are on");
    expect(content).toContain("in addition to the DigitalOcean cloud firewall");
    const connect = content.slice(content.indexOf("## Connect"), content.indexOf("## Database"));
    expect(connect).toMatch(/Droplet Console[\s\S]*cannot log in as root/);
    expect(connect).toContain("Recovery Console still works");
    expect(content).toMatchSnapshot();
  });

  it("explains daily backups, their price and that they outlive the Droplet", () => {
    const on = renderRunbook(doPlan(), ctx).content;
    const backups = on.slice(on.indexOf("## Database backups"), on.indexOf("## Change settings"));
    expect(backups).toMatch(/every day/);
    expect(backups).toMatch(/four weeks/);
    const off = renderRunbook(doPlan({ backups: false }), ctx).content;
    expect(off).toContain("Automated server backups are **off**");
    expect(off).toContain("(30% of the Droplet price)");
  });

  it("explains the teardown: no delete protection, snapshot billing and retained backups", () => {
    const content = renderRunbook(doPlan({ domain: "shop.example.com" }), ctx).content;
    const section = content.slice(content.indexOf("## Tear it down"));
    expect(section).toContain("--confirm shop");
    expect(section).toContain(
      "the Droplet, its firewall, SSH key and app tag (`opscrew-app:shop`)",
    );
    expect(section).toMatch(/`managed-by:opscrew` tag \(other OpsCrew apps/);
    expect(section).toContain("Cloudflare DNS records");
    expect(section).toMatch(/no delete protection/);
    expect(section).toMatch(/immediately/);
    expect(section).toMatch(/`opscrew destroy` is the safe/);
    expect(section).toMatch(/DigitalOcean snapshot of the Droplet/);
    expect(section).toContain("$0.06 per GB per month");
    expect(section).toMatch(/kept for up to four weeks/);
    expect(section).toMatchSnapshot();

    const stateless = renderRunbook(doPlan({ postgres: false, backups: false }), ctx).content;
    const plain = stateless.slice(stateless.indexOf("## Tear it down"));
    expect(plain).toMatch(/does not take a\s+snapshot/);
    expect(plain).not.toContain("Cloudflare DNS records");
    expect(plain).not.toContain("daily backups");
    expect(plain).toMatch(/no delete protection/);
    expect(plain).toMatchSnapshot();
  });

  it("explains how to move to another provider without naming one", () => {
    const content = renderRunbook(doPlan({ domain: "shop.example.com" }), ctx).content;
    const section = content
      .slice(
        content.indexOf("## Moving to another provider"),
        content.indexOf("## Check for drift"),
      )
      .replace(/\s+/g, " ");
    expect(section).toContain("`opscrew retarget --to <provider>`");
    expect(section).toContain("`opscrew retarget --finish`");
    expect(section).toContain("`opscrew retarget --abort`");
    expect(section).toContain("**Maintenance window:**");
    expect(section).toMatch(/both servers are billed until then/);
    expect(section).toMatch(/only\s+before the DNS switch/);
    expect(content).not.toMatch(/hetzner/i);
  });

  it("is deterministic and contains no absolute paths", () => {
    const a = renderRunbook(doPlan(), ctx).content;
    expect(renderRunbook(doPlan(), ctx).content).toBe(a);
    expect(a).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });
});
