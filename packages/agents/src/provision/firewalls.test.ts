// A provision on Contabo, whose firewall its connector applies after the apply (ADR 0029, D8): the
// firewall is set once the apply is done and again by a run that plans nothing new, and the
// firewall of a server design dropped goes after the apply that removes it. Contabo's connector
// cancels that server (D10): after its shutdown, then it leaves the state and the rest is planned
// again and applied.
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { AppServer, IacApproval, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeFirewalls,
  FakeGitHub,
  fakeSharedCloudflare,
  fakeWantedFirewall,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const APP_ID = "202611001";
const DATA_ID = "202611002";
const contabo = (address: string, action: ResourceChange["action"]): ResourceChange => {
  const [, module = "", type = "", name = ""] = address.split(".");
  return {
    address: `module.${module}.${type}.${name}`,
    type,
    name,
    provider: "registry.opentofu.org/contabo/contabo",
    action,
  };
};
/** The app's server, created. */
const CREATE = [contabo("module.server.contabo_instance.this", "create")];
/** The extra server data, which design dropped from `servers`: Contabo cancels it. */
const REMOVAL = [contabo("module.server_data.contabo_instance.this", "delete")];

/** A fake engine whose applies are recorded in `events`, before the firewall calls. */
class EventEngine extends FakeEngine {
  constructor(
    readonly events: string[],
    scenario: ConstructorParameters<typeof FakeEngine>[0],
  ) {
    super(scenario);
  }

  override async apply(dir: string, planFile: string, approval: IacApproval) {
    this.events.push("apply");
    return super.apply(dir, planFile, approval);
  }

  override async stateRemove(dir: string, addresses: readonly string[]) {
    this.events.push(`state-rm:${addresses.join(",")}`);
    return super.stateRemove(dir, addresses);
  }
}

async function setup(scenario: ConstructorParameters<typeof FakeEngine>[0]) {
  const project = await createProject(testPlan({ provider: "contabo", userSecret: false }));
  const events: string[] = [];
  const engine = new EventEngine(events, scenario);
  const firewalls = new FakeFirewalls((call) => events.push(call));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    runner: projectRunner(),
    approvalHandler: new ScriptedApprovalHandler(() => true),
  });
  const servers = {
    findAppServers: async (): Promise<AppServer[]> => [
      { id: DATA_ID, name: "shop-data", status: "off", cancelledUntil: "2026-12-11T00:00:00.000Z" },
    ],
    powerOff: async (id: string) => {
      events.push(`power-off:${id}`);
    },
    // Contabo's Terraform cannot cancel a server: its connector does (ADR 0029, D10).
    cancelServer: async (id: string) => {
      events.push(`cancel:${id}`);
      return "2026-12-11";
    },
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("not used by provision");
  };
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: {
      configured: true,
      verify: async () => ({ ok: true, message: "ok" }),
      servers: {
        ...servers,
        snapshotServer: unexpected,
        listSnapshots: unexpected,
        deleteSnapshot: unexpected,
        rebuild: unexpected,
        powerOn: unexpected,
      },
    },
    github: new FakeGitHub(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    firewalls: { contabo: firewalls },
  };
  return { ...project, deps, engine, events, firewalls, services };
}

const OUTPUTS = {
  server_ipv4: "198.51.100.40",
  server_ipv6: "2001:db8:40::1",
  server_id: APP_ID,
  server_name: "shop",
  url: "http://198.51.100.40",
  wanted_firewalls: { server: fakeWantedFirewall("contabo", APP_ID) },
};

describe.skipIf(!findExecutable("git"))("runProvision on Contabo and its firewall", () => {
  it("sets the server's firewall once the apply is done, and again in a run that plans nothing new", async () => {
    const s = await setup({ changes: CREATE, planJson: {}, outputs: OUTPUTS });
    await runProvision(s.deps, { services: s.services });
    expect(s.events).toEqual(["apply", "sync shop-firewall"]);
    expect(s.firewalls.firewalls.get("shop-firewall")?.serverIds).toEqual([APP_ID]);
    expect(s.deps.reporter.text()).toContain(
      "success: Created Contabo's firewall shop-firewall with 1 rules.",
    );
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "sync firewall",
        phase: "provision",
        target: "contabo firewall shop-firewall",
      }),
    );

    s.engine.scenario.changes = [];
    await s.git(s.root, "checkout", "-q", "main");
    await s.git(s.root, "merge", "-q", "opscrew/deploy-setup");
    await runProvision(s.deps, { services: s.services });
    expect(s.events).toEqual(["apply", "sync shop-firewall", "sync shop-firewall"]);
  });

  it("stops with a plain error when the firewall cannot be set after the apply", async () => {
    const s = await setup({ changes: CREATE, planJson: {}, outputs: OUTPUTS });
    s.firewalls.syncError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered 503.");
    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "Setting Contabo's firewall shop-firewall failed: Contabo answered 503. The server may not be protected yet.",
      hint: "Run `opscrew provision` again: it plans nothing new and sets the firewall again.",
    });
    expect(s.events).toEqual(["apply", "sync shop-firewall"]);
  });

  /** The plan that cancels the extra server data, whose state wanted both firewalls. */
  const removal = () => ({
    changes: REMOVAL,
    planJson: {
      format_version: "1.2",
      resource_changes: [
        {
          address: REMOVAL[0]?.address,
          type: "contabo_instance",
          change: {
            actions: ["delete"],
            before: { id: DATA_ID, name: "shop-data" },
            after: null,
          },
        },
      ],
      output_changes: {
        wanted_firewalls: {
          actions: ["update"],
          before: {
            server: fakeWantedFirewall("contabo", APP_ID),
            server_data: fakeWantedFirewall("contabo", DATA_ID, "shop-data"),
          },
        },
      },
    },
    outputs: OUTPUTS,
  });

  it("deletes the firewall of a server design dropped after the apply that cancels it", async () => {
    const s = await setup(removal());
    s.firewalls.seed(fakeWantedFirewall("contabo", DATA_ID, "shop-data"));
    await runProvision(s.deps, { services: s.services });
    expect(s.events).toEqual([
      `power-off:${DATA_ID}`,
      `cancel:${DATA_ID}`,
      `state-rm:${REMOVAL[0]?.address}`,
      "apply",
      "remove shop-data-firewall",
      "sync shop-firewall",
    ]);
    expect(s.deps.reporter.text()).toContain(
      "success: Deleted Contabo's firewall shop-data-firewall.",
    );
    // The plan applied is the approved one made again without the server's deletion.
    expect(s.engine.applied.map((a) => a.planFile.endsWith("-rest.tfplan"))).toEqual([true]);
    expect(s.deps.reporter.text()).toContain(
      `success: Cancelled the Contabo server ${DATA_ID}: its contract ends on 2026-12-11.`,
    );
  });

  it("stops before the state is touched when Contabo refuses the cancel", async () => {
    const s = await setup(removal());
    const servers = s.services.provider?.servers;
    if (servers === undefined) throw new Error("no servers");
    servers.cancelServer = async (id: string) => {
      s.events.push(`cancel:${id}`);
      throw new OpsCrewError("PROVIDER_ERROR", "Contabo answered HTTP 400.");
    };
    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: `OpsCrew could not cancel the Contabo server ${DATA_ID}: Contabo answered HTTP 400. Nothing more was applied, and the infrastructure state is unchanged.`,
    });
    expect(s.events).toEqual([`power-off:${DATA_ID}`, `cancel:${DATA_ID}`]);
    expect(s.engine.stateRemoved).toEqual([]);
  });

  it("still shows and audits when a cancelled server's contract ends when the firewall cannot be set", async () => {
    const s = await setup(removal());
    s.firewalls.syncError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered 503.");
    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(s.events).toEqual([
      `power-off:${DATA_ID}`,
      `cancel:${DATA_ID}`,
      `state-rm:${REMOVAL[0]?.address}`,
      "apply",
      "remove shop-data-firewall",
      "sync shop-firewall",
    ]);
    expect(s.deps.reporter.text()).toContain(
      "The Contabo server shop-data is cancelled: its contract ends on 11 December 2026",
    );
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "provider-call",
        action: "cancel date",
        target: `contabo server ${DATA_ID}`,
        detail: "contract ends 2026-12-11T00:00:00.000Z",
      }),
    );
  });
});
