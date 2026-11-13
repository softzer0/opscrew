import { readFile, writeFile } from "node:fs/promises";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeProviderBackups } from "../testing";
import {
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
  return { deps, contabo, run, said, audited, state };
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

describe("syncProviderBackups", () => {
  it("turns on the backups the state wants on, records it, says and audits it", async () => {
    const s = await setup();
    await syncProviderBackups(s.run, {
      wanted_backups: { server: wanted(APP_ID, true), server_db: wanted(DB_ID, false) },
    });
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(await s.state(APP_ID)).toBe("on");
    expect(await s.state(DB_ID)).toBeUndefined();
    expect(s.said()).toEqual([
      `step: Turning on Contabo's automated backups of server ${APP_ID}`,
      `success: Turned on Contabo's automated backups of server ${APP_ID}: they cost extra, priced on Contabo's order page.`,
    ]);
    expect(s.audited()).toEqual([["turn on backups", `contabo server ${APP_ID}`]]);
  });

  it("never orders them again once recorded", async () => {
    const s = await setup();
    const outputs = { wanted_backups: { server: wanted(APP_ID, true) } };
    await syncProviderBackups(s.run, outputs);
    await syncProviderBackups(s.run, outputs);
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    const today = s.deps.clock.now().toISOString().slice(0, 10);
    expect(s.said().at(-1)).toBe(
      `info: Contabo's automated backups of server ${APP_ID} are on since ${today}, when OpsCrew turned them on.`,
    );
  });

  it("forgets a refusal, so nothing is recorded as ordered, and stops with Contabo's reason", async () => {
    const s = await setup();
    s.contabo.refused = "Contabo answered HTTP 400 to POST …/upgrade: Backup is not available";
    const error = await failure(
      syncProviderBackups(s.run, { wanted_backups: { server: wanted(APP_ID, true) } }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      `Contabo refused to turn on its automated backups of server ${APP_ID}, so nothing was turned on: Contabo answered HTTP 400 to POST …/upgrade: Backup is not available`,
    );
    expect(error.hint).toBe("Fix what Contabo named, then run `opscrew provision` again.");
    expect(await s.state(APP_ID)).toBeUndefined();
    expect(s.audited()).toEqual([["backups refused", `contabo server ${APP_ID}`]]);
  });

  it("keeps an order without a clear answer, and never sends it again", async () => {
    const s = await setup();
    s.contabo.error = new OpsCrewError("PROVIDER_ERROR", "Lost the connection to Contabo's API.");
    const outputs = { wanted_backups: { server: wanted(APP_ID, true) } };
    const error = await failure(syncProviderBackups(s.run, outputs));
    const file = providerBackupsFile(s.deps.paths, "contabo", APP_ID);
    const check = `Check the server in the Contabo Customer Control Panel. If its automated backups are on there, change "sent" to "on" in ${file}; if they are off, delete that file. Then run \`opscrew provision\` again.`;
    expect(error.message).toBe(
      `Turning on Contabo's automated backups of server ${APP_ID} got no clear answer (Lost the connection to Contabo's API), so they may be on. OpsCrew won't ask again.`,
    );
    expect(error.hint).toBe(check);
    expect(await s.state(APP_ID)).toBe("sent");
    expect(s.audited()).toEqual([["backups unclear", `contabo server ${APP_ID}`]]);

    s.contabo.error = undefined;
    await syncProviderBackups(s.run, outputs);
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.said().at(-1)).toBe(
      `warn: OpsCrew's request to turn on Contabo's automated backups of server ${APP_ID} got no clear answer, so it isn't sent again. ${check}`,
    );
  });

  it("says how to turn them off in the panel when the plan turns them off, and calls nothing", async () => {
    const s = await setup();
    await syncProviderBackups(s.run, { wanted_backups: { server: wanted(APP_ID, true) } });
    const off = { wanted_backups: { server: wanted(APP_ID, false) } };
    await syncProviderBackups(s.run, off);
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
    expect(s.said().at(-1)).toBe(
      `warn: The plan turns Contabo's automated backups of server ${APP_ID} off, but Contabo's API can't turn them off, so OpsCrew changed nothing. Cancel them in the Contabo Customer Control Panel: they stay on, and billed, until you do.`,
    );
    expect(await s.state(APP_ID)).toBeUndefined();
    expect(s.audited().at(-1)).toEqual(["backups left on", `contabo server ${APP_ID}`]);

    // Said once; a plan that turns them on again turns them on again.
    const lines = s.said().length;
    await syncProviderBackups(s.run, off);
    expect(s.said()).toHaveLength(lines);
    await syncProviderBackups(s.run, { wanted_backups: { server: wanted(APP_ID, true) } });
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`, `turnOn ${APP_ID}`]);
    expect(await s.state(APP_ID)).toBe("on");
  });

  it("stops plainly on a damaged record, sending nothing", async () => {
    const s = await setup();
    await syncProviderBackups(s.run, { wanted_backups: { server: wanted(APP_ID, true) } });
    const file = providerBackupsFile(s.deps.paths, "contabo", APP_ID);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
      provider: "contabo",
      serverId: APP_ID,
      state: "on",
    });
    await writeFile(file, "{");
    const error = await failure(
      syncProviderBackups(s.run, { wanted_backups: { server: wanted(APP_ID, true) } }),
    );
    expect(error.code).toBe("ARTIFACT_INVALID");
    expect(error.message).toContain(file);
    expect(s.contabo.calls).toEqual([`turnOn ${APP_ID}`]);
  });

  it("calls nothing for backups the plan never turned on", async () => {
    const s = await setup();
    await syncProviderBackups(s.run, { wanted_backups: { server: wanted(APP_ID, false) } });
    expect(s.contabo.calls).toEqual([]);
    expect(s.said()).toEqual([]);
  });
});
