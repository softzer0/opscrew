import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  AppServer,
  CloudProviderDefinition,
  IacApproval,
  ResourceChange,
} from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { cloudTarget, DEPLOY_SECRETS } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { ownProject, provisionOwn } from "../drift/__fixtures__/own-project";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { ensureStatePassphrase } from "../shared";
import { updateServerAddresses } from "../shared/server-record";
import {
  createProject,
  createTestPhaseDeps,
  DROPLET_ADDRESS,
  deployedResources,
  FakeDestroyGitHub,
  FakeServers,
  fakeCloudflare,
  HOST_KEY,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  SERVER_IPV4,
  testKeyMaker,
  testPlan,
} from "../testing";
import { dataSnapshotOffer } from "./cancel";
import { runDestroy } from "./run";
import type { ServerSnapshot } from "./servers";
import { destroyConfirmPrompt } from "./texts";
import type { DestroyPreview, DestroyServices } from "./types";

/*
 * No registered provider cancels its servers yet (Contabo joins the registry later), so
 * DigitalOcean's definition stands in for one that does: its servers are cancelled at the end of
 * a one-month term, and its snapshots go with them. Everything else stays DigitalOcean's.
 */
vi.mock("@opscrew/providers", async (original) => {
  const actual = await original<typeof import("@opscrew/providers")>();
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

const DIGITALOCEAN = fakeSecret("digitalocean-token");
const SECRET_NAMES = Object.values(DEPLOY_SECRETS).sort();
const RESOURCES = deployedResources({ provider: "digitalocean" });
const CONSOLE = "the DigitalOcean control panel";
const ENDS = "2026-12-11T00:00:00.000Z";

/** The provider's servers: a shutdown is recorded, and the read-back answers `cancelledUntil`. */
class CancellingServers extends FakeServers {
  readonly poweredOff: string[] = [];
  powerOffError: Error | undefined;
  cancelledUntil: string | undefined = ENDS;

  // The base fake takes no id (it has no shutdown), so the id is optional here.
  override async powerOff(serverId?: string): Promise<void> {
    this.events.push(`power-off:${serverId}`);
    if (this.powerOffError) throw this.powerOffError;
    this.poweredOff.push(serverId ?? "");
  }

  override async findAppServers(app: string): Promise<AppServer[]> {
    const found = await super.findAppServers(app);
    this.events.push("lookup");
    return found.map((server) =>
      this.cancelledUntil === undefined
        ? server
        : { ...server, cancelledUntil: this.cancelledUntil },
    );
  }
}

/** A deployed app on the stand-in provider: Postgres on the server, no provider backups. */
function cancellingPlan(): DeployPlan {
  const plan = testPlan({ deployed: true, provider: "digitalocean" });
  return {
    ...plan,
    target: { ...cloudTarget(plan.target), backups: false },
    deployment: { ...plan.deployment, lastPlanHash: "a".repeat(64) },
  };
}

async function setup(
  options: { plan?: DeployPlan; resources?: ResourceChange[]; applyLog?: string } = {},
) {
  const plan = options.plan ?? cancellingPlan();
  const project = await createProject(plan);
  const events: string[] = [];
  const engine = new ScriptedDestroyEngine(
    {
      resources: options.resources ?? RESOURCES,
      ...(options.applyLog ? { applyOk: { destroy: false } } : {}),
    },
    events,
  );
  if (options.applyLog !== undefined) {
    const apply = engine.apply.bind(engine);
    const log = options.applyLog;
    engine.apply = async (dir: string, file: string, approval: IacApproval) => ({
      ...(await apply(dir, file, approval)),
      log,
    });
  }
  const servers = new CancellingServers(events, "digitalocean");
  const github = new FakeDestroyGitHub(events);
  for (const name of SECRET_NAMES) github.secrets.set(name, "stored");
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      DIGITALOCEAN_TOKEN: DIGITALOCEAN,
      DIGITALOCEAN_ACCESS_TOKEN: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  engine.beforeApply = (planHash) => {
    events.push("apply");
    const approved = deps.audit.entries.some(
      (e) => e.kind === "approval" && e.target === planHash && e.decision === "approved",
    );
    if (!approved) throw new Error(`apply of ${planHash} before its approval`);
  };
  await ensureStatePassphrase(deps.paths);
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(deps.paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
  const services: DestroyServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers,
    cloudflare: fakeCloudflare(),
    github,
    sleep: async () => undefined,
  };
  return { plan, deps, engine, servers, github, handler, services, events };
}

/** The provider calls in the audit log as `[action, target, detail]`. */
function providerCalls(deps: Awaited<ReturnType<typeof setup>>["deps"]): unknown[][] {
  return deps.audit.entries
    .filter((e) => e.kind === "provider-call")
    .map((e) => [e.action, e.target, e.detail]);
}

describe("cancellation wording", () => {
  it("the typed confirmation says the server stays billed to the end of its term", () => {
    expect(destroyConfirmPrompt("shop", "digitalocean")).toBe(
      "Type shop to cancel the DigitalOcean Droplet, billed until the end of its term, and delete the rest listed above; its disk and its DigitalOcean snapshots go when the term ends (anything else stops with nothing changed)",
    );
    // A provider that deletes at once keeps its question.
    expect(destroyConfirmPrompt("shop", "hetzner")).toBe(
      "Type shop to delete everything listed above (anything else cancels)",
    );
  });

  it("offers OpsCrew's own data snapshot, turning on the off-server copy when it is off", () => {
    const plan = cancellingPlan();
    const app: ServerSnapshot = {
      server: "app",
      provider: "digitalocean",
      module: "module.server.",
      inState: true,
      ids: ["3164444"],
      data: { serverData: true, backups: false },
      wanted: false,
    };
    expect(dataSnapshotOffer(plan, [app], "")).toBe(
      "To keep the PostgreSQL database, type anything else now, turn on the encrypted copy off the server (`opscrew snapshot offsite on --to r2`, or `opscrew snapshot offsite on --to hetzner --region <region>` (or `--to digitalocean`), then `opscrew provision`) and run `opscrew snapshot`, then run `opscrew destroy` again. That is OpsCrew's own snapshot of the data, and its copy off the server stays after the teardown; a DigitalOcean snapshot would go with the Droplet.",
    );
    const offsite = {
      ...plan,
      snapshots: { offsite: { provider: "r2" as const, bucket: "shop-snapshots" } },
    };
    expect(dataSnapshotOffer(offsite, [app], " --env staging")).toContain(
      "type anything else now, run `opscrew snapshot --env staging`, which also puts its encrypted copy in the bucket shop-snapshots for 90 days, then run `opscrew destroy --env staging` again.",
    );
  });
});

describe.skipIf(!findExecutable("git"))("runDestroy where the provider cancels the server", () => {
  it("says the server is billed to its term's end, shuts it down after the approval and shows the end date", async () => {
    const s = await setup();
    const previews: DestroyPreview[] = [];
    let shownBeforeName = "";
    const result = await runDestroy(s.deps, {
      services: s.services,
      confirm: async (preview) => {
        previews.push(preview);
        shownBeforeName = s.deps.reporter.text();
        s.events.push("confirm");
        return true;
      },
    });

    // Order: preview → typed name → destroy plan and its approval → shutdown → apply → end date.
    // No provider snapshot: it would go with the server.
    expect(s.events).toEqual([
      "plan:destroy",
      "confirm",
      "plan:destroy",
      "power-off:3164444",
      "apply",
      "apply:destroy",
      "lookup",
      ...SECRET_NAMES.map((name) => `secret:${name}`),
    ]);
    expect(s.servers.snapshots).toEqual([]);
    expect(s.servers.poweredOff).toEqual(["3164444"]);

    // Before the typed name: the billing, the shutdown, what goes when, and the data snapshot offer.
    for (const line of [
      "DigitalOcean does not delete the Droplet shop at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.",
      "OpsCrew shuts it down now and deletes the app's other resources (such as its DNS records, firewall and SSH key) at once.",
      `Its disk and its DigitalOcean snapshots go when the term ends; until then you can start it again in ${CONSOLE}.`,
      "Cancelling the Droplet loses the PostgreSQL database and any files the app stored on the Droplet when its term ends, and OpsCrew shuts it down now. Only OpsCrew's own data snapshot, with its encrypted copy off the server, keeps a copy.",
      "To keep the PostgreSQL database, type anything else now,",
    ]) {
      expect(shownBeforeName).toContain(line);
    }
    expect(shownBeforeName).not.toContain("no delete protection");
    expect(shownBeforeName).not.toContain("A snapshot of the Droplet is taken first");
    expect(previews[0]).toMatchObject({ name: "shop", snapshot: false, resources: RESOURCES });
    expect(previews[0]?.confirmPrompt).toContain("billed until the end of its term");

    // The approved plan lists the shutdown before the destroy, and says the same.
    const destroy = s.handler.requests.find((r) => r.kind === "iac-apply");
    expect(destroy).toMatchObject({
      title: "Delete shop on DigitalOcean and cancel the Droplet shop (4 resources in the plan)",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    const details = destroy?.details ?? "";
    expect(details).toContain(`- delete  ${DROPLET_ADDRESS}`);
    expect(details).toContain(
      "First OpsCrew shuts the Droplet shop (id 3164444) down through DigitalOcean's API; this plan's deletion of it is DigitalOcean's cancel.",
    );
    expect(details).toContain("bills it until then");
    expect(details).toContain("Its disk and its DigitalOcean snapshots go when the term ends");
    expect(details).toContain("Snapshot: none; DigitalOcean snapshots go with the Droplet.");
    // It stays billed until its term ends: no saving is shown.
    expect(details).toContain("Nothing is saved on the Droplet shop until its term ends.");
    expect(destroy?.costDelta).toBeUndefined();

    // After the apply: the end date, shown, in what remains, and audited with the shutdown.
    const ended = `The DigitalOcean Droplet shop is cancelled: its contract ends on 11 December 2026, and DigitalOcean bills it until then. Its disk goes then; until then you can start it again in ${CONSOLE}.`;
    expect(s.deps.reporter.text()).toContain(ended);
    expect(result.remaining[0]).toBe(ended);
    expect(providerCalls(s.deps)).toEqual([
      ["power off", "digitalocean server 3164444", "shut shop down before its cancellation"],
      ["powered off", "digitalocean server 3164444", "shop is off"],
      ["cancel date", "digitalocean server 3164444", `contract ends ${ENDS}`],
    ]);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
  });

  it("says plainly when the provider answers no end date", async () => {
    const s = await setup();
    s.servers.cancelledUntil = undefined;
    const result = await runDestroy(s.deps, { services: s.services });
    const unknown = `DigitalOcean did not say when the contract of the Droplet shop ends, so OpsCrew cannot tell you the date; see it in ${CONSOLE}.`;
    expect(s.deps.reporter.text()).toContain(unknown);
    expect(result.remaining).toContain(unknown);
    expect(providerCalls(s.deps)).toContainEqual([
      "cancel date",
      "digitalocean server 3164444",
      "no end date answered",
    ]);
  });

  it("says plainly when the end date cannot be read after the apply, and still finishes", async () => {
    const s = await setup();
    const lookup = s.servers.findAppServers.bind(s.servers);
    s.servers.findAppServers = async (app: string) => {
      if (s.engine.applied.length > 0) {
        throw new OpsCrewError("PROVIDER_ERROR", "DigitalOcean answered 503.");
      }
      return lookup(app);
    };
    const result = await runDestroy(s.deps, { services: s.services });
    const unread = `OpsCrew could not read when the contract of the Droplet shop ends (DigitalOcean answered 503); see the date in ${CONSOLE}.`;
    expect(s.deps.reporter.text()).toContain(unread);
    expect(result.remaining).toContain(unread);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(providerCalls(s.deps)).toContainEqual([
      "cancel date",
      "digitalocean server 3164444",
      "end date not read: DigitalOcean answered 503",
    ]);
  });

  it("takes no provider snapshot even when asked, since it would go with the server", async () => {
    const s = await setup();
    const result = await runDestroy(s.deps, { services: s.services, snapshot: true });
    expect(s.servers.snapshots).toEqual([]);
    expect(result.snapshotId).toBeUndefined();
    expect(s.deps.reporter.text()).toContain(
      "No DigitalOcean snapshot: DigitalOcean deletes a Droplet's snapshots with the Droplet, so one would not keep its data.",
    );
  });

  it("a refused cancel shows the provider's reason and names its console", async () => {
    const reason =
      "Error: cancelling instance 3164444: 422 Unprocessable Entity: instance was not created via the API";
    const s = await setup({ applyLog: `Plan: 0 to add, 0 to change, 4 to destroy.\n${reason}` });
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    const { message, hint } = error as OpsCrewError;
    expect(message).toContain("Cancelling the Droplet shop and deleting the rest failed:");
    expect(message).toContain(reason);
    expect(hint).toBe(
      `If DigitalOcean refused to cancel the Droplet shop (its reason is in the log above; it refuses one not created through its API, for example), cancel it by hand in ${CONSOLE}. Otherwise fix the cause shown above and run \`opscrew destroy\` again; it continues with what is left. The Droplet shop is shut down; you can start it again in ${CONSOLE}.`,
    );
    // Shut down first, then the refused apply; nothing is cleaned up.
    expect(s.servers.poweredOff).toEqual(["3164444"]);
    expect(s.github.deleted).toEqual([]);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeUndefined();
  });

  it("a shutdown that fails stops before anything is cancelled or deleted", async () => {
    const s = await setup();
    s.servers.powerOffError = new OpsCrewError(
      "PROVIDER_ERROR",
      "The server did not stop in time.",
    );
    const error = await runDestroy(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message:
        "OpsCrew could not shut the Droplet shop down: The server did not stop in time. Nothing was cancelled or deleted.",
      hint: `Check the Droplet in ${CONSOLE}, then run \`opscrew destroy\` again.`,
    });
    expect(s.engine.applied).toEqual([]);
    expect(providerCalls(s.deps)).toEqual([
      ["power off", "digitalocean server 3164444", "shut shop down before its cancellation"],
      ["power off failed", "digitalocean server 3164444", "shop: The server did not stop in time"],
    ]);
  });
});

/** The Droplet `data` and its firewall in the destroy plan, beside the app server's resources. */
function dataResource(type: string): ResourceChange {
  return {
    address: `module.server_data.${type}.this`,
    type,
    name: "this",
    provider: "registry.opentofu.org/digitalocean/digitalocean",
    action: "delete",
  };
}
const DATA_RESOURCES = [
  dataResource("digitalocean_firewall"),
  dataResource("digitalocean_droplet"),
];

/** The stand-in provider's server target: it cancels its servers, and has no backups on. */
const DO_TARGET = {
  provider: "digitalocean",
  mode: "vps-compose",
  location: "fra1",
  serverType: "s-1vcpu-2gb",
  image: "ubuntu-24-04-x64",
  backups: false,
} as const;

/** A deployed app whose Postgres runs on the extra server `data` at the stand-in provider. */
function splitAt(app: "hetzner" | "digitalocean"): DeployPlan {
  const base = splitPlan({ data: "cloud" });
  const deployed = {
    ...base,
    ...(app === "digitalocean" ? { target: { ...DO_TARGET, edge: "caddy" as const } } : {}),
    servers: [{ name: "data", target: DO_TARGET }],
    deployment: {
      ...base.deployment,
      lastPlanHash: "a".repeat(64),
      lastApplyAt: "2026-10-10T09:00:00.000Z",
    },
  };
  const facts = { data: { udpPortsInUse: [], wireguardInterfaces: [] } };
  return withNetwork(deployed, allocateNetwork(deployed, facts, testKeyMaker()).network);
}

const CANCELLED_DATA =
  "Server data: the DigitalOcean Droplet shop-data is cancelled, billed to the end of its term with the PostgreSQL database on it; OpsCrew takes no snapshot of it.";
const ENDED_DATA = `The DigitalOcean Droplet shop-data is cancelled: its contract ends on 11 December 2026, and DigitalOcean bills it until then. Its disk goes then; until then you can start it again in ${CONSOLE}.`;

describe.skipIf(!findExecutable("git"))(
  "runDestroy cancels every server of the app at such a provider",
  () => {
    it("an extra server at the same provider: each one shut down, worded and read back", async () => {
      const s = await setup({
        plan: splitAt("digitalocean"),
        resources: [...RESOURCES, ...DATA_RESOURCES],
      });
      const previews: DestroyPreview[] = [];
      let shownBeforeName = "";
      const result = await runDestroy(s.deps, {
        services: s.services,
        confirm: async (preview) => {
          previews.push(preview);
          if (shownBeforeName === "") shownBeforeName = s.deps.reporter.text();
          return true;
        },
      });
      // Each server's own typed name, worded as a cancel.
      expect(previews.map((p) => [p.name, p.server])).toEqual([
        ["shop", undefined],
        ["shop-data", "data"],
      ]);
      expect(previews[1]?.confirmPrompt).toBe(
        "Type shop-data to cancel server data (the DigitalOcean Droplet shop-data, billed until the end of its term) and everything on it; its disk and its DigitalOcean snapshots go when the term ends (anything else stops with nothing changed)",
      );
      expect(previews[0]?.servers).toEqual([
        "Server app: the DigitalOcean Droplet shop is cancelled, billed to the end of its term; OpsCrew takes no snapshot of it.",
        CANCELLED_DATA,
      ]);
      const notes =
        "DigitalOcean does not delete the Droplets shop and shop-data at once: it ends their contract at the end of their current term (1 month at least) and bills them until then.";
      expect(shownBeforeName).toContain(notes);
      expect(shownBeforeName).toContain("To keep the PostgreSQL database, type anything else now,");

      // Both shut down after the approval and before the apply, each audited by its name.
      const destroy = s.handler.requests.find((r) => r.kind === "iac-apply");
      expect(destroy?.title).toBe(
        "Delete shop on DigitalOcean and cancel the Droplets shop and shop-data (6 resources in the plan)",
      );
      expect(destroy?.details).toContain(
        "First OpsCrew shuts the Droplet shop (id 3164444) down through DigitalOcean's API",
      );
      expect(destroy?.details).toContain(
        "First OpsCrew shuts the Droplet shop-data (id 3164444) down through DigitalOcean's API",
      );
      expect(destroy?.details).toContain(notes);
      expect(s.events.filter((e) => e.startsWith("power-off") || e.startsWith("apply"))).toEqual([
        "power-off:3164444",
        "power-off:3164444",
        "apply",
        "apply:destroy",
      ]);
      expect(
        providerCalls(s.deps)
          .filter(([action]) => action === "power off")
          .map(([, , detail]) => detail),
      ).toEqual([
        "shut shop down before its cancellation",
        "shut shop-data down before its cancellation",
      ]);

      // Each one's end date, shown and in what remains.
      expect(result.remaining).toContain(ENDED_DATA);
      expect(result.remaining).toContain(
        `The DigitalOcean Droplet shop is cancelled: its contract ends on 11 December 2026, and DigitalOcean bills it until then. Its disk goes then; until then you can start it again in ${CONSOLE}.`,
      );
    });

    it("a mixed app: the Hetzner server is deleted as before, the other provider's is cancelled", async () => {
      const s = await setup({
        plan: splitAt("hetzner"),
        resources: [...deployedResources(), ...DATA_RESOURCES],
      });
      const previews: DestroyPreview[] = [];
      let shownBeforeName = "";
      const result = await runDestroy(s.deps, {
        services: s.services,
        snapshot: false,
        confirm: async (preview) => {
          previews.push(preview);
          if (shownBeforeName === "") shownBeforeName = s.deps.reporter.text();
          return true;
        },
      });
      // Each server worded by its own provider's definition.
      expect(previews[0]?.confirmPrompt).toBe(
        "Type shop to delete everything listed above (anything else cancels)",
      );
      expect(previews[0]?.servers).toEqual([
        "Server app: the Hetzner Cloud server shop is deleted; OpsCrew takes no snapshot of it.",
        CANCELLED_DATA,
      ]);
      expect(shownBeforeName).toContain(
        "DigitalOcean does not delete the Droplet shop-data at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.",
      );
      expect(shownBeforeName).not.toContain("Hetzner does not delete");
      expect(shownBeforeName).toContain("a DigitalOcean snapshot would go with the Droplet.");

      // Only the cancelled server is shut down; Hetzner's protection is lifted as before.
      expect(s.servers.poweredOff).toEqual(["3164444"]);
      const titles = s.handler.requests.map((r) => r.title);
      expect(titles).toContain("Lift delete protection on shop");
      const destroy = s.handler.requests.find((r) => r.title.startsWith("Delete shop"));
      expect(destroy?.title).toMatch(
        /^Delete shop on Hetzner Cloud and cancel the Droplet shop-data \(\d+ resources in the plan\)$/,
      );
      expect(destroy?.details).toContain(
        "First OpsCrew shuts the Droplet shop-data (id 3164444) down through DigitalOcean's API; this plan's deletion of it is DigitalOcean's cancel.",
      );
      expect(destroy?.details).not.toContain("shuts the server shop ");
      // The cancelled server stays billed until its term ends: no saving is shown.
      expect(destroy?.details).toContain(
        "Nothing is saved on the Droplet shop-data until its term ends.",
      );
      expect(destroy?.costDelta).toBeUndefined();
      expect(result.remaining).toContain(ENDED_DATA);
      expect(providerCalls(s.deps)).toEqual([
        ["power off", "digitalocean server 3164444", "shut shop-data down before its cancellation"],
        ["powered off", "digitalocean server 3164444", "shop-data is off"],
        ["cancel date", "digitalocean server 3164444", `contract ends ${ENDS}`],
      ]);
    });

    it("an app on the user's own server: its extra server at such a provider is cancelled", async () => {
      const { s, events, services } = await ownWithCancelledData();
      const asked: DestroyPreview[] = [];
      const result = await runDestroy(s.deps, {
        services,
        confirm: async (preview) => {
          asked.push(preview);
          return true;
        },
      });
      expect(asked.map((p) => p.name)).toEqual(["shop", "shop-data"]);
      expect(asked[0]?.servers).toContain(CANCELLED_DATA);
      expect(s.deps.reporter.text()).toContain(
        "DigitalOcean does not delete the Droplet shop-data at once",
      );
      const removal = s.handler.requests.find((r) => r.kind === "iac-apply" && r.allowDestroy);
      expect(removal?.details).toContain(
        "First OpsCrew shuts the Droplet shop-data (id 3164444) down through DigitalOcean's API; this plan's deletion of it is DigitalOcean's cancel.",
      );
      expect(removal?.details).toContain(
        "DigitalOcean does not delete the Droplet shop-data at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.",
      );
      // Shut down after the approval, before the apply of the plan that cancels it.
      expect(events).toEqual(["power-off:3164444", "apply", "lookup"]);
      expect(result.remaining).toContain(ENDED_DATA);
    });

    it("an app on the user's own server: a refused cancel names the provider's console", async () => {
      const reason =
        "Error: cancelling instance 3164444: 422 Unprocessable Entity: instance was not created via the API";
      const { s, events, services } = await ownWithCancelledData(reason);
      const error = await runDestroy(s.deps, { services, confirm: async () => true }).catch(
        (e: unknown) => e,
      );
      expect(error).toMatchObject({ code: "ENGINE_FAILED" });
      const { message, hint } = error as OpsCrewError;
      expect(message).toContain(reason);
      expect(hint).toBe(
        `If DigitalOcean refused to cancel the Droplet shop-data (its reason is in the log above; it refuses one not created through its API, for example), cancel it by hand in ${CONSOLE}. Otherwise fix the cause shown above and run \`opscrew destroy\` again; it continues with what is left. The Droplet shop-data is shut down; you can start it again in ${CONSOLE}.`,
      );
      // Shut down first, then the refused apply; no end date is read.
      expect(events).toEqual(["power-off:3164444", "apply"]);
    });
  },
);

/**
 * A provisioned app on the user's own server whose Postgres then moved to the extra server `data`
 * at the stand-in provider; the destroy plan deletes that Droplet with the DNS record. With
 * `refusal`, its apply fails with that line in the engine's log.
 */
async function ownWithCancelledData(refusal?: string) {
  const s = await ownProject();
  await provisionOwn(s);
  const provisioned = await readArtifact("plan", s.deps.paths.files.plan);
  const base = {
    ...provisioned,
    servers: [{ name: "data", target: DO_TARGET }],
    services: provisioned.services.map((service) =>
      service.name === "db" ? { ...service, server: "data" } : service,
    ),
  };
  const facts = { app: { udpPortsInUse: [], wireguardInterfaces: [] } };
  const plan = withNetwork(base, allocateNetwork(base, facts, testKeyMaker()).network);
  await writeArtifact("plan", s.deps.paths.files.plan, plan);
  await updateServerAddresses(s.deps.paths, (current) => ({
    ...current,
    servers: { data: { ipv4: "203.0.113.20" } },
  }));
  const engine = s.engine;
  const plan0 = engine.plan.bind(engine);
  engine.plan = async (dir, file, options) => {
    const summary = await plan0(dir, file, options);
    if (options?.destroy !== true || summary.changes.length === 0) return summary;
    const droplet = {
      address: "module.server_data.digitalocean_droplet.this",
      type: "digitalocean_droplet",
      change: { actions: ["delete"], before: { id: "3164444", name: "shop-data" }, after: null },
    };
    return {
      ...summary,
      changes: [...summary.changes, ...DATA_RESOURCES],
      planJson: { resource_changes: [droplet] },
    };
  };
  const events: string[] = [];
  const apply0 = engine.apply.bind(engine);
  engine.apply = async (dir, file, approval, options) => {
    events.push("apply");
    const result = await apply0(dir, file, approval, options);
    return refusal === undefined ? result : { ok: false, outputs: {}, log: refusal };
  };
  const services: DestroyServices = {
    engine: s.services.engine,
    github: s.github,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    servers: new CancellingServers(events, "digitalocean"),
    sleep: async () => undefined,
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    ...(s.services.own !== undefined ? { own: s.services.own } : {}),
  };
  return { s, events, services };
}
