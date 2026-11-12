import { existsSync } from "node:fs";
import path from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "./__fixtures__/fake-runner";
import { createEngine } from "./engine";

const SERVER = "module.server.contabo_instance.this";
const EXTRA = "module.server_worker.contabo_instance.this";

function makeEngine(runner: ScriptedRunner) {
  return createEngine(
    { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
    { runner, env: { PATH: "/usr/bin" } },
  );
}

describe("stateRemove", () => {
  it("runs `state rm <addresses>` in the root with the caller's env, its backup in a scratch folder removed afterwards", async () => {
    const runner = new ScriptedRunner().on("state", {
      stdout: "Successfully removed 2 resource instance(s).",
    });
    await makeEngine(runner).stateRemove("infra", [SERVER, EXTRA], {
      env: { TF_ENCRYPTION: "x" },
    });
    const [call] = runner.calls;
    const backup = call?.args.find((arg) => arg.startsWith("-backup="))?.slice("-backup=".length);
    expect(call?.args).toEqual(["state", "rm", "-no-color", `-backup=${backup}`, SERVER, EXTRA]);
    expect(call?.options.cwd).toBe(path.resolve("infra"));
    expect(call?.options.env).toMatchObject({ TF_ENCRYPTION: "x", TF_IN_AUTOMATION: "1" });
    // State commands always write a backup of the whole state: never into the root (a project
    // folder), and gone once the command ran.
    expect(backup).toBeDefined();
    expect(path.dirname(backup ?? "")).not.toBe(path.resolve("infra"));
    expect(existsSync(path.dirname(backup ?? ""))).toBe(false);
  });

  it("fails with ENGINE_FAILED naming the addresses, its tail redacted", async () => {
    const key = fakeSecret("generic-password", "state-rm");
    const runner = new ScriptedRunner().on("state", {
      exitCode: 1,
      stderr: `Error: Failed to load state ${key}`,
    });
    const error = await makeEngine(runner)
      .stateRemove("infra", [SERVER], { env: { CNTB_OAUTH2_CLIENT_SECRET: key } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    expect((error as Error).message).toContain(`OpenTofu state rm ${SERVER} failed (exit code 1)`);
    expect((error as Error).message).not.toContain(key);
    expect((error as OpsCrewError).hint).toContain("Nothing in the cloud changed");
  });
});
