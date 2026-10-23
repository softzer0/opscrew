import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResourceChange } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, type Site, writeArtifact } from "@opscrew/plan-schema";

/** A Vite single-page app built with npm, as detection reports it. */
export const NPM_SITE = {
  tool: "node",
  packageManager: "npm",
  nodeVersion: "24",
  command: "npm run build",
  outputDir: "dist",
} as const satisfies Site;

/** Astro with `@astrojs/cloudflare` (016's spike, result 6). */
export const ASTRO_SSR_SITE = {
  ...NPM_SITE,
  outputDir: "dist/client",
  entry: "dist/server/entry.mjs",
} as const satisfies Site;

export interface SitePlanOptions {
  /** Default Cloudflare's hosting. */
  provider?: "cloudflare-workers" | "github-pages";
  /** Cloudflare: server rendering (Astro with its adapter) or static files (default). */
  render?: "static" | "ssr";
  /** Default `docs.example.com`, a subdomain of the zone `example.com`. */
  domain?: string;
  www?: boolean;
  /** The app's variables, by name: secret values the user gives. */
  env?: readonly string[];
  /** A named environment: its app name is `<app>-<env>`. */
  environment?: string;
  /** Deployed by `opscrew promote` from this environment. */
  promotedFrom?: string;
  notFound?: "single-page-application" | "404-page" | "none";
  workersDev?: boolean;
  /** The app's name (default `example-app`) and the Worker's. */
  name?: string;
  /** Recorded as applied, as provision leaves it. */
  deployed?: boolean;
}

/** A plan on a server-less target as design writes it (a static npm site on Cloudflare by default). */
export function sitePlan(o: SitePlanOptions = {}): DeployPlan {
  const provider = o.provider ?? "cloudflare-workers";
  const base = o.name ?? "example-app";
  const name = o.environment === undefined ? base : `${base}-${o.environment}`;
  const ssr = o.render === "ssr";
  const pages = provider === "github-pages";
  const target = pages
    ? { provider, mode: "pages-workflow", site: NPM_SITE }
    : {
        provider,
        mode: "workers-assets",
        worker: name,
        render: o.render ?? "static",
        notFound: o.notFound ?? (ssr ? "none" : "single-page-application"),
        ...(o.workersDev === undefined ? {} : { workersDev: o.workersDev }),
        site: ssr ? ASTRO_SSR_SITE : NPM_SITE,
      };
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-10-23T12:00:00.000Z",
    updatedAt: "2026-10-23T12:00:00.000Z",
    ...(o.environment === undefined && o.promotedFrom === undefined
      ? {}
      : {
          environment: {
            ...(o.environment === undefined ? {} : { name: o.environment }),
            ...(o.promotedFrom === undefined
              ? {}
              : { deploySource: { from: "promote", source: o.promotedFrom } }),
          },
        }),
    app: {
      name,
      port: 3000,
      buildContext: ".",
      env: (o.env ?? []).map((variable) => ({ name: variable, secret: true, source: "user" })),
    },
    target,
    processes: { workers: [], cron: [] },
    externalServices: [],
    cost: {
      monthly: { amount: 0, currency: "USD" },
      breakdown: [],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-23T00:00:00.000Z",
    },
    codeChanges: [],
    infra: { engine: "tofu" },
    dns: {
      provider: "cloudflare",
      domain: o.domain ?? "docs.example.com",
      zone: "example.com",
      proxied: !pages,
      www: o.www ?? false,
    },
    cicd: {
      provider: "github-actions",
      registry: "ghcr",
      branch: "main",
      ...(o.environment === undefined
        ? {}
        : { workflowPath: `.github/workflows/opscrew-deploy-${o.environment}.yml` }),
    },
    security: { wafCustomRules: !pages },
    ...(o.deployed === true ? { deployment: { lastApplyAt: "2026-10-23T11:00:00.000Z" } } : {}),
  });
}

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

/** What the first apply of a Cloudflare hosting root creates: the Worker's shell and its domains. */
export function workerCreate(plan: Pick<DeployPlan, "dns">): ResourceChange[] {
  return [
    ["terraform_data", "worker"],
    ["cloudflare_workers_script", "this"],
    ["cloudflare_workers_script_subdomain", "this"],
    ["cloudflare_workers_custom_domain", "domain"],
    ...(plan.dns.www ? [["cloudflare_workers_custom_domain", "www"]] : []),
  ].map(([type, name]) => ({
    address: `module.worker.${type}.${name}`,
    type: type as string,
    name: name as string,
    provider: type === "terraform_data" ? "terraform.io/builtin/terraform" : CLOUDFLARE_PROVIDER,
    action: "create" as const,
  }));
}

/** `show -json` of a Cloudflare hosting root's first plan (no secret anywhere in it). */
export function workerPlanJson(plan: DeployPlan): unknown {
  const worker = plan.target.provider === "cloudflare-workers" ? plan.target.worker : "";
  return {
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.worker",
            resources: [
              {
                address: "module.worker.cloudflare_workers_script.this",
                mode: "managed",
                type: "cloudflare_workers_script",
                name: "this",
                values: { script_name: worker, main_module: "worker.js" },
              },
              {
                address: "module.worker.cloudflare_workers_custom_domain.domain",
                mode: "managed",
                type: "cloudflare_workers_custom_domain",
                name: "domain",
                values: { hostname: plan.dns.domain, service: worker },
              },
            ],
          },
        ],
      },
    },
    resource_changes: [],
  };
}

/**
 * A git project of a static site with no Dockerfile, its `origin` on GitHub (`acme/shop`, pushes
 * go to a bare repository), and `plan` written to `opscrew/plan.yaml`.
 */
export async function createSiteProject(plan: DeployPlan) {
  const runner = new NodeCommandRunner();
  const root = await mkdtemp(join(tmpdir(), "opscrew-site-"));
  const bare = await mkdtemp(join(tmpdir(), "opscrew-site-remote-"));
  const git = async (cwd: string, ...args: string[]) => {
    const result = await runner.run("git", ["-C", cwd, ...args]);
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git(bare, "init", "--bare", "-b", "main");
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpsCrew Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgsign", "false");
  await git(root, "remote", "add", "origin", "https://github.com/acme/shop.git");
  await git(root, "remote", "set-url", "--push", "origin", bare);
  await writeFile(join(root, "index.html"), "<!doctype html><title>example-app</title>\n");
  await writeFile(join(root, ".gitignore"), ".opscrew/\n.env\n");
  await git(root, "add", "index.html", ".gitignore");
  await git(root, "commit", "-m", "init");
  await writeArtifact("plan", join(root, "opscrew", "plan.yaml"), plan);
  return { root, bare, git };
}
