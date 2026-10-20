/**
 * Integration tests with real `tofu` / `terraform` binaries, found through OPSCREW_TOFU_BIN /
 * OPSCREW_TERRAFORM_BIN or PATH. The module uses only the built-in `terraform_data` resource, so
 * no provider is downloaded and no network is needed. Skipped when a binary is not available.
 *
 * The drift tests download the `hashicorp/local` provider, so they also need `OPSCREW_IT=1` and
 * network access; they skip with a message when the download fails.
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

const DRIFT_MODULE = `terraform {
  required_providers {
    local = {
      source = "hashicorp/local"
    }
  }
}

resource "local_file" "note" {
  filename = "\${path.module}/note.txt"
  content  = "drift-original-content"
}
`;

const TIMEOUT = 180_000;
const detected = await detectEngines();
const runDriftIt = process.env.OPSCREW_IT === "1";
if (!runDriftIt) {
  console.warn(
    "[iac-engine] skipping drift integration tests: set OPSCREW_IT=1 (they download the hashicorp/local provider).",
  );
}

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

  describe.skipIf(!found || !runDriftIt)(`${name} drift (real binary, hashicorp/local)`, () => {
    let dir: string;
    afterAll(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it(
      "a refresh-only plan reports a file edited on disk as drift, without its contents",
      async (ctx) => {
        dir = await mkdtemp(path.join(tmpdir(), `opscrew-it-${name}-drift-`));
        await writeFile(path.join(dir, "main.tf"), DRIFT_MODULE);
        const engine = await selectEngine(name);
        try {
          await engine.init(dir);
        } catch (error) {
          ctx.skip(
            `${name} could not download the hashicorp/local provider (network needed): ${String((error as Error).message).split("\n")[0]}`,
          );
        }

        const created = await engine.plan(dir, ".opscrew/plans/infra.tfplan");
        expect(created.counts.create).toBe(1);
        const applied = await engine.apply(dir, created.planFile, {
          approvedPlanHash: created.planHash,
        });
        expect(applied.ok).toBe(true);

        const clean = await engine.plan(dir, ".opscrew/plans/drift.tfplan", { refreshOnly: true });
        expect(clean.changes).toEqual([]);
        expect(clean.drift).toBeUndefined();

        await writeFile(path.join(dir, "note.txt"), "drift-edited-by-hand");
        const drifted = await engine.plan(dir, ".opscrew/plans/drift.tfplan", {
          refreshOnly: true,
        });
        expect(drifted.changes).toEqual([]);
        expect(drifted.hasDestroy).toBe(false);
        expect(drifted.drift).toEqual([
          expect.objectContaining({
            address: "local_file.note",
            type: "local_file",
            name: "note",
            provider: expect.stringContaining("hashicorp/local"),
          }),
        ]);
        expect(["update", "delete"]).toContain(drifted.drift?.[0]?.action);
        const reported = JSON.stringify(drifted.drift);
        expect(reported).not.toContain("drift-original-content");
        expect(reported).not.toContain("drift-edited-by-hand");
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

// `state list` on a state file from no root module; only with OPSCREW_IT=1, like the agents' check.
describe.skipIf(!runDriftIt)("stateResources on a state file (real binaries)", () => {
  const cases = [
    { name: "tofu" as const, encrypted: false },
    { name: "tofu" as const, encrypted: true },
    { name: "terraform" as const, encrypted: false },
  ];
  for (const { name, encrypted } of cases) {
    const found = detected.find((d) => d.name === name && d.supported);
    it.skipIf(!found)(
      `lists the managed resources, then none after a full destroy (${name}${encrypted ? ", encrypted" : ""})`,
      async () => {
        const dir = await mkdtemp(path.join(tmpdir(), `opscrew-it-${name}-list-`));
        try {
          await writeFile(path.join(dir, "main.tf"), MODULE);
          const passphrase = `it-${randomBytes(16).toString("hex")}`;
          const env = encrypted ? { TF_ENCRYPTION: tofuEncryptionEnv(passphrase) } : {};
          const engine = await selectEngine(name);
          const state = path.join(dir, "terraform.tfstate");
          await engine.init(dir, { env });
          const created = await engine.plan(dir, "infra.tfplan", { env });
          const applied = await engine.apply(
            dir,
            created.planFile,
            { approvedPlanHash: created.planHash },
            { env },
          );
          expect(applied.ok).toBe(true);
          expect(await engine.stateResources(state, { env })).toEqual([
            "terraform_data.a",
            "terraform_data.b",
          ]);

          const removal = await engine.plan(dir, "removal.tfplan", { env, destroy: true });
          const removed = await engine.apply(
            dir,
            removal.planFile,
            { approvedPlanHash: removal.planHash, allowDestroy: true },
            { env },
          );
          expect(removed.ok).toBe(true);
          if (encrypted) expect(await readFile(state, "utf8")).toContain("encrypted_data");
          expect(await engine.stateResources(state, { env })).toEqual([]);

          if (encrypted) {
            // Without the encryption settings the engine cannot read it; the error never shows them.
            const error = await engine.stateResources(state).catch((e: unknown) => e);
            expect(error).toMatchObject({ code: "ENGINE_FAILED" });
            expect(String((error as Error).message)).not.toContain(passphrase);
          }
          const missing = await engine
            .stateResources(path.join(dir, "missing.tfstate"), { env })
            .catch((e: unknown) => e);
          expect(missing).toMatchObject({ code: "ENGINE_FAILED" });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

/**
 * A create that fails after the resource exists leaves it tainted, like the `aws` provider's read
 * of a bucket Hetzner shows late. Built-in `terraform_data` and `local-exec` only: no provider.
 */
const TAINT_MODULE = `terraform {
  backend "local" {}
}

resource "terraform_data" "bucket" {
  input = "bucket"

  provisioner "local-exec" {
    command = "exit 1"
  }
}
`;

// `untaint` on a root with a local backend; only with OPSCREW_IT=1, like `stateResources`.
describe.skipIf(!runDriftIt)("untaint on a root's state (real binaries)", () => {
  const cases = [
    { name: "tofu" as const, encrypted: false },
    { name: "tofu" as const, encrypted: true },
    { name: "terraform" as const, encrypted: false },
  ];
  for (const { name, encrypted } of cases) {
    const found = detected.find((d) => d.name === name && d.supported);
    it.skipIf(!found)(
      `keeps a resource a failed create tainted, so the next plan does not replace it (${name}${encrypted ? ", encrypted" : ""})`,
      async () => {
        const dir = await mkdtemp(path.join(tmpdir(), `opscrew-it-${name}-untaint-`));
        try {
          await writeFile(path.join(dir, "main.tf"), TAINT_MODULE);
          const env = encrypted
            ? { TF_ENCRYPTION: tofuEncryptionEnv(`it-${randomBytes(16).toString("hex")}`) }
            : {};
          const engine = await selectEngine(name);
          const state = path.join(dir, "state", "root.tfstate");
          await engine.init(dir, { env, backendConfig: { path: state } });
          const created = await engine.plan(dir, "create.tfplan", { env });
          const failed = await engine.apply(
            dir,
            created.planFile,
            { approvedPlanHash: created.planHash },
            { env },
          );
          expect(failed.ok).toBe(false);
          const tainted = await engine.plan(dir, "tainted.tfplan", { env });
          expect(tainted.changes).toEqual([
            expect.objectContaining({ address: "terraform_data.bucket", action: "replace" }),
          ]);

          await engine.untaint(dir, "terraform_data.bucket", { env });
          expect(await engine.stateResources(state, { env })).toEqual(["terraform_data.bucket"]);
          const kept = await engine.plan(dir, "kept.tfplan", { env });
          expect(kept.changes).toEqual([]);
          // An address the state lacks is no error.
          await engine.untaint(dir, "terraform_data.missing", { env });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});

/**
 * An object that exists but never reached the state, like a bucket whose create failed reading it
 * back. Its variable has no default: the import reads it from `terraform.tfvars.json`, as plan does.
 */
const IMPORT_MODULE = `terraform {
  backend "local" {}
}

variable "name" {
  type = string
}

resource "terraform_data" "bucket" {
  input = var.name
}
`;

// `importResource` on a root with a local backend; only with OPSCREW_IT=1, like `untaint`.
describe.skipIf(!runDriftIt)("importResource into a root's state (real binaries)", () => {
  const cases = [
    { name: "tofu" as const, encrypted: false },
    { name: "tofu" as const, encrypted: true },
    { name: "terraform" as const, encrypted: false },
  ];
  for (const { name, encrypted } of cases) {
    const found = detected.find((d) => d.name === name && d.supported);
    it.skipIf(!found)(
      `records an existing object, so the next plan no longer creates it (${name}${encrypted ? ", encrypted" : ""})`,
      async () => {
        const dir = await mkdtemp(path.join(tmpdir(), `opscrew-it-${name}-import-`));
        try {
          await writeFile(path.join(dir, "main.tf"), IMPORT_MODULE);
          await writeFile(path.join(dir, "terraform.tfvars.json"), '{ "name": "bucket" }\n');
          const env = encrypted
            ? { TF_ENCRYPTION: tofuEncryptionEnv(`it-${randomBytes(16).toString("hex")}`) }
            : {};
          const engine = await selectEngine(name);
          const state = path.join(dir, "state", "root.tfstate");
          await engine.init(dir, { env, backendConfig: { path: state } });
          const before = await engine.plan(dir, "before.tfplan", { env });
          expect(before.changes).toEqual([
            expect.objectContaining({ address: "terraform_data.bucket", action: "create" }),
          ]);

          await engine.importResource(dir, "terraform_data.bucket", "bucket", { env });
          expect(await engine.stateResources(state, { env })).toEqual(["terraform_data.bucket"]);
          const after = await engine.plan(dir, "after.tfplan", { env });
          expect(after.changes.map((c) => c.action)).not.toContain("create");
          // The address is in the state now, so the engine refuses a second import.
          await expect(
            engine.importResource(dir, "terraform_data.bucket", "bucket", { env }),
          ).rejects.toMatchObject({ code: "ENGINE_FAILED" });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      TIMEOUT,
    );
  }
});
