import {
  type DestroyOptions,
  type DestroyPreview,
  type DestroyResult,
  destroyConfirmPrompt,
  type PhaseDeps,
} from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { afterEach, describe, expect, it } from "vitest";
import { CliExit } from "../exit";
import {
  projectContext,
  run,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { type SiteProvider, writeSitePlan } from "../ui/__fixtures__/site";
import { type DestroyFlags, runDestroyCommand, TypedConfirmationHandler } from "./destroy";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const PAGES_PLAN = "5e".repeat(32);

async function siteProject(provider: SiteProvider): Promise<TempProject> {
  project = await tempProject();
  await writeSitePlan(project, provider);
  return project;
}

/** The Pages plan that removes the site: deletes, and asks for the app's name. */
const removal = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  kind: "pages-apply",
  title: "Apply the Pages plan to the GitHub Pages site of example-org/example-app (3 changes)",
  details: `Pages plan hash: ${PAGES_PLAN}`,
  planHash: PAGES_PLAN,
  allowDestroy: true,
  confirmPhrase: "example-app",
  ...overrides,
});

/** Records what reaches the base handler (after the typed-name handler) and refuses it. */
class BaseApprovals implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return { approved: false, approver: "test", decidedAt: "2026-10-24T12:00:00.000Z" };
  }
}

function handler(base: ApprovalHandler, typed: string | undefined) {
  return new TypedConfirmationHandler(
    base,
    "example-app",
    () => typed,
    false,
    () => {},
    "the app's name",
    { purposeOf: async () => undefined, scripted: false, hashes: [] },
  );
}

describe("TypedConfirmationHandler for a site on GitHub Pages", () => {
  it("approves the Pages plan that removes the site once the app's name was typed", async () => {
    const base = new BaseApprovals();
    expect(await handler(base, "example-app").request(removal())).toMatchObject({
      approved: true,
      confirmation: "example-app",
    });
    expect(base.requests).toEqual([]);
  });

  it("never covers a Pages plan that deletes nothing, another name, or a name not typed", async () => {
    for (const [request, typed] of [
      [removal({ allowDestroy: undefined, confirmPhrase: undefined }), "example-app"],
      [removal({ allowDestroy: undefined }), "example-app"],
      [removal({ confirmPhrase: "other" }), "example-app"],
      [removal(), "example"],
      [removal(), undefined],
    ] as const) {
      const base = new BaseApprovals();
      expect((await handler(base, typed).request(request)).approved).toBe(false);
      expect(base.requests).toEqual([request]);
    }
  });
});

interface FakeDestroy {
  options: DestroyOptions[];
  decisions: ApprovalDecision[];
  destroy: (deps: PhaseDeps, options: DestroyOptions) => Promise<DestroyResult>;
}

/** A fake site teardown: confirms the preview, then asks for the Pages plan that removes the site. */
function fakeDestroy(provider: SiteProvider): FakeDestroy {
  const seen: FakeDestroy = {
    options: [],
    decisions: [],
    destroy: async (deps, options) => {
      seen.options.push(options);
      const preview: DestroyPreview = {
        name: "example-app",
        confirmPrompt: destroyConfirmPrompt("example-app", provider),
        provider,
        deleteProtection: false,
        resources: [],
        snapshot: false,
      };
      if (options.confirm !== undefined && !(await options.confirm(preview))) {
        throw new OpsCrewError("APPROVAL_REFUSED", "The app name was not confirmed.");
      }
      const decision = await deps.approvals.request(removal());
      seen.decisions.push(decision);
      if (!decision.approved) throw new OpsCrewError("APPROVAL_REFUSED", "Not approved.");
      return {
        destroyed: [],
        secretsRemoved: [],
        remaining: ["GitHub's domain verification record"],
      };
    },
  };
  return seen;
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

describe.each([
  ["Cloudflare's hosting", "cloudflare-workers"],
  ["GitHub Pages", "github-pages"],
] as const)("opscrew destroy for a site on %s", (name, provider) => {
  it("--confirm <app> approves each plan with the app's name and names deploying again", async () => {
    const p = await siteProject(provider);
    const ctx = projectContext(p);
    const fake = fakeDestroy(provider);
    expect(await destroy(ctx, { confirm: "example-app" }, fake), ctx.errors).toBe(0);
    expect(fake.decisions[0]).toMatchObject({ approved: true });
    expect(fake.options[0]).not.toHaveProperty("deleteVerification");
    expect(ctx.output).toContain("(confirmed with the app's name)");
    expect(ctx.output).toContain("run `opscrew provision` to deploy again");
  });

  it("asks a terminal for the app's name", async () => {
    const p = await siteProject(provider);
    const prompts = new ScriptedPrompts(["example-app"]);
    const ctx = projectContext(p, { interactive: true, services: { prompts } });
    const fake = fakeDestroy(provider);
    expect(await destroy(ctx, {}, fake), ctx.errors).toBe(0);
    expect(prompts.calls[0]?.message).toBe(destroyConfirmPrompt("example-app", provider));
    expect(fake.decisions[0]).toMatchObject({ approved: true });
  });

  it("refuses --undo-host, --delete-data and --snapshot without talking about servers, changing nothing", async () => {
    const p = await siteProject(provider);
    const fake = fakeDestroy(provider);
    for (const flags of [{ undoHost: true }, { deleteData: true }, { snapshot: true }]) {
      const ctx = projectContext(p);
      expect(await destroy(ctx, { confirm: "example-app", ...flags }, fake)).toBe(2);
      expect(ctx.errors).toContain(`do not apply to a site on ${name}`);
      expect(ctx.errors).not.toMatch(/server/i);
    }
    expect(fake.options).toEqual([]);
  });

  it("refuses a run nobody can confirm, naming --confirm with the app's name", async () => {
    const p = await siteProject(provider);
    const ctx = projectContext(p);
    const fake = fakeDestroy(provider);
    expect(await destroy(ctx, {}, fake)).toBe(1);
    expect(ctx.errors).toContain("needs the app's name typed by a person");
    expect(ctx.errors).toContain("opscrew destroy --confirm example-app");
    expect(fake.options).toEqual([]);
  });
});

describe("opscrew destroy --delete-verification", () => {
  it("asks GitHub Pages' teardown to delete the verification record too", async () => {
    const p = await siteProject("github-pages");
    const ctx = projectContext(p);
    const fake = fakeDestroy("github-pages");
    const flags = { confirm: "example-app", deleteVerification: true };
    expect(await destroy(ctx, flags, fake), ctx.errors).toBe(0);
    expect(fake.options[0]).toMatchObject({ deleteVerification: true });
  });

  it("is refused on any other target before anything runs", async () => {
    const p = await siteProject("cloudflare-workers");
    const ctx = projectContext(p);
    // Through the program: the flag is parsed, then refused before anything is read or asked.
    const args = ["destroy", "--delete-verification", "--confirm", "example-app"];
    expect(await run(ctx, ...args)).toBe(2);
    expect(ctx.errors).toContain("--delete-verification applies only to a site on GitHub Pages");
    expect(ctx.fetchUrls).toEqual([]);
  });
});
