import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../../testing";
import { PAGES_REPO } from "../../testing/pages";
import { type PagesApi, PagesApplyError, planPages } from "./plan";
import { pagesPlanStep } from "./step";

describe("pagesPlanStep", () => {
  it("audits each step applied before a failure, then the failure", async () => {
    const deps = await createTestPhaseDeps();
    const api: PagesApi = {
      getPages: async () => undefined,
      createPages: async () => undefined,
      updatePages: async () => {
        throw new OpsCrewError("PROVIDER_ERROR", "GitHub did not answer.");
      },
      pagesHealth: async () => undefined,
      pagesAllowed: async () => "yes",
    };
    const plan = planPages({
      ...PAGES_REPO,
      site: undefined,
      cname: "docs.example.com",
      savedAgain: false,
    });
    const error = await pagesPlanStep(deps, {
      api,
      plan,
      planOnly: false,
      command: "opscrew provision",
      app: "example-app",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PagesApplyError);
    expect((error as PagesApplyError).applied).toEqual(["create"]);
    const pages = deps.audit.entries.filter((entry) => entry.action.startsWith("pages "));
    expect(pages.map((entry) => [entry.action, entry.decision])).toEqual([
      ["pages apply started", "approved"],
      ["pages change create", "approved"],
      ["pages apply failed", "refused"],
    ]);
    expect(pages[2]?.detail).toBe("steps applied before the failure: create");
  });
});
