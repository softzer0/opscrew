/**
 * End-to-end move with fakes (T509, US1–US4): a live Hetzner deployment of `shop` (Cloudflare DNS,
 * self-hosted Postgres) is moved to DigitalOcean through the real `opscrew retarget` command,
 * non-interactively: every stop prints a plan hash that the next run approves with
 * `--approve <hash>`, the maintenance window needs `--allow-downtime`, and `--finish` deletes the
 * old server with `--confirm shop` and the deletion plan's hash. A second project aborts before
 * the switch. No real engine, cloud, GitHub, server or network is reached.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readServerAddresses } from "@opscrew/agents";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { GIT, run } from "../../src/ui/__fixtures__/harness";
import {
  APP,
  DOMAIN,
  MOVE_TOKENS,
  type MoveProject,
  moveProject,
  NEW_SERVERS,
  OLD_IPV4,
} from "../../src/ui/__fixtures__/retarget";

const STEP_TIMEOUT = 120_000;
const NEW = NEW_SERVERS.digitalocean;

let move: MoveProject | undefined;
afterEach(async () => {
  await move?.project.cleanup();
  move = undefined;
});

/** Runs `opscrew retarget <args>` non-interactively and checks that no apply went unapproved. */
async function retarget(m: MoveProject, ...args: string[]) {
  const ctx = m.context();
  const appliedBefore = m.engine.applied.length;
  const code = await run(ctx, "retarget", ...args);
  const text = ctx.output + ctx.errors;
  const applied = m.engine.applied.slice(appliedBefore);
  // Constitution I: a scripted run applies at most the one plan it names with --approve.
  const approveAt = args.indexOf("--approve");
  const approved = approveAt >= 0 ? args[approveAt + 1] : undefined;
  for (const hash of applied) expect(hash, `${args.join(" ")} applied`).toBe(approved);
  expect(applied.length, `${args.join(" ")} applied`).toBeLessThanOrEqual(1);
  for (const token of Object.values(MOVE_TOKENS)) expect(text).not.toContain(token);
  const hash = /Plan hash \(SHA-256\): ([0-9a-f]{64})/.exec(ctx.output)?.[1];
  return { code, text, ctx, hash, applied };
}

const readPlan = (m: MoveProject): Promise<DeployPlan> => readArtifact("plan", m.paths.files.plan);

/** The servers' addresses in OpsCrew's local state (`.opscrew/server.json`). */
const localServers = (m: MoveProject) => readServerAddresses(m.paths);

/** Start → renamed → created/deployed → switch planned: three stops, each with a hash. */
async function moveUntilSwitchPlanned(m: MoveProject): Promise<string> {
  const start = await retarget(m, "--to", "digitalocean", "--yes");
  expect(start.code, start.text).toBe(1);
  expect(start.applied).toEqual([]);
  expect(start.text).toContain("Moving shop from Hetzner Cloud");
  expect(start.text).toContain(`opscrew retarget --approve ${start.hash}`);
  expect(start.text).toContain("Pass --yes again with that command.");
  let plan = await readPlan(m);
  expect(plan.target.provider).toBe("digitalocean");
  expect(plan.retarget).toMatchObject({
    step: "started",
    from: { target: { provider: "hetzner" } },
  });
  // The addresses are in the local state only, never in opscrew/plan.yaml.
  expect(await localServers(m)).toMatchObject({
    deployment: { ipv4: OLD_IPV4 },
    retarget: { from: { ipv4: OLD_IPV4 } },
  });
  expect(await readFile(m.paths.files.plan, "utf8")).not.toContain(OLD_IPV4);

  // The same command again without --approve applies nothing and stops at a plan again.
  const again = await retarget(m, "--yes");
  expect(again.code, again.text).toBe(1);
  expect(again.applied).toEqual([]);
  expect(again.hash).not.toBe(start.hash);

  // The superseded plan's hash is not applied: OpsCrew plans again and stops with a new hash.
  const stale = await retarget(m, "--approve", start.hash ?? "", "--yes");
  expect(stale.code, stale.text).toBe(1);
  expect(stale.applied).toEqual([]);
  expect(stale.text).toContain(`did not use --approve ${start.hash}`);
  expect((await readPlan(m)).retarget?.step).toBe("started");

  const renamed = await retarget(m, "--approve", stale.hash ?? "", "--yes");
  expect(renamed.code, renamed.text).toBe(1);
  expect(renamed.applied).toEqual([stale.hash]);
  expect(renamed.hash).toBeDefined();
  plan = await readPlan(m);
  expect(plan.retarget?.step).toBe("renamed");
  expect(m.engine.state.servers.server_previous?.provider).toBe("hetzner");

  const created = await retarget(m, "--approve", renamed.hash ?? "", "--yes");
  expect(created.code, created.text).toBe(1);
  expect(created.applied).toEqual([renamed.hash]);
  expect(created.text).toContain(`--allow-downtime --approve ${created.hash}`);
  plan = await readPlan(m);
  expect(plan.retarget).toMatchObject({ step: "deployed" });
  expect((await localServers(m)).retarget?.next?.ipv4).toBe(NEW.ipv4);
  expect(m.github.secrets.get("OPSCREW_HOST")).toBe(NEW.ipv4);
  // The old server still serves users; the new one waits with Caddy stopped.
  expect(m.hosts.host(OLD_IPV4)).toMatchObject({ app: true, caddy: true });
  expect(m.hosts.host(NEW.ipv4)).toMatchObject({ app: true, caddy: false });
  return created.hash ?? "";
}

describe.skipIf(GIT === undefined)("opscrew retarget (Hetzner Cloud → DigitalOcean)", () => {
  it(
    "moves a live deployment step by step with --approve, then finishes it",
    async () => {
      move = await moveProject();
      const m = move;
      const switchHash = await moveUntilSwitchPlanned(m);

      // The maintenance window needs --allow-downtime, even with the right hash.
      const noWindow = await retarget(m, "--approve", switchHash, "--yes");
      expect(noWindow.code, noWindow.text).toBe(1);
      expect(noWindow.applied).toEqual([]);
      expect(noWindow.text).toContain("--allow-downtime");
      expect(m.hosts.host(OLD_IPV4).app).toBe(true);

      const switched = await retarget(m, "--approve", switchHash, "--allow-downtime", "--yes");
      expect(switched.code, switched.text).toBe(0);
      expect(switched.applied).toEqual([switchHash]);
      expect(switched.text).toContain("allowed with --allow-downtime");
      expect(switched.text).toContain("opscrew retarget --finish");
      let plan = await readPlan(m);
      expect(plan.retarget?.step).toBe("switched");
      expect(plan.deployment).toMatchObject({ url: `https://${DOMAIN}` });
      expect((await localServers(m)).deployment?.ipv4).toBe(NEW.ipv4);
      expect(m.engine.dnsServer()?.ipv4).toBe(NEW.ipv4);
      expect(m.hosts.host(NEW.ipv4)).toMatchObject({ db: "orders before the move", app: true });
      expect(m.hosts.host(OLD_IPV4).app).toBe(false);

      // `opscrew status` shows the move and what to run next.
      const statusCtx = m.context();
      expect(await run(statusCtx, "status")).toBe(0);
      expect(statusCtx.output).toMatch(
        /retarget\s+moving from Hetzner Cloud to DigitalOcean; last completed step: switched .*opscrew retarget --finish/,
      );

      // After the switch there is no way back with --abort.
      const noAbort = await retarget(m, "--abort", "--confirm", APP);
      expect(noAbort.code, noAbort.text).toBe(1);
      expect(noAbort.text).toContain("can no longer be aborted");

      // A wrong --confirm stops before anything happens.
      const wrong = await retarget(m, "--finish", "--confirm", "shpo");
      expect(wrong.code).toBe(1);
      expect(wrong.text).toContain("does not match the app name");
      expect(m.events.filter((e) => e.type === "snapshot")).toEqual([]);

      // Finish: a snapshot, the protection lift and the deletion, each plan named by its hash.
      const unprotect = await retarget(m, "--finish", "--confirm", APP, "--yes");
      expect(unprotect.code, unprotect.text).toBe(1);
      expect(unprotect.text).toContain(`--finish --confirm shop --approve ${unprotect.hash}`);
      expect(m.events.filter((e) => e.type === "snapshot")).toEqual([
        { type: "snapshot", serverId: "4711" },
      ]);

      const destroy = await retarget(
        m,
        "--finish",
        "--confirm",
        APP,
        "--approve",
        unprotect.hash ?? "",
        "--yes",
      );
      expect(destroy.code, destroy.text).toBe(1);
      expect(destroy.applied).toEqual([unprotect.hash]);
      expect(m.engine.state.servers.server_previous?.protected).toBe(false);

      // The deletion plan's hash without --confirm is refused before anything happens.
      const unconfirmed = await retarget(m, "--finish", "--approve", destroy.hash ?? "", "--yes");
      expect(unconfirmed.code).toBe(1);
      expect(unconfirmed.applied).toEqual([]);
      expect(m.engine.state.servers.server_previous).toBeDefined();

      const finished = await retarget(
        m,
        "--finish",
        "--confirm",
        APP,
        "--approve",
        destroy.hash ?? "",
        "--yes",
      );
      expect(finished.code, finished.text).toBe(0);
      expect(finished.applied).toEqual([destroy.hash]);
      expect(finished.text).toContain("approved with --approve and --confirm");
      expect(m.engine.state.servers).toEqual({
        server: expect.objectContaining({ provider: "digitalocean", ipv4: NEW.ipv4 }),
      });
      plan = await readPlan(m);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target.provider).toBe("digitalocean");
      expect(await localServers(m)).toEqual({
        schemaVersion: 1,
        deployment: { ipv4: NEW.ipv4, ipv6: NEW.ipv6 },
      });
      const committed = await readFile(m.paths.files.plan, "utf8");
      for (const ip of [OLD_IPV4, NEW.ipv4]) expect(committed).not.toContain(ip);
      expect(m.github.pulls).toHaveLength(1);
      const knownHosts = await readFile(m.paths.files.knownHosts, "utf8");
      expect(knownHosts).not.toContain(OLD_IPV4);

      const after = m.context();
      expect(await run(after, "status")).toBe(0);
      expect(after.output).not.toContain("Move in progress");
      expect(after.output).toMatch(/retarget\s+ok/);
    },
    STEP_TIMEOUT,
  );

  it(
    "aborts a move before the switch and restores the Hetzner deployment",
    async () => {
      move = await moveProject();
      const m = move;
      await moveUntilSwitchPlanned(m);

      const statusCtx = m.context();
      expect(await run(statusCtx, "status")).toBe(0);
      expect(statusCtx.output).toMatch(
        /retarget\s+moving from Hetzner Cloud to DigitalOcean; last completed step: deployed .*opscrew retarget --abort/,
      );

      // Non-interactive aborts need --confirm with the app name.
      const bare = await retarget(m, "--abort");
      expect(bare.code).toBe(1);
      expect(bare.text).toContain("opscrew retarget --abort --confirm shop");
      expect(bare.text).not.toContain("This run is not interactive");
      expect(m.engine.applied).toHaveLength(2); // the rename and the new server only

      const removal = await retarget(m, "--abort", "--confirm", APP, "--yes");
      expect(removal.code, removal.text).toBe(1);
      expect(removal.applied).toEqual([]);
      expect(removal.text).toContain(`--abort --confirm shop --approve ${removal.hash}`);

      const removed = await retarget(
        m,
        "--abort",
        "--confirm",
        APP,
        "--approve",
        removal.hash ?? "",
        "--yes",
      );
      expect(removed.code, removed.text).toBe(1);
      expect(removed.applied).toEqual([removal.hash]);
      expect(m.engine.state.servers.server).toBeUndefined();
      expect(m.github.secrets.get("OPSCREW_HOST")).toBe(OLD_IPV4);

      const aborted = await retarget(
        m,
        "--abort",
        "--confirm",
        APP,
        "--approve",
        removed.hash ?? "",
        "--yes",
      );
      expect(aborted.code, aborted.text).toBe(0);
      expect(aborted.applied).toEqual([removed.hash]);
      expect(aborted.text).toContain("shop stays on Hetzner Cloud");
      expect(m.engine.state.servers).toEqual({
        server: expect.objectContaining({ provider: "hetzner", ipv4: OLD_IPV4 }),
      });
      const plan = await readPlan(m);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target).toEqual(m.plan.target);
      expect((await localServers(m)).deployment?.ipv4).toBe(OLD_IPV4);
      expect((await localServers(m)).retarget).toBeUndefined();
      expect(m.hosts.host(OLD_IPV4)).toMatchObject({ app: true, caddy: true });
      expect(existsSync(m.paths.files.plan)).toBe(true);
    },
    STEP_TIMEOUT,
  );
});
