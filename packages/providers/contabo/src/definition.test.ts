import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLOUD_PROVIDER_CONTRACT_VERSION, type PlannedResourceJson } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner, Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { collectProviderModule } from "../../../../scripts/gen-provider-modules";
import { CREDENTIALS_ENV } from "./__fixtures__/fixtures";
import { definition } from "./index";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
/** OpsCrew's regions (plan-schema's `RegionSchema`, which a provider package does not import). */
const REGIONS = ["eu-central", "eu-north", "us-east", "us-west", "ap-southeast"];
const ENV_VARS = [
  "CNTB_OAUTH2_CLIENT_ID",
  "CNTB_OAUTH2_CLIENT_SECRET",
  "CNTB_OAUTH2_USER",
  "CNTB_OAUTH2_PASS",
];

/** A planned resource of `type` with `values`. */
function resource(
  address: string,
  type: string,
  values: Record<string, unknown>,
): PlannedResourceJson {
  return { address, type, name: address.split(".").at(-1) ?? "", values, unknown: {} };
}

describe("Contabo's cloud provider definition", () => {
  it("has the contract's version, its names and every part", () => {
    expect(definition.contractVersion).toBe(CLOUD_PROVIDER_CONTRACT_VERSION);
    expect(definition).toMatchObject({
      id: "contabo",
      displayName: "Contabo",
      name: "Contabo",
      serverNoun: "server",
      sizeNoun: "plan",
    });
    for (const part of ["credentials", "regions", "offering", "terraform", "texts"] as const) {
      expect(definition[part]).toBeDefined();
    }
  });

  it("needs all four credentials, which have no recognisable format", () => {
    const { credentials } = definition;
    expect(credentials).toMatchObject({
      envVars: ENV_VARS,
      mode: "all",
      createUrl: "https://new.contabo.com/account/security",
      tokenRules: [],
      envPrefixes: ["CNTB", "CONTABO"],
    });
    for (const text of [
      "Error: POST https://api.contabo.com/v1/compute/instances: 403 Forbidden",
      "oauth2: cannot fetch token from https://auth.contabo.com/auth/realms/contabo",
      "with contabo_instance.this",
    ]) {
      expect(credentials.apiPattern.test(text), text).toBe(true);
    }
    expect(credentials.apiPattern.test("api.hetzner.cloud")).toBe(false);
  });

  it("maps every OpsCrew region to Contabo's, with a note for the Nordics", () => {
    const { locations, locationNames, coordinates, notes } = definition.regions;
    expect(locations).toEqual({
      "eu-central": ["EU"],
      "eu-north": ["EU"],
      "us-east": ["US-east"],
      "us-west": ["US-west"],
      "ap-southeast": ["SIN"],
    });
    for (const location of new Set(Object.values(locations).flat())) {
      expect(locationNames[location], location).toBeTruthy();
      expect(coordinates[location], location).toHaveLength(2);
    }
    expect(Object.keys(notes)).toEqual(["eu-north"]);
    expect(notes["eu-north"]).toContain("Germany");
    for (const region of Object.keys(notes)) expect(REGIONS).toContain(region);
  });

  it("sells monthly terms that a removal cancels, with included snapshots and no backups", () => {
    expect(definition.offering).toMatchObject({
      currency: "EUR",
      backupPercent: 0,
      providerBackups: false,
      backupsOutliveServer: false,
      snapshots: { kind: "included" },
      serverSnapshotsOutliveServer: false,
      deleteProtection: false,
      resize: false,
      offAfterRefusedResize: false,
      removal: { kind: "cancel-at-term-end", minimumTermMonths: 1 },
    });
    expect(definition.offering.unavailable.test("The product is out of stock")).toBe(true);
    expect(definition.offering.unavailable.test("service temporarily unavailable")).toBe(false);
    expect(definition.offering.serverLimit.test("maximum number of instances reached")).toBe(true);
  });

  it("has the texts the contract asks for, and no resize text since a size change is refused", () => {
    const { texts } = definition;
    expect(texts.resizeOffline).toBeUndefined();
    expect(texts.interview.label).toBe("Contabo");
    expect(texts.interview.hint).toMatch(/Germany, the US and Singapore.*monthly.*EUR/);
    expect(texts.design).toEqual({ summaryNoun: "Contabo server", titleSuffix: " on Contabo" });
    for (const name of ENV_VARS) expect(texts.init.fix).toContain(name);
    expect(texts.init.fix).toContain("https://new.contabo.com/account/security");
    expect(texts.init.fix).toContain("whole account");
    expect(texts.init.scopeNote).toBe("");
    expect(texts.rotate.deleteToken).toContain("Account → Security");
    expect(texts.runbook.deletes("shop")).toContain("end of the current term");
    expect(texts.destroy.lookup("shop")).toContain("opscrew-app:shop");
    expect(texts.destroy.tokenHint("opscrew destroy")).toContain("`opscrew destroy`");
    expect(texts.destroy.deletedBackups).toBeUndefined();
    expect(texts.destroy.storageConsole).toBe(
      "the Contabo Customer Control Panel (Object Storage)",
    );
  });

  it("builds the module arguments of the app's server, an extra server and the previous one", () => {
    const { moduleArguments, extraShared } = definition.terraform;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
    const appTag = ["app_tag", '"opscrew-app:${var.app_name}"'];
    expect(moduleArguments({ prefix: "" })).toEqual([
      ["name", "var.app_name"],
      ["location", "var.location"],
      ["server_type", "var.server_type"],
      ["image", "var.image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      ["http_allowed_cidrs", "var.http_allowed_cidrs"],
      appTag,
    ]);
    expect(moduleArguments({ prefix: "db_", extra: "db", appTag: extraShared.appTag })).toEqual([
      // biome-ignore lint/suspicious/noTemplateCurlyInString: HCL interpolation, not JavaScript.
      ["name", '"${var.app_name}-db"'],
      ["location", "var.db_location"],
      ["server_type", "var.db_server_type"],
      ["image", "var.db_image"],
      ["ssh_public_key", "var.deploy_ssh_public_key"],
      ["ssh_allowed_cidrs", "var.ssh_allowed_cidrs"],
      appTag,
      ["app_tag_id", "coalesce(contabo_tag.app.id)"],
    ]);
    const previous = moduleArguments({ prefix: "previous_" });
    expect(previous).toContainEqual(["location", "var.previous_location"]);
    expect(previous).toContainEqual(["server_type", "var.previous_server_type"]);
    expect(previous).toContainEqual(["http_allowed_cidrs", "var.http_allowed_cidrs"]);
    expect(previous.map(([name]) => name)).not.toContain("app_tag_id");
    expect(extraShared.sshKeyId).toBe("coalesce(contabo_secret.deploy.id)");
  });

  // Its Terraform provider sends the cancel without the body Contabo requires (research R8).
  it("removes a server through the connector, which can cancel one", () => {
    expect(definition.terraform.connectorRemoval).toBe(true);
    const connector = definition.connector({ env: CREDENTIALS_ENV, redactor: new Redactor() });
    expect(connector.servers?.cancelServer).toBeTypeOf("function");
  });

  it("describes the firewall in the module, for the connector to apply, and keeps no login", () => {
    const { terraform } = definition;
    expect(terraform).toMatchObject({
      firewallResourceType: "terraform_data.firewall",
      connectorFirewall: true,
      homeCacheFiles: [".cache/contabo/terraform/token"],
    });
    const main = terraform.module.files["main.tf"] ?? "";
    expect(main).not.toContain("contabo_firewall");
    expect(main).toContain('resource "terraform_data" "firewall" {');
    expect(main).toContain("server_ids  = [tostring(contabo_instance.this.id)]");
    // A family with no network gets a source that matches nobody, never an empty list.
    for (const [list, family, nobody] of [
      ["ssh", "ipv4", '"127.0.0.1/32"'],
      ["ssh", "ipv6", '"::1/128"'],
      ["http", "ipv4", '"127.0.0.1/32"'],
      ["http", "ipv6", '"::1/128"'],
    ]) {
      const local = `${list}_${family}`;
      const colon = family === "ipv4" ? '!strcontains(cidr, ":")' : 'strcontains(cidr, ":")';
      const line = main.split("\n").find((text) => text.trimStart().startsWith(`${local} `));
      expect(line?.trim().replace(/\s+=\s+/, " = ")).toBe(
        `${local} = coalescelist([for cidr in var.${list}_allowed_cidrs : cidr if ${colon}], [${nobody}])`,
      );
    }
    // The SSH rule only with allowed networks, the web's only on a server that serves the web.
    expect(main).toContain('for port in length(var.ssh_allowed_cidrs) == 0 ? [] : ["22"] :');
    expect(main).toContain("for rule in var.web ? local.web_rules : [] :");
    expect(terraform.module.files["outputs.tf"]).toMatch(
      /output "wanted_firewall" \{[^}]*value\s+= terraform_data\.firewall\.input\n\}/,
    );
  });

  it("reads the wanted firewall's rules, one per port, and an empty source list as any source", () => {
    const firewall = resource("module.server.terraform_data.firewall", "terraform_data", {
      input: {
        name: "shop-firewall",
        description: "OpsCrew's firewall of shop.",
        server_ids: [null],
        rules: [
          { protocol: "tcp", ports: ["22"], ipv4: ["203.0.113.0/24"], ipv6: ["::1/128"] },
          { protocol: "tcp", ports: ["80", "443"], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
          { protocol: "icmp", ports: [], ipv4: ["0.0.0.0/0"], ipv6: ["::/0"] },
          { protocol: "udp", ports: ["8000-8100"], ipv4: [], ipv6: ["::1/128"] },
        ],
      },
    });
    expect(definition.texts.secops.rules(firewall)).toEqual([
      { direction: "in", protocol: "tcp", port: "22", source_ips: ["203.0.113.0/24", "::1/128"] },
      { direction: "in", protocol: "tcp", port: "80", source_ips: ["0.0.0.0/0", "::/0"] },
      { direction: "in", protocol: "tcp", port: "443", source_ips: ["0.0.0.0/0", "::/0"] },
      { direction: "in", protocol: "icmp", port: "", source_ips: ["0.0.0.0/0", "::/0"] },
      { direction: "in", protocol: "udp", port: "8000-8100", source_ips: ["0.0.0.0/0", "::1/128"] },
    ]);
  });

  it("sees the firewall attached by the server's id in server_ids or by a reference in the configuration", () => {
    const { attached } = definition.texts.secops;
    const server = resource("module.server.contabo_instance.this", "contabo_instance", {});
    const firewall = resource("module.server.terraform_data.firewall", "terraform_data", {
      input: { server_ids: [null] },
    });
    // The input's references as a plan's configuration lists them.
    const planJson = (module: string, references: string[]) => ({
      configuration: {
        root_module: {
          module_calls: {
            [module]: {
              module: {
                resources: [
                  {
                    address: "terraform_data.firewall",
                    type: "terraform_data",
                    name: "firewall",
                    expressions: { input: { references } },
                  },
                ],
              },
            },
          },
        },
      },
    });
    const references = [
      "var.name",
      "contabo_instance.this.id",
      "contabo_instance.this",
      "local.ssh_ipv4",
    ];
    expect(attached(server, [firewall], planJson("server", references))).toBe(true);
    expect(attached(server, [firewall], planJson("server", ["var.name"]))).toBe(false);
    // Another module's firewall references that module's own server.
    expect(attached(server, [firewall], planJson("server_db", references))).toBe(false);

    const known = resource("contabo_instance.this", "contabo_instance", { id: "100123" });
    const listing = (ids: unknown[]) =>
      resource("terraform_data.firewall", "terraform_data", { input: { server_ids: ids } });
    expect(attached(known, [listing(["100123"])], {})).toBe(true);
    expect(attached(known, [listing(["999"])], {})).toBe(false);
    expect(attached(known, [], {})).toBe(false);
  });

  it("embeds the current module, without the shared cloud-init", () => {
    expect(definition.terraform.module.name).toBe("contabo-vps");
    expect(definition.terraform.module.files).toEqual(collectProviderModule(packageDir));
    expect(Object.keys(definition.terraform.module.files)).not.toContain("cloud-init.yaml.tftpl");
  });

  it("ignores the instance's attributes whose change would reinstall it, and says so to drift", () => {
    expect(definition.terraform.lifecycleIgnored).toEqual([
      // Contabo attaches its firewall add-on (1501) by itself after creating the instance (R8).
      "add_ons",
      "default_user",
      "image_id",
      "period",
      "ssh_keys",
      "user_data",
    ]);
    expect(definition.terraform.module.files["main.tf"]).toContain(
      "ignore_changes = [user_data, image_id, ssh_keys, default_user, period, add_ons]",
    );
    expect(definition.terraform.module.files["versions.tf"]).toContain('version = "~> 0.1.44"');
  });

  it("outputs the IPv6 address shortened, as Cloudflare stores the AAAA record", () => {
    // Contabo answers 2a02:…:0000:0000:0000:0001; cidrhost gives back 2a02:…::1 (research R8).
    expect(definition.terraform.module.files["outputs.tf"]).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: an HCL interpolation, not JavaScript.
      'value       = try(cidrhost("${contabo_instance.this.ip_config[0].v6[0].ip}/128", 0), null)',
    );
  });
});

// Downloads the contabo provider from the registry, so it only runs with OPSCREW_IT=1. Binaries
// come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH.
const runIt = process.env.OPSCREW_IT === "1";
if (!runIt) {
  console.warn(
    "[provider-contabo] skipping HCL validation: set OPSCREW_IT=1 (it downloads the contabo provider).",
  );
}
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
/** The shared first-boot setup OpsCrew adds to every server module. */
const CLOUD_INIT = join(packageDir, "../../iac-templates/shared/cloud-init.yaml.tftpl");
const MODULE_DIR = "modules/contabo-vps";

/** `module "<name>" { … }` with `args`. */
function moduleBlock(name: string, args: readonly (readonly [string, string])[]): string[] {
  return [
    `module "${name}" {`,
    `  source = "./${MODULE_DIR}"`,
    ...args.map(([key, value]) => `  ${key} = ${value}`),
    "}",
    "",
  ];
}

/**
 * A root module as OpsCrew renders one: the app's server with the scheduled check's key and a
 * WireGuard port, and an extra server with the key and tag the root holds once.
 */
function rootModule(): string {
  const { terraform } = definition;
  const variable = (name: string, type: string) => [
    `variable "${name}" {`,
    `  type = ${type}`,
    "}",
  ];
  const shared = terraform.extraShared;
  return [
    "terraform {",
    "  required_providers {",
    `    ${terraform.provider.name} = {`,
    `      source  = "${terraform.provider.source}"`,
    `      version = "${terraform.provider.version}"`,
    "    }",
    "  }",
    "}",
    "",
    `# ${terraform.credentialsComment}`,
    `provider "${terraform.provider.name}" {}`,
    "",
    ...[
      "app_name",
      "deploy_ssh_public_key",
      "check_key_line",
      "location",
      "server_type",
      "image",
      "db_location",
      "db_server_type",
      "db_image",
    ].flatMap((name) => variable(name, "string")),
    ...["ssh_allowed_cidrs", "http_allowed_cidrs"].flatMap((name) =>
      variable(name, "list(string)"),
    ),
    "",
    ...moduleBlock("server", [
      ...terraform.moduleArguments({ prefix: "" }),
      ["wireguard_port", "51820"],
      ["check_key_line", "var.check_key_line"],
    ]),
    ...shared.resources,
    ...moduleBlock("server_db", [
      ...terraform.moduleArguments({
        prefix: "db_",
        extra: "db",
        ...(shared.appTag === undefined ? {} : { appTag: shared.appTag }),
      }),
      ["web", "false"],
      ["wireguard_port", "51821"],
      ["ssh_key_id", shared.sshKeyId],
      ["check_key_line", "var.check_key_line"],
    ]),
    'output "addresses" {',
    "  value = [module.server.ipv4_address, module.server.ipv6_address, module.server_db.ipv4_address]",
    "}",
    'output "ids" {',
    "  value = [module.server.server_id, module.server.server_name, module.server.ssh_key_id, module.server.app_tag_name]",
    "}",
  ].join("\n");
}

describe.skipIf(!runIt)("Contabo's module validates (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const bin = process.env[`OPSCREW_${name.toUpperCase()}_BIN`] || findExecutable(name);
    if (runIt && bin === undefined) {
      console.warn(
        `[provider-contabo] skipping ${name} validation: no ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
      );
    }
    it.skipIf(bin === undefined)(
      `validates a root with the app's server and an extra server with ${name}`,
      async (test) => {
        const root = await mkdtemp(join(tmpdir(), `opscrew-contabo-${name}-`));
        const files = {
          ...definition.terraform.module.files,
          "cloud-init.yaml.tftpl": await readFile(CLOUD_INIT, "utf8"),
        };
        for (const [path, content] of Object.entries(files)) {
          const target = join(root, MODULE_DIR, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content);
        }
        await writeFile(join(root, "main.tf"), rootModule());
        const runner = new NodeCommandRunner();
        const run = (args: string[]) => runner.run(bin as string, args, { cwd: root });
        const init = await run(["init", "-backend=false", "-input=false", "-no-color"]);
        if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
          test.skip(
            `${name} could not download the contabo provider (network needed): ${init.stderr.trim().split("\n")[0]}`,
          );
        }
        expect(init.exitCode, init.stdout + init.stderr).toBe(0);
        const validate = await run(["validate", "-no-color"]);
        expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
        const fmt = await run(["fmt", "-check", "-recursive", "-no-color", MODULE_DIR]);
        expect(fmt.exitCode, `not formatted as ${name} fmt writes it:\n${fmt.stdout}`).toBe(0);
      },
      300_000,
    );
  }
});
