import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IacEngine, IacEngineName, ResourceAction } from "@opscrew/contracts";
import { tofuEncryptionEnv } from "@opscrew/iac-engine";
import { describe, expect, it } from "vitest";
import {
  createTestPhaseDeps,
  DATA_ZONE,
  encryptedState,
  FakeEngine,
  MANAGED_TUNNEL,
  plainState,
  testPlan,
  withStateList,
} from "../testing";
import {
  describeChanges,
  existingStateEngine,
  hasState,
  projectEngine,
  stateContents,
  stateFile,
} from "./engine";
import { pollUntil } from "./wait";

const tofu = async (): Promise<IacEngine> => new FakeEngine();
const terraform = async (): Promise<IacEngine> =>
  Object.assign(new FakeEngine(), {
    info: { name: "terraform" as const, version: "1.9.0", binary: "/fake/terraform" },
  });

describe("projectEngine", () => {
  it("makes the state passphrase once for OpenTofu and sets TF_ENCRYPTION", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan();
    expect(plan.infra.stateEncryption).toBe(true);
    const { engine, env } = await projectEngine(deps, plan, { services: { engine: tofu } });
    expect(engine.info.name).toBe("tofu");
    const passphrase = (await readFile(deps.paths.files.statePassphrase, "utf8")).trim();
    expect(env.TF_ENCRYPTION).toContain(passphrase);
    expect(deps.redactor.redact(passphrase)).not.toContain(passphrase);
  });

  it("only reads the passphrase on request: stops without one, or goes on without it", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan();
    await expect(
      projectEngine(deps, plan, {
        services: { engine: tofu },
        passphrase: { requiredBy: "opscrew retarget --to digitalocean" },
      }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The OpenTofu state is encrypted, but this computer does not have its passphrase. Nothing was changed.",
      hint: `Copy the state passphrase file from the computer that ran \`opscrew provision\` to ${deps.paths.files.statePassphrase}, then run \`opscrew retarget --to digitalocean\` again.`,
    });
    expect(existsSync(deps.paths.files.statePassphrase)).toBe(false);
    const quiet = await projectEngine(deps, plan, {
      services: { engine: tofu },
      passphrase: "if-present",
    });
    expect(quiet.env.TF_ENCRYPTION).toBeUndefined();
    await mkdir(dirname(deps.paths.files.statePassphrase), { recursive: true });
    await writeFile(deps.paths.files.statePassphrase, "short\n");
    await expect(
      projectEngine(deps, plan, { services: { engine: tofu }, passphrase: "if-present" }),
    ).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
  });

  it("gives Terraform no encryption", async () => {
    const deps = await createTestPhaseDeps();
    const { env } = await projectEngine(deps, testPlan(), { services: { engine: terraform } });
    expect(env.TF_ENCRYPTION).toBeUndefined();
  });

  it("existingStateEngine never makes a passphrase, says which engine it uses and warns Terraform", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan();
    await expect(
      existingStateEngine(deps, plan, { services: { engine: tofu }, command: "opscrew destroy" }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("then run `opscrew destroy` again.") });
    expect(existsSync(deps.paths.files.statePassphrase)).toBe(false);

    const { engine } = await existingStateEngine(deps, plan, {
      services: { engine: terraform },
      command: "opscrew destroy",
    });
    expect(engine.info.name).toBe("terraform");
    expect(deps.reporter.text()).toContain("Using Terraform 1.9.0.");
    expect(deps.reporter.text()).toContain(
      "If OpenTofu provisioned this deployment, run `opscrew destroy --engine tofu` instead.",
    );
    expect(existsSync(deps.paths.files.plansDir)).toBe(true);
  });

  it("tells whether the state file has content", async () => {
    const deps = await createTestPhaseDeps();
    expect(await hasState(deps.paths)).toBe(false);
    await mkdir(dirname(stateFile(deps.paths)), { recursive: true });
    await writeFile(stateFile(deps.paths), "");
    expect(await hasState(deps.paths)).toBe(false);
    await writeFile(stateFile(deps.paths), "{}");
    expect(await hasState(deps.paths)).toBe(true);
  });
});

describe("describeChanges", () => {
  it("shows each change with its action's sign, one per line", () => {
    const change = (action: ResourceAction, address: string) => ({
      address,
      type: "t",
      name: "n",
      provider: "p",
      action,
    });
    expect(
      describeChanges([
        change("create", "module.dns.a"),
        change("update", "module.dns.b"),
        change("delete", "module.server.c"),
        change("replace", "module.server.d"),
      ]),
    ).toEqual([
      "  + create  module.dns.a",
      "  ~ update  module.dns.b",
      "  - delete  module.server.c",
      "  ± replace module.server.d",
    ]);
  });
});

describe("pollUntil", () => {
  it("returns the first answer, or undefined at the deadline without sleeping past it", async () => {
    let now = 0;
    const waits: number[] = [];
    const sleep = async (ms: number) => {
      waits.push(ms);
      now += ms;
    };
    let calls = 0;
    const found = await pollUntil(async () => (++calls === 3 ? "done" : undefined), {
      timeoutMs: 60_000,
      intervalMs: 5_000,
      sleep,
      now: () => now,
    });
    expect(found).toBe("done");
    expect(waits).toEqual([5_000, 5_000]);

    waits.length = 0;
    now = 0;
    const never = await pollUntil(async () => undefined, {
      timeoutMs: 12_000,
      intervalMs: 5_000,
      sleep,
      now: () => now,
    });
    expect(never).toBeUndefined();
    expect(waits).toEqual([5_000, 5_000, 2_000]);
  });
});

async function setup(content: string | undefined) {
  const deps = await createTestPhaseDeps();
  const file = join(await mkdtemp(join(deps.paths.root, "state-")), "prod.tfstate");
  if (content !== undefined) await writeFile(file, content);
  return { deps, file };
}

/** A test engine named `name` with a scripted `state list` for encrypted state. */
function listing(inside: string[] | undefined, name: IacEngineName = "tofu") {
  const engine = new FakeEngine();
  Object.defineProperty(engine, "info", { value: { ...engine.info, name } });
  return withStateList(engine, () => inside);
}

async function writePassphrase(deps: Awaited<ReturnType<typeof createTestPhaseDeps>>) {
  const passphrase = randomBytes(24).toString("base64url");
  await mkdir(dirname(deps.paths.files.statePassphrase), { recursive: true });
  await writeFile(deps.paths.files.statePassphrase, `${passphrase}\n`);
  return passphrase;
}

describe("stateContents", () => {
  it("asks the engine for managed resources: none in an emptied state, outputs and data sources do not count", async () => {
    for (const [content, expected] of [
      [plainState([MANAGED_TUNNEL]), "resources"],
      [plainState([]), "nothing"],
      [plainState([DATA_ZONE]), "nothing"],
    ] as const) {
      const { deps, file } = await setup(content);
      const engine = listing(undefined);
      expect(await stateContents(deps, file, async () => engine)).toBe(expected);
      expect(engine.stateCalls).toEqual([{ file, encryption: undefined }]);
    }
  });

  it("holds nothing without a state file or with a blank one, without asking for an engine", async () => {
    for (const content of [undefined, "  \n"]) {
      const { deps, file } = await setup(content);
      let asked = false;
      const engine = async () => {
        asked = true;
        return listing(undefined);
      };
      expect(await stateContents(deps, file, engine)).toBe("nothing");
      expect(asked).toBe(false);
    }
  });

  it("opens an encrypted state with TF_ENCRYPTION from the existing passphrase (OpenTofu only)", async () => {
    const { deps, file } = await setup(encryptedState());
    const passphrase = await writePassphrase(deps);
    const removed = listing([]);
    expect(await stateContents(deps, file, async () => removed)).toBe("nothing");
    expect(removed.stateCalls).toEqual([{ file, encryption: tofuEncryptionEnv(passphrase) }]);
    expect(deps.redactor.redact(`x ${passphrase} y`)).toBe("x [REDACTED:state-passphrase] y");
    const held = listing(["module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this"]);
    expect(await stateContents(deps, file, async () => held)).toBe("resources");

    // Terraform cannot read OpenTofu-encrypted state.
    const terraform = listing([], "terraform");
    expect(await stateContents(deps, file, async () => terraform)).toBe("unknown");
    expect(terraform.stateCalls).toEqual([]);
  });

  it("is unknown when the engine cannot read the state, or there is no passphrase or engine", async () => {
    const { deps, file } = await setup(encryptedState());
    // No passphrase on this computer: never created, never asked of the engine.
    const engine = listing([]);
    expect(await stateContents(deps, file, async () => engine)).toBe("unknown");
    expect(engine.stateCalls).toEqual([]);
    await expect(readFile(deps.paths.files.statePassphrase, "utf8")).rejects.toThrow();

    await writePassphrase(deps);
    expect(await stateContents(deps, file, async () => listing(undefined))).toBe("unknown");
    const missing = async (): Promise<IacEngine> => {
      throw new Error("no engine");
    };
    expect(await stateContents(deps, file, missing)).toBe("unknown");
    const damaged = await setup("{ not json");
    expect(await stateContents(damaged.deps, damaged.file, async () => engine)).toBe("unknown");
  });

  it("counts a plain state through the engine's `state list`: no instance is nothing, a non-state is unknown", async () => {
    const fake = async () => new FakeEngine();
    for (const [content, expected] of [
      [plainState([MANAGED_TUNNEL]), "resources"],
      [plainState([]), "nothing"],
      [plainState([DATA_ZONE]), "nothing"],
      [plainState([{ ...MANAGED_TUNNEL, instances: [] }]), "nothing"],
      [JSON.stringify({ fake: true }), "unknown"],
      [encryptedState(), "unknown"],
    ] as const) {
      const { deps, file } = await setup(content);
      expect(await stateContents(deps, file, fake)).toBe(expected);
    }
  });
});
