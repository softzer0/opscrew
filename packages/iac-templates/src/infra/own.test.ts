// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation in expected file contents, not JavaScript templates.
import { checkDialect } from "@opscrew/iac-engine";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testTarget } from "../__fixtures__/layouts";
import {
  ACCOUNT_ID,
  ONE_TIME_PIN_ID,
  testCloudflare,
  testCloudflareAccount,
  testContext,
  testPlan,
} from "../__fixtures__/plans";
import type { RenderContext, RenderedFile } from "../types";
import { moveLayout, renderInfra, tfvars } from "./index";

// Documentation addresses (RFC 5737 / RFC 3849): what the CLI would pass as TF_VAR_*.
const SERVER_IPV4 = "203.0.113.10";
const SERVER_IPV6 = "2001:db8::10";

const PORTAINER = {
  access: "subdomain",
  hostname: "portainer.example.com",
  allowedEmails: ["ops@example.com"],
} as const;

function file(files: readonly RenderedFile[], suffix: string): string {
  const found = files.find((f) => f.path.endsWith(suffix));
  if (!found) throw new Error(`no ${suffix} in ${files.map((f) => f.path).join(", ")}`);
  return found.content;
}

/** Context with the server's addresses known locally (the runbook gets them; HCL must not). */
function ownContext(overrides: Partial<RenderContext> = {}): RenderContext {
  return testContext({ serverIpv4: SERVER_IPV4, serverIpv6: SERVER_IPV6, ...overrides });
}

/** The plan served directly with DNS only (not proxied, web traffic from anywhere). */
function dnsOnlyPlan(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    dns: { ...plan.dns, proxied: false },
    security: { ...plan.security, httpAllowedFrom: "any" },
  });
}

function expectNoAddress(files: readonly RenderedFile[]): void {
  for (const f of files) {
    expect(f.content, f.path).not.toContain(SERVER_IPV4);
    expect(f.content, f.path).not.toContain(SERVER_IPV6);
  }
}

describe("renderInfra for a server the user owns (public)", () => {
  const plan = testPlan({ provider: "own", domain: "example.com", www: true });
  const files = renderInfra(plan, ownContext({ cloudflare: testCloudflare() }));

  it("renders no server resources and vendors only the DNS module", () => {
    expect(files.map((f) => f.path)).toEqual([
      "opscrew/infra/prod/versions.tf",
      "opscrew/infra/prod/main.tf",
      "opscrew/infra/prod/variables.tf",
      "opscrew/infra/prod/outputs.tf",
      "opscrew/infra/prod/terraform.tfvars.json",
      "opscrew/infra/modules/cloudflare-dns/main.tf",
      "opscrew/infra/modules/cloudflare-dns/outputs.tf",
      "opscrew/infra/modules/cloudflare-dns/variables.tf",
      "opscrew/infra/modules/cloudflare-dns/versions.tf",
    ]);
    const main = file(files, "prod/main.tf");
    expect(main).not.toMatch(/module "server|hcloud|digitalocean/);
    expect(file(files, "prod/versions.tf")).not.toMatch(/hcloud|digitalocean/);
    expect(main).toMatch(/^ {2}ipv4 +=\s*var\.server_ipv4$/m);
    expect(main).toMatch(/^ {2}ipv6 +=\s*var\.server_ipv6$/m);
    // Behind OpsCrew's web filter (proxied, the default here) the site is published on IPv4
    // only: never an AAAA record.
    expect(main).toMatch(/^ {2}ipv6_record +=\s*false$/m);
    // DNS only: an IPv4-only server (no TF_VAR_server_ipv6) gets no AAAA record, known when
    // planning; the file is exactly what it was before the web filter existed.
    const dnsOnly = file(
      renderInfra(dnsOnlyPlan(plan), ownContext({ cloudflare: testCloudflare() })),
      "prod/main.tf",
    );
    expect(dnsOnly).toMatch(/^ {2}ipv6_record +=\s*var\.server_ipv6 != null$/m);
    expect(dnsOnly).toMatchSnapshot("main.tf");
    expect(main).toEqual(
      dnsOnly.replace("  ipv6_record = var.server_ipv6 != null", "  ipv6_record = false"),
    );
    expect(file(files, "prod/variables.tf")).toMatchSnapshot("variables.tf");
    expect(file(files, "prod/outputs.tf")).toMatchSnapshot("outputs.tf");
    expect(file(files, "prod/versions.tf")).toMatchSnapshot("versions.tf");
  });

  it("declares the address variables (IPv6 optional) and never writes them to tfvars", () => {
    const variables = file(files, "prod/variables.tf");
    const block = (name: string) =>
      new RegExp(`variable "${name}" \\{[^}]*\\}`).exec(variables)?.[0] ?? "";
    expect(block("server_ipv4")).toContain("type        = string");
    expect(block("server_ipv4")).not.toContain("default");
    expect(block("server_ipv6")).toContain("type        = string");
    expect(block("server_ipv6")).toContain("default     = null");
    const values = JSON.parse(file(files, "terraform.tfvars.json"));
    expect(values).toEqual({
      app_name: "shop",
      domain: "example.com",
      cloudflare_zone_id: "0123456789abcdef0123456789abcdef",
      proxied: true,
      www: true,
    });
    expect(file(files, "terraform.tfvars.json")).not.toMatch(/server_ipv|ipv4|ipv6/);
    expect(tfvars(plan, ownContext({ cloudflare: testCloudflare() }))).toEqual(values);
    expectNoAddress(files);
  });

  it("keeps the outputs existing readers use: server_ipv4, server_ipv6, url and servers", () => {
    const outputs = file(files, "prod/outputs.tf");
    expect(outputs).toContain('output "server_ipv4" {\n  value = var.server_ipv4\n}');
    expect(outputs).toContain('output "server_ipv6" {\n  value = var.server_ipv6\n}');
    expect(outputs).toContain('output "url" {\n  value = module.dns.url\n}');
    expect(outputs).toMatch(/output "servers" \{\s+value = \{\s+own = \{/);
    expect(outputs).not.toMatch(/server_id|server_name/);
  });

  it("renders an empty root without a domain, with the URL on the address", () => {
    const bare = renderInfra(testPlan({ provider: "own" }), ownContext());
    expect(bare.map((f) => f.path.replace("opscrew/infra/prod/", ""))).toEqual([
      "versions.tf",
      "main.tf",
      "variables.tf",
      "outputs.tf",
      "terraform.tfvars.json",
    ]);
    expect(file(bare, "versions.tf")).not.toContain("cloudflare");
    expect(file(bare, "main.tf")).not.toMatch(/^(?:module|provider|resource) /m);
    expect(file(bare, "outputs.tf")).toContain(
      'output "url" {\n  value = "http://${var.server_ipv4}"\n}',
    );
    expect(JSON.parse(file(bare, "terraform.tfvars.json"))).toEqual({ app_name: "shop" });
    expectNoAddress(bare);
  });

  it("is dialect-neutral and deterministic", () => {
    const tf = files.filter((f) => f.path.endsWith(".tf"));
    expect(checkDialect(tf)).toEqual([]);
    expect(renderInfra(plan, ownContext({ cloudflare: testCloudflare() }))).toEqual(files);
  });
});

describe("renderInfra for a server the user owns (tunnel)", () => {
  const plan = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });
  const context = ownContext({ cloudflare: testCloudflareAccount(), sshPort: 2222 });
  const files = renderInfra(plan, context);

  it("serves the app and SSH through the tunnel and Access, without DNS records to an address", () => {
    expect(files.map((f) => f.path).filter((p) => p.includes("/modules/"))).toEqual([
      "opscrew/infra/modules/cloudflare-access/main.tf",
      "opscrew/infra/modules/cloudflare-access/outputs.tf",
      "opscrew/infra/modules/cloudflare-access/variables.tf",
      "opscrew/infra/modules/cloudflare-access/versions.tf",
      "opscrew/infra/modules/cloudflare-tunnel/main.tf",
      "opscrew/infra/modules/cloudflare-tunnel/outputs.tf",
      "opscrew/infra/modules/cloudflare-tunnel/variables.tf",
      "opscrew/infra/modules/cloudflare-tunnel/versions.tf",
    ]);
    const main = file(files, "prod/main.tf");
    expect(main).not.toMatch(/module "dns"|module "server|server_ipv/);
    expect(main).toContain('{ hostname = var.domain, service = "http://localhost:18080" },');
    expect(main).toContain(
      '{ hostname = var.ssh_hostname, service = "ssh://localhost:${var.ssh_port}" },',
    );
    expect(main).not.toContain("portainer");
    expect(main).toMatchSnapshot("main.tf");
    expect(file(files, "prod/variables.tf")).toMatchSnapshot("variables.tf");
    expect(file(files, "prod/outputs.tf")).toMatchSnapshot("outputs.tf");
  });

  it("writes the SSH hostname, sshd's port and the account to tfvars, never an address", () => {
    expect(JSON.parse(file(files, "terraform.tfvars.json"))).toEqual({
      app_name: "shop",
      domain: "shop.example.com",
      cloudflare_zone_id: "0123456789abcdef0123456789abcdef",
      cloudflare_account_id: ACCOUNT_ID,
      ssh_hostname: "ssh-shop.example.com",
      ssh_port: 2222,
    });
    expect(file(files, "prod/variables.tf")).not.toContain("server_ipv");
    expectNoAddress(files);
    const defaultPort = tfvars(plan, ownContext({ cloudflare: testCloudflareAccount() }));
    expect(defaultPort.ssh_port).toBe(22);
  });

  it("marks the tunnel token and the service token as sensitive outputs", () => {
    const outputs = file(files, "prod/outputs.tf");
    for (const name of [
      "tunnel_token",
      "deploy_service_token_client_id",
      "deploy_service_token_client_secret",
    ]) {
      expect(outputs).toMatch(
        new RegExp(`output "${name}" \\{\\n {2}value +=[^\\n]+\\n {2}sensitive = true\\n\\}`),
      );
    }
    expect(outputs).toContain('output "ssh_hostname" {\n  value = var.ssh_hostname\n}');
    expect(outputs).toContain('output "tunnel_id" {\n  value = module.tunnel.tunnel_id\n}');
    expect(outputs).not.toContain("cloudflare_rulesets");
  });

  it("routes www through the tunnel", () => {
    const www = renderInfra(
      testPlan({ provider: "own", access: "tunnel", domain: "example.com", www: true }),
      context,
    );
    const main = file(www, "prod/main.tf");
    expect(main).toContain(
      '{ hostname = "www.${var.domain}", service = "http://localhost:18080" },',
    );
  });

  it("adds Portainer behind Access with the listed emails when opted in", () => {
    const withPortainer = renderInfra(
      testPlan({
        provider: "own",
        access: "tunnel",
        domain: "shop.example.com",
        portainer: PORTAINER,
      }),
      ownContext({ cloudflare: testCloudflareAccount() }),
    );
    const main = file(withPortainer, "prod/main.tf");
    expect(main).toContain(
      '{ hostname = var.portainer_hostname, service = "https://localhost:9443", no_tls_verify = true },',
    );
    expect(main).toMatchSnapshot("main.tf with Portainer");
    expect(JSON.parse(file(withPortainer, "terraform.tfvars.json"))).toMatchObject({
      portainer_hostname: "portainer.example.com",
      portainer_allowed_emails: ["ops@example.com"],
      one_time_pin_identity_provider_id: ONE_TIME_PIN_ID,
    });
    expect(file(withPortainer, "prod/outputs.tf")).toContain(
      'output "portainer_url" {\n  value = "https://${var.portainer_hostname}"\n}',
    );
  });

  it("takes the account's one-time PIN login method only for Portainer, and no organization", () => {
    const sshOnly = renderInfra(plan, ownContext({ cloudflare: testCloudflareAccount() }));
    const main = file(sshOnly, "prod/main.tf");
    expect(main).not.toMatch(/organization|one_time_pin|portainer/);
    expect(file(sshOnly, "prod/variables.tf")).not.toMatch(/organization|one_time_pin/);
    expect(JSON.parse(file(sshOnly, "terraform.tfvars.json"))).not.toHaveProperty(
      "one_time_pin_identity_provider_id",
    );

    const withPortainer = renderInfra(
      testPlan({
        provider: "own",
        access: "tunnel",
        domain: "shop.example.com",
        portainer: PORTAINER,
      }),
      ownContext({ cloudflare: testCloudflareAccount() }),
    );
    const portainerMain = file(withPortainer, "prod/main.tf");
    expect(portainerMain).not.toContain("organization");
    expect(portainerMain).toMatch(
      /^ {2}one_time_pin_identity_provider_id +=\s*var\.one_time_pin_identity_provider_id$/m,
    );
    // A plain required input: no default that would let the module make its own.
    const pinVariable =
      /variable "one_time_pin_identity_provider_id" \{[^}]*\}/.exec(
        file(withPortainer, "prod/variables.tf"),
      )?.[0] ?? "";
    expect(pinVariable).toContain("type        = string");
    expect(pinVariable).not.toContain("default");
  });

  it("creates every Access application before the tunnel's routes and DNS records", () => {
    for (const rendered of [
      files,
      renderInfra(
        testPlan({ domain: "shop.example.com", portainer: PORTAINER }),
        testContext({ cloudflare: testCloudflareAccount() }),
      ),
    ]) {
      const main = file(rendered, "prod/main.tf");
      const tunnelBlock = /module "tunnel" \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
      expect(tunnelBlock).toContain("  depends_on = [module.access]");
      const accessBlock = /module "access" \{[\s\S]*?\n\}/.exec(main)?.[0] ?? "";
      expect(accessBlock).not.toContain("module.tunnel");
    }
  });

  it("stops plainly without the one-time PIN login method Portainer's Access needs", () => {
    const withPortainer = testPlan({
      provider: "own",
      access: "tunnel",
      domain: "shop.example.com",
      portainer: PORTAINER,
    });
    let error: unknown;
    try {
      renderInfra(
        withPortainer,
        ownContext({
          cloudflare: testCloudflareAccount({ oneTimePinIdentityProviderId: undefined }),
        }),
      );
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("one-time PIN login method"),
      hint: expect.stringContaining(
        "Run `opscrew provision` again: it sets up the Cloudflare Zero Trust login",
      ),
    });
  });

  it("stops with plain errors without a Cloudflare domain or account id", () => {
    // The plan schema refuses this; the renderer still stops plainly on an unchecked plan.
    const noDomain = { ...testPlan({ provider: "own" }), target: plan.target };
    expect(() => renderInfra(noDomain, ownContext())).toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("needs a domain on your Cloudflare account"),
      }),
    );
    expect(() => renderInfra(plan, ownContext({ cloudflare: testCloudflare() }))).toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("Cloudflare account id"),
      }),
    );
  });

  it("is dialect-neutral", () => {
    expect(checkDialect(files.filter((f) => f.path.endsWith(".tf")))).toEqual([]);
  });
});

describe("renderInfra with Portainer on an OpsCrew-created server", () => {
  for (const provider of ["hetzner", "digitalocean"] as const) {
    it(`leaves the ${provider} root untouched for local-only Portainer`, () => {
      const context = testContext({ cloudflare: testCloudflareAccount() });
      const plain = renderInfra(testPlan({ provider, domain: "shop.example.com" }), context);
      const local = renderInfra(
        testPlan({ provider, domain: "shop.example.com", portainer: { access: "local" } }),
        context,
      );
      expect(local).toEqual(plain);
    });

    it(`appends the tunnel and Access for a Portainer subdomain on ${provider}`, () => {
      const context = testContext({ cloudflare: testCloudflareAccount() });
      const plain = renderInfra(testPlan({ provider, domain: "shop.example.com" }), context);
      const files = renderInfra(
        testPlan({ provider, domain: "shop.example.com", portainer: PORTAINER }),
        context,
      );
      for (const name of ["main.tf", "variables.tf", "outputs.tf"]) {
        const before = file(plain, `prod/${name}`);
        const after = file(files, `prod/${name}`);
        expect(after.startsWith(before.replace(/\n$/, ""))).toBe(true);
      }
      const main = file(files, "prod/main.tf");
      expect(main).toContain('module "tunnel" {');
      expect(main).not.toMatch(/ssh_hostname|localhost:18080/);
      expect(file(files, "prod/outputs.tf")).toContain('output "tunnel_token" {');
      expect(files.some((f) => f.path.endsWith("modules/cloudflare-access/main.tf"))).toBe(true);
      expect(checkDialect(files.filter((f) => f.path.endsWith(".tf")))).toEqual([]);
    });
  }
});

describe("renderInfra move layouts", () => {
  it("refuses a move that involves a server the user owns", () => {
    const own = testPlan({ provider: "own" }).target;
    const refusal = expect.objectContaining({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("not to a server you already own"),
    });
    expect(() => moveLayout("both", testTarget("hetzner"), own)).toThrow(refusal);
    const layout = moveLayout("finish", testTarget("digitalocean"), testTarget("hetzner"));
    expect(() => renderInfra(testPlan({ provider: "own" }), testContext({ layout }))).toThrow(
      refusal,
    );
  });
});
