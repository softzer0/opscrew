// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import { renderTunnelConnectorCompose } from "../runtime";

/** The body of `resource "<type>" "<name>"` (up to its closing brace at column 0). */
function resource(source: string, type: string, name: string): string {
  const match = new RegExp(`resource "${type}" "${name}" \\{\\n([\\s\\S]*?)\\n\\}`).exec(source);
  if (!match?.[1]) throw new Error(`no resource ${type}.${name}`);
  return match[1];
}

/** The body of `output "<name>"`. */
function outputBlock(source: string, name: string): string {
  const match = new RegExp(`output "${name}" \\{\\n([\\s\\S]*?)\\n\\}`).exec(source);
  if (!match?.[1]) throw new Error(`no output ${name}`);
  return match[1];
}

describe("resources several OpsCrew apps share", () => {
  it("are in no module: the zone's rules and the account's Zero Trust login stay outside Terraform", () => {
    for (const [path, content] of Object.entries(MODULE_FILES)) {
      expect(content, path).not.toMatch(
        /cloudflare_ruleset|cloudflare_zero_trust_organization|cloudflare_zero_trust_access_identity_provider|module "waf"/,
      );
    }
  });
});

describe("cloudflare-tunnel module security", () => {
  const main = MODULE_FILES["cloudflare-tunnel/main.tf"] ?? "";
  const outputs = MODULE_FILES["cloudflare-tunnel/outputs.tf"] ?? "";

  it("is remotely managed and ends its ingress with a 404 for every other hostname", () => {
    const tunnel = resource(main, "cloudflare_zero_trust_tunnel_cloudflared", "this");
    expect(tunnel).toMatch(/config_src = "cloudflare"/);
    const config = resource(main, "cloudflare_zero_trust_tunnel_cloudflared_config", "this");
    // The catch-all is the last element of the concatenated ingress list.
    expect(config).toMatch(
      /\[\s*\{\s*hostname\s*= null\s*path\s*= null\s*service\s*= "http_status:404"\s*origin_request = null\s*\},\s*\],\s*\)\s*\}$/,
    );
    expect(config.match(/http_status:404/g)).toHaveLength(1);
  });

  it("lets a route serve only the paths it matches, other paths falling through to the 404", () => {
    const config = resource(main, "cloudflare_zero_trust_tunnel_cloudflared_config", "this");
    expect(config).toMatch(/^ {10}path {11}= route\.path$/m);
    const variables = MODULE_FILES["cloudflare-tunnel/variables.tf"] ?? "";
    expect(variables).toMatch(/^ {4}path {10}= optional\(string\)$/m);
  });

  it("publishes every hostname only as a proxied CNAME to the tunnel", () => {
    const record = resource(main, "cloudflare_dns_record", "route");
    expect(record).toMatch(/^ {2}type {4}= "CNAME"$/m);
    expect(record).toMatch(/^ {2}proxied = true$/m);
    expect(record).toContain(".cfargotunnel.com");
    expect(main.match(/resource "cloudflare_dns_record"/g)).toHaveLength(1);
  });

  it("keeps the connector token sensitive", () => {
    expect(outputBlock(outputs, "token")).toMatch(/^ {2}sensitive {3}= true$/m);
  });
});

describe("cloudflare-access module security", () => {
  const main = MODULE_FILES["cloudflare-access/main.tf"] ?? "";
  const outputs = MODULE_FILES["cloudflare-access/outputs.tf"] ?? "";

  it("lets only the deploy service token through to its service (SSH or Portainer's webhook)", () => {
    const policy = resource(main, "cloudflare_zero_trust_access_policy", "ssh");
    expect(policy).toMatch(/^ {2}decision {3}= "non_identity"$/m);
    const include = /include = \[([\s\S]*?)\n {2}\]/.exec(policy)?.[1] ?? "";
    expect(include.trim()).toBe(
      "{ service_token = { token_id = cloudflare_zero_trust_access_service_token.ssh[0].id } },",
    );
    expect(policy).not.toMatch(/require|exclude|everyone|email/);
    const app = resource(main, "cloudflare_zero_trust_access_application", "ssh");
    const policies = /policies = \[([\s\S]*?)\n {2}\]/.exec(app)?.[1] ?? "";
    expect(policies.trim()).toBe(
      "{ id = cloudflare_zero_trust_access_policy.ssh[0].id, precedence = 1 },",
    );
    expect(app).toMatch(/domain\s+= var\.service_hostname/);
  });

  it("names the service-token application by its label, SSH unless the root says otherwise", () => {
    const app = resource(main, "cloudflare_zero_trust_access_application", "ssh");
    expect(app).toMatch(
      /^ {2}name {22}= "OpsCrew \$\{var\.service_label\} \(\$\{var\.app_name\}\)"$/m,
    );
    const variables = MODULE_FILES["cloudflare-access/variables.tf"] ?? "";
    expect(variables).toMatch(/variable "service_label" \{[^}]*default {5}= "SSH"\n\}/);
  });

  it("lets only the listed emails through to Portainer, with the one-time PIN login", () => {
    const policy = resource(main, "cloudflare_zero_trust_access_policy", "portainer");
    expect(policy).toMatch(/^ {2}decision {3}= "allow"$/m);
    expect(policy).toMatch(
      /^ {2}include {4}= \[for email in var\.portainer_allowed_emails : \{ email = \{ email = email \} \}\]$/m,
    );
    expect(policy).not.toMatch(/everyone|email_domain|service_token|require|exclude/);
    const app = resource(main, "cloudflare_zero_trust_access_application", "portainer");
    expect(app).toMatch(/^ {2}allowed_idps\s+= \[var\.one_time_pin_identity_provider_id\]$/m);
    const policies = /policies = \[([\s\S]*?)\n {2}\]/.exec(app)?.[1] ?? "";
    expect(policies.trim()).toBe(
      "{ id = cloudflare_zero_trust_access_policy.portainer[0].id, precedence = 1 },",
    );
  });

  it("keeps the service token sensitive", () => {
    for (const name of ["ssh_service_token_client_id", "ssh_service_token_client_secret"]) {
      expect(outputBlock(outputs, name), name).toMatch(/^ {2}sensitive {3}= true$/m);
    }
  });
});

describe("tunnel connector security", () => {
  it("serves cloudflared's metrics on loopback only, on a free port of its own", () => {
    const compose = parse(
      renderTunnelConnectorCompose(
        testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" }),
      ).content,
    );
    const command: string[] = compose.services.cloudflared.command;
    expect(command.slice(command.indexOf("--metrics"), command.indexOf("--metrics") + 2)).toEqual([
      "--metrics",
      "127.0.0.1:0",
    ]);
  });
});
