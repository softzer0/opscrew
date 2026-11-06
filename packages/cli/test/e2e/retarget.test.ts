/**
 * End-to-end move with fakes (T509, US1–US4): a live Hetzner deployment of `shop` (Cloudflare DNS,
 * self-hosted Postgres) is moved to DigitalOcean through the real `opscrew retarget` command,
 * non-interactively: every stop prints a plan hash that the next run approves with
 * `--approve <hash>`, the maintenance window needs `--allow-downtime`, and `--finish` deletes the
 * old server with `--confirm shop` and the deletion plan's hash. A second project aborts before
 * the switch. No real engine, cloud, GitHub, server or network is reached.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import {
  APP,
  DOMAIN,
  NEW_SERVERS,
  OLD_IPV4,
  PORTAINER_CERT,
  PORTAINER_TOKEN,
  PORTAINER_URL,
  SITE_MOVE,
  TOKENS,
} from "@opscrew/agents/testing";
import { tfstateFile } from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { GIT, git, run } from "../../src/ui/__fixtures__/harness";
import {
  BUCKET_KEYS,
  HOST_KEY_FINGERPRINT,
  type MoveProject,
  moveProject,
  OWN_NEW_IPV4,
  PORTAINER_IPV4,
  REPO_READ_TOKEN,
  type SiteMoveProject,
  siteMoveProject,
} from "../../src/ui/__fixtures__/retarget";

const STEP_TIMEOUT = 120_000;
const NEW = NEW_SERVERS.digitalocean;
const BUCKET = "shop-uploads";

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
  for (const token of Object.values(TOKENS)) expect(text).not.toContain(token);
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

/** A side of the moves below: a cloud provider, the user's own server, their Portainer. */
type Side = "hetzner" | "digitalocean" | "own" | "portainer";

/**
 * Runs `opscrew retarget <first>` and then, while it stops, the printed command again with
 * `then`: with the plan's `--approve <hash>` at a plan, or once the user merged the deploy
 * workflow's pull request for the new side (here: its branch pushed to main). It stops early when
 * `until` holds for a run's text. Returns the last run and every run's text.
 */
async function approveEach(
  m: MoveProject,
  first: string[],
  then: string[],
  until: (text: string) => boolean = () => false,
) {
  let last = await retarget(m, ...first);
  const texts = [last.text];
  for (let i = 0; last.code === 1 && !until(last.text) && i < 12; i++) {
    const branch = /Committed the deployment files on branch (\S+?)\./.exec(last.text)?.[1];
    if (last.hash === undefined && branch !== undefined) {
      await git(m.project.env, m.project.root, "push", "-q", m.project.bare, `${branch}:main`);
      last = await retarget(m, ...then);
    } else {
      expect(last.hash, last.text).toBeDefined();
      last = await retarget(m, ...then, "--approve", last.hash ?? "");
    }
    texts.push(last.text);
  }
  return { last, text: texts.join("\n") };
}

/** The flags that start a move to `to` in a script: the new side's answers from files. */
async function startFlags(m: MoveProject, to: Side): Promise<string[]> {
  const file = path.join(m.project.dir, `${to}.yaml`);
  switch (to) {
    case "own":
      await writeFile(
        file,
        [
          `server.host: ${OWN_NEW_IPV4}`,
          "server.user: root",
          "server.key: agent",
          "server.reachable: yes",
          "server.serve: dns-only",
          "",
        ].join("\n"),
      );
      return ["--to", "own", "--answers", file, "--host-key", HOST_KEY_FINGERPRINT, "--yes"];
    case "portainer":
      await writeFile(
        file,
        [
          `portainer.url: ${PORTAINER_URL}`,
          "portainer.environment: local",
          "portainer.redeploy: updater",
          "portainer.web: caddy",
          "",
        ].join("\n"),
      );
      return [
        "--to",
        "portainer",
        "--answers",
        file,
        "--portainer-cert",
        PORTAINER_CERT.fingerprint,
        "--portainer-address",
        PORTAINER_IPV4,
        "--public-image",
        "--yes",
      ];
    default:
      return ["--to", to, "--option", "digitalocean-single-s-1vcpu-2gb-fra1", "--yes"];
  }
}

/** The flags every later run of a move to `to` repeats (`--public-image` for Portainer). */
const continueFlags = (to: Side) => [...(to === "portainer" ? ["--public-image"] : []), "--yes"];

/** Where DNS points once the move switched, and where the database's data lands. */
const NEW_SIDE: Record<Side, { address: string; data: string }> = {
  hetzner: { address: NEW_SERVERS.hetzner.ipv4, data: NEW_SERVERS.hetzner.ipv4 },
  digitalocean: { address: NEW.ipv4, data: NEW.ipv4 },
  own: { address: OWN_NEW_IPV4, data: OWN_NEW_IPV4 },
  portainer: { address: PORTAINER_IPV4, data: "portainer" },
};

/** The secrets a run must never print or commit, nor the user's addresses. */
async function expectNoLeak(m: MoveProject, text: string, from: Side) {
  for (const secret of [PORTAINER_TOKEN, REPO_READ_TOKEN, ...Object.values(TOKENS)]) {
    expect(text).not.toContain(secret);
  }
  // The user's own servers and Portainer host, never printed (a server OpsCrew created may be).
  for (const ip of [OWN_NEW_IPV4, PORTAINER_IPV4, ...(from === "hetzner" ? [] : [OLD_IPV4])]) {
    expect(text).not.toContain(ip);
  }
  expect(text).not.toContain(new URL(PORTAINER_URL).hostname);
  const committed = await readFile(m.paths.files.plan, "utf8");
  for (const ip of [OLD_IPV4, OWN_NEW_IPV4, PORTAINER_IPV4]) expect(committed).not.toContain(ip);
}

/** The applies the user's server at `ip` received, by purpose. */
const hostApplies = (m: MoveProject, ip: string) =>
  m.ownHosts.get(ip)?.applies.map((apply) => apply.plan.purpose);

/** The Portainer requests that changed something (never the environment itself). */
const portainerChanges = (m: MoveProject) => m.portainerApi.mutations();

/** Whether a request changed the Portainer environment itself (its volumes and stacks aside). */
const environmentChanged = (m: MoveProject) =>
  portainerChanges(m).some((call) => /^\S+ \/api\/endpoints\/\d+(\?|$)/.test(call));

/** `opscrew retarget --finish`: a script with the app name, each plan approved by its hash. */
const finishFlags = (from: Side) => [
  "--finish",
  "--confirm",
  APP,
  ...(from === "hetzner" ? ["--no-snapshot"] : []),
  "--yes",
];

describe.skipIf(GIT === undefined)("opscrew retarget between every kind of side", () => {
  it.each([
    ["hetzner", "own", "Hetzner Cloud", "your own server"],
    ["own", "digitalocean", "your own server", "DigitalOcean"],
    ["hetzner", "portainer", "Hetzner Cloud", "your Portainer"],
    ["portainer", "digitalocean", "your Portainer", "DigitalOcean"],
    ["own", "own", "your own server", "your own server"],
    ["own", "portainer", "your own server", "your Portainer"],
    ["portainer", "own", "your Portainer", "your own server"],
  ] as const)(
    "moves from %s to %s with the data, switches, then removes only what the old side held",
    async (from, to, fromWords, toWords) => {
      move = await moveProject({ from });
      const m = move;
      const moved = await approveEach(m, await startFlags(m, to), [
        "--allow-downtime",
        ...continueFlags(to),
      ]);
      expect(moved.last.code, moved.text).toBe(0);
      expect(moved.text).toContain("Db's data at /var/lib/postgresql/data:");
      const plan = await readPlan(m);
      expect(plan.target.provider).toBe(to);
      expect(plan.retarget?.step).toBe("switched");
      expect(m.engine.dnsServer()?.ipv4).toBe(NEW_SIDE[to].address);
      expect(m.hosts.host(NEW_SIDE[to].data).db).toBe("orders before the move");
      // The user's new server was set up by an approved host plan, never created.
      if (to === "own") expect(hostApplies(m, OWN_NEW_IPV4)).toEqual(["setup"]);

      const status = m.context();
      expect(await run(status, "status")).toBe(0);
      expect(status.output).toContain(
        `retarget  moving from ${fromWords} to ${toWords}; last completed step: switched`,
      );

      const ownBefore = hostApplies(m, OLD_IPV4);
      const portainerBefore = portainerChanges(m).length;
      const unchanged = () => {
        expect(hostApplies(m, OLD_IPV4)).toEqual(ownBefore);
        expect(portainerChanges(m)).toHaveLength(portainerBefore);
      };
      const shown = await retarget(m, ...finishFlags(from));
      // Without the deletion's hash, or with another one, nothing is removed: the plan again.
      if (from !== "hetzner") {
        expect(shown.hash, shown.text).toBeDefined();
        const other = await retarget(m, ...finishFlags(from), "--approve", "c".repeat(64));
        expect(other.code, other.text).toBe(1);
        expect(other.hash).toBe(shown.hash);
        const noConfirm = await retarget(m, "--finish", "--approve", shown.hash ?? "", "--yes");
        expect(noConfirm.code).toBe(1);
        expect(noConfirm.applied).toEqual([]);
        unchanged();
      }
      const finished = await approveEach(
        m,
        [...finishFlags(from), ...(shown.hash === undefined ? [] : ["--approve", shown.hash])],
        finishFlags(from),
      );
      expect(finished.last.code, finished.text).toBe(0);
      expect((await readPlan(m)).retarget).toBeUndefined();
      if (from === "hetzner") expect(m.engine.state.servers).toEqual({});
      if (from !== "hetzner")
        expect(finished.text).toContain("approved with --approve and --confirm");
      // Only the app goes from the user's server: a teardown host plan, never the server.
      if (from === "own") expect(hostApplies(m, OLD_IPV4)).toEqual(["teardown"]);
      // Only the app's stacks go from Portainer, never its environment.
      if (from === "portainer") {
        expect(environmentChanged(m)).toBe(false);
        expect(portainerChanges(m)).toContain("DELETE /api/stacks/7?endpointId=3");
      }
      await expectNoLeak(m, `${shown.text}\n${moved.text}\n${finished.text}`, from);
    },
    STEP_TIMEOUT,
  );

  it.each(["own", "portainer"] as const)(
    "aborts a move from Hetzner Cloud to %s before the switch: only the app is removed there",
    async (to) => {
      move = await moveProject();
      const m = move;
      // Stopped at the maintenance window, which needs --allow-downtime.
      const started = await approveEach(m, await startFlags(m, to), continueFlags(to), (text) =>
        text.includes("--allow-downtime --approve"),
      );
      expect(started.last.code, started.text).toBe(1);
      expect((await readPlan(m)).retarget?.step).toBe("deployed");

      // The flags a move's start uses are ignored once it is recorded, saying so.
      const again = await retarget(
        m,
        ...(to === "own"
          ? ["--host-key", HOST_KEY_FINGERPRINT]
          : ["--portainer-address", PORTAINER_IPV4]),
        ...continueFlags(to),
      );
      expect(again.text).toContain(
        `Only a move's start uses ${to === "own" ? "--host-key" : "--portainer-address"}; the move to ${to === "own" ? "your own server" : "your Portainer"} continues as it started.`,
      );

      const abort = ["--abort", "--confirm", APP, "--yes"];
      const aborted = await approveEach(m, abort, abort);
      expect(aborted.last.code, aborted.text).toBe(0);
      const plan = await readPlan(m);
      expect(plan.retarget).toBeUndefined();
      expect(plan.target.provider).toBe("hetzner");
      expect(m.engine.state.servers.server?.provider).toBe("hetzner");
      expect(m.hosts.host(OLD_IPV4)).toMatchObject({ app: true, caddy: true });
      if (to === "own") expect(hostApplies(m, OWN_NEW_IPV4)).toEqual(["setup", "teardown"]);
      if (to === "portainer") {
        expect(aborted.text).toContain("approved with --approve and --confirm");
        expect(environmentChanged(m)).toBe(false);
        expect(portainerChanges(m)).toContain("DELETE /api/stacks/101?endpointId=3");
      }
      await expectNoLeak(m, `${started.text}\n${again.text}\n${aborted.text}`, "hetzner");
    },
    STEP_TIMEOUT,
  );
});

describe.skipIf(GIT === undefined)("opscrew retarget with the app's bucket", () => {
  const keys = [...Object.values(BUCKET_KEYS.old), ...Object.values(BUCKET_KEYS.new)];
  const finish = (...confirms: string[]) => [
    "--finish",
    ...confirms.flatMap((name) => ["--confirm", name]),
    "--no-snapshot",
    "--yes",
  ];

  it(
    "moves the bucket from Hetzner to DigitalOcean with the app, then deletes the old one after its own name",
    async () => {
      move = await moveProject({ bucket: true });
      const m = move;
      const moved = await approveEach(m, await startFlags(m, "digitalocean"), [
        "--allow-downtime",
        "--yes",
      ]);
      expect(moved.last.code, moved.text).toBe(0);
      expect((await readPlan(m)).storage?.objectStorage?.provider).toBe("digitalocean");
      // Every file reached the new bucket, copied by rclone on the new server.
      expect([...m.rclone.next.keys()].sort()).toEqual(["a.png", "b.png", "c.pdf"]);

      // The app's name alone takes the move up to the bucket's deletion, which stops for its name.
      const toBucket = await approveEach(m, finish(APP), finish(APP), (text) =>
        text.includes(`--confirm ${BUCKET}`),
      );
      expect(toBucket.last.code, toBucket.text).toBe(1);
      expect(toBucket.text).toContain(`--confirm ${BUCKET}`);
      const hash = toBucket.last.hash ?? "";
      // With its hash but without its name, nothing is deleted.
      const unnamed = await retarget(m, ...finish(APP), "--approve", hash);
      expect(unnamed.code).toBe(1);
      expect(unnamed.applied).toEqual([]);
      // A name that is no bucket of the move, nor the app's, is refused before anything runs.
      const wrong = await retarget(m, ...finish(APP, "shop-uplaods"), "--approve", hash);
      expect(wrong.code).toBe(1);
      expect(wrong.text).toContain("--confirm shop-uplaods does not match");

      const finished = await approveEach(
        m,
        [...finish(APP, BUCKET), "--approve", hash],
        finish(APP, BUCKET),
      );
      expect(finished.last.code, finished.text).toBe(0);
      expect(finished.text).toContain("approved with --approve and --confirm");
      expect((await readPlan(m)).retarget).toBeUndefined();
      const text = `${moved.text}\n${toBucket.text}\n${finished.text}`;
      for (const key of keys) expect(text).not.toContain(key);
    },
    STEP_TIMEOUT,
  );

  it(
    "aborts before the switch, deleting the new bucket only after its own name",
    async () => {
      move = await moveProject({ bucket: true });
      const m = move;
      const started = await approveEach(m, await startFlags(m, "digitalocean"), ["--yes"], (text) =>
        text.includes("--allow-downtime --approve"),
      );
      expect((await readPlan(m)).retarget?.step, started.text).toBe("deployed");
      const abort = (...confirms: string[]) => [
        "--abort",
        ...confirms.flatMap((name) => ["--confirm", name]),
        "--yes",
      ];
      const toBucket = await approveEach(m, abort(APP), abort(APP), (text) =>
        text.includes(`--confirm ${BUCKET}`),
      );
      expect(toBucket.last.code, toBucket.text).toBe(1);
      const aborted = await approveEach(
        m,
        [...abort(APP, BUCKET), "--approve", toBucket.last.hash ?? ""],
        abort(APP, BUCKET),
      );
      expect(aborted.last.code, aborted.text).toBe(0);
      const plan = await readPlan(m);
      expect(plan.retarget).toBeUndefined();
      expect(plan.storage?.objectStorage?.provider).toBe("hetzner");
    },
    STEP_TIMEOUT,
  );

  it(
    "with --keep-bucket leaves the bucket where it is, and finishes with the app's name alone",
    async () => {
      move = await moveProject({ bucket: true });
      const m = move;
      const moved = await approveEach(
        m,
        [...(await startFlags(m, "digitalocean")), "--keep-bucket"],
        ["--allow-downtime", "--yes"],
      );
      expect(moved.last.code, moved.text).toBe(0);
      expect((await readPlan(m)).storage?.objectStorage?.provider).toBe("hetzner");
      expect(m.rclone.runs).toEqual([]);
      const finished = await approveEach(m, finish(APP), finish(APP));
      expect(finished.last.code, finished.text).toBe(0);
      expect(finished.text).not.toContain(`--confirm ${BUCKET}`);
      expect((await readPlan(m)).storage?.objectStorage?.provider).toBe("hetzner");
    },
    STEP_TIMEOUT,
  );

  it("refuses --keep-bucket for a site host, the user's own server or Portainer", async () => {
    move = await moveProject({ bucket: true });
    const m = move;
    for (const to of ["own", "portainer", "github-pages"]) {
      const refused = await retarget(m, "--to", to, "--keep-bucket");
      expect(refused.code).toBe(2);
      expect(refused.text).toContain(`--keep-bucket does not apply to a move to ${to}.`);
    }
    expect((await readPlan(m)).retarget).toBeUndefined();
  });
});

/** Runs `opscrew retarget <args>` in the site's project, non-interactively. */
async function siteRun(s: SiteMoveProject, ...args: string[]) {
  const ctx = s.context();
  const code = await run(ctx, "retarget", ...args);
  const text = ctx.output + ctx.errors;
  for (const secret of [SITE_MOVE.CF_TOKEN, SITE_MOVE.GITHUB_TOKEN, SITE_MOVE.API_KEY]) {
    expect(text).not.toContain(secret);
  }
  const hash = /Plan hash \(SHA-256\): ([0-9a-f]{64})/.exec(ctx.output)?.[1];
  return { code, text, hash };
}

/**
 * A site's move run like a script: `first`, then `then` again at each stop, with the plan's
 * `--approve <hash>`, or once the deploy setup's pull request is merged.
 */
async function siteSteps(s: SiteMoveProject, first: string[], then: string[]) {
  let last = await siteRun(s, ...first);
  const texts = [last.text];
  for (let i = 0; last.code === 1 && i < 12; i++) {
    if (last.hash === undefined && last.text.includes("Merge https://github.com/")) {
      await s.merge();
      last = await siteRun(s, ...then);
    } else {
      expect(last.hash, last.text).toBeDefined();
      last = await siteRun(s, ...then, "--approve", last.hash ?? "");
    }
    texts.push(last.text);
  }
  return { last, text: texts.join("\n") };
}

describe.skipIf(GIT === undefined)("opscrew retarget for a site between site hosts", () => {
  const SITE = "example-app";
  const { DOMAIN: SITE_DOMAIN, VERIFICATION, CUSTOM_DOMAIN, PAGES_RECORD } = SITE_MOVE;

  it(
    "moves a site from GitHub Pages to Cloudflare's hosting and back, each plan by its hash",
    async () => {
      const s = await siteMoveProject("github-pages");
      const state = () => s.engine.states.get(tfstateFile(s.paths)) ?? new Set<string>();
      const finishFlags = ["--finish", "--confirm", SITE, "--yes"];

      // To Cloudflare's hosting: a version of the Worker goes live with each deploy, and the
      // switch takes the app's name in a script.
      s.github.deploy = s.workerDeploys;
      const named = ["--confirm", SITE, "--yes"];
      const toWorkers = await siteSteps(s, ["--to", "cloudflare-workers", ...named], named);
      expect(toWorkers.last.code, toWorkers.text).toBe(0);
      expect(state().has(CUSTOM_DOMAIN)).toBe(true);
      const status = s.context();
      expect(await run(status, "status")).toBe(0);
      expect(status.output).toContain("retarget  moving from GitHub Pages to Cloudflare hosting;");
      const finished = await siteSteps(s, finishFlags, finishFlags);
      expect(finished.last.code, finished.text).toBe(0);
      let plan = await s.readPlan();
      expect(plan.retarget).toBeUndefined();
      expect(plan.target.provider).toBe("cloudflare-workers");
      expect(state().has(PAGES_RECORD)).toBe(false);
      // The user merges the pull request with the final files, as --finish says.
      await s.merge();

      // And back to GitHub Pages, with GitHub's verification value given in the script.
      const pagesFlags = ["--pages-verification", VERIFICATION, ...named];
      const toPages = await siteSteps(s, ["--to", "github-pages", ...pagesFlags], pagesFlags);
      expect(toPages.last.code, toPages.text).toBe(0);
      expect(s.pages.state.site).toMatchObject({ cname: SITE_DOMAIN });
      const again = await siteSteps(s, finishFlags, finishFlags);
      expect(again.last.code, again.text).toBe(0);
      plan = await s.readPlan();
      expect(plan.retarget).toBeUndefined();
      expect(plan.target.provider).toBe("github-pages");
      expect(state()).toEqual(new Set([PAGES_RECORD]));
    },
    STEP_TIMEOUT,
  );

  it("refuses a server move's flags for a site, and a server target for a site", async () => {
    const s = await siteMoveProject("cloudflare-workers");
    for (const [args, says] of [
      [
        ["--to", "github-pages", "--empty", "db"],
        "--empty does not apply to a move to github-pages.",
      ],
      [
        ["--to", "github-pages", "--allow-downtime"],
        "--allow-downtime does not apply to a move to github-pages.",
      ],
      [
        ["--to", "cloudflare-workers", "--pages-verification", "x"],
        "--pages-verification does not apply to a move to cloudflare-workers.",
      ],
    ] as const) {
      const refused = await siteRun(s, ...args);
      expect(refused.code).toBe(2);
      expect(refused.text).toContain(says);
    }
    const server = await siteRun(s, "--to", "hetzner", "--yes");
    expect(server.code).toBe(1);
    expect(server.text).toContain("Nothing was changed.");
    expect((await s.readPlan()).retarget).toBeUndefined();
  });
});
