import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testServices } from "../__fixtures__/plans";
import {
  cell,
  deployRows,
  externalDatabaseCell,
  renderRunbook,
  runbookHead,
  webOnlyFromCloudflare,
} from "../index";
import type { RenderContext } from "../types";

const IPV4 = "203.0.113.10";
const IPV6 = "2001:db8::1";

function plan(
  o: { domain?: string; proxied?: boolean; postgres?: boolean; backups?: boolean } = {},
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
    services: testServices({ postgres: o.postgres ?? true }),
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
      ? {
          provider: "cloudflare",
          domain: o.domain,
          zone: "example.com",
          proxied: o.proxied ?? true,
        }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
  });
}

const ctx: RenderContext = {
  opscrewVersion: "0.1.0",
  github: { owner: "Acme", repo: "Shop" },
  deploySshPublicKey: "ssh-ed25519 AAAA opscrew-deploy",
  projectId: "shop-0123456789ab",
};

/** The context once the server exists: its addresses from OpsCrew's local state. */
const deployed: RenderContext = { ...ctx, serverIpv4: IPV4, serverIpv6: IPV6 };

describe("renderRunbook", () => {
  it("uses the real domain, SSH command and rollback steps (spec US4 scenario 3)", () => {
    const file = renderRunbook(plan({ domain: "shop.example.com" }), deployed);
    expect(file.path).toBe("opscrew/RUNBOOK.md");
    expect(file.content).toContain("https://shop.example.com");
    expect(file.content).toContain(
      "ssh -i ~/.opscrew/projects/shop-0123456789ab/deploy_key deploy@$(opscrew status --ip)",
    );
    expect(file.content).toContain("## Roll back");
    expect(file.content).toContain("Cloudflare's IP ranges");
    expect(file.content).toContain("ghcr.io/acme/shop");
    expect(file.content).toContain(
      "€7.09 per month (excl. VAT, estimate from Hetzner's price list of 2026-06-15)",
    );
    expect(file.content).toMatchSnapshot();
  });

  it("never writes the server's address behind Cloudflare's proxy", () => {
    const content = renderRunbook(plan({ domain: "shop.example.com" }), deployed).content;
    expect(content).not.toContain(IPV4);
    expect(content).not.toContain(IPV6);
    expect(content).toContain(
      "| IPv4 / IPv6 | kept private behind Cloudflare: `opscrew status` shows them |",
    );
    expect(content).toContain("The server's IP address is not written in this repository");
    expect(content).toContain("`opscrew status --ip`");
    // `npx` users have no `opscrew` on PATH: the runbook gives them a line that works too.
    expect(content).toContain(
      "# without a global install: ssh -i ~/.opscrew/projects/shop-0123456789ab/deploy_key deploy@$(npx opscrew status --ip)",
    );
  });

  it("shows the address when the app is served on it or DNS is not proxied", () => {
    const noDomain = renderRunbook(plan(), deployed).content;
    expect(noDomain).toContain(`| App | http://${IPV4} |`);
    expect(noDomain).toContain(`| IPv4 / IPv6 | ${IPV4} / ${IPV6} |`);
    expect(noDomain).toContain(`deploy_key deploy@${IPV4}`);
    expect(noDomain).not.toContain("opscrew status --ip");
    expect(noDomain).not.toContain("npx opscrew");

    const dnsOnly = renderRunbook(
      plan({ domain: "shop.example.com", proxied: false }),
      deployed,
    ).content;
    expect(dnsOnly).toContain("| App | https://shop.example.com |");
    expect(dnsOnly).toContain(`| IPv4 / IPv6 | ${IPV4} / ${IPV6} |`);
    expect(dnsOnly).toContain(`deploy_key deploy@${IPV4}`);
  });

  it("explains placeholders before the first apply", () => {
    const content = renderRunbook(plan(), { ...ctx, projectId: undefined }).content;
    expect(content).toContain("_(set by `opscrew provision`)_");
    expect(content).toContain("deploy@$(opscrew status --ip)");
    expect(content).toContain("<project-id>");
    expect(content).toContain("plain HTTP on the server IP");
    expect(content).not.toContain("Cloudflare's proxy hides it");
  });

  it("covers backups only when Postgres is self-hosted", () => {
    expect(renderRunbook(plan({ postgres: false }), ctx).content).not.toContain(
      "## Database backups",
    );
    const off = renderRunbook(plan({ backups: false }), ctx).content;
    expect(off).toContain(
      "Automated server backups are **off**. Turn them on with `opscrew design` (they cost extra; it shows the price) or make your own backups:",
    );
    expect(off).not.toContain("20% of the server price");
  });

  it("explains how to check for drift without changing anything", () => {
    const content = renderRunbook(plan(), ctx).content;
    const section = content.slice(content.indexOf("## Check for drift"));
    expect(content).toContain("## Check for drift");
    expect(section).toContain("opscrew drift");
    expect(section).toMatch(/never changes anything/);
    expect(section).toMatch(/refresh/i);
    expect(section).toContain("opscrew/infra/");
  });

  it("explains how to move to another provider, finish the move or abort it", () => {
    // The section's text, with line breaks folded into spaces.
    const moving = (p: DeployPlan) => {
      const content = renderRunbook(p, ctx).content;
      const section = content.slice(
        content.indexOf("## Moving to another provider"),
        content.indexOf("## Check for drift"),
      );
      expect(section).toMatch(/^## Moving to another provider\n\n/);
      return section.replace(/\s+/g, " ");
    };
    const section = moving(plan({ domain: "shop.example.com" }));
    expect(section).toContain("`opscrew retarget --to <provider>`");
    expect(section).toContain("`opscrew retarget --finish`");
    expect(section).toContain("`opscrew retarget --abort`");
    expect(section).toContain("`opscrew retarget --approve <hash>`");
    expect(section).toContain("`opscrew status`");
    expect(section).toContain("switches the Cloudflare DNS records to it.");
    expect(section).toContain("**Maintenance window:**");
    expect(section).toContain("`--allow-downtime`");
    expect(section).toMatch(/database size and the expected downtime/);
    expect(section).toMatch(/old server keeps running until you run `opscrew retarget --finish`/);
    expect(section).toMatch(/both servers are billed until then/);
    expect(section).toMatch(/only\s+before the DNS switch/);
    expect(section).toContain("`--confirm shop`");

    const stateless = moving(plan({ postgres: false }));
    expect(stateless).toContain("**No maintenance window:**");
    expect(stateless).not.toContain("--allow-downtime");
    expect(stateless).toContain("shows you the new server's address");
    expect(stateless).toContain("`--dns-switched`");

    const elsewhere = moving({
      ...plan(),
      dns: { provider: "none", domain: "shop.example.com", proxied: false, www: false },
    });
    expect(elsewhere).toMatch(/DNS records to change at your DNS provider/);
    expect(elsewhere).toContain("`--dns-switched`");
    expect(elsewhere).not.toContain("Cloudflare");

    // Scripts also need --yes for the GitHub secrets, the push and the pull request.
    for (const text of [section, stateless, elsewhere]) {
      expect(text).toMatch(
        /`--yes` approves storing the GitHub deploy secrets, pushing and opening the pull request/,
      );
    }

    // Without managed DNS and with a database, the downtime lasts until the DNS change is live.
    expect(elsewhere).toContain("the downtime lasts for the copy plus your DNS change");
    expect(elsewhere).toContain("lower the TTL of the DNS records beforehand");
    expect(elsewhere).toContain(
      "pass `--allow-downtime --dns-switched` together only when the records are ready",
    );
    const noDomain = moving(plan());
    expect(noDomain).toContain("the downtime lasts for the copy plus the time your users need");
    expect(noDomain).not.toContain("TTL");
    for (const text of [section, stateless]) {
      expect(text).not.toContain("TTL");
      expect(text).not.toContain("plus your DNS change");
    }
  });

  it("explains how to tear the deployment down and what remains", () => {
    const content = renderRunbook(plan({ domain: "shop.example.com" }), ctx).content;
    const section = content.slice(content.indexOf("## Tear it down"));
    expect(content).toContain("## Tear it down");
    expect(section).toContain("opscrew destroy");
    expect(section).toContain("--confirm shop");
    expect(section).toContain("--no-snapshot");
    expect(section).toMatch(/backups are deleted\s+together\s+with\s+the\s+server/);
    expect(section).toMatch(/snapshot is the only copy/);
    expect(section).toMatch(/per GB per month/);
    expect(section).toContain("https://www.hetzner.com/cloud");
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
    const a = renderRunbook(plan({ domain: "shop.example.com" }), ctx).content;
    expect(renderRunbook(plan({ domain: "shop.example.com" }), ctx).content).toBe(a);
    expect(a).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
  });
});

describe("the runbook's shared rows", () => {
  it("names external services in the Database row, or None", () => {
    const external = plan({ postgres: false });
    expect(externalDatabaseCell(external)).toBe("External: supabase (not managed by OpsCrew)");
    expect(renderRunbook(external, ctx).content).toContain(
      "| Database | External: supabase (not managed by OpsCrew) |",
    );
    expect(externalDatabaseCell({ ...external, externalServices: [] })).toBe("None");
  });

  it("shows live prices that include VAT without a price list date", () => {
    const base = plan();
    const live: DeployPlan = {
      ...base,
      cost: { ...base.cost, pricesIncludeVat: true, source: "live" },
    };
    expect(renderRunbook(live, ctx).content).toContain("| Cost | €7.09 per month (incl. VAT) |");
  });

  it("exports the head and the deploy rows, with pipes escaped in cells", () => {
    const p = plan({ domain: "shop.example.com" });
    expect(cell("a | b")).toBe("a \\| b");
    expect(cell("one\ntwo\r\nthree")).toBe("one two three");
    expect(runbookHead(p, { opscrewVersion: "0.1.0" }, "https://shop.example.com")).toEqual([
      "# Runbook: shop",
      "",
      "Generated by OpsCrew 0.1.0 from `opscrew/plan.yaml`. Run `opscrew verify` to refresh it.",
      "",
      "## At a glance",
      "",
      "| | |",
      "|---|---|",
      "| App | https://shop.example.com |",
      "| Health check | `/api/health` |",
    ]);
    expect(deployRows(p, "Acme/Shop")).toEqual([
      `| Deploys | every push to \`main\` runs \`${p.cicd.workflowPath}\` |`,
      "| Image | `ghcr.io/acme/shop` (GitHub Container Registry) |",
    ]);
  });

  it("keeps a branch with a pipe inside the Deploys cell", () => {
    const p = plan();
    const piped: DeployPlan = { ...p, cicd: { ...p.cicd, branch: "release|2026" } };
    expect(deployRows(piped, "acme/shop")[0]).toBe(
      `| Deploys | every push to \`release\\|2026\` runs \`${p.cicd.workflowPath}\` |`,
    );
  });

  it("exports whether web traffic may come only from Cloudflare", () => {
    const proxied = plan({ domain: "shop.example.com" });
    const only: DeployPlan = {
      ...proxied,
      security: { ...proxied.security, httpAllowedFrom: "cloudflare" },
    };
    expect(webOnlyFromCloudflare(only)).toBe(true);
    expect(webOnlyFromCloudflare({ ...only, dns: { ...only.dns, proxied: false } })).toBe(false);
  });
});
