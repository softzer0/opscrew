import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, IacInitOptions, IacRunOptions } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../provision/__fixtures__/fakes";
import { createTestPhaseDeps } from "../testing";
import {
  addressFromOutputs,
  committableUrl,
  damagedServerAddressesFile,
  ensureStatePassphrase,
  formatServerAddress,
  hasDeployment,
  hidesServerAddress,
  infrastructureOutputs,
  type PortainerConnection,
  readOwnServer,
  readPortainerConnection,
  readServerAddresses,
  recordOwnServer,
  recordPortainerConnection,
  recordServerAddress,
  serverAddress,
  serverAddressesFile,
  serverOfProvider,
  setAsideServerAddresses,
  updateServerAddresses,
  withoutServerAddress,
} from "./index";

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::10";

/** Engine fake that only answers `output`. */
class OutputEngine implements IacEngine {
  readonly info = { name: "tofu" as const, version: "1.13.1", binary: "/fake/tofu" };
  readonly calls: { dir: string; env: IacRunOptions["env"] }[] = [];

  constructor(private readonly outputs: Record<string, unknown> | "fail") {}

  async init(_dir: string, _options?: IacInitOptions): Promise<void> {}
  async validate() {
    return { valid: true, diagnostics: [] };
  }
  async plan(): Promise<never> {
    throw new Error("plan is not expected");
  }
  async apply(): Promise<never> {
    throw new Error("apply is not expected");
  }
  async output(dir: string, options?: IacRunOptions): Promise<Record<string, unknown>> {
    this.calls.push({ dir, env: options?.env });
    if (this.outputs === "fail") throw new Error("Backend initialization required");
    return this.outputs;
  }
}

/** Like a real engine: outputs can only be read once `init` set up the local backend. */
class InitFirstEngine extends OutputEngine {
  readonly inits: { dir: string; path: string | undefined }[] = [];

  constructor(
    outputs: Record<string, unknown>,
    private initialised = false,
  ) {
    super(outputs);
  }

  override async init(dir: string, options?: IacInitOptions): Promise<void> {
    this.inits.push({ dir, path: options?.backendConfig?.path });
    this.initialised = true;
  }

  override async output(dir: string, options?: IacRunOptions): Promise<Record<string, unknown>> {
    if (!this.initialised) throw new Error("Backend initialization required");
    return super.output(dir, options);
  }
}

const applied = (plan: DeployPlan = testPlan()): DeployPlan => ({
  ...plan,
  deployment: { ...plan.deployment, lastApplyAt: "2026-10-11T11:00:00.000Z" },
});

async function withState(root?: string) {
  const deps = await createTestPhaseDeps(root === undefined ? {} : { root });
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), '{"encrypted_data":"x"}');
  return deps;
}

describe("the server's address in OpsCrew's local state", () => {
  it("lives in .opscrew/server.json, inside the gitignored state folder", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });
    await recordServerAddress(deps.paths, { ipv4: IPV4, ipv6: IPV6 });
    const file = serverAddressesFile(deps.paths);
    expect(file).toBe(join(deps.paths.stateDir, "server.json"));
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: IPV4, ipv6: IPV6 },
    });
    expect(await readFile(join(deps.paths.stateDir, ".gitignore"), "utf8")).toBe("*\n");

    await updateServerAddresses(deps.paths, (s) => ({ ...s, retarget: { from: { ipv4: IPV4 } } }));
    await recordServerAddress(deps.paths, undefined);
    expect(await readServerAddresses(deps.paths)).toEqual({
      schemaVersion: 1,
      retarget: { from: { ipv4: IPV4 } },
    });
  });

  it("stops with a plain error when the file is damaged, never reading it as empty", async () => {
    const deps = await withState();
    const file = serverAddressesFile(deps.paths);
    const engine = new OutputEngine({ server_ipv4: IPV4 });
    for (const damaged of [
      "{ not json",
      JSON.stringify({ schemaVersion: 1, deployment: "x" }),
      JSON.stringify({ schemaVersion: 1, retarget: { from: { ipv4: "not an address" } } }),
      JSON.stringify({ deployment: { ipv4: IPV4 } }),
    ]) {
      await writeFile(file, damaged);
      for (const attempt of [
        () => readServerAddresses(deps.paths),
        () => serverAddress(deps, applied(), { engine: async () => engine }),
        () => recordServerAddress(deps.paths, { ipv4: IPV4 }),
      ]) {
        const error = await attempt().then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error, damaged).toMatchObject({ code: "ARTIFACT_INVALID" });
        const { message, hint } = error as { message: string; hint: string };
        expect(message).toContain(".opscrew/server.json");
        expect(message).toContain("is damaged");
        expect(hint).toContain("Fix the JSON in .opscrew/server.json");
        // An own server's record holds its connection and pinned host key: never just delete it.
        expect(hint).toMatch(
          /If this project deploys to your own server, do not delete the file: run `opscrew interview` again instead.*confirm the server's host key again/,
        );
        expect(hint).toMatch(/For Hetzner Cloud or DigitalOcean .*Delete \.opscrew\/server\.json/);
        expect(hint).toContain("on the computer that provisioned the server");
      }
      // Nothing guessed, nothing overwritten.
      expect(engine.calls).toEqual([]);
      expect(await readFile(file, "utf8")).toBe(damaged);
    }
  });

  it("sets a damaged file aside on request, and never a valid or missing one", async () => {
    const deps = await createTestPhaseDeps();
    expect(await setAsideServerAddresses(deps.paths)).toBeUndefined();
    await recordServerAddress(deps.paths, { ipv4: IPV4 });
    expect(await setAsideServerAddresses(deps.paths)).toBeUndefined();
    expect(await readServerAddresses(deps.paths)).toMatchObject({ deployment: { ipv4: IPV4 } });
    for (const damaged of ["{ not json", "{ still not json"]) {
      await writeFile(serverAddressesFile(deps.paths), damaged);
      const copy = await setAsideServerAddresses(deps.paths);
      expect(copy).toBe(damagedServerAddressesFile(deps.paths));
      expect(await readFile(copy as string, "utf8")).toBe(damaged);
      expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });
    }
  });

  it("stops with the same error when the file cannot be read", async () => {
    const deps = await createTestPhaseDeps();
    await mkdir(serverAddressesFile(deps.paths), { recursive: true });
    await expect(readServerAddresses(deps.paths)).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
    });
  });
});

describe("a server the user owns in OpsCrew's local state", () => {
  // A fingerprint-shaped value generated at runtime (`SHA256:` and 43 base64 characters).
  const HOST_KEY = `SHA256:${createHash("sha256").update("test host key").digest("base64").replace(/=+$/, "")}`;
  const own = { host: IPV4, user: "root", keyPath: "/home/me/.ssh/id_ed25519", agent: false };

  it("records how OpsCrew connects, fills the SSH port and keeps the other entries", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readOwnServer(deps.paths)).toBeUndefined();
    await recordServerAddress(deps.paths, { ipv4: IPV4 });
    await recordOwnServer(deps.paths, { ...own, hostKey: HOST_KEY, publicIpv6: IPV6 });
    expect(await readOwnServer(deps.paths)).toEqual({
      ...own,
      port: 22,
      hostKey: HOST_KEY,
      publicIpv6: IPV6,
    });
    expect(JSON.parse(await readFile(serverAddressesFile(deps.paths), "utf8"))).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: IPV4 },
      own: { ...own, port: 22, hostKey: HOST_KEY, publicIpv6: IPV6 },
    });

    const viaAgent = { host: "pi.home.example.com", port: 2222, user: "admin", agent: true };
    await recordOwnServer(deps.paths, { ...viaAgent, hostKey: HOST_KEY, publicIpv4: IPV4 });
    expect(await readOwnServer(deps.paths)).toEqual({
      ...viaAgent,
      hostKey: HOST_KEY,
      publicIpv4: IPV4,
    });

    await recordOwnServer(deps.paths, undefined);
    expect(await readServerAddresses(deps.paths)).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: IPV4 },
    });
  });

  it("refuses entries that could not connect safely and leaves the file as it was", async () => {
    const deps = await createTestPhaseDeps();
    await recordOwnServer(deps.paths, { ...own, hostKey: HOST_KEY });
    const before = await readFile(serverAddressesFile(deps.paths), "utf8");
    // Key-shaped values are generated at runtime, never committed.
    const pem = fakeSecret("private-key-pem");
    const pemFirstLine = pem.split("\n")[0] ?? "";
    for (const [label, bad] of [
      ["fingerprint", { ...own, hostKey: "MD5:aa:bb" }],
      ["host option", { ...own, host: "-oProxyCommand=evil" }],
      ["user option", { ...own, user: "-l root" }],
      ["port", { ...own, port: 0 }],
      ["no key and no agent", { ...own, keyPath: undefined }],
      ["password", { ...own, password: "x" }],
      ["key path option", { ...own, keyPath: "-oProxyCommand=evil" }],
      ["key path dash", { ...own, keyPath: "-/home/me/.ssh/id_ed25519" }],
      ["key itself", { ...own, keyPath: pem }],
      ["key marker", { ...own, keyPath: `/home/me/${pemFirstLine}` }],
      ["private key words", { ...own, keyPath: "/home/me/PRIVATE KEY" }],
      ["relative key path", { ...own, keyPath: ".ssh/id_ed25519" }],
      ["bare key name", { ...own, keyPath: "id_ed25519" }],
      ["drive without slash", { ...own, keyPath: "C:id_ed25519" }],
    ] as const) {
      const error = await recordOwnServer(deps.paths, { hostKey: HOST_KEY, ...bad } as never).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, label).toBeInstanceOf(Error);
      expect(String((error as Error).message), label).not.toContain("-----BEGIN");
    }
    expect(await readFile(serverAddressesFile(deps.paths), "utf8")).toBe(before);
  });

  it("records the login before the host key is pinned, with the reachability answer", async () => {
    const deps = await createTestPhaseDeps();
    await recordOwnServer(deps.paths, { ...own, reachable: false });
    expect(await readOwnServer(deps.paths)).toEqual({ ...own, port: 22, reachable: false });
    await recordOwnServer(deps.paths, { ...own, reachable: true, hostKey: HOST_KEY });
    expect(await readOwnServer(deps.paths)).toEqual({
      ...own,
      port: 22,
      reachable: true,
      hostKey: HOST_KEY,
    });
    const error = await recordOwnServer(deps.paths, { ...own, reachable: "yes" } as never).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
  });

  it("records how the site is served, and refuses any other answer", async () => {
    const deps = await createTestPhaseDeps();
    for (const serve of ["tunnel", "proxy", "dns-only"] as const) {
      await recordOwnServer(deps.paths, { ...own, reachable: true, serve });
      expect((await readOwnServer(deps.paths))?.serve).toBe(serve);
    }
    const error = await recordOwnServer(deps.paths, { ...own, serve: "open" } as never).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
  });

  it("accepts absolute key paths on every system, spaces included", async () => {
    const deps = await createTestPhaseDeps();
    for (const keyPath of [
      "/home/me/.ssh/id_ed25519",
      "~/.ssh/id_ed25519",
      "/home/me/my keys/id ed25519",
      "C:\\Users\\Me\\.ssh\\id_ed25519",
      "D:/keys/my key",
    ]) {
      await recordOwnServer(deps.paths, { ...own, keyPath, hostKey: HOST_KEY });
      expect((await readOwnServer(deps.paths))?.keyPath, keyPath).toBe(keyPath);
    }
  });

  it("stops with a plain error when the recorded entry is damaged", async () => {
    const deps = await createTestPhaseDeps();
    await mkdir(deps.paths.stateDir, { recursive: true });
    const damaged = JSON.stringify({ schemaVersion: 1, own: { ...own, hostKey: "nope" } });
    await writeFile(serverAddressesFile(deps.paths), damaged);
    const error = await readOwnServer(deps.paths).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ARTIFACT_INVALID" });
    expect((error as Error).message).toContain("own.hostKey is not valid");
  });
});

describe("an existing Portainer in OpsCrew's local state", () => {
  // Fingerprint-shaped values generated at runtime, never committed.
  const digest = createHash("sha256").update("test certificate").digest();
  const HEX = `SHA256:${digest.toString("hex")}`;
  const COLONS = `SHA256:${(digest.toString("hex").toUpperCase().match(/../g) ?? []).join(":")}`;
  const BASE64 = `SHA256:${digest.toString("base64").replace(/=+$/, "")}`;
  const portainer = {
    url: "https://portainer.home.example.com:9443",
    certFingerprint: HEX,
    environmentId: 3,
    environmentName: "local",
  };

  it("records the connection with an empty record of what OpsCrew created, and keeps the other entries", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readPortainerConnection(deps.paths)).toBeUndefined();
    await recordServerAddress(deps.paths, { ipv4: IPV4 });
    await recordPortainerConnection(deps.paths, portainer);
    const expected = { ...portainer, created: { stacks: [], volumes: [] } };
    expect(await readPortainerConnection(deps.paths)).toEqual(expected);
    expect(JSON.parse(await readFile(serverAddressesFile(deps.paths), "utf8"))).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: IPV4 },
      portainer: expected,
    });

    await recordPortainerConnection(deps.paths, undefined);
    expect(await readServerAddresses(deps.paths)).toEqual({
      schemaVersion: 1,
      deployment: { ipv4: IPV4 },
    });
  });

  it("records the stacks, registry entry and volumes OpsCrew created", async () => {
    const deps = await createTestPhaseDeps();
    const created: PortainerConnection["created"] = {
      stacks: [
        { id: 12, name: "opscrew-acme-web", role: "app" },
        { id: 13, name: "opscrew-acme-web-updater", role: "updater" },
        { id: 14, name: "opscrew-acme-web-tunnel", role: "tunnel-connector" },
      ],
      registryId: 2,
      volumes: ["opscrew-acme-web_pgdata", "opscrew-acme-web_caddy_data"],
    };
    await recordPortainerConnection(deps.paths, { ...portainer, created });
    expect((await readPortainerConnection(deps.paths))?.created).toEqual(created);
  });

  it("pins the certificate in the usual spellings, and connects to localhost over plain HTTP", async () => {
    const deps = await createTestPhaseDeps();
    for (const certFingerprint of [HEX, COLONS, BASE64]) {
      await recordPortainerConnection(deps.paths, { ...portainer, certFingerprint });
      expect((await readPortainerConnection(deps.paths))?.certFingerprint).toBe(certFingerprint);
    }
    for (const url of ["http://localhost:9000", "http://127.0.0.1:9000", "http://[::1]:9000"]) {
      const { certFingerprint: _pin, ...plain } = portainer;
      await recordPortainerConnection(deps.paths, { ...plain, url });
      expect((await readPortainerConnection(deps.paths))?.url, url).toBe(url);
    }
    // The interview may record the address before the certificate is confirmed.
    const { certFingerprint: _pin, ...unpinned } = portainer;
    await recordPortainerConnection(deps.paths, unpinned);
    expect((await readPortainerConnection(deps.paths))?.certFingerprint).toBeUndefined();
  });

  it("refuses entries that could not connect safely or would hold a secret, and leaves the file as it was", async () => {
    const deps = await createTestPhaseDeps();
    await recordPortainerConnection(deps.paths, portainer);
    const before = await readFile(serverAddressesFile(deps.paths), "utf8");
    const token = fakeSecret("generic-password");
    const stack = { id: 12, name: "opscrew-acme-web", role: "app" };
    const created = (extra: Record<string, unknown>) => ({
      ...portainer,
      created: { stacks: [stack], volumes: [], ...extra },
    });
    for (const [label, bad] of [
      ["token", { ...portainer, token }],
      ["api key", { ...portainer, apiKey: token }],
      ["webhook", { ...portainer, webhook: "1b4e28ba-2fa1-11d2-883f-0016d3cca427" }],
      ["password in the URL", { ...portainer, url: "https://admin:pw@portainer.example.com:9443" }],
      ["query in the URL", { ...portainer, url: "https://portainer.example.com:9443/?token=x" }],
      [
        "plain HTTP elsewhere",
        { ...portainer, certFingerprint: undefined, url: "http://nas.lan:9000" },
      ],
      ["pinned plain HTTP", { ...portainer, url: "http://localhost:9000" }],
      ["another scheme", { ...portainer, url: "ftp://portainer.example.com" }],
      ["not a URL", { ...portainer, url: "portainer.example.com:9443" }],
      ["fingerprint", { ...portainer, certFingerprint: "MD5:aa:bb" }],
      ["short fingerprint", { ...portainer, certFingerprint: "SHA256:abcd" }],
      ["environment id", { ...portainer, environmentId: 0 }],
      ["environment id text", { ...portainer, environmentId: "3" }],
      ["environment name", { ...portainer, environmentName: "" }],
      ["no environment", { url: portainer.url, certFingerprint: HEX }],
      ["stack id", created({ stacks: [{ ...stack, id: -1 }] })],
      ["someone else's stack", created({ stacks: [{ ...stack, name: "nextcloud" }] })],
      ["stack role", created({ stacks: [{ ...stack, role: "database" }] })],
      ["duplicate stack", created({ stacks: [stack, { ...stack, role: "updater" }] })],
      ["registry id", created({ registryId: 0 })],
      ["volume name", created({ volumes: ["../etc"] })],
      ["stack env", created({ stacks: [{ ...stack, env: [{ name: "X", value: token }] }] })],
    ] as const) {
      const error = await recordPortainerConnection(deps.paths, bad as never).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, label).toBeInstanceOf(Error);
      expect(String((error as Error).message), label).not.toContain(token);
    }
    expect(await readFile(serverAddressesFile(deps.paths), "utf8")).toBe(before);
  });

  it("stops with a plain error when the recorded entry is damaged", async () => {
    const deps = await createTestPhaseDeps();
    await mkdir(deps.paths.stateDir, { recursive: true });
    const damaged = JSON.stringify({
      schemaVersion: 1,
      portainer: { ...portainer, certFingerprint: "nope" },
    });
    await writeFile(serverAddressesFile(deps.paths), damaged);
    const error = await readPortainerConnection(deps.paths).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ARTIFACT_INVALID" });
    expect((error as Error).message).toContain("portainer.certFingerprint is not valid");
    // The record lists what OpsCrew created in Portainer: never just delete it.
    expect((error as { hint: string }).hint).toMatch(
      /If this project deploys to your Portainer, do not delete the file/,
    );
  });
});

describe("serverAddress", () => {
  it("reads the local state first and never asks the engine then", async () => {
    const deps = await withState();
    await recordServerAddress(deps.paths, { ipv4: IPV4 });
    const engine = new OutputEngine("fail");
    const address = await serverAddress(deps, applied(), { engine: async () => engine });
    expect(address).toEqual({ ipv4: IPV4 });
    expect(engine.calls).toEqual([]);
  });

  it("falls back to the OpenTofu outputs (decrypting the state) and records what it found", async () => {
    const deps = await withState();
    const passphrase = await ensureStatePassphrase(deps.paths);
    const engine = new OutputEngine({ server_ipv4: IPV4, server_ipv6: IPV6, server_id: "1" });
    const plan = applied();
    expect(await serverAddress(deps, plan, { engine: async () => engine })).toEqual({
      ipv4: IPV4,
      ipv6: IPV6,
    });
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]?.dir).toBe(join(deps.paths.root, plan.infra.dir));
    expect(engine.calls[0]?.env?.TF_ENCRYPTION).toContain("pbkdf2");
    expect(deps.redactor.redact(`x ${passphrase} y`)).not.toContain(passphrase);
    expect((await readServerAddresses(deps.paths)).deployment).toEqual({ ipv4: IPV4, ipv6: IPV6 });

    // Recorded: the next read does not need the engine.
    expect(await serverAddress(deps, plan, { engine: async () => engine })).toEqual({
      ipv4: IPV4,
      ipv6: IPV6,
    });
    expect(engine.calls).toHaveLength(1);
  });

  it("initialises the root module first on a computer with a copied state but no .terraform/", async () => {
    const deps = await withState();
    const plan = applied();
    const dir = join(deps.paths.root, plan.infra.dir);
    const state = join(deps.paths.files.tfstateDir, "prod.tfstate");
    const engine = new InitFirstEngine({ server_ipv4: IPV4 });
    expect(await serverAddress(deps, plan, { engine: async () => engine })).toEqual({ ipv4: IPV4 });
    expect(engine.inits).toEqual([{ dir, path: state }]);

    // Initialised before (a .terraform/ is there): the read comes first, and `init` only after a
    // failed one.
    await recordServerAddress(deps.paths, undefined);
    await mkdir(join(dir, ".terraform"), { recursive: true });
    const ready = new InitFirstEngine({ server_ipv4: IPV4 }, true);
    expect(await serverAddress(deps, plan, { engine: async () => ready })).toEqual({ ipv4: IPV4 });
    expect(ready.inits).toEqual([]);
    await recordServerAddress(deps.paths, undefined);
    const stale = new InitFirstEngine({ server_ipv4: IPV4 });
    expect(await serverAddress(deps, plan, { engine: async () => stale })).toEqual({ ipv4: IPV4 });
    expect(stale.inits).toEqual([{ dir, path: state }]);
  });

  it("uses the caller's engine environment when given", async () => {
    const deps = await withState();
    const engine = new OutputEngine({ server_ipv4: IPV4 });
    await serverAddress(deps, applied(), {
      engine: async () => engine,
      engineEnv: { TF_ENCRYPTION: "from-the-session" },
    });
    expect(engine.calls[0]?.env).toEqual({ TF_ENCRYPTION: "from-the-session" });
  });

  it("knows no address without an applied deployment, without state, or when the engine fails", async () => {
    const engine = new OutputEngine({ server_ipv4: IPV4 });
    const use = { engine: async () => engine };

    const deps = await withState();
    expect(await serverAddress(deps, testPlan(), use)).toBeUndefined();
    const destroyed = applied();
    destroyed.deployment.destroyedAt = "2026-10-11T12:00:00.000Z";
    expect(await serverAddress(deps, destroyed, use)).toBeUndefined();
    expect(engine.calls).toEqual([]);

    const noState = await createTestPhaseDeps();
    expect(await serverAddress(noState, applied(), use)).toBeUndefined();
    expect(engine.calls).toEqual([]);

    const failing = new OutputEngine("fail");
    expect(await serverAddress(deps, applied(), { engine: async () => failing })).toBeUndefined();
    const empty = new OutputEngine({});
    expect(await serverAddress(deps, applied(), { engine: async () => empty })).toBeUndefined();
    expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });

    // No engine installed (the default runner answers nothing): still just unknown.
    expect(await serverAddress(deps, applied())).toBeUndefined();
  });
});

describe("infrastructureOutputs", () => {
  it("reads the outputs with the engine the caller prefers, when the state is here", async () => {
    const deps = await withState();
    await ensureStatePassphrase(deps.paths);
    const engine = new OutputEngine({ server_ipv4: IPV4 });
    const asked: string[] = [];
    const outputs = await infrastructureOutputs(deps, testPlan(), {
      engine: async (preference) => {
        asked.push(preference);
        return engine;
      },
      preference: "terraform",
    });
    expect(outputs).toEqual({ server_ipv4: IPV4 });
    expect(asked).toEqual(["terraform"]);
    expect(engine.calls[0]?.env?.TF_ENCRYPTION).toContain("pbkdf2");
  });

  it("is undefined without a state file or when the engine fails", async () => {
    const engine = new OutputEngine({ server_ipv4: IPV4 });
    const none = await createTestPhaseDeps();
    expect(await infrastructureOutputs(none, testPlan(), { engine: async () => engine })).toBe(
      undefined,
    );
    expect(engine.calls).toEqual([]);
    const deps = await withState();
    const failing = new OutputEngine("fail");
    expect(
      await infrastructureOutputs(deps, testPlan(), { engine: async () => failing }),
    ).toBeUndefined();
  });
});

describe("helpers", () => {
  it("reads addresses from root-module outputs", () => {
    expect(addressFromOutputs({ server_ipv4: IPV4, server_ipv6: IPV6 })).toEqual({
      ipv4: IPV4,
      ipv6: IPV6,
    });
    expect(addressFromOutputs({ server_ipv4: IPV4, server_ipv6: "" })).toEqual({ ipv4: IPV4 });
    expect(addressFromOutputs({ server_ipv4: "" })).toBeUndefined();
  });

  it("reads each provider's server from the `servers` output", () => {
    const outputs = {
      server_ipv4: IPV4,
      servers: {
        hetzner: { ipv4: IPV4, ipv6: IPV6, id: "4711" },
        digitalocean: { ipv4: "198.51.100.30", ipv6: "not an address", id: "3164445" },
      },
    };
    expect(serverOfProvider(outputs, "hetzner")).toEqual({ ipv4: IPV4, ipv6: IPV6 });
    expect(serverOfProvider(outputs, "digitalocean")).toEqual({ ipv4: "198.51.100.30" });
    expect(
      serverOfProvider({ servers: { hetzner: outputs.servers.hetzner } }, "digitalocean"),
    ).toBe(undefined);
    for (const servers of [undefined, "x", null, { hetzner: "x" }, { hetzner: { ipv4: "" } }]) {
      expect(serverOfProvider({ server_ipv4: IPV4, servers }, "hetzner")).toBeUndefined();
    }
  });

  it("hides the address only behind Cloudflare's proxy", () => {
    expect(hidesServerAddress(testPlan({ domain: "shop.example.com" }))).toBe(true);
    expect(hidesServerAddress(testPlan())).toBe(false);
    const unproxied = testPlan({ domain: "shop.example.com" });
    expect(hidesServerAddress({ dns: { ...unproxied.dns, proxied: false } })).toBe(false);
  });

  it("removes every spelling-exact occurrence of the addresses from text", () => {
    const text = `Server: ${IPV4}. Probe ${IPV4}:22, not ${IPV4}0 or 1${IPV4}. AAAA ${IPV6.toUpperCase()}.`;
    expect(withoutServerAddress(text, [{ ipv4: IPV4, ipv6: IPV6 }, undefined])).toBe(
      `Server: the server. Probe the server:22, not ${IPV4}0 or 1${IPV4}. AAAA the server.`,
    );
  });

  it("commits only domain URLs", () => {
    expect(committableUrl("https://shop.example.com")).toBe("https://shop.example.com");
    expect(committableUrl(`http://${IPV4}`)).toBeUndefined();
    expect(committableUrl(`http://[${IPV6}]:8080/`)).toBeUndefined();
    expect(committableUrl(undefined)).toBeUndefined();
    expect(committableUrl("not a url")).toBeUndefined();
  });

  it("tells a deployed plan apart and formats addresses for the terminal", () => {
    expect(hasDeployment(testPlan())).toBe(false);
    expect(hasDeployment(applied())).toBe(true);
    expect(formatServerAddress({ ipv4: IPV4 })).toBe(IPV4);
    expect(formatServerAddress({ ipv4: IPV4, ipv6: IPV6 })).toBe(`${IPV4} (IPv6 ${IPV6})`);
  });
});
