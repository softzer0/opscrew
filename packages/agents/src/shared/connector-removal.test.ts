// A server the provider's Terraform cannot remove, removed through its connector (ADR 0029, D10):
// Contabo's Terraform provider sends the cancel without the body Contabo requires (research R8).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanSummary, ResourceChange } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeEngine, FakeServers } from "../testing";
import { applyWithConnectorRemoval } from "./connector-removal";

const CONTABO = "registry.opentofu.org/contabo/contabo";
const APP_ID = "202611001";
const WORKER_ID = "202611002";

function change(address: string, action: ResourceChange["action"]): ResourceChange {
  const [type = "", name = ""] = address.split(".").slice(-2);
  const provider = type.startsWith("contabo_") ? CONTABO : "terraform.io/builtin/terraform";
  return { address, type, name, provider, action };
}

const SERVER = "module.server.contabo_instance.this";
const WORKER = "module.server_worker.contabo_instance.this";
/** A teardown of the app's Contabo server and its other resources. */
const TEARDOWN = [
  change("module.server.terraform_data.firewall", "delete"),
  change("module.server.contabo_tag_assignment.app", "delete"),
  change(SERVER, "delete"),
  change("module.server.contabo_secret.deploy", "delete"),
];

/** The plan JSON's resource changes with each server's id as the state records it. */
function planJson(changes: readonly ResourceChange[], ids: Record<string, string>) {
  return {
    format_version: "1.2",
    resource_changes: changes.map((c) => ({
      address: c.address,
      type: c.type,
      change: {
        actions: c.action === "replace" ? ["delete", "create"] : [c.action],
        before: { id: ids[c.address] ?? `${c.name}-1`, name: "shop" },
        after: null,
      },
    })),
  };
}

async function setup(
  changes: ResourceChange[],
  ids: Record<string, string> = { [SERVER]: APP_ID },
) {
  const dir = await mkdtemp(join(tmpdir(), "opscrew-connector-removal-"));
  const deps = await createTestPhaseDeps({ root: dir });
  const engine = new FakeEngine({ changes, planJson: planJson(changes, ids) });
  const events: string[] = [];
  const servers = new FakeServers(events, "contabo");
  const approved = await engine.plan(dir, join(dir, "destroy.tfplan"), { destroy: true });
  engine.calls.length = 0;
  const planned: { file: string; summary: PlanSummary }[] = [];
  const replan = async (file: string) => {
    const summary = await engine.plan(dir, file, { destroy: true });
    planned.push({ file, summary });
    return summary;
  };
  const env = { TF_ENCRYPTION: "kept" };
  const run = {
    deps,
    phase: "provision" as const,
    command: "opscrew destroy",
    engine,
    dir,
    env,
    servers: () => servers,
  };
  return { deps, engine, servers, events, approved, replan, planned, run, dir };
}

describe("applyWithConnectorRemoval", () => {
  it("applies a plan that removes no such server exactly as the engine would", async () => {
    const hetzner: ResourceChange = {
      address: "module.server.hcloud_server.this",
      type: "hcloud_server",
      name: "this",
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "delete",
    };
    const s = await setup([hetzner], { [hetzner.address]: "4711" });
    const result = await applyWithConnectorRemoval(s.run, s.approved, {
      allowDestroy: true,
      replan: s.replan,
    });
    expect(result.ok).toBe(true);
    expect(s.engine.calls).toEqual(["apply"]);
    expect(s.engine.applied).toEqual([
      {
        planFile: s.approved.planFile,
        approval: { approvedPlanHash: s.approved.planHash, allowDestroy: true },
      },
    ]);
    expect(s.events).toEqual([]);
  });

  it("cancels the server through the connector, takes it out of the state and applies the rest planned again", async () => {
    const s = await setup(TEARDOWN);
    const result = await applyWithConnectorRemoval(s.run, s.approved, {
      allowDestroy: true,
      replan: s.replan,
    });
    expect(result.ok).toBe(true);
    // The server's id comes from the plan's `before`.
    expect(s.events).toEqual([`cancel:${APP_ID}`]);
    expect(s.engine.stateRemoved).toEqual([SERVER]);
    expect(s.engine.calls).toEqual(["state-rm", "plan", "apply"]);
    const [again] = s.planned;
    expect(again?.file).toBe(join(s.dir, "destroy-rest.tfplan"));
    expect(again?.summary.changes.map((c) => c.address)).not.toContain(SERVER);
    // The plan made again is applied, bound to its own hash, and its file goes afterwards.
    expect(s.engine.applied).toEqual([
      {
        planFile: again?.file,
        approval: { approvedPlanHash: again?.summary.planHash, allowDestroy: true },
      },
    ]);
    expect(await exists(again?.file ?? "")).toBe(false);

    expect(s.deps.reporter.text()).toContain(
      `step: Cancelling the Contabo server ${APP_ID} through Contabo's API`,
    );
    expect(s.deps.reporter.text()).toContain(
      `success: Cancelled the Contabo server ${APP_ID}: its contract ends on 2026-12-11.`,
    );
    const audit = s.deps.audit.entries.map(({ at: _at, ...entry }) => entry);
    expect(audit).toEqual([
      {
        kind: "provider-call",
        actor: "opscrew",
        action: "cancel server",
        phase: "provision",
        target: `contabo server ${APP_ID}`,
        detail: `${SERVER}, which the approved plan deletes`,
      },
      {
        kind: "provider-call",
        actor: "opscrew",
        action: "cancelled server",
        phase: "provision",
        target: `contabo server ${APP_ID}`,
        detail: "contract ends 2026-12-11",
      },
      {
        kind: "iac",
        actor: "opscrew",
        action: "state rm",
        phase: "provision",
        target: s.approved.planHash,
        detail: `${SERVER}, cancelled through its provider's connector`,
      },
      {
        kind: "iac",
        actor: "opscrew",
        action: "plan again",
        phase: "provision",
        target: again?.summary.planHash,
        detail: `the approved plan ${s.approved.planHash} without the deletion of ${SERVER}`,
      },
    ]);
  });

  it("cancels every such server and takes them out of the state together", async () => {
    const changes = [...TEARDOWN, change(WORKER, "delete")];
    const s = await setup(changes, { [SERVER]: APP_ID, [WORKER]: WORKER_ID });
    await applyWithConnectorRemoval(s.run, s.approved, { allowDestroy: true, replan: s.replan });
    expect(s.events).toEqual([`cancel:${APP_ID}`, `cancel:${WORKER_ID}`]);
    expect(s.engine.stateRemoved).toEqual([SERVER, WORKER]);
    expect(s.engine.calls).toEqual(["state-rm", "plan", "apply"]);
  });

  it("applies a replaced server's plan made again, which creates it", async () => {
    const s = await setup([
      change(SERVER, "replace"),
      change("module.dns.terraform_data.a", "update"),
    ]);
    await applyWithConnectorRemoval(s.run, s.approved, { allowDestroy: true, replan: s.replan });
    expect(s.events).toEqual([`cancel:${APP_ID}`]);
    expect(s.planned[0]?.summary.changes.map((c) => `${c.action} ${c.address}`)).toEqual([
      `create ${SERVER}`,
      "update module.dns.terraform_data.a",
    ]);
    expect(s.engine.calls).toEqual(["state-rm", "plan", "apply"]);
  });

  it("stops before the state is touched when the cancel fails", async () => {
    const s = await setup(TEARDOWN);
    s.servers.cancelError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered HTTP 400.", {
      hint: "Fix what it named.",
    });
    const error = await applyWithConnectorRemoval(s.run, s.approved, {
      allowDestroy: true,
      replan: s.replan,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `OpsCrew could not cancel the Contabo server ${APP_ID}: Contabo answered HTTP 400. Nothing more was applied, and the infrastructure state is unchanged.`,
      hint: "Fix what it named. Check it in the Contabo Customer Control Panel, then run `opscrew destroy` again; a server cancelled already is not cancelled again.",
    });
    expect(s.engine.calls).toEqual([]);
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        action: "cancel failed",
        target: `contabo server ${APP_ID}`,
        detail: "Contabo answered HTTP 400",
      }),
    );
  });

  it("stops naming the differences, and applies nothing more, when the plan made again is not the approved one without the server", async () => {
    const s = await setup(TEARDOWN);
    const stateRemove = s.engine.stateRemove.bind(s.engine);
    s.engine.stateRemove = async (dir, addresses) => {
      await stateRemove(dir, addresses);
      // Something changed in between: the secret is gone, and a record appeared.
      s.engine.scenario.changes = [
        ...TEARDOWN.filter((c) => c.type !== "contabo_secret"),
        change("module.dns.cloudflare_dns_record.a", "create"),
      ];
    };
    const error = await applyWithConnectorRemoval(s.run, s.approved, {
      allowDestroy: true,
      replan: s.replan,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: [
        `The plan made again without the cancelled Contabo server ${APP_ID} is not the approved plan without its deletion, so OpsCrew stopped and applied nothing more:`,
        "  create module.dns.cloudflare_dns_record.a: not in the approved plan",
        "  delete module.server.contabo_secret.deploy: in the approved plan, not in the plan made again",
      ].join("\n"),
      hint: "The server stays cancelled and is out of the infrastructure state. Run `opscrew drift` to see what changed, then run `opscrew destroy` again: it plans what is left.",
    });
    expect(s.engine.calls).toEqual(["state-rm", "plan"]);
    expect(await exists(s.planned[0]?.file ?? "")).toBe(false);
  });

  it("says the server is cancelled already when it cannot be taken out of the state", async () => {
    const s = await setup(TEARDOWN);
    s.engine.stateRemove = async () => {
      throw new OpsCrewError("ENGINE_FAILED", `OpenTofu state rm ${SERVER} failed (exit code 1).`, {
        hint: "Check the state passphrase, then try again.",
      });
    };
    const error = await applyWithConnectorRemoval(s.run, s.approved, {
      allowDestroy: true,
      replan: s.replan,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "ENGINE_FAILED",
      message: `OpenTofu state rm ${SERVER} failed (exit code 1). The Contabo server ${APP_ID} is cancelled already.`,
      hint: "Check the state passphrase, then try again. Running `opscrew destroy` again goes on from there: a server cancelled already is not cancelled again.",
    });
    expect(s.planned).toEqual([]);
    expect(s.engine.applied).toEqual([]);
  });
});
