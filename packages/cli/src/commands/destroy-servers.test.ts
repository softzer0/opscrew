import {
  allocateNetwork,
  type DestroyOptions,
  type DestroyPreview,
  type DestroyResult,
  type PhaseDeps,
} from "@opscrew/agents";
import { testKeyMaker, testPlan } from "@opscrew/agents/testing";
import type { ApprovalDecision } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { CliExit } from "../exit";
import { writeProjectPlan } from "../ui/__fixtures__/deploy";
import {
  projectContext,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { type DestroyFlags, runDestroyCommand } from "./destroy";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** The deployed app `shop` with Postgres on the Hetzner server `data` (`shop-data` at Hetzner). */
function splitPlan() {
  const base = testPlan({ deployed: true, userSecret: false });
  const split = {
    ...base,
    servers: [
      {
        name: "data",
        target: {
          provider: "hetzner" as const,
          mode: "vps-compose" as const,
          location: "nbg1",
          serverType: "cx23",
          backups: true,
        },
      },
    ],
    services: base.services.map((s) => (s.name === "db" ? { ...s, server: "data" } : s)),
  };
  return DeployPlanSchema.parse({
    ...split,
    network: allocateNetwork(split, {}, testKeyMaker()).network,
  });
}

/** What the fake teardown asked and was told. */
interface Teardown {
  confirmed: { name: string; answer: boolean }[];
  decision?: ApprovalDecision;
}

/**
 * The teardown as `runDestroy` runs it with an extra cloud server: the deployment's name typed,
 * then the extra server's own name, then the destroy plan's approval (the deployment's name as its
 * phrase). A name not confirmed stops it, as `confirmDeletion` does.
 */
function fakeDestroy(teardown: Teardown) {
  return async (deps: PhaseDeps, options: DestroyOptions): Promise<DestroyResult> => {
    const preview: DestroyPreview = {
      name: "shop",
      provider: "hetzner",
      deleteProtection: true,
      resources: [],
      snapshot: false,
    };
    for (const asked of [preview, { ...preview, name: "shop-data", server: "data" }]) {
      const answer = (await options.confirm?.(asked)) ?? false;
      teardown.confirmed.push({ name: asked.name, answer });
      if (!answer) {
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          "The Hetzner server name was not confirmed, so nothing was deleted and nothing was changed.",
          { hint: `Run \`opscrew destroy\` again and type ${asked.name} when asked.` },
        );
      }
    }
    teardown.decision = await deps.approvals.request({
      kind: "iac-apply",
      title: "Delete shop and shop-data on Hetzner Cloud",
      details: "- module.server_data.hcloud_server.this",
      planHash: "ab".repeat(32),
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    return { destroyed: [], secretsRemoved: [], remaining: [] };
  };
}

async function destroy(flags: DestroyFlags, options: { typed?: string[] } = {}) {
  project = await tempProject();
  await writeProjectPlan(project, splitPlan());
  const prompts = new ScriptedPrompts(options.typed ?? []);
  const ctx = projectContext(project, { interactive: options.typed !== undefined });
  withServices(ctx, { prompts });
  const teardown: Teardown = { confirmed: [] };
  const code = await runDestroyCommand(ctx, flags, fakeDestroy(teardown)).then(
    () => 0,
    (error: unknown) => (error instanceof CliExit ? error.exitCode : -1),
  );
  return { ctx, prompts, teardown, code };
}

describe("opscrew destroy with an extra cloud server", () => {
  it("takes each server's name with its own --confirm in a script", async () => {
    const r = await destroy({ confirm: ["shop", "shop-data"] });
    expect(r.code, r.ctx.errors).toBe(0);
    expect(r.teardown.confirmed).toEqual([
      { name: "shop", answer: true },
      { name: "shop-data", answer: true },
    ]);
    expect(r.teardown.decision).toMatchObject({ approved: true, approver: "typed server name" });
  });

  it("deletes nothing when a script leaves out an extra server's name, and names the flag", async () => {
    const r = await destroy({ confirm: ["shop"] });
    expect(r.code).toBe(1);
    expect(r.teardown.confirmed).toEqual([
      { name: "shop", answer: true },
      { name: "shop-data", answer: false },
    ]);
    expect(r.teardown.decision).toBeUndefined();
    expect(r.ctx.errors).toContain("In a script, add --confirm shop-data");
  });

  it("refuses a --confirm value that names no server before anything runs", async () => {
    const r = await destroy({ confirm: ["shop", "shop-dta"] });
    expect(r.code).toBe(1);
    expect(r.teardown.confirmed).toEqual([]);
    expect(r.ctx.errors).toContain(
      "--confirm shop-dta does not match the server name or an extra server's name (shop-data)",
    );
    expect(r.ctx.errors).toContain("opscrew destroy --confirm shop --confirm shop-data");
    // The deployment's own name is needed too.
    const alone = await destroy({ confirm: ["shop-data"] });
    expect(alone.code).toBe(1);
    expect(alone.teardown.confirmed).toEqual([]);
    expect(alone.ctx.errors).toContain(
      "Add --confirm shop: the deployment is deleted only with its own name, as each extra server is with its own. Nothing was changed.",
    );
    expect(alone.ctx.errors).toContain("opscrew destroy --confirm shop --confirm shop-data");
  });

  it("asks for each server's name in a terminal, the deployment's first", async () => {
    const r = await destroy({}, { typed: ["shop", "shop-data"] });
    expect(r.code, r.ctx.errors).toBe(0);
    expect(r.prompts.calls.map((call) => call.message)).toEqual([
      expect.stringContaining("Type shop to delete"),
      expect.stringContaining("Type shop-data"),
    ]);
    // The destroy plan still carries the deployment's name as typed.
    expect(r.teardown.decision).toMatchObject({ approved: true, approver: "typed server name" });

    const wrong = await destroy({}, { typed: ["shop", "shop"] });
    expect(wrong.code).toBe(1);
    expect(wrong.teardown.confirmed.at(-1)).toEqual({ name: "shop-data", answer: false });
  });
});
