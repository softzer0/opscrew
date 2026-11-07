import type { Readable } from "node:stream";
import type { DockerRequest, DockerResponse, DockerTransport } from "@opscrew/contracts";
import { OpsCrewError, parseAnswer, Redactor } from "@opscrew/core";
import { z } from "zod";

/** A container as {@link DockerClient.listContainers} reports it. */
export interface DockerContainer {
  id: string;
  /** Its name, without Docker's leading slash; empty when Docker reports none. */
  name: string;
  image: string;
  /** Docker's state: `created`, `running`, `exited`… */
  state: string;
  /** Its health check's answer while it runs; absent without a health check. */
  health?: "starting" | "healthy" | "unhealthy";
  labels: Record<string, string>;
  mounts: ContainerMount[];
}

/** One mount of a container, as {@link DockerClient.listContainers} reports it. */
export interface ContainerMount {
  /** `volume` (a named volume), `bind` (a folder on the server), or another, such as `tmpfs`. */
  type: "volume" | "bind" | (string & {});
  /** A named volume's name. */
  name?: string;
  /** Where the data is on the server: a volume's folder in Docker's storage, or a bound folder. */
  source: string;
  /** Where the container sees it. */
  destination: string;
}

/** What {@link DockerClient.createContainer} creates. */
export interface ContainerSpec {
  image: string;
  cmd?: readonly string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  /**
   * Mounts by Docker's `Mounts` API: Docker refuses a bound folder that doesn't exist rather than
   * creating it (a named volume is still created).
   */
  mounts?: readonly MountSpec[];
  /** The network it joins (`none` for none); Docker's default bridge when omitted. */
  network?: string;
}

/** One of {@link ContainerSpec.mounts}: a named volume or a folder on the server, at `target`. */
export interface MountSpec {
  type: "volume" | "bind";
  /** The volume's name, or the folder's absolute path. */
  source: string;
  target: string;
  readOnly?: boolean;
}

/** A volume as {@link DockerClient.listVolumes} reports it. */
export interface DockerVolume {
  name: string;
  labels: Record<string, string>;
}

/** A container's output, by stream. */
export interface ContainerLogs {
  stdout: string;
  stderr: string;
}

/**
 * The subset of the Docker Engine API a move uses. Label filters are `key` or `key=value`, and a
 * container must have every one. Each call fails with a {@link DockerApiError} when Docker refuses
 * it, and with `PROVIDER_ERROR` when Docker answers in a shape OpsCrew does not know.
 */
export interface DockerClient {
  /** The containers, running or not, with every label in `labels`. */
  listContainers(labels: readonly string[]): Promise<DockerContainer[]>;
  /** Creates a container (not started) and returns its id. */
  createContainer(spec: ContainerSpec): Promise<string>;
  /** Starts a container; one that already runs is left as it is. */
  startContainer(id: string): Promise<void>;
  /**
   * Stops a container, killing it after `timeoutSeconds` (by default its own stop timeout, such
   * as a Compose `stop_grace_period`); one already stopped is left as it is.
   */
  stopContainer(id: string, timeoutSeconds?: number): Promise<void>;
  /** Waits until a container stops and returns its exit code. */
  waitContainer(id: string): Promise<number>;
  /** The whole output of a container started without a TTY. */
  containerLogs(id: string): Promise<ContainerLogs>;
  /** Removes a container, stopping it first if it runs. Its volumes stay. */
  removeContainer(id: string): Promise<void>;
  /** A tar of `path` in a container (running, stopped or only created), streamed as it comes. */
  getArchive(id: string, path: string): Promise<Readable>;
  /** Unpacks the tar `archive` at `path` in a container, streaming it as it is read. */
  putArchive(id: string, path: string, archive: Readable): Promise<void>;
  /** The volumes with every label in `labels`; all of them when it is omitted. */
  listVolumes(labels?: readonly string[]): Promise<DockerVolume[]>;
  /** True when the volume exists (Docker answers 404 when it doesn't). */
  volumeExists(name: string): Promise<boolean>;
  createVolume(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** Each volume's size in bytes, by name; a volume whose size Docker can't tell is left out. */
  volumeSizes(): Promise<Map<string, number>>;
  /** Pulls an image, such as a pinned `name:tag@sha256:…` reference. */
  pullImage(ref: string): Promise<void>;
}

/** Docker refused a request: `status` is its HTTP status (200 for an error inside a stream). */
export class DockerApiError extends OpsCrewError {
  readonly status: number;

  constructor(status: number, message: string) {
    super("PROVIDER_ERROR", message, {
      hint:
        status === 401 || status === 403
          ? "Check that the account OpsCrew uses may manage Docker there, then try again."
          : "Check Docker on the server, then try again.",
    });
    this.name = "DockerApiError";
    this.status = status;
  }
}

const Labels = z.record(z.string(), z.string()).nullish();
const ContainerList = z.array(
  z.object({
    Id: z.string(),
    Names: z.array(z.string()).nullish(),
    Image: z.string(),
    State: z.string(),
    /** `Up 2 minutes (healthy)`: the health check's answer in parentheses. */
    Status: z.string().nullish(),
    Labels,
    Mounts: z
      .array(
        z.object({
          Type: z.string(),
          Name: z.string().optional(),
          Source: z.string().default(""),
          Destination: z.string(),
        }),
      )
      .nullish(),
  }),
);
const Created = z.object({ Id: z.string() });

/** The health check's answer in a container's `Status` (`(health: starting)`, `(healthy)`). */
function healthOf(status: string | null | undefined): Pick<DockerContainer, "health"> {
  const said = /\((health: starting|healthy|unhealthy)\)/.exec(status ?? "")?.[1];
  if (said === undefined) return {};
  return { health: said === "healthy" || said === "unhealthy" ? said : "starting" };
}
const WaitResult = z.object({
  StatusCode: z.number().int(),
  Error: z.object({ Message: z.string() }).nullish(),
});
const VolumeList = z.object({
  Volumes: z.array(z.object({ Name: z.string(), Labels })).nullish(),
});
const DiskUsage = z.object({
  Volumes: z
    .array(z.object({ Name: z.string(), UsageData: z.object({ Size: z.number() }).nullish() }))
    .nullish(),
});
const PullEvent = z.object({ error: z.string().optional() });
const ErrorAnswer = z.object({ message: z.string() });

async function bytes(body: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Docker's reason in an error answer: its JSON `message`, or the text itself. */
function reason(text: string): string {
  try {
    const parsed = ErrorAnswer.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data.message;
  } catch {
    // Not JSON: the text is the reason.
  }
  return text.trim() || "no reason given";
}

function failure(status: number, action: string, why: string): DockerApiError {
  return new DockerApiError(status, `Docker could not ${action}: ${why.replace(/\.$/, "")}.`);
}

/** A label filter as Docker's `filters` query value. */
function labelFilter(labels: readonly string[]): string {
  return encodeURIComponent(JSON.stringify({ label: labels }));
}

/**
 * Docker's multiplexed log stream split by stream: frames of an 8-byte header (the stream in byte
 * 0, 1 for stdout, 2 for stderr; the size big-endian in bytes 4–7) and their payload.
 */
function demultiplex(frames: Buffer, action: string): ContainerLogs {
  const out = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  let offset = 0;
  while (offset < frames.length) {
    const end = offset + 8 <= frames.length ? offset + 8 + frames.readUInt32BE(offset + 4) : -1;
    if (end === -1 || end > frames.length) {
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Docker's answer to ${action} ended inside a frame.`,
        {
          hint: "Try again; if it keeps failing, please report it to OpsCrew.",
        },
      );
    }
    out[frames[offset] === 1 ? "stdout" : "stderr"].push(frames.subarray(offset + 8, end));
    offset = end;
  }
  return {
    stdout: Buffer.concat(out.stdout).toString("utf8"),
    stderr: Buffer.concat(out.stderr).toString("utf8"),
  };
}

/** A {@link DockerClient} over `transport`, such as an SSH dial-stdio or Portainer's proxy. */
export function dockerClient(transport: DockerTransport): DockerClient {
  /**
   * Sends `request`. An answer outside 2xx (and `accepted`) becomes a {@link DockerApiError} that
   * Docker could not `action`, its reason passed through `mask`.
   */
  async function send(
    request: DockerRequest,
    action: string,
    options: { accepted?: number[]; mask?: (text: string) => string } = {},
  ): Promise<DockerResponse> {
    const response = await transport.request(request);
    const { status } = response;
    if ((status >= 200 && status < 300) || options.accepted?.includes(status)) return response;
    const why = reason((await bytes(response.body)).toString("utf8"));
    throw failure(status, action, options.mask ? options.mask(why) : why);
  }

  /** Sends `request` and reads its answer to the end, ignoring it. */
  async function done(request: DockerRequest, action: string, accepted?: number[]) {
    await bytes((await send(request, action, { accepted })).body);
  }

  /** Sends `request` and parses its JSON answer with `schema`. */
  async function json<S extends z.ZodType>(
    request: DockerRequest,
    action: string,
    schema: S,
    mask?: (text: string) => string,
  ): Promise<z.output<S>> {
    const body = (await bytes((await send(request, action, { mask })).body)).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      value = body;
    }
    return parseAnswer(schema, value, "Docker", action);
  }

  const short = (id: string) => id.slice(0, 12);

  return {
    async listContainers(labels) {
      const list = await json(
        { method: "GET", path: `/containers/json?all=1&filters=${labelFilter(labels)}` },
        "list containers",
        ContainerList,
      );
      return list.map((container) => ({
        id: container.Id,
        name: (container.Names?.[0] ?? "").replace(/^\//, ""),
        image: container.Image,
        state: container.State,
        ...healthOf(container.Status),
        labels: container.Labels ?? {},
        mounts: (container.Mounts ?? []).map((mount) => ({
          type: mount.Type,
          ...(mount.Name === undefined ? {} : { name: mount.Name }),
          source: mount.Source,
          destination: mount.Destination,
        })),
      }));
    },

    async createContainer(spec) {
      // Docker may quote what it refuses; the environment's values never reach an error.
      const redactor = new Redactor();
      for (const value of Object.values(spec.env ?? {})) redactor.addLiteral(value);
      const body = {
        Image: spec.image,
        Cmd: spec.cmd,
        Env: Object.entries(spec.env ?? {}).map(([name, value]) => `${name}=${value}`),
        Labels: spec.labels ?? {},
        HostConfig: {
          Mounts: spec.mounts?.map((mount) => ({
            Type: mount.type,
            Source: mount.source,
            Target: mount.target,
            ReadOnly: mount.readOnly ?? false,
          })),
          NetworkMode: spec.network,
        },
      };
      const created = await json(
        {
          method: "POST",
          path: "/containers/create",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        `create a container from ${spec.image}`,
        Created,
        redactor.redactSecrets,
      );
      return created.Id;
    },

    startContainer: (id) =>
      done(
        { method: "POST", path: `/containers/${id}/start` },
        `start container ${short(id)}`,
        [304],
      ),

    stopContainer: (id, timeoutSeconds) =>
      done(
        {
          method: "POST",
          path: `/containers/${id}/stop${timeoutSeconds === undefined ? "" : `?t=${timeoutSeconds}`}`,
        },
        `stop container ${short(id)}`,
        [304],
      ),

    async waitContainer(id) {
      const action = `wait for container ${short(id)}`;
      const result = await json(
        { method: "POST", path: `/containers/${id}/wait` },
        action,
        WaitResult,
      );
      if (result.Error?.Message) throw failure(200, action, result.Error.Message);
      return result.StatusCode;
    },

    async containerLogs(id) {
      const action = `read the logs of container ${short(id)}`;
      const response = await send(
        { method: "GET", path: `/containers/${id}/logs?stdout=1&stderr=1` },
        action,
      );
      return demultiplex(await bytes(response.body), action);
    },

    removeContainer: (id) =>
      done(
        { method: "DELETE", path: `/containers/${id}?force=1` },
        `remove container ${short(id)}`,
      ),

    async getArchive(id, path) {
      const response = await send(
        { method: "GET", path: `/containers/${id}/archive?path=${encodeURIComponent(path)}` },
        `read ${path} from container ${short(id)}`,
      );
      return response.body;
    },

    putArchive: (id, path, archive) =>
      done(
        {
          method: "PUT",
          path: `/containers/${id}/archive?path=${encodeURIComponent(path)}`,
          headers: { "Content-Type": "application/x-tar" },
          body: archive,
        },
        `write into ${path} of container ${short(id)}`,
      ),

    async listVolumes(labels) {
      const query = labels === undefined ? "" : `?filters=${labelFilter(labels)}`;
      const list = await json(
        { method: "GET", path: `/volumes${query}` },
        "list volumes",
        VolumeList,
      );
      return (list.Volumes ?? []).map((volume) => ({
        name: volume.Name,
        labels: volume.Labels ?? {},
      }));
    },

    async volumeExists(name) {
      const response = await send(
        { method: "GET", path: `/volumes/${name}` },
        `read volume ${name}`,
        {
          accepted: [404],
        },
      );
      await bytes(response.body);
      return response.status !== 404;
    },

    createVolume: (name) =>
      done(
        {
          method: "POST",
          path: "/volumes/create",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ Name: name }),
        },
        `create volume ${name}`,
      ),

    removeVolume: (name) =>
      done({ method: "DELETE", path: `/volumes/${name}` }, `remove volume ${name}`),

    async volumeSizes() {
      const usage = await json(
        { method: "GET", path: "/system/df?type=volume" },
        "read the volumes' sizes",
        DiskUsage,
      );
      const sizes = new Map<string, number>();
      for (const volume of usage.Volumes ?? []) {
        const size = volume.UsageData?.Size ?? -1;
        if (size >= 0) sizes.set(volume.Name, size);
      }
      return sizes;
    },

    async pullImage(ref) {
      const action = `pull image ${ref}`;
      const response = await send(
        { method: "POST", path: `/images/create?fromImage=${encodeURIComponent(ref)}` },
        action,
      );
      // The answer is a stream of JSON progress events; a failed pull still answers 200, with an
      // event that holds the error.
      const events = (await bytes(response.body)).toString("utf8").split(/\r?\n/);
      for (const line of events.filter((event) => event.trim() !== "")) {
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          value = line;
        }
        const event = parseAnswer(PullEvent, value, "Docker", action);
        if (event.error !== undefined) throw failure(200, action, event.error);
      }
    },
  };
}
