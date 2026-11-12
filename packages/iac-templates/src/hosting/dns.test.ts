// Feature 027 (T2711): the DNS root of an app on a hosting account, and the hosting branch of the
// workflow renderer.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { detectEngines } from "@opscrew/iac-engine";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it, type TestContext } from "vitest";
import { MODULE_FILES } from "../infra/modules";
import type { RenderContext } from "../types";
import { deploySecretNamesFor, renderWorkflow } from "../workflow";
import { serverPlan } from "../workflow/__fixtures__/plans";
import { renderHostingDns } from "./dns";
import { RELEASE_SIGNING_KEY_SECRET, renderHostingWorkflow } from "./workflow";

/** A plain PHP app on a cPanel account, its hostname on Cloudflare. */
function hostingPlan(panel: "cpanel" | "sftp" = "cpanel"): DeployPlan {
  const base = serverPlan();
  return DeployPlanSchema.parse({
    ...base,
    target: {
      provider: "hosting",
      panel,
      app: "php",
      webRoot: "public",
      php: { version: "8.3", via: panel === "sftp" ? "account" : "handler" },
    },
    services: [],
    externalServices: [],
    dns: {
      provider: "cloudflare",
      zone: "example.com",
      domain: "notes.example.com",
      proxied: false,
      www: false,
    },
    security: { ...base.security, httpAllowedFrom: "any" },
  });
}

const CTX = {
  github: { owner: "acme", repo: "notes" },
  cloudflare: { zoneId: "zone-1234" },
} as unknown as RenderContext;

describe("renderHostingDns", () => {
  const files = renderHostingDns(hostingPlan(), CTX, "192.0.2.10");
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const dir = hostingPlan().infra.dir;

  it("points the hostname's A record at the account, DNS only, with no AAAA record", () => {
    const main = byPath.get(`${dir}/main.tf`) ?? "";
    expect(main).toContain('source = "../modules/cloudflare-dns"');
    expect(main).toMatch(/ipv4\s+= var\.account_ipv4/);
    expect(main).toMatch(/ipv6_record = false/);
    expect(main).toMatch(/proxied\s+= false/);
    expect(main).not.toContain("www");
    expect(main).not.toContain("caa");
    expect(JSON.parse(byPath.get(`${dir}/terraform.tfvars.json`) ?? "{}")).toEqual({
      domain: "notes.example.com",
      cloudflare_zone_id: "zone-1234",
      account_ipv4: "192.0.2.10",
    });
    expect(byPath.get(`${dir}/variables.tf`)).toContain('variable "account_ipv4"');
    expect(byPath.get(`${dir}/outputs.tf`)).toContain("module.dns.url");
  });

  it("vendors the cloudflare-dns module itself, without its GitHub Pages mode", () => {
    const vendored = files.filter((file) => file.path.includes("/modules/"));
    expect(vendored.map((file) => file.path.replace(/^.*\/modules\//, ""))).toEqual([
      "cloudflare-dns/main.tf",
      "cloudflare-dns/outputs.tf",
      "cloudflare-dns/variables.tf",
      "cloudflare-dns/versions.tf",
    ]);
    for (const file of vendored) {
      expect(file.content).toBe(MODULE_FILES[file.path.replace(/^.*\/modules\//, "")]);
    }
    expect(files.every((file) => file.kind === "infra")).toBe(true);
  });

  it("refuses an address that isn't IPv4, and another target", () => {
    expect(() => renderHostingDns(hostingPlan(), CTX, "2001:db8::10")).toThrow(/IPv4/);
    expect(() => renderHostingDns(serverPlan(), CTX, "192.0.2.10")).toThrow(
      /only applies to an app on a hosting account/,
    );
  });
});

describe("the hosting branch of the workflow renderer", () => {
  it("renders a hosting account's own workflow, whose only secret is the signing key", () => {
    const plan = hostingPlan();
    expect(renderWorkflow(plan, CTX)).toEqual(renderHostingWorkflow(plan, CTX));
    expect(deploySecretNamesFor(plan)).toEqual([RELEASE_SIGNING_KEY_SECRET]);
  });

  it("leaves an SFTP host to its own workflow", () => {
    expect(() => renderWorkflow(hostingPlan("sftp"), CTX)).toThrow(/hosting account with a panel/);
  });
});

// Downloads the cloudflare provider from the registry, so it only runs with OPSCREW_IT=1. Binaries
// come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;

describe.skipIf(!runIt)("the hosting DNS root validates and plans (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    it.skipIf(!engine)(
      `validates, is formatted and plans one A record with ${name}`,
      async (test: TestContext) => {
        const dir = await mkdtemp(join(tmpdir(), `opscrew-hosting-dns-${name}-`));
        const plan = hostingPlan();
        for (const f of renderHostingDns(plan, CTX, "192.0.2.10")) {
          await mkdir(dirname(join(dir, f.path)), { recursive: true });
          await writeFile(join(dir, f.path), f.content);
        }
        const cwd = join(dir, plan.infra.dir);
        const env = { ...process.env, CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token", name) };
        const runner = new NodeCommandRunner();
        const bin = engine?.binary ?? name;
        const state = join(dir, "dns.tfstate");
        const init = await runner.run(
          bin,
          ["init", "-input=false", "-no-color", `-backend-config=path=${state}`],
          { cwd, env },
        );
        if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
          test.skip(`${name} could not download the cloudflare provider (network needed)`);
        }
        expect(init.exitCode, init.stdout + init.stderr).toBe(0);
        const validate = await runner.run(bin, ["validate", "-no-color"], { cwd, env });
        expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
        const fmt = await runner.run(bin, ["fmt", "-check", "-recursive", "-no-color", ".."], {
          cwd,
        });
        expect(fmt.exitCode, fmt.stdout + fmt.stderr).toBe(0);
        const planned = await runner.run(
          bin,
          ["plan", "-input=false", "-no-color", "-refresh=false", "-lock=false"],
          { cwd, env },
        );
        expect(planned.exitCode, planned.stdout + planned.stderr).toBe(0);
        expect(planned.stdout).toContain("module.dns.cloudflare_dns_record.a will be created");
        expect(planned.stdout).toContain("Plan: 1 to add, 0 to change, 0 to destroy.");
      },
      600_000,
    );
  }
});
