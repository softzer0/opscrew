// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCaddyfile, renderCompose } from "../runtime";
import type { RenderContext } from "../types";
import {
  CHECKOUT_ACTION,
  DEFAULT_TRIVY_IMAGE,
  DEPLOY_SECRETS,
  healthUrl,
  renderWorkflow,
} from "./index";

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
    services: { postgres: o.postgres ?? true, redis: o.redis ?? true },
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

describe("renderCompose", () => {
  it("runs the app, Postgres, Valkey and Caddy with only Caddy publishing ports", () => {
    const file = renderCompose(plan());
    expect(file.path).toBe("opscrew/runtime/compose.yaml");
    const doc = parse(file.content);
    expect(Object.keys(doc.services)).toEqual(["app", "db", "cache", "caddy"]);
    expect(doc.services.app.ports).toBeUndefined();
    expect(doc.services.db.ports).toBeUndefined();
    expect(doc.services.caddy.ports).toEqual(["80:80", "443:443", "443:443/udp"]);
    expect(doc.services.app.image).toMatch(/^\$\{APP_IMAGE:\?/);
    expect(doc.services.app.cap_drop).toEqual(["ALL"]);
    expect(doc.services.app.depends_on).toEqual({
      db: { condition: "service_healthy" },
      cache: { condition: "service_started" },
    });
    expect(doc.services.db.healthcheck.test[1]).toContain("$${POSTGRES_USER}");
    expect(file.content).toMatchSnapshot();
  });

  it("omits the database and cache when the plan does not self-host them", () => {
    const doc = parse(renderCompose(plan({ postgres: false, redis: false })).content);
    expect(Object.keys(doc.services)).toEqual(["app", "caddy"]);
    expect(doc.services.app.depends_on).toBeUndefined();
  });

  it("rotates every service's logs itself and keeps no-new-privileges (Docker's daemon settings stay as they are)", () => {
    const release = "python manage.py migrate --noinput";
    const doc = parse(renderCompose(plan({ release })).content);
    expect(Object.keys(doc.services)).toEqual(["app", "release", "db", "cache", "caddy"]);
    for (const service of Object.values<Record<string, unknown>>(doc.services)) {
      expect(service.logging).toEqual({
        driver: "json-file",
        options: { "max-size": "10m", "max-file": "3" },
      });
      expect(service.security_opt).toEqual(["no-new-privileges:true"]);
    }
  });

  it("adds no release service without a release command", () => {
    const content = renderCompose(plan()).content;
    expect(content).not.toContain("release");
  });

  it("runs the release command as a one-off service of the app image, environment and network", () => {
    const command = "python manage.py migrate --noinput && echo $HOME ${X}";
    const file = renderCompose(plan({ release: command }));
    const doc = parse(file.content);
    expect(Object.keys(doc.services)).toEqual(["app", "release", "db", "cache", "caddy"]);
    const { app, release } = doc.services;
    expect(release.image).toBe(app.image);
    expect(release.env_file).toEqual(app.env_file);
    expect(release.environment).toEqual(app.environment);
    expect(release.networks).toEqual(app.networks);
    expect(release.cap_drop).toEqual(["ALL"]);
    expect(release.security_opt).toEqual(app.security_opt);
    // Only `docker compose run` starts it, never `docker compose up`, and it never restarts.
    expect(release.profiles).toEqual(["release"]);
    expect(release.restart).toBeUndefined();
    expect(release.ports).toBeUndefined();
    expect(release.depends_on).toBeUndefined();
    // `$` is escaped so Compose passes the command to the shell unchanged.
    expect(release.command).toEqual([
      "sh",
      "-c",
      "python manage.py migrate --noinput && echo $$HOME $${X}",
    ]);
    expect(file.content).toContain("app.releaseCommand");
    expect(file.content).toMatchSnapshot();
  });
});

describe("renderCaddyfile", () => {
  it("serves the domain (and www) with HSTS and the ACME email", () => {
    const content = renderCaddyfile(plan({ domain: "example.com", www: true }), ctx).content;
    expect(content).toContain("example.com, www.example.com {");
    expect(content).toContain("email ops@example.com");
    expect(content).toContain("reverse_proxy app:3000");
    expect(content).toContain("Strict-Transport-Security");
    expect(content).toMatchSnapshot();
  });

  it("serves plain HTTP on the IP without HSTS before a domain exists", () => {
    const content = renderCaddyfile(plan({ port: 8080 }), ctx).content;
    expect(content).toContain(":80 {");
    expect(content).toContain("reverse_proxy app:8080");
    expect(content).not.toContain("Strict-Transport-Security");
    expect(content).not.toContain("email");
  });
});

describe("renderWorkflow", () => {
  const withDomain = renderWorkflow(plan({ domain: "shop.example.com" }), ctx);
  const doc = parse(withDomain.content);
  type Step = {
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    if?: string;
    name?: string;
    id?: string;
  };
  const steps = (job: string): Step[] => doc.jobs[job].steps;

  it("is valid YAML with least-privilege permissions and a concurrency group", () => {
    expect(withDomain.path).toBe(".github/workflows/opscrew-deploy.yml");
    expect(doc.on.push.branches).toEqual(["main"]);
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(doc.jobs.build.permissions).toEqual({ contents: "read", packages: "write" });
    expect(doc.jobs.deploy.permissions).toEqual({ contents: "read", packages: "read" });
    expect(doc.jobs.deploy.needs).toBe("build");
    expect(doc.concurrency).toEqual({ group: "opscrew-deploy", "cancel-in-progress": false });
    expect(withDomain.content).toMatchSnapshot();
  });

  it("pins every action by commit SHA and uses no third-party actions", () => {
    const uses = [...steps("build"), ...steps("deploy")].map((s) => s.uses).filter(Boolean);
    expect(uses).toEqual([CHECKOUT_ACTION.split(" #")[0], CHECKOUT_ACTION.split(" #")[0]]);
    expect(uses.every((u) => /@[0-9a-f]{40}$/.test(u ?? ""))).toBe(true);
  });

  it("never interpolates expressions inside run scripts", () => {
    for (const step of [...steps("build"), ...steps("deploy")]) {
      if (step.run) expect(step.run, step.name).not.toContain("${{");
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
    expect(remote[0]).toContain("rm -f .env.previous");
    expect(remote[0]).toContain("cp .env .env.previous");
    expect(remote[1]).toContain("docker login ghcr.io");
    expect(remote[2]).toContain("docker compose pull");
  });

  it("deploys the exact pushed image by digest and keeps the SHA tag for humans", () => {
    const image = steps("build").find((s) => s.id === "image");
    expect(image?.run).toContain("${GITHUB_SHA}");
    const push = steps("build").find((s) => s.id === "push");
    expect(push?.run).toContain('docker push "$IMAGE"');
    expect(push?.run).toContain("RepoDigests");
    expect(push?.run).toContain('echo "ref=$ref" >> "$GITHUB_OUTPUT"');
    expect(doc.jobs.build.outputs).toEqual({
      image: "${{ steps.push.outputs.ref }}",
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
    expect(DEFAULT_TRIVY_IMAGE).toMatch(/^aquasec\/trivy:0\.75\.0@sha256:[0-9a-f]{64}$/);
    const build = steps("build");
    const scan = build.findIndex((s) => s.name?.startsWith("Scan"));
    const logout = build.findIndex((s) => s.run?.includes("docker logout ghcr.io"));
    expect(scan).toBeGreaterThan(-1);
    expect(logout).toBeGreaterThan(-1);
    expect(logout).toBeLessThan(scan);
    expect(build[scan]?.run).toContain(DEFAULT_TRIVY_IMAGE);
    const noScan = parse(renderWorkflow(plan({ imageScan: false }), ctx).content);
    expect(
      noScan.jobs.build.steps.some((s: Step) => s.run?.includes("docker logout ghcr.io")),
    ).toBe(true);
  });

  it("runs no release step without a release command", () => {
    expect(withDomain.content).not.toContain("release");
  });

  describe("with a release command", () => {
    const remoteDeploy = (p: DeployPlan) => {
      const deploy = parse(renderWorkflow(p, ctx).content).jobs.deploy.steps as Step[];
      const start = deploy.find((s) => s.id === "start")?.run ?? "";
      return (
        start
          .split("\n")
          .filter((line) => line.includes("ssh "))
          .at(-1) ?? ""
      );
    };

    it("starts the backing services and runs the command in the new image before the switch", () => {
      const remote = remoteDeploy(plan({ release: "python manage.py migrate --noinput" }));
      const order = [
        "export APP_IMAGE='${IMAGE}'",
        "docker compose pull",
        "docker compose up -d --wait db cache",
        "docker compose run --rm --no-deps -T release",
        "> .env",
        "docker compose up -d --remove-orphans",
      ].map((part) => remote.indexOf(part));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // The command itself lives in compose.yaml, not in the workflow.
      expect(remote).not.toContain("manage.py");
    });

    it("waits only for the backing services the plan has", () => {
      const dbOnly = remoteDeploy(plan({ release: "x", redis: false }));
      expect(dbOnly).toContain("docker compose up -d --wait db;");
      const none = remoteDeploy(plan({ release: "x", postgres: false, redis: false }));
      expect(none).not.toContain("--wait");
      expect(none).toContain("docker compose run --rm --no-deps -T release");
    });

    it("stops with a plain message that names neither the server nor a secret", () => {
      const remote = remoteDeploy(plan({ release: "x" }));
      const message = /echo '(::error::[^']*)'/.exec(remote)?.[1] ?? "";
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
