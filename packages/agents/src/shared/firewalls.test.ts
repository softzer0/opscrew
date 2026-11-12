import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeFirewalls } from "../testing";
import { removeFirewalls, syncFirewalls, wantedFirewalls } from "./firewalls";

/** A server module's wanted firewall as the root's `wanted_firewalls` output lists it. */
function wanted(name: string, serverId: string) {
  return {
    provider: "contabo",
    firewall: {
      name,
      description: `OpsCrew's firewall of ${name.replace(/-firewall$/, "")}.`,
      server_ids: [serverId],
      rules: [
        { protocol: "tcp", ports: ["22"], ipv4: ["203.0.113.0/24"], ipv6: ["::1/128"] },
        { protocol: "icmp", ports: [], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
      ],
    },
  };
}

const APP = wanted("shop-firewall", "202611001");
const DB = wanted("shop-db-firewall", "202611002");

/** The plan JSON's change of the `wanted_firewalls` output, from `before`. */
const planWith = (before: Record<string, unknown> | null) => ({
  format_version: "1.2",
  output_changes: { wanted_firewalls: { actions: ["update"], before, after: null } },
});

async function setup() {
  const deps = await createTestPhaseDeps();
  const contabo = new FakeFirewalls();
  const run = {
    deps,
    phase: "provision" as const,
    command: "opscrew provision",
    firewalls: { contabo },
  };
  const said = () => deps.reporter.lines.map((line) => `${line.level}: ${line.message}`);
  const audited = () =>
    deps.audit.entries
      .filter((entry) => entry.kind === "provider-call")
      .map((entry) => [entry.action, entry.target, entry.detail]);
  return { deps, contabo, run, said, audited };
}

describe("wantedFirewalls", () => {
  it("reads each server module's wanted firewall with its provider", () => {
    expect(wantedFirewalls({ wanted_firewalls: { server: APP, server_db: DB } })).toEqual([
      {
        module: "server",
        provider: "contabo",
        wanted: {
          name: "shop-firewall",
          description: "OpsCrew's firewall of shop.",
          serverIds: ["202611001"],
          rules: APP.firewall.rules,
        },
      },
      expect.objectContaining({
        module: "server_db",
        wanted: expect.objectContaining({ serverIds: ["202611002"] }),
      }),
    ]);
  });

  it("is empty for a root without the output", () => {
    expect(wantedFirewalls({ server_ipv4: "198.51.100.40" })).toEqual([]);
  });

  it("stops plainly on an output it cannot read, and on a provider whose Terraform manages its firewalls", () => {
    for (const value of [
      { server: { ...APP, firewall: { ...APP.firewall, server_ids: [null] } } },
      { server: { ...APP, provider: "hetzner" } },
    ]) {
      expect(() => wantedFirewalls({ wanted_firewalls: value })).toThrow(
        /could not read the firewalls the servers want from the infrastructure's outputs/,
      );
    }
  });
});

describe("syncFirewalls", () => {
  it("makes each wanted firewall, says and audits what changed", async () => {
    const s = await setup();
    await syncFirewalls(s.run, { wanted_firewalls: { server: APP, server_db: DB } });
    expect(s.contabo.calls).toEqual(["sync shop-firewall", "sync shop-db-firewall"]);
    expect(s.said()).toEqual([
      "step: Setting Contabo's firewall shop-firewall",
      "success: Created Contabo's firewall shop-firewall with 2 rules.",
      "step: Setting Contabo's firewall shop-db-firewall",
      "success: Created Contabo's firewall shop-db-firewall with 2 rules.",
    ]);
    expect(s.audited()).toEqual([
      [
        "sync firewall",
        "contabo firewall shop-firewall",
        "Created Contabo's firewall shop-firewall with 2 rules.",
      ],
      [
        "sync firewall",
        "contabo firewall shop-db-firewall",
        "Created Contabo's firewall shop-db-firewall with 2 rules.",
      ],
    ]);
  });

  it("says a firewall that needed nothing is as the plan wants it, and audits nothing", async () => {
    const s = await setup();
    await syncFirewalls(s.run, { wanted_firewalls: { server: APP } });
    s.deps.reporter.lines.length = 0;
    await syncFirewalls(s.run, { wanted_firewalls: { server: APP } });
    expect(s.said()).toEqual([
      "step: Setting Contabo's firewall shop-firewall",
      "info: Contabo's firewall shop-firewall is as the plan wants it.",
    ]);
    expect(s.audited()).toHaveLength(1);
  });

  it("does nothing for a root without wanted firewalls", async () => {
    const s = await setup();
    await syncFirewalls(s.run, { server_ipv4: "198.51.100.20" });
    expect(s.contabo.calls).toEqual([]);
    expect(s.said()).toEqual([]);
  });

  it("stops on a failure: the server may not be protected, and running the command again sets it", async () => {
    const s = await setup();
    s.contabo.syncError = new OpsCrewError(
      "PROVIDER_ERROR",
      "Contabo has 2 firewalls named shop-firewall.",
      {
        hint: "Delete or rename the ones OpsCrew did not create in Contabo's Customer Control Panel, then try again.",
      },
    );
    const error = await syncFirewalls(s.run, {
      wanted_firewalls: { server: APP, server_db: DB },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "Setting Contabo's firewall shop-firewall failed: Contabo has 2 firewalls named shop-firewall. The server may not be protected yet.",
      hint: "Delete or rename the ones OpsCrew did not create in Contabo's Customer Control Panel, then try again. Then run `opscrew provision` again: it plans nothing new and sets the firewall again.",
    });
    expect(s.contabo.calls).toEqual(["sync shop-firewall"]);
    expect(s.audited()).toEqual([
      [
        "firewall sync failed",
        "contabo firewall shop-firewall",
        "Contabo has 2 firewalls named shop-firewall",
      ],
    ]);
  });

  it("stops the same way when the provider's credentials are not set", async () => {
    const s = await setup();
    const error = await syncFirewalls(
      { ...s.run, firewalls: undefined },
      { wanted_firewalls: { server: APP } },
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "Setting Contabo's firewall shop-firewall failed: OpsCrew cannot reach Contabo: its credentials (CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER and CNTB_OAUTH2_PASS) are not set. The server may not be protected yet.",
      hint: "Run `opscrew provision` again: it plans nothing new and sets the firewall again.",
    });
  });
});

describe("removeFirewalls", () => {
  it("deletes the firewalls the root wanted before the apply and wants no more, says and audits it", async () => {
    const s = await setup();
    await syncFirewalls(s.run, { wanted_firewalls: { server: APP, server_db: DB } });
    s.deps.reporter.lines.length = 0;
    await removeFirewalls(s.run, planWith({ server: APP, server_db: DB }), {
      wanted_firewalls: { server: APP },
    });
    expect(s.contabo.calls.slice(2)).toEqual(["remove shop-db-firewall"]);
    expect(s.said()).toEqual([
      "step: Deleting Contabo's firewall shop-db-firewall",
      "success: Deleted Contabo's firewall shop-db-firewall.",
    ]);
    expect(s.audited().at(-1)).toEqual([
      "delete firewall",
      "contabo firewall shop-db-firewall",
      "its servers were removed by the apply",
    ]);
  });

  it("deletes every firewall after the whole root is removed, and keeps those it still wants", async () => {
    const s = await setup();
    await removeFirewalls(s.run, planWith({ server: APP }), {});
    expect(s.contabo.calls).toEqual(["remove shop-firewall"]);
    expect(s.said()).toContain("info: Contabo's firewall shop-firewall was gone already.");

    const kept = await setup();
    // A server renamed in the state (module.server to module.server_previous) keeps its firewall.
    await removeFirewalls(kept.run, planWith({ server: APP }), {
      wanted_firewalls: { server_previous: APP },
    });
    await removeFirewalls(kept.run, planWith(null), { wanted_firewalls: { server: APP } });
    await removeFirewalls(kept.run, { format_version: "1.2" }, {});
    await removeFirewalls(kept.run, undefined, {});
    expect(kept.contabo.calls).toEqual([]);
  });

  it("warns with where to delete it by hand when a deletion fails, and goes on", async () => {
    const s = await setup();
    s.contabo.removeError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered 500.");
    await removeFirewalls(s.run, planWith({ server: APP, server_db: DB }), {});
    expect(s.contabo.calls).toEqual(["remove shop-firewall", "remove shop-db-firewall"]);
    expect(s.said()).toContain(
      "warn: OpsCrew could not delete Contabo's firewall shop-firewall: Contabo answered 500. No server of this app needs it any more; delete it in the Contabo Customer Control Panel.",
    );
    expect(s.audited()).toEqual([
      ["firewall deletion failed", "contabo firewall shop-firewall", "Contabo answered 500"],
      ["firewall deletion failed", "contabo firewall shop-db-firewall", "Contabo answered 500"],
    ]);
  });
});
