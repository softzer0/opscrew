import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IacEngine, IacEngineName } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixture, type RecordedCall, ScriptedRunner, writesPlan } from "./__fixtures__/fake-runner";
import { tofuEncryptionEnv } from "./encryption";
import { APPLY_TIMEOUT_MS, COMMAND_TIMEOUT_MS, createEngine } from "./engine";
import { hashFile } from "./hash";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-engine-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeEngine(
  runner: ScriptedRunner,
  name: IacEngineName = "tofu",
  env: Record<string, string | undefined> = { PATH: "/usr/bin" },
): IacEngine {
  return createEngine(
    { name, version: "1.13.1", binary: `/bin/${name}` },
    { runner, env, now: () => NOW },
  );
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("init", () => {
  it("runs non-interactively with backend config and automation env", async () => {
    const runner = new ScriptedRunner().on("init", { stdout: "ok" });
    await makeEngine(runner).init(dir, {
      upgrade: true,
      backendConfig: { path: "/abs/state/terraform.tfstate" },
      env: { HCLOUD_TOKEN: "x", TF_IN_AUTOMATION: "0" },
    });
    const [call] = runner.calls;
    expect(call?.command).toBe("/bin/tofu");
    expect(call?.args).toEqual([
      "init",
      "-input=false",
      "-no-color",
      "-upgrade",
      "-backend-config=path=/abs/state/terraform.tfstate",
    ]);
    expect(call?.options.cwd).toBe(path.resolve(dir));
    expect(call?.options.timeoutMs).toBe(COMMAND_TIMEOUT_MS);
    expect(call?.options.env).toMatchObject({
      PATH: "/usr/bin",
      HCLOUD_TOKEN: "x",
      TF_IN_AUTOMATION: "1",
      TF_INPUT: "0",
      CHECKPOINT_DISABLE: "1",
    });
  });

  it("maps a failure to ENGINE_FAILED with a redacted stderr tail", async () => {
    const token = fakeSecret("hcloud-token");
    const stderr = `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")}\nError: bad token ${token}\n`;
    const runner = new ScriptedRunner().on("init", { exitCode: 1, stderr });
    const error = await failure(makeEngine(runner).init(dir, { env: { HCLOUD_TOKEN: token } }));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("OpenTofu init failed (exit code 1)");
    expect(error.message).toContain("[REDACTED:HCLOUD_TOKEN]");
    expect(error.message).not.toContain(token);
    expect(error.message).not.toContain("line 5\n");
    expect(error.message).toContain("line 29");
    expect(error.hint).toBeTruthy();
  });

  it("maps a timeout to ENGINE_FAILED", async () => {
    const runner = new ScriptedRunner().on("init", { exitCode: 124, timedOut: true });
    const error = await failure(makeEngine(runner, "terraform").init(dir));
    expect(error.message).toContain("Terraform init timed out after 10 minutes");
  });

  it("maps a missing binary to ENGINE_NOT_FOUND", async () => {
    const runner = new ScriptedRunner().on("init", () => {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        "Could not run /bin/tofu: it is not installed or not on PATH.",
      );
    });
    const error = await failure(makeEngine(runner).init(dir));
    expect(error.code).toBe("ENGINE_NOT_FOUND");
  });
});

describe("validate", () => {
  it("returns valid for a clean configuration", async () => {
    const runner = new ScriptedRunner().on("validate", {
      stdout: JSON.stringify({
        format_version: "1.0",
        valid: true,
        error_count: 0,
        warning_count: 0,
        diagnostics: [],
      }),
    });
    expect(await makeEngine(runner).validate(dir)).toEqual({ valid: true, diagnostics: [] });
    expect(runner.calls[0]?.args).toEqual(["validate", "-json", "-no-color"]);
  });

  it("parses diagnostics from an invalid configuration (exit code 1)", async () => {
    const runner = new ScriptedRunner().on("validate", {
      exitCode: 1,
      stdout: JSON.stringify({
        valid: false,
        error_count: 1,
        warning_count: 1,
        diagnostics: [
          {
            severity: "error",
            summary: "Reference to undeclared input variable",
            detail: 'No variable "missing".',
            range: { filename: "main.tf", start: { line: 2, column: 11, byte: 42 } },
          },
          { severity: "warning", summary: "Deprecated" },
        ],
      }),
    });
    expect(await makeEngine(runner).validate(dir)).toEqual({
      valid: false,
      diagnostics: [
        {
          severity: "error",
          summary: "Reference to undeclared input variable",
          detail: 'No variable "missing".',
          file: "main.tf",
          line: 2,
        },
        { severity: "warning", summary: "Deprecated" },
      ],
    });
  });

  it("fails when the engine prints no JSON", async () => {
    const runner = new ScriptedRunner().on("validate", { exitCode: 1, stderr: "Error: crashed" });
    const error = await failure(makeEngine(runner).validate(dir));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("Error: crashed");
  });
});

describe("plan", () => {
  it("saves the plan, hashes it and summarises show -json", async () => {
    const runner = new ScriptedRunner()
      .on("plan", writesPlan("PLAN-BYTES-1"))
      .on("show", { stdout: fixture("show-mixed.json") });
    const summary = await makeEngine(runner).plan(dir, "plans/infra.tfplan", {
      vars: { location: "fsn1", name: "my-app" },
      destroy: true,
    });
    const planFile = path.join(path.resolve(dir), "plans", "infra.tfplan");
    expect(runner.calls[0]?.args).toEqual([
      "plan",
      "-input=false",
      "-no-color",
      `-out=${planFile}`,
      "-detailed-exitcode",
      "-destroy",
      "-var",
      "location=fsn1",
      "-var",
      "name=my-app",
    ]);
    expect(runner.calls[1]?.args).toEqual(["show", "-json", "-no-color", planFile]);
    expect(summary).toMatchObject({
      engine: { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
      dir: path.resolve(dir),
      planFile,
      planHash: sha256("PLAN-BYTES-1"),
      createdAt: NOW.toISOString(),
      counts: { create: 1, update: 1, delete: 1, replace: 2 },
      hasDestroy: true,
    });
    expect(summary.changes).toHaveLength(5);
    expect(summary.planJson).toEqual(JSON.parse(fixture("show-mixed.json")));
    expect(await hashFile(planFile)).toBe(summary.planHash);
  });

  it("accepts exit code 0 (no changes)", async () => {
    const runner = new ScriptedRunner()
      .on("plan", writesPlan("EMPTY", 0))
      .on("show", { stdout: fixture("show-noop.json") });
    const summary = await makeEngine(runner).plan(dir, "p.tfplan");
    expect(summary.changes).toEqual([]);
    expect(summary.hasDestroy).toBe(false);
  });

  it("fails on exit code 1 and removes a stale plan file first", async () => {
    const stale = path.join(dir, "p.tfplan");
    await writeFile(stale, "OLD");
    const runner = new ScriptedRunner().on("plan", {
      exitCode: 1,
      stderr: "Error: Invalid reference",
    });
    const error = await failure(makeEngine(runner).plan(dir, "p.tfplan"));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("OpenTofu plan failed (exit code 1)");
    expect(error.message).toContain("Error: Invalid reference");
    expect(existsSync(stale)).toBe(false);
  });

  it("rejects invalid variable names", async () => {
    const runner = new ScriptedRunner();
    const error = await failure(
      makeEngine(runner).plan(dir, "p.tfplan", { vars: { "bad name": "x" } }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(runner.calls).toEqual([]);
  });

  it("passes TF_ENCRYPTION to OpenTofu but never to Terraform, and redacts the passphrase", async () => {
    const passphrase = `${fakeSecret("generic-password")}-passphrase`;
    const env = { TF_ENCRYPTION: tofuEncryptionEnv(passphrase) };

    const tofu = new ScriptedRunner().on("plan", {
      exitCode: 1,
      stderr: `Error: decrypt with ${passphrase} failed`,
    });
    const error = await failure(makeEngine(tofu).plan(dir, "p.tfplan", { env }));
    expect(tofu.calls[0]?.options.env?.TF_ENCRYPTION).toBe(env.TF_ENCRYPTION);
    expect(error.message).not.toContain(passphrase);
    expect(error.message).toContain("[REDACTED:TF_ENCRYPTION]");

    const terraform = new ScriptedRunner().on("plan", writesPlan("X")).on("show", { stdout: "{}" });
    await makeEngine(terraform, "terraform", { TF_ENCRYPTION: "base" }).plan(dir, "p.tfplan", {
      env,
    });
    for (const call of terraform.calls)
      expect(call.options.env).not.toHaveProperty("TF_ENCRYPTION");
  });

  it("streams redacted progress lines", async () => {
    const token = fakeSecret("cloudflare-token");
    const lines: string[] = [];
    const runner = new ScriptedRunner()
      .on("plan", async (call) => {
        await (writesPlan("X") as (c: RecordedCall) => Promise<unknown>)(call);
        return { exitCode: 2, stdout: `using ${token}\nPlan: 1 to add` };
      })
      .on("show", { stdout: fixture("show-create.json") });
    await makeEngine(runner).plan(dir, "p.tfplan", {
      env: { CLOUDFLARE_API_TOKEN: token },
      onOutput: (line) => lines.push(line),
    });
    expect(lines.join("\n")).not.toContain(token);
    expect(lines).toContain("Plan: 1 to add");
  });
});

describe("apply", () => {
  async function planned(content: string, show: string) {
    const file = path.join(dir, "p.tfplan");
    await writeFile(file, content);
    const runner = new ScriptedRunner()
      .on("show", { stdout: show })
      .on("apply", { stdout: "Apply complete! Resources: 2 added, 0 changed, 0 destroyed." })
      .on("output", {
        stdout: JSON.stringify({
          ipv4: { sensitive: false, type: "string", value: "203.0.113.10" },
        }),
      });
    return { file, runner, hash: sha256(content) };
  }

  it("applies exactly the approved plan (hash compared case-insensitively) and returns outputs", async () => {
    const { file, runner, hash } = await planned("PLAN-A", fixture("show-create.json"));
    const result = await makeEngine(runner).apply(dir, "p.tfplan", {
      approvedPlanHash: hash.toUpperCase(),
    });
    expect(result).toEqual({
      ok: true,
      outputs: { ipv4: "203.0.113.10" },
      log: "Apply complete! Resources: 2 added, 0 changed, 0 destroyed.",
    });
    expect(runner.subcommands()).toEqual(["show", "apply", "output"]);
    const applyCall = runner.calls[1];
    expect(applyCall?.args.slice(0, 3)).toEqual(["apply", "-input=false", "-no-color"]);
    // The apply runs on a private copy of the verified bytes, which is removed afterwards.
    const applied = applyCall?.args[3] ?? "";
    expect(applied).not.toBe(file);
    expect(runner.calls[0]?.args[3]).toBe(applied);
    expect(existsSync(applied)).toBe(false);
    expect(applyCall?.options.timeoutMs).toBe(APPLY_TIMEOUT_MS);
    expect(applyCall?.options.cwd).toBe(path.resolve(dir));
  });

  it("refuses a plan that changed after approval", async () => {
    const { file, runner, hash } = await planned("PLAN-A", fixture("show-create.json"));
    await writeFile(file, "PLAN-A-TAMPERED");
    const error = await failure(makeEngine(runner).apply(dir, file, { approvedPlanHash: hash }));
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toContain("plan changed since it was approved");
    expect(runner.calls).toEqual([]);
  });

  it("refuses deletes and replaces without allowDestroy", async () => {
    const { runner, hash } = await planned("PLAN-D", fixture("show-mixed.json"));
    const error = await failure(
      makeEngine(runner).apply(dir, "p.tfplan", { approvedPlanHash: hash }),
    );
    expect(error.code).toBe("DESTROY_NOT_APPROVED");
    expect(error.message).toContain("hcloud_server.app (replace)");
    expect(error.message).toContain("hcloud_ssh_key.old (delete)");
    expect(runner.subcommands()).toEqual(["show"]);
  });

  it("applies deletes and replaces with allowDestroy", async () => {
    const { runner, hash } = await planned("PLAN-D", fixture("show-mixed.json"));
    const result = await makeEngine(runner).apply(dir, "p.tfplan", {
      approvedPlanHash: hash,
      allowDestroy: true,
    });
    expect(result.ok).toBe(true);
    expect(runner.subcommands()).toEqual(["show", "apply", "output"]);
  });

  it("refuses a missing or malformed approval hash", async () => {
    const { runner } = await planned("PLAN-A", fixture("show-create.json"));
    const error = await failure(
      makeEngine(runner).apply(dir, "p.tfplan", { approvedPlanHash: "abc" }),
    );
    expect(error.code).toBe("PLAN_NOT_APPROVED");
    expect(runner.calls).toEqual([]);
  });

  it("reports a missing plan file", async () => {
    const runner = new ScriptedRunner();
    const error = await failure(
      makeEngine(runner).apply(dir, "missing.tfplan", { approvedPlanHash: sha256("x") }),
    );
    expect(error.code).toBe("ARTIFACT_MISSING");
  });

  it("returns ok: false with a redacted log when apply fails", async () => {
    const token = fakeSecret("hcloud-token");
    const { file, hash } = await planned("PLAN-A", fixture("show-create.json"));
    const runner = new ScriptedRunner()
      .on("show", { stdout: fixture("show-create.json") })
      .on("apply", { exitCode: 1, stdout: "Creating...", stderr: `Error: 401 for ${token}` });
    const result = await makeEngine(runner).apply(
      dir,
      file,
      { approvedPlanHash: hash },
      { env: { HCLOUD_TOKEN: token } },
    );
    expect(result.ok).toBe(false);
    expect(result.outputs).toEqual({});
    expect(result.log).toContain("Creating...");
    expect(result.log).toContain("OpenTofu apply failed (exit code 1).");
    expect(result.log).not.toContain(token);
  });
});

describe("output and hashFile", () => {
  it("unwraps output values and handles an empty state", async () => {
    const runner = new ScriptedRunner().on(
      "output",
      { stdout: JSON.stringify({ a: { value: "x" }, b: { value: [1, 2], sensitive: false } }) },
      { stdout: "{}\n" },
    );
    const engine = makeEngine(runner);
    expect(await engine.output(dir)).toEqual({ a: "x", b: [1, 2] });
    expect(await engine.output(dir)).toEqual({});
    expect(runner.calls[0]?.args).toEqual(["output", "-json", "-no-color"]);
  });

  it("hashFile returns the lowercase SHA-256 hex of the file bytes", async () => {
    const file = path.join(dir, "f.bin");
    await writeFile(file, Buffer.from([0, 1, 2, 255]));
    expect(await hashFile(file)).toBe(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
    );
    expect(await hashFile(file)).toMatch(/^[0-9a-f]{64}$/);
  });
});
