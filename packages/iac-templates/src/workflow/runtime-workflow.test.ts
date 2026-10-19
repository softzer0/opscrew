// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testServices } from "../__fixtures__/plans";
import { ACTIONS, IMAGES } from "../pins";
import type { RenderContext } from "../types";
import { DEPLOY_SECRETS, healthUrl, renderWorkflow } from "./index";

function plan(
  o: {
    domain?: string;
    www?: boolean;
    postgres?: boolean;
    redis?: boolean;
    imageScan?: boolean;
    port?: number;
    release?: string;
  } = {},
): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: {
      name: "shop",
      port: o.port ?? 3000,
      healthPath: "/api/health",
      env: [],
      ...(o.release === undefined ? {} : { releaseCommand: o.release }),
    },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: true,
    },
    services: testServices({ postgres: o.postgres ?? true, redis: o.redis ?? true }),
    externalServices: [],
    cost: {
      monthly: { amount: 7.09, currency: "EUR" },
      breakdown: [
        { item: "server", monthly: { amount: 6.59, currency: "EUR" } },
        { item: "ipv4", monthly: { amount: 0.5, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: o.domain
      ? {
          provider: "cloudflare",
          domain: o.domain,
          zone: "example.com",
          proxied: true,
          www: o.www ?? false,
        }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: o.imageScan === false ? { imageScan: false } : {},
  });
}

const ctx: RenderContext = {
  opscrewVersion: "0.1.0",
  github: { owner: "Acme", repo: "Shop" },
  deploySshPublicKey: "ssh-ed25519 AAAA opscrew-deploy",
  acmeEmail: "ops@example.com",
};

type Step = {
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  if?: string;
  name?: string;
  id?: string;
};

/** The server script the start step sends over SSH (the heredoc after `sh -s`). */
function serverScript(p: DeployPlan): string {
  const deploy = parse(renderWorkflow(p, ctx).content).jobs.deploy.steps as Step[];
  const start = deploy.find((s) => s.id === "start")?.run ?? "";
  return start.slice(start.indexOf("<<'REMOTE'\n"));
}

describe("renderWorkflow", () => {
  const withDomain = renderWorkflow(plan({ domain: "shop.example.com" }), ctx);
  const doc = parse(withDomain.content);
  const steps = (job: string): Step[] => doc.jobs[job].steps;

  it("is valid YAML with least-privilege permissions and a concurrency group", () => {
    expect(withDomain.path).toBe(".github/workflows/opscrew-deploy.yml");
    expect(doc.on.push.branches).toEqual(["main"]);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(Object.keys(doc.jobs)).toEqual(["build", "deploy", "prune"]);
    expect(doc.jobs.build.permissions).toEqual({ contents: "read", packages: "write" });
    expect(doc.jobs.deploy.permissions).toEqual({ contents: "read", packages: "read" });
    expect(doc.jobs.deploy.needs).toBe("build");
    expect(doc.jobs.deploy.outputs).toEqual({ previous: "${{ steps.start.outputs.previous }}" });
    expect(doc.concurrency).toEqual({ group: "opscrew-deploy", "cancel-in-progress": false });
    expect(withDomain.content).toMatchSnapshot();
  });

  it("pins every action by commit SHA, from pins.ts", () => {
    const uses = Object.values<{ steps: Step[] }>(doc.jobs)
      .flatMap((j) => j.steps)
      .map((s) => s.uses)
      .filter(Boolean);
    expect(uses.every((u) => /@[0-9a-f]{40}$/.test(u ?? ""))).toBe(true);
    expect(steps("deploy")[0]?.uses).toBe(ACTIONS.checkout.split(" #")[0]);
  });

  it("never interpolates expressions inside run scripts", () => {
    for (const job of Object.values<{ steps: Step[] }>(doc.jobs)) {
      for (const step of job.steps) {
        if (step.run) expect(step.run, step.name).not.toContain("${{");
      }
    }
  });

  it("references deploy secrets only by name", () => {
    for (const name of [
      DEPLOY_SECRETS.host,
      DEPLOY_SECRETS.sshKey,
      DEPLOY_SECRETS.knownHosts,
      DEPLOY_SECRETS.appEnv,
      DEPLOY_SECRETS.dbEnv,
      DEPLOY_SECRETS.buildEnv,
      DEPLOY_SECRETS.buildSecrets,
    ]) {
      expect(withDomain.content).toContain(`secrets.${name}`);
    }
    const noDb = renderWorkflow(plan({ domain: "shop.example.com", postgres: false }), ctx).content;
    expect(noDb).not.toContain(DEPLOY_SECRETS.dbEnv);
    expect(noDb).not.toContain("db.env");
  });

  it("checks health over HTTPS on the domain and rolls back on failure", () => {
    const health = steps("deploy").find((s) => s.name?.startsWith("Check"));
    expect(health?.env?.URL).toBe("https://shop.example.com/api/health");
    const rollback = steps("deploy").find((s) => s.name?.startsWith("Roll back"));
    expect(rollback?.run).toContain(".env.previous");
  });

  it("rolls back only when starting or checking the new version failed", () => {
    const deploy = steps("deploy");
    expect(deploy.find((s) => s.id === "start")?.name).toBe("Start the new version");
    expect(deploy.find((s) => s.id === "health")?.name).toBe("Check that the app is healthy");
    const rollback = deploy.find((s) => s.name?.startsWith("Roll back"));
    expect(rollback?.if).toBe(
      "failure() && (steps.start.outcome == 'failure' || steps.health.outcome == 'failure')",
    );
    expect(deploy.at(-1)).toBe(rollback);
    expect(rollback?.run).toMatch(/exit 1\s*$/);
  });

  it("saves the previous environment as the first thing the start step does on the server", () => {
    const start = steps("deploy").find((s) => s.id === "start");
    const remote = (start?.run ?? "").split("\n").filter((line) => line.includes("ssh "));
    expect(remote).toHaveLength(3);
    expect(remote[0]).toContain("rm -f .env.previous");
    expect(remote[0]).toContain("cp .env .env.previous");
    expect(remote[0]).toMatch(/^previous="\$\(ssh /);
    expect(remote[1]).toContain("docker login ghcr.io");
    expect(remote[2]).toContain(`sh -s -- "$IMAGE" <<'REMOTE'`);
    expect(serverScript(plan())).toContain("docker compose pull");
  });

  it("deploys the exact pushed image by digest and keeps the SHA tag for humans", () => {
    expect(doc.jobs.build.outputs).toEqual({
      image: "${{ steps.final.outputs.ref }}",
      tag: "${{ steps.image.outputs.image }}",
    });
    const start = steps("deploy").find((s) => s.id === "start");
    expect(start?.env?.IMAGE).toBe("${{ needs.build.outputs.image }}");
    expect(start?.run).toContain("@sha256:[0-9a-f]{64}");
  });

  it("checks health on the server IP before a domain exists", () => {
    expect(healthUrl(plan())).toBe("http://${{ secrets.OPSCREW_HOST }}/api/health");
  });

  it("scans the image only when enabled", () => {
    expect(withDomain.content).toContain("aquasec/trivy:");
    expect(renderWorkflow(plan({ imageScan: false }), ctx).content).not.toContain("trivy");
  });

  it("runs Trivy pinned by digest, after logging out of the registry", () => {
    expect(IMAGES.trivy.ref).toMatch(/^aquasec\/trivy:0\.75\.0@sha256:[0-9a-f]{64}$/);
    const scan = steps("build").find((s) => s.name?.startsWith("Scan"))?.run ?? "";
    expect(scan.indexOf("docker logout ghcr.io")).toBeGreaterThan(-1);
    expect(scan.indexOf("docker logout ghcr.io")).toBeLessThan(scan.indexOf(IMAGES.trivy.ref));
  });

  it("runs no release step without a release command", () => {
    expect(withDomain.content).not.toContain("release");
  });

  describe("with a release command", () => {
    it("starts the backing services and runs the command in the new image before the switch", () => {
      const remote = serverScript(plan({ release: "python manage.py migrate --noinput" }));
      const order = [
        'export APP_IMAGE="$1"',
        "docker compose pull",
        "docker compose up -d --no-deps --wait --remove-orphans db cache proxy caddy",
        "docker compose run --rm --no-deps -T release",
        "--scale",
        "> .env",
      ].map((part) => remote.indexOf(part));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The command itself lives in compose.yaml, not in the workflow.
      expect(remote).not.toContain("manage.py");
      // The database and cache are never named after the release command.
      const after = remote.slice(remote.indexOf("-T release"));
      expect(after).not.toMatch(/\b(db|cache)\b/);
    });

    it("starts only the backing services the plan has", () => {
      const dbOnly = serverScript(plan({ release: "x", redis: false }));
      expect(dbOnly).toContain(
        "docker compose up -d --no-deps --wait --remove-orphans db proxy caddy\n",
      );
      const none = serverScript(plan({ release: "x", postgres: false, redis: false }));
      expect(none).toContain(
        "docker compose up -d --no-deps --wait --remove-orphans proxy caddy\n",
      );
      expect(none).toContain("docker compose run --rm --no-deps -T release");
    });

    it("stops with a plain message that names neither the server nor a secret", () => {
      const remote = serverScript(plan({ release: "x" }));
      const message = /echo '(::error::The release[^']*)'/.exec(remote)?.[1] ?? "";
      expect(message).toContain("release command");
      expect(message).toContain("app.releaseCommand");
      expect(message).toContain("previous version keeps serving");
      expect(message).not.toMatch(/\$|HOST|secrets/);
    });

    it("matches the snapshot", () => {
      const content = renderWorkflow(
        plan({ domain: "shop.example.com", release: "python manage.py migrate --noinput" }),
        ctx,
      ).content;
      expect(content).toMatchSnapshot();
    });
  });
});
