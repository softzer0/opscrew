import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      backendConfig: { path: "/abs/state/terraform.tfstate" },
      env: { HCLOUD_TOKEN: "x", TF_IN_AUTOMATION: "0" },
    });
    const [call] = runner.calls;
    expect(call?.command).toBe("/bin/tofu");
    expect(call?.args).toEqual([
      "init",
      "-input=false",
      "-no-color",
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

  it("tries again when the provider registry does not answer, then goes on", async () => {
    const busy = {
      exitCode: 1,
      stderr:
        "Error: Failed to install provider\n\nError while installing hetznercloud/hcloud v1.70.2: could not query provider\nregistry for registry.opentofu.org/hetznercloud/hcloud: failed to retrieve\ncryptographic signature for provider: request failed after 2 attempts: 504\n",
    };
    const runner = new ScriptedRunner().on("init", busy, busy, { stdout: "ok" });
    const waits: number[] = [];
    const engine = createEngine(
      { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
      {
        runner,
        env: { PATH: "/usr/bin" },
        now: () => NOW,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    );
    await engine.init(dir);
    expect(runner.subcommands()).toEqual(["init", "init", "init"]);
    expect(waits).toEqual([5_000, 15_000]);
  });

  it("stops after three tries of an unanswering registry, and never tries again otherwise", async () => {
    const busy = {
      exitCode: 1,
      stderr:
        "Error while installing x/y v1.0.0: could not query provider registry for registry.opentofu.org/x/y: 503\n",
    };
    const runner = new ScriptedRunner().on("init", busy);
    const sleep = async () => {};
    const engine = (r: ScriptedRunner) =>
      createEngine(
        { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
        { runner: r, env: { PATH: "/usr/bin" }, now: () => NOW, sleep },
      );
    const error = await failure(engine(runner).init(dir));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(runner.subcommands()).toEqual(["init", "init", "init"]);

    const other = new ScriptedRunner().on("init", {
      exitCode: 1,
      stderr: "Error: Unsupported argument\n",
    });
    await failure(engine(other).init(dir));
    expect(other.subcommands()).toEqual(["init"]);
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

  it("masks the values of every secret-looking variable in its output (DJANGO_SECRET_KEY, MINIO_ACCESS_KEY)", async () => {
    const django = fakeSecret("generic-password", "django");
    const minio = fakeSecret("generic-password", "minio");
    const runner = new ScriptedRunner().on("init", {
      exitCode: 1,
      stderr: `Error: rejected ${django} and ${minio}\n`,
    });
    const error = await failure(
      makeEngine(runner).init(dir, { env: { DJANGO_SECRET_KEY: django, MINIO_ACCESS_KEY: minio } }),
    );
    expect(error.message).toContain(
      "rejected [REDACTED:DJANGO_SECRET_KEY] and [REDACTED:MINIO_ACCESS_KEY]",
    );
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

  it("names the field when the JSON does not have the expected shape", async () => {
    const runner = new ScriptedRunner().on("validate", {
      exitCode: 1,
      stdout: JSON.stringify({ valid: false, diagnostics: [{ severity: "error" }] }),
    });
    const error = await failure(makeEngine(runner).validate(dir));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("OpenTofu printed validation results that could not be read");
    expect(error.message).toContain("diagnostics.0.summary");
    expect(error.hint).toBe("Check that OpenTofu is version 1.6 or newer, then try again.");
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

  it("refuses a saved plan whose show -json has an unexpected shape, saying what to do", async () => {
    const malformed = JSON.stringify({
      format_version: "1.2",
      resource_changes: [{ address: "hcloud_server.app", type: "hcloud_server", change: {} }],
    });
    const runner = new ScriptedRunner()
      .on("plan", writesPlan("PLAN-BYTES"))
      .on("show", { stdout: malformed });
    const error = await failure(makeEngine(runner).plan(dir, "p.tfplan"));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("resource_changes.0.name");
    expect(error.hint).toMatch(/create the plan again/);
  });

  it("passes -refresh-only and reports drift with no changes", async () => {
    const runner = new ScriptedRunner()
      .on("plan", writesPlan("REFRESH"))
      .on("show", { stdout: fixture("show-drift-tofu.json") });
    const summary = await makeEngine(runner).plan(dir, "drift.tfplan", {
      refreshOnly: true,
      vars: { name: "my-app" },
    });
    expect(runner.calls[0]?.args).toEqual([
      "plan",
      "-input=false",
      "-no-color",
      `-out=${path.join(path.resolve(dir), "drift.tfplan")}`,
      "-detailed-exitcode",
      "-refresh-only",
      "-var",
      "name=my-app",
    ]);
    expect(summary.changes).toEqual([]);
    expect(summary.counts).toEqual({ create: 0, update: 0, delete: 0, replace: 0 });
    expect(summary.hasDestroy).toBe(false);
    expect(summary.drift?.map((d) => [d.address, d.action, d.attributes])).toEqual([
      ["hcloud_firewall.web", "update", ["rule"]],
      ["local_file.note", "delete", []],
    ]);
  });

  it("reports drift found while planning normal changes, and omits drift when there is none", async () => {
    const drifted = new ScriptedRunner()
      .on("plan", writesPlan("NORMAL"))
      .on("show", { stdout: fixture("show-drift-terraform.json") });
    const summary = await makeEngine(drifted, "terraform").plan(dir, "p.tfplan");
    expect(drifted.calls[0]?.args).not.toContain("-refresh-only");
    expect(summary.counts.update).toBe(1);
    expect(summary.drift).toHaveLength(2);

    const clean = new ScriptedRunner()
      .on("plan", writesPlan("CLEAN", 0))
      .on("show", { stdout: fixture("show-refresh-clean.json") });
    const none = await makeEngine(clean, "terraform").plan(dir, "p.tfplan", { refreshOnly: true });
    expect(none.changes).toEqual([]);
    expect(none).not.toHaveProperty("drift");
  });

  it("reports the moves of a moves-only plan without changes, and omits moves when there are none", async () => {
    const runner = new ScriptedRunner()
      .on("plan", writesPlan("MOVES"))
      .on("show", { stdout: fixture("show-moves-terraform.json") });
    const summary = await makeEngine(runner, "terraform").plan(dir, "p.tfplan");
    expect(summary.changes).toEqual([]);
    expect(summary.hasDestroy).toBe(false);
    expect(summary.moves).toEqual([
      {
        from: "module.server.terraform_data.this",
        to: "module.server_previous.terraform_data.this",
        type: "terraform_data",
      },
    ]);

    const plain = new ScriptedRunner()
      .on("plan", writesPlan("PLAIN"))
      .on("show", { stdout: fixture("show-create.json") });
    expect(await makeEngine(plain).plan(dir, "p.tfplan")).not.toHaveProperty("moves");
  });

  it("rejects refreshOnly combined with destroy before running anything", async () => {
    const stale = path.join(dir, "p.tfplan");
    await writeFile(stale, "OLD");
    const runner = new ScriptedRunner();
    const error = await failure(
      makeEngine(runner).plan(dir, "p.tfplan", { refreshOnly: true, destroy: true }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.hint).toBeTruthy();
    expect(runner.calls).toEqual([]);
    expect(existsSync(stale)).toBe(true);
  });

  it("passes -replace=<address> for each address to both engines and summarises the replacement", async () => {
    for (const name of ["tofu", "terraform"] as const) {
      const runner = new ScriptedRunner()
        .on("plan", writesPlan("REPLACE"))
        .on("show", { stdout: fixture("show-mixed.json") });
      const summary = await makeEngine(runner, name).plan(dir, "p.tfplan", {
        replace: ["hcloud_server.app", "hcloud_primary_ip.v4"],
        vars: { name: "my-app" },
      });
      expect(runner.calls[0]?.args).toEqual([
        "plan",
        "-input=false",
        "-no-color",
        `-out=${path.join(path.resolve(dir), "p.tfplan")}`,
        "-detailed-exitcode",
        "-replace=hcloud_server.app",
        "-replace=hcloud_primary_ip.v4",
        "-var",
        "name=my-app",
      ]);
      expect(summary.counts.replace).toBe(2);
      expect(summary.hasDestroy).toBe(true);
    }
  });

  it("fails, removing the plan file, when the plan does not replace an address asked for", async () => {
    const runner = new ScriptedRunner()
      .on("plan", writesPlan("NOT-REPLACED"))
      .on("show", { stdout: fixture("show-mixed.json") });
    const error = await failure(
      makeEngine(runner).plan(dir, "p.tfplan", {
        replace: ["hcloud_server.app", "hcloud_firewall.web", "cloudflare_tunnel.missing"],
      }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("hcloud_firewall.web, cloudflare_tunnel.missing");
    expect(error.message).not.toContain("hcloud_server.app");
    expect(error.hint).toBeTruthy();
    expect(existsSync(path.join(dir, "p.tfplan"))).toBe(false);
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

  it("names the output whose JSON does not have the expected shape", async () => {
    const runner = new ScriptedRunner().on("output", { stdout: JSON.stringify({ a: "x" }) });
    const error = await failure(makeEngine(runner).output(dir));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("OpenTofu printed outputs that could not be read (a: ");
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

describe("homeCacheFiles", () => {
  const TOKEN = ".cache/contabo/terraform/token";

  function cacheEngine(
    runner: ScriptedRunner,
    env: Record<string, string | undefined>,
    removeFile: (file: string) => Promise<void>,
  ): IacEngine {
    return createEngine(
      { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
      { runner, env, now: () => NOW, homeCacheFiles: [TOKEN], removeFile },
    );
  }

  it("removes each file under HOME before and after every command", async () => {
    const events: string[] = [];
    const runner = new ScriptedRunner().on("output", () => {
      events.push("output");
      return { stdout: "{}" };
    });
    const engine = cacheEngine(
      runner,
      { HOME: "/home/me", USERPROFILE: "C:Usersme" },
      async (file) => {
        events.push(file);
      },
    );
    await engine.output(dir);
    const token = path.join("/home/me", TOKEN);
    expect(events).toEqual([token, "output", token]);
  });

  it("uses the home the command's own environment names: HOME, else USERPROFILE, else HOMEDRIVE and HOMEPATH", async () => {
    const removed: string[] = [];
    const remove = async (file: string) => {
      removed.push(file);
    };
    const runner = new ScriptedRunner().on("output", { stdout: "{}" });
    await cacheEngine(runner, { USERPROFILE: "C:Usersme" }, remove).output(dir, {
      env: { HOME: "/run/home" },
    });
    await cacheEngine(runner, { HOME: "", USERPROFILE: "C:Usersme" }, remove).output(dir);
    await cacheEngine(runner, { HOMEDRIVE: "D:", HOMEPATH: "Usersme" }, remove).output(dir);
    expect(removed).toEqual([
      path.join("/run/home", TOKEN),
      path.join("/run/home", TOKEN),
      path.join("C:Usersme", TOKEN),
      path.join("C:Usersme", TOKEN),
      path.join("D:Usersme", TOKEN),
      path.join("D:Usersme", TOKEN),
    ]);
  });

  it("removes nothing and runs as before without home cache files", async () => {
    const runner = new ScriptedRunner().on("output", { stdout: "{}" });
    let removals = 0;
    const engine = createEngine(
      { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
      { runner, env: { HOME: "/home/me" }, removeFile: async () => void removals++ },
    );
    await engine.output(dir);
    expect(removals).toBe(0);
  });

  it("removes a real file and is fine when it is missing", async () => {
    const home = path.join(dir, "home");
    const file = path.join(home, TOKEN);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "cached login");
    const runner = new ScriptedRunner().on("output", { stdout: "{}" });
    const engine = createEngine(
      { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
      { runner, env: { HOME: home }, homeCacheFiles: [TOKEN] },
    );
    await engine.output(dir);
    expect(existsSync(file)).toBe(false);
    await engine.output(dir);
    expect(runner.calls).toHaveLength(2);
  });

  it("stops before the command when a removal fails, naming the file", async () => {
    const runner = new ScriptedRunner().on("output", { stdout: "{}" });
    const engine = cacheEngine(runner, { HOME: "/home/me" }, async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });
    const error = await failure(engine.output(dir));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain(path.join("/home/me", TOKEN));
    expect(error.hint).toContain("Delete");
    expect(runner.calls).toHaveLength(0);
  });

  it("keeps the command's result when the removal after it fails, and says so", async () => {
    const runner = new ScriptedRunner().on("output", { stdout: '{"a":{"value":"x"}}' });
    let calls = 0;
    const engine = cacheEngine(runner, { HOME: "/home/me" }, async () => {
      if (++calls > 1) throw new Error("EBUSY");
    });
    const lines: string[] = [];
    expect(await engine.output(dir, { onOutput: (line) => lines.push(line) })).toEqual({ a: "x" });
    expect(lines.some((line) => line.includes(path.join("/home/me", TOKEN)))).toBe(true);
  });
});
