import path from "node:path";
import {
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  planJsonFor,
  testPlan,
} from "@opscrew/agents/testing";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalHandler } from "@opscrew/contracts";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import {
  type DeployProject,
  DeployRunner,
  deployProject,
  provisionServices,
} from "../ui/__fixtures__/deploy";
import { GIT, projectContext, run } from "../ui/__fixtures__/harness";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** A person who approves everything, typing any name asked for. */
const approveAll: ApprovalHandler = {
  request: async (request) => ({
    approved: true,
    approver: "test",
    decidedAt: "2026-10-17T12:00:00.000Z",
    ...(request.confirmPhrase === undefined ? {} : { confirmation: request.confirmPhrase }),
  }),
};

function context(
  p: DeployProject,
  engine = new FakeEngine(),
  o: { zone?: FakeZone; approvals?: ApprovalHandler } = {},
) {
  const ctx = projectContext(p, {
    services: {
      runner: new DeployRunner(),
      ...(o.approvals === undefined ? {} : { approvalHandler: o.approvals }),
    },
  });
  const shared = o.zone === undefined ? {} : { sharedCloudflare: fakeSharedCloudflare(o.zone) };
  withServices(ctx, { provision: provisionServices(engine, new FakeGitHub(), shared) });
  return { ctx, engine };
}

describe.skipIf(GIT === undefined)("opscrew dns", () => {
  it("--domain puts the app behind Cloudflare and prints the hash to approve", async () => {
    project = await deployProject();
    const engine = new FakeEngine({ planJson: planJsonFor({ proxied: true }) });
    const { ctx } = context(project, engine);
    expect(await run(ctx, "dns", "--domain", "Shop.Example.com", "--plan-only", "--yes")).toBe(0);

    const plan = await readArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"));
    expect(plan.dns).toMatchObject({
      provider: "cloudflare",
      domain: "shop.example.com",
      proxied: true,
      zone: "example.com",
    });
    expect(plan.security.httpAllowedFrom).toBe("cloudflare");
    expect(engine.calls).toEqual(["init", "validate", "plan"]);
    expect(ctx.output).toContain("https://shop.example.com through Cloudflare");
    // The Cloudflare plan (OpsCrew's shared rules) and the infrastructure plan, one hash each.
    expect(ctx.output).toMatch(/Cloudflare plan: +[0-9a-f]{64}\n/);
    expect(ctx.output).toMatch(
      / {4}opscrew dns --approve [0-9a-f]{64} --approve [0-9a-f]{64} --yes\n/,
    );
  });

  it("a Cloudflare plan that deletes OpsCrew's rule: no --confirm (dns has none), a terminal or provision instead", async () => {
    project = await deployProject(testPlan({ domain: "shop.example.com" }));
    const zone = new FakeZone();
    // Deployed once (the run stops later, at production values this test does not give).
    await run(context(project, new FakeEngine(), { zone, approvals: approveAll }).ctx, "dns");
    expect(zone.opscrewRule("http_request_firewall_custom")).toBeDefined();
    // The app stops blocking probes: its hostname leaves OpsCrew's rule, the only app in it.
    const file = path.join(project.root, "opscrew", "plan.yaml");
    const plan = await readArtifact("plan", file);
    await writeArtifact("plan", file, {
      ...plan,
      security: { ...plan.security, wafCustomRules: false },
    });

    const { ctx } = context(project, new FakeEngine(), { zone });
    expect(await run(ctx, "dns", "--plan-only", "--yes"), ctx.errors).toBe(0);
    expect(ctx.output).toMatch(/Cloudflare plan hash: [0-9a-f]{64}\n/);
    // `opscrew dns` has no --confirm: no --approve command a script cannot finish.
    expect(ctx.output).not.toContain("opscrew dns --approve");
    expect(ctx.output).not.toContain("--confirm shop\n");
    expect(ctx.output).toContain(
      "This plan deletes or replaces resources, so it needs the app's name: run `opscrew dns` in a terminal and type shop when asked, or in a script run `opscrew provision --plan-only` and then the command it prints (with --confirm shop).",
    );
  });

  it("exits 2 for an invalid domain or when there is no domain at all", async () => {
    project = await deployProject();
    const { ctx, engine } = context(project);
    expect(await run(ctx, "dns", "--domain", "https://shop.example.com/x")).toBe(2);
    expect(ctx.errors).toContain("is not a valid domain name");
    expect(await run(ctx, "dns")).toBe(2);
    expect(ctx.errors).toContain("opscrew dns --domain app.example.com");
    expect(engine.calls).toEqual([]);
  });
});
