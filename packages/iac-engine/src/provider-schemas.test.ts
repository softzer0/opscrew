import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScriptedRunner } from "./__fixtures__/fake-runner";
import { createEngine } from "./engine";

const SCHEMAS = {
  format_version: "1.0",
  provider_schemas: {
    "registry.opentofu.org/hetznercloud/hcloud": {
      resource_schemas: {
        hcloud_server: {
          version: 0,
          block: {
            attributes: {
              name: { type: "string", description_kind: "plain", required: true },
              status: { type: "string", description_kind: "plain", computed: true },
            },
          },
        },
      },
    },
  },
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-schemas-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeEngine(runner: ScriptedRunner) {
  return createEngine(
    { name: "tofu", version: "1.13.1", binary: "/bin/tofu" },
    { runner, env: { PATH: "/usr/bin" } },
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

describe("providerSchemas", () => {
  it("runs `providers schema -json` in the directory and returns the parsed document", async () => {
    const runner = new ScriptedRunner().on("providers", { stdout: JSON.stringify(SCHEMAS) });
    const engine = makeEngine(runner);
    const result = await engine.providerSchemas(dir, { env: { TF_ENCRYPTION: "x" } });

    expect(result).toEqual(SCHEMAS);
    const [call] = runner.calls;
    expect(call?.command).toBe("/bin/tofu");
    expect(call?.args).toEqual(["providers", "schema", "-json"]);
    expect(call?.options.cwd).toBe(path.resolve(dir));
    expect(call?.options.env).toMatchObject({
      PATH: "/usr/bin",
      TF_ENCRYPTION: "x",
      TF_IN_AUTOMATION: "1",
    });
  });

  it("reads the schemas once per directory for the engine's lifetime", async () => {
    const runner = new ScriptedRunner().on("providers", { stdout: JSON.stringify(SCHEMAS) });
    const engine = makeEngine(runner);
    await engine.providerSchemas(dir);
    await engine.providerSchemas(path.join(dir, "."));
    expect(runner.calls).toHaveLength(1);

    const other = path.join(dir, "other");
    await engine.providerSchemas(other);
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[1]?.options.cwd).toBe(path.resolve(other));
  });

  it("fails with ENGINE_FAILED on a non-zero exit and tries again next time", async () => {
    const runner = new ScriptedRunner().on(
      "providers",
      { exitCode: 1, stderr: "Error: Inconsistent dependency lock file" },
      { stdout: JSON.stringify(SCHEMAS) },
    );
    const engine = makeEngine(runner);
    const error = await failure(engine.providerSchemas(dir));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("OpenTofu providers schema failed (exit code 1)");
    expect(error.message).toContain("Inconsistent dependency lock file");
    expect(error.hint).toMatch(/init/);

    expect(await engine.providerSchemas(dir)).toEqual(SCHEMAS);
    expect(runner.calls).toHaveLength(2);
  });

  it("fails with ENGINE_FAILED when the output is not JSON", async () => {
    const runner = new ScriptedRunner().on("providers", { stdout: "not json" });
    const error = await failure(makeEngine(runner).providerSchemas(dir));
    expect(error.code).toBe("ENGINE_FAILED");
    expect(error.message).toContain("could not be read");
  });
});
