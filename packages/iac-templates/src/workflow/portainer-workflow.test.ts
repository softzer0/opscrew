// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { PORTAINER_DEPLOY_SECRETS, portainerHealthUrl, renderWorkflow } from "./index";

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
};
type Job = {
  name: string;
  "runs-on": string;
  permissions: Record<string, string>;
  needs?: string;
  environment?: string;
  outputs?: Record<string, string>;
  steps: Step[];
};
type Workflow = { permissions: Record<string, string>; jobs: { build: Job; deploy: Job } };

const ctx = testContext();
const updaterPlan = portainerTestPlan({ redeploy: "updater", web: { mode: "tunnel" } });
const cloudflarePlan = portainerTestPlan({ redeploy: "cloudflare", web: { mode: "caddy" } });
const updater = renderWorkflow(updaterPlan, ctx);
const cloudflare = renderWorkflow(cloudflarePlan, ctx);
const updaterDoc = parse(updater.content) as Workflow;
const cloudflareDoc = parse(cloudflare.content) as Workflow;

function step(doc: Workflow, id: string): Step {
  const found = doc.jobs.deploy.steps.find((s) => s.id === id || s.name === id);
  if (!found) throw new Error(`no step ${id}`);
  return found;
}

describe("renderWorkflow for a Portainer target", () => {
  it("builds and pushes exactly as for other targets", () => {
    const server = parse(renderWorkflow(testPlan(), ctx).content) as Workflow;
    expect(updaterDoc.jobs.build).toEqual(server.jobs.build);
    expect(updaterDoc.permissions).toEqual({ contents: "read" });
    expect(updater.path).toBe(".github/workflows/opscrew-deploy.yml");
    expect(updater.kind).toBe("workflow");
  });

  it("builds on an arm64 runner for an arm64 environment", () => {
    const arm = parse(
      renderWorkflow(portainerTestPlan({ arch: "arm64" }), ctx).content,
    ) as Workflow;
    expect(arm.jobs.build["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(updaterDoc.jobs.build["runs-on"]).toBe("ubuntu-latest");
  });

  it("gives only the deploy job contents: write, for the deploy branch", () => {
    for (const doc of [updaterDoc, cloudflareDoc]) {
      expect(doc.jobs.deploy.name).toBe("Deploy to Portainer");
      expect(doc.jobs.deploy.needs).toBe("build");
      expect(doc.jobs.deploy.environment).toBe("production");
      expect(doc.jobs.deploy.permissions).toEqual({ contents: "write" });
      expect(doc.jobs.build.permissions).toEqual({ contents: "read", packages: "write" });
    }
  });

  it("writes compose.yaml with the new digest to the orphan branch opscrew-deploy", () => {
    const write = step(updaterDoc, "write");
    expect(write.name).toBe("Write the new version to the opscrew-deploy branch");
    expect(write.env).toEqual({ IMAGE: "${{ needs.build.outputs.image }}" });
    const script = write.run ?? "";
    expect(script).toContain("grep -qF __OPSCREW_APP_IMAGE__ opscrew/runtime/compose.yaml");
    expect(script).toContain('compose="${template//__OPSCREW_APP_IMAGE__/"$IMAGE"}"');
    expect(script).toContain("printf '100644 blob %s\\tcompose.yaml\\n'");
    expect(script).toContain('git commit-tree "$tree" "${parent[@]}" -m "Deploy $IMAGE"');
    expect(script).toContain('git push origin "$deployed:refs/heads/opscrew-deploy"');
    // A fast-forward on top of the branch's head: never a forced push.
    expect(script).not.toMatch(/git push[^\n]*(--force|\s-f\b|\s\+)/);
  });

  it("updater mode: Portainer's updater redeploys, the workflow needs no Portainer secret", () => {
    expect(updaterDoc.jobs.deploy.steps.map((s) => s.id ?? s.name ?? s.uses)).toEqual([
      expect.stringMatching(/^actions\/checkout@[0-9a-f]{40}$/),
      "write",
      "health",
      "Roll back to the previous version",
    ]);
    expect(updater.content).not.toContain("OPSCREW_PORTAINER_");
    expect(updater.content).not.toMatch(/CF-Access|OPSCREW_HOST|ssh/);
  });

  it("cloudflare mode: calls the webhook through Access with the service token from secrets", () => {
    const redeploy = step(cloudflareDoc, "redeploy");
    expect(redeploy.if).toBe("steps.write.outputs.changed == 'true'");
    expect(redeploy.env).toEqual({
      WEBHOOK_URL: `\${{ secrets.${PORTAINER_DEPLOY_SECRETS.webhookUrl} }}`,
      ACCESS_CLIENT_ID: `\${{ secrets.${PORTAINER_DEPLOY_SECRETS.accessClientId} }}`,
      ACCESS_CLIENT_SECRET: `\${{ secrets.${PORTAINER_DEPLOY_SECRETS.accessClientSecret} }}`,
    });
    const script = redeploy.run ?? "";
    expect(script).toContain("CF-Access-Client-Id: %s\\nCF-Access-Client-Secret: %s\\n");
    expect(script).toContain('-X POST -H @"$headers"');
    expect(script).toContain('rm -f "$headers"');
    expect(cloudflareDoc.jobs.deploy.steps.map((s) => s.id ?? s.name)).toEqual([
      undefined,
      "write",
      "redeploy",
      "health",
      "Roll back to the previous version",
    ]);
    // The rollback calls the webhook again.
    expect(step(cloudflareDoc, "Roll back to the previous version").env).toMatchObject(
      redeploy.env ?? {},
    );
  });

  it("never echoes a secret or passes one on a command line", () => {
    for (const doc of [updaterDoc, cloudflareDoc]) {
      for (const s of doc.jobs.deploy.steps) {
        const script = s.run ?? "";
        expect(script, s.name).not.toMatch(/\$\{\{\s*secrets\./);
        for (const line of script.split("\n")) {
          if (/\$\{?(ACCESS_CLIENT_ID|ACCESS_CLIENT_SECRET)/.test(line)) {
            // Only into the header file, never into the log.
            expect(line, s.name).toContain('> "$headers"');
          }
          if (/\$\{?WEBHOOK_URL/.test(line)) expect(line, s.name).toMatch(/^code="\$\(curl /);
        }
      }
    }
  });

  it("waits a bounded time for the site to answer with the new version", () => {
    for (const [doc, attempts] of [
      [updaterDoc, 60],
      [cloudflareDoc, 30],
    ] as const) {
      const health = step(doc, "health");
      expect(health.env).toEqual({
        URL: "https://shop.example.com/api/health",
        IMAGE: "${{ needs.build.outputs.image }}",
      });
      expect(health.run).toContain(`for attempt in $(seq 1 ${attempts}); do`);
      expect(health.run).toContain("-w '%header{x-opscrew-image}'");
    }
    expect(portainerHealthUrl(updaterPlan)).toBe("https://shop.example.com/api/health");
  });

  it("rolls back only after it changed the branch, and always fails the run", () => {
    for (const doc of [updaterDoc, cloudflareDoc]) {
      const rollback = step(doc, "Roll back to the previous version");
      expect(rollback.if).toBe("failure() && steps.write.outputs.changed == 'true'");
      expect(rollback.env).toMatchObject({
        PREVIOUS: "${{ steps.write.outputs.previous }}",
        DEPLOYED: "${{ steps.write.outputs.deployed }}",
      });
      expect(rollback.run?.trim().endsWith("exit 1")).toBe(true);
      expect(rollback.run).toContain('git commit-tree "$PREVIOUS^{tree}" -p "$DEPLOYED"');
    }
  });

  it("without a domain, writes the branch and says the run cannot check the app", () => {
    const plan = portainerTestPlan({ domain: false, web: { mode: "proxy", port: 8080 } });
    expect(portainerHealthUrl(plan)).toBeUndefined();
    const doc = parse(renderWorkflow(plan, ctx).content) as Workflow;
    expect(doc.jobs.deploy.steps.map((s) => s.id ?? s.name)).toEqual([
      undefined,
      "write",
      "Check the app",
    ]);
    expect(step(doc, "Check the app").run).toContain("::notice::");
  });

  it("proxy mode: probes the site once before the write, and checks it only when GitHub reaches it", () => {
    const plan = portainerTestPlan({ web: { mode: "proxy", port: 8080 } });
    const doc = parse(renderWorkflow(plan, ctx).content) as Workflow;
    expect(doc.jobs.deploy.steps.map((s) => s.id ?? s.name)).toEqual([
      undefined,
      "probe",
      "write",
      "Check the app",
      "health",
      "Roll back to the previous version",
    ]);
    const probe = step(doc, "probe");
    expect(probe.env).toEqual({ URL: "https://shop.example.com/api/health" });
    expect(probe.run).toContain('if curl -sS --max-time 15 -o /dev/null "$URL"; then');
    expect(probe.run).not.toContain("-f");
    expect(step(doc, "health").if).toBe("steps.probe.outputs.reachable == 'true'");
    expect(step(doc, "health").run).toContain(
      "Check also that your proxy forwards shop.example.com to port 8080 of the Portainer host.",
    );
    const notice = step(doc, "Check the app");
    expect(notice.if).toBe("steps.probe.outputs.reachable != 'true'");
    // The same notice as without a domain.
    const noDomain = parse(
      renderWorkflow(portainerTestPlan({ domain: false, web: { mode: "proxy", port: 8080 } }), ctx)
        .content,
    ) as Workflow;
    expect(notice.run).toBe(step(noDomain, "Check the app").run);
    expect(step(doc, "Roll back to the previous version").if).toBe(
      "failure() && steps.write.outputs.changed == 'true'",
    );
  });

  it("caddy and tunnel modes always check the site: no probe", () => {
    for (const doc of [updaterDoc, cloudflareDoc]) {
      expect(doc.jobs.deploy.steps.some((s) => s.id === "probe")).toBe(false);
      expect(step(doc, "health").if).toBeUndefined();
      expect(step(doc, "health").run).not.toContain("your proxy");
    }
  });

  it("leaves the other targets' workflows as they were", () => {
    for (const plan of [
      testPlan(),
      testPlan({ provider: "digitalocean", domain: "shop.example.com" }),
      testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" }),
    ]) {
      const content = renderWorkflow(plan, ctx).content;
      expect(content).not.toContain("opscrew-deploy branch");
      expect(content).toContain("    name: Deploy to the server");
    }
  });

  it("matches the snapshots", () => {
    expect(updater.content).toMatchSnapshot("updater");
    expect(cloudflare.content).toMatchSnapshot("cloudflare");
  });
});
