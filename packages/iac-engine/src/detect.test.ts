import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "./__fixtures__/fake-runner";
import { detectEngines, MIN_ENGINE_VERSION, selectEngine, versionAtLeast } from "./detect";

const versionJson = (v: string) =>
  JSON.stringify({ terraform_version: v, platform: "linux_amd64", provider_selections: {} });

/** Fake PATH lookup: `installed` maps a name or configured path to the resolved binary. */
function finder(installed: Record<string, string>) {
  return (name: string) => installed[name];
}

function runnerFor(versions: Record<string, string>): ScriptedRunner {
  const runner = new ScriptedRunner();
  runner.on("version", (call) => {
    const version = versions[call.command];
    return version === undefined
      ? { exitCode: 1, stderr: "boom" }
      : { stdout: versionJson(version) };
  });
  return runner;
}

describe("versionAtLeast", () => {
  it("compares semantic versions", () => {
    expect(MIN_ENGINE_VERSION).toBe("1.6.0");
    expect(versionAtLeast("1.13.1")).toBe(true);
    expect(versionAtLeast("1.6.0")).toBe(true);
    expect(versionAtLeast("1.5.7")).toBe(false);
    expect(versionAtLeast("2.0.0")).toBe(true);
    expect(versionAtLeast("garbage")).toBe(false);
  });
});

describe("detectEngines", () => {
  it("prefers OPSCREW_*_BIN over PATH and reads versions with version -json", async () => {
    const runner = runnerFor({ "/opt/tofu": "1.13.1", "/usr/bin/terraform": "1.16.5" });
    const found = await detectEngines({
      env: { OPSCREW_TOFU_BIN: "/opt/tofu" },
      runner,
      findExecutable: finder({
        "/opt/tofu": "/opt/tofu",
        tofu: "/usr/bin/tofu",
        terraform: "/usr/bin/terraform",
      }),
    });
    expect(found).toEqual([
      { name: "tofu", version: "1.13.1", binary: "/opt/tofu", source: "env", supported: true },
      {
        name: "terraform",
        version: "1.16.5",
        binary: "/usr/bin/terraform",
        source: "path",
        supported: true,
      },
    ]);
    expect(runner.calls[0]?.args).toEqual(["version", "-json"]);
  });

  it("reports a misconfigured OPSCREW_TOFU_BIN instead of falling back to PATH", async () => {
    const found = await detectEngines({
      env: { OPSCREW_TOFU_BIN: "/nope/tofu" },
      runner: runnerFor({}),
      findExecutable: finder({ tofu: "/usr/bin/tofu" }),
    });
    expect(found).toEqual([
      expect.objectContaining({
        name: "tofu",
        supported: false,
        problem: expect.stringContaining("OPSCREW_TOFU_BIN"),
      }),
    ]);
  });

  it("marks old versions and broken binaries unsupported", async () => {
    const runner = runnerFor({ "/usr/bin/tofu": "1.5.7" });
    const found = await detectEngines({
      env: {},
      runner,
      findExecutable: finder({ tofu: "/usr/bin/tofu", terraform: "/usr/bin/terraform" }),
    });
    expect(found.map((f) => [f.name, f.supported])).toEqual([
      ["tofu", false],
      ["terraform", false],
    ]);
    expect(found[0]?.problem).toContain("older than the minimum 1.6.0");
  });

  it("treats non-JSON version output as unsupported", async () => {
    const runner = new ScriptedRunner().on("version", { stdout: "Terraform v0.12.0" });
    const [entry] = await detectEngines({
      env: {},
      runner,
      findExecutable: finder({ terraform: "/bin/terraform" }),
    });
    expect(entry).toMatchObject({ name: "terraform", supported: false });
  });
});

describe("selectEngine", () => {
  const both = { tofu: "/bin/tofu", terraform: "/bin/terraform" };
  const versions = { "/bin/tofu": "1.13.1", "/bin/terraform": "1.16.5" };

  it("auto picks OpenTofu when only tofu is installed", async () => {
    const engine = await selectEngine("auto", {
      env: {},
      runner: runnerFor(versions),
      findExecutable: finder({ tofu: "/bin/tofu" }),
    });
    expect(engine.info).toEqual({ name: "tofu", version: "1.13.1", binary: "/bin/tofu" });
  });

  it("auto picks OpenTofu when both are installed", async () => {
    const engine = await selectEngine("auto", {
      env: {},
      runner: runnerFor(versions),
      findExecutable: finder(both),
    });
    expect(engine.info.name).toBe("tofu");
  });

  it("auto falls back to Terraform", async () => {
    const engine = await selectEngine("auto", {
      env: {},
      runner: runnerFor(versions),
      findExecutable: finder({ terraform: "/bin/terraform" }),
    });
    expect(engine.info.name).toBe("terraform");
  });

  it("honours an explicit terraform preference", async () => {
    const engine = await selectEngine("terraform", {
      env: {},
      runner: runnerFor(versions),
      findExecutable: finder(both),
    });
    expect(engine.info).toEqual({ name: "terraform", version: "1.16.5", binary: "/bin/terraform" });
  });

  it("fails with install instructions for both when nothing is installed", async () => {
    const error = await selectEngine("auto", {
      env: {},
      runner: runnerFor({}),
      findExecutable: finder({}),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ENGINE_NOT_FOUND" });
    const { message, hint } = error as { message: string; hint: string };
    expect(message).toContain("Neither OpenTofu nor Terraform is installed");
    expect(hint).toContain("https://opentofu.org/docs/intro/install/");
    expect(hint).toContain("https://developer.hashicorp.com/terraform/install");
  });

  it("explains an engine that is too old", async () => {
    const error = await selectEngine("tofu", {
      env: {},
      runner: runnerFor({ "/bin/tofu": "1.5.0" }),
      findExecutable: finder(both),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "ENGINE_NOT_FOUND",
      message: expect.stringContaining("1.5.0"),
    });
    expect((error as { hint: string }).hint).toContain("1.6.0 or newer");
  });
});
