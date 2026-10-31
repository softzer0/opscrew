import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { splitPlan } from "../infra/__fixtures__/servers";
import { renderRunbook } from "./index";
import { networkSection } from "./network";

const ctx = testContext({ projectId: "shop-0123456789ab" });
const HEADING = "## Servers and the private network";

/** The runbook's "Servers and the private network" section, up to the next `## ` heading. */
function section(plan: DeployPlan): string {
  const content = renderRunbook(plan, ctx).content;
  const start = content.indexOf(HEADING);
  if (start < 0) throw new Error("no network section");
  const end = content.indexOf("\n## ", start + HEADING.length);
  return content.slice(start, end < 0 ? undefined : end);
}

describe("the runbook's servers and private network", () => {
  it("has no such section without a network", () => {
    expect(renderRunbook(testPlan(), ctx).content).not.toContain(HEADING);
    expect(renderRunbook(testPlan({ provider: "own" }), ctx).content).not.toContain(HEADING);
  });

  it("describes each server, the network, and the commands that cover every server", () => {
    const text = section(
      splitPlan({
        servers: [
          { name: "db", provider: "hetzner" },
          { name: "cache", provider: "digitalocean" },
        ],
      }),
    );
    expect(text).toContain(
      "| `app` | Hetzner Cloud cx23 in nbg1 | the app, its workers and cron jobs, the edge | 10.200.4.1, UDP 51820 (`wg-opscrew0`) |",
    );
    expect(text).toContain(
      "| `db` | Hetzner Cloud cx33 in hel1 | PostgreSQL (`db`) | 10.200.4.2, UDP 51820 (`wg-opscrew0`) |",
    );
    expect(text).toContain("| `cache` | DigitalOcean Droplet s-2vcpu-4gb in ams3 |");
    expect(text).toContain("(`10.200.4.0/24`)");
    expect(text).toMatch(/listens only on that server's private address/);
    expect(text).toContain("`opscrew logs --service <name>`");
    expect(text).toMatch(/`opscrew destroy` lists every server/);
    expect(text).toContain("`opscrew vpn add <name> --this-computer`");
    expect(text).toContain("`opscrew secure --close-public-ssh`");
    expect(text).toMatchSnapshot();
  });

  it("says which services have no login", () => {
    const plan = splitPlan({ servers: [{ name: "db", provider: "hetzner" }] });
    const [db] = plan.services;
    const kafka = { ...db, name: "events", kind: "kafka" } as DeployPlan["services"][number];
    const text = section({ ...plan, services: [...plan.services, kafka] });
    expect(text).toMatch(/Kafka \(`events`\) has no login: only the app's servers reach it/);
  });

  it("lists devices and grants, a closed public SSH and a finished move", () => {
    const base = splitPlan({ servers: [{ name: "db", provider: "hetzner" }], device: true });
    const network = base.network as NonNullable<DeployPlan["network"]>;
    const plan: DeployPlan = {
      ...base,
      network: {
        ...network,
        grants: [{ device: "laptop", service: "db", access: "read-only" }],
        publicSsh: false,
      },
      move: { service: "db", from: "app", to: "db", step: "switched", copy: "dump" },
    };
    const text = section(plan);
    expect(text).toContain("- `laptop`: 10.200.4.100");
    expect(text).toContain("- `laptop` to `db`, read-only");
    expect(text).toContain("`opscrew vpn revoke <device> <service>`");
    expect(text).toContain("**Public SSH is closed:**");
    expect(text).toContain("`opscrew secure --open-public-ssh`");
    expect(text).toContain(
      "Its old copy stays, stopped, on `app` until `opscrew provision --finish-move` removes it",
    );
    expect(text).toMatchSnapshot();
  });

  it("names the environment on every command, and covers a network on the user's own server", () => {
    const text = networkSection(splitPlan({ device: true }), ["prod", "staging"]).join("\n");
    expect(text).toContain("`opscrew vpn list --env prod`");
    expect(text).not.toMatch(/opscrew destroy/);

    const own = section(splitPlan({ app: { provider: "own" }, device: true }));
    expect(own).toContain("| `app` | your own server |");
  });
});
