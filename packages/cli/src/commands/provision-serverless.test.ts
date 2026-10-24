import type { ProvisionOptions, ProvisionResult } from "@opscrew/agents";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../program";
import {
  projectContext,
  ScriptedPrompts,
  type TempProject,
  tempProject,
} from "../ui/__fixtures__/harness";
import { type SiteProvider, writeSitePlan } from "../ui/__fixtures__/site";
import { runInfraCommand } from "./provision";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

const PAGES = "a1".repeat(32);
const VERIFICATION = "b2".repeat(32);

async function siteProject(provider: SiteProvider): Promise<TempProject> {
  project = await tempProject();
  await writeSitePlan(project, provider);
  return project;
}

describe("opscrew provision for a site on GitHub Pages", () => {
  it("--plan-only prints the Pages plan's and the verification record's hashes to approve", async () => {
    const ctx = projectContext(await siteProject("github-pages"));
    await runInfraCommand(
      ctx,
      "provision",
      { planOnly: true },
      async (): Promise<ProvisionResult> => ({
        applied: false,
        pagesPlanHash: PAGES,
        pagesVerificationPlanHash: VERIFICATION,
        outputs: {},
      }),
    );
    expect(ctx.output).toMatch(new RegExp(`Pages plan for GitHub Pages: +${PAGES}`));
    expect(ctx.output).toMatch(new RegExp(`GitHub's domain verification record: +${VERIFICATION}`));
    expect(ctx.output).toContain(`opscrew provision --approve ${PAGES} --approve ${VERIFICATION}`);
  });

  it("has --pages-verification on the program's provision", () => {
    const ctx = projectContext({ root: ".", dir: ".", env: {}, cleanup: async () => {} });
    const provision = createProgram(ctx).commands.find((c) => c.name() === "provision");
    expect(provision?.options.map((o) => o.long)).toContain("--pages-verification");
  });

  it("passes --pages-verification to the phase, and a terminal gets a prompt for the value", async () => {
    const p = await siteProject("github-pages");
    const given: ProvisionOptions[] = [];
    const phase = async (_deps: unknown, options: ProvisionOptions): Promise<ProvisionResult> => {
      given.push(options);
      return { applied: false, outputs: {} };
    };
    await runInfraCommand(projectContext(p), "provision", { pagesVerification: "abc123" }, phase);
    expect(given[0]).toMatchObject({ pagesVerification: "abc123" });

    const prompts = new ScriptedPrompts(["def456"]);
    const terminal = projectContext(p, { interactive: true, services: { prompts } });
    await runInfraCommand(terminal, "provision", {}, phase);
    const ask = given[1]?.services?.askPagesVerification;
    const page = "https://github.com/settings/pages";
    expect(await ask?.({ domain: "docs.example.com", page })).toBe("def456");
    expect(prompts.calls[0]?.message).toContain(page);
    expect(prompts.calls[0]?.message).toContain('click "Add a domain", enter docs.example.com');
  });
});

describe.each(["cloudflare-workers", "github-pages"] as const)(
  "opscrew provision's next steps for a site on %s",
  (provider) => {
    it("names the site's security check, not a server's hardening", async () => {
      const ctx = projectContext(await siteProject(provider));
      await runInfraCommand(ctx, "provision", {}, async () => ({ applied: true, outputs: {} }));
      expect(ctx.output).toContain("run `opscrew secure` to check the site's security headers");
      expect(ctx.output).not.toMatch(/server/i);
    });
  },
);
