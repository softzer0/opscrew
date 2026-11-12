/**
 * A move to or from Contabo, whose firewall its connector applies after the apply (ADR 0029, D8):
 * the new server's firewall is set once the apply that creates it is done, and the firewall of the
 * server `--finish` or `--abort` removes is deleted after the apply that removes it.
 */
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { type MoveEvent, type MoveHarness, moveHarness, NEW_SERVERS, OLD_IDS } from "../testing";
import { caught, crashAfter, expectGated, run } from "./__fixtures__/assert";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";

const FIREWALL = "shop-firewall";

/** The applies (with what they create or delete) and the firewall calls, in order. */
function firewallTrail(events: readonly MoveEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type === "firewall") return [event.op];
    if (event.type !== "apply") return [];
    const creates = event.creates.some((a) => a.endsWith(".terraform_data.firewall"));
    const deletes = event.deletes.some((a) => a.endsWith(".terraform_data.firewall"));
    return [creates ? "apply creating it" : deletes ? "apply deleting it" : "apply"];
  });
}

function finish(h: MoveHarness) {
  return finishRetarget(h.deps, { services: h.services, confirm: h.confirm });
}

function abort(h: MoveHarness) {
  return abortRetarget(h.deps, { services: h.services, confirm: h.confirm });
}

describe.skipIf(!findExecutable("git"))("a move and Contabo's firewall", () => {
  it("sets the new server's firewall after the apply that creates it, and the abort deletes it after the apply that cancels the server", async () => {
    const h = await moveHarness({ to: "contabo" });
    crashAfter(h, "created");
    await expect(run(h)).rejects.toThrow("interrupted");
    const created = firewallTrail(h.events);
    expect(created.slice(created.indexOf("apply creating it"))).toEqual([
      "apply creating it",
      `sync ${FIREWALL}`,
    ]);
    expect(h.firewalls.firewalls.get(FIREWALL)?.serverIds).toEqual([NEW_SERVERS.contabo.id]);
    const mark = h.events.length;

    await abort(h);
    expectGated(h.events, true);
    // The new server is shut down, then cancelled with its other resources; its firewall goes.
    expect(h.poweredOff).toEqual([NEW_SERVERS.contabo.id]);
    expect(firewallTrail(h.events.slice(mark))).toEqual([
      "apply deleting it",
      `remove ${FIREWALL}`,
      "apply",
    ]);
    expect(h.firewalls.firewalls.size).toBe(0);
    expect(h.audit.entries.filter((e) => e.kind === "provider-call")).toContainEqual(
      expect.objectContaining({
        action: "delete firewall",
        phase: "retarget",
        target: `contabo firewall ${FIREWALL}`,
      }),
    );
    expect(h.reporter.text()).toContain(`success: Deleted Contabo's firewall ${FIREWALL}.`);
  });

  it("finishing a move off Contabo deletes the old server's firewall after the apply that cancels it", async () => {
    const h = await moveHarness({ from: "contabo" });
    await run(h);
    // The old server keeps its firewall while the move runs: each apply leaves it as it is.
    expect(h.firewalls.calls.every((call) => call === `sync ${FIREWALL}`)).toBe(true);
    expect(h.firewalls.firewalls.get(FIREWALL)?.serverIds).toEqual([OLD_IDS.contabo]);
    const mark = h.events.length;

    await finish(h);
    expect(h.poweredOff).toEqual([OLD_IDS.contabo]);
    expect(firewallTrail(h.events.slice(mark))).toEqual([
      "apply deleting it",
      `remove ${FIREWALL}`,
    ]);
    expect(h.firewalls.firewalls.size).toBe(0);
  });

  it("stops after the apply when the new server's firewall cannot be set; the next run sets it", async () => {
    const h = await moveHarness({ to: "contabo" });
    h.firewalls.syncError = new OpsCrewError("PROVIDER_ERROR", "Contabo answered 503.");
    const error = await caught(run(h));
    expect(error.message).toBe(
      `Setting Contabo's firewall ${FIREWALL} failed: Contabo answered 503. The server may not be protected yet.`,
    );
    expect(error.hint).toBe(
      "Run `opscrew retarget` again: it plans nothing new and sets the firewall again.",
    );
    expect(firewallTrail(h.events).slice(-2)).toEqual(["apply creating it", `sync ${FIREWALL}`]);
    const mark = h.events.length;

    h.firewalls.syncError = undefined;
    await run(h);
    // Nothing new to apply for the new server: its firewall is set first.
    expect(firewallTrail(h.events.slice(mark))[0]).toBe(`sync ${FIREWALL}`);
    expect(h.firewalls.firewalls.get(FIREWALL)?.serverIds).toEqual([NEW_SERVERS.contabo.id]);
  });
});
