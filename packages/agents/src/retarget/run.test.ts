import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ROLLING_NOTE } from "../design/strategy";
import { readServerAddresses, serverAddressesFile } from "../shared";
import {
  DOMAIN,
  HOST_KEY,
  type MoveHarness,
  moveHarness,
  OLD_IPV4,
  OLD_IPV6,
  planJsonFor,
  STRIPE,
  TOKENS,
} from "../testing";
import {
  caught,
  crashAfter,
  crashOn,
  drive,
  everythingPrinted,
  expectGated,
  moveOnDisk as move,
  run,
  trail,
} from "./__fixtures__/assert";
import {
  PRISMA_P3018,
  RELEASE_OUTPUT_FRAGMENTS,
  SQLALCHEMY_ERROR,
} from "./__fixtures__/release-output";
import type { MoveSession } from "./session";
import type { RetargetSummary } from "./types";
import { maintenanceWindow } from "./window";

const applies = (h: MoveHarness) => h.events.filter((e) => e.type === "apply");
const ops = (h: MoveHarness, host: string, op: string) =>
  h.events.filter((e) => e.type === "remote" && e.host === host && e.op === op).length;

const fail = (stderr = "boom"): CommandResult => ({ exitCode: 1, stdout: "", stderr });

function windowStarted(h: MoveHarness): boolean {
  return h.events.some(
    (e) => e.type === "approval" && e.kind === "remote-exec" && e.title.startsWith("Maintenance"),
  );
}

describe.skipIf(!findExecutable("git"))("runRetarget", () => {
  it("US1: moves a Hetzner deployment with Cloudflare and Postgres to DigitalOcean", async () => {
    const h = await moveHarness();
    let summary: RetargetSummary | undefined;
    const result = await run(h, {
      confirmStart: async (s) => {
        summary = s;
        return true;
      },
    });
    expect(result).toMatchObject({ step: "switched", done: true });
    expect(result.next.join(" ")).toContain("opscrew retarget --finish");
    expect(summary).toMatchObject({
      from: { provider: "hetzner" },
      to: { provider: "digitalocean", location: "fra1" },
      databaseBytes: 52_428_800,
      expectedDowntimeMinutes: 3,
    });
    expect(summary?.extraMonthly.currency).toBe("USD");
    expect(summary?.steps).toHaveLength(6);

    const n = h.newServer.ipv4;
    expect(trail(h.events)).toEqual([
      `${OLD_IPV4} db size`,
      "approve iac-apply",
      "apply moves=3",
      "approve iac-apply",
      "apply creates=4",
      "approve github-secrets",
      "dispatch main",
      `${n} stop caddy`,
      `${OLD_IPV4} db size`,
      "approve remote-exec",
      `${OLD_IPV4} stop app`,
      `${OLD_IPV4} dump`,
      `scp ${OLD_IPV4} -> ${n}`,
      `${n} stop app`,
      `${n} empty db`,
      `${n} restore`,
      `${OLD_IPV4} rm dump`,
      `${n} rm dump`,
      `${n} start app`,
      "approve iac-apply",
      "apply updates=2",
      `${n} start caddy`,
    ]);
    // Without a release service in the new server's compose file, no release runs in the window.
    expect(ops(h, n, "release")).toBe(0);
    const window = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
    expect(window?.details).not.toContain("release");
    expect(window?.details).not.toContain("--clean");
    expectGated(h.events);
    // The DNS switch was planned before the maintenance window (no plan fails while offline).
    const planned = h.events.findLastIndex((e) => e.type === "plan");
    const windowAt = h.events.findIndex((e) => e.type === "remote" && e.op === "dump");
    expect(planned).toBeLessThan(windowAt);

    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.target).toMatchObject({ provider: "digitalocean", location: "fra1" });
    expect(plan.cost.monthly.currency).toBe("USD");
    expect(plan.retarget).toMatchObject({
      step: "switched",
      from: { target: { provider: "hetzner", serverType: "cx23" } },
    });
    expect(plan.retarget?.oldAppStoppedAt).toBeDefined();
    expect(plan.deployment).toMatchObject({ url: `https://${DOMAIN}` });
    // Both servers' addresses are in OpsCrew's local state, never in opscrew/plan.yaml.
    const fresh = { ipv4: n, ipv6: h.newServer.ipv6 };
    expect(await readServerAddresses(h.paths)).toEqual({
      schemaVersion: 1,
      deployment: fresh,
      retarget: { from: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 }, next: fresh },
    });
    const committed = await readFile(h.paths.files.plan, "utf8");
    for (const ip of [OLD_IPV4, OLD_IPV6, n, h.newServer.ipv6]) {
      expect(committed).not.toContain(ip);
    }
    expect(plan.approvals).toHaveLength(3);
    // Honest cost: the plan that creates the new server shows its price; rename and switch none.
    const applyRequests = h.handler.requests.filter((r) => r.kind === "iac-apply");
    expect(applyRequests.map((r) => r.costDelta)).toEqual([
      undefined,
      plan.cost.monthly,
      undefined,
    ]);
    expect(applyRequests[2]?.details).toContain("Cost: unchanged");
    expect(h.hosts.host(n)).toMatchObject({ app: true, caddy: true, db: "orders before the move" });
    expect(h.hosts.host(OLD_IPV4)).toMatchObject({ app: false, caddy: true });
    expect(h.hosts.host(OLD_IPV4).dump).toBeUndefined();
    expect(h.hosts.host(n).dump).toBeUndefined();
    expect(h.engine.dnsServer()?.ipv4).toBe(n);

    expect(h.github.secrets.get("OPSCREW_HOST")).toBe(n);
    expect(h.github.secrets.get("OPSCREW_SSH_KNOWN_HOSTS")).toBe(`${n} ${HOST_KEY}\n`);
    expect(h.github.secrets.get("OPSCREW_APP_ENV")).toContain(STRIPE);
    expect(h.github.runs).toEqual([{ workflowFile: "opscrew-deploy.yml", ref: "main" }]);
    await expect(readFile(h.paths.files.knownHosts, "utf8")).resolves.toContain(n);
    const main = await readFile(join(h.root, "opscrew/infra/prod/main.tf"), "utf8");
    expect(main).toContain('module "server_previous"');
    expect(main).toContain("module.server.ipv4_address");

    const printed = everythingPrinted(h);
    for (const secret of [STRIPE, TOKENS.hetzner, TOKENS.digitalocean, TOKENS.cloudflare]) {
      expect(printed).not.toContain(secret);
    }
    expect(h.audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "retarget started",
        "retarget renamed",
        "retarget created",
        "retarget deployed",
        "retarget migrated",
        "retarget switched",
      ]),
    );
    expect(
      h.audit.entries.filter((e) => e.action.startsWith("retarget ")).map((e) => e.phase),
    ).toEqual(expect.arrayContaining(["retarget"]));
  });

  it("US1: moves a DigitalOcean deployment to Hetzner Cloud", async () => {
    const h = await moveHarness({ from: "digitalocean" });
    const result = await run(h);
    expect(result).toMatchObject({ step: "switched", done: true });
    const n = h.newServer.ipv4;
    expect(trail(h.events).filter((line) => line.startsWith("apply"))).toEqual([
      "apply moves=4",
      "apply creates=3",
      "apply updates=2",
    ]);
    expectGated(h.events);
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.target).toMatchObject({ provider: "hetzner", image: "ubuntu-24.04" });
    expect(plan.cost.monthly.currency).toBe("EUR");
    expect(plan.retarget?.from.target.provider).toBe("digitalocean");
    expect(h.engine.state.servers.server).toMatchObject({ provider: "hetzner", protected: true });
    expect(h.hosts.host(n).db).toBe("orders before the move");
    const variables = await readFile(join(h.root, "opscrew/infra/prod/variables.tf"), "utf8");
    expect(variables).toContain('variable "delete_protection"');
    expect(variables).not.toContain('variable "previous_delete_protection"');
  });

  it.each(["started", "renamed", "created", "deployed", "migrated", "switched"])(
    "SC-503: an interruption after %s resumes and completes the move",
    async (step) => {
      const h = await moveHarness();
      crashAfter(h, step);
      await expect(run(h)).rejects.toThrow("interrupted");
      expect((await move(h))?.step).toBe(step);
      const result = await run(h);
      expect(result).toMatchObject({ step: "switched", done: true });
      // Nothing done twice: one rename, one create, one DNS switch, one copy, one deploy.
      expect(trail(h.events).filter((line) => line.startsWith("apply"))).toEqual([
        "apply moves=3",
        "apply creates=4",
        "apply updates=2",
      ]);
      expect(ops(h, OLD_IPV4, "dump")).toBe(1);
      expect(h.github.runs).toHaveLength(1);
      expectGated(h.events);
      const n = h.newServer.ipv4;
      expect(h.hosts.host(n)).toMatchObject({
        app: true,
        caddy: true,
        db: "orders before the move",
      });
      expect(h.engine.dnsServer()?.ipv4).toBe(n);
    },
  );

  it("an interrupted maintenance window starts the old app first and repeats the copy", async () => {
    const h = await moveHarness();
    const n = h.newServer.ipv4;
    // Killed once the window began (oldAppStoppedAt recorded); it had stopped the app and dumped.
    crashOn(h, "maintenance window");
    await expect(run(h)).rejects.toThrow("interrupted");
    const interrupted = await move(h);
    expect(interrupted).toMatchObject({ step: "deployed" });
    expect(interrupted?.oldAppStoppedAt).toBeDefined();
    Object.assign(h.hosts.host(OLD_IPV4), { app: false, dump: "orders before the move" });
    h.events.length = 0;

    const result = await run(h);
    expect(result).toMatchObject({ step: "switched", done: true });
    const lines = trail(h.events);
    expect(lines.slice(0, 3)).toEqual([
      `${OLD_IPV4} start app`,
      `${OLD_IPV4} rm dump`,
      `${n} rm dump`,
    ]);
    expect(lines).toContain("approve remote-exec");
    expect(ops(h, OLD_IPV4, "dump")).toBe(1);
    expect(h.reporter.text()).toContain("stopped during the maintenance window");
    expect(h.hosts.host(n).db).toBe("orders before the move");
  });

  const WINDOW_FAILURES = [
    { what: "stopping the old app", on: "old", op: "stop app" },
    { what: "the dump", on: "old", op: "dump" },
    { what: "the copy", on: "old", op: "scp" },
    { what: "stopping the new app", on: "new", op: "stop app" },
    { what: "emptying the new database", on: "new", op: "empty db" },
    { what: "the restore", on: "new", op: "restore" },
    { what: "deleting the old dump", on: "old", op: "rm dump" },
    { what: "starting the new app", on: "new", op: "start app" },
    { what: "the health check", on: "new", op: "health" },
  ] as const;

  it.each(WINDOW_FAILURES)(
    "FR-506: a failure of $what rolls back to the old app; a re-run repeats the window",
    async ({ on, op }) => {
      const h = await moveHarness();
      const n = h.newServer.ipv4;
      const host = on === "old" ? OLD_IPV4 : n;
      let failed = false;
      h.hosts.fail = (ip, o) => {
        if (ip !== host || o !== op || !windowStarted(h)) return undefined;
        if (failed && op !== "health") return undefined;
        failed = true;
        return fail(`${op} failed`);
      };
      const error = await caught(run(h));
      expect(error.message).toContain("The maintenance window failed");
      expect(error.message).toContain("The app on the old server runs again");
      expect(error.hint).toContain("opscrew retarget");
      const state = await move(h);
      expect(state?.step).toBe("deployed");
      expect(state?.oldAppStoppedAt).toBeUndefined();
      expect(h.hosts.host(OLD_IPV4).app).toBe(true);
      expect(h.hosts.host(OLD_IPV4).dump).toBeUndefined();
      expect(h.hosts.host(n).dump).toBeUndefined();
      expect(h.hosts.host(n).app).toBe(true);
      expect(applies(h)).toHaveLength(2);
      expect(h.engine.dnsServer()?.ipv4).toBe(OLD_IPV4);

      h.hosts.fail = undefined;
      const result = await run(h);
      expect(result).toMatchObject({ step: "switched", done: true });
      expect(h.hosts.host(n).db).toBe("orders before the move");
      expectGated(h.events);
    },
  );

  it("T831: with a release command the copy goes onto an empty database and is migrated before the app starts", async () => {
    const h = await moveHarness({ release: true });
    const n = h.newServer.ipv4;
    const result = await run(h);
    expect(result).toMatchObject({ step: "switched", done: true });
    const lines = trail(h.events);
    const from = lines.indexOf(`${OLD_IPV4} stop app`);
    expect(lines.slice(from, lines.indexOf(`${n} start app`) + 1)).toEqual([
      `${OLD_IPV4} stop app`,
      `${OLD_IPV4} dump`,
      `scp ${OLD_IPV4} -> ${n}`,
      `${n} stop app`,
      `${n} empty db`,
      `${n} restore`,
      `${n} release`,
      `${OLD_IPV4} rm dump`,
      `${n} rm dump`,
      `${n} start app`,
    ]);
    // The new server's compose file is read before the window is approved.
    const probe = h.events.findIndex((e) => e.type === "remote" && e.op === "services?");
    const approval = h.events.findIndex(
      (e) => e.type === "approval" && e.title.startsWith("Maintenance"),
    );
    expect(probe).toBeGreaterThanOrEqual(0);
    expect(probe).toBeLessThan(approval);
    expect(h.events[probe]).toMatchObject({ host: n });
    // The old data, migrated forward to the version deployed on the new server.
    expect(h.hosts.host(n).db).toBe("orders before the move (migrated)");
    const window = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
    expect(window?.details).toContain(
      "docker compose exec -T db psql -U app -d postgres -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS app WITH (FORCE)' -c 'CREATE DATABASE app OWNER app'",
    );
    expect(window?.details).toContain("docker compose run --rm --no-deps -T release");
    expect(window?.details).not.toContain("--clean");
    const actions = h.audit.entries.map((e) => e.action);
    expect(actions).toContain("empty database");
    expect(actions).toContain("run release command");
    expect(h.reporter.text()).toContain("release command");
    expectGated(h.events);
  });

  it.each([
    { tool: "Prisma P3018", output: PRISMA_P3018 },
    { tool: "SQLAlchemy", output: SQLALCHEMY_ERROR },
  ])(
    "T831: a failed release command ($tool) in the window rolls back to the old app and says so, without its output",
    async ({ output }) => {
      const h = await moveHarness({ release: true });
      const n = h.newServer.ipv4;
      let failed = false;
      h.hosts.fail = (ip, op) => {
        if (ip !== n || op !== "release" || failed) return undefined;
        failed = true;
        return { exitCode: 1, stdout: output, stderr: output };
      };
      const error = await caught(run(h));
      expect(error.code).toBe("COMMAND_FAILED");
      expect(error.message).toContain("The maintenance window failed");
      expect(error.message).toContain(
        `Could not run the release command (app.releaseCommand in opscrew/plan.yaml) on ${n}: it exited with code 1`,
      );
      expect(error.message).toContain("it ran only on the copy of the database on the new server");
      expect(error.message).toContain("The app on the old server runs again");
      expect(error.hint).toContain("The old server keeps serving your users.");
      expect(error.hint).toContain("app.releaseCommand");
      expect(error.hint).toContain("docker compose run --rm --no-deps -T release");
      expect(error.hint).toContain("opscrew retarget");
      // Migration output quotes rows and SQL parameters: none of it is shown or audited.
      const printed = `${everythingPrinted(h)}\n${error.message}\n${error.hint}`;
      for (const fragment of RELEASE_OUTPUT_FRAGMENTS) expect(printed).not.toContain(fragment);
      const lines = trail(h.events);
      expect(lines.slice(lines.indexOf(`${n} release`))).toEqual([
        `${n} release`,
        `${OLD_IPV4} rm dump`,
        `${n} rm dump`,
        `${n} start app`,
        `${OLD_IPV4} start app`,
      ]);
      const state = await move(h);
      expect(state?.step).toBe("deployed");
      expect(state?.oldAppStoppedAt).toBeUndefined();
      expect(h.hosts.host(OLD_IPV4).app).toBe(true);
      expect(h.hosts.host(OLD_IPV4).dump).toBeUndefined();
      expect(h.hosts.host(n).dump).toBeUndefined();
      expect(h.engine.dnsServer()?.ipv4).toBe(OLD_IPV4);
      expect(h.audit.entries).toContainEqual(
        expect.objectContaining({ action: "maintenance window", decision: "refused" }),
      );

      // A re-run repeats the window from a fresh, empty database.
      const result = await run(h);
      expect(result).toMatchObject({ step: "switched", done: true });
      expect(h.hosts.host(n).db).toBe("orders before the move (migrated)");
      expectGated(h.events);
    },
  );

  it("T831: stops before the window, with nothing changed, when the new server's services cannot be read", async () => {
    const h = await moveHarness({ release: true });
    h.hosts.fail = (ip, op) =>
      ip === h.newServer.ipv4 && op === "services?"
        ? fail("no configuration file provided")
        : undefined;
    const error = await caught(run(h));
    expect(error.message).toContain("read the Compose services");
    expect(windowStarted(h)).toBe(false);
    expect(ops(h, OLD_IPV4, "stop app")).toBe(0);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect((await move(h))?.oldAppStoppedAt).toBeUndefined();
  });

  it.each([
    { what: "unreadable", result: fail("pg_restore: error: input file is too short") },
    {
      what: "different from the old server's dump",
      result: {
        exitCode: 0,
        stdout: `${"0".repeat(64)}  /srv/app/opscrew-move.dump\n`,
        stderr: "",
      },
    },
  ])("T831: a copied dump that is $what drops nothing and rolls back", async ({ result }) => {
    const h = await moveHarness({ release: true });
    const n = h.newServer.ipv4;
    let failed = false;
    h.hosts.fail = (ip, op) => {
      if (ip !== n || op !== "verify dump" || failed) return undefined;
      failed = true;
      return result;
    };
    const error = await caught(run(h));
    expect(error.message).toContain("The maintenance window failed");
    expect(error.message).toContain(n);
    expect(error.message).toContain("The app on the old server runs again");
    expect(ops(h, n, "empty db")).toBe(0);
    expect(ops(h, n, "restore")).toBe(0);
    expect(ops(h, n, "release")).toBe(0);
    expect(ops(h, n, "stop app")).toBe(0);
    expect(h.hosts.host(n).db).toBe("schema of HEAD");
    const state = await move(h);
    expect(state?.step).toBe("deployed");
    expect(state?.oldAppStoppedAt).toBeUndefined();
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect(h.hosts.host(OLD_IPV4).dump).toBeUndefined();
    expect(h.hosts.host(n).dump).toBeUndefined();
  });

  it("FR-810: stops before any server command when the recorded servers share an address", async () => {
    const h = await moveHarness({ interactive: false });
    // A script without --allow-downtime stops right before the window.
    const stopped = await drive(h);
    expect(stopped.step).toBe("deployed");
    const file = serverAddressesFile(h.paths);
    const record = JSON.parse(await readFile(file, "utf8"));
    record.retarget.next = { ipv4: OLD_IPV4, ipv6: h.newServer.ipv6 };
    await writeFile(file, `${JSON.stringify(record)}\n`);
    h.events.length = 0;
    h.cli.allowDowntime = true;
    const error = await caught(run(h, { allowDowntime: true }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "OpsCrew cannot tell which server is which on this computer: the server being replaced and the new server have the same address in .opscrew/server.json or in the infrastructure state, so it cannot continue the move. Nothing was changed.",
    );
    expect(error.hint).toContain(".opscrew/server.json");
    expect(h.events.filter((e) => e.type === "remote" || e.type === "scp")).toEqual([]);
    expect(h.hosts.host(OLD_IPV4)).toMatchObject({ app: true, db: "orders before the move" });
  });

  it.each([
    { same: "IPv4", next: { ipv4: OLD_IPV4 } },
    { same: "IPv6", next: { ipv4: "198.51.100.99", ipv6: OLD_IPV6.toUpperCase() } },
  ])(
    "FR-810: the maintenance window refuses two servers with the same $same address before any command",
    async ({ next }) => {
      const h = await moveHarness();
      const session = {
        deps: h.deps,
        services: h.services,
        plan: h.plan,
        command: "opscrew retarget",
        servers: { from: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 }, next },
      } as unknown as MoveSession;
      const error = await caught(maintenanceWindow(session, { allowDowntime: true }));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("OpsCrew cannot tell which server is which on this computer");
      expect(error.message).toContain("Nothing was changed.");
      expect(h.events).toEqual([]);
    },
  );

  it("says the app is offline when the old app cannot be started again, and retries first", async () => {
    const h = await moveHarness();
    h.hosts.fail = (ip, op) => {
      if (ip !== OLD_IPV4 || !windowStarted(h)) return undefined;
      if (op === "dump") return fail("dump failed");
      if (op === "start app") return fail("docker is not running");
      return undefined;
    };
    const error = await caught(run(h));
    expect(error.message).toContain("could not start the app on the old server");
    expect(error.message).toContain("Your app is offline");
    expect(error.hint).toContain("docker compose up -d app");
    expect((await move(h))?.oldAppStoppedAt).toBeDefined();

    h.hosts.fail = undefined;
    h.events.length = 0;
    await run(h);
    expect(trail(h.events)[0]).toBe(`${OLD_IPV4} start app`);
  });

  it("stops before the window when the DNS switch plan would create a record", async () => {
    const h = await moveHarness();
    h.engine.tamper = (effect) => {
      if (effect.dnsTo === undefined) return;
      effect.changes.push({
        address: "module.dns.cloudflare_dns_record.www",
        type: "cloudflare_dns_record",
        name: "www",
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        action: "create",
      });
    };
    const error = await caught(run(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "The DNS switch plan would do more than update the DNS records in place",
    );
    expect(error.message).toContain("create module.dns.cloudflare_dns_record.www");
    expect(applies(h)).toHaveLength(2);
    expect(ops(h, OLD_IPV4, "dump")).toBe(0);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });

  it("after a DNS switch that failed half-way, continuing copies again and completes it", async () => {
    const h = await moveHarness();
    const n = h.newServer.ipv4;
    h.engine.failApply = (effect) => {
      if (effect.dnsTo === undefined) return undefined;
      h.engine.state.dns = effect.dnsTo;
      return "Error: Cloudflare API timeout";
    };
    const error = await caught(run(h));
    expect(error.message).toContain(`may already point at the new server (${n}`);
    h.engine.failApply = undefined;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    expect(ops(h, OLD_IPV4, "dump")).toBe(2);
    expect(h.engine.dnsServer()?.ipv4).toBe(n);
    expect(h.hosts.host(n)).toMatchObject({ caddy: true, db: "orders before the move" });
  });

  it("a failed DNS switch starts the old app again and goes back before the window", async () => {
    const h = await moveHarness();
    h.engine.failApply = (effect) =>
      effect.dnsTo !== undefined ? "Error: Cloudflare API returned 500" : undefined;
    const error = await caught(run(h));
    expect(error.message).toContain("The switch failed");
    expect(error.message).toContain("The app on the old server runs again");
    expect(error.hint).toContain("repeats the maintenance window");
    const state = await move(h);
    expect(state?.step).toBe("deployed");
    expect(state?.oldAppStoppedAt).toBeUndefined();
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect(h.engine.dnsServer()?.ipv4).toBe(OLD_IPV4);
    expect(h.hosts.host(h.newServer.ipv4).caddy).toBe(false);

    h.engine.failApply = undefined;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    expect(ops(h, OLD_IPV4, "dump")).toBe(2);
    expectGated(h.events);
  });

  it("a failed switch whose old app cannot start goes back before the window anyway", async () => {
    const h = await moveHarness();
    h.engine.failApply = (effect) => (effect.dnsTo !== undefined ? "Error: API 500" : undefined);
    h.hosts.fail = (ip, op) =>
      ip === OLD_IPV4 && op === "start app" ? fail("docker is not running") : undefined;
    const error = await caught(run(h));
    expect(error.message).toContain("Your app is offline");
    const state = await move(h);
    expect(state?.step).toBe("deployed");
    expect(state?.oldAppStoppedAt).toBeDefined();

    h.engine.failApply = undefined;
    h.hosts.fail = undefined;
    h.events.length = 0;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    const lines = trail(h.events);
    expect(lines[0]).toBe(`${OLD_IPV4} start app`);
    expect(lines).toContain(`${OLD_IPV4} dump`);
  });

  it("a refused DNS switch also rolls back so users keep being served", async () => {
    const h = await moveHarness();
    h.handler.answer = (r) => !(r.kind === "iac-apply" && r.title.includes("2 to update"));
    const error = await caught(run(h));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("The switch was not approved");
    expect((await move(h))?.step).toBe("deployed");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });

  it("shows the builder and the deploy strategy for the new server before the start, and records them", async () => {
    const h = await moveHarness();
    const before = await readArtifact("plan", h.paths.files.plan);
    const earlier = {
      builder: "buildpacks" as const,
      chosen: "auto" as const,
      reason: "Before the move.",
      runtime: { language: "node" as const, version: "24" },
    };
    await writeArtifact("plan", h.paths.files.plan, {
      ...before,
      app: { ...before.app, build: earlier },
      deploy: { strategy: "recreate", drainSeconds: 45 },
    });
    let summary: RetargetSummary | undefined;
    const refused = await caught(
      run(h, {
        confirmStart: async (s) => {
          summary = s;
          return false;
        },
      }),
    );
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(summary?.changes).toEqual([
      expect.stringMatching(
        /^Image builder: generated-dockerfile \(was buildpacks\)\. OpsCrew has/,
      ),
      `Deploys: rolling (was recreate). ${ROLLING_NOTE}`,
    ]);
    for (const change of summary?.changes ?? []) expect(h.reporter.text()).toContain(change);
    expect(applies(h)).toHaveLength(0);
    expect((await readArtifact("plan", h.paths.files.plan)).app.build).toEqual(earlier);

    await run(h, { confirmStart: async () => true });
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.app.build).toMatchObject({ builder: "generated-dockerfile", chosen: "auto" });
    expect(plan.deploy).toEqual({ strategy: "rolling", drainSeconds: 45 });
  });

  it("stops before anything is created when the new server's builder needs a missing Dockerfile", async () => {
    const h = await moveHarness();
    await rm(join(h.root, "Dockerfile"));
    const error = await caught(run(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "The new server's builder needs a Dockerfile this repository lacks: run `opscrew design` and `opscrew adapt` first. Nothing was changed.",
    );
    expect(applies(h)).toHaveLength(0);
    expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();
  });

  it("stops before anything is created when the plan's builder cannot build the app", async () => {
    const h = await moveHarness();
    const before = await readArtifact("plan", h.paths.files.plan);
    const build = {
      builder: "buildpacks" as const,
      chosen: "user" as const,
      reason: "You chose it.",
      runtime: { language: "node" as const, version: "24" },
    };
    await writeArtifact("plan", h.paths.files.plan, { ...before, app: { ...before.app, build } });
    // Buildpacks has no pnpm support.
    const architecture = await readArtifact("architecture", h.paths.files.architecture);
    await writeArtifact("architecture", h.paths.files.architecture, {
      ...architecture,
      facts: { ...architecture.facts, packageManager: "pnpm" },
    });
    const error = await caught(run(h));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain(
      "sets app.build.builder to buildpacks, but the pinned Buildpacks builder has no pnpm support",
    );
    expect(error.message).toContain("Nothing was changed.");
    expect(applies(h)).toHaveLength(0);
    expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();
  });

  it("without a self-hosted database there is no maintenance window", async () => {
    const h = await moveHarness({ postgres: false });
    let summary: RetargetSummary | undefined;
    const result = await run(h, {
      confirmStart: async (s) => {
        summary = s;
        return true;
      },
    });
    expect(result).toMatchObject({ step: "switched", done: true });
    expect(summary?.databaseBytes).toBeUndefined();
    expect(summary?.steps.join(" ")).toContain("No maintenance window");
    const lines = trail(h.events);
    expect(lines).not.toContain("approve remote-exec");
    expect(lines.some((line) => line.includes("dump") || line.includes("db size"))).toBe(false);
    // The old app served users until the switch, then stops.
    const switchAt = lines.indexOf("apply updates=2");
    const stopAt = lines.indexOf(`${OLD_IPV4} stop app`);
    expect(stopAt).toBeGreaterThan(switchAt);
    expect((await move(h))?.oldAppStoppedAt).toBeDefined();
    expect(h.github.secrets.has("OPSCREW_DB_ENV")).toBe(false);
  });

  it("DNS at another provider: shows the records and continues once the user confirms", async () => {
    const h = await moveHarness({ dns: "other" });
    const n = h.newServer.ipv4;
    h.handler.answer = (r) => {
      if (r.kind === "remote-exec" && r.title.startsWith("Switch")) h.manual.ip = n;
      return true;
    };
    const result = await run(h);
    expect(result).toMatchObject({ step: "switched", done: true });
    const confirm = h.handler.requests.find((r) => r.title.startsWith("Switch"));
    expect(confirm?.details).toContain(`A     ${DOMAIN} → ${n}`);
    expect(confirm?.details).toContain(`AAAA  ${DOMAIN} → ${h.newServer.ipv6}`);
    expect(trail(h.events).filter((line) => line.startsWith("apply"))).toEqual([
      "apply moves=3",
      "apply creates=4",
    ]);
    const plan = await readArtifact("plan", h.paths.files.plan);
    // The URL on the new server's IP is not committed; the address is in the local state.
    expect(plan.deployment.url).toBeUndefined();
    expect((await readServerAddresses(h.paths)).deployment?.ipv4).toBe(n);
    expect(h.events.some((e) => e.type === "fetch" && e.url.startsWith(`https://${DOMAIN}`))).toBe(
      true,
    );
  });

  it("DNS at another provider in a script: stops with the records until --dns-switched", async () => {
    const h = await moveHarness({ dns: "other", interactive: false });
    const n = h.newServer.ipv4;
    const stop = await drive(h, { allowDowntime: true });
    expect(stop).toMatchObject({ step: "migrated", done: false });
    expect(stop.pendingPlanHash).toBeUndefined();
    expect(stop.next.join("\n")).toContain(`A     ${DOMAIN} → ${n}`);
    expect(stop.next.join("\n")).toContain("opscrew retarget --dns-switched");
    expect(stop.next.join("\n")).toContain("users see an error");

    h.manual.ip = n;
    const result = await run(h, { dnsSwitched: true });
    expect(result).toMatchObject({ step: "switched", done: true });
    expect(h.audit.entries.some((e) => e.action === "dns-switched")).toBe(true);
    expectGated(h.events);
  });

  it("DNS at another provider: says the downtime lasts until the user's DNS change is live", async () => {
    const h = await moveHarness({ dns: "other" });
    const n = h.newServer.ipv4;
    h.handler.answer = (r) => {
      if (r.kind === "remote-exec" && r.title.startsWith("Switch")) h.manual.ip = n;
      return true;
    };
    let summary: RetargetSummary | undefined;
    await run(h, {
      confirmStart: async (s) => {
        summary = s;
        return true;
      },
    });
    const window = summary?.steps.find((step) => step.startsWith("Maintenance window"));
    expect(window).toContain(
      "the app stays offline from then until your DNS change has reached your users",
    );
    const printed = h.reporter.text();
    expect(printed).toContain("for the copy, plus the time your DNS change takes to reach");
    expect(printed).toContain("Lower the TTL of those records beforehand");
    expect(printed).toContain("pass `--allow-downtime --dns-switched` together only when");
    const approval = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
    expect(approval?.title).toContain("for the copy, plus your DNS change");
    expect(approval?.details).toContain("Lower the TTL");
    const confirm = h.handler.requests.find((r) => r.title.startsWith("Switch"));
    expect(confirm?.details).toContain("so your users are offline until your DNS change");
  });

  it("DNS at another provider in a script: the window stop says the app stays stopped", async () => {
    const h = await moveHarness({ dns: "other", interactive: false });
    const stop = await drive(h);
    expect(stop).toMatchObject({ step: "deployed", done: false });
    const text = stop.next.join("\n");
    expect(text).toContain("stays stopped until your DNS change has reached your users");
    expect(text).toContain("Lower the TTL");
    expect(text).toContain("`--allow-downtime --dns-switched`");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });

  it("with Cloudflare DNS the downtime is only the copy", async () => {
    const h = await moveHarness();
    let summary: RetargetSummary | undefined;
    await run(h, {
      confirmStart: async (s) => {
        summary = s;
        return true;
      },
    });
    expect(summary?.steps.join(" ")).not.toContain("offline from then");
    expect(h.reporter.text()).not.toContain("TTL");
    const approval = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
    expect(approval?.title).toContain("(about 3 minutes of downtime)");
  });

  it("a script resumed after the copy says users are offline while the switch plan waits", async () => {
    const h = await moveHarness({ interactive: false });
    crashAfter(h, "migrated");
    await expect(drive(h, { allowDowntime: true })).rejects.toThrow("interrupted");
    expect((await move(h))?.step).toBe("migrated");
    h.cli.approve = undefined;
    h.cli.allowDowntime = undefined;
    const stop = await run(h);
    expect(stop).toMatchObject({ step: "migrated", done: false });
    const hash = stop.pendingPlanHash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const text = stop.next.join("\n");
    expect(text).toContain("The app on the old server is stopped");
    expect(text).toContain("your users are offline until this switch is applied");
    expect(text).toContain(`opscrew retarget --approve ${hash}`);
    expect(h.hosts.host(OLD_IPV4).app).toBe(false);

    h.cli.approve = hash;
    expect(await run(h, { approvePlanHash: hash })).toMatchObject({ step: "switched", done: true });
    expect(ops(h, OLD_IPV4, "dump")).toBe(1);
    expectGated(h.events);
  });

  it("reads both servers' addresses from the infrastructure state when the local record is gone", async () => {
    const h = await moveHarness({ dns: "none", postgres: false, interactive: false });
    const fresh = { ipv4: h.newServer.ipv4, ipv6: h.newServer.ipv6 };
    await drive(h);
    await rm(serverAddressesFile(h.paths));
    const result = await run(h, { dnsSwitched: true });
    expect(result).toMatchObject({ step: "switched", done: true });
    expect(await readServerAddresses(h.paths)).toEqual({
      schemaVersion: 1,
      deployment: fresh,
      retarget: { from: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 }, next: fresh },
    });
    // The right servers were used: the old app is stopped, the new one serves.
    expect(h.hosts.host(OLD_IPV4).app).toBe(false);
    expect(h.hosts.host(fresh.ipv4)).toMatchObject({ app: true, caddy: true });
  });

  it("a switch made by hand, local record gone: the old and new servers are never swapped", async () => {
    // Without managed DNS no `switched` layout is ever applied: module.server is still the new
    // server, and the outputs' live server is still the old one.
    const h = await moveHarness({ dns: "none", postgres: false });
    const n = h.newServer.ipv4;
    crashAfter(h, "switched");
    await expect(run(h)).rejects.toThrow("interrupted");
    expect(await move(h)).toMatchObject({ step: "switched" });
    expect((await move(h))?.oldAppStoppedAt).toBeUndefined();
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    await rm(serverAddressesFile(h.paths));

    const mark = h.events.length;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    expect(trail(h.events.slice(mark))).toEqual([`${n} start caddy`, `${OLD_IPV4} stop app`]);
    expect(h.hosts.host(OLD_IPV4).app).toBe(false);
    expect(h.hosts.host(n)).toMatchObject({ app: true, caddy: true });
    // The record is rebuilt: both servers, and the new one receives the traffic.
    const fresh = { ipv4: n, ipv6: h.newServer.ipv6 };
    expect(await readServerAddresses(h.paths)).toEqual({
      schemaVersion: 1,
      deployment: fresh,
      retarget: { from: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 }, next: fresh },
    });
  });

  it("a DNS switch applied but not recorded, local record gone: the servers are not swapped", async () => {
    const h = await moveHarness({ postgres: false });
    const n = h.newServer.ipv4;
    // The process dies right after the third apply (the DNS switch), before it is recorded.
    const append = h.audit.append.bind(h.audit);
    let applied = 0;
    h.audit.append = async (entry) => {
      await append(entry);
      if (entry.kind === "iac" && entry.action === "apply" && ++applied === 3) {
        throw new Error("interrupted");
      }
    };
    await caught(run(h));
    expect(h.engine.dnsServer()?.ipv4).toBe(n);
    expect((await move(h))?.step).toBe("deployed");
    // The state's outputs now follow the new server as the live one.
    expect(h.engine.state.outputs.server_ipv4).toBe(n);
    await rm(serverAddressesFile(h.paths));

    const mark = h.events.length;
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    expect(trail(h.events.slice(mark))).toEqual([`${n} start caddy`, `${OLD_IPV4} stop app`]);
    expect(h.hosts.host(OLD_IPV4).app).toBe(false);
    expect(h.hosts.host(n)).toMatchObject({ app: true, caddy: true });
    const fresh = { ipv4: n, ipv6: h.newServer.ipv6 };
    expect(await readServerAddresses(h.paths)).toEqual({
      schemaVersion: 1,
      deployment: fresh,
      retarget: { from: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 }, next: fresh },
    });
  });

  it("stops without acting when it cannot tell which server is which", async () => {
    const h = await moveHarness({ dns: "none", postgres: false, interactive: false });
    await drive(h);
    expect((await move(h))?.step).toBe("deployed");
    await rm(serverAddressesFile(h.paths));
    // A state without the `servers` output: only the live server is named.
    h.engine.state.outputs = { server_ipv4: OLD_IPV4, server_ipv6: OLD_IPV6 };
    const mark = h.events.length;
    const error = await caught(run(h, { dnsSwitched: true }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("OpsCrew cannot tell which server is which on this computer");
    expect(error.message).toContain("Nothing was changed.");
    expect(error.hint).toContain("on the computer that started the move");
    expect(trail(h.events.slice(mark))).toEqual([]);
    expect((await move(h))?.step).toBe("deployed");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });

  it("a damaged local record stops the move before anything happens", async () => {
    const h = await moveHarness({ dns: "none", postgres: false, interactive: false });
    await drive(h);
    await writeFile(serverAddressesFile(h.paths), '{"schemaVersion":1,"retarget":');
    const mark = h.events.length;
    const error = await caught(run(h, { dnsSwitched: true }));
    expect(error.code).toBe("ARTIFACT_INVALID");
    expect(error.message).toContain(".opscrew/server.json");
    expect(error.hint).toContain("Delete .opscrew/server.json");
    expect(trail(h.events.slice(mark))).toEqual([]);
    expect((await move(h))?.step).toBe("deployed");
    expect(await readFile(serverAddressesFile(h.paths), "utf8")).toBe(
      '{"schemaVersion":1,"retarget":',
    );
  });

  it("without a domain the app moves to the new address", async () => {
    const h = await moveHarness({ dns: "none", postgres: false, interactive: false });
    const n = h.newServer.ipv4;
    const stop = await drive(h);
    expect(stop.next.join("\n")).toContain(`The app's new address is http://${n}`);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    const result = await run(h, { dnsSwitched: true });
    expect(result).toMatchObject({ step: "switched", done: true });
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.deployment.url).toBeUndefined();
    expect((await readServerAddresses(h.paths)).deployment?.ipv4).toBe(n);
    expect(await readFile(h.paths.files.plan, "utf8")).not.toContain(n);
    expect(h.events.some((e) => e.type === "fetch" && e.url === `http://${n}/api/health`)).toBe(
      true,
    );
  });

  it("a refused switch confirmation rolls back to the old app", async () => {
    const h = await moveHarness({ dns: "other" });
    h.handler.answer = (r) => !(r.kind === "remote-exec" && r.title.startsWith("Switch"));
    const error = await caught(run(h));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect((await move(h))?.step).toBe("deployed");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });

  it("US3: a script stops at every plan with its hash and continues with --approve", async () => {
    const h = await moveHarness({ interactive: false });
    const first = await run(h);
    expect(first).toMatchObject({ step: "started", done: false });
    const rename = first.pendingPlanHash as string;
    expect(rename).toMatch(/^[0-9a-f]{64}$/);
    expect(first.next.join(" ")).toContain(`opscrew retarget --approve ${rename}`);
    expect(applies(h)).toHaveLength(0);

    // A wrong hash applies nothing: the step is planned again.
    h.cli.approve = "0".repeat(64);
    const wrong = await run(h, { approvePlanHash: "0".repeat(64) });
    expect(wrong.step).toBe("started");
    expect(applies(h)).toHaveLength(0);
    expect(h.reporter.text()).toContain("did not use --approve");
    const renameAgain = wrong.pendingPlanHash as string;

    h.cli.approve = renameAgain;
    const second = await run(h, { approvePlanHash: renameAgain });
    expect(second).toMatchObject({ step: "renamed", done: false });
    expect(applies(h)).toHaveLength(1);

    h.cli.approve = second.pendingPlanHash;
    const third = await run(h, { approvePlanHash: second.pendingPlanHash as string });
    expect(third).toMatchObject({ step: "deployed", done: false });
    const dnsSwitch = third.pendingPlanHash as string;
    expect(third.next.join(" ")).toContain(
      `opscrew retarget --allow-downtime --approve ${dnsSwitch}`,
    );
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);

    // The window needs --allow-downtime; the approved switch plan waits.
    h.cli.approve = dnsSwitch;
    const fourth = await run(h, { approvePlanHash: dnsSwitch });
    expect(fourth).toMatchObject({ step: "deployed", done: false, pendingPlanHash: dnsSwitch });
    expect(fourth.next.join(" ")).toContain("--allow-downtime");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect(ops(h, OLD_IPV4, "dump")).toBe(0);

    h.cli.allowDowntime = true;
    const last = await run(h, { approvePlanHash: dnsSwitch, allowDowntime: true });
    expect(last).toMatchObject({ step: "switched", done: true });
    expect(applies(h)).toHaveLength(3);
    expectGated(h.events);
  });

  it("stops when the deploy workflow fails; the old server keeps serving", async () => {
    const h = await moveHarness();
    h.github.conclusion = "failure";
    const error = await caught(run(h));
    expect(error.message).toContain("The deploy workflow did not succeed (failure)");
    expect(error.message).toContain("https://github.com/acme/shop/actions/runs/99");
    expect(error.message).toContain("The old server still serves your users");
    expect(error.hint).toContain("opscrew retarget --abort");
    expect((await move(h))?.step).toBe("created");
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);

    h.github.conclusion = "success";
    expect(await run(h)).toMatchObject({ step: "switched", done: true });
    // The secrets were stored once; the workflow ran again.
    expect(h.events.filter((e) => e.type === "secret")).toHaveLength(7);
    expect(h.github.runs).toHaveLength(2);
  });

  it("stops before any plan when a provider token is missing or rejected", async () => {
    const h = await moveHarness();
    h.services.providers = {
      ...h.services.providers,
      digitalocean: { configured: false, verify: async () => ({ ok: false, message: "no" }) },
    };
    const error = await caught(run(h));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("DigitalOcean");
    expect(h.events.filter((e) => e.type === "plan")).toEqual([]);
    expect(await move(h)).toBeUndefined();
  });

  it("stops before any plan when the GitHub token is missing", async () => {
    const h = await moveHarness();
    h.services.github = null;
    const error = await caught(run(h));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("GitHub");
    expect(error.hint).toBeTruthy();
    expect(h.events.filter((e) => e.type === "plan")).toEqual([]);
    expect(await move(h)).toBeUndefined();
  });

  it("stops before any plan when the Cloudflare token is missing", async () => {
    const h = await moveHarness();
    h.services.cloudflare = null;
    const error = await caught(run(h));
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("No Cloudflare token found: set CLOUDFLARE_API_TOKEN");
    expect(error.hint).toBeTruthy();
    expect(h.events.filter((e) => e.type === "plan")).toEqual([]);
    expect(await move(h)).toBeUndefined();
  });

  it("stops before any plan without the state passphrase, naming the move's command", async () => {
    const h = await moveHarness();
    await rm(h.deps.paths.files.statePassphrase);
    const error = await caught(run(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("does not have its passphrase");
    expect(error.hint).toMatch(/then run `opscrew retarget[^`]*` again\.$/);
    expect(existsSync(h.deps.paths.files.statePassphrase)).toBe(false);
    expect(h.engine.plans).toHaveLength(0);
  });

  it("stops before anything when the deploy key is not on this computer", async () => {
    const h = await moveHarness();
    await rm(h.paths.files.deployKey);
    const error = await caught(run(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("deploy key is not on this computer");
    expect(await move(h)).toBeUndefined();
  });

  it("refuses a move to the provider the deployment already uses", async () => {
    const h = await moveHarness();
    const error = await caught(run(h, { to: "hetzner" }));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("already runs on Hetzner Cloud");
    expect(h.events.filter((e) => e.type === "plan")).toEqual([]);
  });

  it("refuses a deployment that is not live", async () => {
    const h = await moveHarness();
    await rm(join(h.paths.files.tfstateDir, "prod.tfstate"));
    const error = await caught(run(h));
    expect(error.message).toContain("no live deployment");
  });

  it("changes nothing when the summary is not confirmed", async () => {
    const h = await moveHarness();
    const error = await caught(run(h, { confirmStart: async () => false }));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toBe("The move was not started. Nothing was changed.");
    expect(await move(h)).toBeUndefined();
    expect((await readArtifact("plan", h.paths.files.plan)).target.provider).toBe("hetzner");
  });

  it("uses the option the user picked", async () => {
    const h = await moveHarness();
    const result = await run(h, { option: "digitalocean-single-s-2vcpu-4gb-fra1" });
    expect(result.step).toBe("switched");
    const plan = await readArtifact("plan", h.paths.files.plan);
    expect(plan.target).toMatchObject({ serverType: "s-2vcpu-4gb" });
    const error = await caught(run(await moveHarness(), { choose: async () => "no-such-option" }));
    expect(error.code).toBe("INVALID_INPUT");
  });

  it("stops before approval when the new server's plan fails a security policy", async () => {
    const h = await moveHarness();
    h.engine.planJsonFor = (effect) =>
      effect.creates.length > 0
        ? planJsonFor({ provider: "digitalocean", openDatabasePort: true })
        : effect.planJson;
    const error = await caught(run(h));
    expect(error.message).toContain("security");
    expect(trail(h.events).filter((line) => line.startsWith("apply"))).toEqual(["apply moves=3"]);
    expect((await move(h))?.step).toBe("renamed");
  });

  it("a size the new provider cannot create says to abort and start again, never `opscrew design`", async () => {
    const h = await moveHarness();
    h.engine.failApply = (effect) =>
      effect.creates.length > 0
        ? 'Error: Error creating droplet: POST https://api.digitalocean.com/v2/droplets: 422 (request "r1") Size is not available in this region.'
        : undefined;
    const error = await caught(run(h));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.hint).toMatch(/^DigitalOcean cannot create a \S+ Droplet in \S+ right now /);
    expect(error.hint).toContain(
      "Run `opscrew retarget --abort` (your app keeps running on the old server), then start the move again and pick another option: `opscrew retarget --to digitalocean --option <id>`. Nothing that was already created is removed until you abort.",
    );
    expect(error.hint).not.toContain("opscrew design");
    expect((await move(h))?.step).toBe("renamed");
  });

  it("stops when the rename would change more than the state (drift)", async () => {
    const h = await moveHarness();
    h.engine.state.servers = {};
    const error = await caught(run(h));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("would do more than rename resources");
    expect(error.hint).toContain("opscrew retarget --abort");
    expect(applies(h)).toHaveLength(0);
  });

  it("never prints tokens, the database password or dump contents", async () => {
    const h = await moveHarness();
    const row = fakeSecret("generic-password", "row");
    h.hosts.fail = (ip, op) =>
      op === "restore" && ip === h.newServer.ipv4
        ? fail(
            `pg_restore: error: could not execute query\nDETAIL: Key (email)=(alice@example.com, ${row}) already exists.\nCommand was: COPY public.users (email, secret) FROM stdin;`,
          )
        : undefined;
    await caught(run(h));
    const printed = everythingPrinted(h);
    expect(printed).toContain("could not execute query");
    for (const secret of [row, "alice@example.com", STRIPE, ...Object.values(TOKENS)]) {
      expect(printed).not.toContain(secret);
    }
    const generated = await readFile(join(h.paths.projectHomeDir, "generated_values.json"), "utf8");
    const password = (JSON.parse(generated) as { dbPassword: string }).dbPassword;
    expect(password.length).toBeGreaterThan(8);
    expect(printed).not.toContain(password);
  });
});
