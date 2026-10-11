/**
 * Integration tests with real `tofu` / `terraform` binaries, found through OPSCREW_TOFU_BIN /
 * OPSCREW_TERRAFORM_BIN or PATH. The module uses only the built-in `terraform_data` resource, so
 * no provider is downloaded and no network is needed. Skipped when a binary is not available.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IacEngine, IacEngineName } from "@opscrew/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectEngines, selectEngine } from "./detect";
import { tofuEncryptionEnv } from "./encryption";

const MODULE = `variable "label" {
  type    = string
  default = "one"
}

resource "terraform_data" "a" {
  input            = "alpha-\${var.label}"
  triggers_replace = var.label
}

resource "terraform_data" "b" {
  input = "beta-plaintext-marker"
}

output "a" {
  value = terraform_data.a.output
}
`;

const TIMEOUT = 180_000;
const detected = await detectEngines();

for (const name of ["tofu", "terraform"] as const satisfies readonly IacEngineName[]) {
  const found = detected.find((d) => d.name === name && d.supported);
  if (!found) {
    console.warn(
      `[iac-engine] skipping ${name} integration tests: no usable ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
    );
  }

  describe.skipIf(!found)(`${name} engine (real binary)`, () => {
    let dir: string;
    let engine: IacEngine;

    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), `opscrew-it-${name}-`));
      await writeFile(path.join(dir, "main.tf"), MODULE);
      engine = await selectEngine(name);
    });
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it(
      "init, validate, plan, hash-bound apply, replace guarded by allowDestroy, tamper refused",
      async () => {
        expect(engine.info.name).toBe(name);
        await engine.init(dir);
        expect(await engine.validate(dir)).toEqual({ valid: true, diagnostics: [] });

        const first = await engine.plan(dir, ".opscrew/plans/infra.tfplan");
        expect(first.counts).toEqual({ create: 2, update: 0, delete: 0, replace: 0 });
        expect(first.hasDestroy).toBe(false);
        expect(first.changes.map((c) => c.address).sort()).toEqual([
          "terraform_data.a",
          "terraform_data.b",
        ]);
        expect(first.planHash).toMatch(/^[0-9a-f]{64}$/);

        const applied = await engine.apply(dir, first.planFile, {
          approvedPlanHash: first.planHash.toUpperCase(),
        });
        expect(applied.ok).toBe(true);
        expect(applied.outputs).toEqual({ a: "alpha-one" });

        const second = await engine.plan(dir, ".opscrew/plans/infra.tfplan", {
          vars: { label: "two" },
        });
        expect(second.changes).toEqual([
          expect.objectContaining({ address: "terraform_data.a", action: "replace" }),
        ]);
        expect(second.hasDestroy).toBe(true);

        await expect(
          engine.apply(dir, second.planFile, { approvedPlanHash: second.planHash }),
        ).rejects.toMatchObject({ code: "DESTROY_NOT_APPROVED" });
        expect(await engine.output(dir)).toEqual({ a: "alpha-one" });

        const original = await readFile(second.planFile);
        await writeFile(second.planFile, Buffer.concat([original, Buffer.from([0])]));
        await expect(
          engine.apply(dir, second.planFile, {
            approvedPlanHash: second.planHash,
            allowDestroy: true,
          }),
        ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
        expect(await engine.output(dir)).toEqual({ a: "alpha-one" });

        await writeFile(second.planFile, original);
        const replaced = await engine.apply(dir, second.planFile, {
          approvedPlanHash: second.planHash,
          allowDestroy: true,
        });
        expect(replaced.ok).toBe(true);
        expect(replaced.outputs).toEqual({ a: "alpha-two" });
      },
      TIMEOUT,
    );

    it(
      "reports validation diagnostics with file and line",
      async () => {
        const bad = await mkdtemp(path.join(tmpdir(), `opscrew-it-${name}-bad-`));
        try {
          await writeFile(
            path.join(bad, "main.tf"),
            'resource "terraform_data" "a" {\n  input = var.missing\n}\n',
          );
          await engine.init(bad);
          const result = await engine.validate(bad);
          expect(result.valid).toBe(false);
          expect(result.diagnostics[0]).toMatchObject({
            severity: "error",
            file: "main.tf",
            line: 2,
          });
        } finally {
          await rm(bad, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  });
}

const tofu = detected.find((d) => d.name === "tofu" && d.supported);
describe.skipIf(!tofu)("tofu state encryption via TF_ENCRYPTION (real binary)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "opscrew-it-tofu-enc-"));
    await writeFile(path.join(dir, "main.tf"), MODULE);
  });
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it(
    "encrypts state and plan at rest, and later plans still work",
    async () => {
      const passphrase = `it-${randomBytes(16).toString("hex")}`;
      const env = { TF_ENCRYPTION: tofuEncryptionEnv(passphrase) };
      const engine = await selectEngine("tofu");

      await engine.init(dir, { env });
      const plan = await engine.plan(dir, "infra.tfplan", { env });
      expect(plan.counts.create).toBe(2);
      const planBytes = await readFile(plan.planFile);
      expect(planBytes.includes("beta-plaintext-marker")).toBe(false);

      const applied = await engine.apply(
        dir,
        plan.planFile,
        { approvedPlanHash: plan.planHash },
        { env },
      );
      expect(applied.ok).toBe(true);
      expect(applied.outputs).toEqual({ a: "alpha-one" });

      const state = await readFile(path.join(dir, "terraform.tfstate"), "utf8");
      expect(state).not.toContain("beta-plaintext-marker");
      expect(state).not.toContain("alpha-one");
      expect(state).not.toContain("terraform_data");
      expect(state).not.toContain(passphrase);
      expect(JSON.parse(state)).toHaveProperty("encrypted_data");

      const again = await engine.plan(dir, "infra2.tfplan", { env });
      expect(again.changes).toEqual([]);

      // Without the passphrase the encrypted state cannot be read; the error never shows it.
      const error = await engine.plan(dir, "infra3.tfplan").catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "ENGINE_FAILED" });
      expect(String((error as Error).message)).not.toContain(passphrase);
    },
    TIMEOUT,
  );
});
