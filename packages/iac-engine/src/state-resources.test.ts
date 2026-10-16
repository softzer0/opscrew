import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { IacEngine } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "./__fixtures__/fake-runner";
import { createEngine } from "./engine";
import { managedAddresses, readsStateResources } from "./state-resources";

function makeEngine(runner: ScriptedRunner, name: "tofu" | "terraform" = "tofu") {
  return createEngine(
    { name, version: "1.13.1", binary: `/bin/${name}` },
    { runner, env: { PATH: "/usr/bin" } },
  );
}

describe("stateResources", () => {
  it("runs `state list -state=<file>` in an empty scratch folder and keeps managed resources only", async () => {
    let scratch: { cwd: string; entries: string[] } | undefined;
    const runner = new ScriptedRunner().on("state", async (call) => {
      const cwd = call.options.cwd as string;
      scratch = { cwd, entries: await readdir(cwd) };
      return {
        stdout: [
          "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
          "data.cloudflare_zone.zone",
          'module.dns["www"].data.cloudflare_ip_ranges.this',
          "module.access.cloudflare_zero_trust_access_application.this[0]",
          "",
        ].join("\n"),
      };
    });
    const resources = await makeEngine(runner).stateResources("state/prod.tfstate", {
      env: { TF_ENCRYPTION: "x" },
    });

    expect(resources).toEqual([
      "module.access.cloudflare_zero_trust_access_application.this[0]",
      "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
    ]);
    const [call] = runner.calls;
    expect(call?.args).toEqual([
      "state",
      "list",
      "-no-color",
      `-state=${path.resolve("state/prod.tfstate")}`,
    ]);
    expect(call?.options.env).toMatchObject({ TF_ENCRYPTION: "x", TF_IN_AUTOMATION: "1" });
    expect(scratch?.entries).toEqual([]);
    expect(existsSync(scratch?.cwd as string)).toBe(false);
  });

  it("lists nothing for an emptied state", async () => {
    const runner = new ScriptedRunner().on("state", { stdout: "" });
    expect(await makeEngine(runner, "terraform").stateResources("/s/prod.tfstate")).toEqual([]);
  });

  it("fails with ENGINE_FAILED when the engine cannot read the state, and cleans up", async () => {
    let cwd = "";
    const runner = new ScriptedRunner().on("state", (call) => {
      cwd = call.options.cwd as string;
      return {
        exitCode: 1,
        stderr:
          "Error: Failed to load state: Unsupported state file format: This state file is encrypted",
      };
    });
    const error = await makeEngine(runner)
      .stateResources("/s/prod.tfstate")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({ code: "ENGINE_FAILED" });
    expect((error as OpsCrewError).message).toContain("OpenTofu state list failed (exit code 1)");
    expect((error as OpsCrewError).hint).toContain("state passphrase");
    expect(existsSync(cwd)).toBe(false);
  });

  it("is an optional capability engines can be checked for", () => {
    const engine: IacEngine = makeEngine(new ScriptedRunner());
    expect(readsStateResources(engine)).toBe(true);
    expect(readsStateResources({ info: engine.info } as unknown as IacEngine)).toBe(false);
  });
});

describe("managedAddresses", () => {
  it("drops data sources at any module depth and blank lines, and sorts", () => {
    expect(
      managedAddresses(
        "b.x\r\ndata.a.b\nmodule.m.data.c.d\nmodule.m[0].module.n.data.e.f\n\n  a.y  \n",
      ),
    ).toEqual(["a.y", "b.x"]);
  });
});
