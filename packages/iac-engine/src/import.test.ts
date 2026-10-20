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

describe("importResource", () => {
  it("runs `import <address> <id>` in the root with the caller's env and vars, as plan does", async () => {
    const runner = new ScriptedRunner().on("import", { stdout: "Import successful!" });
    await makeEngine(runner).importResource("infra/storage", "aws_s3_bucket.this", "shop-uploads", {
      env: { TF_ENCRYPTION: "x" },
      vars: { region: "fsn1" },
    });
    const [call] = runner.calls;
    expect(call?.args).toEqual([
      "import",
      "-input=false",
      "-no-color",
      "-var",
      "region=fsn1",
      "aws_s3_bucket.this",
      "shop-uploads",
    ]);
    expect(call?.options.cwd).toBe(path.resolve("infra/storage"));
    expect(call?.options.env).toMatchObject({ TF_ENCRYPTION: "x", TF_IN_AUTOMATION: "1" });
  });

  it("maps a failure to ENGINE_FAILED with the engine's redacted words", async () => {
    const key = fakeSecret("aws-secret-access-key");
    const runner = new ScriptedRunner().on("import", {
      exitCode: 1,
      stderr: `Error: Cannot import non-existent remote object ${key}`,
    });
    const error = await makeEngine(runner)
      .importResource("infra/storage", "aws_s3_bucket.this", "shop-uploads", {
        env: { AWS_SECRET_ACCESS_KEY: key },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    expect((error as Error).message).toContain("OpenTofu import failed (exit code 1)");
    expect((error as Error).message).toContain("Cannot import non-existent remote object");
    expect((error as Error).message).not.toContain(key);
  });
});
