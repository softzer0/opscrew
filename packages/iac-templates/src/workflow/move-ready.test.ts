import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ACCOUNT_ID, testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { renderInfra } from "../infra";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { cloudflarePlan } from "../serverless/__fixtures__/plans";
import { isMoveReady, renderWorkflow } from "./index";

const ctx = testContext({ cloudflare: { ...testCloudflare(), accountId: ACCOUNT_ID } });

/** The files `plan` renders today, by their repository paths, as a commit holds them. */
function committed(plan: DeployPlan): Map<string, string> {
  const files = [renderWorkflow(plan, ctx)];
  if (plan.target.provider === "cloudflare-workers") files.push(...renderInfra(plan, ctx));
  return new Map(files.map((file) => [file.path, file.content]));
}

const reader = (files: Map<string, string>) => async (path: string) => files.get(path);

/** `files` as an earlier OpsCrew wrote them: without the lines that hold `needle`. */
function without(files: Map<string, string>, needle: string): Map<string, string> {
  return new Map(
    [...files].map(([path, content]) => [
      path,
      content
        .split("\n")
        .filter((line) => !line.includes(needle))
        .join("\n"),
    ]),
  );
}

describe("isMoveReady", () => {
  const tunnel = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });
  const portainer = portainerTestPlan({ redeploy: "cloudflare" });
  const worker = cloudflarePlan();

  it("is true for the files OpsCrew renders today", async () => {
    for (const plan of [tunnel, portainer, worker, testPlan(), portainerTestPlan()]) {
      expect(await isMoveReady(plan, reader(committed(plan))), plan.target.provider).toBe(true);
    }
  });

  it("is false for a deploy through Access whose workflow has no `_NEW` service token", async () => {
    expect(await isMoveReady(tunnel, reader(without(committed(tunnel), "_NEW")))).toBe(false);
    expect(await isMoveReady(portainer, reader(without(committed(portainer), "_NEW")))).toBe(false);
  });

  it("is false for a Workers site without the new account's deploy or the custom domains' variable", async () => {
    const files = committed(worker);
    expect(await isMoveReady(worker, reader(without(files, "_NEW")))).toBe(false);
    expect(await isMoveReady(worker, reader(without(files, "var.custom_domains")))).toBe(false);
    expect(await isMoveReady(worker, reader(new Map()))).toBe(false);
  });

  it("needs nothing new where no deploy goes through Cloudflare", async () => {
    for (const plan of [testPlan(), portainerTestPlan()]) {
      expect(await isMoveReady(plan, reader(new Map()))).toBe(true);
    }
  });
});
