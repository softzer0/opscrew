/**
 * `opscrew retarget --finish` off a provider that cancels its servers at the end of their term,
 * and `--abort` of a move to one (feature 026, US2, US4 #2, FR-2608, FR-2609): the server is
 * cancelled, not deleted at once. The plan says so before its approval, the server is shut down
 * after the approval and before the apply, and its end date is read back, shown and audited.
 */
import type { AppServer, CloudProviderDefinition, ServerSnapshotApi } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { destroyConfirmPrompt, noProviderSnapshot } from "../destroy/texts";
import { networked } from "../network/__fixtures__/plans";
import { updateServerAddresses } from "../shared";
import { recordGeneratedEntries } from "../shared/app-secrets";
import { APP, type MoveHarness, moveHarness, NEW_SERVERS, OLD_IDS, OLD_IPV4 } from "../testing";
import { caught, crashAfter, expectGated, run, trail } from "./__fixtures__/assert";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";
import { cloudFacts, cloudHosts } from "./network.fakes";
import type { RetargetServices } from "./types";

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

const OLD_ID = OLD_IDS.digitalocean;
const DATA_ID = "3164499";
const DATA_IP = "203.0.113.20";
const CONSOLE = "the DigitalOcean control panel";
const ENDS = "2026-12-11T00:00:00.000Z";
const NOTES = [
  "DigitalOcean does not delete the Droplet shop at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.",
  // In a move the app's DNS records follow the app, so only the server's own resources are named.
  "OpsCrew shuts it down now and deletes its other resources (such as its firewall and SSH key) at once.",
  `Its disk and its DigitalOcean snapshots go when the term ends; until then you can start it again in ${CONSOLE}.`,
];
/** The approval's line for the shutdown of the Droplet `id`. */
const shutdown = (id: string) =>
  `First OpsCrew shuts the Droplet shop (id ${id}) down through DigitalOcean's API; this plan's deletion of it is DigitalOcean's cancel.`;
const SHUTDOWN = shutdown(OLD_ID);
const DATE = `The DigitalOcean Droplet shop is cancelled: its contract ends on 11 December 2026, and DigitalOcean bills it until then. Its disk goes then; until then you can start it again in ${CONSOLE}.`;

/**
 * The stand-in provider's servers: each shutdown is recorded with the trail it came after, and the
 * lookup answers the cancelled server `id` (and the extra one, still running) as cancelled until
 * {@link ENDS}.
 */
function cancellingServers(h: MoveHarness, extra = false, id = OLD_ID) {
  const base = h.services.servers?.digitalocean as ServerSnapshotApi;
  const fake = {
    /** Each shutdown: the server's id and the trail before it. */
    poweredOff: [] as { id: string; after: string[] }[],
    powerOffError: undefined as Error | undefined,
    lookups: 0,
  };
  const mark = h.events.length;
  const api: ServerSnapshotApi = {
    ...base,
    powerOff: async (id) => {
      fake.poweredOff.push({ id, after: trail(h.events.slice(mark)) });
      if (fake.powerOffError) throw fake.powerOffError;
    },
    findAppServers: async (): Promise<AppServer[]> => {
      fake.lookups += 1;
      return [
        { id, name: APP, status: "off", cancelledUntil: ENDS },
        ...(extra ? [{ id: DATA_ID, name: `${APP}-data`, status: "running" }] : []),
      ];
    },
  };
  h.services.servers = { ...h.services.servers, digitalocean: api };
  return fake;
}

/** A move off the stand-in provider, switched; its old server is cancelled by `--finish`. */
async function switched() {
  const h = await moveHarness({ from: "digitalocean" });
  await run(h);
  return h;
}

function finish(h: MoveHarness, services: RetargetServices = h.services) {
  return finishRetarget(h.deps, { services, confirm: h.confirm });
}

/** The removal's approval request (the last `iac-apply` that allows a destroy). */
function removalRequest(h: MoveHarness) {
  return h.handler.requests.findLast((r) => r.kind === "iac-apply" && r.allowDestroy === true);
}

describe.skipIf(!findExecutable("git"))("a move at a provider that cancels", () => {
  it("says the old server is cancelled before its approval, shuts it down, then reads its end date", async () => {
    const h = await switched();
    const servers = cancellingServers(h);
    const prompts: (string | undefined)[] = [];
    const confirm = h.confirm;
    h.confirm = async (preview) => {
      prompts.push((preview as { confirmPrompt?: string }).confirmPrompt);
      return confirm(preview);
    };
    const mark = h.events.length;

    const result = await finish(h);

    expect(result).toMatchObject({ step: "finished", done: true });
    expect(result.snapshotId).toBeUndefined();
    // No provider snapshot (it would go with the server); one shutdown, after the approval and
    // before the apply.
    expect(trail(h.events.slice(mark))).toEqual([
      `${h.newServer.ipv4} start caddy`,
      `confirm ${APP}`,
      "approve iac-apply",
      "apply deletes=4",
      "approve git-push",
      "approve pull-request",
    ]);
    expect(servers.poweredOff).toEqual([
      {
        id: OLD_ID,
        after: [`${h.newServer.ipv4} start caddy`, `confirm ${APP}`, "approve iac-apply"],
      },
    ]);
    expectGated(h.events, true);
    expect(h.engine.state.servers.server_previous).toBeUndefined();

    // Before the typed name and in the approval: cancelled, billed to the end of its term.
    expect(h.reporter.lines).toContainEqual({ level: "warn", message: NOTES.join("\n") });
    expect(prompts).toEqual([destroyConfirmPrompt(APP, "digitalocean")]);
    const request = removalRequest(h);
    expect(request?.title).toBe(
      "Cancel the old Droplet shop on DigitalOcean and delete its other resources (4 resources in the plan)",
    );
    expect(request?.details).toContain([SHUTDOWN, ...NOTES].join("\n"));
    expect(request?.details).toContain("Snapshot: none.");

    // After the apply: the end date, shown, audited and listed under what remains.
    expect(h.reporter.lines).toContainEqual({
      level: "success",
      message: "Cancelled the old Droplet and deleted the rest (4 resources).",
    });
    expect(h.reporter.lines).toContainEqual({ level: "info", message: DATE });
    expect(result.next).toContain(DATE);
    expect(h.reporter.text()).toContain(`What remains:\n  - ${DATE}`);
    expect(h.reporter.text()).toContain("the old Droplet on DigitalOcean is cancelled");
    const calls = h.audit.entries.filter((e) => e.target?.startsWith("digitalocean server"));
    expect(calls.map((e) => [e.action, e.target, e.detail])).toEqual([
      ["power off", `digitalocean server ${OLD_ID}`, "shut shop down before its cancellation"],
      ["powered off", `digitalocean server ${OLD_ID}`, "shop is off"],
      ["cancel date", `digitalocean server ${OLD_ID}`, `contract ends ${ENDS}`],
    ]);
  });

  it("--finish --snapshot takes no provider snapshot, which would go with the server, and says why", async () => {
    const h = await switched();
    cancellingServers(h);
    const mark = h.events.length;

    const result = await finishRetarget(h.deps, {
      services: h.services,
      confirm: h.confirm,
      snapshot: true,
    });

    expect(result).toMatchObject({ step: "finished", done: true });
    expect(result.snapshotId).toBeUndefined();
    expect(h.events.slice(mark).some((e) => e.type === "snapshot")).toBe(false);
    expect(h.reporter.lines).toContainEqual({
      level: "info",
      message: noProviderSnapshot("digitalocean"),
    });
    expect(noProviderSnapshot("digitalocean")).toBe(
      "No DigitalOcean snapshot: DigitalOcean deletes a Droplet's snapshots with the Droplet, so one would not keep its data.",
    );
    expect(removalRequest(h)?.details).toContain("Snapshot: none.");
  });

  it("a script sees the cancellation with the plan's hash, and nothing is shut down before --approve", async () => {
    const h = await switched();
    const servers = cancellingServers(h);
    h.deps.interactive = false;
    h.cli.confirm = APP;

    const first = await finish(h);
    expect(first).toMatchObject({ step: "switched", done: false });
    const hash = first.pendingPlanHash as string;
    expect(servers.poweredOff).toEqual([]);
    expect(h.reporter.text()).toContain([SHUTDOWN, ...NOTES].join("\n"));
    expect(h.engine.state.servers.server_previous).toBeDefined();

    h.cli.approve = hash;
    const last = await finishRetarget(h.deps, {
      services: h.services,
      confirm: async () => true,
      approvePlanHash: hash,
    });
    expect(last).toMatchObject({ step: "finished", done: true });
    expect(servers.poweredOff.map((p) => p.id)).toEqual([OLD_ID]);
    expect(last.next).toContain(DATE);
  });

  it("a failed shutdown applies nothing and says so", async () => {
    const h = await switched();
    const servers = cancellingServers(h);
    servers.powerOffError = new Error("the API is down");
    const mark = h.events.length;

    const error = await caught(finish(h));

    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "OpsCrew could not shut the Droplet shop down: unexpected error. Nothing was cancelled or deleted.",
    );
    expect(error.hint).toBe(
      `Check the Droplet in ${CONSOLE}, then run \`opscrew retarget --finish\` again.`,
    );
    expect(trail(h.events.slice(mark)).filter((line) => line.startsWith("apply"))).toEqual([]);
    expect(h.engine.state.servers.server_previous).toBeDefined();
    expect(servers.lookups).toBe(0);
    expect(h.audit.entries.map((e) => e.action)).toContain("power off failed");
  });

  it("a refused cancel shows the provider's reason and names its console", async () => {
    const h = await switched();
    const servers = cancellingServers(h);
    const reason = "Error: the instance was not created through the API, so it cannot be cancelled";
    h.engine.failApply = (effect) => (effect.destroys.length > 0 ? reason : undefined);

    const error = await caught(finish(h));

    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain(
      `Cancelling the old server and deleting the rest failed:\n${reason}`,
    );
    expect(error.hint).toBe(
      `If DigitalOcean refused to cancel the Droplet shop (its reason is in the log above; it refuses one not created through its API, for example), cancel it by hand in ${CONSOLE}. Otherwise fix the cause shown above and run \`opscrew retarget --finish\` again; it continues with what is left. The Droplet shop is shut down; you can start it again in ${CONSOLE}.`,
    );
    // Shut down first, then the refused apply; no end date is read.
    expect(servers.poweredOff.map((p) => p.id)).toEqual([OLD_ID]);
    expect(servers.lookups).toBe(0);
    expect(h.engine.state.servers.server_previous).toBeDefined();
  });

  it("with an extra server at the same provider: only the old app server is cancelled; the extra one stays", async () => {
    const h = await moveHarness({ from: "digitalocean" });
    const { network: _none, ...base } = h.plan;
    const split = {
      ...base,
      servers: [
        {
          name: "data",
          target: {
            provider: "digitalocean",
            mode: "vps-compose",
            location: "fra1",
            serverType: "s-2vcpu-4gb",
            backups: false,
          },
        },
      ],
      services: base.services.map((s) => (s.name === "db" ? { ...s, server: "data" } : s)),
    } as Omit<DeployPlan, "network">;
    const { plan, privateKeys } = networked(split);
    await writeArtifact("plan", h.paths.files.plan, plan);
    await recordGeneratedEntries(h.deps, "network", privateKeys);
    await updateServerAddresses(h.paths, (current) => ({
      ...current,
      servers: { data: { ipv4: DATA_IP } },
    }));
    const member = (name: string) => plan.network?.members.find((m) => m.name === name);
    const net = cloudHosts({
      [OLD_IPV4]: cloudFacts({ publicKey: member("app")?.publicKey }),
      [DATA_IP]: cloudFacts({ publicKey: member("data")?.publicKey }),
    });
    h.services.serverHost = net.adapter;
    expect(await run(h)).toMatchObject({ step: "switched" });
    const servers = cancellingServers(h, true);

    const result = await finish(h);

    expect(result).toMatchObject({ step: "finished", done: true });
    expect(servers.poweredOff.map((p) => p.id)).toEqual([OLD_ID]);
    expect(removalRequest(h)?.details).toContain([SHUTDOWN, ...NOTES].join("\n"));
    expect(result.next).toContain(DATE);
    // The extra server is neither shut down nor cancelled, and no date is said for it.
    const said = h.reporter.text();
    expect(said).not.toContain("shop-data");
    expect(h.audit.entries.some((e) => e.target === `digitalocean server ${DATA_ID}`)).toBe(false);
  });

  it("--abort of a move to the provider cancels the new server, billed to the end of its term", async () => {
    // A move from Hetzner to the stand-in provider, stopped after the new server's deploy.
    const h = await moveHarness();
    crashAfter(h, "deployed");
    await expect(run(h)).rejects.toThrow("interrupted");
    const id = NEW_SERVERS.digitalocean.id;
    const servers = cancellingServers(h, false, id);
    const prompts: (string | undefined)[] = [];
    const result = await abortRetarget(h.deps, {
      services: h.services,
      confirm: async (preview) => {
        prompts.push(preview.confirmPrompt);
        return h.confirm(preview);
      },
    });

    expect(result).toMatchObject({ step: "aborted", done: true });
    expectGated(h.events, true);
    // One shutdown, after the removal's approval and before its apply.
    expect(servers.poweredOff.map((p) => p.id)).toEqual([id]);
    const before = servers.poweredOff[0]?.after ?? [];
    expect(before.at(-1)).toBe("approve iac-apply");
    expect(before.some((line) => line.includes("deletes="))).toBe(false);
    expect(h.engine.state.servers.server).toEqual(
      expect.objectContaining({ id: OLD_IDS.hetzner, provider: "hetzner" }),
    );

    // Before the typed name and in the approval: cancelled, billed to the end of its term.
    expect(h.reporter.lines).toContainEqual({ level: "warn", message: NOTES.join("\n") });
    expect(prompts).toEqual([destroyConfirmPrompt(APP, "digitalocean")]);
    const request = removalRequest(h);
    expect(request?.title).toBe(
      "Cancel the new Droplet shop on DigitalOcean and delete its other resources (4 resources in the plan)",
    );
    expect(request?.details).toContain(
      [
        shutdown(id),
        ...NOTES,
        "The app keeps running on the old server; nothing is saved until the new Droplet's term ends.",
      ].join("\n"),
    );
    // It stays billed until its term ends: no saving is shown.
    expect(request?.costDelta).toBeUndefined();

    // After the apply: the end date, shown, audited and in what is left to know.
    expect(h.reporter.lines).toContainEqual({
      level: "success",
      message: "Cancelled the new Droplet and deleted the rest (4 resources).",
    });
    expect(h.reporter.lines).toContainEqual({ level: "info", message: DATE });
    expect(result.next).toContain(DATE);
    const calls = h.audit.entries.filter((e) => e.target === `digitalocean server ${id}`);
    expect(calls.map((e) => [e.action, e.detail])).toEqual([
      ["power off", "shut shop down before its cancellation"],
      ["powered off", "shop is off"],
      ["cancel date", `contract ends ${ENDS}`],
    ]);
  });
});
