import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderCaddyfile, renderCompose } from "../runtime";
import type { RenderContext } from "../types";
import { CHECKOUT_ACTION, DEPLOY_SECRETS, healthUrl, renderWorkflow } from "./index";

function plan(
  o: {
    domain?: string;
    www?: boolean;
    postgres?: boolean;
    redis?: boolean;
    imageScan?: boolean;
    port?: number;
  } = {},
): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: { name: "shop", port: o.port ?? 3000, healthPath: "/api/health", env: [] },
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
    const file = renderCompose(plan(), ctx);
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
    const doc = parse(renderCompose(plan({ postgres: false, redis: false }), ctx).content);
    expect(Object.keys(doc.services)).toEqual(["app", "caddy"]);
    expect(doc.services.app.depends_on).toBeUndefined();
  });
});

describe("renderCaddyfile", () => {
  it("serves the domain (and www) with HSTS and the ACME email", () => {
    const content = renderCaddyfile(plan({ domain: "shop.example.com", www: true }), ctx).content;
    expect(content).toContain("shop.example.com, www.shop.example.com {");
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
    const rollback = steps("deploy").find((s) => s.if === "failure()");
    expect(rollback?.run).toContain(".env.previous");
  });

  it("checks health on the server IP before a domain exists", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression, not a JS template.
    expect(healthUrl(plan())).toBe("http://${{ secrets.OPSCREW_HOST }}/api/health");
  });

  it("scans the image only when enabled", () => {
    expect(withDomain.content).toContain("aquasec/trivy:");
    expect(renderWorkflow(plan({ imageScan: false }), ctx).content).not.toContain("trivy");
  });
});
