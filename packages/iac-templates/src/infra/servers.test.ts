// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import type { RenderContext, RenderedFile } from "../types";
import { splitPlan, type TestExtraServer } from "./__fixtures__/servers";
import { extraServerVariables, renderInfra } from "./index";

const root = (files: readonly RenderedFile[], name: string) =>
  files.find((f) => f.path === `opscrew/infra/prod/${name}`)?.content ?? "";

/** The body of `module "<name>"` in `main`. */
function moduleBody(main: string, name: string): string {
  const match = new RegExp(`module "${name}" \\{\\n([\\s\\S]*?)\\n\\}`).exec(main);
  if (!match?.[1]) throw new Error(`no module ${name}`);
  return match[1];
}

/** The addresses of the resources `main` declares itself, outside every module. */
function rootResources(main: string): string[] {
  return [...main.matchAll(/^resource "(\w+)" "(\w+)"/gm)].map((m) => `${m[1]}.${m[2]}`);
}

/** `name = value` arguments of a module body, whitespace-normalised. */
function args(body: string): Record<string, string> {
  return Object.fromEntries(
    [...body.matchAll(/^ {2}(\w+) += (.*)$/gm)].map((m) => [m[1], (m[2] ?? "").trim()]),
  );
}

function expectSnapshots(files: readonly RenderedFile[]): void {
  for (const name of ["versions.tf", "main.tf", "variables.tf", "outputs.tf"]) {
    expect(root(files, name), name).toMatchSnapshot(name);
  }
  expect(JSON.parse(root(files, "terraform.tfvars.json"))).toMatchSnapshot("terraform.tfvars.json");
}

const ctx = (o: Partial<RenderContext> = {}) => testContext(o);

describe("an extra server on the app server's provider (Hetzner app plus Hetzner db)", () => {
  const files = renderInfra(splitPlan({ servers: [{ name: "db", provider: "hetzner" }] }), ctx());
  const main = root(files, "main.tf");

  it("renders module server_db: named <app>-db, no web, the network's port, the app server's key", () => {
    expect(args(moduleBody(main, "server_db"))).toEqual({
      source: '"../modules/hetzner-vps"',
      name: '"${var.app_name}-db"',
      location: "var.db_location",
      server_type: "var.db_server_type",
      image: "var.db_image",
      backups: "var.db_backups",
      delete_protection: "var.db_delete_protection",
      ssh_public_key: "var.deploy_ssh_public_key",
      ssh_allowed_cidrs: "var.ssh_allowed_cidrs",
      labels: '{ "managed-by" = "opscrew", app = var.app_name }',
      web: "false",
      wireguard_port: "51820",
      ssh_key_id: "module.server.ssh_key_id",
    });
  });

  it("gives the app's server the network's port and lists the provider once", () => {
    expect(args(moduleBody(main, "server")).wireguard_port).toBe("51820");
    expect(main.match(/provider "hcloud"/g)).toHaveLength(1);
    expect(root(files, "versions.tf").match(/hcloud = \{/g)).toHaveLength(1);
    expect(files.filter((f) => f.path.endsWith("hetzner-vps/main.tf"))).toHaveLength(1);
  });

  it("outputs each extra server's addresses, id and name", () => {
    expect(root(files, "outputs.tf")).toContain(
      [
        'output "extra_servers" {',
        "  value = {",
        "    db = {",
        "      ipv4 = module.server_db.ipv4_address",
        "      ipv6 = module.server_db.ipv6_address",
        "      id   = module.server_db.server_id",
        "      name = module.server_db.server_name",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
  });

  it("writes the server's settings and keeps its delete protection on by default", () => {
    const tfvars = JSON.parse(root(files, "terraform.tfvars.json"));
    expect(tfvars).toMatchObject({
      db_location: "hel1",
      db_server_type: "cx33",
      db_image: "ubuntu-24.04",
      db_backups: false,
    });
    expect(tfvars).not.toHaveProperty("db_delete_protection");
    // Design reads them back by these names.
    const names = extraServerVariables("db");
    expect([tfvars[names.location], tfvars[names.serverType]]).toEqual(["hel1", "cx33"]);
    expect(root(files, "variables.tf")).toMatch(
      /variable "db_delete_protection" \{[^}]*default {5}= true/,
    );
  });

  it("gives the scheduled check's key to every server", () => {
    const checked = renderInfra(
      splitPlan({ servers: [{ name: "db", provider: "hetzner" }] }),
      ctx({ checkKeyLine: "restrict check-line" }),
    );
    const checkedMain = root(checked, "main.tf");
    for (const module of ["server", "server_db"]) {
      expect(args(moduleBody(checkedMain, module)).check_key_line).toBe("var.check_key_line");
    }
  });

  it("matches its snapshots", () => {
    expectSnapshots(files);
  });
});

describe("an extra server on another provider (Hetzner app plus DigitalOcean db)", () => {
  const files = renderInfra(
    splitPlan({ servers: [{ name: "db", provider: "digitalocean" }] }),
    ctx(),
  );
  const main = root(files, "main.tf");

  it("gets the deploy key and the app's tag the root creates once on that provider", () => {
    expect(rootResources(main)).toEqual(["digitalocean_ssh_key.deploy", "digitalocean_tag.app"]);
    const db = args(moduleBody(main, "server_db"));
    expect(db).toMatchObject({
      source: '"../modules/digitalocean-droplet"',
      name: '"${var.app_name}-db"',
      region: "var.db_location",
      size: "var.db_server_type",
      shared_tags: '[digitalocean_tag.app.name, "managed-by:opscrew"]',
      web: "false",
      wireguard_port: "51820",
      ssh_key_id: "coalesce(digitalocean_ssh_key.deploy.id)",
    });
    expect(db).not.toHaveProperty("app_tag");
    expect(db).not.toHaveProperty("http_allowed_cidrs");
  });

  it("lists both providers, each once, and vendors both modules", () => {
    expect(main.match(/provider "(hcloud|digitalocean)" \{\}/g)).toEqual([
      'provider "hcloud" {}',
      'provider "digitalocean" {}',
    ]);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("opscrew/infra/modules/hetzner-vps/main.tf");
    expect(paths).toContain("opscrew/infra/modules/digitalocean-droplet/main.tf");
  });

  it("matches its snapshots", () => {
    expectSnapshots(files);
  });
});

describe("two extra servers on a provider the app's server is not on", () => {
  const mainFor = (servers: TestExtraServer[]) =>
    root(renderInfra(splitPlan({ servers }), ctx()), "main.tf");
  const both = mainFor([
    { name: "db", provider: "digitalocean" },
    { name: "cache", provider: "digitalocean" },
  ]);

  it("share the key and the app's tag the root creates once", () => {
    expect(rootResources(both)).toEqual(["digitalocean_ssh_key.deploy", "digitalocean_tag.app"]);
    for (const module of ["server_db", "server_cache"]) {
      const server = args(moduleBody(both, module));
      expect(server).toMatchObject({
        ssh_key_id: "coalesce(digitalocean_ssh_key.deploy.id)",
        shared_tags: '[digitalocean_tag.app.name, "managed-by:opscrew"]',
      });
      expect(server).not.toHaveProperty("app_tag");
    }
  });

  it("keep them where they are when the first is removed", () => {
    const rest = mainFor([{ name: "cache", provider: "digitalocean" }]);
    expect(rootResources(rest)).toEqual(rootResources(both));
    expect(args(moduleBody(rest, "server_cache"))).toEqual(args(moduleBody(both, "server_cache")));
  });
});

describe("two extra servers on the app server's provider", () => {
  it("get the app server's key and tag, and the root creates none", () => {
    const main = root(
      renderInfra(
        splitPlan({
          app: { provider: "digitalocean" },
          servers: [
            { name: "db", provider: "digitalocean" },
            { name: "cache", provider: "digitalocean" },
          ],
        }),
        ctx(),
      ),
      "main.tf",
    );
    expect(rootResources(main)).toEqual([]);
    for (const module of ["server_db", "server_cache"]) {
      expect(args(moduleBody(main, module))).toMatchObject({
        ssh_key_id: "module.server.ssh_key_id",
        shared_tags: '[module.server.app_tag_name, "managed-by:opscrew"]',
      });
    }
  });
});

describe("a network with no extra server (devices only)", () => {
  const files = renderInfra(splitPlan({ device: true }), ctx());

  it("only opens the network's port on the app's server", () => {
    const without = renderInfra(testPlan(), ctx());
    const main = root(files, "main.tf");
    expect(main.replace("  wireguard_port     = 51820\n", "")).toBe(root(without, "main.tf"));
    for (const name of ["versions.tf", "variables.tf", "outputs.tf", "terraform.tfvars.json"]) {
      expect(root(files, name), name).toBe(root(without, name));
    }
  });

  it("matches its snapshots", () => {
    expectSnapshots(files);
  });
});

describe("an own app server plus a Hetzner db", () => {
  const files = renderInfra(
    splitPlan({ app: { provider: "own" }, servers: [{ name: "db-1", provider: "hetzner" }] }),
    ctx(),
  );

  it("creates the extra server with the root's key, its provider and the shared variables", () => {
    const main = root(files, "main.tf");
    expect(rootResources(main)).toEqual(["hcloud_ssh_key.deploy"]);
    const db = args(moduleBody(main, "server_db-1"));
    expect(db).toMatchObject({
      name: '"${var.app_name}-db-1"',
      web: "false",
      ssh_key_id: "coalesce(hcloud_ssh_key.deploy.id)",
    });
    expect(main).toContain('provider "hcloud" {}');
    const tfvars = JSON.parse(root(files, "terraform.tfvars.json"));
    expect(Object.keys(tfvars)).toEqual([
      "app_name",
      "db-1_location",
      "db-1_server_type",
      "db-1_image",
      "db-1_backups",
      "deploy_ssh_public_key",
      "ssh_allowed_cidrs",
    ]);
    // The own server's addresses still never reach a committed file.
    expect(tfvars).not.toHaveProperty("server_ipv4");
    expect(root(files, "outputs.tf")).toContain("    db-1 = {\n      ipv4 = module.server_db-1");
  });

  it("matches its snapshots", () => {
    expectSnapshots(files);
  });
});

describe("the server modules", () => {
  for (const module of ["hetzner-vps", "digitalocean-droplet"]) {
    const main = MODULE_FILES[`${module}/main.tf`] ?? "";
    const variables = MODULE_FILES[`${module}/variables.tf`] ?? "";

    it(`${module} takes web, wireguard_port and ssh_key_id, and outputs ssh_key_id`, () => {
      expect(variables).toMatch(/variable "web" \{[^}]*type {8}= bool\n {2}default {5}= true/);
      expect(variables).toMatch(
        /variable "wireguard_port" \{[^}]*type {8}= number\n {2}default {5}= null/,
      );
      expect(variables).toMatch(
        /variable "ssh_key_id" \{[^}]*type {8}= string\n {2}default {5}= null/,
      );
      expect(MODULE_FILES[`${module}/outputs.tf`]).toMatch(
        /output "ssh_key_id" \{[^}]*value {7}= local\.ssh_key_id/,
      );
      // The deploy key only without ssh_key_id; a key created as a single resource keeps its place.
      expect(main).toMatch(
        /_ssh_key" "deploy" \{\n {2}count {6}= var\.ssh_key_id == null \? 1 : 0/,
      );
      expect(main).toMatch(
        /moved \{\n {2}from = \w+_ssh_key\.deploy\n {2}to {3}= \w+_ssh_key\.deploy\[0\]/,
      );
      expect(main).toMatch(/for_each = var\.web \? local\.web_rules : \[\]/);
      expect(main).toMatch(
        /for_each = var\.wireguard_port == null \? \[\] : \[var\.wireguard_port\]/,
      );
    });
  }

  it("hetzner-vps opens 80 and 443 only with web, and WireGuard's port to everyone", () => {
    const main = MODULE_FILES["hetzner-vps/main.tf"] ?? "";
    const rules = /web_rules = \[([^\]]*)\]/.exec(main)?.[1]?.replace(/\s+/g, " ").trim();
    expect(rules).toBe(
      '{ description = "HTTP", protocol = "tcp", port = "80" }, { description = "HTTPS", protocol = "tcp", port = "443" }, { description = "HTTP/3", protocol = "udp", port = "443" },',
    );
    const dynamic = [
      ...main.matchAll(/dynamic "rule" \{\s*for_each = ([^\n]*)\s*content \{([^}]*)\}/g),
    ].map((m) => [m[1], (m[2] ?? "").replace(/\s+/g, " ").trim()]);
    expect(dynamic).toEqual([
      [
        "var.web ? local.web_rules : []",
        'description = rule.value.description direction = "in" protocol = rule.value.protocol port = rule.value.port source_ips = var.http_allowed_cidrs',
      ],
      [
        "var.wireguard_port == null ? [] : [var.wireguard_port]",
        'description = "WireGuard" direction = "in" protocol = "udp" port = tostring(rule.value) source_ips = ["0.0.0.0/0", "::/0"]',
      ],
    ]);
    // SSH and ping stay fixed rules.
    expect(
      [...main.matchAll(/^ {2}rule \{\n {4}description = "([^"]+)"/gm)].map((m) => m[1]),
    ).toEqual(["SSH", "Ping"]);
  });
});
