import { readFile, writeFile } from "node:fs/promises";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeProviderBackups } from "../testing";
import {
  markWantedBackups,
  providerBackupsFile,
  readProviderBackups,
  syncProviderBackups,
  wantedBackups,
} from "./provider-backups";

const APP_ID = "202611001";
const DB_ID = "202611002";

/** A server module's wanted backups as the root's `wanted_backups` output lists them. */
const wanted = (serverId: string, on: boolean) => ({
  provider: "contabo",
  backup: { server_id: serverId, on },
});

/** The outputs with the app server's backups `on`. */
const outputs = (on: boolean) => ({ wanted_backups: { server: wanted(APP_ID, on) } });

/** A plan JSON whose `terraform_data.backup` of `module` has `actions` and `on` after them. */
const planChanging = (module: string, actions: string[], on: boolean) => ({
  format_version: "1.2",
  resource_changes: [
    {
      address: `module.${module}.terraform_data.backup`,
      type: "terraform_data",
      name: "backup",
      change: { actions, before: null, after: { input: { server_id: null, on } } },
    },
  ],
});

async function setup() {
  const deps = await createTestPhaseDeps();
  const contabo = new FakeProviderBackups();
  const run = {
    deps,
    phase: "provision" as const,
    command: "opscrew provision",
    backups: { contabo },
  };
  const said = () => deps.reporter.lines.map((line) => `${line.level}: ${line.message}`);
  const audited = () =>
    deps.audit.entries
      .filter((entry) => entry.kind === "provider-call")
      .map((entry) => [entry.action, entry.target]);
  const state = async (serverId: string) =>
    (await readProviderBackups(deps, { provider: "contabo", serverId }))?.state;
  /** This run's plan turned the app server's backups on, then the step after the apply. */
  const applied = async () => {
    const fresh = await markWantedBackups(
      run,
      planChanging("server", ["create"], true),
      outputs(true),
    );
    await syncProviderBackups(run, outputs(true), fresh);
  };
  return { deps, contabo, run, said, audited, state, applied };
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("wantedBackups", () => {
  it("reads each server module's wanted backups with its provider", () => {
    expect(
      wantedBackups({
        wanted_backups: { server: wanted(APP_ID, true), server_db: wanted(DB_ID, false) },
      }),
    ).toEqual([
      { module: "server", provider: "contabo", serverId: APP_ID, on: true },
      { module: "server_db", provider: "contabo", serverId: DB_ID, on: false },
    ]);
  });

  it("is empty for a root without the output", () => {
    expect(wantedBackups({ server_ipv4: "198.51.100.40" })).toEqual([]);
  });

  it("stops plainly on an output it cannot read, and on a provider whose Terraform turns them on", () => {
    for (const value of [
      { server: { provider: "contabo", backup: { server_id: "../x", on: true } } },
      { server: { provider: "contabo", backup: { on: true } } },
      { server: { ...wanted(APP_ID, true), provider: "hetzner" } },
    ]) {
      expect(() => wantedBackups({ wanted_backups: value })).toThrow(
        /could not read the automated backups the servers want from the infrastructure's outputs/,
      );
    }
  });
});

describe("markWantedBackups", () => {
  it("marks the servers whose terraform_data.backup the approved plan creates or updates to on", async () => {
    const s = await setup();
    const both = {
      wanted_backups: { server: wanted(APP_ID, true), server_db: wanted(DB_ID, true) },
    };
    expect(await markWantedBackups(s.run, planChanging("server", ["update"], true), both)).toEqual([
      APP_ID,
    ]);
    expect(await s.state(APP_ID)).toBe("wanted");
    // Not the server the plan didn't change.
    expect(await s.state(DB_ID)).toBeUndefined();
  });

  it("marks nothing for a plan that turns them off, changes nothing or can't be read", async () => {
    const s = await setup();
    for (const plan of [planChanging("server", ["update"], false), {}, { resource_changes: 1 }]) {
      expect(await markWantedBackups(s.run, plan, outputs(true))).toEqual([]);
    }
    expect(await s.state(APP_ID)).toBeUndefined();
  });

  it("keeps the record of backups OpsCrew already ordered", async () => {
    const s = await setup();
    await s.applied();
    expect(
      await markWantedBackups(s.run, planChanging("server", ["update"], true), outputs(true)),
    ).toEqual([APP_ID]);
    expect(await s.state(APP_ID)).toBe("on");
  });
});

describe("syncProviderBackups", () => {
  it("orders the backups this run's plan turned on, records it, says and audits it", async () => {
    const s = await setup();
    await s.applied();
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(await s.state(APP_ID)).toBe("on");
    expect(s.said()).toEqual([
      `step: Turning on Contabo's automated backups of server ${APP_ID}`,
      `success: Turned on Contabo's automated backups of server ${APP_ID}: they cost extra, priced on Contabo's order page.`,
    ]);
    expect(s.audited()).toEqual([["turn on backups", `contabo server ${APP_ID}`]]);
  });

  it("never orders them again once recorded", async () => {
    const s = await setup();
    await s.applied();
    await syncProviderBackups(s.run, outputs(true));
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    const today = s.deps.clock.now().toISOString().slice(0, 10);
    expect(s.said().at(-1)).toBe(
      `info: Contabo's automated backups of server ${APP_ID} are on since ${today}, when OpsCrew turned them on.`,
    );
  });

  it("never orders backups the state has on without a record of this computer's, and says so", async () => {
    const s = await setup();
    await syncProviderBackups(s.run, outputs(true));
    expect(s.contabo.calls).toEqual([]);
    expect(s.said()).toEqual([
      `warn: OpsCrew has no record of turning on Contabo's automated backups of server ${APP_ID} on this computer, so it doesn't order them: check the server in the Contabo Customer Control Panel.`,
    ]);
    expect(await s.state(APP_ID)).toBeUndefined();
  });

  it("keeps a refused order wanted, stops with Contabo's reason, and sends it again on the next run", async () => {
    const s = await setup();
    s.contabo.refused = "Contabo answered HTTP 400 to POST …/upgrade: Backup is not available";
    const error = await failure(s.applied());
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `Contabo refused to turn on its automated backups of server ${APP_ID}, so nothing was turned on: Contabo answered HTTP 400 to POST …/upgrade: Backup is not available`,
    );
    expect(error.hint).toBe(
      "Fix what Contabo named, then run `opscrew provision` again: it sends the order again.",
    );
    expect(await s.state(APP_ID)).toBe("wanted");
    expect(s.audited()).toEqual([["backups refused", `contabo server ${APP_ID}`]]);

    s.contabo.refused = undefined;
    await syncProviderBackups(s.run, outputs(true));
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`, `turnOn ${APP_ID}`]);
    expect(s.said()).toContain(
      `step: Turning on Contabo's automated backups of server ${APP_ID}: an earlier run's order didn't go through, so OpsCrew sends it again`,
    );
    expect(await s.state(APP_ID)).toBe("on");
  });

  it("keeps an order without a clear answer, and never sends it again", async () => {
    const s = await setup();
    s.contabo.error = new OpsCrewError("PROVIDER_ERROR", "Contabo answered HTTP 502.");
    const error = await failure(s.applied());
    const file = providerBackupsFile(s.deps.paths, "contabo", APP_ID);
    const check = `Check the server in the Contabo Customer Control Panel. If its automated backups are on there, change "sent" to "on" in ${file}; if they are off, delete that file. Then run \`opscrew provision\` again.`;
    expect(error.message).toBe(
      `Turning on Contabo's automated backups of server ${APP_ID} got no clear answer (Contabo answered HTTP 502), so they may be on. OpsCrew won't ask again.`,
    );
    expect(error.hint).toBe(check);
    expect(await s.state(APP_ID)).toBe("sent");
    expect(s.audited()).toEqual([["backups unclear", `contabo server ${APP_ID}`]]);

    s.contabo.error = undefined;
    await syncProviderBackups(s.run, outputs(true));
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.said().at(-1)).toBe(
      `warn: OpsCrew's order of Contabo's automated backups of server ${APP_ID} got no clear answer, so it isn't sent again. ${check}`,
    );
  });

  it("says how to cancel them in the panel when the plan turns them off, and calls nothing", async () => {
    const s = await setup();
    await s.applied();
    await syncProviderBackups(s.run, outputs(false));
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.said().at(-1)).toBe(
      `warn: The plan turns Contabo's automated backups of server ${APP_ID} off, but Contabo's API can't turn them off, so OpsCrew changed nothing. Cancel them in the Contabo Customer Control Panel: they stay on, and billed, until you do.`,
    );
    expect(await s.state(APP_ID)).toBeUndefined();
    expect(s.audited().at(-1)).toEqual(["backups left on", `contabo server ${APP_ID}`]);

    // Said once.
    const lines = s.said().length;
    await syncProviderBackups(s.run, outputs(false));
    expect(s.said()).toHaveLength(lines);
  });

  it("says they may be on when the order got no clear answer, and forgets one never sent", async () => {
    const s = await setup();
    s.contabo.error = new OpsCrewError("PROVIDER_ERROR", "Lost the connection to Contabo's API.");
    await failure(s.applied());
    await syncProviderBackups(s.run, outputs(false));
    expect(s.said().at(-1)).toBe(
      `warn: The plan turns Contabo's automated backups of server ${APP_ID} off. OpsCrew's order of them got no clear answer, so they may be on: check the server in the Contabo Customer Control Panel and cancel them there if they are. Contabo's API can't turn them off, so OpsCrew changed nothing.`,
    );

    const t = await setup();
    t.contabo.refused = "Backup is not available";
    await failure(t.applied());
    const lines = t.said().length;
    await syncProviderBackups(t.run, outputs(false));
    expect(t.said()).toHaveLength(lines);
    expect(await t.state(APP_ID)).toBeUndefined();
  });

  it("stops plainly on a damaged record, sending nothing", async () => {
    const s = await setup();
    await s.applied();
    const file = providerBackupsFile(s.deps.paths, "contabo", APP_ID);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      provider: "contabo",
      serverId: APP_ID,
      state: "on",
    });
    await writeFile(file, "{");
    const error = await failure(syncProviderBackups(s.run, outputs(true)));
    expect(error.code).toBe("ARTIFACT_INVALID");
    expect(error.message).toContain(file);
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
  });

  it("calls nothing for backups the plan has off and OpsCrew never ordered", async () => {
    const s = await setup();
    await syncProviderBackups(s.run, outputs(false));
    expect(s.contabo.calls).toEqual([]);
    expect(s.said()).toEqual([]);
  });
});
