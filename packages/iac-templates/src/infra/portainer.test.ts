// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation in expected file contents, not JavaScript templates.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { checkDialect, detectEngines } from "@opscrew/iac-engine";
import { describe, expect, it, type TestContext } from "vitest";
import { testTarget } from "../__fixtures__/layouts";
import { testCloudflare, testCloudflareAccount, testContext } from "../__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import type { RenderContext, RenderedFile } from "../types";
import {
  moveLayout,
  PORTAINER_WEBHOOK_PATH,
  portainerWebhookHostname,
  renderInfra,
  tfvars,
} from "./index";

// A documentation address (RFC 5737): what the CLI would pass as TF_VAR_portainer_origin.
const PORTAINER_ORIGIN = "https://192.0.2.44:9443";

function file(files: readonly RenderedFile[], suffix: string): string {
  const found = files.find((f) => f.path.endsWith(suffix));
  if (!found) throw new Error(`no ${suffix} in ${files.map((f) => f.path).join(", ")}`);
  return found.content;
}

const paths = (files: readonly RenderedFile[]) => files.map((f) => f.path);
const accountCtx = (overrides: Partial<RenderContext> = {}) =>
  testContext({ cloudflare: testCloudflareAccount(), ...overrides });
const rootFiles = (files: readonly RenderedFile[]) =>
  Object.fromEntries(
    files.filter((f) => f.path.includes("/prod/")).map((f) => [f.path, f.content]),
  );

function expectNoAddress(files: readonly RenderedFile[]): void {
  for (const f of files) {
    expect(f.content, f.path).not.toContain("192.0.2.44");
    expect(f.content, f.path).not.toMatch(/server_ipv[46]/);
  }
}

describe("renderInfra for a Portainer target, web mode tunnel", () => {
  const plan = portainerTestPlan({ web: { mode: "tunnel" }, www: true, domain: "example.com" });
  const files = renderInfra(plan, accountCtx());
  const main = file(files, "prod/main.tf");

  it("serves the app through its own tunnel to Caddy in the stack, with no DNS module or Access", () => {
    expect(paths(files)).toEqual([
      "opscrew/infra/prod/versions.tf",
      "opscrew/infra/prod/main.tf",
      "opscrew/infra/prod/variables.tf",
      "opscrew/infra/prod/outputs.tf",
      "opscrew/infra/prod/terraform.tfvars.json",
      "opscrew/infra/modules/cloudflare-tunnel/main.tf",
      "opscrew/infra/modules/cloudflare-tunnel/outputs.tf",
      "opscrew/infra/modules/cloudflare-tunnel/variables.tf",
      "opscrew/infra/modules/cloudflare-tunnel/versions.tf",
    ]);
    expect(main).toContain('module "tunnel" {');
    expect(main).toContain('  name       = "opscrew-${var.app_name}"');
    expect(main).toContain('    { hostname = var.domain, service = "http://caddy:80" },');
    expect(main).toContain('    { hostname = "www.${var.domain}", service = "http://caddy:80" },');
    expect(main).not.toMatch(
      /module "(dns|access|portainer_tunnel)"|depends_on|hcloud|digitalocean/,
    );
    expect(file(files, "prod/versions.tf")).toContain('source  = "cloudflare/cloudflare"');
  });

  it("outputs the URL, the tunnel id and the connector's token (sensitive)", () => {
    const outputs = file(files, "prod/outputs.tf");
    expect(outputs).toContain('output "url" {\n  value = "https://${var.domain}"\n}');
    expect(outputs).toContain('output "tunnel_id" {\n  value = module.tunnel.tunnel_id\n}');
    expect(outputs).toContain(
      'output "tunnel_token" {\n  value     = module.tunnel.token\n  sensitive = true\n}',
    );
    expect(outputs).not.toContain("cloudflare_rulesets");
  });

  it("writes the account to tfvars, never an address", () => {
    expect(tfvars(plan, accountCtx())).toEqual({
      app_name: "shop",
      domain: "example.com",
      cloudflare_zone_id: testCloudflare().zoneId,
      cloudflare_account_id: testCloudflareAccount().accountId,
    });
    expect(JSON.parse(file(files, "terraform.tfvars.json"))).toEqual(tfvars(plan, accountCtx()));
    expectNoAddress(files);
  });

  it("is dialect-neutral and matches the snapshot", () => {
    expect(checkDialect(files)).toEqual([]);
    expect(rootFiles(files)).toMatchSnapshot();
  });
});

describe("renderInfra for a Portainer target, web modes proxy and caddy", () => {
  for (const web of [{ mode: "proxy", port: 8080 }, { mode: "caddy" }] as const) {
    it(`${web.mode} with the updater: no root at all, OpsCrew creates no DNS record`, () => {
      const plan = portainerTestPlan({ web, proxied: false, www: true, domain: "example.com" });
      // Not even a zone id is needed.
      expect(renderInfra(plan, testContext())).toEqual([]);
      expect(renderInfra(plan, accountCtx())).toEqual([]);
      expect(tfvars(plan, accountCtx())).toEqual({});
    });
  }

  it("without a domain on Cloudflare: no root either", () => {
    for (const plan of [
      portainerTestPlan({ web: { mode: "proxy", port: 8080 }, domain: false }),
      portainerTestPlan({ web: { mode: "caddy" }, dnsProvider: "none" }),
    ]) {
      expect(renderInfra(plan, testContext())).toEqual([]);
      expect(tfvars(plan, testContext())).toEqual({});
      expect(portainerWebhookHostname(plan)).toBeUndefined();
    }
  });
});

describe("renderInfra for a Portainer target, redeploy mode cloudflare", () => {
  const plan = portainerTestPlan({
    web: { mode: "caddy" },
    redeploy: "cloudflare",
    proxied: false,
  });
  const ctx = accountCtx();
  const files = renderInfra(plan, ctx);
  const main = file(files, "prod/main.tf");
  const variables = file(files, "prod/variables.tf");
  const outputs = file(files, "prod/outputs.tf");

  it("serves only the webhook paths of portainer-<app>.<zone> through its own tunnel", () => {
    expect(portainerWebhookHostname(plan)).toBe("portainer-shop.example.com");
    expect(PORTAINER_WEBHOOK_PATH).toBe("^/api/stacks/webhooks/");
    expect(main).toContain('module "portainer_tunnel" {');
    expect(main).toContain('  name       = "opscrew-${var.app_name}-portainer"');
    expect(main).toContain(
      [
        "  routes = [",
        "    {",
        "      hostname      = var.portainer_hostname",
        '      path          = "^/api/stacks/webhooks/"',
        "      service       = var.portainer_origin",
        "      no_tls_verify = true",
        "    },",
        "  ]",
      ].join("\n"),
    );
    expect(main).toContain("  depends_on = [module.access]");
    // Only the tunnel and Access: no DNS records for the app in caddy (or proxy) mode.
    expect(main).not.toMatch(/module "(dns|tunnel)"/);
    expect(paths(files).filter((p) => p.includes("/modules/"))).toEqual([
      "opscrew/infra/modules/cloudflare-access/main.tf",
      "opscrew/infra/modules/cloudflare-access/outputs.tf",
      "opscrew/infra/modules/cloudflare-access/variables.tf",
      "opscrew/infra/modules/cloudflare-access/versions.tf",
      "opscrew/infra/modules/cloudflare-tunnel/main.tf",
      "opscrew/infra/modules/cloudflare-tunnel/outputs.tf",
      "opscrew/infra/modules/cloudflare-tunnel/variables.tf",
      "opscrew/infra/modules/cloudflare-tunnel/versions.tf",
    ]);
  });

  it("puts Access on the whole hostname, named as Portainer's webhook", () => {
    expect(main).toContain('module "access" {');
    // The module's service-token slot: only the deploy workflow's service token gets through.
    expect(main).toContain("  service_hostname = var.portainer_hostname");
    expect(main).toContain('  service_label    = "Portainer webhook"');
    expect(main).toContain("  app_name         = var.app_name");
    expect(main).not.toContain("portainer_allowed_emails");
  });

  it("keeps Portainer's address out of committed files and out of plans (a sensitive variable)", () => {
    expect(variables).toContain(
      'variable "portainer_origin" {\n  description = "Portainer\'s address as the tunnel connector reaches it, for example https://192.168.1.10:9443. OpsCrew passes it as TF_VAR_portainer_origin from .opscrew/server.json; it is never written to a committed file."\n  type        = string\n  sensitive   = true\n}',
    );
    const values = tfvars(plan, ctx);
    expect(values).toEqual({
      app_name: "shop",
      cloudflare_zone_id: testCloudflare().zoneId,
      cloudflare_account_id: testCloudflareAccount().accountId,
      portainer_hostname: "portainer-shop.example.com",
    });
    expect(variables).not.toMatch(/variable "(domain|proxied|www)"|organization|one_time_pin/);
    expectNoAddress(files);
  });

  it("outputs the connector's token and the deploy workflow's service token, all sensitive", () => {
    expect(outputs).toContain(
      'output "portainer_tunnel_token" {\n  value     = module.portainer_tunnel.token\n  sensitive = true\n}',
    );
    expect(outputs).toContain(
      'output "deploy_service_token_client_id" {\n  value     = module.access.ssh_service_token_client_id\n  sensitive = true\n}',
    );
    expect(outputs).toContain(
      'output "deploy_service_token_client_secret" {\n  value     = module.access.ssh_service_token_client_secret\n  sensitive = true\n}',
    );
    expect(outputs).toContain('output "portainer_hostname" {\n  value = var.portainer_hostname\n}');
    expect(outputs).not.toMatch(/output "(tunnel_token|url|cloudflare_rulesets)"/);
  });

  it("with web mode tunnel: two tunnels, the app's and Portainer's", () => {
    const both = portainerTestPlan({ web: { mode: "tunnel" }, redeploy: "cloudflare" });
    const bothFiles = renderInfra(both, ctx);
    const bothMain = file(bothFiles, "prod/main.tf");
    expect(bothMain).toContain('module "tunnel" {');
    expect(bothMain).toContain('module "portainer_tunnel" {');
    expect(bothMain).not.toContain('module "dns"');
    const bothOutputs = file(bothFiles, "prod/outputs.tf");
    expect(bothOutputs).toContain('output "tunnel_token"');
    expect(bothOutputs).toContain('output "portainer_tunnel_token"');
    expect(checkDialect(bothFiles)).toEqual([]);
  });

  it("is dialect-neutral and matches the snapshot", () => {
    expect(checkDialect(files)).toEqual([]);
    expect(rootFiles(files)).toMatchSnapshot();
  });
});

describe("renderInfra for a Portainer target, web mode caddy with the records OpsCrew manages", () => {
  const plan = portainerTestPlan({
    web: { mode: "caddy", records: true },
    www: true,
    proxied: false,
  });
  // The records need the zone only: no tunnel, so no account id.
  const ctx = testContext({ cloudflare: testCloudflare() });
  const files = renderInfra(plan, ctx);
  const main = file(files, "prod/main.tf");

  it("points the app's records at the environment's public address", () => {
    expect(paths(files)).toEqual([
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
    expect(main).toContain(
      [
        'module "dns" {',
        '  source = "../modules/cloudflare-dns"',
        "",
        "  zone_id     = var.cloudflare_zone_id",
        "  domain      = var.domain",
        "  ipv4        = var.server_ipv4",
        "  ipv6        = var.server_ipv6",
        "  ipv6_record = var.server_ipv6 != null",
        "  proxied     = var.proxied",
        "  www         = var.www",
        "  caa_issuers = var.caa_issuers",
        "}",
      ].join("\n"),
    );
    expect(main).not.toMatch(/module "(tunnel|portainer_tunnel|access)"|hcloud|digitalocean/);
    expect(file(files, "prod/outputs.tf")).toBe(
      [
        file(files, "prod/outputs.tf").split("\n\n")[0],
        "",
        'output "url" {',
        "  value = module.dns.url",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("keeps the address out of committed files: TF_VAR_server_ipv4 and TF_VAR_server_ipv6", () => {
    const variables = file(files, "prod/variables.tf");
    expect(variables).toContain(
      'variable "server_ipv4" {\n  description = "Public IPv4 address of your Portainer environment. OpsCrew passes it as TF_VAR_server_ipv4 from .opscrew/server.json; it is never written to a committed file."\n  type        = string\n}',
    );
    expect(variables).toMatch(/variable "server_ipv6" \{\n[^}]*\n {2}default {5}= null\n\}/);
    expect(variables).not.toContain("cloudflare_account_id");
    // Caddy in the app's stack gets the certificates: its authorities in CAA (DNS only).
    expect(tfvars(plan, ctx)).toEqual({
      app_name: "shop",
      domain: "shop.example.com",
      cloudflare_zone_id: testCloudflare().zoneId,
      proxied: false,
      www: true,
      caa_issuers: ["letsencrypt.org", "sectigo.com"],
    });
    expect(main).toContain("TF_VAR_server_ipv4 and TF_VAR_server_ipv6");
  });

  it("adds the webhook's tunnel and Access with redeploy mode cloudflare", () => {
    const both = portainerTestPlan({
      web: { mode: "caddy", records: true },
      redeploy: "cloudflare",
    });
    const bothFiles = renderInfra(both, accountCtx());
    const bothMain = file(bothFiles, "prod/main.tf");
    expect(bothMain).toMatch(/module "dns" \{[^}]*ipv4 += var\.server_ipv4\n/);
    expect(bothMain).toContain('module "portainer_tunnel" {');
    expect(bothMain).toContain('module "access" {');
    expect(file(bothFiles, "prod/outputs.tf")).toContain(
      'output "url" {\n  value = module.dns.url\n}',
    );
    expect(Object.keys(tfvars(both, accountCtx()))).toEqual([
      "app_name",
      "domain",
      "cloudflare_zone_id",
      "proxied",
      "www",
      "caa_issuers",
      "cloudflare_account_id",
      "portainer_hostname",
    ]);
    expect(checkDialect(bothFiles)).toEqual([]);
  });

  it("renders no records while they are the user's, or without a domain on Cloudflare", () => {
    for (const p of [
      portainerTestPlan({ web: { mode: "caddy", records: false } }),
      portainerTestPlan({ web: { mode: "caddy", records: true }, dnsProvider: "none" }),
    ]) {
      expect(renderInfra(p, accountCtx())).toEqual([]);
    }
  });

  it("is dialect-neutral and matches the snapshot", () => {
    expect(checkDialect(files)).toEqual([]);
    expect(rootFiles(files)).toMatchSnapshot();
  });
});

describe("renderInfra for a Portainer target refuses", () => {
  it("a move layout with a Portainer side served through a Cloudflare Tunnel", () => {
    const refusal = expect.objectContaining({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("a Portainer environment without a Cloudflare Tunnel"),
      hint: expect.stringContaining("bug in OpsCrew"),
    });
    for (const plan of [
      portainerTestPlan({ web: { mode: "tunnel" } }),
      portainerTestPlan({ web: { mode: "caddy", records: true }, redeploy: "cloudflare" }),
    ]) {
      expect(() => moveLayout("both", testTarget("hetzner"), plan.target)).toThrow(refusal);
      expect(() => moveLayout("both", plan.target, testTarget("hetzner"))).toThrow(refusal);
    }
  });

  it("records without the Cloudflare zone id", () => {
    const plan = portainerTestPlan({ web: { mode: "caddy", records: true } });
    expect(() => renderInfra(plan, testContext())).toThrow(/Cloudflare zone id is required/);
  });

  it("a tunnel without the Cloudflare zone or account id", () => {
    for (const plan of [
      portainerTestPlan({ web: { mode: "tunnel" } }),
      portainerTestPlan({ web: { mode: "caddy" }, redeploy: "cloudflare" }),
    ]) {
      expect(() => renderInfra(plan, testContext({ cloudflare: testCloudflare() }))).toThrow(
        expect.objectContaining({
          code: "PHASE_PRECONDITION",
          message: expect.stringContaining("Cloudflare account id"),
        }),
      );
      expect(() => renderInfra(plan, testContext())).toThrow(/Cloudflare zone id is required/);
    }
  });
});

// Downloads the cloudflare provider from the registry, so it only runs with OPSCREW_IT=1. Binaries
// come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
// Not a credential: a placeholder of the right shape, so the provider configures without a network.
const PLACEHOLDER_TOKEN = "0".repeat(40);

const validated = {
  "tunnel + updater": () =>
    portainerTestPlan({ web: { mode: "tunnel" }, www: true, domain: "example.com" }),
  "tunnel + cloudflare": () =>
    portainerTestPlan({ web: { mode: "tunnel" }, redeploy: "cloudflare" }),
  "proxy + cloudflare": () =>
    portainerTestPlan({ web: { mode: "proxy", port: 8080 }, redeploy: "cloudflare" }),
  "caddy with records + updater": () =>
    portainerTestPlan({ web: { mode: "caddy", records: true }, www: true, proxied: false }),
  "caddy with records + cloudflare": () =>
    portainerTestPlan({ web: { mode: "caddy", records: true }, redeploy: "cloudflare" }),
};
const validatedContext = () => testContext({ cloudflare: testCloudflareAccount() });

async function write(root: string, files: readonly RenderedFile[]): Promise<string> {
  for (const f of files) {
    const target = join(root, f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content);
  }
  return join(root, "opscrew/infra/prod");
}

describe.skipIf(!runIt)("the Portainer roots validate and plan (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    if (runIt && !engine)
      console.warn(`[iac-templates] skipping ${name}: no usable ${name} binary`);
    const bin = engine?.binary ?? name;
    for (const [label, planFor] of Object.entries(validated)) {
      it.skipIf(!engine)(
        `validates the Portainer root (${label}) with ${name}`,
        async (test: TestContext) => {
          const root = await mkdtemp(join(tmpdir(), `opscrew-portainer-${name}-`));
          const cwd = await write(root, renderInfra(planFor(), validatedContext()));
          const runner = new NodeCommandRunner();
          const init = await runner.run(
            bin,
            ["init", "-backend=false", "-input=false", "-no-color"],
            { cwd },
          );
          if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
            test.skip(`${name} could not download the providers (network needed)`);
          }
          expect(init.exitCode, init.stdout + init.stderr).toBe(0);
          const validate = await runner.run(bin, ["validate", "-no-color"], { cwd });
          expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
          const fmt = await runner.run(bin, ["fmt", "-check", "-recursive", "-no-color", ".."], {
            cwd,
          });
          expect(
            fmt.exitCode,
            `not formatted as ${name} fmt writes it:\n${fmt.stdout}${fmt.stderr}`,
          ).toBe(0);
        },
        300_000,
      );
    }

    // Plans offline (placeholder token, local state, nothing refreshed): only the webhook paths
    // are routed, Access carries the webhook's name, and Portainer's address (a sensitive
    // variable) never shows in the plan.
    it.skipIf(!engine)(
      `plans the cloudflare redeploy root with ${name} without showing Portainer's address`,
      async (test: TestContext) => {
        const root = await mkdtemp(join(tmpdir(), `opscrew-portainer-plan-${name}-`));
        const cwd = await write(
          root,
          renderInfra(validated["proxy + cloudflare"](), validatedContext()),
        );
        const runner = new NodeCommandRunner();
        const env = {
          ...process.env,
          CLOUDFLARE_API_TOKEN: PLACEHOLDER_TOKEN,
          TF_VAR_portainer_origin: PORTAINER_ORIGIN,
        };
        const init = await runner.run(
          bin,
          [
            "init",
            "-input=false",
            "-no-color",
            `-backend-config=path=${join(root, "state.tfstate")}`,
          ],
          { cwd, env },
        );
        if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
          test.skip(`${name} could not download the providers (network needed)`);
        }
        expect(init.exitCode, init.stdout + init.stderr).toBe(0);
        const plan = await runner.run(
          bin,
          ["plan", "-input=false", "-no-color", "-refresh=false", "-lock=false"],
          { cwd, env },
        );
        expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
        expect(plan.stdout).toContain("cloudflare_zero_trust_tunnel_cloudflared_config.this");
        expect(plan.stdout).toContain('"^/api/stacks/webhooks/"');
        expect(plan.stdout).toContain('"OpsCrew Portainer webhook (shop)"');
        expect(plan.stdout).not.toContain("192.0.2.44");
      },
      300_000,
    );
  }
});
