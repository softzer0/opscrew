/**
 * The user's Portainer for the snapshot commands' tests: the app's stack in a fake Docker reached
 * through the fake Portainer's Docker proxy, its containers' commands played on the snapshots
 * volume: a list, a probe, a deletion, a snapshot's folder, the parts' copies and its finish, which
 * runs under `sh` on a copy of the folder so its `about.json` is the real one.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { TarEntry } from "@opscrew/connector-docker";
import {
  type FakeContainer,
  FakeDocker,
  type FakeFile,
  type FakeRun,
  parseTar,
} from "@opscrew/connector-docker/testing";
import { type PinnedStream, portainerClient } from "@opscrew/connector-portainer";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES, portainerSnapshotsVolume, portainerStackName } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { recordPortainerConnection } from "../../shared";
import { generatedValuesFile } from "../../shared/app-secrets";
import {
  createTestPhaseDeps,
  fakeCertificate,
  fakePortainer,
  PORTAINER_URL,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
} from "../../testing";
import type { SnapshotServices } from "../types";
import { fakeRuns, gitRemote } from "./world";

export const PORTAINER_TOKEN = fakeSecret("generic-password", "portainer token");
export const DB_SECRET = fakeSecret("generic-password", "portainer db password");
export const CACHE_SECRET = fakeSecret("generic-password", "portainer cache password");
const CERT = fakeCertificate();

/** True when `sh` runs here (Git's on Windows), which the finish needs. */
export const SH = spawnSync("sh", ["-c", "exit 0"]).status === 0;

/** A file in a fake volume, root's, mode 600. */
function file(data: string | Buffer): FakeFile {
  return { type: "file", mode: 0o600, uid: 0, gid: 0, data: Buffer.from(data) };
}

const FOLDER: FakeFile = { type: "dir", mode: 0o700, uid: 0, gid: 0 };

export interface PortainerWorld {
  deps: TestPhaseDeps;
  plan: DeployPlan;
  docker: FakeDocker;
  services: SnapshotServices;
  handler: ScriptedApprovalHandler;
  /** The snapshots volume's files, by path inside it. */
  volume(): Map<string, FakeFile>;
  /** Every container that started, as it started. */
  ran: FakeContainer[];
  /** Every archive put into a container, by its entries. */
  puts: TarEntry[][];
  /** The probe's disk, in KiB; `version` the running image's 64 hex digits. */
  probe: { totalKb: number; freeKb: number; version?: string };
  /** How the next copy of each part ends (exit code), by its file; 0 by default. */
  copies: Map<string, number>;
  /** Writes `about` as the snapshot `id`'s `about.json`, with `offsite.done` when `offsite`. */
  store(id: string, about: object, offsite?: boolean): void;
}

/** A container of the app's stack, with its named volume `<stack>_<service>_data` at `target`. */
function stackContainer(
  docker: FakeDocker,
  stack: string,
  service: string,
  target: string | undefined,
  image: string,
): FakeContainer {
  const id = `${stack}-${service}`.padEnd(64, "0");
  const volume = `${stack}_${service}_data`;
  const container: FakeContainer = {
    id,
    name: `${stack}-${service}-1`,
    image,
    cmd: [],
    // What a stack container holds in Docker; the snapshot never reads it.
    env: service === "db" ? [`POSTGRES_PASSWORD=${DB_SECRET}`] : [],
    labels: { "com.docker.compose.project": stack, "com.docker.compose.service": service },
    binds: target === undefined ? [] : [`${volume}:${target}`],
    mounts: [],
    state: "running",
    exitCode: 0,
    stdout: "",
    stderr: "",
  };
  docker.containers.set(id, container);
  if (target !== undefined) docker.addVolume(volume, { "data.bin": file(`${service} data`) });
  return container;
}

/**
 * Runs the finish script on a copy of the folder `<id>.taking` of `files` in a temp folder
 * (`chown` a no-op), and returns the finished folder `<id>`'s files.
 */
function finish(
  script: string,
  files: Map<string, FakeFile>,
): { run: FakeRun; finished?: [string, FakeFile][] } {
  const root = mkdtempSync(join(tmpdir(), "opscrew-snapshots-volume-")).replace(/\\/g, "/");
  const id = /\/snapshots\/([0-9A-Za-z]+)\.taking/.exec(script)?.[1] ?? "";
  mkdirSync(join(root, `${id}.taking`));
  for (const [path, entry] of files) {
    if (entry.type === "file" && path.startsWith(`${id}.taking/`)) {
      writeFileSync(join(root, path), entry.data ?? Buffer.alloc(0));
    }
  }
  const run = spawnSync("sh", ["-c", `chown() { :; }\n${script.replaceAll("/snapshots", root)}`], {
    encoding: "utf8",
  });
  if (run.status !== 0) return { run: { exitCode: run.status ?? 1, stderr: run.stderr } };
  const finished: [string, FakeFile][] = readdirSync(join(root, id)).map((name) => [
    `${id}/${name}`,
    file(readFileSync(join(root, id, name))),
  ]);
  return { run: { exitCode: 0 }, finished };
}

/** Removes `folder` and everything in it from `files`. */
function removeFolder(files: Map<string, FakeFile>, folder: string): void {
  for (const path of [...files.keys()]) {
    if (path === folder || path.startsWith(`${folder}/`)) files.delete(path);
  }
}

/**
 * The staging environment of `plan` in the user's Portainer: its stack's `app`, `db` (with its
 * data volume) and `kafka` (with its log volume) running, this computer's generated values holding
 * the services' secrets, and the snapshots volume (none with `volume: false`).
 */
export async function portainerWorld(
  plan: DeployPlan,
  o: {
    answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
    volume?: boolean;
    /** The last apply recorded the snapshots volume among the stack's (default true). */
    recorded?: boolean;
  } = {},
): Promise<PortainerWorld> {
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({
    environment: "staging",
    approvalHandler: handler,
    runner: gitRemote(),
  });
  deps.env = { ...deps.env, PORTAINER_API_KEY: PORTAINER_TOKEN };
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await recordPortainerConnection(deps.paths, {
    url: PORTAINER_URL,
    certFingerprint: CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "tunnel" },
    created: {
      stacks: [],
      volumes: o.recorded === false ? [] : [portainerSnapshotsVolume(plan)],
    },
  });
  await mkdir(deps.paths.projectHomeDir, { recursive: true });
  await writeFile(
    generatedValuesFile(deps),
    JSON.stringify({ dbPassword: DB_SECRET, services: { cache: { password: CACHE_SECRET } } }),
  );
  const portainer = fakePortainer({ token: PORTAINER_TOKEN });
  const docker = new FakeDocker();
  const stack = portainerStackName(plan);
  const snapshots = portainerSnapshotsVolume(plan);
  if (o.volume !== false) docker.addVolume(snapshots);
  stackContainer(docker, stack, "app", undefined, "ghcr.io/acme/shop@sha256:1");
  stackContainer(docker, stack, "db", "/var/lib/postgresql/data", IMAGES.postgres.ref);
  stackContainer(docker, stack, "kafka", "/var/lib/kafka/data", "apache/kafka");
  const puts: TarEntry[][] = [];
  const stream: PinnedStream = async (init) => {
    const prefix = "/api/endpoints/3/docker";
    let body = init.body;
    if (init.method === "PUT" && body instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      const archive = Buffer.concat(chunks);
      puts.push(parseTar(archive));
      body = Readable.from([archive], { objectMode: false });
    }
    return docker.request({
      method: init.method,
      path: init.path.slice(prefix.length),
      headers: init.headers,
      ...(body !== undefined ? { body } : {}),
    });
  };
  const files = () => docker.volumes.get(snapshots)?.files ?? new Map<string, FakeFile>();
  const world: PortainerWorld = {
    deps,
    plan,
    docker,
    handler,
    services: {
      github: fakeRuns(),
      portainer: {
        client: (endpoint, token, clientDeps) =>
          portainerClient(endpoint, token, { ...clientDeps, request: portainer.request, stream }),
      },
    },
    volume: files,
    ran: [],
    puts,
    probe: { totalKb: 41_943_040, freeKb: 20_971_520 },
    copies: new Map(),
    store(id, about, offsite = false) {
      files().set(id, FOLDER);
      files().set(`${id}/about.json`, file(`${JSON.stringify(about)}\n`));
      if (offsite) files().set(`${id}/offsite.done`, file(""));
    },
  };
  docker.onStart = (container) => {
    // A stack's service runs again once started, keeping its health check's answer.
    if (container.labels["com.docker.compose.service"] !== undefined) {
      return { exitCode: 0, state: "running" } as FakeRun;
    }
    world.ran.push({ ...container });
    const script = container.cmd[2] ?? "";
    const volume = files();
    if (script.includes('cat "$d"/about.json')) {
      const ids = [...volume.keys()].filter(
        (path) => path !== "" && !path.includes("/") && !/\.(partial|taking)$/.test(path),
      );
      const lines = ids.flatMap((id) => [
        (volume.get(`${id}/about.json`)?.data?.toString() ?? "").trim(),
        ...(volume.has(`${id}/offsite.done`) ? [`offsite ${id}`] : []),
      ]);
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    }
    if (script.startsWith("df -Pk")) {
      const id = /\[ -e \/snapshots\/([0-9A-Za-z]+) \]/.exec(script)?.[1] ?? "";
      const { totalKb, freeKb, version } = world.probe;
      const lines = [
        `disk ${totalKb} ${freeKb}`,
        ...(version === undefined ? [] : [`version ${version}`]),
        ...(volume.has(id) ? ["taken"] : []),
      ];
      return { exitCode: 0, stdout: lines.join("\n") };
    }
    const deletion = /^\[ -d \/snapshots\/([0-9A-Za-z]+) \]/.exec(script)?.[1];
    if (deletion !== undefined) {
      if (!volume.has(deletion)) return { exitCode: 5 };
      removeFolder(volume, deletion);
      return { exitCode: 0 };
    }
    const begun = /mkdir \/snapshots\/([0-9A-Za-z]+\.taking)/.exec(script)?.[1];
    if (begun !== undefined) {
      volume.set(begun, FOLDER);
      return { exitCode: 0 };
    }
    const copy = /(?:-cf |t=)\/snapshots\/([0-9A-Za-z]+\.taking)\/([a-z0-9.-]+?)(?:\.tmp)?(?: |\n)/.exec(
      script,
    );
    if (copy !== null) {
      const name = copy[2] ?? "";
      const exitCode = world.copies.get(name) ?? 0;
      if (exitCode === 0) volume.set(`${copy[1]}/${name}`, file(`copy of ${name}`));
      return { exitCode };
    }
    if (script.startsWith("set -e\n{")) {
      if (!SH) return { exitCode: 0 };
      const id = /\/snapshots\/([0-9A-Za-z]+)\.taking/.exec(script)?.[1] ?? "";
      const { run, finished } = finish(script, volume);
      if (finished === undefined) return run;
      removeFolder(volume, `${id}.taking`);
      volume.set(id, FOLDER);
      for (const [path, entry] of finished) volume.set(path, entry);
      return run;
    }
    const cleanup = /^rm -rf \/snapshots\/([0-9A-Za-z]+\.taking)$/.exec(script)?.[1];
    if (cleanup !== undefined) {
      removeFolder(volume, cleanup);
      return { exitCode: 0 };
    }
    return undefined;
  };
  return world;
}
