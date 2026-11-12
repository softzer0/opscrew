// A server the provider's Terraform cannot remove, removed through its connector (ADR 0029, D10):
// Contabo's Terraform provider sends the cancel without the body Contabo requires (research R8).
import { mkdtemp, writeFile } from "node:fs/promises";
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
const CONSOLE = "the Contabo Customer Control Panel";
/** What every stop after the server's cancel says to do, for `opscrew destroy`. */
const AFRESH = "run `opscrew destroy` again without `--approve` to plan afresh";

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

/** The root module the plans are made from, and its input variables. */
const CONFIGURATION = {
  root_module: { module_calls: { server: { source: "../modules/contabo-vps" } } },
};
const VARIABLES = { server_type: { value: "V91" } };

/**
 * The plan JSON: the configuration and variables it was made from, and its resource changes with
 * each server's id as the state records it.
 */
function planJson(changes: readonly ResourceChange[], ids: Record<string, string>) {
  return {
    format_version: "1.2",
    configuration: CONFIGURATION,
    variables: VARIABLES,
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

/** The error `applyWithConnectorRemoval` stops with. */
async function stopOf(s: Awaited<ReturnType<typeof setup>>): Promise<OpsCrewError> {
  const error = await applyWithConnectorRemoval(s.run, s.approved, {
    allowDestroy: true,
    replan: s.replan,
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
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
    // The state removal runs with the run's environment (its state encryption).
    expect(s.engine.stateRemoveOptions).toEqual([{ env: { TF_ENCRYPTION: "kept" } }]);
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

  it("stops before anything is cancelled when the plan does not say a server's id", async () => {
    const s = await setup(TEARDOWN);
    s.approved = { ...s.approved, planJson: { format_version: "1.2", resource_changes: [] } };
    const error = await stopOf(s);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `The approved plan deletes the Contabo server ${SERVER} without saying its id, so OpsCrew cannot cancel it. Nothing was cancelled, and the infrastructure state is unchanged.`,
      hint: `Run \`opscrew destroy\` again without \`--approve\` to plan afresh. It is shut down: start it again in ${CONSOLE} if you keep it.`,
    });
    expect(s.events).toEqual([]);
    expect(s.engine.calls).toEqual([]);
  });

  it("stops before the state is touched when the cancel fails, and says the server is shut down", async () => {
    const s = await setup(TEARDOWN);
    s.servers.cancelError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered HTTP 400.", {
      hint: "Fix what it named.",
    });
    const error = await stopOf(s);
    expect(error).toMatchObject({
      code: "PROVIDER_ERROR",
      message: `OpsCrew could not cancel the Contabo server ${APP_ID}: Contabo answered HTTP 400. Nothing more was applied, and the infrastructure state is unchanged.`,
      hint: `Fix what it named. Check it in ${CONSOLE}, then run \`opscrew destroy\` again; a server cancelled already is not cancelled again. It is shut down: start it again in ${CONSOLE} if you keep it.`,
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

  it("says which servers are cancelled already when a later cancel fails", async () => {
    const changes = [...TEARDOWN, change(WORKER, "delete")];
    const s = await setup(changes, { [SERVER]: APP_ID, [WORKER]: WORKER_ID });
    const cancel = s.servers.cancelServer.bind(s.servers);
    s.servers.cancelServer = async (id: string) => {
      if (id === WORKER_ID) throw new OpsCrewError("PROVIDER_ERROR", "Contabo answered HTTP 400.");
      return cancel(id);
    };
    const error = await stopOf(s);
    expect(error.message).toBe(
      `OpsCrew could not cancel the Contabo server ${WORKER_ID}: Contabo answered HTTP 400. Nothing more was applied, and the infrastructure state is unchanged. The Contabo server ${APP_ID} is cancelled already.`,
    );
    expect(s.servers.cancelled).toEqual([APP_ID]);
    expect(s.engine.calls).toEqual([]);
  });

  it("stops naming the differences, audits them and applies nothing more, when the plan made again is not the approved one without the server", async () => {
    const s = await setup(TEARDOWN);
    const stateRemove = s.engine.stateRemove.bind(s.engine);
    s.engine.stateRemove = async (dir, addresses, options) => {
      await stateRemove(dir, addresses, options);
      // Something changed in between: the secret is gone, and a record appeared.
      s.engine.scenario.changes = [
        ...TEARDOWN.filter((c) => c.type !== "contabo_secret"),
        change("module.dns.cloudflare_dns_record.a", "create"),
      ];
    };
    const error = await stopOf(s);
    const differences = [
      "create module.dns.cloudflare_dns_record.a: not in the approved plan",
      "delete module.server.contabo_secret.deploy: in the approved plan, not in the plan made again",
    ];
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: [
        `The plan made again without the cancelled Contabo server ${APP_ID} is not the approved plan without its deletion, so OpsCrew stopped and applied nothing more:`,
        ...differences.map((line) => `  ${line}`),
      ].join("\n"),
      hint: "The server stays cancelled and is out of the infrastructure state, so the approved plan cannot be applied any more. Run `opscrew drift` to see what changed, then run `opscrew destroy` again without `--approve`: it plans what is left.",
    });
    expect(s.engine.calls).toEqual(["state-rm", "plan"]);
    expect(await exists(s.planned[0]?.file ?? "")).toBe(false);
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "iac",
        action: "plan again",
        target: s.planned[0]?.summary.planHash,
        decision: "refused",
        detail: `the plan made again is not the approved plan ${s.approved.planHash} without the deletion of ${SERVER}: ${differences.join("; ")}`,
      }),
    );
  });

  it("stops after the state removal, applying nothing, when the plan made again has another configuration or other variables", async () => {
    const s = await setup(TEARDOWN);
    const stateRemove = s.engine.stateRemove.bind(s.engine);
    s.engine.stateRemove = async (dir, addresses, options) => {
      await stateRemove(dir, addresses, options);
      // The files on disk are not the ones the approved plan was made from: same addresses and
      // actions, other values.
      s.engine.scenario.planJson = {
        ...planJson(TEARDOWN, { [SERVER]: APP_ID }),
        configuration: { root_module: { module_calls: { server: { source: "./elsewhere" } } } },
        variables: { server_type: { value: "V94" } },
      };
    };
    const error = await stopOf(s);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: [
        `The plan made again without the cancelled Contabo server ${APP_ID} is not the approved plan without its deletion, so OpsCrew stopped and applied nothing more:`,
        "  the infrastructure configuration: not the approved plan's",
        "  variable server_type: not the approved plan's value",
      ].join("\n"),
      hint: "The server stays cancelled and is out of the infrastructure state, so the approved plan cannot be applied any more. Run `opscrew drift` to see what changed, then run `opscrew destroy` again without `--approve`: it plans what is left.",
    });
    expect(s.engine.stateRemoved).toEqual([SERVER]);
    expect(s.engine.applied).toEqual([]);
    expect(await exists(s.planned[0]?.file ?? "")).toBe(false);
  });

  it("compares the plans with their sensitive values masked, as a saved plan keeps them", async () => {
    const s = await setup(TEARDOWN);
    const secret = (value: string) => ({
      ...planJson(TEARDOWN, { [SERVER]: APP_ID }),
      configuration: {
        root_module: { ...CONFIGURATION.root_module, variables: { key: { sensitive: true } } },
      },
      variables: { ...VARIABLES, key: { value } },
    });
    // The approved plan as its saved sidecar holds it, the sensitive value masked.
    s.approved = { ...s.approved, planJson: secret("(sensitive value)") };
    s.engine.scenario.planJson = secret("the value itself");
    const result = await applyWithConnectorRemoval(s.run, s.approved, {
      allowDestroy: true,
      replan: s.replan,
    });
    expect(result.ok).toBe(true);
    expect(s.engine.calls).toEqual(["state-rm", "plan", "apply"]);
  });

  it("says the server is cancelled already when it cannot be taken out of the state", async () => {
    const s = await setup(TEARDOWN);
    s.engine.stateRemove = async () => {
      throw new OpsCrewError("ENGINE_FAILED", `OpenTofu state rm ${SERVER} failed (exit code 1).`, {
        hint: "Check the state passphrase, then try again.",
      });
    };
    const error = await stopOf(s);
    expect(error).toMatchObject({
      code: "ENGINE_FAILED",
      message: `OpenTofu state rm ${SERVER} failed (exit code 1). The Contabo server ${APP_ID} is cancelled already.`,
      hint: `Check the state passphrase, then try again. ${AFRESH.replace(/^r/, "R")}: a server cancelled already is not cancelled again.`,
    });
    expect(s.planned).toEqual([]);
    expect(s.engine.applied).toEqual([]);
  });

  it("says the server is cancelled already when the plan made again fails, and leaves no plan file", async () => {
    const s = await setup(TEARDOWN);
    let file = "";
    const replan = async (planFile: string): Promise<PlanSummary> => {
      file = planFile;
      await writeFile(planFile, "half a plan");
      throw new OpsCrewError("ENGINE_FAILED", "OpenTofu plan failed (exit code 1).", {
        hint: "Fix what it names, then try again.",
      });
    };
    const error = await applyWithConnectorRemoval(s.run, s.approved, {
      allowDestroy: true,
      replan,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "ENGINE_FAILED",
      message: `OpenTofu plan failed (exit code 1). The Contabo server ${APP_ID} is cancelled already.`,
      hint: `Fix what it names, then try again. ${AFRESH.replace(/^r/, "R")}: a server cancelled already is not cancelled again.`,
    });
    expect(file).toBe(join(s.dir, "destroy-rest.tfplan"));
    expect(await exists(file)).toBe(false);
    expect(s.engine.applied).toEqual([]);
  });
});
