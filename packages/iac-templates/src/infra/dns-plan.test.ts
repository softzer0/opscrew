import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { detectEngines } from "@opscrew/iac-engine";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it, type TestContext } from "vitest";
import { testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import { renderInfra, tfvars } from "./index";

describe("cloudflare-dns module", () => {
  const main = MODULE_FILES["cloudflare-dns/main.tf"] ?? "";

  it("creates the AAAA record only when asked", () => {
    expect(main).toMatch(
      /resource "cloudflare_dns_record" "aaaa" \{\n {2}count {3}= var\.ipv6_record \? 1 : 0\n/,
    );
    expect(main).not.toContain("moved {");
    const variables = MODULE_FILES["cloudflare-dns/variables.tf"] ?? "";
    expect(variables).toMatch(/variable "ipv6_record" \{[^}]*default {5}= true\n\}/);
  });

  it("writes CAA at the domain, one per issuer, only when not proxied", () => {
    expect(main).toContain(
      [
        'resource "cloudflare_dns_record" "caa" {',
        "  for_each = var.proxied ? toset([]) : toset(var.caa_issuers)",
        "  zone_id  = var.zone_id",
        "  name     = var.domain",
        '  type     = "CAA"',
        "  ttl      = 1",
        "  data = {",
        "    flags = 0",
        '    tag   = "issue"',
        "    value = each.value",
        "  }",
        '  comment = "Managed by OpsCrew"',
        "}",
      ].join("\n"),
    );
    const variables = MODULE_FILES["cloudflare-dns/variables.tf"] ?? "";
    expect(variables).toMatch(
      /variable "caa_issuers" \{[^}]*type {8}= list\(string\)\n {2}default {5}= \[\]\n\}/,
    );
  });

  it("names the authorities of the plan's edge, and none for an app on the zone apex", () => {
    const issuers = (plan: DeployPlan) =>
      tfvars(plan, testContext({ cloudflare: testCloudflare() })).caa_issuers;
    const withEdge = (plan: DeployPlan, edge: "caddy" | "nginx") =>
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge } });
    for (const provider of ["hetzner", "digitalocean", "own"] as const) {
      const plan = testPlan({ provider, domain: "shop.example.com" });
      expect(issuers(plan)).toEqual(["letsencrypt.org", "sectigo.com"]);
      expect(issuers(withEdge(plan, "nginx"))).toEqual(["letsencrypt.org"]);
      const apex = testPlan({ provider, domain: "example.com" });
      expect(issuers(apex)).toEqual([]);
      expect(issuers(withEdge(apex, "nginx"))).toEqual([]);
    }
    const root = renderInfra(
      testPlan({ domain: "shop.example.com" }),
      testContext({ cloudflare: testCloudflare() }),
    ).find((f) => f.path.endsWith("prod/main.tf"))?.content;
    expect(root).toMatch(/module "dns" \{[^}]*caa_issuers += var\.caa_issuers\n/);
  });

  it("is always on for OpsCrew-created servers (their roots do not pass ipv6_record)", () => {
    for (const provider of ["hetzner", "digitalocean"] as const) {
      const files = renderInfra(
        testPlan({ provider, domain: "shop.example.com" }),
        testContext({ cloudflare: testCloudflare() }),
      );
      const root = files.find((f) => f.path.endsWith("prod/main.tf"))?.content ?? "";
      expect(root).not.toContain("ipv6_record");
    }
  });
});

// Plans an own-server root offline (fake token, -refresh=false, local state) to show what the
// engines would do. Needs the cloudflare provider from the registry, so only with OPSCREW_IT=1.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
// Not a credential: a placeholder of the right shape, so the provider configures without a network.
const PLACEHOLDER_TOKEN = "0".repeat(40);

describe.skipIf(!runIt)("own-server DNS plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    const bin = engine?.binary ?? name;

    /** DNS only by default; `filtered` serves behind Cloudflare's proxy with the web filter. */
    async function plan(
      test: TestContext,
      vars: Record<string, string>,
      filtered = false,
    ): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), `opscrew-dns-plan-${name}-`));
      const proxied = testPlan({ provider: "own", domain: "shop.example.com" });
      const deployPlan = filtered
        ? proxied
        : DeployPlanSchema.parse({
            ...proxied,
            dns: { ...proxied.dns, proxied: false },
            security: { ...proxied.security, httpAllowedFrom: "any" },
          });
      const files = renderInfra(deployPlan, testContext({ cloudflare: testCloudflare() }));
      for (const file of files) {
        const target = join(root, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      const statePath = join(root, "state.tfstate");
      const runner = new NodeCommandRunner();
      const cwd = join(root, "opscrew/infra/prod");
      const init = await runner.run(
        bin,
        ["init", "-input=false", "-no-color", `-backend-config=path=${statePath}`],
        { cwd },
      );
      if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
        test.skip(`${name} could not download the providers (network needed)`);
      }
      expect(init.exitCode, init.stdout + init.stderr).toBe(0);
      const env: Record<string, string | undefined> = {
        ...process.env,
        CLOUDFLARE_API_TOKEN: PLACEHOLDER_TOKEN,
      };
      for (const [key, value] of Object.entries(vars)) env[`TF_VAR_${key}`] = value;
      const result = await runner.run(
        bin,
        ["plan", "-refresh=false", "-input=false", "-lock=false", "-no-color"],
        { cwd, env },
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      return result.stdout;
    }

    it.skipIf(!engine)(
      `gives an IPv4-only own server no AAAA record (${name})`,
      async (test) => {
        const out = await plan(test, { server_ipv4: "203.0.113.10" });
        expect(out).toContain("module.dns.cloudflare_dns_record.a will be created");
        expect(out).not.toContain("cloudflare_dns_record.aaaa");
      },
      300_000,
    );

    it.skipIf(!engine)(
      `writes Caddy's CAA records at the DNS-only domain (${name})`,
      async (test) => {
        const out = await plan(test, { server_ipv4: "203.0.113.10" });
        for (const issuer of ["letsencrypt.org", "sectigo.com"]) {
          expect(out).toContain(
            `module.dns.cloudflare_dns_record.caa["${issuer}"] will be created`,
          );
        }
      },
      300_000,
    );

    it.skipIf(!engine)(
      `creates the AAAA record when the server has IPv6 (${name})`,
      async (test) => {
        const out = await plan(test, { server_ipv4: "203.0.113.10", server_ipv6: "2001:db8::10" });
        expect(out).toContain("module.dns.cloudflare_dns_record.aaaa[0] will be created");
      },
      300_000,
    );

    it.skipIf(!engine)(
      `gives no AAAA record behind the web filter, also with IPv6 (${name})`,
      async (test) => {
        const out = await plan(
          test,
          { server_ipv4: "203.0.113.10", server_ipv6: "2001:db8::10" },
          true,
        );
        expect(out).toContain("module.dns.cloudflare_dns_record.a will be created");
        expect(out).not.toContain("cloudflare_dns_record.aaaa");
        expect(out).not.toContain("cloudflare_dns_record.caa");
      },
      300_000,
    );
  }
});
