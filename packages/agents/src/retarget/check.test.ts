import { findExecutable } from "@opscrew/core";
import { CHECK_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type MoveHarness, moveHarness, OLD_IPV4 } from "../testing";
import { caught, crashAfter, moveOnDisk, run, trail } from "./__fixtures__/assert";
import { abortRetarget } from "./abort";
import { finishRetarget } from "./finish";

/** A move of `shop` with the scheduled check on. */
async function checkedMove(): Promise<MoveHarness> {
  const h = await moveHarness();
  const plan = await readArtifact("plan", h.paths.files.plan);
  await writeArtifact("plan", h.paths.files.plan, {
    ...plan,
    observability: { check: { enabled: true } },
  });
  return h;
}

const paused = (h: MoveHarness) => {
  const text = h.github.variables.get(CHECK_PAUSED_VARIABLE);
  return text === undefined ? undefined : JSON.parse(text);
};

/** The check's server secret as the move left it. */
const checkServer = (h: MoveHarness) => {
  const text = h.github.secrets.get("OPSCREW_CHECK_SERVER");
  return text === undefined ? undefined : JSON.parse(text);
};

describe.skipIf(!findExecutable("git"))("the scheduled check during a move", () => {
  it("is paused when the window opens, before the old app stops, and resumed at --finish", async () => {
    const h = await checkedMove();
    await run(h);
    // The check's reach of the server follows the deploy secrets to the new server.
    expect(checkServer(h)).toMatchObject({ host: h.newServer.ipv4, port: 22, user: "deploy" });
    const lines = trail(h.events);
    const pause = lines.indexOf("approve github-settings");
    expect(pause).toBeGreaterThan(lines.indexOf("approve remote-exec"));
    expect(pause).toBeLessThan(lines.indexOf(`${OLD_IPV4} stop app`));
    expect(paused(h)).toEqual({
      "shop/prod": { reason: "retarget", since: expect.any(String) },
    });

    await finishRetarget(h.deps, { services: h.services, confirm: h.confirm });
    expect(h.github.variables.has(CHECK_PAUSED_VARIABLE)).toBe(false);
  });

  it("is resumed by an abort", async () => {
    const h = await checkedMove();
    crashAfter(h, "migrated");
    await expect(run(h)).rejects.toThrow("interrupted");
    expect(paused(h)).toHaveProperty("shop/prod");
    expect(checkServer(h)?.host).toBe(h.newServer.ipv4);
    await abortRetarget(h.deps, { services: h.services, confirm: h.confirm });
    expect(h.github.variables.has(CHECK_PAUSED_VARIABLE)).toBe(false);
    // And back to the old server.
    expect(checkServer(h)).toMatchObject({ host: OLD_IPV4, port: 22, user: "deploy" });
  });

  it("stops before the window, with the old app running, when the pause is declined", async () => {
    const h = await checkedMove();
    const answer = h.handler.answer;
    h.handler.answer = (request) => request.kind !== "github-settings" && answer(request);
    const error = await caught(run(h));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("The scheduled check was not paused");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect((await moveOnDisk(h))?.oldAppStoppedAt).toBeUndefined();
    expect(h.github.variables.size).toBe(0);
  });
});
