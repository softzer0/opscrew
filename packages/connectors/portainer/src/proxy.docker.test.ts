/**
 * Portainer's Docker proxy against a real, throwaway Portainer CE (the pinned `IMAGES.portainer`)
 * with this computer's Docker socket mounted, set up through its API: the administrator, the local
 * environment, a standard user with access to it, and both users' access tokens.
 *
 * Through `dockerProxyTransport`:
 * - a chunked `PUT` of a 1 GiB archive into a created (never started) busybox container's volume,
 *   and a `GET` of the file back, with the same SHA-256;
 * - a Portainer stack's container (Compose labels it), stopped and started with the standard
 *   user's token; and a Compose-labelled container the administrator made, which the standard user
 *   may not stop (recorded), stopped and started with the administrator's token.
 *
 * Gated: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon. Passwords and tokens are made at
 * runtime and never printed. Every container, volume, network and image the test made is removed
 * afterwards; images Docker had before are kept.
 */
import { execFile } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import type { DockerTransport } from "@opscrew/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PortainerClient, portainerClient } from "./client";
import { inspectCertificate, type PortainerEndpoint, pinnedRequest } from "./pinned";

const SKIP =
  process.env.OPSCREW_DOCKER_TESTS !== "1" ? "set OPSCREW_DOCKER_TESTS=1 to run it" : undefined;
if (SKIP !== undefined) console.warn(`Skipping Portainer's Docker proxy on Docker: ${SKIP}.`);

/** The pinned images, read from `@opscrew/iac-templates`' pins so the test never drifts. */
function pinnedRef(name: string): string {
  const pins = readFileSync(new URL("../../../iac-templates/src/pins.ts", import.meta.url), "utf8");
  const ref = new RegExp(`\\n  ${name}: \\{\\s*ref: "([^"]+)"`).exec(pins)?.[1];
  if (ref === undefined) throw new Error(`No pinned ${name} image in iac-templates' pins.ts.`);
  return ref;
}

const GIB = 1024 ** 3;
const MINUTES = 60_000;
const RUN = `opscrew-t2304-${randomBytes(4).toString("hex")}`;
const TEST_LABEL = "opscrew.test";

/** Runs `docker`; its output is returned, never shown (`docker logs` holds the setup token). */
function docker(
  args: string[],
  timeoutMs = 2 * MINUTES,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`docker ${args[0]} failed (exit ${String(error.code)}).`));
        else resolve({ stdout, stderr });
      },
    );
  });
}

async function dockerOut(args: string[], timeoutMs?: number): Promise<string> {
  return (await docker(args, timeoutMs)).stdout;
}

async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await sleep(2_000);
  }
}

async function imageIds(): Promise<Set<string>> {
  const out = await dockerOut(["image", "ls", "-a", "-q", "--no-trunc"]);
  return new Set(out.split(/\s+/).filter((id) => id !== ""));
}

/** A one-entry ustar header for a regular file of `size` bytes. */
function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  const field = (offset: number, length: number, value: string) =>
    header.write(value, offset, length, "ascii");
  const octal = (value: number, length: number) =>
    `${value.toString(8).padStart(length - 1, "0")}\0`;
  field(0, 100, name);
  field(100, 8, octal(0o644, 8));
  field(108, 8, octal(0, 8));
  field(116, 8, octal(0, 8));
  field(124, 12, octal(size, 12));
  field(136, 12, octal(Math.floor(Date.now() / 1000), 12));
  field(148, 8, "        ");
  field(156, 1, "0");
  field(257, 6, "ustar\0");
  field(263, 2, "00");
  let sum = 0;
  for (const byte of header) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/**
 * A tar holding `name` with `size` pseudo-random bytes (AES-CTR of zeros), made as it streams;
 * `digest` settles with the file's SHA-256 once the stream has been read.
 */
function randomTar(name: string, size: number): { body: Readable; digest: Promise<string> } {
  const hash = createHash("sha256");
  let done: (value: string) => void = () => undefined;
  const digest = new Promise<string>((resolve) => {
    done = resolve;
  });
  const cipher = createCipheriv("aes-128-ctr", randomBytes(16), randomBytes(16));
  const zeros = Buffer.alloc(1024 * 1024);
  async function* parts() {
    yield tarHeader(name, size);
    for (let left = size; left > 0; left -= zeros.length) {
      const part = cipher.update(left >= zeros.length ? zeros : zeros.subarray(0, left));
      hash.update(part);
      yield part;
    }
    done(hash.digest("hex"));
    const padding = (512 - (size % 512)) % 512;
    yield Buffer.alloc(padding + 1024);
  }
  return { body: Readable.from(parts(), { objectMode: false }), digest };
}

/** The size and SHA-256 of the regular file named `name` in a streamed tar. */
async function tarFile(body: Readable, name: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let found: number | undefined;
  let buffer: Buffer = Buffer.alloc(0);
  let remaining = 0;
  let skip = 0;
  let hashing = false;
  for await (const chunk of body) {
    buffer = buffer.length === 0 ? (chunk as Buffer) : Buffer.concat([buffer, chunk as Buffer]);
    for (;;) {
      if (remaining > 0) {
        const take = Math.min(remaining, buffer.length);
        if (hashing) hash.update(buffer.subarray(0, take));
        remaining -= take;
        buffer = buffer.subarray(take);
        if (remaining > 0) break;
        continue;
      }
      if (skip > 0) {
        const take = Math.min(skip, buffer.length);
        skip -= take;
        buffer = buffer.subarray(take);
        if (skip > 0) break;
        continue;
      }
      if (buffer.length < 512) break;
      const header = buffer.subarray(0, 512);
      buffer = buffer.subarray(512);
      if (header.every((byte) => byte === 0)) continue;
      const entry = header.toString("ascii", 0, 100).replace(/\0.*$/s, "");
      const size = Number.parseInt(header.toString("ascii", 124, 136).replace(/\0.*$/s, ""), 8);
      const type = String.fromCharCode(header[156] ?? 0);
      hashing = (type === "0" || type === "\0") && entry === name;
      if (hashing) found = size;
      remaining = size;
      skip = (512 - (size % 512)) % 512;
    }
  }
  if (found === undefined) throw new Error(`The archive has no ${name}.`);
  return { bytes: found, sha256: hash.digest("hex") };
}

/** Reads a whole answer as JSON (or `undefined` when it is empty). */
async function json(body: Readable): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const chunk of body) parts.push(chunk as Buffer);
  const text = Buffer.concat(parts).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

async function dockerCall(
  transport: DockerTransport,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await transport.request({
    method,
    path,
    ...(body !== undefined && {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  });
  return { status: response.status, json: await json(response.body) };
}

async function running(transport: DockerTransport, id: string): Promise<boolean> {
  const inspected = await dockerCall(transport, "GET", `/containers/${id}/json`);
  expect(inspected.status).toBe(200);
  return (inspected.json as { State: { Running: boolean } }).State.Running;
}

describe.skipIf(SKIP !== undefined)("Portainer's Docker proxy on Docker", () => {
  const portainerImage = pinnedRef("portainer");
  const busybox = pinnedRef("busybox");
  let imagesBefore = new Set<string>();
  let endpoint: PortainerEndpoint;
  let environmentId = 0;
  let admin: PortainerClient;
  let standard: PortainerClient;
  const stackName = `${RUN}-stack`;

  beforeAll(async () => {
    imagesBefore = await imageIds();
    await docker(["pull", "-q", portainerImage], 10 * MINUTES);
    await docker(["pull", "-q", busybox], 10 * MINUTES);
    await docker([
      "run",
      "-d",
      "--name",
      RUN,
      "--label",
      `${TEST_LABEL}=${RUN}`,
      "-p",
      "127.0.0.1::9443",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "-v",
      `${RUN}-data:/data`,
      portainerImage,
    ]);
    const port = (await dockerOut(["port", RUN, "9443/tcp"])).trim().split(":").pop();
    const url = `https://127.0.0.1:${port}`;
    const certificate = await until("Portainer's certificate", 2 * MINUTES, () =>
      inspectCertificate(url),
    );
    endpoint = { url, certFingerprint: certificate.fingerprint };
    const request = pinnedRequest(endpoint);
    /** One setup call; only the status is ever reported (answers may hold password hashes). */
    const api = async (
      method: "GET" | "POST" | "PUT",
      path: string,
      what: string,
      init: { json?: unknown; form?: Record<string, string>; headers?: Record<string, string> },
    ): Promise<Record<string, unknown>> => {
      const headers: Record<string, string> = { Accept: "application/json", ...init.headers };
      let body: string | undefined;
      if (init.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(init.json);
      } else if (init.form !== undefined) {
        const boundary = `opscrew-${randomBytes(12).toString("hex")}`;
        headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;
        body = `${Object.entries(init.form)
          .map(
            ([name, value]) =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
          )
          .join("")}--${boundary}--\r\n`;
      }
      const response = await request({
        method,
        path,
        headers,
        timeoutMs: MINUTES,
        ...(body !== undefined && { body }),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Portainer refused to ${what} (HTTP ${response.status}).`);
      }
      return response.body === "" ? {} : (JSON.parse(response.body) as Record<string, unknown>);
    };
    await until("Portainer's API", 2 * MINUTES, () =>
      api("GET", "/api/system/status", "report its status", {}),
    );

    // A fresh Portainer: the administrator (with the setup token, when this version prints one).
    const logs = await docker(["logs", RUN]);
    const setupToken = /^\s*setup_token=([0-9a-f]{16,})\b/m.exec(
      `${logs.stdout}\n${logs.stderr}`,
    )?.[1];
    const adminPassword = randomBytes(24).toString("base64url");
    await api("POST", "/api/users/admin/init", "initialise the administrator", {
      json: { Username: "admin", Password: adminPassword },
      ...(setupToken !== undefined && { headers: { "X-Setup-Token": setupToken } }),
    });
    const session = async (username: string, password: string) => {
      const auth = await api("POST", "/api/auth", "log in", {
        json: { Username: username, Password: password },
      });
      return { Authorization: `Bearer ${String(auth.jwt)}` };
    };
    const adminSession = await session("admin", adminPassword);
    const environment = await api("POST", "/api/endpoints", "add the local environment", {
      form: { Name: "local", EndpointCreationType: "1" },
      headers: adminSession,
    });
    environmentId = Number(environment.Id);
    const adminToken = await api("POST", "/api/users/1/tokens", "create the admin's token", {
      json: { description: RUN, password: adminPassword },
      headers: adminSession,
    });
    admin = portainerClient(endpoint, String(adminToken.rawAPIKey));

    // A standard user (role 2) with access to the environment, and that user's own token.
    const standardPassword = randomBytes(24).toString("base64url");
    const adminKey = { "X-API-Key": String(adminToken.rawAPIKey) };
    const user = await api("POST", "/api/users", "create the standard user", {
      json: { Username: "standard", Password: standardPassword, Role: 2 },
      headers: adminKey,
    });
    await api("PUT", `/api/endpoints/${environmentId}`, "give the standard user access", {
      json: { UserAccessPolicies: { [String(user.Id)]: { RoleId: 0 } } },
      headers: adminKey,
    });
    const standardToken = await api(
      "POST",
      `/api/users/${String(user.Id)}/tokens`,
      "create the standard user's token",
      {
        json: { description: RUN, password: standardPassword },
        headers: await session("standard", standardPassword),
      },
    );
    standard = portainerClient(endpoint, String(standardToken.rawAPIKey));
  }, 15 * MINUTES);

  afterAll(async () => {
    const remove = async (args: string[]) => {
      await docker(args).catch(() => undefined);
    };
    for (const label of [`${TEST_LABEL}=${RUN}`, `com.docker.compose.project=${stackName}`]) {
      const ids = (await dockerOut(["ps", "-aq", "--filter", `label=${label}`]).catch(() => ""))
        .split(/\s+/)
        .filter((id) => id !== "");
      if (ids.length > 0) await remove(["rm", "-f", "-v", ...ids]);
    }
    const volumes = (
      await dockerOut(["volume", "ls", "-q", "--filter", `name=${RUN}`]).catch(() => "")
    )
      .split(/\s+/)
      .filter((name) => name !== "");
    if (volumes.length > 0) await remove(["volume", "rm", "-f", ...volumes]);
    await remove(["network", "rm", `${stackName}_default`]);
    const added = [...(await imageIds())].filter((id) => !imagesBefore.has(id));
    if (added.length > 0) await remove(["image", "rm", "-f", ...added]);
  }, 5 * MINUTES);

  it("reads the environment as Portainer's own Docker socket", async () => {
    expect(await admin.environmentKind(environmentId)).toBe("socket");
    expect(await standard.environmentKind(environmentId)).toBe("socket");
  });

  it(
    "writes 1 GiB chunked into a created container's volume and reads it back, same SHA-256",
    async () => {
      const transport = standard.dockerProxyTransport(environmentId);
      const volume = `${RUN}-volume`;
      const created = await dockerCall(transport, "POST", "/volumes/create", {
        Name: volume,
        Labels: { [TEST_LABEL]: RUN },
      });
      // Docker answers 201; Portainer's proxy rewrites the volume answer (with its access control) as 200.
      expect(created.status).toBe(200);
      const container = await dockerCall(
        transport,
        "POST",
        `/containers/create?name=${RUN}-carrier`,
        {
          Image: busybox,
          Cmd: ["true"],
          Labels: { [TEST_LABEL]: RUN },
          HostConfig: { Mounts: [{ Type: "volume", Source: volume, Target: "/data" }] },
        },
      );
      expect(container.status).toBe(201);
      const id = (container.json as { Id: string }).Id;

      const tar = randomTar("data/blob", GIB);
      let started = Date.now();
      const put = await transport.request({
        method: "PUT",
        path: `/containers/${id}/archive?path=%2F`,
        headers: { "Content-Type": "application/x-tar" },
        body: tar.body,
      });
      const putBody = await json(put.body).catch(() => undefined);
      expect(put.status, JSON.stringify(putBody)).toBe(200);
      const written = await tar.digest;
      const putSeconds = (Date.now() - started) / 1000;

      started = Date.now();
      const get = await transport.request({
        method: "GET",
        path: `/containers/${id}/archive?path=%2Fdata%2Fblob`,
      });
      expect(get.status).toBe(200);
      const read = await tarFile(get.body, "blob");
      const getSeconds = (Date.now() - started) / 1000;
      expect(read).toEqual({ bytes: GIB, sha256: written });
      console.log(
        `1 GiB through Portainer's proxy: PUT ${putSeconds.toFixed(1)} s, GET ${getSeconds.toFixed(1)} s.`,
      );
    },
    20 * MINUTES,
  );

  it(
    "stops and starts a stack's container with the standard user's token",
    async () => {
      const stack = await standard.createStringStack(environmentId, {
        name: stackName,
        compose: `services:\n  app:\n    image: ${busybox}\n    command: ["sleep", "3600"]\n`,
        env: [],
      });
      const transport = standard.dockerProxyTransport(environmentId);
      const filters = encodeURIComponent(
        JSON.stringify({ label: [`com.docker.compose.project=${stackName}`] }),
      );
      const id = await until("the stack's container", 3 * MINUTES, async () => {
        const list = await dockerCall(
          transport,
          "GET",
          `/containers/json?all=1&filters=${filters}`,
        );
        return (list.json as { Id: string; State: string }[]).find(
          (item) => item.State === "running",
        )?.Id;
      });
      expect((await dockerCall(transport, "POST", `/containers/${id}/stop?t=1`)).status).toBe(204);
      expect(await running(transport, id)).toBe(false);
      expect((await dockerCall(transport, "POST", `/containers/${id}/start`)).status).toBe(204);
      expect(await running(transport, id)).toBe(true);
      expect(await standard.removeStack(stack.id, environmentId)).toBe("removed");
    },
    10 * MINUTES,
  );

  it(
    "needs the administrator's token for a Compose-labelled container the standard user did not create",
    async () => {
      const adminTransport = admin.dockerProxyTransport(environmentId);
      const project = `${RUN}-other`;
      const created = await dockerCall(
        adminTransport,
        "POST",
        `/containers/create?name=${project}-app-1`,
        {
          Image: busybox,
          Cmd: ["sleep", "3600"],
          Labels: {
            [TEST_LABEL]: RUN,
            "com.docker.compose.project": project,
            "com.docker.compose.service": "app",
            "com.docker.compose.container-number": "1",
            "com.docker.compose.oneoff": "False",
          },
        },
      );
      expect(created.status).toBe(201);
      const id = (created.json as { Id: string }).Id;
      expect((await dockerCall(adminTransport, "POST", `/containers/${id}/start`)).status).toBe(
        204,
      );

      const refused = await dockerCall(
        standard.dockerProxyTransport(environmentId),
        "POST",
        `/containers/${id}/stop?t=1`,
      );
      console.log(
        `A standard user's stop of a container it did not create: HTTP ${refused.status}.`,
      );
      expect(refused.status).toBe(403);
      expect(await running(adminTransport, id)).toBe(true);

      expect((await dockerCall(adminTransport, "POST", `/containers/${id}/stop?t=1`)).status).toBe(
        204,
      );
      expect(await running(adminTransport, id)).toBe(false);
      expect((await dockerCall(adminTransport, "POST", `/containers/${id}/start`)).status).toBe(
        204,
      );
      expect(await running(adminTransport, id)).toBe(true);
    },
    5 * MINUTES,
  );
});
