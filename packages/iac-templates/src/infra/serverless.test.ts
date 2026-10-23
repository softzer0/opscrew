// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation in expected file contents, not JavaScript templates.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { checkDialect, detectEngines } from "@opscrew/iac-engine";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, type TestContext, vi } from "vitest";
import { ACCOUNT_ID, testCloudflare, testContext, testPlan } from "../__fixtures__/plans";
import { MODULE_FILES } from "../generated/modules";
import type { RenderContext, RenderedFile } from "../types";
import { pagesVerificationRootDir, renderInfra, renderPagesVerification, tfvars } from "./index";

// Feature 016: the roots of the server-less targets, Cloudflare's hosting (a Worker's shell and its
// custom domains) and GitHub Pages (its DNS records, and GitHub's verification record in a root of
// its own).

const SITE = {
  tool: "node",
  packageManager: "npm",
  nodeVersion: "24",
  command: "npm run build",
  outputDir: "dist",
} as const;

const WORKERS = {
  provider: "cloudflare-workers",
  mode: "workers-assets",
  worker: "example-app",
  render: "static",
  notFound: "single-page-application",
  site: SITE,
} as const;

const PAGES = { provider: "github-pages", mode: "pages-workflow", site: SITE } as const;

/** A value as GitHub's verification page shows it (not a secret: it is public in DNS). */
const VERIFICATION = "0a1b2c3d4e5f60718293a4b5c6d7e8";

/** A plan for `target` with nothing that needs a server, on `domain` in the zone example.com. */
function serverlessPlan(
  target: Record<string, unknown>,
  o: { domain?: string; www?: boolean; zone?: string | null } = {},
): DeployPlan {
  const base = testPlan({ postgres: false });
  const pages = target.provider === "github-pages";
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: "example-app" },
    target,
    services: [],
    externalServices: [],
    dns: {
      provider: "cloudflare",
      domain: o.domain ?? "docs.example.com",
      ...(o.zone === null ? {} : { zone: o.zone ?? "example.com" }),
      proxied: !pages,
      www: o.www ?? false,
    },
    security: pages ? { wafCustomRules: false, httpAllowedFrom: "any" } : {},
  });
}

/** The repository's owner as Git names it, in mixed case: the records use it in lower case. */
function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return testContext({
    github: { owner: "Example-Org", repo: "example-app" },
    cloudflare: { ...testCloudflare(), accountId: ACCOUNT_ID },
    ...overrides,
  });
}

function file(files: readonly RenderedFile[], suffix: string): string {
  const found = files.find((f) => f.path.endsWith(suffix));
  if (!found) throw new Error(`no ${suffix} in ${files.map((f) => f.path).join(", ")}`);
  return found.content;
}

/** The body of the block whose first line is `header` (up to its closing brace at column 0). */
function block(source: string, header: string): string {
  const match = new RegExp(
    `^${header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{\\n([\\s\\S]*?)\\n\\}`,
    "m",
  ).exec(source);
  if (!match?.[1]) throw new Error(`no ${header}`);
  return match[1];
}

const ROOT_FILES = [
  "versions.tf",
  "main.tf",
  "variables.tf",
  "outputs.tf",
  "terraform.tfvars.json",
];

describe("renderInfra on Cloudflare's hosting", () => {
  const plan = serverlessPlan(WORKERS, { www: true });
  const files = renderInfra(plan, ctx());

  it("renders the Worker's root and vendors only the cloudflare-workers module", () => {
    expect(files.map((f) => f.path)).toEqual([
      ...ROOT_FILES.map((name) => `opscrew/infra/prod/${name}`),
      "opscrew/infra/modules/cloudflare-workers/main.tf",
      "opscrew/infra/modules/cloudflare-workers/outputs.tf",
      "opscrew/infra/modules/cloudflare-workers/variables.tf",
      "opscrew/infra/modules/cloudflare-workers/versions.tf",
    ]);
    for (const name of ["main.tf", "variables.tf", "outputs.tf", "versions.tf"]) {
      expect(file(files, `prod/${name}`)).toMatchSnapshot(name);
    }
    // No server, no DNS module: each custom domain creates its own record.
    expect(file(files, "prod/main.tf")).not.toMatch(/module "(server|dns)"|hcloud|digitalocean/);
  });

  it("writes the Worker's name, the hostnames and the two addresses' switches as variables", () => {
    expect(JSON.parse(file(files, "terraform.tfvars.json"))).toEqual({
      domain: "docs.example.com",
      cloudflare_zone_id: testCloudflare().zoneId,
      www: true,
      cloudflare_account_id: ACCOUNT_ID,
      worker: "example-app",
      workers_dev: false,
      preview_urls: false,
    });
    const turnedOn = serverlessPlan(
      { ...WORKERS, worker: "example-app-staging", workersDev: true, previewUrls: true },
      { domain: "staging.example.com" },
    );
    expect(tfvars(turnedOn, ctx())).toMatchObject({
      domain: "staging.example.com",
      www: false,
      worker: "example-app-staging",
      workers_dev: true,
      preview_urls: true,
    });
  });

  it("needs the Cloudflare account id and the zone id", () => {
    expect(() => renderInfra(plan, ctx({ cloudflare: testCloudflare() }))).toThrow(
      /Cloudflare account id is required/,
    );
    expect(() => renderInfra(plan, ctx({ cloudflare: undefined }))).toThrow(/zone id/);
  });
});

describe("renderInfra on GitHub Pages", () => {
  const apex = renderInfra(serverlessPlan(PAGES, { domain: "example.com", www: true }), ctx());
  const subdomain = renderInfra(serverlessPlan(PAGES), ctx());

  it("renders the site's root with only the GitHub Pages DNS module", () => {
    for (const files of [apex, subdomain]) {
      expect(files.map((f) => f.path)).toEqual([
        ...ROOT_FILES.map((name) => `opscrew/infra/prod/${name}`),
        "opscrew/infra/modules/cloudflare-dns/github-pages/main.tf",
        "opscrew/infra/modules/cloudflare-dns/github-pages/outputs.tf",
        "opscrew/infra/modules/cloudflare-dns/github-pages/variables.tf",
        "opscrew/infra/modules/cloudflare-dns/github-pages/versions.tf",
      ]);
    }
    for (const name of ["main.tf", "variables.tf", "outputs.tf", "versions.tf"]) {
      expect(file(apex, `prod/${name}`)).toMatchSnapshot(name);
      // The apex and a subdomain differ only in their values.
      expect(file(subdomain, `prod/${name}`)).toBe(file(apex, `prod/${name}`));
    }
  });

  it("tells an apex from a subdomain, and points at the owner's github.io host in lower case", () => {
    expect(file(apex, "terraform.tfvars.json")).toMatchSnapshot("apex");
    expect(file(subdomain, "terraform.tfvars.json")).toMatchSnapshot("subdomain");
    expect(tfvars(serverlessPlan(PAGES), ctx())).toMatchObject({
      apex: false,
      github_owner: "example-org",
    });
    expect(tfvars(serverlessPlan(PAGES, { domain: "example.com" }), ctx())).toMatchObject({
      apex: true,
    });
  });

  it("keeps GitHub's verification record out of the site's root", () => {
    for (const f of [...apex, ...subdomain]) {
      expect(f.content, f.path).not.toMatch(/_github-pages-challenge|"TXT"|var\.verification/);
    }
  });

  it("refuses a plan that does not name the domain's zone: it decides the records", () => {
    expect(() => renderInfra(serverlessPlan(PAGES, { zone: null }), ctx())).toThrow(
      /zone \(dns\.zone\)/,
    );
  });
});

describe("renderPagesVerification", () => {
  const plan = serverlessPlan(PAGES);
  const files = renderPagesVerification(plan, ctx(), VERIFICATION);

  it("renders GitHub's verification record in a root of its own, beside the site's", () => {
    expect(pagesVerificationRootDir(plan)).toBe("opscrew/infra/github-pages-verification");
    expect(files.map((f) => f.path)).toEqual(
      ["versions.tf", "main.tf", "variables.tf", "terraform.tfvars.json"].map(
        (name) => `opscrew/infra/github-pages-verification/${name}`,
      ),
    );
    expect(files.every((f) => f.kind === "infra")).toBe(true);
    for (const name of ["main.tf", "variables.tf", "versions.tf"]) {
      expect(file(files, `verification/${name}`)).toMatchSnapshot(name);
    }
    expect(JSON.parse(file(files, "terraform.tfvars.json"))).toEqual({
      domain: "docs.example.com",
      cloudflare_zone_id: testCloudflare().zoneId,
      github_owner: "example-org",
      verification: VERIFICATION,
    });
  });

  it("names the record _github-pages-challenge-<owner>.<domain>, DNS only and quoted", () => {
    const record = block(
      file(files, "verification/main.tf"),
      'resource "cloudflare_dns_record" "verification"',
    );
    expect(record).toContain(
      'name    = "_github-pages-challenge-${var.github_owner}.${var.domain}"',
    );
    expect(record).toContain('type    = "TXT"');
    expect(record).toContain('content = "\\"${var.verification}\\""');
    expect(record).not.toContain("proxied = true");
  });

  it("follows the site's infra folder", () => {
    const moved = DeployPlanSchema.parse({ ...plan, infra: { ...plan.infra, dir: "ops/tf/site" } });
    expect(pagesVerificationRootDir(moved)).toBe("ops/tf/github-pages-verification");
  });

  it("needs the zone id", () => {
    expect(() =>
      renderPagesVerification(plan, ctx({ cloudflare: undefined }), VERIFICATION),
    ).toThrow(/zone id/);
  });
});

describe("the cloudflare-workers module", () => {
  const main = MODULE_FILES["cloudflare-workers/main.tf"] ?? "";
  const variables = MODULE_FILES["cloudflare-workers/variables.tf"] ?? "";
  const script = block(main, 'resource "cloudflare_workers_script" "this"');

  it("creates the shell with a placeholder that answers 503 until OpsCrew's first deploy", () => {
    expect(script).toMatch(/^ {2}main_module += "worker\.js"$/m);
    expect(script).toMatch(/^ {2}compatibility_date += "\d{4}-\d{2}-\d{2}"$/m);
    expect(script).toContain('return new Response("Not deployed yet", { status: 503 });');
    expect(script).toMatch(/^ {2}keep_assets += true$/m);
    expect(script).toMatch(/^ {2}keep_bindings += \["secret_text", "plain_text"\]$/m);
  });

  it("never updates the script, and replaces it when the Worker is renamed", () => {
    expect(script).toMatch(/^ {4}ignore_changes += all$/m);
    expect(script).toMatch(/^ {4}replace_triggered_by = \[terraform_data\.worker\]$/m);
    expect(block(main, 'resource "terraform_data" "worker"')).toBe("  input = var.worker");
  });

  it("puts no secret into the configuration or the state: no binding at all", () => {
    for (const [path, content] of Object.entries(MODULE_FILES)) {
      if (!path.startsWith("cloudflare-workers/")) continue;
      expect(content, path).not.toMatch(/^\s*bindings\s*=|secret_key|sensitive/m);
      // `secret_text` appears only as a binding type Wrangler's deploys keep.
      expect(content.match(/secret_text/g) ?? [], path).toHaveLength(
        path.endsWith("main.tf") ? 1 : 0,
      );
    }
  });

  it("turns the workers.dev address and the preview URLs on only when asked", () => {
    const subdomain = block(main, 'resource "cloudflare_workers_script_subdomain" "this"');
    expect(subdomain).toMatch(/^ {2}enabled += var\.workers_dev$/m);
    expect(subdomain).toMatch(/^ {2}previews_enabled = var\.preview_urls$/m);
    for (const name of ["workers_dev", "preview_urls"]) {
      expect(variables).toMatch(new RegExp(`variable "${name}" \\{[^}]*default {5}= false\\n\\}`));
    }
  });

  it("serves one custom domain per hostname: the domain, and www when on", () => {
    expect(main.match(/resource "cloudflare_workers_custom_domain"/g)).toHaveLength(2);
    const domain = block(main, 'resource "cloudflare_workers_custom_domain" "domain"');
    expect(domain).toMatch(/^ {2}hostname += var\.domain$/m);
    expect(domain).toMatch(/^ {2}service += cloudflare_workers_script\.this\.script_name$/m);
    const www = block(main, 'resource "cloudflare_workers_custom_domain" "www"');
    expect(www).toMatch(/^ {2}count += var\.www \? 1 : 0$/m);
    expect(www).toMatch(/^ {2}hostname += "www\.\$\{var\.domain\}"$/m);
    // Each custom domain creates its own DNS record.
    expect(main).not.toContain("cloudflare_dns_record");
  });
});

describe("the cloudflare-dns module's GitHub Pages mode", () => {
  const main = MODULE_FILES["cloudflare-dns/github-pages/main.tf"] ?? "";

  it("points an apex at GitHub Pages' four IPv4 and four IPv6 addresses", () => {
    for (const ip of ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"]) {
      expect(main).toContain(`"${ip}"`);
    }
    for (const ip of [
      "2606:50c0:8000::153",
      "2606:50c0:8001::153",
      "2606:50c0:8002::153",
      "2606:50c0:8003::153",
    ]) {
      expect(main).toContain(`"${ip}"`);
    }
    const a = block(main, 'resource "cloudflare_dns_record" "a"');
    expect(a).toMatch(/^ {2}for_each = var\.apex \? toset\(local\.ipv4\) : toset\(\[\]\)$/m);
    expect(a).toMatch(/^ {2}type {5}= "A"$/m);
    const aaaa = block(main, 'resource "cloudflare_dns_record" "aaaa"');
    expect(aaaa).toMatch(/^ {2}for_each = var\.apex \? toset\(local\.ipv6\) : toset\(\[\]\)$/m);
    expect(aaaa).toMatch(/^ {2}type {5}= "AAAA"$/m);
  });

  it("points a subdomain, and www when on, at <owner>.github.io with a CNAME", () => {
    expect(main).toMatch(/^ {2}github_io = "\$\{var\.owner\}\.github\.io"$/m);
    const cname = block(main, 'resource "cloudflare_dns_record" "cname"');
    expect(cname).toMatch(/^ {2}count {3}= var\.apex \? 0 : 1$/m);
    expect(cname).toMatch(/^ {2}name {4}= var\.domain$/m);
    expect(cname).toMatch(/^ {2}content = local\.github_io$/m);
    const www = block(main, 'resource "cloudflare_dns_record" "www"');
    expect(www).toMatch(/^ {2}count {3}= var\.www \? 1 : 0$/m);
    expect(www).toMatch(/^ {2}name {4}= "www\.\$\{var\.domain\}"$/m);
    expect(www).toMatch(/^ {2}content = local\.github_io$/m);
  });

  it("keeps every record DNS only, and writes no CAA or TXT record", () => {
    const records = main.match(/resource "cloudflare_dns_record"/g) ?? [];
    expect(records).toHaveLength(4);
    expect(main.match(/^ {2}proxied += false$/gm)).toHaveLength(4);
    expect(main).not.toMatch(/proxied += (true|var\.)/);
    expect(main).not.toMatch(/"CAA"|"TXT"/);
  });
});

describe("server roots", () => {
  it("vendor the server DNS module without the GitHub Pages mode", () => {
    for (const provider of ["hetzner", "digitalocean", "own"] as const) {
      const files = renderInfra(testPlan({ provider, domain: "shop.example.com" }), ctx());
      expect(
        files.filter((f) => f.path.includes("/cloudflare-dns/")).map((f) => f.path),
        provider,
      ).toEqual(
        ["main.tf", "outputs.tf", "variables.tf", "versions.tf"].map(
          (name) => `opscrew/infra/modules/cloudflare-dns/${name}`,
        ),
      );
    }
  });
});

describe("the server-less roots", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const rendered = () => [
    ...renderInfra(serverlessPlan(WORKERS, { www: true }), ctx()),
    ...renderInfra(serverlessPlan(PAGES, { domain: "example.com", www: true }), ctx()),
    ...renderPagesVerification(serverlessPlan(PAGES), ctx(), VERIFICATION),
  ];

  it("are deterministic and in the dialect both engines share", () => {
    expect(rendered()).toEqual(rendered());
    const tf = rendered().filter((f) => f.path.endsWith(".tf"));
    expect(checkDialect(tf.map((f) => ({ path: f.path, content: f.content })))).toEqual([]);
    for (const f of rendered()) expect(f.content.endsWith("\n"), f.path).toBe(true);
  });

  it("hold no token: the provider reads Cloudflare's from the environment", () => {
    const token = fakeSecret("cloudflare-token", "serverless-iac");
    const deployToken = fakeSecret("cloudflare-token", "serverless-deploy");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", token);
    vi.stubEnv("CLOUDFLARE_DEPLOY_TOKEN", deployToken);
    for (const f of rendered()) {
      expect(f.content, f.path).not.toContain(token);
      expect(f.content, f.path).not.toContain(deployToken);
      expect(f.content, f.path).not.toMatch(
        /(ghp_|github_pat_|sk-ant-|sk_live_|AKIA)[A-Za-z0-9]{8}|BEGIN [A-Z ]*PRIVATE KEY/,
      );
      // No token argument, variable or output that could carry one into a plan or the state.
      expect(f.content, f.path).not.toMatch(/api_token|sensitive/);
    }
  });
});

// Downloads the cloudflare provider from the registry, so it only runs with OPSCREW_IT=1. Binaries
// come from OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];
if (!runIt) {
  console.warn(
    "[iac-templates] skipping the server-less roots' validation: set OPSCREW_IT=1 (it downloads the cloudflare provider).",
  );
}
const NETWORK_ERROR =
  /dial tcp|no such host|i\/o timeout|connection (?:refused|reset)|network is unreachable|TLS handshake|context deadline exceeded|could not connect/i;

/** Each root, the folder it renders to, and what its offline plan creates and leaves out. */
const ROOTS = {
  "Cloudflare hosting": {
    files: () => renderInfra(serverlessPlan(WORKERS, { www: true }), ctx()),
    dir: "opscrew/infra/prod",
    creates: [
      "module.worker.terraform_data.worker",
      "module.worker.cloudflare_workers_script.this",
      "module.worker.cloudflare_workers_script_subdomain.this",
      "module.worker.cloudflare_workers_custom_domain.domain",
      "module.worker.cloudflare_workers_custom_domain.www[0]",
    ],
    absent: ["cloudflare_dns_record"],
  },
  "GitHub Pages on an apex": {
    files: () => renderInfra(serverlessPlan(PAGES, { domain: "example.com", www: true }), ctx()),
    dir: "opscrew/infra/prod",
    creates: [
      ...["108", "109", "110", "111"].map(
        (n) => `module.dns.cloudflare_dns_record.a["185.199.${n}.153"]`,
      ),
      ...["8000", "8001", "8002", "8003"].map(
        (n) => `module.dns.cloudflare_dns_record.aaaa["2606:50c0:${n}::153"]`,
      ),
      "module.dns.cloudflare_dns_record.www[0]",
    ],
    absent: ["cloudflare_dns_record.cname"],
  },
  "GitHub Pages on a subdomain": {
    files: () => renderInfra(serverlessPlan(PAGES), ctx()),
    dir: "opscrew/infra/prod",
    creates: ["module.dns.cloudflare_dns_record.cname[0]"],
    absent: [
      "cloudflare_dns_record.a[",
      "cloudflare_dns_record.aaaa[",
      "cloudflare_dns_record.www",
    ],
  },
  "GitHub Pages verification": {
    files: () => renderPagesVerification(serverlessPlan(PAGES), ctx(), VERIFICATION),
    dir: "opscrew/infra/github-pages-verification",
    creates: ["cloudflare_dns_record.verification"],
    absent: [],
  },
};

describe.skipIf(!runIt)("the server-less roots validate and plan (integration)", () => {
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    if (runIt && !engine)
      console.warn(`[iac-templates] skipping ${name}: no usable ${name} binary`);
    const bin = engine?.binary ?? name;
    // One folder per engine, so the provider is downloaded once; each root re-runs init.
    let root: Promise<string> | undefined;

    for (const [label, spec] of Object.entries(ROOTS)) {
      it.skipIf(!engine)(
        `validates and plans the ${label} root with ${name}, with no token in the plan`,
        async (test: TestContext) => {
          root ??= mkdtemp(join(tmpdir(), `opscrew-serverless-${name}-`));
          const dir = await root;
          for (const f of spec.files()) {
            const target = join(dir, f.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, f.content);
          }
          const cwd = join(dir, spec.dir);
          const token = fakeSecret("cloudflare-token", `${name}-${label}`);
          const env = { ...process.env, CLOUDFLARE_API_TOKEN: token };
          const runner = new NodeCommandRunner();
          const state = join(dir, `${label.replace(/\W+/g, "-")}.tfstate`);
          const init = await runner.run(
            bin,
            ["init", "-input=false", "-no-color", `-backend-config=path=${state}`, "-reconfigure"],
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
          expect(
            fmt.exitCode,
            `not formatted as ${name} fmt writes it:\n${fmt.stdout}${fmt.stderr}`,
          ).toBe(0);

          // Offline: local state, nothing refreshed, so the provider never calls Cloudflare.
          const planFile = `${state}.tfplan`;
          const plan = await runner.run(
            bin,
            [
              "plan",
              "-input=false",
              "-no-color",
              "-refresh=false",
              "-lock=false",
              `-out=${planFile}`,
            ],
            { cwd, env },
          );
          expect(plan.exitCode, plan.stdout + plan.stderr).toBe(0);
          for (const address of spec.creates) {
            expect(plan.stdout).toContain(`${address} will be created`);
          }
          expect(plan.stdout).toContain(
            `Plan: ${spec.creates.length} to add, 0 to change, 0 to destroy.`,
          );
          for (const address of spec.absent) expect(plan.stdout).not.toContain(address);
          const shown = await runner.run(bin, ["show", "-json", "-no-color", planFile], {
            cwd,
            env,
          });
          expect(shown.exitCode, shown.stderr).toBe(0);
          for (const output of [plan.stdout, plan.stderr, shown.stdout]) {
            expect(output).not.toContain(token);
          }
        },
        600_000,
      );
    }
  }
});
