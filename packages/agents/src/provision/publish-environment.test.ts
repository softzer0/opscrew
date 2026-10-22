import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { driftNextSteps, renderDriftReport } from "../drift";
import type { DriftReport } from "../drift/types";
import { portainerPlan, testPlan } from "../testing";
import { renderPortainerRunbook } from "../verify/portainer";
import { deploySetupPullRequestBody } from "./publish";

/** `prod` as the plan of the environment `name`, as design writes it. */
function inEnvironment(prod: DeployPlan, name: string): DeployPlan {
  return DeployPlanSchema.parse({
    ...prod,
    environment: { name },
    app: { ...prod.app, name: `${prod.app.name}-${name}` },
    infra: { ...prod.infra, dir: `opscrew/infra/${name}` },
    cicd: { ...prod.cicd, workflowPath: `.github/workflows/opscrew-deploy-${name}.yml` },
    dns: prod.dns.domain === undefined ? prod.dns : { ...prod.dns, domain: `${name}.example.com` },
  });
}

const STAGING = "opscrew/environments/staging";

describe("the deploy-setup pull request of a named environment", () => {
  it("names its own runtime folder, plan file and --env", () => {
    const body = deploySetupPullRequestBody(inEnvironment(testPlan(), "staging"), "1.2.3", {
      secretsStored: false,
      flag: " --env staging",
    });
    expect(body).toContain(`\`${STAGING}/runtime/\``);
    expect(body).toContain(`\`${STAGING}/plan.yaml\``);
    expect(body).toContain("`opscrew provision --env staging`");
    expect(body).not.toContain("opscrew/runtime/");
    expect(body).not.toContain("`opscrew/plan.yaml`");
  });

  it("in the user's Portainer, names its own stack template and deploy branch", () => {
    const body = deploySetupPullRequestBody(inEnvironment(portainerPlan(), "staging"), "1.2.3");
    expect(body).toContain(`\`${STAGING}/runtime/compose.yaml\``);
    expect(body).toContain("`opscrew-deploy-staging` branch");
    expect(body).not.toMatch(/`opscrew-deploy` branch/);
  });

  it("is unchanged for prod", () => {
    const body = deploySetupPullRequestBody(testPlan(), "1.2.3");
    expect(body).toContain("- `opscrew/runtime/`: Docker Compose");
    expect(body).toContain("- `opscrew/plan.yaml`: the deployment plan.");
  });
});

describe("the Portainer runbook beside other environments", () => {
  const ctx = { opscrewVersion: "1.2.3", github: { owner: "acme", repo: "shop" }, projectId: "p1" };

  it("names --env prod in prod's commands, and the environment's own folders elsewhere", () => {
    const prod = renderPortainerRunbook(portainerPlan(), {
      ...ctx,
      environments: ["prod", "staging"],
      flag: " --env prod",
    }).content;
    expect(prod).toContain("`opscrew verify --env prod`");
    const staging = renderPortainerRunbook(inEnvironment(portainerPlan(), "staging"), {
      ...ctx,
      environments: ["prod", "staging"],
      flag: " --env staging",
    }).content;
    expect(staging).toContain("`opscrew destroy --env staging`");
    expect(staging).toContain("`opscrew-deploy-staging` branch");
  });

  it("is unchanged for an app with prod only", () => {
    const alone = renderPortainerRunbook(portainerPlan(), ctx).content;
    expect(alone).toBe(
      renderPortainerRunbook(portainerPlan(), { ...ctx, environments: ["prod"] }).content,
    );
    expect(alone).toContain("`opscrew verify` checks the site from outside");
  });
});

describe("the drift report of a named environment", () => {
  const report: DriftReport = {
    drift: [],
    pending: [],
    files: { changed: ["opscrew/environments/staging/runtime/compose.yaml"], created: [] },
    foreignDnsRecords: [],
    clean: false,
    checkedAt: "2026-10-22T12:00:00.000Z",
    provider: "portainer",
  };

  it("names its plan file, --env and its deploy branch", () => {
    const plan = inEnvironment(portainerPlan(), "staging");
    expect(renderDriftReport(report, plan)).toContain(
      `Files that differ from what OpsCrew renders from ${STAGING}/plan.yaml`,
    );
    expect(driftNextSteps(report, plan).join("\n")).toContain("`opscrew provision --env staging`");
    expect(driftNextSteps({ ...report, clean: true }, plan)[0]).toContain(
      "`opscrew drift --env staging` again after changes in Portainer, on the opscrew-deploy-staging branch",
    );
  });

  it("is prod's without a plan", () => {
    expect(driftNextSteps({ ...report, clean: true })[0]).toContain(
      "run `opscrew drift` again after changes in Portainer, on the opscrew-deploy branch",
    );
  });
});
