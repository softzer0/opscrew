import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { DockerRequest, DockerResponse, DockerTransport } from "@opscrew/contracts";
import { type TarEntry, tarStream } from "../tar";
import { parseTar } from "./tar";

/** A file, folder or link in a fake volume. */
export type FakeFile = Omit<TarEntry, "name">;

/** A fake volume: its labels and its files by path inside it (`""` is its root folder). */
export interface FakeVolume {
  labels: Record<string, string>;
  files: Map<string, FakeFile>;
}

/** A fake container as `POST /containers/create` described it, and how its command ended. */
export interface FakeContainer {
  id: string;
  name?: string;
  image: string;
  cmd: string[];
  env: string[];
  labels: Record<string, string>;
  /** `HostConfig.Binds`, as given. */
  binds: string[];
  /** `HostConfig.Mounts`, as given. */
  mounts: FakeMount[];
  network?: string;
  state: "created" | "running" | "exited";
  /** Its health check's answer while it runs; absent without a health check. */
  health?: "starting" | "healthy" | "unhealthy";
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** One of `HostConfig.Mounts`: a named volume, or a host folder bound in. */
export interface FakeMount {
  type: string;
  source: string;
  target: string;
  readOnly?: boolean;
}

/** How a container's command ends when it starts. */
export interface FakeRun {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** A mount of either kind: a volume's name or a host folder's absolute path, at `target`. */
interface Mount {
  source: string;
  target: string;
  readOnly: boolean;
}

const ROOT: FakeFile = { type: "dir", mode: 0o755, uid: 0, gid: 0 };

/**
 * An in-memory Docker Engine API for tests: containers, volumes, host folders and images, with
 * archives as real tar streams. A started container runs to its end at once: the carrier's
 * commands (emptying, hashing and measuring what it mounts, and `test ! -L`) are built in, and
 * `onStart` answers any other.
 */
export class FakeDocker implements DockerTransport {
  readonly volumes = new Map<string, FakeVolume>();
  /**
   * The host's folders by absolute path. A `Binds` entry of a missing one creates it; a bind in
   * `Mounts` is refused, as Docker does.
   */
  readonly folders = new Map<string, FakeVolume>();
  /** The host paths that are symbolic links. */
  readonly symlinks = new Set<string>();
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Set<string>();
  /** Images whose pull fails, as a registry answers for one it doesn't know. */
  readonly unknownImages = new Set<string>();
  /** Every request, as `METHOD path`. */
  readonly calls: string[] = [];
  /** The request bodies that came as streams, in order. */
  readonly streamedBodies: Readable[] = [];
  /** The command's outcome for a container that starts; `undefined` falls back to the built-ins. */
  onStart?: (container: FakeContainer) => FakeRun | undefined;
  private readonly failures: { method: string; path: RegExp; status: number; message: string }[] =
    [];
  private nextId = 1;
  private brokenArchive: string | undefined;

  /** Makes the next `method` request whose path matches `path` answer `status` with `message`. */
  fail(method: string, path: RegExp, status: number, message: string): void {
    this.failures.push({ method, path, status, message });
  }

  /** Makes the next archive read fail after its first block with `message`, as a lost link does. */
  breakNextArchive(message: string): void {
    this.brokenArchive = message;
  }

  /** Adds a volume holding `files`, by path inside it; its root is a 755 folder of root's. */
  addVolume(
    name: string,
    files: Record<string, FakeFile> = {},
    labels: Record<string, string> = {},
  ): FakeVolume {
    const volume = { labels, files: new Map([["", { ...ROOT }], ...Object.entries(files)]) };
    this.volumes.set(name, volume);
    return volume;
  }

  /** Adds a host folder at `path` holding `files`, as {@link addVolume} does for a volume. */
  addFolder(path: string, files: Record<string, FakeFile> = {}): FakeVolume {
    const folder = { labels: {}, files: new Map([["", { ...ROOT }], ...Object.entries(files)]) };
    this.folders.set(path, folder);
    return folder;
  }

  /** What a bind's source names: a host folder for an absolute path, else a volume. */
  private storage(source: string): FakeVolume | undefined {
    return source.startsWith("/") ? this.folders.get(source) : this.volumes.get(source);
  }

  async request(request: DockerRequest): Promise<DockerResponse> {
    this.calls.push(`${request.method} ${request.path}`);
    const failure = this.failures.findIndex(
      (rule) => rule.method === request.method && rule.path.test(request.path),
    );
    if (failure !== -1) {
      const [rule] = this.failures.splice(failure, 1);
      if (rule !== undefined) return json(rule.status, { message: rule.message });
    }
    if (request.body instanceof Readable) this.streamedBodies.push(request.body);
    return this.route(request.method, new URL(request.path, "http://docker"), request.body);
  }

  private async route(
    method: string,
    url: URL,
    body: string | Readable | undefined,
  ): Promise<DockerResponse> {
    const path = url.pathname;
    const query = url.searchParams;
    if (method === "GET" && path === "/containers/json") {
      return json(
        200,
        [...this.containers.values()]
          .filter((container) => matches(container.labels, query))
          .map((container) => ({
            Id: container.id,
            Names: container.name === undefined ? [] : [`/${container.name}`],
            Image: container.image,
            State: container.state,
            Status: statusOf(container),
            Labels: container.labels,
            Mounts: mounts(container).map((mount) =>
              mount.source.startsWith("/")
                ? { Type: "bind", Source: mount.source, Destination: mount.target }
                : {
                    Type: "volume",
                    Name: mount.source,
                    Source: `/var/lib/docker/volumes/${mount.source}/_data`,
                    Destination: mount.target,
                  },
            ),
          })),
      );
    }
    if (method === "POST" && path === "/containers/create") {
      return this.create(query.get("name") ?? undefined, JSON.parse(await text(body)));
    }
    const container = /^\/containers\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (container !== null) {
      return this.containerCall(method, container[1] ?? "", container[2] ?? "", query, body);
    }
    if (method === "GET" && path === "/volumes") {
      const volumes = [...this.volumes].filter(([, volume]) => matches(volume.labels, query));
      return json(200, {
        Volumes: volumes.map(([name, volume]) => ({
          Name: name,
          Driver: "local",
          Labels: volume.labels,
        })),
        Warnings: [],
      });
    }
    if (method === "POST" && path === "/volumes/create") {
      const spec = JSON.parse(await text(body)) as {
        Name: string;
        Labels?: Record<string, string>;
      };
      this.addVolume(spec.Name, {}, spec.Labels ?? {});
      return json(201, { Name: spec.Name, Driver: "local" });
    }
    const volume = /^\/volumes\/([^/]+)$/.exec(path)?.[1];
    if (method === "GET" && volume !== undefined) {
      const found = this.volumes.get(volume);
      if (found === undefined) return json(404, { message: `get ${volume}: no such volume` });
      return json(200, { Name: volume, Driver: "local", Labels: found.labels });
    }
    if (method === "DELETE" && volume !== undefined) return this.removeVolume(volume);
    if (method === "GET" && path === "/system/df") {
      return json(200, {
        Volumes: [...this.volumes].map(([name, volume]) => ({
          Name: name,
          UsageData: { Size: bytes(volume), RefCount: this.users(name).length },
        })),
      });
    }
    if (method === "POST" && path === "/images/create") return this.pull(query.get("fromImage"));
    return json(404, { message: "page not found" });
  }

  private create(name: string | undefined, spec: CreateBody): DockerResponse {
    if (!this.images.has(spec.Image)) return json(404, { message: `No such image: ${spec.Image}` });
    const given = (spec.HostConfig?.Mounts ?? []).map((mount) => ({
      type: mount.Type,
      source: mount.Source,
      target: mount.Target,
      ...(mount.ReadOnly === undefined ? {} : { readOnly: mount.ReadOnly }),
    }));
    const missing = given.find((mount) => mount.type === "bind" && !this.folders.has(mount.source));
    if (missing !== undefined) {
      return json(400, {
        message: `invalid mount config for type "bind": bind source path does not exist: ${missing.source}`,
      });
    }
    const id = (this.nextId++).toString(16).padStart(64, "0");
    const container: FakeContainer = {
      id,
      image: spec.Image,
      cmd: spec.Cmd ?? [],
      env: spec.Env ?? [],
      labels: spec.Labels ?? {},
      binds: spec.HostConfig?.Binds ?? [],
      mounts: given,
      state: "created",
      exitCode: 0,
      stdout: "",
      stderr: "",
    };
    if (name !== undefined) container.name = name;
    if (spec.HostConfig?.NetworkMode !== undefined) container.network = spec.HostConfig.NetworkMode;
    for (const { source } of mounts(container)) {
      if (this.storage(source) !== undefined) continue;
      if (source.startsWith("/")) this.addFolder(source);
      else this.addVolume(source);
    }
    this.containers.set(id, container);
    return json(201, { Id: id, Warnings: [] });
  }

  private async containerCall(
    method: string,
    id: string,
    action: string,
    query: URLSearchParams,
    body: string | Readable | undefined,
  ): Promise<DockerResponse> {
    const container = this.containers.get(id);
    if (container === undefined) return json(404, { message: `No such container: ${id}` });
    switch (`${method} ${action}`) {
      case "POST /start": {
        if (container.state === "running") return empty(304);
        const run = this.onStart?.(container) ?? this.builtIn(container);
        Object.assign(container, { state: "exited", stdout: "", stderr: "" }, run);
        return empty(204);
      }
      case "POST /stop":
        if (container.state !== "running") return empty(304);
        container.state = "exited";
        return empty(204);
      case "POST /wait":
        return json(200, { StatusCode: container.exitCode, Error: null });
      case "GET /logs":
        return {
          status: 200,
          headers: { "content-type": "application/vnd.docker.multiplexed-stream" },
          body: Readable.from([frame(1, container.stdout), frame(2, container.stderr)], {
            objectMode: false,
          }),
        };
      case "DELETE ":
        if (container.state === "running" && query.get("force") !== "1") {
          return json(409, { message: "cannot remove a running container" });
        }
        this.containers.delete(id);
        return empty(204);
      case "GET /archive":
        return this.readArchive(container, query.get("path") ?? "");
      case "PUT /archive":
        return this.writeArchive(container, query.get("path") ?? "", await buffer(body));
      default:
        return json(404, { message: "page not found" });
    }
  }

  /**
   * The carrier's commands: `test ! -L <mount>/<name>` (that the host path is no link), and on
   * what is mounted at /data: `find /data -mindepth 1 -delete`, the hashing script, `du -sb /data`.
   */
  private builtIn(container: FakeContainer): FakeRun {
    const [program, ...args] = container.cmd;
    if (program === "test" && args[0] === "!" && args[1] === "-L") {
      const path = args[2] ?? "";
      const mount = mounts(container).find((candidate) => path.startsWith(`${candidate.target}/`));
      const host = mount === undefined ? "" : mount.source + path.slice(mount.target.length);
      return { exitCode: this.symlinks.has(host) ? 1 : 0 };
    }
    const data = mounts(container).find((mount) => mount.target === "/data");
    const volume = data === undefined ? undefined : this.storage(data.source);
    if (volume === undefined) return { exitCode: 0 };
    if (program === "find" && args.join(" ") === "/data -mindepth 1 -delete") {
      for (const path of [...volume.files.keys()]) if (path !== "") volume.files.delete(path);
      return { exitCode: 0 };
    }
    if (program === "sh" && args[1]?.includes("sha256sum")) {
      return { exitCode: 0, stdout: `${digest(volume)}  -\n` };
    }
    if (program === "du" && args.join(" ") === "-sb /data") {
      return { exitCode: 0, stdout: `${bytes(volume)}\t/data\n` };
    }
    return { exitCode: 0 };
  }

  private readArchive(container: FakeContainer, path: string): DockerResponse {
    const mount = mounts(container).find((candidate) => candidate.target === path);
    const volume = mount === undefined ? undefined : this.storage(mount.source);
    if (volume === undefined) {
      return json(404, { message: `Could not find the file ${path} in container ${container.id}` });
    }
    const base = path.slice(1);
    const entries = [...volume.files]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([inside, file]) => {
        const name = inside === "" ? base : `${base}/${inside}`;
        return { ...file, name: file.type === "dir" ? `${name}/` : name };
      });
    const broken = this.brokenArchive;
    this.brokenArchive = undefined;
    return {
      status: 200,
      headers: { "content-type": "application/x-tar" },
      body:
        broken === undefined
          ? tarStream(entries)
          : Readable.from(
              (async function* () {
                yield Buffer.alloc(512);
                throw new Error(broken);
              })(),
              { objectMode: false },
            ),
    };
  }

  private writeArchive(container: FakeContainer, path: string, archive: Buffer): DockerResponse {
    if (path !== "/") return json(400, { message: "the fake writes archives only at /" });
    const writes: { volume: FakeVolume; path: string; file: FakeFile }[] = [];
    for (const { name, ...file } of parseTar(archive)) {
      const [top = "", ...rest] = name.replace(/\/$/, "").split("/");
      const mount = mounts(container).find((candidate) => candidate.target === `/${top}`);
      const volume = mount === undefined ? undefined : this.storage(mount.source);
      if (mount === undefined || volume === undefined) continue;
      if (mount.readOnly) {
        return json(403, { message: `mounted volume is marked read-only: ${mount.target}` });
      }
      writes.push({ volume, path: rest.join("/"), file });
    }
    for (const write of writes) write.volume.files.set(write.path, write.file);
    return empty(200);
  }

  private removeVolume(name: string): DockerResponse {
    if (!this.volumes.has(name)) return json(404, { message: `get ${name}: no such volume` });
    const users = this.users(name);
    if (users.length > 0) {
      return json(409, { message: `remove ${name}: volume is in use - [${users.join(", ")}]` });
    }
    this.volumes.delete(name);
    return empty(204);
  }

  private pull(image: string | null): DockerResponse {
    const lines: unknown[] = [{ status: `Pulling from ${image}` }];
    if (image === null || this.unknownImages.has(image)) {
      lines.push({ errorDetail: { message: "manifest unknown" }, error: "manifest unknown" });
    } else {
      this.images.add(image);
      lines.push({ status: `Status: Downloaded newer image for ${image}` });
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([lines.map((line) => `${JSON.stringify(line)}\r\n`).join("")], {
        objectMode: false,
      }),
    };
  }

  private users(volume: string): string[] {
    return [...this.containers.values()]
      .filter((container) => mounts(container).some((mount) => mount.source === volume))
      .map((container) => container.id);
  }
}

interface CreateBody {
  Image: string;
  Cmd?: string[];
  Env?: string[];
  Labels?: Record<string, string>;
  HostConfig?: {
    Binds?: string[];
    Mounts?: { Type: string; Source: string; Target: string; ReadOnly?: boolean }[];
    NetworkMode?: string;
  };
}

/** Docker's `Status` of a container: `Up` with its health (`(health: starting)`), or `Exited`. */
function statusOf(container: FakeContainer): string {
  if (container.state !== "running") return `Exited (${container.exitCode})`;
  if (container.health === undefined) return "Up 1 second";
  return `Up 1 second (${container.health === "starting" ? "health: starting" : container.health})`;
}

/** A container's `Binds` and `Mounts` alike. */
function mounts(container: FakeContainer): Mount[] {
  const binds = container.binds.map((bind) => {
    const [source = "", target = "", options = ""] = bind.split(":");
    return { source, target, readOnly: options.split(",").includes("ro") };
  });
  const given = container.mounts.map(({ source, target, readOnly }) => ({
    source,
    target,
    readOnly: readOnly === true,
  }));
  return [...binds, ...given];
}

/** True when `labels` has every `key` or `key=value` of the request's `label` filter. */
function matches(labels: Record<string, string>, query: URLSearchParams): boolean {
  const filters = JSON.parse(query.get("filters") ?? "{}") as { label?: string[] };
  return (filters.label ?? []).every((filter) => {
    const at = filter.indexOf("=");
    return at === -1 ? filter in labels : labels[filter.slice(0, at)] === filter.slice(at + 1);
  });
}

/** The size of a volume's or folder's files, as `system/df` and `du -sb` count it. */
function bytes(volume: FakeVolume): number {
  return [...volume.files.values()].reduce((total, file) => total + (file.data?.length ?? 0), 0);
}

/** One SHA-256 over every path's type, mode, owner, size, content and link target. */
function digest(volume: FakeVolume): string {
  const lines = [...volume.files].map(([path, file]) =>
    [
      path,
      file.type,
      file.mode.toString(8),
      file.uid,
      file.gid,
      file.data === undefined ? "" : createHash("sha256").update(file.data).digest("hex"),
      file.target ?? "",
    ].join(" "),
  );
  return createHash("sha256").update(lines.sort().join("\n")).digest("hex");
}

/** One frame of Docker's multiplexed log stream: 1 for stdout, 2 for stderr. */
function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

function json(status: number, value: unknown): DockerResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(value))], { objectMode: false }),
  };
}

function empty(status: number): DockerResponse {
  return { status, headers: {}, body: Readable.from([], { objectMode: false }) };
}

async function buffer(body: string | Readable | undefined): Promise<Buffer> {
  if (body === undefined) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function text(body: string | Readable | undefined): Promise<string> {
  return (await buffer(body)).toString("utf8");
}
