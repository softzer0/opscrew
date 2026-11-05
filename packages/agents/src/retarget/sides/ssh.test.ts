import { readFile } from "node:fs/promises";
import { dockerClient, type MountSpec } from "@opscrew/connector-docker";
import { FakeDocker } from "@opscrew/connector-docker/testing";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { monitoredPlan } from "../../network/__fixtures__/plans";
import { ensureDeployKey } from "../../shared";
import {
  type MoveHarness,
  moveHarness,
  NEW_SERVERS,
  OLD_IPV4,
  OLD_IPV6,
  TOKENS,
} from "../../testing";
import type { MoveSession } from "../session";
import { cloudSide } from "./cloud";
import { fakeDialStdio } from "./ssh.fakes";

const NEW = NEW_SERVERS.digitalocean;
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/**
 * A move from the harness's Hetzner server to a DigitalOcean one, as recorded once the new server
 * exists, with the Docker API of each server behind a fake `ssh … docker system dial-stdio`.
 */
async function moving(h: MoveHarness) {
  const plan: DeployPlan = {
    ...h.plan,
    target: {
      provider: "digitalocean",
      mode: "vps-compose",
      location: "fra1",
      serverType: "s-2vcpu-4gb",
      image: "ubuntu-24-04-x64",
      backups: false,
      edge: "caddy",
    },
    retarget: {
      from: { target: h.plan.target, deploy: h.plan.deploy },
      step: "deployed",
      empty: [],
      startedAt: "2026-10-13T12:00:00.000Z",
    },
  };
  const docker = new FakeDocker();
  const streams = fakeDialStdio(docker);
  closers.push(streams.close);
  h.deps.streams = streams;
  const session = {
    deps: h.deps,
    services: h.services,
    plan,
    deployKey: await ensureDeployKey(h.paths, h.deps.redactor),
    servers: { from: { ipv4: OLD_IPV4, ipv6: OLD_IPV6 }, next: { ipv4: NEW.ipv4, ipv6: NEW.ipv6 } },
    command: "opscrew retarget",
    approve: undefined,
  } as unknown as MoveSession;
  return { session, docker, streams };
}

/** The server operations `ip` saw, in order. */
function ops(h: MoveHarness, ip: string): string[] {
  return h.events.flatMap((e) => (e.type === "remote" && e.host === ip ? [e.op] : []));
}

describe.skipIf(!findExecutable("git"))("a side over SSH", () => {
  it("opens the Docker API with ssh … docker system dial-stdio as deploy, never reusing a connection", async () => {
    const h = await moveHarness();
    const { session, docker, streams } = await moving(h);
    docker.addVolume("shop_sqlite");

    const side = await cloudSide("new").docker(session);
    expect((await side.client.listVolumes()).map((v) => v.name)).toEqual(["shop_sqlite"]);
    expect(await side.carrier.volumeDigest({ kind: "volume", name: "shop_sqlite" })).toMatch(
      /^[0-9a-f]{64}$/,
    );
    // Only the app's own data folder may be bound into a carrier.
    docker.addFolder("/srv/data/blog/db");
    await expect(
      side.carrier.volumeDigest({ kind: "bind", path: "/srv/data/blog/db" }),
    ).rejects.toThrow(/outside the folders OpsCrew may copy here \(\/srv\/data\/shop\/\)/);
    await side.close();

    const { command, args } = streams.opened[0] ?? { command: "", args: [] };
    expect(command).toBe("ssh");
    expect(args).toEqual(
      expect.arrayContaining([
        "-i",
        session.deployKey.privateKeyFile,
        "IdentitiesOnly=yes",
        "StrictHostKeyChecking=yes",
        `UserKnownHostsFile=${h.paths.files.knownHosts}`,
        "ControlMaster=no",
        "ControlPath=none",
        "ServerAliveInterval=15",
      ]),
    );
    expect(args.slice(-4)).toEqual(["-p", "22", `deploy@${NEW.ipv4}`, "docker system dial-stdio"]);
    // The carrier is the pinned busybox, pulled when the server lacks it.
    expect(docker.images).toEqual(new Set([IMAGES.busybox.ref]));
  });

  it("reaches the old server for the old side", async () => {
    const h = await moveHarness();
    const { session, streams } = await moving(h);
    const side = await cloudSide("old").docker(session);
    await side.client.listVolumes();
    await side.close();
    expect(streams.opened[0]?.args).toContain(`deploy@${OLD_IPV4}`);
  });

  it("stops and starts the app with its workers, its services and the edge, by Compose", async () => {
    const h = await moveHarness();
    const { session } = await moving(h);
    const side = cloudSide("old");
    await side.stopApp(session);
    await side.stopServices(session, ["db"]);
    await side.stopEdge(session);
    await side.startEdge(session);
    await side.startServices(session, ["db"]);
    await side.startApp(session);
    await side.stopServices(session, []);
    expect(ops(h, OLD_IPV4)).toEqual([
      "stop app",
      "cd /srv/apps/shop && docker compose stop db",
      "stop caddy",
      "start caddy",
      "cd /srv/apps/shop && docker compose up -d db",
      "start app",
    ]);
  });

  it("refuses a service the app's server does not run, before reaching it", async () => {
    const h = await moveHarness();
    const { session } = await moving(h);
    const error = await cloudSide("new")
      .stopServices(session, ["db", "search"])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "INTERNAL" });
    expect(ops(h, NEW.ipv4)).toEqual([]);
  });

  it("checks the app's health route", async () => {
    const h = await moveHarness();
    const { session } = await moving(h);
    const side = cloudSide("new");
    expect(await side.healthy(session)).toBe(false);
    h.hosts.host(NEW.ipv4).app = true;
    expect(await side.healthy(session)).toBe(true);
    expect(await cloudSide("old").healthy(session)).toBe(true);
  });

  it("deploy waits until the app answers, then stops the edge until the switch", async () => {
    const h = await moveHarness();
    const { session } = await moving(h);
    h.hosts.deploy(NEW.ipv4);
    expect(await cloudSide("new").deploy(session)).toBeUndefined();
    expect(ops(h, NEW.ipv4)).toEqual(["health", "stop caddy"]);
    expect(h.hosts.host(NEW.ipv4).caddy).toBe(false);
    expect(h.audit.entries.at(-1)).toMatchObject({
      kind: "remote-exec",
      action: "stop caddy",
      phase: "retarget",
      detail: "on the new Droplet, until traffic is switched to it",
    });
  });

  it("lists the app's data mounts by owner and path: volumes and its own data folders", async () => {
    const h = await moveHarness();
    const { session, docker } = await moving(h);
    const bytes = (n: number) => ({
      type: "file" as const,
      mode: 0o600,
      uid: 999,
      gid: 999,
      data: Buffer.alloc(n),
    });
    docker.addFolder("/srv/data/shop");
    docker.addFolder("/srv/data/shop/db", { PG_VERSION: bytes(3), "base/1": bytes(4096) });
    docker.addVolume("shop_sqlite", { "app.db": bytes(8192) });
    docker.addVolume("opscrew-monitoring_prometheus", { wal: bytes(100) });
    docker.addFolder("/srv/data/blog/db");
    docker.addFolder("/srv/apps/shop/crontab");
    docker.images.add("postgres:17").add("ghcr.io/acme/shop:1").add("prom/prometheus:3");
    const client = dockerClient(docker);
    const container = (project: string, service: string, mounts: MountSpec[]) =>
      client.createContainer({
        image:
          service === "db"
            ? "postgres:17"
            : service === "prometheus"
              ? "prom/prometheus:3"
              : "ghcr.io/acme/shop:1",
        labels: {
          "com.docker.compose.project": project,
          "com.docker.compose.service": service,
          "com.docker.compose.project.working_dir": `/srv/apps/${project}`,
        },
        mounts,
      });
    const db = {
      type: "bind" as const,
      source: "/srv/data/shop/db",
      target: "/var/lib/postgresql/data",
    };
    const sqlite = { type: "volume" as const, source: "shop_sqlite", target: "/app/data" };
    await container("shop", "db", [db]);
    await container("shop", "app", [
      sqlite,
      { type: "bind", source: "/srv/apps/shop/crontab", target: "/etc/crontab" },
    ]);
    await container("shop", "worker", [sqlite]);
    await container("blog", "db", [
      { type: "bind", source: "/srv/data/blog/db", target: "/var/lib/postgresql/data" },
    ]);
    await container("opscrew-monitoring", "prometheus", [
      { type: "volume", source: "opscrew-monitoring_prometheus", target: "/prometheus" },
    ]);

    const side = cloudSide("new");
    expect(await side.volumes(session)).toEqual([
      {
        owner: "app",
        key: "/app/data",
        source: { kind: "volume", name: "shop_sqlite" },
        bytes: 8192,
      },
      {
        owner: "db",
        key: "/var/lib/postgresql/data",
        source: { kind: "bind", path: "/srv/data/shop/db" },
        bytes: 4099,
      },
    ]);

    // With self-hosted monitoring on the app's server, its stack's volumes are listed too.
    const monitored = {
      ...session,
      plan: { ...session.plan, observability: monitoredPlan({ on: "app" }).observability },
    } as MoveSession;
    expect((await side.volumes(monitored)).map((v) => [v.owner, v.key])).toEqual([
      ["app", "/app/data"],
      ["db", "/var/lib/postgresql/data"],
      ["monitoring", "/prometheus"],
    ]);
  });

  it("names the server in words when a command fails, never its address", async () => {
    const h = await moveHarness();
    const { session } = await moving(h);
    h.hosts.fail = (_ip, op) =>
      op.endsWith("docker compose stop db")
        ? { exitCode: 255, stdout: "", stderr: `ssh: connect to host ${OLD_IPV4} port 22: refused` }
        : undefined;
    const error = (await cloudSide("old")
      .stopServices(session, ["db"])
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "Could not stop db on the old server: ssh: connect to host the old server port 22: refused.",
    );
    expect(`${error.message} ${error.hint}`).not.toContain(OLD_IPV4);
    expect(error.hint).toContain("docker compose ps");

    h.hosts.fail = (_ip, op) => (op === "stop app" ? new Error(`reset by ${OLD_IPV4}`) : undefined);
    const stop = (await cloudSide("old")
      .stopApp(session)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(stop.message).toContain("Could not stop the app on the old server");
    expect(`${stop.message} ${stop.hint}`).not.toContain(OLD_IPV4);
  });

  it("leaks no address, key or token into output, audit entries or errors", async () => {
    const h = await moveHarness();
    const { session, docker } = await moving(h);
    docker.addVolume("shop_sqlite");
    h.hosts.deploy(NEW.ipv4);
    const side = cloudSide("new");
    await side.deploy(session);
    await side.stopApp(session);
    await side.startApp(session);
    const opened = await side.docker(session);
    await opened.client.listContainers(["com.docker.compose.project=shop"]);
    await opened.close();
    docker.fail("GET", /^\/containers\/json/, 500, `dial ${NEW.ipv4}: refused`);
    const error = (await side.volumes(session).catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);

    const key = await readFile(session.deployKey.privateKeyFile, "utf8");
    const seen = `${h.reporter.text()}\n${JSON.stringify(h.audit.entries)}\n${error.message} ${error.hint}`;
    for (const secret of [NEW.ipv4, NEW.ipv6, OLD_IPV4, key.trim(), ...Object.values(TOKENS)]) {
      expect(seen).not.toContain(secret);
    }
  });
});
