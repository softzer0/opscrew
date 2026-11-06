// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are HCL interpolation, not JavaScript templates.
import { OpsCrewError } from "@opscrew/core";
import type { CloudflareWorkersDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import { wrongTarget } from "../providers";
import type { RenderContext, RenderedFile, SiteLayout } from "../types";
import { planFilePath } from "../workflow/shared";
import { accountId, WWW_VARIABLE, zoneTfvars, zoneVariables } from "./cloudflare";
import {
  besideInfraDir,
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_PROVIDER_BLOCK,
  moduleBlock,
  output,
  type RootFiles,
  rootHeader,
  type VariableSpec,
  variablesTf,
  versionsTf,
} from "./hcl";

const GITHUB_OWNER_VARIABLE: VariableSpec = {
  name: "github_owner",
  type: "string",
  description:
    "GitHub account that owns the repository, in lower case: its GitHub Pages host is <owner>.github.io.",
};

/** The repository's owner in lower case, as DNS names and Cloudflare's records carry it. */
function githubOwner(ctx: RenderContext): string {
  return ctx.github.owner.toLowerCase();
}

/** A host of a site's root: its module call, variables, values and vendored module. */
interface SiteHost {
  /** The module's name in the root (`worker`, `dns`), which the `url` output follows. */
  name: string;
  module: string[];
  variables: VariableSpec[];
  tfvars: Record<string, unknown>;
  /** The vendored module it uses. */
  source: string;
}

/**
 * `module "worker"` (`cloudflare-workers`) for `target`: the Worker's shell and, unless `shell`,
 * one custom domain per hostname (the domain, and `www.` when on), which bring their own DNS
 * records and certificates. Needs `ctx.cloudflare.accountId`.
 */
function workerHost(
  target: CloudflareWorkersDeployTarget,
  ctx: RenderContext,
  shell: boolean,
): SiteHost {
  return {
    name: "worker",
    source: "cloudflare-workers",
    module: moduleBlock({
      comment: [
        "# The app on Cloudflare's hosting: a Worker with the site's files, and a custom domain for each",
        "# hostname. This configuration creates the Worker's shell once; OpsCrew's deploy workflow",
        "# uploads its code, files and secrets with Wrangler, and its settings are in the Wrangler config.",
        ...(shell
          ? [
              "# During the move GitHub Pages holds the hostnames, so the Worker has no custom domains.",
            ]
          : []),
      ],
      name: "worker",
      source: "cloudflare-workers",
      args: [
        ["account_id", "var.cloudflare_account_id"],
        ["zone_id", "var.cloudflare_zone_id"],
        ["worker", "var.worker"],
        ["domain", "var.domain"],
        ["www", "var.www"],
        ["workers_dev", "var.workers_dev"],
        ["preview_urls", "var.preview_urls"],
        ...(shell ? ([["custom_domains", "false"]] as const) : []),
      ],
    }),
    variables: [
      {
        name: "cloudflare_account_id",
        type: "string",
        description: "Cloudflare account id (the Worker belongs to it).",
      },
      {
        name: "worker",
        type: "string",
        description: "Name of the Worker, unique in the Cloudflare account.",
      },
      {
        name: "workers_dev",
        type: "bool",
        description: "Serve the Worker on its workers.dev address.",
      },
      {
        name: "preview_urls",
        type: "bool",
        description: "Give each version of the Worker its own preview URL.",
      },
    ],
    tfvars: {
      cloudflare_account_id: accountId(ctx),
      worker: target.worker,
      workers_dev: target.workersDev,
      preview_urls: target.previewUrls,
    },
  };
}

/**
 * True when the site's domain is its zone's apex (A and AAAA records), false for a subdomain (a
 * CNAME). Throws when the plan does not name the zone.
 */
function onApex(plan: DeployPlan): boolean {
  const { domain, zone } = plan.dns;
  if (zone === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "GitHub Pages needs the domain's Cloudflare zone (dns.zone) in the plan: an apex domain gets A and AAAA records, a subdomain a CNAME.",
      {
        hint: `Set dns.zone in ${planFilePath(plan)} to the domain's zone on Cloudflare, for example example.com, or run \`opscrew design\` again, then run the command again.`,
      },
    );
  }
  return domain === zone;
}

/**
 * `module "dns"`, the `cloudflare-dns` module's GitHub Pages mode (`cloudflare-dns/github-pages`),
 * all DNS only. With `afterWorker` its records wait for `module "worker"`'s changes
 * (`depends_on`), so when the hostnames move to GitHub Pages the custom domains go first.
 */
function pagesHost(plan: DeployPlan, ctx: RenderContext, afterWorker: boolean): SiteHost {
  return {
    name: "dns",
    source: "cloudflare-dns/github-pages",
    module: moduleBlock({
      comment: [
        "# The site on GitHub Pages: its DNS records, all DNS only, since Cloudflare's proxy would stop",
        "# GitHub from issuing and renewing the site's certificate. GitHub's domain verification record",
        `# has a root of its own (${pagesVerificationRootDir(plan)}), so destroying this one keeps it.`,
        ...(afterWorker
          ? [
              "# The records wait for the Worker: when they take the hostnames, its custom domains go first.",
            ]
          : []),
      ],
      name: "dns",
      source: "cloudflare-dns/github-pages",
      args: [
        ["zone_id", "var.cloudflare_zone_id"],
        ["domain", "var.domain"],
        ["apex", "var.apex"],
        ["owner", "var.github_owner"],
        ["www", "var.www"],
      ],
      ...(afterWorker ? { body: ["  depends_on = [module.worker]"] } : {}),
    }),
    variables: [
      {
        name: "apex",
        type: "bool",
        description: "The domain is the zone's apex (A and AAAA records) rather than a subdomain.",
      },
      GITHUB_OWNER_VARIABLE,
    ],
    tfvars: { apex: onApex(plan), github_owner: githubOwner(ctx) },
  };
}

/**
 * A site's root from its `hosts`, the `url` output following `live` (the host that holds the
 * hostnames); `note` goes below the header.
 */
function siteRoot(
  plan: DeployPlan,
  ctx: RenderContext,
  hosts: readonly SiteHost[],
  live: SiteHost,
  note: readonly string[] = [],
): RootFiles {
  return {
    versions: versionsTf(plan, [CLOUDFLARE_PROVIDER]),
    main: [
      rootHeader(plan),
      "",
      ...(note.length > 0 ? [...note, ""] : []),
      ...CLOUDFLARE_PROVIDER_BLOCK,
      ...hosts.flatMap((host) => host.module),
    ].join("\n"),
    variables: variablesTf(plan, [
      ...zoneVariables("domain"),
      WWW_VARIABLE,
      ...hosts.flatMap((host) => host.variables),
    ]),
    outputs: [rootHeader(plan), "", ...output("url", `module.${live.name}.url`)].join("\n"),
    tfvars: Object.assign(
      { ...zoneTfvars(plan, ctx, "domain"), www: plan.dns.www },
      ...hosts.map((host) => host.tfvars),
    ),
    modules: hosts.map((host) => host.source),
  };
}

/** The root of one host: the plan's site without a move. */
function singleHostRoot(plan: DeployPlan, ctx: RenderContext, host: SiteHost): RootFiles {
  return siteRoot(plan, ctx, [host], host);
}

/**
 * The root module of an app on Cloudflare's hosting: `module "worker"` (`cloudflare-workers`)
 * creates the Worker's shell and one custom domain per hostname (the domain, and `www.` when on),
 * which bring their own DNS records and certificates. The deploy workflow owns the Worker's code,
 * files, secrets and settings; this root never changes them. `target` is the plan's target. Needs
 * `ctx.cloudflare.accountId`.
 */
function workersRoot(
  plan: DeployPlan,
  target: CloudflareWorkersDeployTarget,
  ctx: RenderContext,
): RootFiles {
  return singleHostRoot(plan, ctx, workerHost(target, ctx, false));
}

/**
 * The root module of a site on GitHub Pages: only `module "dns"`, the `cloudflare-dns` module's
 * GitHub Pages mode (`cloudflare-dns/github-pages`), all DNS only. GitHub's domain verification
 * record has a root of its own ({@link renderPagesVerification}), so destroying this one keeps it.
 */
function pagesRoot(plan: DeployPlan, ctx: RenderContext): RootFiles {
  return singleHostRoot(plan, ctx, pagesHost(plan, ctx, false));
}

/** The Worker of a move between site hosts: the plan's target, else the move's old side. */
function movingWorker(plan: DeployPlan): CloudflareWorkersDeployTarget {
  if (plan.target.provider === "cloudflare-workers") return plan.target;
  const from = plan.retarget?.from.target;
  if (from?.provider === "cloudflare-workers") return from;
  throw wrongTarget("A site move's root renders a Worker only when one side of the move is one.");
}

/**
 * The root module of a move between Cloudflare's hosting and GitHub Pages (`layout`), in one root
 * and state, so one plan moves the hostnames from one host to the other: the Worker
 * (`module "worker"`, the plan's or the old side's) with its custom domains (`bound`) or as a shell
 * without them (`shell`), and GitHub Pages' DNS records (`module "dns"`), which wait for the
 * Worker's changes when both are there. The Worker `bound` alone renders the plain Worker root
 * under the move's note. Throws when both hosts would hold the hostnames, or neither is rendered.
 */
function siteMoveRoot(plan: DeployPlan, layout: SiteLayout, ctx: RenderContext): RootFiles {
  const { worker, pages = false } = layout;
  if (worker === "bound" && pages) {
    throw wrongTarget(
      "A site move's root cannot give the hostnames to both the Worker and GitHub Pages.",
    );
  }
  const workers =
    worker === undefined ? [] : [workerHost(movingWorker(plan), ctx, worker === "shell")];
  const records = pages ? [pagesHost(plan, ctx, worker !== undefined)] : [];
  const live = worker === "bound" ? workers[0] : (records[0] ?? workers[0]);
  if (live === undefined) {
    throw wrongTarget("A site move's root renders neither the Worker nor GitHub Pages.");
  }
  return siteRoot(plan, ctx, [...workers, ...records], live, [
    "# A move to another site host is in progress: `opscrew retarget` manages these files until the",
    "# move is finished (`opscrew retarget --finish`) or aborted (`opscrew retarget --abort`).",
  ]);
}

/**
 * The root module of a site: both hosts' during a move between site hosts (`ctx.siteLayout`,
 * {@link siteMoveRoot}), else the plan's target's ({@link workersRoot}, {@link pagesRoot});
 * `undefined` for a plan on another target.
 */
export function siteRootModule(plan: DeployPlan, ctx: RenderContext): RootFiles | undefined {
  if (ctx.siteLayout !== undefined) return siteMoveRoot(plan, ctx.siteLayout, ctx);
  const { target } = plan;
  if (target.provider === "cloudflare-workers") return workersRoot(plan, target, ctx);
  if (target.provider === "github-pages") return pagesRoot(plan, ctx);
  return undefined;
}

/**
 * The folder of GitHub's domain verification record's root, beside `plan.infra.dir`:
 * `opscrew/infra/github-pages-verification` for the repository's first app,
 * `opscrew/infra/github-pages-verification-<key>` for a further app, whose state is its own.
 * GitHub Pages has one site per repository, so an app has one such root for its environments.
 */
export function pagesVerificationRootDir(plan: Pick<DeployPlan, "app" | "infra">): string {
  const key = plan.app.key;
  return besideInfraDir(plan, `github-pages-verification${key === undefined ? "" : `-${key}`}`);
}

/**
 * The name of GitHub's domain verification record for `domain`, `_github-pages-challenge-<owner>.<domain>`
 * with the owner in lower case, as GitHub's settings page names it.
 */
export function verificationRecordName(owner: string, domain: string): string {
  return `_github-pages-challenge-${owner.toLowerCase()}.${domain}`;
}

/**
 * The root of GitHub's domain verification record for a site on GitHub Pages
 * ({@link pagesVerificationRootDir}): one DNS-only TXT record `_github-pages-challenge-<owner>.<domain>`
 * holding `verification`, the value GitHub's verification page shows (not a secret: it is public in
 * DNS). Kept in a root of its own, so destroying the site's root keeps the domain verified; only an
 * explicit request destroys it. Deterministic; contains no secrets.
 */
export function renderPagesVerification(
  plan: DeployPlan,
  ctx: RenderContext,
  verification: string,
): RenderedFile[] {
  if (!ctx.cloudflare?.zoneId) {
    throw new Error("A Cloudflare zone id is required to render DNS for this plan.");
  }
  const dir = pagesVerificationRootDir(plan);
  const main = [
    rootHeader(plan),
    "",
    ...CLOUDFLARE_PROVIDER_BLOCK,
    "# GitHub's domain verification record for the site's domain, quoted as Cloudflare takes TXT",
    "# content. It has a root of its own, so destroying the site keeps the domain verified for the",
    "# GitHub account.",
    'resource "cloudflare_dns_record" "verification" {',
    "  zone_id = var.cloudflare_zone_id",
    '  name    = "_github-pages-challenge-${var.github_owner}.${var.domain}"',
    '  type    = "TXT"',
    '  content = "\\"${var.verification}\\""',
    "  ttl     = 1",
    "  proxied = false",
    '  comment = "Managed by OpsCrew"',
    "}",
    "",
  ];
  const variables = variablesTf(plan, [
    ...zoneVariables("domain"),
    GITHUB_OWNER_VARIABLE,
    {
      name: "verification",
      type: "string",
      description:
        "The value of GitHub's verification record, from the GitHub account's Pages settings (public in DNS, not a secret).",
    },
  ]);
  const values = {
    ...zoneTfvars(plan, ctx, "domain"),
    github_owner: githubOwner(ctx),
    verification,
  };
  return [
    { path: `${dir}/versions.tf`, content: versionsTf(plan, [CLOUDFLARE_PROVIDER]), kind: "infra" },
    { path: `${dir}/main.tf`, content: main.join("\n"), kind: "infra" },
    { path: `${dir}/variables.tf`, content: variables, kind: "infra" },
    {
      path: `${dir}/terraform.tfvars.json`,
      content: `${JSON.stringify(values, null, 2)}\n`,
      kind: "infra",
    },
  ];
}
