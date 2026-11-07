import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { type FakeContainer, FakeDocker } from "@opscrew/connector-docker/testing";
import { type PinnedStream, portainerClient } from "@opscrew/connector-portainer";
import { errorMessage, generateAgeIdentity } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR } from "../../provision/portainer";
import { OFFSITE_KEY_VARS } from "../../provision/storage";
import type { PortainerServices } from "../../provision/types";
import { sopsConfigFile } from "../../secrets/store";
import {
  type PortainerConnection,
  readPortainerConnection,
  recordPortainerConnection,
} from "../../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeGitHub,
  fakeCertificate,
  fakePortainer,
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerPlan,
  projectRunner,
  ScriptedApprovalHandler,
  testPlan,
} from "../../testing";
import type { MoveSession } from "../session";
import { portainerSide } from "./portainer";

const TOKEN = fakeSecret("generic-password", "portainer-token");
const DB_PASSWORD = fakeSecret("generic-password", "stack db password");
const STRIPE = fakeSecret("stripe-live-key");
const REPO_TOKEN = fakeSecret("github-pat", "repository read token");
const GHCR_TOKEN = fakeSecret("github-token", "ghcr read token");
const CERT = fakeCertificate();
const IMAGE = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;
const STACK = "opscrew-shop";
const OFFSITE_KEY = {
  accessKeyId: fakeSecret("aws-access-key-id", "offsite"),
  secretAccessKey: fakeSecret("aws-secret-access-key", "offsite"),
};

interface HarnessOptions {
  /** The plan's off-server copy of its snapshots, its key in the environment. */
  offsite?: NonNullable<DeployPlan["snapshots"]>["offsite"];
  /** The side under test (default: the new one). */
  which?: "new" | "old";
  /** The image is public, as the user said; the record doesn't say. */
  publicImage?: boolean;
  /** No connection is recorded on this computer. */
  unrecorded?: boolean;
  /** The move comes from another Portainer environment (default: a Hetzner server). */
  fromPortainer?: boolean;
  /** The environment's type in Portainer (default 1, a Docker host; 4 or 7 an Edge Agent). */
  environmentType?: number;
  interactive?: boolean;
  approve?: string;
  /** Docker calls through the proxy that Portainer refuses with this status. */
  refuse?: { path: RegExp; status: 401 | 403 };
  answer?: (request: { kind: string }) => boolean;
}

/** A container of the app's stack as Portainer's deploy leaves it, with its named volumes. */
function stackContainer(
  docker: FakeDocker,
  service: string,
  binds: string[] = [],
  project = STACK,
): FakeContainer {
  const id = `${project}-${service}`.padEnd(64, "0");
  const container: FakeContainer = {
    id,
    name: `${project}-${service}-1`,
    image: service === "app" ? IMAGE : IMAGES.postgres.ref,
    cmd: [],
    // What a stack container holds in Docker; the side never reads it.
    env: service === "db" ? [`POSTGRES_PASSWORD=${DB_PASSWORD}`] : [],
    labels: { "com.docker.compose.project": project, "com.docker.compose.service": service },
    binds,
    mounts: [],
    state: "running",
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  docker.containers.set(id, container);
  for (const bind of binds) {
    const volume = bind.split(":")[0] ?? "";
    if (!docker.volumes.has(volume)) {
      docker.addVolume(
        volume,
        { "data.bin": { type: "file", mode: 0o600, uid: 999, gid: 999, data: Buffer.alloc(2048) } },
        { "com.docker.compose.project": project },
      );
    }
  }
  return container;
}

async function harness(options: HarnessOptions = {}) {
  const base = portainerPlan({ web: { mode: "caddy" }, redeploy: "updater" });
  // The new side of a move from a Hetzner server, with a worker beside the app.
  const plan: DeployPlan = DeployPlanSchema.parse({
    ...base,
    processes: {
      ...base.processes,
      workers: [{ name: "worker", command: "node worker.js", source: "user" }],
    },
    retarget: {
      from: {
        target: options.fromPortainer
          ? portainerPlan({ web: { mode: "caddy" }, environmentId: 5 }).target
          : testPlan({ provider: "hetzner" }).target,
      },
      step: "created",
      startedAt: "2026-11-05T12:00:00.000Z",
    },
    ...(options.offsite !== undefined ? { snapshots: { offsite: options.offsite } } : {}),
  });
  const project = await createProject(plan);
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const portainer = fakePortainer({
    token: TOKEN,
    ...(options.environmentType !== undefined ? { environmentType: options.environmentType } : {}),
  });
  const docker = new FakeDocker();
  docker.images.add(IMAGES.busybox.ref);
  const app = { healthy: true };
  const ran: FakeContainer[] = [];
  docker.onStart = (container) => {
    ran.push({ ...container });
    if (container.cmd[0] === "wget") return { exitCode: app.healthy ? 0 : 1 };
    return undefined;
  };
  stackContainer(docker, "app", [`${STACK}_sqlite:/data`]);
  stackContainer(docker, "worker");
  stackContainer(docker, "db", [`${STACK}_db_data:/var/lib/postgresql/data`]);
  stackContainer(docker, "caddy", [
    `${STACK}_caddy_data:/data`,
    `${STACK}_version:/srv/version:ro`,
  ]);
  // Another app's stack in the same environment: never touched.
  stackContainer(docker, "app", ["opscrew-other_sqlite:/data"], "opscrew-other");

  const proxyCalls: string[] = [];
  const stream: PinnedStream = async (init) => {
    const prefix = "/api/endpoints/3/docker";
    proxyCalls.push(`${init.method} ${init.path}`);
    const refused = options.refuse;
    if (init.headers["X-API-Key"] !== TOKEN || refused?.path.test(init.path)) {
      return {
        status: refused?.status ?? 401,
        headers: { "content-type": "application/json" },
        body: Readable.from([Buffer.from('{"message":"Access denied to resource"}')], {
          objectMode: false,
        }),
      };
    }
    return docker.request({
      method: init.method,
      path: init.path.slice(prefix.length),
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  };
  const services: PortainerServices = {
    client: (endpoint, token, clientDeps) =>
      portainerClient(endpoint, token, { ...clientDeps, request: portainer.request, stream }),
    inspectCertificate: async () => CERT,
    randomUUID: () => "6f1c2d3e-4a5b-4c6d-8e7f-901a2b3c4d5e",
    wait: { now: () => 0, sleep: async () => undefined },
  };
  const handler = new ScriptedApprovalHandler((item) => options.answer?.(item) ?? true);
  const inherited = { ...process.env };
  for (const name of ["PORTAINER_API_KEY", REPOSITORY_TOKEN_VAR, REGISTRY_TOKEN_VAR]) {
    delete inherited[name];
  }
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...inherited,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      OPSCREW_APP_ENV_FILE: "production.env",
      PORTAINER_API_KEY: TOKEN,
      [REPOSITORY_TOKEN_VAR]: REPO_TOKEN,
      [REGISTRY_TOKEN_VAR]: GHCR_TOKEN,
      [OFFSITE_KEY_VARS.accessKeyId]: OFFSITE_KEY.accessKeyId,
      [OFFSITE_KEY_VARS.secretAccessKey]: OFFSITE_KEY.secretAccessKey,
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  deps.interactive = options.interactive ?? true;
  await recordPortainerConnection(deps.paths, {
    url: PORTAINER_URL,
    certFingerprint: CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "caddy" },
  });
  const github = new FakeGitHub();
  let monotonic = 0;
  const session = {
    deps,
    plan,
    command: "opscrew retarget",
    approve: options.approve,
    services: {
      sleep: async (ms: number) => {
        monotonic += ms;
      },
      now: () => monotonic,
    },
    github: { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
    githubApi: github,
    git: {
      remoteBranchSha: async (branch: string) => (github.holds.has(branch) ? "c" : undefined),
    },
    cloudflare: undefined,
    requirements: undefined,
    deployKey: { publicKeyOpenSsh: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOpscrewTestKey opscrew" },
    committedRender: {},
    builderBranch: undefined,
    site: { edge: {}, values: {} },
  } as unknown as MoveSession;
  const side = portainerSide({
    which: options.which ?? "new",
    record: {
      read: async () =>
        options.unrecorded === true ? undefined : readPortainerConnection(deps.paths),
      write: (connection: PortainerConnection) => recordPortainerConnection(deps.paths, connection),
    },
    image: async () => IMAGE,
    ...(options.publicImage !== undefined ? { publicImage: options.publicImage } : {}),
    services,
  });
  /** Everything that left the side: output, audit entries and the containers it ran. */
  const visible = () =>
    JSON.stringify([
      deps.reporter.lines,
      deps.audit.entries,
      ran.map((container) => [container.env, container.cmd, container.labels]),
      handler.requests.map((item) => [item.title, item.details]),
    ]);
  return {
    plan,
    deps,
    docker,
    portainer,
    github,
    handler,
    session,
    side,
    app,
    ran,
    proxyCalls,
    visible,
  };
}

const containerOf = (docker: FakeDocker, project: string, service: string) =>
  [...docker.containers.values()].find(
    (container) =>
      container.labels["com.docker.compose.project"] === project &&
      container.labels["com.docker.compose.service"] === service,
  );
const stateOf = (docker: FakeDocker, project: string, service: string) =>
  containerOf(docker, project, service)?.state;
const idOf = (docker: FakeDocker, project: string, service: string) =>
  containerOf(docker, project, service)?.id;

describe("the Portainer side of a move", () => {
  it("refuses an Edge Agent environment at its inspection, before any change", async () => {
    for (const environmentType of [4, 7]) {
      const h = await harness({ environmentType });
      const error = await h.side.prepare(h.session).catch((caught: unknown) => caught);
      expect(errorMessage(error)).toContain("is an Edge agent environment");
      expect(errorMessage(error)).toContain("so it changed nothing");
      expect(h.portainer.mutations()).toEqual([]);
      expect(h.proxyCalls).toEqual([]);
    }
  });

  it("says how to give the new side's Portainer when this computer has no record of it", async () => {
    const h = await harness({ unrecorded: true });
    const error = await h.side.prepare(h.session).catch((caught: unknown) => caught);
    expect(errorMessage(error)).toContain("so it changed nothing");
    expect(JSON.stringify(error)).toContain("Answer the Portainer questions for the new side");
    expect(JSON.stringify(error)).toContain("--answers");
    expect(h.portainer.calls).toEqual([]);
  });

  it("deploys a public image without a registry entry when the user said so", async () => {
    const priv = await harness();
    await priv.side.deploy(priv.session);
    expect(priv.portainer.registries).toHaveLength(1);
    const pub = await harness({ publicImage: true });
    await pub.side.deploy(pub.session);
    expect(pub.portainer.registries).toEqual([]);
    expect((await readPortainerConnection(pub.deps.paths))?.publicImage).toBe(true);
  });

  it("checks the environment and the stacks at prepare without changing anything", async () => {
    const h = await harness();
    expect(await h.side.prepare(h.session)).toBeUndefined();
    expect(h.portainer.mutations()).toEqual([]);
    expect(h.github.holds.size).toBe(0);
  });

  it("deploys the old side's image through a stack plan approved by hash, checks the app and stops Caddy", async () => {
    const h = await harness();
    expect(await h.side.deploy(h.session)).toBeUndefined();

    // The deploy branch holds the app's stack with the image the old side runs.
    const branch = h.github.holds.get("opscrew-deploy");
    expect(branch?.path).toBe("compose.yaml");
    expect(branch?.content).toContain(`image: ${IMAGE}`);
    expect(branch?.content).not.toContain("__OPSCREW_APP_IMAGE__");
    const kinds = h.handler.requests.map((item) => item.kind);
    expect(kinds).toEqual(["git-push", "stack-apply"]);
    const stackApproval = h.handler.requests[1];
    expect(stackApproval?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.portainer.stacks.map((stack) => stack.Name).sort()).toEqual([
      STACK,
      `${STACK}-updater`,
    ]);
    // The health check ran on the stack's network; then the stack's Caddy stopped.
    const check = h.ran.find((container) => container.cmd[0] === "wget");
    expect(check?.network).toBe(`${STACK}_internal`);
    expect(check?.cmd.at(-1)).toBe(`http://app:${h.plan.app.port}${h.plan.app.healthPath}`);
    expect(stateOf(h.docker, STACK, "caddy")).toBe("exited");
    expect(stateOf(h.docker, STACK, "app")).toBe("running");
    // What OpsCrew created is recorded for --finish and --abort.
    const recorded = await readPortainerConnection(h.deps.paths);
    expect(recorded?.created.stacks.map((stack) => stack.role).sort()).toEqual(["app", "updater"]);
  });

  it("stops a script at the stack plan until --approve names its hash, with nothing changed", async () => {
    const h = await harness({ interactive: false });
    const stop = await h.side.deploy(h.session);
    expect(stop?.done).toBe(false);
    expect(stop?.pendingPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stop?.next.join(" ")).toContain(`--approve ${stop?.pendingPlanHash}`);
    expect(h.portainer.mutations()).toEqual([]);
    expect(h.github.holds.size).toBe(0);
    expect(h.handler.requests).toEqual([]);
  });

  it("says when the app does not answer, and leaves Caddy running", async () => {
    const h = await harness();
    h.app.healthy = false;
    await expect(h.side.deploy(h.session)).rejects.toThrow("did not answer");
    expect(stateOf(h.docker, STACK, "caddy")).toBe("running");
  });

  it("stops and starts the app, its services and Caddy by Compose labels", async () => {
    const h = await harness();
    await h.side.stopApp(h.session);
    expect(stateOf(h.docker, STACK, "app")).toBe("exited");
    expect(stateOf(h.docker, STACK, "worker")).toBe("exited");
    expect(stateOf(h.docker, STACK, "db")).toBe("running");
    expect(stateOf(h.docker, STACK, "caddy")).toBe("running");
    expect(stateOf(h.docker, "opscrew-other", "app")).toBe("running");

    await h.side.stopServices(h.session, ["db"]);
    expect(stateOf(h.docker, STACK, "db")).toBe("exited");
    await h.side.stopEdge(h.session);
    expect(stateOf(h.docker, STACK, "caddy")).toBe("exited");

    const started = () =>
      h.docker.calls
        .filter((call) => /^POST \/containers\/[^/]+\/start$/.test(call))
        .map((call) => call.split("/")[2] ?? "");
    await h.side.startServices(h.session, ["db"]);
    expect(started()).toEqual([idOf(h.docker, STACK, "db")]);
    await h.side.startApp(h.session);
    await h.side.startEdge(h.session);
    expect(started()).toEqual(
      ["db", "app", "worker", "caddy"].map((service) => idOf(h.docker, STACK, service)),
    );
    expect(h.portainer.mutations()).toEqual([]);
  });

  it("lists the app's volumes and its services' by their path in the container, with their sizes", async () => {
    const h = await harness();
    expect(await h.side.volumes(h.session)).toEqual([
      {
        owner: "app",
        key: "/data",
        source: { kind: "volume", name: `${STACK}_sqlite` },
        bytes: 2048,
      },
      {
        owner: "db",
        key: "/var/lib/postgresql/data",
        source: { kind: "volume", name: `${STACK}_db_data` },
        bytes: 2048,
      },
    ]);
  });

  it("opens the Docker API through Portainer's proxy, with the pinned carrier", async () => {
    const h = await harness();
    const docker = await h.side.docker(h.session);
    expect(await docker.carrier.volumeDigest({ kind: "volume", name: `${STACK}_db_data` })).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(h.proxyCalls.every((call) => call.includes("/api/endpoints/3/docker/"))).toBe(true);
    await docker.close();
  });

  it("words Portainer's 401 and 403 with PORTAINER_API_KEY and what a standard user's token reaches", async () => {
    const forbidden = await harness({ refuse: { path: /\/stop/, status: 403 } });
    const error = await forbidden.side
      .stopApp(forbidden.session)
      .catch((caught: unknown) => caught);
    expect(errorMessage(error)).toContain("PORTAINER_API_KEY");
    expect(errorMessage(error)).toContain(
      "a standard user's token reaches only the containers of the stacks that user deployed",
    );

    const rejected = await harness({ refuse: { path: /containers\/json/, status: 401 } });
    const denied = await rejected.side.volumes(rejected.session).catch((caught: unknown) => caught);
    expect(errorMessage(denied)).toContain("rejected the access token (PORTAINER_API_KEY)");
  });

  it("removes only the app's stacks and volumes after the typed name, never the environment", async () => {
    const h = await harness();
    await h.side.deploy(h.session);
    const recorded = await readPortainerConnection(h.deps.paths);
    for (const name of recorded?.created.volumes ?? []) {
      h.portainer.volumes.push({ Name: name, Labels: { "com.docker.compose.project": STACK } });
    }
    h.portainer.volumes.push({
      Name: "opscrew-other_sqlite",
      Labels: { "com.docker.compose.project": "opscrew-other" },
    });

    // The typed name refused: nothing changes.
    await expect(h.side.remove(h.session, async () => false)).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("nothing was changed."),
    });
    expect(h.portainer.stacks).toHaveLength(2);
    // The typed name is audited, refused or confirmed, as on the other sides.
    const typedNames = () =>
      h.deps.audit.entries
        .filter((entry) => entry.action === "destroy-confirm")
        .map((entry) => entry.decision);
    expect(typedNames()).toEqual(["refused"]);

    const previews: { name: string; stackChanges?: string[] }[] = [];
    expect(
      await h.side.remove(h.session, async (preview) => {
        previews.push(preview);
        return true;
      }),
    ).toBeUndefined();
    expect(previews[0]?.name).toBe("shop");
    expect(typedNames()).toEqual(["refused", "approved"]);
    const teardown = h.handler.requests.at(-1);
    expect(teardown).toMatchObject({
      kind: "stack-apply",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(h.portainer.stacks).toEqual([]);
    expect(h.portainer.volumes.map((volume) => volume.Name)).toEqual(["opscrew-other_sqlite"]);
    expect(h.portainer.calls.filter((call) => /^DELETE \/api\/endpoints\/3$/.test(call))).toEqual(
      [],
    );
    expect((await readPortainerConnection(h.deps.paths))?.created.stacks).toEqual([]);
  });

  it("stops a script at the teardown until --approve and --confirm are given", async () => {
    const h = await harness();
    await h.side.deploy(h.session);
    h.deps.interactive = false;
    const stop = await h.side.remove(h.session, async () => true);
    expect(stop?.next.join(" ")).toContain(`--confirm shop --approve ${stop?.pendingPlanHash}`);
    expect(h.portainer.stacks).toHaveLength(2);

    // A stale hash (an earlier plan's) shows the plan again and changes nothing.
    h.session.approve = "f".repeat(64);
    const again = await h.side.remove(h.session, async () => true);
    expect(again?.pendingPlanHash).toBe(stop?.pendingPlanHash);
    const teardowns = () =>
      h.handler.requests.filter((r) => r.kind === "stack-apply" && r.allowDestroy === true);
    expect(teardowns()).toEqual([]);
    expect(h.portainer.stacks).toHaveLength(2);

    h.session.approve = stop?.pendingPlanHash;
    expect(await h.side.remove(h.session, async () => true)).toBeUndefined();
    expect(teardowns().map((r) => r.planHash)).toEqual([stop?.pendingPlanHash]);
    expect(h.session.approve).toBeUndefined();
    expect(h.portainer.stacks).toEqual([]);
  });

  it("fills the off-server copy's stack variables after a move, as provision does", async () => {
    const h = await harness({
      offsite: { provider: "hetzner", bucket: "shop-backups", region: "fsn1" },
    });
    const { recipient } = generateAgeIdentity();
    const sops = sopsConfigFile([recipient]);
    await writeFile(join(h.deps.paths.root, sops.path), sops.content);
    expect(await h.side.deploy(h.session)).toBeUndefined();
    const app = h.portainer.stacks.find((stack) => stack.Name === STACK);
    const env = Object.fromEntries((app?.Env ?? []).map((pair) => [pair.name, pair.value]));
    expect(env).toMatchObject({
      OPSCREW_OFFSITE_ENDPOINT: "https://fsn1.your-objectstorage.com",
      OPSCREW_OFFSITE_ACCESS_KEY_ID: OFFSITE_KEY.accessKeyId,
      OPSCREW_OFFSITE_SECRET_ACCESS_KEY: OFFSITE_KEY.secretAccessKey,
      OPSCREW_OFFSITE_RECIPIENT: recipient,
    });
    expect(h.visible()).not.toContain(OFFSITE_KEY.secretAccessKey);
  });

  it("never shows the token, a password or Portainer's address", async () => {
    const h = await harness();
    await h.side.deploy(h.session);
    // The values the stacks got (the generated database password among them), sent only there.
    const sent = h.portainer.stacks
      .flatMap((stack) => stack.Env.map((pair) => pair.value))
      .filter((value) => value.length >= 12);
    expect(sent.length).toBeGreaterThan(0);
    await h.side.stopApp(h.session);
    await h.side.volumes(h.session);
    await h.side.remove(h.session, async () => true);
    const forbidden = await harness({ refuse: { path: /\/stop/, status: 403 } });
    const error = await forbidden.side
      .stopApp(forbidden.session)
      .catch((caught: unknown) => caught);
    const texts = [
      h.visible(),
      forbidden.visible(),
      `${errorMessage(error)} ${JSON.stringify(error)}`,
    ];
    for (const text of texts) {
      for (const secret of [
        TOKEN,
        DB_PASSWORD,
        STRIPE,
        REPO_TOKEN,
        GHCR_TOKEN,
        PORTAINER_HOST,
        ...sent,
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});
