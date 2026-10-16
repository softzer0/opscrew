import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IacEngine } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { FakeEngine, testPlan } from "../provision/__fixtures__/fakes";
import { createTestPhaseDeps } from "../testing";
import { hasState, projectEngine, stateFile } from "./engine";
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
      projectEngine(deps, plan, { services: { engine: tofu }, passphrase: "require" }),
    ).rejects.toMatchObject({ code: "PHASE_PRECONDITION" });
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
