import { findExecutable } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { readServerAddresses } from "../../shared";
import { type MoveHarness, moveHarness, NEW_SERVERS, OLD_IPV4, TOKENS } from "../../testing";
import { everythingPrinted, expectGated, run, trail } from "../__fixtures__/assert";
import { openSession } from "../session";
import { ABORT_COMMAND, FINISH_COMMAND, RUN_COMMAND } from "../texts";
import { cloudSide } from "./cloud";

const NEW = NEW_SERVERS.digitalocean;

/** The move's session as a command opens it, with `--approve <hash>` when given. */
async function open(h: MoveHarness, command: string, approve?: string) {
  return openSession(h.deps, await readArtifact("plan", h.paths.files.plan), {
    command,
    providers: ["hetzner", "digitalocean"],
    services: h.services,
    oldServerOptional: command === FINISH_COMMAND,
    ...(approve !== undefined ? { approvePlanHash: approve } : {}),
  });
}

/** A scripted move from Hetzner to DigitalOcean up to the plan that creates the new server. */
async function renamed(h: MoveHarness) {
  const first = await run(h);
  h.cli.approve = first.pendingPlanHash;
  const second = await run(h, { approvePlanHash: first.pendingPlanHash as string });
  expect(second).toMatchObject({ step: "renamed", done: false });
}

describe.skipIf(!findExecutable("git"))("a cloud side", () => {
  it("prepare creates the new server with its plan, approved by its hash", async () => {
    const h = await moveHarness({ interactive: false });
    await renamed(h);
    const mark = h.events.length;

    // A script without the plan's hash stops before the apply.
    const waiting = await cloudSide("new").prepare(await open(h, RUN_COMMAND));
    expect(waiting).toMatchObject({ step: "renamed", done: false });
    const hash = waiting?.pendingPlanHash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(trail(h.events.slice(mark))).toEqual([]);

    h.cli.approve = hash;
    const session = await open(h, RUN_COMMAND, hash);
    expect(await cloudSide("new").prepare(session)).toBeUndefined();
    expect(trail(h.events.slice(mark))).toEqual(["approve iac-apply", "apply creates=4"]);
    expectGated(h.events);
    expect(session.plan.retarget?.step).toBe("created");
    expect((await readServerAddresses(h.paths)).retarget?.next).toEqual({
      ipv4: NEW.ipv4,
      ipv6: NEW.ipv6,
    });
  });

  it("remove deletes only the new server at --abort, after the typed name", async () => {
    const h = await moveHarness({ interactive: false });
    await renamed(h);
    const create = await cloudSide("new").prepare(await open(h, RUN_COMMAND));
    h.cli.approve = create?.pendingPlanHash;
    await cloudSide("new").prepare(await open(h, RUN_COMMAND, create?.pendingPlanHash));
    h.deps.interactive = true;
    h.handler.answer = () => true;
    const mark = h.events.length;

    const session = await open(h, ABORT_COMMAND);
    expect(await cloudSide("new").remove(session, h.confirm)).toBeUndefined();
    const events = h.events.slice(mark);
    expect(trail(events)).toEqual(["confirm shop", "approve iac-apply", "apply deletes=4"]);
    expectGated(events, true);
    const deleted = events.flatMap((e) => (e.type === "apply" ? e.deletes : []));
    expect(deleted.every((address) => address.startsWith("module.server."))).toBe(true);
    // Again: nothing left to delete.
    expect(await cloudSide("new").remove(await open(h, ABORT_COMMAND), h.confirm)).toBeUndefined();
    expect(h.reporter.text()).toContain("There is no new Droplet to delete.");
  });

  it("remove deletes only the old server at --finish, after a snapshot and the typed name", async () => {
    const h = await moveHarness();
    await run(h);
    const mark = h.events.length;
    const session = await open(h, FINISH_COMMAND);
    expect(await cloudSide("old").remove(session, h.confirm)).toBeUndefined();
    const events = h.events.slice(mark);
    expect(trail(events)).toEqual([
      "confirm shop",
      "snapshot 4711",
      "approve iac-apply",
      "apply updates=1",
      "approve iac-apply",
      "apply deletes=3",
    ]);
    expectGated(events, true);
    const deleted = events.flatMap((e) => (e.type === "apply" ? e.deletes : []));
    expect(deleted.every((address) => address.startsWith("module.server_previous."))).toBe(true);
    const printed = everythingPrinted(h);
    for (const token of Object.values(TOKENS)) expect(printed).not.toContain(token);
  });

  it("skips the snapshot when the move says so, and waits for --approve in a script", async () => {
    const h = await moveHarness();
    await run(h);
    h.deps.interactive = false;
    const session = await open(h, FINISH_COMMAND);
    const stop = await cloudSide("old", { snapshot: false }).remove(session, h.confirm);
    expect(stop).toMatchObject({ step: "switched", done: false });
    expect(stop?.next.join(" ")).toContain("--confirm shop --no-snapshot --approve");
    expect(h.events.some((e) => e.type === "snapshot")).toBe(false);
    expect(h.reporter.text()).toContain("Skipping the snapshot, as requested.");
    expect(h.hosts.hosts.has(OLD_IPV4)).toBe(true);
  });
});
