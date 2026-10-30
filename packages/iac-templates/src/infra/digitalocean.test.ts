import { checkDialect } from "@opscrew/iac-engine";
import { describe, expect, it } from "vitest";
import {
  CF_RANGES,
  PUBLIC_KEY,
  testCloudflare,
  testContext,
  testPlan,
} from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import { renderInfra } from "./index";

const doPlan = (o: Parameters<typeof testPlan>[0] = {}) =>
  testPlan({ provider: "digitalocean", ...o });
const content = (files: { path: string; content: string }[], suffix: string) =>
  files.find((f) => f.path.endsWith(suffix))?.content ?? "";

describe("renderInfra for DigitalOcean", () => {
  it("renders a Droplet root module without a domain and vendors only its module", () => {
    const files = renderInfra(doPlan(), testContext());
    expect(files.map((f) => f.path)).toEqual([
      "opscrew/infra/prod/versions.tf",
      "opscrew/infra/prod/main.tf",
      "opscrew/infra/prod/variables.tf",
      "opscrew/infra/prod/outputs.tf",
      "opscrew/infra/prod/terraform.tfvars.json",
      "opscrew/infra/modules/digitalocean-droplet/cloud-init.yaml.tftpl",
      "opscrew/infra/modules/digitalocean-droplet/main.tf",
      "opscrew/infra/modules/digitalocean-droplet/outputs.tf",
      "opscrew/infra/modules/digitalocean-droplet/variables.tf",
      "opscrew/infra/modules/digitalocean-droplet/versions.tf",
    ]);
    const main = content(files, "prod/main.tf");
    expect(main).not.toMatch(/cloudflare|hcloud|hetzner/i);
    expect(main).toContain("# Token from the DIGITALOCEAN_TOKEN environment variable");
    expect(main).toContain('source = "../modules/digitalocean-droplet"');
    expect(main).toMatch(/^ {2}region +=\s*var\.location$/m);
    expect(main).toMatch(/^ {2}size +=\s*var\.server_type$/m);
    expect(main).toMatch(/^ {2}app_tag +=\s*"opscrew-app:\$\{var\.app_name\}"$/m);
    expect(main).toMatch(/^ {2}shared_tags +=\s*\["managed-by:opscrew"\]$/m);
    expect(main).toMatchSnapshot("main.tf");
    const versions = content(files, "prod/versions.tf");
    expect(versions).toContain('source  = "digitalocean/digitalocean"');
    expect(versions).toContain('version = "~> 2.106"');
    expect(versions).not.toMatch(/hcloud|cloudflare/);
    expect(versions).toMatchSnapshot("versions.tf");
    expect(content(files, "prod/variables.tf")).toMatchSnapshot("variables.tf");
    expect(content(files, "prod/outputs.tf")).toMatchSnapshot("outputs.tf");
    expect(JSON.parse(content(files, "tfvars.json"))).toEqual({
      app_name: "shop",
      location: "fra1",
      server_type: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      backups: true,
      deploy_ssh_public_key: PUBLIC_KEY,
      ssh_allowed_cidrs: ["0.0.0.0/0", "::/0"],
      http_allowed_cidrs: ["0.0.0.0/0", "::/0"],
    });
  });

  it("adds Cloudflare DNS next to the Droplet and restricts web ports to Cloudflare", () => {
    const files = renderInfra(
      doPlan({ domain: "example.com", www: true }),
      testContext({ cloudflare: testCloudflare(), cloudflareRanges: CF_RANGES }),
    );
    const vendored = files.filter((f) => f.path.startsWith("opscrew/infra/modules/"));
    expect(new Set(vendored.map((f) => f.path.split("/")[3]))).toEqual(
      new Set(["cloudflare-dns", "digitalocean-droplet"]),
    );
    expect(content(files, "prod/main.tf")).toMatchSnapshot("main.tf");
    expect(content(files, "prod/versions.tf")).toMatchSnapshot("versions.tf");
    expect(content(files, "prod/variables.tf")).toMatchSnapshot("variables.tf");
    expect(JSON.parse(content(files, "tfvars.json"))).toMatchObject({
      domain: "example.com",
      cloudflare_zone_id: "0123456789abcdef0123456789abcdef",
      proxied: true,
      www: true,
      http_allowed_cidrs: CF_RANGES,
    });
  });

  it("passes the backups choice through tfvars (on and off)", () => {
    const on = renderInfra(doPlan({ backups: true }), testContext());
    const off = renderInfra(doPlan({ backups: false }), testContext());
    expect(content(on, "tfvars.json")).toMatchSnapshot("backups on");
    expect(content(off, "tfvars.json")).toMatchSnapshot("backups off");
    expect(JSON.parse(content(off, "tfvars.json")).backups).toBe(false);
    // Everything else is the same: backups are a variable, not a different module.
    expect(on.filter((f) => !f.path.endsWith("tfvars.json"))).toEqual(
      off.filter((f) => !f.path.endsWith("tfvars.json")),
    );
  });

  it("has no delete protection variable or argument", () => {
    for (const files of [
      renderInfra(doPlan(), testContext()),
      renderInfra(
        doPlan({ domain: "shop.example.com" }),
        testContext({ cloudflare: testCloudflare() }),
      ),
    ]) {
      for (const file of files) expect(file.content).not.toContain("delete_protection");
    }
  });

  it("is deterministic, dialect-neutral and free of secrets and absolute paths", () => {
    const render = () =>
      renderInfra(
        doPlan({ domain: "shop.example.com" }),
        testContext({ cloudflare: testCloudflare() }),
      );
    const rendered = render();
    expect(render()).toEqual(rendered);
    const tf = rendered.filter((f) => f.path.endsWith(".tf"));
    expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
    for (const file of rendered) {
      expect(file.content).not.toMatch(/do[por]_v1_[0-9a-f]{8}|BEGIN [A-Z ]*PRIVATE KEY/);
      expect(file.content).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
      expect(file.content.endsWith("\n")).toBe(true);
    }
  });
});

describe("digitalocean-droplet module", () => {
  const main = MODULE_FILES["digitalocean-droplet/main.tf"] ?? "";

  it("uses the shared cloud-init template, byte for byte", () => {
    expect(MODULE_FILES["digitalocean-droplet/cloud-init.yaml.tftpl"]).toBe(
      MODULE_FILES["hetzner-vps/cloud-init.yaml.tftpl"],
    );
    // Same template variables as the Hetzner module.
    const call = /templatefile\([^)]*\)/s;
    expect(main.match(call)?.[0]).toBe(MODULE_FILES["hetzner-vps/main.tf"]?.match(call)?.[0]);
  });

  it("pins the provider and the engine version", () => {
    const versions = MODULE_FILES["digitalocean-droplet/versions.tf"] ?? "";
    expect(versions).toContain('required_version = ">= 1.6.0"');
    expect(versions).toContain('source  = "digitalocean/digitalocean"');
    expect(versions).toContain('version = "~> 2.106"');
  });

  it("manages only the app's own tag and never the shared managed-by:opscrew tag", () => {
    // Deleting a DigitalOcean tag untags every resource in the account, other apps included.
    const tagBlocks = [...main.matchAll(/resource "digitalocean_tag" "([^"]+)" \{([^}]*)\}/g)];
    expect(tagBlocks.map((m) => [m[1], (m[2] ?? "").replace(/\s+/g, " ").trim()])).toEqual([
      ["app", "count = var.app_tag == null ? 0 : 1 name = var.app_tag"],
    ]);
    expect(main).toMatch(/^ {2}app_tags += digitalocean_tag\.app\[\*\]\.name$/m);
    expect(main).toMatch(/^ {2}tags +=\s*concat\(local\.app_tags, var\.shared_tags\)$/m);
    for (const file of renderInfra(doPlan(), testContext())) {
      for (const block of file.content.matchAll(/resource "digitalocean_tag"[^{]*\{[^}]*\}/g)) {
        expect(block[0]).not.toContain("managed-by");
      }
    }
  });

  it("creates the deploy SSH key and a Droplet with daily backups only when asked", () => {
    expect(main).toContain('resource "digitalocean_ssh_key" "deploy"');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
    expect(main).toContain('name       = "${var.name}-deploy"');
    expect(main).toContain('resource "digitalocean_droplet" "this"');
    expect(main).toMatch(/dynamic "backup_policy" \{\s+for_each = var\.backups \? \[1\] : \[\]/);
    expect(main).toMatch(/plan = "daily"/);
    expect(main).toMatch(/hour = 4/);
    expect(main).toMatch(/^ {2}ipv6 +=\s*true$/m);
    expect(main).toMatch(/^ {2}monitoring +=\s*true$/m);
    expect(main).toMatch(/^ {2}ssh_keys +=\s*\[local\.ssh_key_id\]$/m);
    expect(main).toMatch(
      /^ {2}ssh_key_id = coalesce\(var\.ssh_key_id, one\(digitalocean_ssh_key\.deploy\[\*\]\.id\)\)$/m,
    );
    expect(main).toContain("ignore_changes = [user_data, image, ssh_keys]");
  });

  it("attaches a firewall with the web, SSH and ping rules and explicit outbound rules", () => {
    expect(main).toContain("droplet_ids = [digitalocean_droplet.this.id]");
    const inbound = [...main.matchAll(/inbound_rule \{([^}]*)\}/g)].map((m) =>
      (m[1] ?? "").replace(/\s+/g, " ").trim(),
    );
    expect(inbound).toEqual([
      'protocol = "tcp" port_range = "22" source_addresses = var.ssh_allowed_cidrs',
      'protocol = "icmp" source_addresses = ["0.0.0.0/0", "::/0"]',
    ]);
    // The web's rules, only with `web`, and WireGuard's, only with a port.
    const dynamic = [
      ...main.matchAll(/dynamic "inbound_rule" \{\s*for_each = ([^\n]*)\s*content \{([^}]*)\}/g),
    ].map((m) => [m[1], (m[2] ?? "").replace(/\s+/g, " ").trim()]);
    expect(dynamic).toEqual([
      [
        "var.web ? local.web_rules : []",
        "protocol = inbound_rule.value.protocol port_range = inbound_rule.value.port source_addresses = var.http_allowed_cidrs",
      ],
      [
        "var.wireguard_port == null ? [] : [var.wireguard_port]",
        'protocol = "udp" port_range = tostring(inbound_rule.value) source_addresses = ["0.0.0.0/0", "::/0"]',
      ],
    ]);
    const webRules = /web_rules = \[([^\]]*)\]/.exec(main)?.[1]?.replace(/\s+/g, " ").trim();
    expect(webRules).toBe(
      '{ protocol = "tcp", port = "80" }, { protocol = "tcp", port = "443" }, { protocol = "udp", port = "443" },',
    );
    const outbound = [...main.matchAll(/outbound_rule \{([^}]*)\}/g)].map((m) =>
      (m[1] ?? "").replace(/\s+/g, " ").trim(),
    );
    expect(outbound).toEqual([
      'protocol = "tcp" port_range = "1-65535" destination_addresses = ["0.0.0.0/0", "::/0"]',
      'protocol = "udp" port_range = "1-65535" destination_addresses = ["0.0.0.0/0", "::/0"]',
      'protocol = "icmp" destination_addresses = ["0.0.0.0/0", "::/0"]',
    ]);
  });

  it("exposes the Hetzner module's outputs, with the id as a string, and the app's tag", () => {
    const names = (file: string) =>
      [...(MODULE_FILES[file] ?? "").matchAll(/^output "([^"]+)"/gm)].map((m) => m[1]);
    expect(names("digitalocean-droplet/outputs.tf")).toEqual([
      ...names("hetzner-vps/outputs.tf"),
      "app_tag_name",
    ]);
    expect(MODULE_FILES["digitalocean-droplet/outputs.tf"]).toContain(
      "tostring(digitalocean_droplet.this.id)",
    );
  });
});
