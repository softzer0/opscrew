import path from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "./__fixtures__/fake-runner";
import { createEngine } from "./engine";

function makeEngine(runner: ScriptedRunner) {
  return createEngine(
    { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
    { runner, env: { PATH: "/usr/bin" } },
  );
}

describe("untaint", () => {
  it("runs `untaint -allow-missing <address>` in the root with the caller's env", async () => {
    const runner = new ScriptedRunner().on("untaint", { stdout: "Resource instance untainted." });
    await makeEngine(runner).untaint("infra/storage", "aws_s3_bucket.this", {
      env: { TF_ENCRYPTION: "x" },
    });
    const [call] = runner.calls;
    expect(call?.args).toEqual(["untaint", "-allow-missing", "-no-color", "aws_s3_bucket.this"]);
    expect(call?.options.cwd).toBe(path.resolve("infra/storage"));
    expect(call?.options.env).toMatchObject({ TF_ENCRYPTION: "x", TF_IN_AUTOMATION: "1" });
  });

  it("maps a failure to ENGINE_FAILED with a redacted tail", async () => {
    const key = fakeSecret("aws-secret-access-key");
    const runner = new ScriptedRunner().on("untaint", {
      exitCode: 1,
      stderr: `Error: Failed to load state ${key}`,
    });
    const error = await makeEngine(runner)
      .untaint("infra/storage", "aws_s3_bucket.this", { env: { AWS_SECRET_ACCESS_KEY: key } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    expect((error as Error).message).toContain("OpenTofu untaint failed (exit code 1)");
    expect((error as Error).message).not.toContain(key);
  });
});
