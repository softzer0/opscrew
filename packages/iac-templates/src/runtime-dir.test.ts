import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "./__fixtures__/plans";
import { withServices } from "./catalog/__fixtures__/plans";
import { originPullPem } from "./edge";
import { localhostPlan } from "./edge/__fixtures__/localhost";
import { renderStorage, storageRootDir } from "./infra";
import { renderPortainerCompose } from "./portainer-host";
import {
  portainerDeployBranch,
  portainerStackTemplatePath,
  renderPortainerStack,
  renderUpdaterStack,
} from "./portainer-target";
import { portainerTestPlan } from "./portainer-target/__fixtures__/plans";
import { renderRunbook } from "./runbook";
import {
  type RuntimeContext,
  renderCompose,
  renderEdgeSite,
  renderRuntimeFiles,
  renderTunnelConnectorCompose,
} from "./runtime";
import { runtimeDir } from "./runtime-dir";
import type { RenderedFile } from "./types";
import { renderWorkflow } from "./workflow";
import { inEnvironment, NIGHTLY, ofApp, withProcesses } from "./workflow/__fixtures__/plans";

const ctx: RuntimeContext = { ...testContext(), localhost: { hostname: "shop.localhost" } };

/**
 * `shop` on the user's own server in tunnel mode with Portainer, MySQL (a settings file) and a
 * cron job: every runtime file a server's app can have.
 */
const server = withProcesses(
  withServices(
    [{ kind: "mysql" }],
    {},
    { provider: "own", access: "tunnel", domain: "shop.example.com", portainer: {} },
  ),
  { cron: [NIGHTLY] },
);

/** Every file the renderers give `plan` on a server or this computer. */
function serverFiles(plan: DeployPlan): RenderedFile[] {
  return [
    renderCompose(plan),
    ...renderRuntimeFiles(plan),
    ...renderEdgeSite(plan, ctx),
    ...(plan.target.provider === "own"
      ? [renderTunnelConnectorCompose(plan), renderPortainerCompose(plan, { initialAdmin: false })]
      : []),
    renderWorkflow(plan, ctx),
  ];
}

describe("runtimeDir", () => {
  it("is opscrew/runtime for prod and opscrew/environments/<env>/runtime for another", () => {
    expect(runtimeDir(server)).toBe("opscrew/runtime");
    expect(runtimeDir(inEnvironment(server, {}))).toBe("opscrew/runtime");
    expect(runtimeDir(inEnvironment(server, { name: "staging" }))).toBe(
      "opscrew/environments/staging/runtime",
    );
    expect(originPullPem(inEnvironment(server, { name: "staging" }))).toBe(
      "opscrew/environments/staging/runtime/edge/tls/pull.pem",
    );
  });

  for (const [name, plan] of [
    ["a server", server],
    ["this computer", withProcesses(localhostPlan(), { cron: [NIGHTLY] })],
  ] as const) {
    it(`keeps two environments' files apart on ${name}, each in its own runtime folder`, () => {
      const prod = serverFiles(plan);
      const staging = serverFiles(inEnvironment(plan, { name: "staging" }));
      const prodPaths = new Set(prod.map((file) => file.path));
      expect(staging.filter((file) => prodPaths.has(file.path))).toEqual([]);
      for (const [files, dir] of [
        [prod, "opscrew/runtime/"],
        [staging, "opscrew/environments/staging/runtime/"],
      ] as const) {
        const runtime = files.filter((file) => file.kind === "runtime");
        expect(runtime.length).toBeGreaterThan(0);
        for (const file of runtime) expect(file.path.startsWith(dir), file.path).toBe(true);
      }
      // Staging's workflow uploads, checks and names only staging's runtime files.
      const workflow = staging.find((file) => file.kind === "workflow")?.content ?? "";
      expect(workflow).toContain("opscrew/environments/staging/runtime/");
      expect(workflow).not.toContain("opscrew/runtime");
    });
  }

  it("keeps two environments' storage roots apart, prod's where it was", () => {
    const staging = inEnvironment(server, { name: "staging" });
    expect(storageRootDir(server)).toBe("opscrew/infra/storage");
    expect(storageRootDir(inEnvironment(server, {}))).toBe("opscrew/infra/storage");
    expect(storageRootDir(staging)).toBe("opscrew/infra/storage-staging");
    // The storage root's files are in it.
    const bucket = inEnvironment(
      DeployPlanSchema.parse({
        ...testPlan({ domain: "shop.example.com" }),
        storage: {
          objectStorage: {
            provider: "hetzner",
            bucket: "shop-uploads",
            region: "fsn1",
            expected: { storageGb: 10, egressGbPerMonth: 50 },
            price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
          },
        },
      }),
      { name: "staging" },
    );
    const files = renderStorage(bucket, ctx).map((file) => file.path);
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) expect(path).toMatch(/^opscrew\/infra\/storage-staging\/[^/]+$/);
  });

  it("names the environment's own files in the runbook's drift check", () => {
    const staging = DeployPlanSchema.parse({
      ...inEnvironment(server, { name: "staging" }),
      infra: { dir: "opscrew/infra/staging" },
    });
    const text = renderRunbook(staging, ctx).content;
    expect(text).toContain(
      "files under `opscrew/infra/staging/` and `opscrew/environments/staging/runtime/` that differ from what\n  `opscrew/environments/staging/plan.yaml` would generate.",
    );
    expect(renderRunbook(server, ctx).content).toContain(
      "files under `opscrew/infra/` and `opscrew/runtime/` that differ from what\n  `opscrew/plan.yaml` would generate.",
    );
  });

  it("keeps two Portainer environments' stack templates apart", () => {
    const plan = portainerTestPlan();
    const staging = inEnvironment(plan, { name: "staging" });
    expect(renderPortainerStack(plan, ctx).path).toBe("opscrew/runtime/compose.yaml");
    expect(renderPortainerStack(staging, ctx).path).toBe(
      "opscrew/environments/staging/runtime/compose.yaml",
    );
    expect(portainerStackTemplatePath(staging)).toBe(renderPortainerStack(staging, ctx).path);
  });
});

describe("two apps in one repository", () => {
  for (const [name, plan] of [
    ["a server", server],
    ["this computer", withProcesses(localhostPlan(), { cron: [NIGHTLY] })],
  ] as const) {
    it(`keeps the first app's files and a further app's apart on ${name}`, () => {
      // A server's runbook too; this computer's is where the caller puts it.
      const files = (p: DeployPlan) => [
        ...serverFiles(p),
        ...(p.target.provider === "localhost" ? [] : [renderRunbook(p, ctx)]),
      ];
      const first = files(plan);
      const docs = ofApp(plan, "docs");
      const docsStaging = ofApp(inEnvironment(plan, { name: "staging" }), "docs");
      const further = files(docs);
      const furtherStaging = files(docsStaging);
      const paths = (files: RenderedFile[]) => new Set(files.map((file) => file.path));
      const taken = paths(first);
      expect(further.filter((file) => taken.has(file.path))).toEqual([]);
      const docsPaths = paths(further);
      expect(
        furtherStaging.filter((file) => taken.has(file.path) || docsPaths.has(file.path)),
      ).toEqual([]);
      for (const [files, dir] of [
        [further, "opscrew/apps/docs/"],
        [furtherStaging, "opscrew/apps/docs/environments/staging/"],
      ] as const) {
        for (const file of files.filter((f) => f.kind !== "workflow")) {
          expect(file.path.startsWith(dir), file.path).toBe(true);
        }
      }
      // The further app's workflow uploads, checks and names only its own runtime files.
      const workflow = further.find((file) => file.kind === "workflow")?.content ?? "";
      expect(workflow).toContain("opscrew/apps/docs/runtime/");
      expect(workflow).not.toMatch(/opscrew\/(?:runtime|environments)\//);
    });
  }

  it("keeps a further app's storage root apart from the first app's", () => {
    expect(storageRootDir(ofApp(server, "docs"))).toBe("opscrew/infra/storage-docs");
    expect(storageRootDir(ofApp(inEnvironment(server, { name: "staging" }), "docs"))).toBe(
      "opscrew/infra/storage-docs-staging",
    );
  });

  it("gives a further app on Portainer a deploy branch and stack template of its own", () => {
    const docs = ofApp(portainerTestPlan(), "docs");
    expect(portainerDeployBranch(docs)).toBe("opscrew-deploy-docs");
    expect(portainerStackTemplatePath(docs)).toBe("opscrew/apps/docs/runtime/compose.yaml");
    const workflow = renderWorkflow(docs, ctx).content;
    expect(workflow).toContain('git push origin "$deployed:refs/heads/opscrew-deploy-docs"');
    expect(workflow).not.toMatch(/refs\/heads\/opscrew-deploy(?!-docs)/);
    expect(renderPortainerStack(docs, ctx).content).toContain(
      "# this file to the opscrew-deploy-docs branch, which Portainer deploys.",
    );
    expect(
      portainerDeployBranch(ofApp(inEnvironment(portainerTestPlan(), { name: "staging" }), "docs")),
    ).toBe("opscrew-deploy-docs-staging");
  });
});

describe("a Portainer environment's deploy branch", () => {
  const prod = portainerTestPlan();
  const staging = inEnvironment(portainerTestPlan(), { name: "staging" });

  it("is opscrew-deploy for prod and opscrew-deploy-<env> for another", () => {
    expect(portainerDeployBranch(prod)).toBe("opscrew-deploy");
    expect(portainerDeployBranch(inEnvironment(prod, {}))).toBe("opscrew-deploy");
    expect(portainerDeployBranch(staging)).toBe("opscrew-deploy-staging");
  });

  it("is the branch a staging stack's workflow writes and its stacks name", () => {
    const workflow = renderWorkflow(staging, ctx).content;
    expect(workflow).toContain('git push origin "$deployed:refs/heads/opscrew-deploy-staging"');
    expect(workflow).toContain(
      "grep -qF __OPSCREW_APP_IMAGE__ opscrew/environments/staging/runtime/compose.yaml",
    );
    // No other branch, and no other environment's template.
    expect(workflow).not.toMatch(/refs\/heads\/opscrew-deploy(?!-staging)/);
    expect(workflow).not.toContain("opscrew/runtime");
    expect(renderPortainerStack(staging, ctx).content).toContain(
      "# this file to the opscrew-deploy-staging branch, which Portainer deploys.",
    );
    expect(renderUpdaterStack(staging).content).toContain(
      "# opscrew-deploy-staging branch; Portainer redeploys only when the branch changed.",
    );
    expect(renderWorkflow(prod, ctx).content).toContain(
      'git push origin "$deployed:refs/heads/opscrew-deploy"',
    );
  });
});
