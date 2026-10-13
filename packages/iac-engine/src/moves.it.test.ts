/**
 * Integration test for `moved` blocks with real `tofu` / `terraform` binaries, found through
 * OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH (as in `engine.it.test.ts`). It replays the
 * retarget sequence of research.md: a moves-only plan renaming `module.server` to
 * `module.server_previous`, a plan adding a new `module "server"`, and a plan without
 * `server_previous`. Only the built-in `terraform_data` resource is used, so no provider is
 * downloaded and no network is needed. Skipped when a binary is not available.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IacEngine, IacEngineName } from "@opscrew/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectEngines, selectEngine } from "./detect";

const SERVER_MODULE = (label: string) => `resource "terraform_data" "this" {
  input = "${label}"
}
`;

const ORIGINAL = `module "server" {
  source = "../old"
}
`;

/** Step A: rename only. A `moved` block cannot free an address the same configuration declares. */
const RENAME = `moved {
  from = module.server
  to   = module.server_previous
}

module "server_previous" {
  source = "../old"
}
`;

/** Step B: keep the renamed module and add a new one from another source. */
const BOTH = `module "server_previous" {
  source = "../old"
}

module "server" {
  source = "../new"
}
`;

/** Step C: only the new module is left. */
const FINISH = `module "server" {
  source = "../new"
}
`;

const TIMEOUT = 180_000;
const PLAN = ".opscrew/plans/infra.tfplan";
const detected = await detectEngines();

/** Module addresses of the resources in the local, unencrypted state. */
async function stateModules(root: string): Promise<string[]> {
  const state = JSON.parse(await readFile(path.join(root, "terraform.tfstate"), "utf8")) as {
    resources?: { module?: string; type: string; name: string }[];
  };
  return (state.resources ?? []).map((r) => `${r.module ?? ""}.${r.type}.${r.name}`).sort();
}

for (const name of ["tofu", "terraform"] as const satisfies readonly IacEngineName[]) {
  const found = detected.find((d) => d.name === name && d.supported);
  if (!found) {
    console.warn(
      `[iac-engine] skipping ${name} moved-block integration test: no usable ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
    );
  }

  describe.skipIf(!found)(`${name} moved blocks (real binary)`, () => {
    let base: string;
    let root: string;
    let engine: IacEngine;

    beforeAll(async () => {
      base = await mkdtemp(path.join(tmpdir(), `opscrew-it-${name}-moves-`));
      root = path.join(base, "root");
      await mkdir(root);
      await mkdir(path.join(base, "old"));
      await mkdir(path.join(base, "new"));
      await writeFile(path.join(base, "old", "main.tf"), SERVER_MODULE("old-server"));
      await writeFile(path.join(base, "new", "main.tf"), SERVER_MODULE("new-server"));
      engine = await selectEngine(name);
    });
    afterAll(async () => {
      if (base) await rm(base, { recursive: true, force: true });
    });

    /** Writes the root configuration and runs init (module calls changed). */
    async function configure(main: string): Promise<void> {
      await writeFile(path.join(root, "main.tf"), main);
      await engine.init(root);
    }

    it(
      "moves-only plan, then a create plan, then a removed-module destroy plan",
      async () => {
        await configure(ORIGINAL);
        const created = await engine.plan(root, PLAN);
        expect(created.counts).toEqual({ create: 1, update: 0, delete: 0, replace: 0 });
        expect(created).not.toHaveProperty("moves");
        expect(
          (await engine.apply(root, created.planFile, { approvedPlanHash: created.planHash })).ok,
        ).toBe(true);
        expect(await stateModules(root)).toEqual(["module.server.terraform_data.this"]);

        // A: rename only. Moves, no changes, and the apply still has to run.
        await configure(RENAME);
        const renamed = await engine.plan(root, PLAN);
        expect(renamed.changes).toEqual([]);
        expect(renamed.counts).toEqual({ create: 0, update: 0, delete: 0, replace: 0 });
        expect(renamed.hasDestroy).toBe(false);
        expect(renamed.moves).toEqual([
          {
            from: "module.server.terraform_data.this",
            to: "module.server_previous.terraform_data.this",
            type: "terraform_data",
          },
        ]);
        expect(
          (await engine.apply(root, renamed.planFile, { approvedPlanHash: renamed.planHash })).ok,
        ).toBe(true);
        expect(await stateModules(root)).toEqual(["module.server_previous.terraform_data.this"]);

        // A again: the `from` address is gone from the state, so nothing is left to move.
        const again = await engine.plan(root, PLAN);
        expect(again.changes).toEqual([]);
        expect(again).not.toHaveProperty("moves");

        // B: a new module "server" next to the renamed one is one create.
        await configure(BOTH);
        const both = await engine.plan(root, PLAN);
        expect(both).not.toHaveProperty("moves");
        expect(both.changes).toEqual([
          expect.objectContaining({
            address: "module.server.terraform_data.this",
            action: "create",
          }),
        ]);
        expect(
          (await engine.apply(root, both.planFile, { approvedPlanHash: both.planHash })).ok,
        ).toBe(true);
        expect(await stateModules(root)).toEqual([
          "module.server.terraform_data.this",
          "module.server_previous.terraform_data.this",
        ]);

        // C: dropping module "server_previous" deletes its resources (guarded by allowDestroy).
        await configure(FINISH);
        const finish = await engine.plan(root, PLAN);
        expect(finish.hasDestroy).toBe(true);
        expect(finish.counts).toEqual({ create: 0, update: 0, delete: 1, replace: 0 });
        expect(finish.changes).toEqual([
          expect.objectContaining({
            address: "module.server_previous.terraform_data.this",
            action: "delete",
          }),
        ]);
        await expect(
          engine.apply(root, finish.planFile, { approvedPlanHash: finish.planHash }),
        ).rejects.toMatchObject({ code: "DESTROY_NOT_APPROVED" });
        expect(
          (
            await engine.apply(root, finish.planFile, {
              approvedPlanHash: finish.planHash,
              allowDestroy: true,
            })
          ).ok,
        ).toBe(true);
        expect(await stateModules(root)).toEqual(["module.server.terraform_data.this"]);
      },
      TIMEOUT,
    );
  });
}
