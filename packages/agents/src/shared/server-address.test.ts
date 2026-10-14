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
  ensureStatePassphrase,
  formatServerAddress,
  hasDeployment,
  hidesServerAddress,
  infrastructureOutputs,
  readOwnServer,
  readServerAddresses,
  recordOwnServer,
  recordServerAddress,
  serverAddress,
  serverAddressesFile,
  serverOfProvider,
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
        expect(hint).toContain("Delete .opscrew/server.json");
        expect(hint).toContain("on the computer that provisioned the server");
      }
      // Nothing guessed, nothing overwritten.
      expect(engine.calls).toEqual([]);
      expect(await readFile(file, "utf8")).toBe(damaged);
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
