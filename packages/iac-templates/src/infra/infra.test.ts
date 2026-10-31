import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { checkDialect, detectEngines } from "@opscrew/iac-engine";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it, type TestContext } from "vitest";
import { collectModuleFiles, renderGeneratedModule } from "../../scripts/gen-modules";
import { DIRECTIONS, testTarget } from "../__fixtures__/layouts";
import {
  ONE_TIME_PIN_ID,
  testCloudflareAccount,
  testContext,
  testPlan,
  testServices,
} from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import type { RenderContext, RenderedFile } from "../types";
import { splitPlan } from "./__fixtures__/servers";
import { MOVE_LAYOUTS, moveLayout, renderInfra, tfvars } from "./index";

describe("renderInfra on a Portainer target", () => {
  it("renders the Portainer root (portainer.test.ts), never a server root: none here", () => {
    const portainer = DeployPlanSchema.parse({
      ...testPlan(),
      target: {
        provider: "portainer",
        mode: "portainer-stack",
        environmentId: 3,
        arch: "amd64",
        redeploy: "updater",
        web: { mode: "proxy", port: 8080 },
      },
    });
    // Proxy mode with the updater needs no Cloudflare Tunnel, so there is nothing to render.
    expect(renderInfra(portainer, testContext())).toEqual([]);
  });
});

const CF = ["173.245.48.0/20", "103.21.244.0/22", "2400:cb00::/32"];
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE opscrew-deploy";

function plan(overrides: { domain?: string; www?: boolean; backups?: boolean } = {}): DeployPlan {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-11T12:00:00.000Z",
    updatedAt: "2026-10-11T12:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/api/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: overrides.backups ?? true,
    },
    services: testServices({ postgres: true }),
    externalServices: [],
    cost: {
      monthly: { amount: 7.09, currency: "EUR" },
      breakdown: [
        { item: "server", monthly: { amount: 6.59, currency: "EUR" } },
        { item: "ipv4", monthly: { amount: 0.5, currency: "EUR" } },
      ],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-06-15T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: overrides.domain
      ? {
          provider: "cloudflare",
          domain: overrides.domain,
          zone: "example.com",
          proxied: true,
          www: overrides.www ?? false,
        }
      : { provider: "none", proxied: false },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: {},
  });
}

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    opscrewVersion: "0.1.0",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: `${PUBLIC_KEY}\n`,
    ...overrides,
  };
}

const cloudflare = () => ({
  zoneId: "0123456789abcdef0123456789abcdef",
  // Only the tunnel and Access use the account id; cloud roots without them ignore it.
  accountId: "fedcba9876543210fedcba9876543210",
});

describe("renderInfra", () => {
  it("renders a server-only root module without a domain", () => {
    const files = renderInfra(plan(), ctx());
    expect(files.map((f) => f.path)).toEqual([
      "opscrew/infra/prod/versions.tf",
      "opscrew/infra/prod/main.tf",
      "opscrew/infra/prod/variables.tf",
      "opscrew/infra/prod/outputs.tf",
      "opscrew/infra/prod/terraform.tfvars.json",
      "opscrew/infra/modules/hetzner-vps/cloud-init.yaml.tftpl",
      "opscrew/infra/modules/hetzner-vps/main.tf",
      "opscrew/infra/modules/hetzner-vps/outputs.tf",
      "opscrew/infra/modules/hetzner-vps/variables.tf",
      "opscrew/infra/modules/hetzner-vps/versions.tf",
    ]);
    const main = files.find((f) => f.path.endsWith("prod/main.tf"))?.content ?? "";
    expect(main).not.toContain("cloudflare");
    expect(main).toMatchSnapshot();
    expect(files.find((f) => f.path.endsWith("versions.tf"))?.content).toMatchSnapshot();
    expect(JSON.parse(files.find((f) => f.path.endsWith("tfvars.json"))?.content ?? "{}")).toEqual({
      app_name: "shop",
      location: "nbg1",
      server_type: "cx23",
      image: "ubuntu-24.04",
      backups: true,
      deploy_ssh_public_key: PUBLIC_KEY,
      ssh_allowed_cidrs: ["0.0.0.0/0", "::/0"],
      http_allowed_cidrs: ["0.0.0.0/0", "::/0"],
    });
  });

  it("passes the scheduled check's key line to a new server only when given", () => {
    const line = `restrict,command="df -P -B1 /" ${PUBLIC_KEY} opscrew-check:acme/shop`;
    const without = renderInfra(plan(), ctx());
    const files = renderInfra(plan(), ctx({ checkKeyLine: line }));
    const content = (list: readonly RenderedFile[], name: string) =>
      list.find((f) => f.path.endsWith(`prod/${name}`))?.content ?? "";
    expect(content(files, "main.tf")).toContain("  check_key_line     = var.check_key_line\n");
    expect(
      content(files, "main.tf").replace("  check_key_line     = var.check_key_line\n", ""),
    ).toBe(content(without, "main.tf"));
    expect(content(files, "variables.tf")).toContain('variable "check_key_line" {');
    expect(JSON.parse(content(files, "terraform.tfvars.json")).check_key_line).toBe(line);
    // Without it, the root module has nothing of it (the modules' variable defaults to empty).
    for (const file of without.filter((f) => f.path.includes("/prod/"))) {
      expect(file.content).not.toContain("check_key");
    }
  });

  it("adds Cloudflare DNS and restricts web ports to Cloudflare when proxied", () => {
    const files = renderInfra(
      plan({ domain: "example.com", www: true }),
      ctx({ cloudflare: cloudflare(), cloudflareRanges: CF }),
    );
    expect(files.some((f) => f.path === "opscrew/infra/modules/cloudflare-dns/main.tf")).toBe(true);
    expect(files.find((f) => f.path.endsWith("prod/main.tf"))?.content).toMatchSnapshot();
    const values = JSON.parse(files.find((f) => f.path.endsWith("tfvars.json"))?.content ?? "{}");
    expect(values).toMatchObject({
      domain: "example.com",
      cloudflare_zone_id: "0123456789abcdef0123456789abcdef",
      proxied: true,
      www: true,
      http_allowed_cidrs: CF,
    });
  });

  it("leaves the zone's rules out of every root: OpsCrew changes them outside Terraform", () => {
    const context = testContext({ cloudflare: testCloudflareAccount() });
    const roots = {
      hetzner: testPlan({ domain: "example.com", www: true }),
      digitalocean: testPlan({ provider: "digitalocean", domain: "example.com", www: true }),
      "own server": testPlan({ provider: "own", domain: "example.com", www: true }),
      "own server (tunnel)": testPlan({
        provider: "own",
        access: "tunnel",
        domain: "example.com",
        www: true,
      }),
    };
    for (const [name, deployPlan] of Object.entries(roots)) {
      const files = renderInfra(deployPlan, context);
      expect(files.some((f) => /modules\/cloudflare-(dns|tunnel)\/main\.tf$/.test(f.path))).toBe(
        true,
      );
      for (const file of files) {
        expect(file.content, `${name}: ${file.path}`).not.toMatch(
          /cloudflare_ruleset|cloudflare-waf|module "waf"|manage_config_rule|manage_waf_rules|ruleset_ids|cloudflare_rulesets/,
        );
      }
    }
  });

  it("keeps web ports open when Cloudflare ranges are unknown", () => {
    expect(
      tfvars(
        plan({ domain: "shop.example.com" }),
        ctx({ cloudflare: cloudflare(), cloudflareRanges: [] }),
      ).http_allowed_cidrs,
    ).toEqual(["0.0.0.0/0", "::/0"]);
  });

  it("exposes delete protection as a variable that defaults to on and is never in tfvars", () => {
    for (const files of [
      renderInfra(plan(), ctx()),
      renderInfra(plan({ domain: "shop.example.com" }), ctx({ cloudflare: cloudflare() })),
    ]) {
      const variablesTf = files.find((f) => f.path.endsWith("prod/variables.tf"))?.content ?? "";
      expect(variablesTf).toContain(
        [
          'variable "delete_protection" {',
          '  description = "Protect the server against accidental deletion and rebuilds; `opscrew destroy` passes false."',
          "  type        = bool",
          "  default     = true",
          "}",
        ].join("\n"),
      );
      const main = files.find((f) => f.path.endsWith("prod/main.tf"))?.content ?? "";
      expect(main).toMatch(/^ {2}delete_protection +=\s*var\.delete_protection$/m);
      const values = JSON.parse(files.find((f) => f.path.endsWith("tfvars.json"))?.content ?? "{}");
      expect(values).not.toHaveProperty("delete_protection");
      expect(files.find((f) => f.path.endsWith("tfvars.json"))?.content).not.toContain(
        "delete_protection",
      );
    }
  });

  it("refuses to render DNS without a zone id", () => {
    expect(() => renderInfra(plan({ domain: "shop.example.com" }), ctx())).toThrow(/zone id/);
  });

  it("is deterministic, dialect-neutral and free of secrets and absolute paths", () => {
    const rendered = renderInfra(
      plan({ domain: "shop.example.com" }),
      ctx({ cloudflare: cloudflare() }),
    );
    expect(
      renderInfra(plan({ domain: "shop.example.com" }), ctx({ cloudflare: cloudflare() })),
    ).toEqual(rendered);
    const tf = rendered.filter((f) => f.path.endsWith(".tf"));
    expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
    for (const file of rendered) {
      expect(file.content).not.toMatch(
        /(ghp_|sk-ant-|sk_live_|AKIA)[A-Za-z0-9]{8}|BEGIN [A-Z ]*PRIVATE KEY/,
      );
      expect(file.content).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//);
      expect(file.content.endsWith("\n")).toBe(true);
    }
  });
});

describe("generated modules", () => {
  it("match the module sources (run gen:modules after editing a module)", () => {
    expect(MODULE_FILES).toEqual(collectModuleFiles());
    expect(renderGeneratedModule(MODULE_FILES)).toContain("export const MODULE_FILES");
  });
});

// Downloads the hcloud, digitalocean and cloudflare providers from the registry, so it only runs
// with OPSCREW_IT=1. Binaries come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH. Covers
// the plain root modules and every move layout in both directions.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
if (!runIt) {
  console.warn(
    "[iac-templates] skipping HCL validation: set OPSCREW_IT=1 (it downloads the hcloud, digitalocean and cloudflare providers).",
  );
}
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;
const PORTAINER_SUBDOMAIN = {
  access: "subdomain",
  hostname: "portainer.example.com",
  allowedEmails: ["ops@example.com", "dev@example.com"],
} as const;
const validatedPlans = {
  hetzner: () => plan({ domain: "example.com", www: true }),
  digitalocean: () =>
    testPlan({ provider: "digitalocean", domain: "example.com", www: true, backups: true }),
  "hetzner with a Portainer subdomain": () =>
    testPlan({ domain: "shop.example.com", portainer: PORTAINER_SUBDOMAIN }),
  "own server (public)": () => testPlan({ provider: "own", domain: "example.com", www: true }),
  "own server (public, no domain)": () => testPlan({ provider: "own" }),
  "own server (tunnel, Portainer subdomain)": () =>
    testPlan({
      provider: "own",
      access: "tunnel",
      arch: "arm64",
      domain: "example.com",
      www: true,
      portainer: PORTAINER_SUBDOMAIN,
    }),
  "own server (tunnel)": () =>
    testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" }),
  "hetzner plus a hetzner db": () =>
    splitPlan({
      app: { domain: "example.com", www: true },
      servers: [{ name: "db", provider: "hetzner" }],
    }),
  "hetzner plus a digitalocean db": () =>
    splitPlan({
      app: { domain: "example.com", www: true },
      servers: [{ name: "db", provider: "digitalocean" }],
    }),
  "digitalocean plus two digitalocean servers": () =>
    splitPlan({
      app: { provider: "digitalocean" },
      servers: [
        { name: "db", provider: "digitalocean" },
        { name: "cache", provider: "digitalocean" },
      ],
    }),
  "hetzner with a network and no extra server": () => splitPlan({ device: true }),
  "own server plus a hetzner db": () =>
    splitPlan({ app: { provider: "own" }, servers: [{ name: "db-1", provider: "hetzner" }] }),
};
/** Context for the validated plans, with the account's one-time PIN login method. */
const validatedContext = () =>
  ctx({
    cloudflare: { ...cloudflare(), oneTimePinIdentityProviderId: ONE_TIME_PIN_ID },
    sshPort: 2222,
  });

/** Writes rendered files under `root`, initialises the root module and validates it. */
async function initAndValidate(
  test: TestContext,
  name: string,
  bin: string,
  root: string,
  files: readonly RenderedFile[],
): Promise<void> {
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const runner = new NodeCommandRunner();
  const cwd = join(root, "opscrew/infra/prod");
  const init = await runner.run(bin, ["init", "-backend=false", "-input=false", "-no-color"], {
    cwd,
  });
  if (init.exitCode !== 0 && NETWORK_ERROR.test(init.stdout + init.stderr)) {
    test.skip(
      `${name} could not download the providers (network needed): ${init.stderr.trim().split("\n")[0]}`,
    );
  }
  expect(init.exitCode, init.stdout + init.stderr).toBe(0);
  const validate = await runner.run(bin, ["validate", "-no-color"], { cwd });
  expect(validate.exitCode, validate.stdout + validate.stderr).toBe(0);
  const fmt = await runner.run(bin, ["fmt", "-check", "-recursive", "-no-color", ".."], { cwd });
  expect(fmt.exitCode, `not formatted as ${name} fmt writes it:\n${fmt.stdout}${fmt.stderr}`).toBe(
    0,
  );
}

/**
 * Plans the validated root under `root` offline (no refresh, placeholder tokens, an own server's
 * address from the environment as the CLI passes it) and returns the plan's text, all creates.
 */
async function planOffline(bin: string, root: string): Promise<string> {
  const runner = new NodeCommandRunner();
  const cwd = join(root, "opscrew/infra/prod");
  const init = await runner.run(bin, ["init", "-input=false", "-no-color"], { cwd });
  expect(init.exitCode, init.stdout + init.stderr).toBe(0);
  const token = "x".repeat(64);
  const planned = await runner.run(
    bin,
    ["plan", "-refresh=false", "-input=false", "-lock=false", "-no-color"],
    {
      cwd,
      env: {
        ...process.env,
        HCLOUD_TOKEN: token,
        DIGITALOCEAN_TOKEN: token,
        TF_VAR_server_ipv4: "203.0.113.10",
      },
    },
  );
  expect(planned.exitCode, planned.stdout + planned.stderr).toBe(0);
  expect(planned.stdout).toMatch(/Plan: \d+ to add, 0 to change, 0 to destroy/);
  return planned.stdout;
}

describe.skipIf(!runIt)("rendered HCL validates (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    if (runIt && !engine) {
      const problem = detected.find((d) => d.name === name)?.problem;
      console.warn(
        problem
          ? `[iac-templates] skipping ${name} validation: ${problem}`
          : `[iac-templates] skipping ${name} validation: no usable ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add it to PATH).`,
      );
    }
    const bin = engine?.binary ?? name;
    for (const [provider, planFor] of Object.entries(validatedPlans)) {
      it.skipIf(!engine)(
        `validates the ${provider} root with ${name}`,
        async (test) => {
          const root = await mkdtemp(join(tmpdir(), `opscrew-infra-${name}-${provider}-`));
          await initAndValidate(test, name, bin, root, renderInfra(planFor(), validatedContext()));
        },
        300_000,
      );
    }
    for (const provider of ["hetzner", "digitalocean"] as const) {
      it.skipIf(!engine)(
        `validates the ${provider} root with the scheduled check's key with ${name}`,
        async (test) => {
          const root = await mkdtemp(join(tmpdir(), `opscrew-infra-${name}-${provider}-check-`));
          const checkKeyLine = `restrict,command="df -P -B1 /" ${PUBLIC_KEY} opscrew-check:acme/shop`;
          const context = { ...validatedContext(), checkKeyLine };
          await initAndValidate(
            test,
            name,
            bin,
            root,
            renderInfra(validatedPlans[provider](), context),
          );
        },
        300_000,
      );
    }

    // An extra server counts its own deploy key from the id it gets, which must be known before
    // apply: an offline plan (no refresh, placeholder tokens) shows it is, with one key per provider.
    const reusing = {
      "hetzner plus a hetzner db": () =>
        splitPlan({ servers: [{ name: "db", provider: "hetzner" }] }),
      "digitalocean plus two digitalocean servers":
        validatedPlans["digitalocean plus two digitalocean servers"],
      "hetzner plus two digitalocean servers": () =>
        splitPlan({
          servers: [
            { name: "db", provider: "digitalocean" },
            { name: "cache", provider: "digitalocean" },
          ],
        }),
      "own server plus a hetzner db": validatedPlans["own server plus a hetzner db"],
    };
    for (const [label, planFor] of Object.entries(reusing)) {
      const plan = planFor();
      const providers = new Set(
        [plan.target, ...(plan.servers ?? []).map((s) => s.target)]
          .map((t) => t.provider)
          .filter((p) => p !== "own"),
      );
      it.skipIf(!engine)(
        `plans the ${label} root offline with one deploy key per provider with ${name}`,
        async (test) => {
          const root = await mkdtemp(join(tmpdir(), `opscrew-infra-${name}-reuse-`));
          await initAndValidate(test, name, bin, root, renderInfra(plan, validatedContext()));
          const planned = await planOffline(bin, root);
          expect(planned.match(/_ssh_key\.deploy(\[0\])? will be created/g)).toHaveLength(
            providers.size,
          );
        },
        300_000,
      );
    }

    // Once public SSH is closed (an empty allow-list), neither cloud firewall has an SSH rule.
    for (const [label, cidrs, rules] of [
      ["open", undefined, 2],
      ["closed", [], 0],
    ] as const) {
      it.skipIf(!engine)(
        `plans the hetzner plus a digitalocean db root offline with public SSH ${label} (${rules} SSH rules) with ${name}`,
        async (test) => {
          const root = await mkdtemp(join(tmpdir(), `opscrew-infra-${name}-ssh-${label}-`));
          const plan = splitPlan({ servers: [{ name: "db", provider: "digitalocean" }] });
          const withCidrs =
            cidrs === undefined
              ? plan
              : DeployPlanSchema.parse({
                  ...plan,
                  network: { ...plan.network, publicSsh: false },
                  security: { ...plan.security, sshAllowedCidrs: cidrs },
                });
          await initAndValidate(test, name, bin, root, renderInfra(withCidrs, validatedContext()));
          const planned = await planOffline(bin, root);
          // Hetzner's rule is described "SSH"; DigitalOcean's has port_range "22".
          expect(planned.match(/description\s+= "SSH"|port_range\s+= "22"/g) ?? []).toHaveLength(
            rules,
          );
          expect(planned).toMatch(/description\s+= "Ping"/);
        },
        300_000,
      );
    }

    // Every move layout uses both providers and Cloudflare, so the layouts share one directory per
    // engine: the providers are downloaded once, and each layout re-runs init for its modules.
    let layoutRoot: Promise<string> | undefined;
    for (const [from, to] of DIRECTIONS) {
      for (const layout of MOVE_LAYOUTS) {
        it.skipIf(!engine)(
          `validates the ${layout} layout from ${from} to ${to} with ${name}`,
          async (test) => {
            layoutRoot ??= mkdtemp(join(tmpdir(), `opscrew-infra-${name}-layouts-`));
            const files = renderInfra(
              testPlan({ provider: to, domain: "example.com", www: true }),
              ctx({
                cloudflare: cloudflare(),
                layout: moveLayout(layout, testTarget(from), testTarget(to)),
              }),
            );
            await initAndValidate(test, name, bin, await layoutRoot, files);
          },
          300_000,
        );
      }
    }
  }
});
