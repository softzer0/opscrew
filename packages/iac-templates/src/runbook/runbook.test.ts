import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { RenderContext } from "../types";
import { renderRunbook } from "./index";

function plan(
  o: { domain?: string; ip?: string; postgres?: boolean; backups?: boolean } = {},
): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: o.backups ?? true,
    },
    services: { postgres: o.postgres ?? true, redis: false },
    externalServices: o.postgres === false ? ["supabase"] : [],
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
      ? { provider: "cloudflare", domain: o.domain, zone: "example.com", proxied: true }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
    deployment: o.ip ? { serverIpv4: o.ip, serverIpv6: "2a01:4f8::1" } : {},
  });
}

const ctx: RenderContext = {
  opscrewVersion: "0.1.0",
  github: { owner: "Acme", repo: "Shop" },
  deploySshPublicKey: "ssh-ed25519 AAAA opscrew-deploy",
  projectId: "shop-0123456789ab",
};

describe("renderRunbook", () => {
  it("uses the real domain, IP, SSH command and rollback steps (spec US4 scenario 3)", () => {
    const file = renderRunbook(plan({ domain: "shop.example.com", ip: "203.0.113.10" }), ctx);
    expect(file.path).toBe("opscrew/RUNBOOK.md");
    expect(file.content).toContain("https://shop.example.com");
    expect(file.content).toContain(
      "ssh -i ~/.opscrew/projects/shop-0123456789ab/deploy_key deploy@203.0.113.10",
    );
    expect(file.content).toContain("## Roll back");
    expect(file.content).toContain("Cloudflare's IP ranges");
    expect(file.content).toContain("ghcr.io/acme/shop");
    expect(file.content).toContain(
      "€7.09 per month (excl. VAT, estimate from Hetzner's price list of 2026-06-15)",
    );
    expect(file.content).toMatchSnapshot();
  });

  it("explains placeholders before the first apply", () => {
    const content = renderRunbook(plan(), { ...ctx, projectId: undefined }).content;
    expect(content).toContain("_(set by `opscrew provision`)_");
    expect(content).toContain("deploy@<server-ip>");
    expect(content).toContain("<project-id>");
    expect(content).toContain("plain HTTP on the server IP");
  });

  it("covers backups only when Postgres is self-hosted", () => {
    expect(renderRunbook(plan({ postgres: false }), ctx).content).not.toContain(
      "## Database backups",
    );
    expect(renderRunbook(plan({ backups: false }), ctx).content).toContain(
      "Automated server backups are **off**",
    );
  });

  it("explains how to check for drift without changing anything", () => {
    const content = renderRunbook(plan({ ip: "203.0.113.10" }), ctx).content;
    const section = content.slice(content.indexOf("## Check for drift"));
    expect(content).toContain("## Check for drift");
    expect(section).toContain("opscrew drift");
    expect(section).toMatch(/never changes anything/);
    expect(section).toMatch(/refresh/i);
    expect(section).toContain("opscrew/infra/");
  });

  it("explains how to tear the deployment down and what remains", () => {
    const content = renderRunbook(
      plan({ domain: "shop.example.com", ip: "203.0.113.10" }),
      ctx,
    ).content;
    const section = content.slice(content.indexOf("## Tear it down"));
    expect(content).toContain("## Tear it down");
    expect(section).toContain("opscrew destroy");
    expect(section).toContain("--confirm shop");
    expect(section).toContain("--no-snapshot");
    expect(section).toMatch(/backups are deleted\s+together\s+with\s+the\s+server/);
    expect(section).toMatch(/snapshot is the only copy/);
    expect(section).toMatch(/per GB per month/);
    expect(section).toContain("ghcr.io/acme/shop");
    expect(section).toContain(".github/workflows/opscrew-deploy.yml");
    expect(section).toMatch(/deploy secrets/);
    expect(section).toContain("Cloudflare DNS records");
    // No data on the server: no snapshot unless asked for.
    const stateless = renderRunbook(plan({ postgres: false, backups: false }), ctx).content;
    const plain = stateless.slice(stateless.indexOf("## Tear it down"));
    expect(plain).toMatch(/does not take a\s+snapshot/);
    expect(plain).toMatch(/backups would be deleted\s+together\s+with\s+the\s+server/);
    expect(plain).not.toContain("Cloudflare DNS records");
  });

  it("contains no absolute paths and is deterministic", () => {
    const a = renderRunbook(plan({ domain: "shop.example.com", ip: "203.0.113.10" }), ctx).content;
    expect(
      renderRunbook(plan({ domain: "shop.example.com", ip: "203.0.113.10" }), ctx).content,
    ).toBe(a);
    expect(a).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });
});
