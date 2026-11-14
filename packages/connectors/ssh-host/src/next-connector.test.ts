import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  provision,
  TUNNEL_COMPOSE,
  TUNNEL_ID,
  tunnelDesired,
  tunnelToken,
} from "./__fixtures__/helpers";
import { hostPlanHash } from "./hash";
import { planNextTunnelConnector, planNextTunnelConnectorRemoval } from "./plan";
import { stepScripts } from "./steps";
import type { HostPlan } from "./types";

const NEXT_ID = "7a2e1d3f-2222-4b6c-8d4e-123456789abc";
const MAIN_DIR = "/srv/opscrew/cloudflared/shop";
const NEXT_DIR = "/srv/opscrew/cloudflared-next/shop";

function scriptsOf(plan: HostPlan) {
  return plan.steps.map((step) => stepScripts(plan, step));
}

describe("planNextTunnelConnector", () => {
  it("runs the new account's connector beside the current one, its token never in the plan", async () => {
    const fake = new FakeHost();
    await provision(fake, tunnelDesired(fake), { secrets: { tunnelToken: tunnelToken() } });
    const mainEnv = fake.files.get(`${MAIN_DIR}/tunnel.env`);

    const plan = planNextTunnelConnector({
      app: "shop",
      runAs: "root",
      connector: { compose: TUNNEL_COMPOSE, tunnelId: NEXT_ID },
    });
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["tunnel-connector", "change"],
    ]);
    const [step] = plan.steps;
    expect(step?.title).toContain("new Cloudflare account");
    expect(step?.title).toContain("beside");
    expect(step?.reason).toContain("beside the current one");
    expect(step?.params).toMatchObject({ dir: NEXT_DIR, next: true, needsToken: true });

    // Refused without the token, before anything changes.
    fake.calls.length = 0;
    await expect(applyApproved(fake, plan)).rejects.toThrow(/needs the tunnel token/);
    expect(fake.calls).toEqual([]);

    const token = `${tunnelToken()}NEXT`;
    const result = await applyApproved(fake, plan, { secrets: { tunnelToken: token } });
    expect(result.applied).toEqual(["tunnel-connector"]);
    expect(fake.files.get(`${NEXT_DIR}/tunnel.env`)).toBe(`TUNNEL_TOKEN=${token}\n`);
    expect(fake.files.get(`${NEXT_DIR}/tunnel.id`)).toBe(`${NEXT_ID}\n`);
    expect(fake.containers.map((container) => container.project)).toEqual(
      expect.arrayContaining(["shop-tunnel", "shop-tunnel-next"]),
    );
    // The current connector is untouched.
    expect(fake.files.get(`${MAIN_DIR}/tunnel.env`)).toBe(mainEnv);
    expect(fake.files.get(`${MAIN_DIR}/tunnel.id`)).toBe(`${TUNNEL_ID}\n`);

    // The token is in no command line, the plan or its hash.
    for (const call of fake.calls) expect(call.command).not.toContain(token);
    expect(JSON.stringify(plan)).not.toContain(token);
    expect(hostPlanHash(plan)).toBe(
      hostPlanHash(
        planNextTunnelConnector({
          app: "shop",
          runAs: "root",
          connector: { compose: TUNNEL_COMPOSE, tunnelId: NEXT_ID },
        }),
      ),
    );

    // Up to date: a second run skips it.
    const again = await applyApproved(fake, plan, { secrets: { tunnelToken: token } });
    expect(again.skipped).toEqual(["tunnel-connector"]);
  });

  it("runs as the login in the given folder on a server OpsCrew created", async () => {
    const fake = new FakeHost({ login: "deploy", sudo: "none" });
    const plan = planNextTunnelConnector({
      app: "shop",
      runAs: "login",
      connector: {
        dir: "/home/deploy/opscrew/cloudflared-next",
        compose: TUNNEL_COMPOSE,
        tunnelId: NEXT_ID,
      },
    });
    const token = tunnelToken();
    await applyApproved(fake, plan, { secrets: { tunnelToken: token } });
    expect(fake.calls.every((call) => !call.sudo)).toBe(true);
    expect(fake.files.get("/home/deploy/opscrew/cloudflared-next/tunnel.env")).toBe(
      `TUNNEL_TOKEN=${token}\n`,
    );
  });

  it("is refused before any approval in the main connector's folder", () => {
    expect(() =>
      planNextTunnelConnector({
        app: "shop",
        runAs: "root",
        connector: { dir: MAIN_DIR, compose: TUNNEL_COMPOSE, tunnelId: NEXT_ID },
      }),
    ).toThrow(/dir/);
    expect(() =>
      planNextTunnelConnector({
        app: "shop",
        runAs: "login",
        connector: {
          dir: "/home/deploy/opscrew/cloudflared",
          compose: TUNNEL_COMPOSE,
          tunnelId: NEXT_ID,
        },
      }),
    ).toThrow(/dir/);
  });

  it("has scripts that match their snapshot", () => {
    const root = planNextTunnelConnector({
      app: "shop",
      runAs: "root",
      connector: { compose: TUNNEL_COMPOSE, tunnelId: NEXT_ID },
    });
    const login = planNextTunnelConnector({
      app: "shop",
      runAs: "login",
      connector: {
        dir: "/home/deploy/opscrew/cloudflared-next",
        compose: TUNNEL_COMPOSE,
        tunnelId: NEXT_ID,
      },
    });
    expect({ root: scriptsOf(root), login: scriptsOf(login) }).toMatchSnapshot();
  });
});

describe("planNextTunnelConnectorRemoval", () => {
  it("stops and removes the beside connector and its folder, never the main one's", async () => {
    const fake = new FakeHost();
    await provision(fake, tunnelDesired(fake), { secrets: { tunnelToken: tunnelToken() } });
    await applyApproved(
      fake,
      planNextTunnelConnector({
        app: "shop",
        runAs: "root",
        connector: { compose: TUNNEL_COMPOSE, tunnelId: NEXT_ID },
      }),
      { secrets: { tunnelToken: `${tunnelToken()}NEXT` } },
    );

    const plan = planNextTunnelConnectorRemoval({ app: "shop", runAs: "root" });
    expect(plan.steps.map((step) => [step.id, step.state])).toEqual([
      ["tunnel-connector", "change"],
    ]);
    expect(plan.steps[0]?.params).toMatchObject({ remove: true, dir: NEXT_DIR, next: true });
    const result = await applyApproved(fake, plan);
    expect(result.applied).toEqual(["tunnel-connector"]);
    expect([...fake.files.keys()].some((path) => path.startsWith(`${NEXT_DIR}/`))).toBe(false);
    expect(fake.containers.map((container) => container.project)).not.toContain("shop-tunnel-next");
    // The main connector stays.
    expect(fake.files.get(`${MAIN_DIR}/tunnel.id`)).toBe(`${TUNNEL_ID}\n`);
    expect(fake.containers.map((container) => container.project)).toContain("shop-tunnel");
  });

  it("is refused before any approval in the main connector's folder", () => {
    expect(() =>
      planNextTunnelConnectorRemoval({ app: "shop", runAs: "root", dir: MAIN_DIR }),
    ).toThrow(/dir/);
    // Nor the main folder of another app named "shop-next".
    expect(() =>
      planNextTunnelConnectorRemoval({
        app: "shop",
        runAs: "root",
        dir: "/srv/opscrew/cloudflared/shop-next",
      }),
    ).toThrow(/dir/);
    expect(() =>
      planNextTunnelConnectorRemoval({
        app: "shop",
        runAs: "login",
        dir: "/home/deploy/opscrew/cloudflared",
      }),
    ).toThrow(/dir/);
  });

  it("has scripts that match their snapshot", () => {
    const root = planNextTunnelConnectorRemoval({ app: "shop", runAs: "root" });
    const login = planNextTunnelConnectorRemoval({
      app: "shop",
      runAs: "login",
      dir: "/home/deploy/opscrew/cloudflared-next",
    });
    expect({ root: scriptsOf(root), login: scriptsOf(login) }).toMatchSnapshot();
  });
});
