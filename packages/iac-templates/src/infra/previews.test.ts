// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript templates.
import { describe, expect, it } from "vitest";
import { testCloudflare, testContext } from "../__fixtures__/plans";
import { previewPlan } from "../previews/__fixtures__/plans";
import type { RenderedFile } from "../types";
import { renderInfra } from "./index";

const context = () => testContext({ cloudflare: testCloudflare() });
const file = (files: readonly RenderedFile[], name: string) =>
  files.find((f) => f.path === `opscrew/infra/preview/${name}`)?.content ?? "";

/** `module "dns"` of a root's main.tf, from its line to the closing brace. */
function dnsBlock(main: string): string {
  const start = main.indexOf('module "dns" {');
  return main.slice(start, main.indexOf("\n}\n", start) + 2);
}

describe("the preview environment's root", () => {
  for (const provider of ["hetzner", "digitalocean", "own"] as const) {
    it(`points the previews' wildcard at the ${provider} server through Cloudflare's proxy, without www. or CAA`, () => {
      const files = renderInfra(previewPlan({ provider }), context());
      const main = file(files, "main.tf");
      const [ipv4, ipv6] =
        provider === "own"
          ? ["var.server_ipv4", "var.server_ipv6"]
          : ["module.server.ipv4_address", "module.server.ipv6_address"];
      expect(dnsBlock(main)).toBe(
        [
          'module "dns" {',
          '  source = "../modules/cloudflare-dns"',
          "",
          "  zone_id     = var.cloudflare_zone_id",
          '  domain      = "*.${var.preview_domain}"',
          `  ipv4        = ${ipv4}`,
          `  ipv6        = ${ipv6}`,
          // Behind OpsCrew's web filter an own server's site is on IPv4 only, as a proxied app's.
          ...(provider === "own" ? ["  ipv6_record = false"] : []),
          "  proxied     = true",
          "  www         = false",
          "  caa_issuers = []",
          "}",
        ].join("\n"),
      );
      expect(main).toContain(
        "# The previews' wildcard record, through Cloudflare's proxy: each preview is\n# pr-<number>-<random>.<base>, a name in no public certificate.\n",
      );
      expect(main).toContain('provider "cloudflare" {}');
      if (provider !== "own") expect(main).toContain('module "server" {');
      expect(file(files, "versions.tf")).toContain('source  = "cloudflare/cloudflare"');
      expect(files.some((f) => f.path === "opscrew/infra/modules/cloudflare-dns/main.tf")).toBe(
        true,
      );
    });
  }

  it("opens the server's web ports to Cloudflare only, as a proxied app's root does", () => {
    const ranges = ["173.245.48.0/20", "2400:cb00::/32"];
    for (const provider of ["hetzner", "digitalocean"] as const) {
      const files = renderInfra(
        previewPlan({ provider }),
        testContext({ cloudflare: testCloudflare(), cloudflareRanges: ranges }),
      );
      expect(JSON.parse(file(files, "terraform.tfvars.json")).http_allowed_cidrs).toEqual(ranges);
      expect(file(files, "main.tf")).toContain("http_allowed_cidrs = var.http_allowed_cidrs");
    }
  });

  it("declares the base name and the zone, never the app's own records' variables", () => {
    const files = renderInfra(previewPlan(), context());
    const variables = file(files, "variables.tf");
    expect(variables).toContain('variable "preview_domain" {');
    expect(variables).toContain('variable "cloudflare_zone_id" {');
    for (const name of ["domain", "proxied", "www", "caa_issuers"]) {
      expect(variables).not.toContain(`variable "${name}" {`);
    }
    const tfvars = JSON.parse(file(files, "terraform.tfvars.json"));
    expect(tfvars).toMatchObject({
      app_name: "shop-preview",
      preview_domain: "example.net",
      cloudflare_zone_id: testCloudflare().zoneId,
    });
    for (const name of ["domain", "proxied", "www", "caa_issuers"]) {
      expect(tfvars).not.toHaveProperty(name);
    }
  });

  it("gives the server's address as its url: it serves no name of its own", () => {
    const outputs = file(renderInfra(previewPlan(), context()), "outputs.tf");
    expect(outputs).toContain(
      'output "url" {\n  value = "http://${module.server.ipv4_address}"\n}',
    );
    const own = file(renderInfra(previewPlan({ provider: "own" }), context()), "outputs.tf");
    expect(own).toContain('output "url" {\n  value = "http://${var.server_ipv4}"\n}');
  });

  it("refuses to render it without the zone's id", () => {
    expect(() => renderInfra(previewPlan(), testContext())).toThrow(
      "A Cloudflare zone id is required to render DNS for this plan.",
    );
  });
});
