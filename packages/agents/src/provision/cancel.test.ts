// 026 US4 and plan 4.1: provision removes a server at a provider that cancels it at the end of its
// term instead of deleting it. No registered provider cancels yet (Contabo joins the registry
// later), so DigitalOcean's definition stands in for one that does: its servers are cancelled at
// the end of a one-month term, and its snapshots go with them.
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type {
  ApprovalRequest,
  AppServer,
  CloudProviderDefinition,
  IacApproval,
  ResourceChange,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it, vi } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  DIGITALOCEAN_CREATE,
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { cancelledByPlan } from "./cancel";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

vi.mock("@opscrew/providers", async (importActual) => {
  const actual = await importActual<typeof import("@opscrew/providers")>();
  const digitalocean = actual.cloudProvider("digitalocean");
  const cancelling: CloudProviderDefinition = {
    ...digitalocean,
    offering: {
      ...digitalocean.offering,
      removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 },
      serverSnapshotsOutliveServer: false,
    },
  };
  return {
    ...actual,
    CLOUD_PROVIDERS: actual.CLOUD_PROVIDERS.map((p) => (p.id === "digitalocean" ? cancelling : p)),
    cloudProvider: (id: string) => (id === "digitalocean" ? cancelling : actual.cloudProvider(id)),
  };
});

const CONSOLE = "the DigitalOcean control panel";
const ENDS = "2026-12-11T00:00:00.000Z";
const DROPLET = "module.server_data.digitalocean_droplet.this";
const DATA_ID = "3164444";
const APP_DROPLET = "module.server.digitalocean_droplet.this";
/** What a failed apply that cancels the Droplet shop-data adds to provision's own hint. */
const CANCEL_NOTE = `If DigitalOcean refused to cancel the Droplet shop-data (its reason is in the log above; it refuses one not created through its API, for example), cancel it by hand in ${CONSOLE}. The Droplet shop-data is shut down; you can start it again in ${CONSOLE}.`;

/** The plan's deletion of the extra Droplet `data`, which design dropped from `servers`. */
const REMOVAL: ResourceChange[] = [
  ["digitalocean_droplet", "this"],
  ["digitalocean_firewall", "this"],
].map(([type, name]) => ({
  address: `module.server_data.${type}.${name}`,
  type: type as string,
  name: name as string,
  provider: "registry.opentofu.org/digitalocean/digitalocean",
  action: "delete" as const,
}));

/** The DigitalOcean plan JSON with the extra Droplet's deletion added, its id in the prior state. */
function removalPlanJson() {
  const json = planJsonFor({ provider: "digitalocean" });
  return {
    ...json,
    resource_changes: [
      ...json.resource_changes,
      {
        address: DROPLET,
        type: "digitalocean_droplet",
        change: { actions: ["delete"], before: { id: DATA_ID, name: "shop-data" }, after: null },
      },
    ],
  };
}

/** The provider's servers: each shutdown is recorded in `events`, the read-back answers `ENDS`. */
function cancellingServers(events: string[]) {
  const unexpected = async (): Promise<never> => {
    throw new Error("not used by provision");
  };
  const state = { powerOffError: undefined as Error | undefined, lookups: [] as string[] };
  const api: ServerSnapshotApi = {
    findAppServers: async (app): Promise<AppServer[]> => {
      state.lookups.push(app);
      return [
        { id: "4711", name: "shop", status: "running" },
        { id: DATA_ID, name: "shop-data", status: "off", cancelledUntil: ENDS },
      ];
    },
    powerOff: async (id) => {
      events.push(`power-off:${id}`);
      if (state.powerOffError) throw state.powerOffError;
    },
    snapshotServer: unexpected,
    listSnapshots: unexpected,
    deleteSnapshot: unexpected,
    rebuild: unexpected,
    powerOn: unexpected,
  };
  return { api, state };
}

/** A fake engine that records its apply in `events`, after any shutdown. */
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
}

async function setup(
  o: {
    changes?: ResourceChange[];
    planJson?: unknown;
    applyLog?: string;
    approve?: (request: ApprovalRequest) => boolean;
  } = {},
) {
  const project = await createProject(testPlan({ provider: "digitalocean", userSecret: false }));
  const events: string[] = [];
  const removing = o.changes === undefined;
  const engine = new EventEngine(events, {
    changes: o.changes ?? REMOVAL,
    planJson:
      o.planJson ?? (removing ? removalPlanJson() : planJsonFor({ provider: "digitalocean" })),
    ...(o.applyLog !== undefined ? { applyOk: false, applyLog: o.applyLog } : {}),
  });
  const servers = cancellingServers(events);
  const handler = new ScriptedApprovalHandler(o.approve ?? (() => true));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: {
      configured: true,
      verify: async () => ({ ok: true, message: "ok" }),
      servers: servers.api,
    },
    github: new FakeGitHub(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
  };
  const providerCalls = () =>
    deps.audit.entries
      .filter((e) => e.kind === "provider-call")
      .map((e) => [e.action, e.target, e.detail]);
  const apply = () => handler.requests.filter((r) => r.kind === "iac-apply").at(-1);
  return { ...project, deps, engine, events, servers, handler, services, providerCalls, apply };
}

describe("cancelledByPlan", () => {
  it("finds the servers a plan deletes or replaces at a provider that cancels, by module", () => {
    const plan = testPlan({ provider: "digitalocean" });
    const replaced: ResourceChange = {
      address: "module.server.digitalocean_droplet.this",
      type: "digitalocean_droplet",
      name: "this",
      provider: "digitalocean",
      action: "replace",
    };
    expect(
      cancelledByPlan(plan, { changes: [...REMOVAL, replaced], planJson: removalPlanJson() }),
    ).toEqual([
      {
        server: "data",
        provider: "digitalocean",
        module: "module.server_data.",
        ids: [DATA_ID],
        replacedAlone: false,
        name: "shop-data",
      },
      {
        server: "app",
        provider: "digitalocean",
        module: "module.server.",
        ids: [],
        replacedAlone: true,
      },
    ]);
    // Hetzner deletes its servers at once.
    const hetzner = {
      ...replaced,
      address: "module.server.hcloud_server.this",
      type: "hcloud_server",
    };
    expect(cancelledByPlan(plan, { changes: [hetzner], planJson: {} })).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))(
  "runProvision removing a server at a provider that cancels",
  () => {
    it("cancels an extra server design dropped: said in the approval, shut down first, its end date read back", async () => {
      const s = await setup();
      await runProvision(s.deps, { services: s.services });

      const apply = s.apply();
      expect(apply).toMatchObject({ allowDestroy: true, confirmPhrase: "shop-data" });
      // It stays billed until its term ends: no cost change is claimed, the cost is still quoted.
      expect(apply?.costDelta).toBeUndefined();
      const details = apply?.details ?? "";
      expect(details).toContain("Estimated cost:");
      expect(details).toContain(
        "Server data is no longer in servers in opscrew/plan.yaml, so this plan cancels it (shop-data).",
      );
      expect(details).not.toContain("so this plan deletes it");
      expect(details).toContain(
        `First OpsCrew shuts the Droplet shop-data (id ${DATA_ID}) down through DigitalOcean's API; this plan's deletion of it is DigitalOcean's cancel.`,
      );
      expect(details).toContain(
        "DigitalOcean does not delete the Droplet shop-data at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.",
      );
      expect(details).toContain(
        "OpsCrew shuts it down now and deletes its other resources (such as its firewall) at once.",
      );
      expect(details).toContain(
        `Its disk and its DigitalOcean snapshots go when the term ends; until then you can start it again in ${CONSOLE}.`,
      );
      expect(details).toContain("Nothing is saved on the Droplet shop-data until its term ends.");

      // Shut down after the approval and before the apply, then read back once.
      expect(s.events).toEqual([`power-off:${DATA_ID}`, "apply"]);
      expect(s.servers.state.lookups).toEqual(["shop"]);
      const ended = `The DigitalOcean Droplet shop-data is cancelled: its contract ends on 11 December 2026, and DigitalOcean bills it until then. Its disk goes then; until then you can start it again in ${CONSOLE}.`;
      expect(s.deps.reporter.text()).toContain(ended);
      expect(s.providerCalls()).toEqual([
        [
          "power off",
          `digitalocean server ${DATA_ID}`,
          "shut shop-data down before its cancellation",
        ],
        ["powered off", `digitalocean server ${DATA_ID}`, "shop-data is off"],
        ["cancel date", `digitalocean server ${DATA_ID}`, `contract ends ${ENDS}`],
      ]);
    });

    it("shuts nothing down when the plan is not approved", async () => {
      const s = await setup({ approve: (r) => r.kind !== "iac-apply" });
      await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
      });
      expect(s.events).toEqual([]);
      expect(s.providerCalls()).toEqual([]);
    });

    it("shuts down only when the saved plan is approved by its hash", async () => {
      const s = await setup();
      const saved = await runProvision(s.deps, { services: s.services, planOnly: true });
      expect(s.events).toEqual([]);
      expect(s.providerCalls()).toEqual([]);
      await runProvision(s.deps, {
        services: s.services,
        approveHashes: [saved.planHash as string],
      });
      expect(s.events).toEqual([`power-off:${DATA_ID}`, "apply"]);
      expect(s.apply()?.details).toContain(
        "Nothing is saved on the Droplet shop-data until its term ends.",
      );
    });

    it("says a replaced app server's other resources stay and its replacement is created", async () => {
      const json = planJsonFor({ provider: "digitalocean" });
      const planJson = {
        ...json,
        resource_changes: json.resource_changes.map((rc) =>
          rc.address === APP_DROPLET
            ? {
                ...rc,
                type: "digitalocean_droplet",
                change: {
                  ...rc.change,
                  actions: ["delete", "create"],
                  before: { id: "4711", name: "shop" },
                },
              }
            : rc,
        ),
      };
      const s = await setup({
        changes: [
          {
            address: APP_DROPLET,
            type: "digitalocean_droplet",
            name: "this",
            provider: "registry.opentofu.org/digitalocean/digitalocean",
            action: "replace",
          },
        ],
        planJson,
      });
      await runProvision(s.deps, { services: s.services });
      const details = s.apply()?.details ?? "";
      expect(details).toContain(
        "First OpsCrew shuts the Droplet shop (id 4711) down through DigitalOcean's API; this plan's deletion of it is DigitalOcean's cancel.",
      );
      expect(details).toContain(
        "DigitalOcean does not delete the Droplet shop at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.",
      );
      expect(details).toContain(
        "OpsCrew shuts it down now; nothing else of it is deleted, and this plan creates its replacement.",
      );
      expect(details).not.toContain("deletes its other resources");
      expect(details).toContain(
        `Its disk and its DigitalOcean snapshots go when the term ends; until then you can start it again in ${CONSOLE}.`,
      );
      expect(s.apply()?.costDelta).toBeUndefined();
      expect(s.events).toEqual(["power-off:4711", "apply"]);
    });

    it("applies nothing when the shutdown fails, and says so", async () => {
      const s = await setup();
      s.servers.state.powerOffError = new OpsCrewError(
        "PROVIDER_ERROR",
        "DigitalOcean did not answer (503).",
      );
      await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
        code: "PROVIDER_ERROR",
        message:
          "OpsCrew could not shut the Droplet shop-data down: DigitalOcean did not answer (503). Nothing was cancelled or deleted.",
        hint: `Check the Droplet in ${CONSOLE}, then run \`opscrew provision\` again.`,
      });
      expect(s.events).toEqual([`power-off:${DATA_ID}`]);
      expect(s.engine.calls).not.toContain("apply");
      expect(s.providerCalls().map(([action]) => action)).toEqual([
        "power off",
        "power off failed",
      ]);
    });

    it("shows the provider's reason for a refused cancel and names its console", async () => {
      const reason =
        "Error: cancelling instance 3164444: 409 the instance was not created through the API";
      const s = await setup({
        applyLog: `${reason}\n\n  with ${DROPLET},\n  on main.tf line 40`,
      });
      const error = await runProvision(s.deps, { services: s.services }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "ENGINE_FAILED" });
      expect((error as OpsCrewError).message).toContain(reason);
      // Provision's own hint, then the cancel's.
      expect((error as OpsCrewError).hint).toBe(
        `Fix the cause shown above, then run \`opscrew provision\` again; it plans the remaining changes. ${CANCEL_NOTE}`,
      );
      // It was shut down before the apply; no end date is read for a cancel that failed.
      expect(s.events).toEqual([`power-off:${DATA_ID}`, "apply"]);
      expect(s.servers.state.lookups).toEqual([]);
    });

    it("keeps the blame of a refused token when a cancelling plan fails on a 403, and adds the cancel's", async () => {
      const s = await setup({
        applyLog:
          'Error: Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 403 (request "r3") You are not authorized to perform this operation',
      });
      const error = await runProvision(s.deps, { services: s.services }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "ENGINE_FAILED" });
      const hint = (error as OpsCrewError).hint ?? "";
      expect(hint).toMatch(
        /^DigitalOcean refused the request, so the API token is probably missing a permission OpsCrew needs\..* Nothing that was already created is removed\. /,
      );
      expect(hint.endsWith(` ${CANCEL_NOTE}`)).toBe(true);
    });

    it("leaves a provision that removes nothing as it was", async () => {
      const s = await setup({ changes: DIGITALOCEAN_CREATE });
      await runProvision(s.deps, { services: s.services });
      expect(s.events).toEqual(["apply"]);
      expect(s.servers.state.lookups).toEqual([]);
      expect(s.providerCalls()).toEqual([]);
      const details = s.apply()?.details ?? "";
      expect(details).not.toContain("cancel");
      expect(details).not.toContain("Nothing is saved");
      expect(s.apply()?.costDelta).toBeDefined();
    });
  },
);
