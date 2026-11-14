import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Registrar } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { connectProject, OLD_DS, RUN_NOW, TOKEN, visibleText } from "../testing";
import { dsWaitStatus, readDs, removeDsAndWait } from "./connect-ds";

const DOMAIN = "example.com";
const ZONE = "zone-b";
const SECOND_DS = { keyTag: 2371, algorithm: 13, digestType: 2, digest: "ABCDEF0123" };

async function caught(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** example.com at Porkbun with an old DS record; the public DNS's copy has an hour left. */
async function porkbunWithDs(now = RUN_NOW) {
  const cp = await connectProject();
  const pb = cp.other("porkbun");
  pb.own(DOMAIN);
  pb.dsRecords.set(DOMAIN, [{ ...OLD_DS }]);
  cp.dns.ds.set(DOMAIN, { records: [{ ...OLD_DS }, { ...SECOND_DS }], ttl: 3600 });
  const run = await cp.run({ now });
  const registrar = run.services.registrars?.porkbun as Registrar;
  const stateFile = join(run.deps.paths.root, ".opscrew", "cloudflare-move-ds.json");
  return { cp, pb, deps: run.deps, registrar, stateFile };
}

describe("readDs", () => {
  it("combines what the registrar's API lists with what the public DNS shows", async () => {
    const { cp, deps, registrar } = await porkbunWithDs();

    const ds = await readDs({ deps, domain: DOMAIN, registrar });

    expect(ds).toEqual({
      api: [OLD_DS],
      public: [OLD_DS, SECOND_DS],
      records: [OLD_DS, SECOND_DS],
      ttlSeconds: 3600,
      at: new Date(RUN_NOW),
    });
    expect(cp.project.cf.events).toEqual([`porkbun listDsRecords ${DOMAIN}`, `dns DS ${DOMAIN}`]);
  });

  it("reads only the public DNS without a registrar OpsCrew drives", async () => {
    const { cp, deps } = await porkbunWithDs();

    const ds = await readDs({ deps, domain: DOMAIN });

    expect(ds.api).toBeUndefined();
    expect(ds.records).toEqual([OLD_DS, SECOND_DS]);
    expect(cp.project.cf.events).toEqual([`dns DS ${DOMAIN}`]);
  });
});

describe("removeDsAndWait and dsWaitStatus", () => {
  it("removes the listed DS records, notes the wait in the given file and audits each removal", async () => {
    const { cp, pb, deps, registrar, stateFile } = await porkbunWithDs();
    expect(await dsWaitStatus(stateFile, new Date(RUN_NOW))).toBeUndefined();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });

    const note = await removeDsAndWait(
      {
        deps,
        domain: DOMAIN,
        registrarId: "porkbun",
        registrar,
        state: undefined,
        ds,
        zoneId: ZONE,
      },
      stateFile,
    );

    // 24 hours after the public copy expires (13:00), plus an hour after a removal.
    const written = {
      domain: DOMAIN,
      registrar: "porkbun",
      zoneId: ZONE,
      switchAfter: "2026-10-12T14:00:00.000Z",
      waitSeconds: 86400,
    };
    expect(note).toEqual(written);
    expect(JSON.parse(await readFile(stateFile, "utf8"))).toEqual(written);
    expect(pb.dsRecords.get(DOMAIN)).toEqual([]);
    expect(cp.project.cf.events.at(-1)).toBe(`porkbun removeDsRecord ${DOMAIN} 4012`);
    expect(deps.audit.entries.map((e) => [e.action, e.detail])).toEqual([
      [
        "remove DS record",
        `Porkbun: key tag 4012 (algorithm 8, digest type 2), before switching to zone ${ZONE}`,
      ],
    ]);

    expect(await dsWaitStatus(stateFile, new Date("2026-10-12T13:59:59.000Z"))).toEqual({
      waiting: true,
      switchAfter: "2026-10-12T14:00:00.000Z",
      waitSeconds: 86400,
    });
    expect(await dsWaitStatus(stateFile, new Date("2026-10-12T14:00:00.000Z"))).toMatchObject({
      waiting: false,
    });
    expect(visibleText(deps)).not.toContain(TOKEN);
  });

  it("never moves an earlier run's switch time earlier or shortens its wait", async () => {
    const { deps, registrar, stateFile } = await porkbunWithDs();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });
    const state = {
      domain: DOMAIN,
      registrar: "porkbun" as const,
      switchAfter: "2026-10-14T00:00:00.000Z",
      waitSeconds: 172800,
    };

    const note = await removeDsAndWait(
      { deps, domain: DOMAIN, registrarId: "porkbun", registrar, state, ds, zoneId: ZONE },
      stateFile,
    );

    expect(note).toMatchObject({ switchAfter: "2026-10-14T00:00:00.000Z", waitSeconds: 172800 });
  });

  it("stops before any change when the registrar's API cannot remove the records", async () => {
    const { cp, pb, deps, stateFile } = await porkbunWithDs();
    // Porkbun's API as it lists DS records, without the call that removes them
    const registrar = pb.api();
    const ds = await readDs({ deps, domain: DOMAIN, registrar });

    const error = await caught(
      removeDsAndWait(
        {
          deps,
          domain: DOMAIN,
          registrarId: "porkbun",
          registrar,
          state: undefined,
          ds,
          zoneId: ZONE,
        },
        stateFile,
      ),
    );

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "Porkbun's API cannot remove the DNSSEC (DS) records of example.com. Nothing was changed.",
    );
    expect(error.hint).toContain("key tag 4012");
    expect(cp.project.cf.events.some((e) => e.includes("removeDsRecord"))).toBe(false);
    expect(await dsWaitStatus(stateFile, new Date(RUN_NOW))).toBeUndefined();
    expect(deps.audit.entries).toEqual([]);
  });

  it("waits while a note has seen old records but noted no switch time, and stops on an unreadable note", async () => {
    const { stateFile } = await porkbunWithDs();
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify({ domain: DOMAIN, registrar: "porkbun", dsSeen: RUN_NOW, waitSeconds: 86400 }),
    );
    expect(await dsWaitStatus(stateFile, new Date("2030-01-01T00:00:00.000Z"))).toEqual({
      waiting: true,
      waitSeconds: 86400,
    });

    await writeFile(stateFile, "{");
    const error = await caught(dsWaitStatus(stateFile, new Date(RUN_NOW)));
    expect(error.code).toBe("PHASE_PRECONDITION");
  });
});
