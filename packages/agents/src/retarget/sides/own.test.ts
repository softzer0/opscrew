import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerClient } from "@opscrew/connector-docker";
import { FakeDocker, fakeDialStdio } from "@opscrew/connector-docker/testing";
import { type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { DestroyPreview } from "../../destroy/types";
import { monitoredPlan } from "../../network/__fixtures__/plans";
import {
  ensureDeployKey,
  type OwnServerConnectionInput,
  readServerAddresses,
  recordOwnServer,
  setAsideOldConnection,
} from "../../shared";
import {
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  FakeHosts,
  freshFacts,
  LAN_IPV4,
  type MoveEvent,
  movePlan,
  OLD_IPV4,
  OWN_IPV4,
  type OwnPlanOptions,
  ownCloudflare,
  ownPlan,
  ownRunner,
  preparedServerFacts,
  ScriptedApprovalHandler,
  withOtherApp,
} from "../../testing";
import type { MoveSession } from "../session";
import { prepareStep } from "../steps";
import { ownSide } from "./own";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** The new own server's login, its host key pinned. */
const NEW_LOGIN: OwnServerConnectionInput = {
  host: OWN_IPV4,
  port: 22,
  user: "root",
  agent: true,
  reachable: true,
  hostKey: ED25519_FINGERPRINT,
};
/** The old own server's login (a move between two servers of the user's). */
const OLD_LOGIN: OwnServerConnectionInput = {
  host: LAN_IPV4,
  port: 2222,
  user: "admin",
  agent: true,
  reachable: true,
  hostKey: ED25519_FINGERPRINT,
};

interface Setup {
  /** Where the app moves from: a cloud server (default) or another server the user owns. */
  from?: "cloud" | "own";
  interactive?: boolean;
  facts?: HostFacts;
  /** Behind Cloudflare's proxy (default true); false serves the domain with DNS only. */
  proxied?: boolean;
  /** More of the new side's plan. */
  own?: OwnPlanOptions;
}

/** What reading the server's edge answers: Caddy, with no origin certificate or site yet. */
const EDGE_READ = "opscrew-edge-read 1\nproxy=caddy\n--origin--\n--site--\n--end--";

/** Approves everything, typing the app's name for a deletion. */
function approveAll(request: ApprovalRequest) {
  return request.allowDestroy ? { approved: true, confirmation: request.confirmPhrase } : true;
}

/** A move to (or, with `from: "own"`, between) servers the user owns, at step `renamed`. */
async function moving(o: Setup = {}) {
  const old = o.from === "own" ? ownPlan().target : movePlan().target;
  const plan: DeployPlan = DeployPlanSchema.parse({
    ...ownPlan({ deployed: true, proxied: o.proxied ?? true, ...o.own }),
    retarget: {
      from: { target: old },
      step: "renamed",
      startedAt: "2026-10-14T12:00:00.000Z",
    },
  });
  const project = await createProject(plan);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
  };
  // The admin login reads the shared edge: it runs Caddy, the plan's proxy.
  const runner = ownRunner(undefined, (args) =>
    String(args.at(-1)).includes("opscrew-edge-read 1")
      ? { exitCode: 0, stdout: `${EDGE_READ}\n`, stderr: "" }
      : undefined,
  );
  const handler = new ScriptedApprovalHandler(approveAll);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner,
    approvalHandler: handler,
    interactive: o.interactive ?? true,
  });
  if (o.from === "own") {
    await recordOwnServer(deps.paths, OLD_LOGIN);
    await setAsideOldConnection(deps.paths, "own");
  }
  await recordOwnServer(deps.paths, NEW_LOGIN);
  const host = new FakeHostServer(o.facts ?? freshFacts());
  const events: MoveEvent[] = [];
  const hosts = new FakeHosts(events);
  const docker = new FakeDocker();
  const streams = fakeDialStdio(docker);
  closers.push(streams.close);
  deps.streams = streams;
  const confirmed: DestroyPreview[] = [];
  const confirm = async (preview: DestroyPreview) => {
    confirmed.push(preview);
    return true;
  };
  const session = {
    deps,
    plan,
    services: {
      cloudflare: ownCloudflare(),
      remote: hosts.remote,
      sleep: async () => undefined,
      now: () => 0,
    },
    deployKey: await ensureDeployKey(deps.paths, deps.redactor),
    servers: { from: { ipv4: OLD_IPV4 } },
    command: "opscrew retarget",
    approve: undefined,
  } as unknown as MoveSession;
  const services = { own: { host, homeDir: await mkdtemp(join(tmpdir(), "opscrew-own-home-")) } };
  return {
    deps,
    session,
    host,
    hosts,
    events,
    docker,
    streams,
    handler,
    runner,
    confirm,
    confirmed,
    services,
  };
}

/** The server operations `ip` saw, in order. */
function ops(events: readonly MoveEvent[], ip: string): string[] {
  return events.flatMap((e) => (e.type === "remote" && e.host === ip ? [e.op] : []));
}

describe.skipIf(!findExecutable("git"))("a side on a server the user owns", () => {
  it("prepare sets the app up beside other apps with the own host plan, approved by its hash", async () => {
    // The other app is served with DNS only, as this one is.
    const s = await moving({ facts: withOtherApp(), proxied: false });
    // prepareStep runs the side's prepare and records the step.
    Object.assign(s.session.services, s.services);
    expect(await prepareStep(s.session, {})).toBeUndefined();

    const approvals = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(approvals).toHaveLength(1);
    expect(s.host.applies.map((a) => a.plan.purpose)).toEqual(["setup"]);
    expect(s.host.applies[0]?.options.approvedHash).toBe(approvals[0]?.planHash);
    expect(s.host.applies[0]?.plan.app).toBe("shop");
    expect((await readArtifact("plan", s.deps.paths.files.plan)).retarget?.step).toBe("created");
    expect((await readServerAddresses(s.deps.paths)).retarget?.next).toEqual({ ipv4: OWN_IPV4 });
  });

  it("stops a script with the host plan's hash and applies it with --approve", async () => {
    const s = await moving({ interactive: false });
    const side = ownSide("new", s.services);
    const stop = await side.prepare(s.session);
    expect(stop).toMatchObject({ step: "renamed", done: false });
    const hash = stop?.pendingPlanHash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stop?.next.join(" ")).toContain(`opscrew retarget --approve ${hash}`);
    expect(s.host.applies).toHaveLength(0);

    s.session.approve = hash;
    expect(await side.prepare(s.session)).toBeUndefined();
    expect(s.session.approve).toBeUndefined();
    expect(s.host.applies.map((a) => a.options.approvedHash)).toEqual([hash]);
  });

  it("refuses what provision refuses, before any change", async () => {
    const s = await moving({ facts: freshFacts({ arch: "arm64" }) });
    const error = (await ownSide("new", s.services)
      .prepare(s.session)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Nothing was changed.");
    expect(s.host.applies).toHaveLength(0);
    expect(s.handler.requests.filter((r) => r.kind === "host-apply")).toHaveLength(0);
  });

  it("lists the monitoring stack's volumes only when the server's record says it is the app's", async () => {
    const s = await moving();
    const session = {
      ...s.session,
      plan: { ...s.session.plan, observability: monitoredPlan({ on: "app" }).observability },
    } as MoveSession;
    s.docker.addVolume("opscrew-monitoring_prometheus");
    s.docker.images.add("prom/prometheus:3");
    await dockerClient(s.docker).createContainer({
      image: "prom/prometheus:3",
      labels: {
        "com.docker.compose.project": "opscrew-monitoring",
        "com.docker.compose.service": "prometheus",
      },
      mounts: [{ type: "volume", source: "opscrew-monitoring_prometheus", target: "/prometheus" }],
    });
    const owned = (app: string) => {
      const facts = preparedServerFacts(s.deps.paths.projectId);
      return HostFactsSchema.parse({
        ...facts,
        record: { ...facts.record, addons: { monitoring: app } },
      });
    };
    const side = ownSide("new", s.services);

    s.host.facts = owned("blog");
    expect(await side.volumes(session)).toEqual([]);
    s.host.facts = owned("shop");
    expect((await side.volumes(session)).map((v) => [v.owner, v.key])).toEqual([
      ["monitoring", "/prometheus"],
    ]);
    // Without monitoring on the app's server, the server is not even inspected for it.
    const inspections = s.host.inspections;
    expect(await side.volumes(s.session)).toEqual([]);
    expect(s.host.inspections).toBe(inspections);
  });

  it("opens the Docker API as deploy at the login's address and port", async () => {
    const s = await moving({ from: "own" });
    for (const [which, login] of [
      ["new", NEW_LOGIN],
      ["old", OLD_LOGIN],
    ] as const) {
      const docker = await ownSide(which, s.services).docker(s.session);
      await docker.client.listVolumes();
      await docker.close();
      expect(s.streams.opened.at(-1)?.args.slice(-4)).toEqual([
        "-p",
        String(login.port),
        `deploy@${login.host}`,
        "docker system dial-stdio",
      ]);
    }
  });

  it("deploy stops the edge only while no other app on the server shares it", async () => {
    const s = await moving();
    s.hosts.deploy(OWN_IPV4);
    s.docker.images.add("ghcr.io/acme/blog:1");
    await dockerClient(s.docker).createContainer({
      image: "ghcr.io/acme/blog:1",
      labels: {
        "com.docker.compose.project": "blog",
        "com.docker.compose.project.working_dir": "/srv/apps/blog",
      },
    });
    const side = ownSide("new", s.services);
    await side.deploy(s.session);
    expect(ops(s.events, OWN_IPV4)).toEqual(["health"]);
    expect(s.deps.reporter.text()).toContain(
      "Caddy on your new server keeps running: other apps there use it too.",
    );
    await side.stopEdge(s.session);
    // Started again after the switch, the shared edge reloads, so the app's hostnames get their
    // certificates at once; it never stops.
    await side.startEdge(s.session);
    expect(ops(s.events, OWN_IPV4)).toEqual(["health", "reload edge"]);

    s.docker.containers.clear();
    await side.deploy(s.session);
    expect(ops(s.events, OWN_IPV4)).toEqual(["health", "reload edge", "health", "stop caddy"]);
  });

  it("remove takes only the app off the new server with its data at --abort, never undoing the host", async () => {
    const s = await moving();
    s.host.facts = preparedServerFacts(s.deps.paths.projectId);
    expect(await ownSide("new", s.services).remove(s.session, s.confirm)).toBeUndefined();

    expect(s.host.applies.map((a) => a.plan.purpose)).toEqual(["teardown"]);
    const teardown = s.host.applies[0]?.plan;
    expect(teardown?.app).toBe("shop");
    const request = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(request).toMatchObject({
      allowDestroy: true,
      confirmPhrase: "shop",
      planHash: s.host.applies[0]?.options.approvedHash,
    });
    expect(request?.details).toContain("Your server itself stays");
    expect(s.confirmed).toHaveLength(1);
    expect(s.confirmed[0]).toMatchObject({ name: "shop", provider: "own", resources: [] });
    expect(s.confirmed[0]?.hostSteps?.length).toBeGreaterThan(0);
    expect(s.confirmed[0]?.dataWarning).toContain("That is the move's copy");

    // Again: nothing of the app is left.
    expect(await ownSide("new", s.services).remove(s.session, s.confirm)).toBeUndefined();
    expect(s.host.applies).toHaveLength(1);
  });

  it("remove at --finish reaches the old server with its set-aside login", async () => {
    const s = await moving({ from: "own" });
    s.host.facts = preparedServerFacts(s.deps.paths.projectId);
    expect(await ownSide("old", s.services).remove(s.session, s.confirm)).toBeUndefined();
    expect(s.host.applies.map((a) => a.plan.purpose)).toEqual(["teardown"]);
    expect(s.runner.calls.find((c) => c.command === "ssh-keyscan")?.args).toContain(LAN_IPV4);
    expect(s.confirmed[0]?.dataWarning).toContain("The move copied it to the new side");
  });

  it("waits for --approve and the typed name in a script before a teardown", async () => {
    const s = await moving({ interactive: false });
    s.host.facts = preparedServerFacts(s.deps.paths.projectId);
    const side = ownSide("new", s.services);
    const stop = await side.remove(s.session, s.confirm);
    const hash = stop?.pendingPlanHash as string;
    expect(stop?.next.join(" ")).toContain(`--confirm shop --approve ${hash}`);
    expect(s.host.applies).toHaveLength(0);
    s.session.approve = hash;
    expect(await side.remove(s.session, s.confirm)).toBeUndefined();
    expect(s.host.applies.map((a) => a.options.approvedHash)).toEqual([hash]);
  });

  it("removes nothing when the app's name on the server is another project's", async () => {
    const s = await moving({ facts: withOtherApp({ app: "shop" }) });
    const error = (await ownSide("new", s.services)
      .remove(s.session, s.confirm)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("OpsCrew cannot remove shop from your new server");
    expect(s.confirmed).toHaveLength(0);
    expect(s.handler.requests.filter((r) => r.kind === "host-apply")).toHaveLength(0);
    expect(s.host.applies).toHaveLength(0);
  });

  it("changes nothing when the typed name is not confirmed", async () => {
    const s = await moving();
    s.host.facts = preparedServerFacts(s.deps.paths.projectId);
    const error = await ownSide("new", s.services)
      .remove(s.session, async () => false)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(s.host.applies).toHaveLength(0);
  });

  it("leaks no address or key into output, audit entries or errors", async () => {
    const s = await moving({ from: "own", facts: withOtherApp(), proxied: false });
    const side = ownSide("new", s.services);
    await side.prepare(s.session);
    s.hosts.deploy(OWN_IPV4);
    await side.deploy(s.session);
    s.hosts.fail = (_ip, op) =>
      op === "stop app" ? { exitCode: 255, stdout: "", stderr: `${OWN_IPV4}: refused` } : undefined;
    const error = (await side.stopApp(s.session).catch((e: unknown) => e)) as OpsCrewError;
    s.host.facts = preparedServerFacts(s.deps.paths.projectId);
    await ownSide("old", s.services).remove(s.session, s.confirm);

    const key = await readFile(s.session.deployKey.privateKeyFile, "utf8");
    const seen = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}\n${error.message} ${error.hint}`;
    for (const secret of [OWN_IPV4, LAN_IPV4, key.trim()]) expect(seen).not.toContain(secret);
  });
});
