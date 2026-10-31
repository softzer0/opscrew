import {
  type DestroyOptions,
  type DestroyPreview,
  type DestroyResult,
  destroyConfirmPrompt,
  type PhaseDeps,
} from "@opscrew/agents";
import { PORTAINER_HOST, portainerPlan } from "@opscrew/agents/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { CliExit } from "../exit";
import { writeProjectPlan } from "../ui/__fixtures__/deploy";
import {
  projectContext,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { recordPortainer } from "../ui/__fixtures__/portainer";
import {
  confirmMessage,
  type DestroyFlags,
  runDestroyCommand,
  TypedConfirmationHandler,
} from "./destroy";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const TEARDOWN = "9f".repeat(32);

/** Records what reaches the base handler (after the typed-name handler) and refuses it. */
class BaseApprovals implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: false, approver: "test", decidedAt: "2026-10-15T12:00:00.000Z" };
  }
}

const teardown = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  kind: "stack-apply",
  title: "Remove shop from your Portainer (3 changes)",
  details: `Stack plan hash: ${TEARDOWN}`,
  planHash: TEARDOWN,
  allowDestroy: true,
  confirmPhrase: "shop",
  ...overrides,
});

function handler(base: ApprovalHandler, typed: string | undefined) {
  return new TypedConfirmationHandler(
    base,
    "shop",
    () => typed,
    false,
    () => {},
    "the app's name",
    {
      purposeOf: async () => undefined,
      scripted: false,
      hashes: [],
    },
  );
}

describe("TypedConfirmationHandler for the user's Portainer", () => {
  it("approves the stack teardown once the app's name was typed", async () => {
    const base = new BaseApprovals();
    const decision = await handler(base, "shop").request(teardown());
    expect(decision).toMatchObject({ approved: true, confirmation: "shop" });
    expect(base.requests).toEqual([]);
  });

  it("never covers a stack plan that deletes nothing, another name, or a name not typed", async () => {
    for (const [request, typed] of [
      [teardown({ allowDestroy: undefined, confirmPhrase: undefined }), "shop"],
      [teardown({ allowDestroy: undefined }), "shop"],
      [teardown({ confirmPhrase: "other" }), "shop"],
      [teardown(), "shp"],
      [teardown(), undefined],
    ] as const) {
      const base = new BaseApprovals();
      const decision = await handler(base, typed).request(request);
      expect(decision.approved).toBe(false);
      expect(base.requests).toEqual([request]);
    }
  });

  it("covers the Cloudflare plan of OpsCrew's shared rules only when it deletes and asks for the name", async () => {
    const shared = teardown({
      kind: "cloudflare-apply",
      title: "Apply the Cloudflare plan to OpsCrew's shared Cloudflare resources (2 changes)",
    });
    const base = new BaseApprovals();
    expect(await handler(base, "shop").request(shared)).toMatchObject({
      approved: true,
      confirmation: "shop",
    });
    for (const [request, typed] of [
      [{ ...shared, allowDestroy: undefined, confirmPhrase: undefined }, "shop"],
      [{ ...shared, allowDestroy: undefined }, "shop"],
      [{ ...shared, confirmPhrase: "other" }, "shop"],
      [shared, "shp"],
      [shared, undefined],
    ] as const) {
      const refused = new BaseApprovals();
      expect((await handler(refused, typed).request(request)).approved).toBe(false);
      expect(refused.requests).toEqual([request]);
    }
  });
});

interface FakeDestroy {
  options: DestroyOptions[];
  decisions: ApprovalDecision[];
  previews: DestroyPreview[];
  destroy: (deps: PhaseDeps, options: DestroyOptions) => Promise<DestroyResult>;
}

/** A fake teardown in the user's Portainer: confirms the preview, then asks for the teardown. */
function fakeDestroy(): FakeDestroy {
  const seen: FakeDestroy = {
    options: [],
    decisions: [],
    previews: [],
    destroy: async (deps, options) => {
      seen.options.push(options);
      const preview: DestroyPreview = {
        name: "shop",
        confirmPrompt: destroyConfirmPrompt("shop", "portainer"),
        provider: "portainer",
        deleteProtection: false,
        resources: [],
        snapshot: false,
        stackChanges: ["Remove the stack opscrew-shop-updater", "Remove the stack opscrew-shop"],
      };
      seen.previews.push(preview);
      if (options.confirm !== undefined && !(await options.confirm(preview))) {
        throw new OpsCrewError(
          "APPROVAL_REFUSED",
          "The app name was not confirmed, so nothing was deleted and nothing was changed.",
        );
      }
      const decision = await deps.approvals.request(teardown());
      seen.decisions.push(decision);
      if (!decision.approved) {
        throw new OpsCrewError("APPROVAL_REFUSED", "The removal was not approved.");
      }
      return { destroyed: [], secretsRemoved: [], remaining: [], stackPlan: TEARDOWN };
    },
  };
  return seen;
}

async function portainerProject(): Promise<TempProject> {
  project = await tempProject();
  await writeProjectPlan(project, portainerPlan());
  await recordPortainer(project, {
    stacks: [{ id: 7, name: "opscrew-shop", role: "app" }],
    volumes: ["opscrew-shop_pgdata"],
  });
  return project;
}

async function destroy(
  ctx: ReturnType<typeof projectContext>,
  flags: DestroyFlags,
  fake: FakeDestroy,
): Promise<number> {
  try {
    await runDestroyCommand(ctx, flags, fake.destroy);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) return error.exitCode;
    throw error;
  }
}

describe("opscrew destroy for the user's Portainer", () => {
  it("--confirm <app> --delete-data approves the stack teardown and prints its hash", async () => {
    const p = await portainerProject();
    const ctx = projectContext(p);
    const fake = fakeDestroy();
    expect(await destroy(ctx, { confirm: ["shop"], deleteData: true }, fake), ctx.errors).toBe(0);
    expect(fake.options[0]).toMatchObject({ deleteData: true });
    expect(fake.decisions[0]).toMatchObject({ approved: true });
    expect(ctx.output).toContain(
      "Remove shop from your Portainer (3 changes) (confirmed with the app's name)",
    );
    expect(ctx.output).toContain(`Applied the stack teardown plan ${TEARDOWN} to your Portainer.`);
    expect(ctx.output).toContain("your Portainer, its other stacks and the host stay");
    expect(`${ctx.output}${ctx.errors}`).not.toContain(PORTAINER_HOST);
  });

  it("asks for the app's name in a terminal, showing what Portainer loses", async () => {
    const p = await portainerProject();
    const prompts = new ScriptedPrompts(["shop"]);
    const ctx = projectContext(p, { interactive: true, services: { prompts } });
    const fake = fakeDestroy();
    expect(await destroy(ctx, {}, fake), ctx.errors).toBe(0);
    const message = prompts.calls[0]?.message ?? "";
    expect(message).toContain(
      "Remove the stack opscrew-shop-updater; Remove the stack opscrew-shop",
    );
    expect(message).toContain(destroyConfirmPrompt("shop", "portainer"));
    expect(fake.decisions[0]).toMatchObject({ approved: true });
    expect(fake.options[0]).not.toHaveProperty("deleteData");
  });

  it("refuses --undo-host and a run nobody can confirm, changing nothing", async () => {
    const p = await portainerProject();
    const undo = projectContext(p);
    const fake = fakeDestroy();
    expect(await destroy(undo, { confirm: ["shop"], undoHost: true }, fake)).toBe(2);
    expect(undo.errors).toContain("--undo-host applies only to a server you already own");
    const script = projectContext(p);
    expect(await destroy(script, { deleteData: true }, fake)).toBe(1);
    expect(script.errors).toContain("opscrew destroy --confirm shop");
    expect(fake.options).toEqual([]);
  });

  it("names the stack teardown's changes only for a Portainer preview", () => {
    const base: DestroyPreview = {
      name: "shop",
      provider: "own",
      deleteProtection: false,
      resources: [],
      snapshot: false,
    };
    expect(confirmMessage(base)).toBe(destroyConfirmPrompt("shop", "own"));
    expect(confirmMessage({ ...base, provider: "portainer", stackChanges: [] })).toBe(
      destroyConfirmPrompt("shop", "portainer"),
    );
  });
});
