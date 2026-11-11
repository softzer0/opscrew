/**
 * Offline checks of the Contabo live test's helpers: its variables, what it reads in outputs, a
 * failed step's wait for a fix, and its cleanup at Contabo against a fake API.
 */

import { join } from "node:path";
import { type FakeReply, fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CONTABO_VARIABLES,
  ContaboAccount,
  cancelTexts,
  contaboEnv,
  createsServer,
  dayText,
  designTexts,
  type FixWait,
  pauseMs,
  serverSnapshotId,
  shownEndDate,
  takeoverLines,
  unsaid,
  untilFixed,
} from "./contabo-support";
import { missingVariables } from "./support";

describe("the Contabo pass's variables", () => {
  it("passes the four test values to OpsCrew under Contabo's own names", () => {
    expect(
      contaboEnv({
        OPSCREW_E2E_CONTABO_CLIENT_ID: "client ",
        OPSCREW_E2E_CONTABO_CLIENT_SECRET: "secret",
        OPSCREW_E2E_CONTABO_USER: "user",
        OPSCREW_E2E_CONTABO_PASS: "pass",
      }),
    ).toEqual({
      CNTB_OAUTH2_CLIENT_ID: "client",
      CNTB_OAUTH2_CLIENT_SECRET: "secret",
      CNTB_OAUTH2_USER: "user",
      CNTB_OAUTH2_PASS: "pass",
    });
  });

  it("is skipped without its gate, naming every variable it misses", () => {
    expect(missingVariables({}, "OPSCREW_E2E_CONTABO", CONTABO_VARIABLES)).toEqual([
      "OPSCREW_E2E_CONTABO=1",
      "OPSCREW_E2E_CONTABO_CLIENT_ID",
      "OPSCREW_E2E_CONTABO_CLIENT_SECRET",
      "OPSCREW_E2E_CONTABO_USER",
      "OPSCREW_E2E_CONTABO_PASS",
      "OPSCREW_E2E_GITHUB_REPO",
      "OPSCREW_E2E_GITHUB_TOKEN",
      "OPSCREW_E2E_CLOUDFLARE_TOKEN",
      "OPSCREW_E2E_DOMAIN",
    ]);
  });
});

describe("what the pass reads in OpsCrew's output", () => {
  const app = "e2e-cntb-abc123";

  it("finds the texts design and destroy must say", () => {
    const design = [
      "▲ Contabo has no price API, so prices come from Contabo's published price list dated 2026-11-11 and are estimates.",
      "  Lean: V153 in Germany on Contabo (contabo-single-V153-EU): €5.50/month, estimate as of 2026-11-11",
    ].join("\n");
    expect(unsaid(design, designTexts("2026-11-11T00:00:00.000Z"))).toEqual([
      "Plus a one-time setup fee of",
      "The contract runs at least 1 month; a removal ends it at the end of the term.",
      "Contabo offers no automatic backups through OpsCrew",
    ]);
    const destroy = [
      `Contabo does not delete the server ${app} at once: it ends its contract at the end of its current term (1 month at least) and bills it until then.`,
      "OpsCrew shuts it down now and deletes the app's other resources (such as its DNS records, firewall and SSH key) at once.",
      "Its disk and its Contabo snapshots go when the term ends; until then you can start it again in the Contabo Customer Control Panel.",
      `◆ Shutting the server ${app} down`,
    ].join("\n");
    expect(unsaid(destroy, cancelTexts(app))).toEqual([]);
  });

  it("reads the end date destroy shows, as Contabo's date reads", () => {
    const output = `The Contabo server ${app} is cancelled: its contract ends on 10 December 2026, and Contabo bills it until then. Its disk goes then.`;
    expect(shownEndDate(output, app)).toBe("10 December 2026");
    expect(shownEndDate(output, "other")).toBeUndefined();
    expect(dayText("2026-12-10")).toBe("10 December 2026");
  });

  it("reads a whole-server snapshot's id, instance and snapshot", () => {
    expect(
      serverSnapshotId(
        `✓ Took the snapshot 202614:snap1628603855 of the server ${app} of prod at Contabo (included in the server's price).`,
      ),
    ).toBe("202614:snap1628603855");
    expect(serverSnapshotId("Took the snapshot 20261111T120000Z of prod on the server.")).toBe(
      undefined,
    );
  });

  it("tells a plan that buys a server from one that does not", () => {
    expect(createsServer("  + create  module.server.contabo_instance.this\n")).toBe(true);
    expect(createsServer("  ± replace module.server.contabo_instance.this\n")).toBe(true);
    expect(createsServer("  + create  module.server.contabo_firewall.this\n")).toBe(false);
    expect(createsServer("  ~ update  module.server.contabo_instance.this\n")).toBe(false);
  });

  it("finds provision's takeover and cancelled-server notes", () => {
    const output = [
      "Plan hash: 00",
      `Contabo has the server ${app} (id 1, running), which the infrastructure state lacks: an earlier apply created it but stopped before recording it. The plan takes it over with an import instead of buying another server; importing it changes nothing at Contabo.`,
      `Contabo has the server ${app} (id 2), which the infrastructure state lacks, cancelled until 2026-12-10. OpsCrew cannot take back a cancelled server, so the plan buys a new one.`,
    ].join("\n");
    expect(takeoverLines(output)).toHaveLength(2);
    expect(takeoverLines("Plan hash: 00")).toEqual([]);
  });
});

describe("the cleanup at Contabo", () => {
  const app = "e2e-cntb-abc123";
  const page = (data: unknown[]): FakeReply => ({
    body: { data, _pagination: { page: 1, totalPages: 1 } },
  });
  const instance = (instanceId: number, status: string, cancelDate = "", name = app) => ({
    instanceId,
    name: `vmi${instanceId}`,
    displayName: name,
    status,
    cancelDate,
  });
  const gone: FakeReply = { status: 204 };
  /** An account on a fake Contabo: nothing of the app unless `routes` says otherwise. */
  function account(routes: Record<string, FakeReply | FakeReply[]>) {
    const fake = fakeFetch(
      {
        "POST https://auth.contabo.com": { body: { access_token: "token", expires_in: 300 } },
        "GET /v1/compute/instances?": page([]),
        "GET /v1/tags": page([]),
        "GET /v1/firewalls": page([]),
        "GET /v1/secrets": page([]),
        ...routes,
      },
      { base: "https://api.contabo.com" },
    );
    const env = Object.fromEntries(
      ["CLIENT_ID", "CLIENT_SECRET", "USER", "PASS"].map((part) => [
        `CNTB_OAUTH2_${part}`,
        fakeSecret("generic-password", `cntb-${part}`),
      ]),
    );
    return { contabo: new ContaboAccount(env, fake.fetch), calls: fake.calls };
  }
  const requests = (calls: { method: string; path: string }[]) =>
    calls.map((call) => `${call.method} ${call.path.split("?")[0]}`);
  const log = () => undefined;

  it("shuts a server destroy did not cancel down, then cancels it", async () => {
    const { contabo, calls } = account({
      "GET /v1/compute/instances?": [
        page([instance(42, "running")]),
        page([instance(42, "stopped", "2026-12-10")]),
      ],
      "GET /v1/compute/instances/42/snapshots": page([]),
      "GET /v1/compute/instances/42": [
        { body: { data: [instance(42, "running")] } },
        { body: { data: [instance(42, "stopped")] } },
      ],
      "POST /v1/compute/instances/42/actions/shutdown": { body: {} },
      "POST /v1/compute/instances/42/cancel": { body: {} },
    });
    expect(await contabo.cleanUp(app, false, log)).toEqual([]);
    const made = requests(calls);
    const shutdown = made.indexOf("POST /v1/compute/instances/42/actions/shutdown");
    expect(shutdown).toBeGreaterThan(-1);
    expect(made.indexOf("POST /v1/compute/instances/42/cancel")).toBeGreaterThan(shutdown);
  });

  it("still deletes the SSH key and the tag when the firewalls cannot be listed", async () => {
    const { contabo, calls } = account({
      "GET /v1/firewalls": { status: 500, body: { message: "down" } },
      "GET /v1/secrets": [page([{ secretId: 5, name: `${app}-deploy` }]), page([])],
      "GET /v1/tags?page=1&size=100&name=": [
        page([{ tagId: 7, name: `opscrew-app:${app}` }]),
        page([]),
      ],
      "DELETE /v1/secrets/5": gone,
      "DELETE /v1/tags/7": gone,
    });
    const problems = await contabo.cleanUp(app, false, log);
    expect(requests(calls)).toEqual(
      expect.arrayContaining(["DELETE /v1/secrets/5", "DELETE /v1/tags/7"]),
    );
    expect(problems).toEqual([
      `delete the firewall ${app}-firewall: Contabo answered HTTP 500 to GET /v1/firewalls`,
      "check Contabo again: Contabo answered HTTP 500 to GET /v1/firewalls",
    ]);
  });

  it("names two servers of the app as a problem", async () => {
    const { contabo } = account({
      "GET /v1/compute/instances?": page([
        instance(42, "stopped", "2026-12-10"),
        instance(43, "stopped", "2026-12-10", `${app}-data`),
      ]),
      "GET /v1/compute/instances/4": page([]),
    });
    expect(await contabo.cleanUp(app, false, log)).toEqual([
      `Contabo has 2 servers of ${app} (ids 42, 43); the test must never buy a second one`,
    ]);
  });

  it("names what a finished destroy left, once deleted", async () => {
    const { contabo } = account({
      "GET /v1/secrets": [page([{ secretId: 5, name: `${app}-deploy` }]), page([])],
      "DELETE /v1/secrets/5": gone,
    });
    expect(await contabo.cleanUp(app, true, log)).toEqual([
      `destroy left the SSH key ${app}-deploy; the cleanup deleted it`,
    ]);
  });
});

describe("a failed step's wait for a fix", () => {
  const folder = join("work", "run");
  const retry = join(folder, "retry");
  const giveUp = join(folder, "give-up");

  /**
   * A wait on a fake clock that each sleep moves on, until `until`: `files` appear at their times,
   * and a removed file is gone. Returns the wait, the attempts made, the log and the files removed.
   */
  function fakeWait(until: number, files: Record<string, number> = {}) {
    let clock = 0;
    const removed: string[] = [];
    const lines: string[] = [];
    const wait: FixWait = {
      folder,
      until,
      log: (message) => lines.push(message),
      describe: (error) => (error instanceof Error ? error.message : String(error)),
      exists: async (path) => (files[path] ?? Number.POSITIVE_INFINITY) <= clock,
      remove: async (path) => {
        removed.push(path);
        files[path] = Number.POSITIVE_INFINITY;
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    };
    return { wait, lines, removed, clock: () => clock };
  }

  /** A step that fails until `passesOn`, noting each attempt's number. */
  function step(passesOn = Number.POSITIVE_INFINITY) {
    const attempts: number[] = [];
    const body = async (attempt: number) => {
      attempts.push(attempt);
      if (attempt < passesOn) throw new Error(`attempt ${attempt} broke`);
    };
    return { attempts, body };
  }

  it("reads the wait in hours, none when unset", () => {
    expect(pauseMs({})).toBe(0);
    expect(pauseMs({ OPSCREW_E2E_CONTABO_PAUSE_HOURS: " " })).toBe(0);
    expect(pauseMs({ OPSCREW_E2E_CONTABO_PAUSE_HOURS: "48" })).toBe(48 * 3_600_000);
    for (const value of ["-1", "two", "601"]) {
      expect(() => pauseMs({ OPSCREW_E2E_CONTABO_PAUSE_HOURS: value })).toThrow(
        `OPSCREW_E2E_CONTABO_PAUSE_HOURS="${value}" is not a number of hours from 0 to 600.`,
      );
    }
  });

  it("runs a step that passes once, without a word", async () => {
    const { wait, lines } = fakeWait(3_600_000);
    const { attempts, body } = step(1);
    await untilFixed(body, wait);
    expect(attempts).toEqual([1]);
    expect(lines).toEqual([]);
  });

  it("throws a failure at once when there is no time to wait", async () => {
    const { wait, lines } = fakeWait(0, { [retry]: 0 });
    const { attempts, body } = step(2);
    await expect(untilFixed(body, wait)).rejects.toThrow("attempt 1 broke");
    expect(attempts).toEqual([1]);
    expect(lines).toEqual([]);
  });

  it("runs the step again once the file retry appears, and deletes it", async () => {
    const { wait, lines, removed, clock } = fakeWait(3_600_000, { [retry]: 90_000 });
    const { attempts, body } = step(2);
    await untilFixed(body, wait);
    expect(attempts).toEqual([1, 2]);
    expect(removed).toEqual([retry]);
    expect(clock()).toBe(90_000);
    expect(lines[0]).toBe("attempt 1 failed: attempt 1 broke");
    expect(lines[1]).toContain("waiting for a fix until 1970-01-01T01:00:00.000Z");
    expect(lines[1]).toContain(`create ${retry} to run the step again, or ${giveUp} to end`);
    expect(lines[2]).toBe("running the step again (attempt 2)");
  });

  it("throws the last failure when the file give-up appears", async () => {
    const { wait } = fakeWait(3_600_000, { [retry]: 30_000, [giveUp]: 60_000 });
    const { attempts, body } = step();
    await expect(untilFixed(body, wait)).rejects.toThrow("attempt 2 broke");
    expect(attempts).toEqual([1, 2]);
  });

  it("throws the failure once the wait is over", async () => {
    const { wait, clock } = fakeWait(120_000);
    const { attempts, body } = step();
    await expect(untilFixed(body, wait)).rejects.toThrow("attempt 1 broke");
    expect(attempts).toEqual([1]);
    expect(clock()).toBe(120_000);
  });
});
