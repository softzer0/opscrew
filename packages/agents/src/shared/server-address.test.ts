import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, IacRunOptions } from "@opscrew/contracts";
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
  readServerAddresses,
  recordServerAddress,
  serverAddress,
  serverAddressesFile,
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

  async init(): Promise<void> {}
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

  it("reads a damaged file as empty instead of failing", async () => {
    const deps = await createTestPhaseDeps();
    await mkdir(deps.paths.stateDir, { recursive: true });
    await writeFile(serverAddressesFile(deps.paths), "{ not json");
    expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });
    await writeFile(serverAddressesFile(deps.paths), JSON.stringify({ deployment: "x" }));
    expect(await readServerAddresses(deps.paths)).toEqual({ schemaVersion: 1 });
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

describe("helpers", () => {
  it("reads addresses from root-module outputs", () => {
    const outputs = {
      server_ipv4: IPV4,
      server_ipv6: IPV6,
      other_server_ipv4: "198.51.100.20",
      other_server_ipv6: "not an address",
    };
    expect(addressFromOutputs(outputs)).toEqual({ ipv4: IPV4, ipv6: IPV6 });
    expect(addressFromOutputs(outputs, "other_server")).toEqual({ ipv4: "198.51.100.20" });
    expect(addressFromOutputs({ server_ipv4: "" })).toBeUndefined();
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
