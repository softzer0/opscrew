// biome-ignore-all lint/suspicious/noTemplateCurlyInString: HCL interpolation in rendered files, not JavaScript templates.
// Feature 028 (T2807): which of a root's resources are Cloudflare's and whose, the account's ids
// among its variables, and the DNS names its records and custom domains hold.
import { posix } from "node:path";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { CF_RANGES, testCloudflareAccount, testContext, testPlan } from "../__fixtures__/plans";
import { BESZEL_SUBDOMAIN, observabilityPlan } from "../addons/__fixtures__/plans";
import { renderHostingDns } from "../hosting/dns";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import type { RenderContext, RenderedFile } from "../types";
import {
  accountVariables,
  CLOUDFLARE_MODULE_NAMES,
  cloudflareAddressScope,
  opscrewRecordNames,
  workerCustomDomainAddresses,
} from "./cloudflare-move";
import { renderInfra, renderPagesVerification } from "./index";
import { renderBackups, renderStorage } from "./storage";

const ZONE = "example.com";

/** Account A's ids, as every other test renders them. */
const ctxA = (): RenderContext =>
  testContext({ cloudflare: testCloudflareAccount(), cloudflareRanges: CF_RANGES });

/** Account B: another zone (the same name), account and one-time PIN login. */
const ctxB = (): RenderContext =>
  testContext({
    cloudflare: {
      zoneId: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
      accountId: "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
      oneTimePinIdentityProviderId: "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2",
    },
    cloudflareRanges: CF_RANGES,
  });

const PORTAINER = {
  access: "subdomain",
  hostname: "portainer.example.com",
  allowedEmails: ["ops@example.com"],
} as const;

const SITE = {
  tool: "node",
  packageManager: "npm",
  nodeVersion: "24",
  command: "npm run build",
  outputDir: "dist",
} as const;

/** A site on `target` at `domain` in example.com. */
function sitePlan(target: Record<string, unknown>, domain: string, www: boolean): DeployPlan {
  const base = testPlan({ postgres: false });
  const pages = target.provider === "github-pages";
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: "example-app" },
    target,
    services: [],
    externalServices: [],
    dns: { provider: "cloudflare", domain, zone: ZONE, proxied: !pages, www },
    security: pages ? { wafCustomRules: false, httpAllowedFrom: "any" } : {},
  });
}

const WORKERS = {
  provider: "cloudflare-workers",
  mode: "workers-assets",
  worker: "example-app",
  render: "static",
  notFound: "single-page-application",
  site: SITE,
} as const;

const PAGES = { provider: "github-pages", mode: "pages-workflow", site: SITE } as const;

/** A PHP app on a cPanel account, its hostname on Cloudflare (DNS only). */
function hostingPlan(): DeployPlan {
  const base = testPlan({ domain: "notes.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    target: {
      provider: "hosting",
      panel: "cpanel",
      app: "php",
      webRoot: "public",
      php: { version: "8.3", via: "handler" },
    },
    services: [],
    externalServices: [],
    dns: { provider: "cloudflare", zone: ZONE, domain: "notes.example.com", proxied: false },
    security: { httpAllowedFrom: "any" },
  });
}

/** A cloud server whose files are in an R2 bucket and its snapshots' copies in another. */
function r2Plan(): DeployPlan {
  const base = testPlan({ domain: ZONE, www: true });
  return DeployPlanSchema.parse({
    ...base,
    storage: {
      objectStorage: {
        provider: "r2",
        bucket: "shop-uploads",
        region: "auto",
        cors: true,
        expected: { storageGb: 10, egressGbPerMonth: 50 },
        price: { monthly: 0, currency: "USD", source: "test", checkedOn: "2026-10-19" },
      },
    },
    snapshots: { offsite: { provider: "r2", bucket: "shop-backups" } },
  });
}

const portainer = (web: Record<string, unknown>, redeploy: "updater" | "cloudflare") =>
  portainerTestPlan({ web: web as never, redeploy, domain: ZONE, www: true });

/** A target and everything rendered for it: its main root, and its other roots. */
interface Case {
  name: string;
  plan: DeployPlan;
  render: (ctx: RenderContext) => RenderedFile[];
}

const main = (plan: DeployPlan) => (ctx: RenderContext) => renderInfra(plan, ctx);

const CASES: Case[] = [
  ...(["hetzner", "digitalocean", "contabo"] as const).map((provider) => {
    const plan = testPlan({ provider, domain: ZONE, www: true });
    return { name: `a ${provider} server`, plan, render: main(plan) };
  }),
  (() => {
    const plan = observabilityPlan(
      { beszel: BESZEL_SUBDOMAIN },
      { domain: ZONE, www: true, portainer: PORTAINER },
    );
    return {
      name: "a cloud server with Portainer and Beszel at subdomains",
      plan,
      render: main(plan),
    };
  })(),
  (() => {
    const plan = testPlan({ provider: "own", domain: ZONE, www: true });
    return { name: "an own server, public", plan, render: main(plan) };
  })(),
  (() => {
    const plan = observabilityPlan(
      { beszel: BESZEL_SUBDOMAIN },
      { provider: "own", access: "tunnel", domain: ZONE, www: true, portainer: PORTAINER },
    );
    return { name: "an own server through a tunnel", plan, render: main(plan) };
  })(),
  ...(
    [
      [{ mode: "tunnel" }, "updater"],
      [{ mode: "tunnel" }, "cloudflare"],
      [{ mode: "caddy", records: true }, "updater"],
      [{ mode: "caddy", records: true }, "cloudflare"],
      [{ mode: "caddy" }, "cloudflare"],
      [{ mode: "caddy" }, "updater"],
      [{ mode: "proxy", port: 8080 }, "cloudflare"],
    ] as const
  ).map(([web, redeploy]) => {
    const plan = portainer(web, redeploy);
    return { name: `Portainer, ${JSON.stringify(web)}, ${redeploy}`, plan, render: main(plan) };
  }),
  ...[true, false].map((www) => {
    const plan = sitePlan(WORKERS, "docs.example.com", www);
    return { name: `a Worker${www ? " with www" : ""}`, plan, render: main(plan) };
  }),
  ...(
    [
      [ZONE, true],
      ["docs.example.com", false],
    ] as const
  ).map(([domain, www]) => {
    const plan = sitePlan(PAGES, domain, www);
    return {
      name: `GitHub Pages at ${domain}`,
      plan,
      render: (ctx: RenderContext) => [
        ...renderInfra(plan, ctx),
        ...renderPagesVerification(plan, ctx, "0a1b2c3d4e5f60718293a4b5c6d7e8"),
      ],
    };
  }),
  (() => {
    const plan = hostingPlan();
    return {
      name: "a hosting account",
      plan,
      render: (ctx: RenderContext) => renderHostingDns(plan, ctx, "192.0.2.10"),
    };
  })(),
  (() => {
    const plan = r2Plan();
    return {
      name: "R2 storage and backups",
      plan,
      render: (ctx: RenderContext) => [
        ...renderInfra(plan, ctx),
        ...renderStorage(plan, ctx),
        ...renderBackups(plan, ctx),
      ],
    };
  })(),
];

/** A root among rendered files: its folder, `main.tf` and `terraform.tfvars.json`. */
interface Root {
  dir: string;
  main: string;
  tfvars: Record<string, unknown>;
}

function rootsOf(files: readonly RenderedFile[]): Root[] {
  return files
    .filter((f) => f.path.endsWith("/main.tf") && !f.path.includes("/modules/"))
    .map((f) => {
      const dir = posix.dirname(f.path);
      const tfvars = files.find((g) => g.path === `${dir}/terraform.tfvars.json`);
      if (tfvars === undefined) throw new Error(`${dir} has no terraform.tfvars.json`);
      return { dir, main: f.content, tfvars: JSON.parse(tfvars.content) };
    });
}

/** The `module` blocks of a root's `main.tf`: name, source folder (`cloudflare-dns`…) and text. */
function moduleCalls(main: string): { name: string; source: string; block: string }[] {
  return [
    ...main.matchAll(
      /^module "(\w+)" \{\n {2}source = "\.\.\/modules\/([^"]+)"\n([\s\S]*?)\n\}$/gm,
    ),
  ].map((m) => ({ name: m[1] as string, source: m[2] as string, block: m[3] as string }));
}

/** `resource` and `data` blocks at the top of an HCL file, as addresses. */
function blocks(hcl: string): string[] {
  return [...hcl.matchAll(/^(resource|data) "(\w+)" "(\w+)"/gm)].map(([, kind, type, name]) =>
    kind === "data" ? `data.${type}.${name}` : `${type}.${name}`,
  );
}

/** Every resource address of a root: its own, and those of the vendored modules it calls. */
function addressesOf(files: readonly RenderedFile[], root: Root) {
  const own = blocks(root.main).map((address) => ({ address, source: undefined }));
  const called = moduleCalls(root.main).flatMap(({ name, source }) => {
    const folder = posix.join(root.dir, "..", "modules", source);
    const inModule = files.filter(
      (f) => posix.dirname(f.path) === folder && f.path.endsWith(".tf"),
    );
    if (inModule.length === 0) throw new Error(`no vendored files for module ${name} (${source})`);
    return inModule.flatMap((f) =>
      blocks(f.content).map((address) => ({ address: `module.${name}.${address}`, source })),
    );
  });
  return [...own, ...called];
}

describe("cloudflareAddressScope", () => {
  it.each([
    ["module.dns.cloudflare_dns_record.a", "zone"],
    ['module.dns.cloudflare_dns_record.caa["letsencrypt.org"]', "zone"],
    ["module.dns.cloudflare_dns_record.www[0]", "zone"],
    ['module.tunnel.cloudflare_dns_record.route["www.example.com"]', "zone"],
    ["module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this", "account"],
    ["module.tunnel.data.cloudflare_zero_trust_tunnel_cloudflared_token.this", "account"],
    ["module.portainer_tunnel.cloudflare_zero_trust_tunnel_cloudflared_config.this", "account"],
    ["module.access.cloudflare_zero_trust_access_service_token.ssh[0]", "account"],
    ["module.worker.terraform_data.worker", "account"],
    ["module.worker.cloudflare_workers_custom_domain.www[0]", "account"],
    ["cloudflare_certificate_pack.previews", "zone"],
    ["cloudflare_dns_record.verification", "zone"],
    ["cloudflare_r2_bucket.this", "account"],
    ["cloudflare_r2_bucket_lifecycle.this", "account"],
    ["module.server.hcloud_server.this", undefined],
    ["module.server_previous.digitalocean_firewall.this", undefined],
    ["module.server.random_id.suffix", undefined],
    ["terraform_data.worker", undefined],
    ["random_password.x", undefined],
    ["hcloud_ssh_key.deploy", undefined],
    ["aws_s3_bucket.this", undefined],
  ])("%s is %s", (address, scope) => {
    expect(cloudflareAddressScope(address)).toBe(scope);
  });

  it("refuses what is not a resource address", () => {
    expect(() => cloudflareAddressScope("shop")).toThrow("isn't a resource address");
  });

  it("knows every resource of every target's roots", () => {
    const modules = new Set<string>();
    const seen = { zone: 0, account: 0, none: 0 };
    for (const c of CASES) {
      const files = c.render(ctxA());
      for (const root of rootsOf(files)) {
        for (const { address, source } of addressesOf(files, root)) {
          const name = address.startsWith("module.") ? address.split(".")[1] : undefined;
          const type = address
            .replace(/^module\.\w+\./, "")
            .replace(/^data\./, "")
            .split(".")[0];
          const cloudflare =
            source === undefined
              ? type?.startsWith("cloudflare_")
              : source.startsWith("cloudflare-");
          if (source?.startsWith("cloudflare-") && name !== undefined) modules.add(name);
          const expected = !cloudflare
            ? undefined
            : type === "cloudflare_dns_record" || type === "cloudflare_certificate_pack"
              ? "zone"
              : "account";
          expect(cloudflareAddressScope(address), `${c.name}: ${address}`).toBe(expected);
          seen[expected ?? "none"] += 1;
        }
      }
    }
    // Every Cloudflare module call the roots make is one of the list, and each is made.
    expect([...modules].sort()).toEqual([...CLOUDFLARE_MODULE_NAMES].sort());
    expect(seen.zone).toBeGreaterThan(0);
    expect(seen.account).toBeGreaterThan(0);
    expect(seen.none).toBeGreaterThan(0);
  });
});

describe("accountVariables", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s: another account's rendering differs only in its ids",
    (_name, c) => {
      const a = c.render(ctxA());
      const b = c.render(ctxB());
      expect(b.map((f) => f.path)).toEqual(a.map((f) => f.path));
      for (const [index, file] of a.entries()) {
        const other = b[index] as RenderedFile;
        if (!file.path.endsWith("/terraform.tfvars.json")) {
          expect(other.content, file.path).toBe(file.content);
          continue;
        }
        const values: Record<string, unknown> = JSON.parse(file.content);
        const otherValues: Record<string, unknown> = JSON.parse(other.content);
        const ids = accountVariables(values, ctxB());
        const differing = Object.keys(values).filter(
          (key) => JSON.stringify(values[key]) !== JSON.stringify(otherValues[key]),
        );
        expect(Object.keys(ids).sort(), file.path).toEqual(differing.sort());
        expect(differing.length, file.path).toBeGreaterThan(0);
        expect({ ...values, ...ids }, file.path).toEqual(otherValues);
        for (const value of Object.values(ids)) expect(typeof value).toBe("string");
      }
    },
  );

  it("names only the ids the root has", () => {
    expect(accountVariables({ app_name: "shop", cloudflare_zone_id: "z" }, ctxB())).toEqual({
      cloudflare_zone_id: "b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0",
    });
    expect(accountVariables({ bucket: "b" }, ctxB())).toEqual({});
  });

  it("refuses a setup without an id the root has", () => {
    const ctx = testContext({ cloudflare: { zoneId: "z" } });
    expect(() => accountVariables({ cloudflare_account_id: "a" }, ctx)).toThrow(
      "This configuration needs the Cloudflare account id.",
    );
    expect(() => accountVariables({ one_time_pin_identity_provider_id: "p" }, ctx)).toThrow(
      "one-time PIN login method",
    );
  });
});

/** An HCL expression's value: `true`/`false`, `var.x`, or a string with `${var.x}` in it. */
function resolve(expression: string, tfvars: Record<string, unknown>): unknown {
  if (expression === "true" || expression === "false") return expression === "true";
  const variable = /^var\.(\w+)$/.exec(expression);
  if (variable) {
    const name = variable[1] as string;
    if (!(name in tfvars)) throw new Error(`no value for var.${name}`);
    return tfvars[name];
  }
  const literal = /^"(.*)"$/.exec(expression);
  if (!literal) throw new Error(`can't read ${expression}`);
  return (literal[1] as string).replace(/\$\{var\.(\w+)\}/g, (_m, name: string) =>
    String(resolve(`var.${name}`, tfvars)),
  );
}

/** A module call's argument (`  name = value` at its top), or `undefined`. */
function argument(block: string, name: string): string | undefined {
  return new RegExp(`^ {2}${name} +=\\s+(.+)$`, "m").exec(block)?.[1];
}

/** The names a root's module calls give records or custom domains, read from its HCL. */
function namesInHcl(root: Root): string[] {
  const names: string[] = [];
  for (const { source, block } of moduleCalls(root.main)) {
    const value = (expression: string | undefined, fallback: unknown) =>
      expression === undefined ? fallback : resolve(expression, root.tfvars);
    if (source === "cloudflare-tunnel") {
      for (const m of block.matchAll(/\bhostname\s+=\s+(var\.\w+|"[^"]*")/g)) {
        names.push(value(m[1], undefined) as string);
      }
      continue;
    }
    if (!["cloudflare-dns", "cloudflare-dns/github-pages", "cloudflare-workers"].includes(source)) {
      continue;
    }
    if (
      source === "cloudflare-workers" &&
      value(argument(block, "custom_domains"), true) !== true
    ) {
      continue;
    }
    const domain = value(argument(block, "domain"), undefined) as string;
    names.push(domain);
    if (value(argument(block, "www"), false) === true) names.push(`www.${domain}`);
  }
  return names;
}

describe("opscrewRecordNames", () => {
  it.each(CASES.map((c) => [c.name, c] as const))(
    "%s: the names its roots' HCL gives",
    (_name, c) => {
      const fromHcl = rootsOf(c.render(ctxA())).flatMap(namesInHcl);
      expect(opscrewRecordNames(c.plan, ZONE)).toEqual([...new Set(fromHcl)].sort());
    },
  );

  it("names a tunnel's hostnames and the webhook's", () => {
    const byName = Object.fromEntries(CASES.map((c) => [c.name, c.plan]));
    expect(
      opscrewRecordNames(byName["an own server through a tunnel"] as DeployPlan, ZONE),
    ).toEqual([
      "beszel.example.com",
      "example.com",
      "portainer.example.com",
      "ssh-shop.example.com",
      "www.example.com",
    ]);
    expect(
      opscrewRecordNames(byName['Portainer, {"mode":"caddy"}, cloudflare'] as DeployPlan, ZONE),
    ).toEqual(["portainer-shop.example.com"]);
    expect(opscrewRecordNames(byName["a hosting account"] as DeployPlan, ZONE)).toEqual([
      "notes.example.com",
    ]);
  });

  it("puts the app in the zone given", () => {
    const plan = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.org" });
    expect(opscrewRecordNames(plan, "example.org")).toEqual([
      "shop.example.org",
      "ssh-shop.example.org",
    ]);
  });

  it("has none without a domain on Cloudflare", () => {
    expect(opscrewRecordNames(testPlan(), ZONE)).toEqual([]);
  });
});

describe("workerCustomDomainAddresses", () => {
  it("names the Worker's custom domains in its root", () => {
    const plan = sitePlan(WORKERS, "docs.example.com", true);
    const domains = workerCustomDomainAddresses(plan);
    expect(domains).toEqual([
      {
        address: "module.worker.cloudflare_workers_custom_domain.domain[0]",
        hostname: "docs.example.com",
      },
      {
        address: "module.worker.cloudflare_workers_custom_domain.www[0]",
        hostname: "www.docs.example.com",
      },
    ]);
    const files = renderInfra(plan, ctxA());
    const [root] = rootsOf(files);
    const addresses = addressesOf(files, root as Root).map((a) => a.address);
    for (const { address } of domains) {
      expect(addresses).toContain(address.replace(/\[0\]$/, ""));
      expect(cloudflareAddressScope(address)).toBe("account");
    }
    expect(domains.map((d) => d.hostname)).toEqual(opscrewRecordNames(plan, ZONE));
  });

  it("has only the domain without www, and none on another target", () => {
    expect(workerCustomDomainAddresses(sitePlan(WORKERS, "docs.example.com", false))).toEqual([
      {
        address: "module.worker.cloudflare_workers_custom_domain.domain[0]",
        hostname: "docs.example.com",
      },
    ]);
    expect(workerCustomDomainAddresses(sitePlan(PAGES, ZONE, true))).toEqual([]);
    expect(workerCustomDomainAddresses(testPlan({ domain: ZONE }))).toEqual([]);
  });
});
