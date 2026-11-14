// A provision on Contabo with its Auto Backup (027 R15): turned on through Contabo's API right after
// the apply of the plan that names it, beside the firewall, once (recorded); a plan that turns it
// off says how to turn it off in the Customer Control Panel and changes nothing.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { IacApproval, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { providerBackupsFile, readProviderBackups } from "../shared/provider-backups";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeFirewalls,
  FakeGitHub,
  FakeProviderBackups,
  fakeSharedCloudflare,
  fakeWantedFirewall,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { cancelledBackupsLines } from "./cancel";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const APP_ID = "202611001";

const change = (address: string, action: ResourceChange["action"]): ResourceChange => {
  const [, module = "", type = "", name = ""] = address.split(".");
  return {
    address: `module.${module}.${type}.${name}`,
    type,
    name,
    provider:
      type === "terraform_data"
        ? "terraform.io/builtin/terraform"
        : "registry.opentofu.org/contabo/contabo",
    action,
  };
};

/** The app's server and its Auto Backup line, created. */
const CREATE = [
  change("module.server.contabo_instance.this", "create"),
  change("module.server.terraform_data.backup", "create"),
];

/** The plan JSON of {@link CREATE}: its Auto Backup line created with `on`. */
const PLAN_JSON = (on: boolean) => ({
  format_version: "1.2",
  resource_changes: [
    {
      address: "module.server.terraform_data.backup",
      type: "terraform_data",
      name: "backup",
      change: { actions: ["create"], before: null, after: { input: { server_id: null, on } } },
    },
  ],
});

/** The state's outputs, with Auto Backup `on`. */
const outputs = (on: boolean) => ({
  server_ipv4: "198.51.100.40",
  server_ipv6: "2001:db8:40::1",
  server_id: APP_ID,
  server_name: "shop",
  url: "http://198.51.100.40",
  wanted_firewalls: { server: fakeWantedFirewall("contabo", APP_ID) },
  wanted_backups: { server: { provider: "contabo", backup: { server_id: APP_ID, on } } },
});

/** A fake engine whose applies are recorded in `events`, before the connector's calls. */
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

async function setup(backups: boolean, scenario: ConstructorParameters<typeof FakeEngine>[0]) {
  const project = await createProject(
    testPlan({ provider: "contabo", userSecret: false, backups }),
  );
  const events: string[] = [];
  const engine = new EventEngine(events, scenario);
  const firewalls = new FakeFirewalls((call) => events.push(call));
  const contabo = new FakeProviderBackups((call) => events.push(call));
  const approvals: string[] = [];
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    runner: projectRunner(),
    approvalHandler: new ScriptedApprovalHandler((request) => {
      if (request.kind === "iac-apply") approvals.push(request.details);
      return true;
    }),
  });
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github: new FakeGitHub(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    firewalls: { contabo: firewalls },
    providerBackups: { contabo },
  };
  return { ...project, deps, engine, events, contabo, approvals, services };
}

describe.skipIf(!findExecutable("git"))("runProvision on Contabo with its Auto Backup", () => {
  it("turns it on after the apply of the approved plan that names it, once, and says the estimate leaves it out", async () => {
    const s = await setup(true, {
      changes: CREATE,
      planJson: PLAN_JSON(true),
      outputs: outputs(true),
    });
    await runProvision(s.deps, { services: s.services });
    expect(s.events).toEqual(["apply", "sync shop-firewall", `turnOn ${APP_ID}`]);
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.approvals[0]).toContain("+ create  module.server.terraform_data.backup");
    expect(s.approvals[0]).toContain(
      "Contabo's automated backups are not in this estimate: they are priced on Contabo's order page.",
    );
    expect(s.deps.reporter.text()).toContain(
      `success: Turned on Contabo's automated backups of server ${APP_ID}: they cost extra, priced on Contabo's order page.`,
    );
    expect(
      await readProviderBackups(s.deps, { provider: "contabo", serverId: APP_ID }),
    ).toMatchObject({ state: "on" });

    // A run that plans nothing new never orders it again.
    s.engine.scenario.changes = [];
    await s.git(s.root, "checkout", "-q", "main");
    await s.git(s.root, "merge", "-q", "opscrew/deploy-setup");
    await runProvision(s.deps, { services: s.services });
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
  });

  it("never orders it in a run that plans nothing new, without this computer's record, and says so", async () => {
    const s = await setup(true, {
      changes: CREATE,
      planJson: PLAN_JSON(true),
      outputs: outputs(true),
    });
    await runProvision(s.deps, { services: s.services });
    // As on another computer: `on` in the state, and no record here.
    await rm(providerBackupsFile(s.deps.paths, "contabo", APP_ID));
    s.engine.scenario.changes = [];
    s.engine.scenario.planJson = {};
    await s.git(s.root, "checkout", "-q", "main");
    await s.git(s.root, "merge", "-q", "opscrew/deploy-setup");
    await runProvision(s.deps, { services: s.services });
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.deps.reporter.text()).toContain(
      `warn: OpsCrew has no record of turning on Contabo's automated backups of server ${APP_ID} on this computer, so it doesn't order them: check the server in the Contabo Customer Control Panel.`,
    );
  });

  it("orders it in a later run when the firewall stopped the run that applied it", async () => {
    const s = await setup(true, {
      changes: CREATE,
      planJson: PLAN_JSON(true),
      outputs: outputs(true),
    });
    const firewalls = s.services.firewalls?.contabo as FakeFirewalls;
    firewalls.syncError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered 503.");
    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
    expect(s.contabo.calls).toEqual([]);
    firewalls.syncError = undefined;
    s.engine.scenario.changes = [];
    s.engine.scenario.planJson = {};
    await runProvision(s.deps, { services: s.services });
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.deps.reporter.text()).toContain(
      `step: Turning on Contabo's automated backups of server ${APP_ID}: an earlier run's order didn't go through, so OpsCrew sends it again`,
    );
  });

  it("says how to turn it off in the Customer Control Panel when the plan turns it off, and calls nothing", async () => {
    const s = await setup(true, {
      changes: CREATE,
      planJson: PLAN_JSON(true),
      outputs: outputs(true),
    });
    await runProvision(s.deps, { services: s.services });
    s.engine.scenario.changes = [change("module.server.terraform_data.backup", "update")];
    s.engine.scenario.planJson = {};
    s.engine.scenario.outputs = outputs(false);
    await s.git(s.root, "checkout", "-q", "main");
    await s.git(s.root, "merge", "-q", "opscrew/deploy-setup");
    await runProvision(s.deps, { services: s.services });
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.deps.reporter.text()).toContain(
      `warn: The plan turns Contabo's automated backups of server ${APP_ID} off, but Contabo's API can't turn them off, so OpsCrew changed nothing. Cancel them in the Contabo Customer Control Panel: they stay on, and billed, until you do.`,
    );
  });

  it("orders nothing when the plan has it off", async () => {
    const s = await setup(false, {
      changes: CREATE,
      planJson: PLAN_JSON(false),
      outputs: outputs(false),
    });
    await runProvision(s.deps, { services: s.services });
    expect(s.contabo.calls).toEqual([]);
    expect(s.approvals[0]).not.toContain("not in this estimate");
  });
});

describe("cancelledBackupsLines", () => {
  /** A plan that cancels the extra Contabo server data, whose Auto Backup was `on`. */
  const removal = (on: boolean) => ({
    changes: [change("module.server_data.contabo_instance.this", "delete")],
    planJson: {
      format_version: "1.2",
      resource_changes: [
        {
          address: "module.server_data.contabo_instance.this",
          type: "contabo_instance",
          change: { actions: ["delete"], before: { id: "202611002" }, after: null },
        },
        {
          address: "module.server_data.terraform_data.backup",
          type: "terraform_data",
          change: {
            actions: ["delete"],
            before: { input: { server_id: "202611002", on } },
            after: null,
          },
        },
      ],
    },
  });
  const plan = testPlan({ provider: "contabo", backups: false });

  it("says to check the Auto Backup add-on of a cancelled server whose backups were on", () => {
    expect(cancelledBackupsLines(plan, removal(true))).toEqual([
      "Contabo cancels the server's Auto Backup add-on apart from the server: check in the Contabo Customer Control Panel that it is cancelled too (server shop-data).",
    ]);
    expect(cancelledBackupsLines(plan, removal(false))).toEqual([]);
  });
});
