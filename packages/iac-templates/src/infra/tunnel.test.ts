// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation in expected file contents, not JavaScript templates.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { checkDialect, detectEngines } from "@opscrew/iac-engine";
import { describe, expect, it, type TestContext } from "vitest";
import { testCloudflareAccount, testContext, testPlan } from "../__fixtures__/plans";
import { BESZEL_SUBDOMAIN, observabilityPlan } from "../addons/__fixtures__/plans";
import type { RenderedFile } from "../types";
import { renderInfra } from "./index";

const ctx = () => testContext({ cloudflare: testCloudflareAccount() });
const PORTAINER = {
  access: "subdomain",
  hostname: "portainer.example.com",
  allowedEmails: ["ops@example.com"],
} as const;

/** A cloud server with only Beszel's hub at a subdomain. */
const beszelOnCloud = () =>
  observabilityPlan({ beszel: BESZEL_SUBDOMAIN }, { domain: "shop.example.com" });
/** An own server in tunnel mode with Portainer and Beszel at subdomains. */
const beszelOnOwnTunnel = () =>
  observabilityPlan(
    { beszel: BESZEL_SUBDOMAIN },
    { provider: "own", access: "tunnel", domain: "shop.example.com", portainer: PORTAINER },
  );

function file(files: readonly RenderedFile[], suffix: string): string {
  const found = files.find((f) => f.path.endsWith(suffix));
  if (!found) throw new Error(`no ${suffix} in ${files.map((f) => f.path).join(", ")}`);
  return found.content;
}

describe("Beszel's hub at a subdomain", () => {
  it("routes the hostname to the hub's loopback port through a tunnel, behind Access", () => {
    const files = renderInfra(beszelOnCloud(), ctx());
    const main = file(files, "prod/main.tf");
    expect(main).toContain(
      '    { hostname = var.beszel_hostname, service = "http://localhost:8090" },',
    );
    expect(main).toContain("  beszel_hostname                   = var.beszel_hostname");
    expect(main).toContain("  beszel_allowed_emails             = var.beszel_allowed_emails");
    expect(main).toContain(
      "  one_time_pin_identity_provider_id = var.one_time_pin_identity_provider_id",
    );
    expect(main).toContain("SSH, Portainer and Beszel hostnames");
    // A cloud server keeps SSH and the app on their public addresses.
    expect(main).not.toContain("ssh_hostname");
    expect(main).not.toContain("portainer");
    const tfvars = JSON.parse(file(files, "prod/terraform.tfvars.json"));
    expect(tfvars.beszel_hostname).toBe("beszel.example.com");
    expect(tfvars.beszel_allowed_emails).toEqual(["ops@example.com", "dev@example.com"]);
    expect(tfvars.one_time_pin_identity_provider_id).toBe(
      testCloudflareAccount().oneTimePinIdentityProviderId,
    );
    expect(file(files, "prod/outputs.tf")).toContain('value = "https://${var.beszel_hostname}"');
    expect(file(files, "prod/variables.tf")).toContain(
      "Id of the account's one-time PIN login method, Beszel's login.",
    );
  });

  it("shares the tunnel, Access and the one-time PIN login with Portainer's subdomain", () => {
    const files = renderInfra(beszelOnOwnTunnel(), ctx());
    const main = file(files, "prod/main.tf");
    expect(main).toContain("var.portainer_hostname, service");
    expect(main).toContain("var.beszel_hostname, service");
    expect(main.match(/one_time_pin_identity_provider_id = /g)).toHaveLength(1);
    expect(file(files, "prod/variables.tf")).toContain(
      "Id of the account's one-time PIN login method, Portainer's and Beszel's login.",
    );
    const tf = files.filter((f) => f.path.endsWith(".tf"));
    expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
  });

  it("needs the account's one-time PIN login method", () => {
    const noPin = testContext({
      cloudflare: testCloudflareAccount({ oneTimePinIdentityProviderId: undefined }),
    });
    expect(() => renderInfra(beszelOnCloud(), noPin)).toThrow(
      /Beszel's Cloudflare Access needs the account's one-time PIN login method/,
    );
  });

  it("leaves the HCL byte-identical for a local hub, Beszel turned off and the agent alone", () => {
    const shapes = [
      { enabled: true, version: "0.21.1" },
      { ...BESZEL_SUBDOMAIN, enabled: false },
      {
        enabled: true,
        version: "0.21.1",
        mode: "agent",
        hubUrl: "https://beszel.example.org",
        hubKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"B".repeat(48)}`,
      },
    ];
    for (const options of [
      { domain: "shop.example.com" },
      { provider: "own", access: "tunnel", domain: "shop.example.com", portainer: PORTAINER },
    ] as const) {
      const without = renderInfra(testPlan(options), ctx());
      for (const beszel of shapes) {
        expect(renderInfra(observabilityPlan({ beszel }, options), ctx())).toEqual(without);
      }
    }
  });
});

// Downloads the cloudflare provider from the registry, so it only runs with OPSCREW_IT=1. Binaries
// come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;

describe.skipIf(!runIt)("the Beszel roots validate (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    if (runIt && !engine)
      console.warn(`[iac-templates] skipping ${name}: no usable ${name} binary`);
    const bin = engine?.binary ?? name;
    for (const [label, planFor] of Object.entries({
      "cloud server": beszelOnCloud,
      "own server in tunnel mode, with Portainer": beszelOnOwnTunnel,
    })) {
      it.skipIf(!engine)(
        `validates the ${label} root with ${name}`,
        async (test: TestContext) => {
          const root = await mkdtemp(join(tmpdir(), `opscrew-beszel-${name}-`));
          for (const f of renderInfra(planFor(), ctx())) {
            const target = join(root, f.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, f.content);
          }
          const cwd = join(root, "opscrew/infra/prod");
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
          expect(fmt.exitCode, `not formatted as ${name} fmt writes it:\n${fmt.stdout}`).toBe(0);
        },
        300_000,
      );
    }
  }
});
