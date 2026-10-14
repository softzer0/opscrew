import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { detectEngines } from "@opscrew/iac-engine";
import { describe, expect, it, type TestContext } from "vitest";
import { testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import { renderInfra } from "./index";

describe("cloudflare-dns module", () => {
  const main = MODULE_FILES["cloudflare-dns/main.tf"] ?? "";

  it("creates the AAAA record only when asked, keeping the record already in the state", () => {
    expect(main).toMatch(
      /resource "cloudflare_dns_record" "aaaa" \{\n {2}count {3}= var\.ipv6_record \? 1 : 0\n/,
    );
    expect(main).toContain(
      "moved {\n  from = cloudflare_dns_record.aaaa\n  to   = cloudflare_dns_record.aaaa[0]\n}",
    );
    const variables = MODULE_FILES["cloudflare-dns/variables.tf"] ?? "";
    expect(variables).toMatch(/variable "ipv6_record" \{[^}]*default {5}= true\n\}/);
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

/** A state with the AAAA record at the address it had before the record became optional. */
function legacyState(): string {
  const record = (name: string, type: string, content: string) => ({
    module: "module.dns",
    mode: "managed",
    type: "cloudflare_dns_record",
    name,
    provider: 'provider["registry.opentofu.org/cloudflare/cloudflare"]',
    instances: [
      {
        schema_version: 0,
        attributes: {
          id: `${name}-record-id`,
          zone_id: "0123456789abcdef0123456789abcdef",
          name: "shop.example.com",
          type,
          content,
          ttl: 1,
          proxied: true,
          comment: "Managed by OpsCrew",
        },
      },
    ],
  });
  return JSON.stringify({
    version: 4,
    terraform_version: "1.6.0",
    serial: 1,
    lineage: "00000000-0000-0000-0000-000000000000",
    outputs: {},
    resources: [record("a", "A", "203.0.113.10"), record("aaaa", "AAAA", "2001:db8::10")],
  });
}

describe.skipIf(!runIt)("own-server DNS plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    const bin = engine?.binary ?? name;

    async function plan(
      test: TestContext,
      vars: Record<string, string>,
      state?: (registry: string) => string,
    ): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), `opscrew-dns-plan-${name}-`));
      const files = renderInfra(
        testPlan({ provider: "own", domain: "shop.example.com" }),
        testContext({ cloudflare: testCloudflare(false) }),
      );
      for (const file of files) {
        const target = join(root, file.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.content);
      }
      const statePath = join(root, "state.tfstate");
      if (state) {
        const registry = name === "tofu" ? "registry.opentofu.org" : "registry.terraform.io";
        await writeFile(statePath, state(registry));
      }
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
      `creates the AAAA record when the server has IPv6 (${name})`,
      async (test) => {
        const out = await plan(test, { server_ipv4: "203.0.113.10", server_ipv6: "2001:db8::10" });
        expect(out).toContain("module.dns.cloudflare_dns_record.aaaa[0] will be created");
      },
      300_000,
    );

    it.skipIf(!engine)(
      `moves an existing AAAA record to its new address instead of replacing it (${name})`,
      async (test) => {
        const out = await plan(
          test,
          { server_ipv4: "203.0.113.10", server_ipv6: "2001:db8::10" },
          (registry) => legacyState().replaceAll("registry.opentofu.org", registry),
        );
        // The fixture state lacks a few computed attributes, so the engines also plan an in-place
        // update; what matters is that the record keeps its identity at the new address.
        expect(out).toMatch(
          /module\.dns\.cloudflare_dns_record\.aaaa has moved to module\.dns\.cloudflare_dns_record\.aaaa\[0\]|# \(moved from module\.dns\.cloudflare_dns_record\.aaaa\)/,
        );
        expect(out).not.toMatch(
          /aaaa(?:\[0\])? (?:will be created|must be replaced|will be destroyed)/,
        );
      },
      300_000,
    );
  }
});
