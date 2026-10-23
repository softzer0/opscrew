/**
 * Design for the server-less targets (feature 016, FR-1602, FR-1605, SC-1606): whether Cloudflare's
 * hosting or GitHub Pages fits the app, and why not in one sentence; the single design option,
 * priced from the provider's published plans with their source and listing the limits; the plan's
 * target with its site block; and the code changes and warnings these targets bring.
 */
import type { PagesAllowed } from "@opscrew/connector-github";
import { formatMoney, listText, OpsCrewError, plural } from "@opscrew/core";
import { detectSite, isClientExposed, type SiteDetection } from "@opscrew/detect";
import {
  CostEstimateSchema,
  type DeployPlan,
  type DesignOption,
  DesignOptionSchema,
  likelyCloudflareZone,
  type ProjectFacts,
  type Requirements,
  type ServerlessProvider,
  type ServiceKind,
  type Site,
} from "@opscrew/plan-schema";
import { frameworkName } from "../analyze/summary";
import type { PhaseDeps } from "../context";
import { providerProfile } from "../providers";
import { serverlessName } from "../shared";
import { reasonOf } from "../shared/errors";
import { githubClientFromToken } from "../shared/github";
import { type CodeChange, under } from "./code-changes";
import { selfHostedServices } from "./components";
import { convertMoney } from "./cost";

/** What design learned for a server-less target, which the plan's target is written from. */
export interface ServerlessDesignChoice {
  provider: ServerlessProvider;
  site: SiteDetection;
  /** The Node.js version the deploy job builds a `node` site with. */
  nodeVersion?: string;
}

/** Why a server-less target does not fit the app, and what to do instead. */
export interface ServerlessMisfit {
  /** One clause: why, for "<target> is not offered for this app: <reason>." */
  reason: string;
  /** The next step, as one or more sentences. */
  fix: string;
}

const CHOOSE_SERVER = "Choose a server target with `opscrew interview`.";

/**
 * Why GitHub Pages is not available for a private repository whose owner's plan has no Pages for
 * it (`pagesAllowed` "no"), and what to do instead: said by design and by `opscrew init`.
 */
export const PAGES_NOT_ALLOWED: Readonly<ServerlessMisfit> = {
  reason:
    "the repository is private, and its owner's GitHub plan has GitHub Pages for public repositories only",
  fix: "Make the repository public, or move to GitHub Pro, Team or Enterprise (the site is public even then); or choose Cloudflare hosting with `opscrew interview`.",
};

/** The frameworks whose Cloudflare adapter OpsCrew sets up, in a sentence. */
const SUPPORTED_ADAPTERS =
  "it sets up those of Astro, Next.js (through OpenNext), Nuxt and SvelteKit";

/** Why there is no site to publish, from what the app is. */
function noSite(facts: ProjectFacts, name: string): ServerlessMisfit {
  const names = [...new Set(facts.frameworks.map((f) => frameworkName(f.name)))];
  const built = names.length === 0 ? "" : ` (${listText(names)})`;
  const reason =
    facts.appKind === "api" || facts.appKind === "fullstack"
      ? `the app runs its own server${built}, and ${name} publishes sites, not servers`
      : facts.appKind === "worker"
        ? `the app is a background worker${built}, which needs a server`
        : "OpsCrew finds no site to publish in it: no framework it builds, no Hugo config and no folder with an index.html";
  return { reason, fix: CHOOSE_SERVER };
}

/**
 * Why `provider` does not fit the app, or `undefined` when it does: the app is no site
 * (`site` undefined); something needs a server (a process that keeps running, a service OpsCrew
 * runs next to the app unless `keep` keeps it hosted, cron jobs, SQLite, a bucket OpsCrew creates);
 * GitHub Pages and server rendering; server rendering without a Cloudflare adapter OpsCrew sets up;
 * a node site without a build script; or no folder to publish.
 */
function serverlessMisfit(
  provider: ServerlessProvider,
  facts: ProjectFacts,
  site: SiteDetection | undefined,
  keep: Requirements["keepExternalServices"],
): ServerlessMisfit | undefined {
  const name = serverlessName(provider);
  if (site === undefined) return noSite(facts, name);
  const need = site.serverNeeds[0];
  if (need !== undefined) {
    return {
      reason: `the app needs a server process that keeps running for ${need}, and ${name} runs none`,
      fix: CHOOSE_SERVER,
    };
  }
  const service = selfHostedServices(facts, keep)[0];
  if (service !== undefined) {
    return {
      reason: `the app uses ${service.title}, which OpsCrew runs on a server, and ${name} has none`,
      fix: `Keep a hosted ${service.title} the app reaches by URL (answer keepExternalServices.${service.kind}: true in \`opscrew interview\`), or choose a server target there.`,
    };
  }
  const server = (reason: string, fix = CHOOSE_SERVER) => ({
    reason: `${reason}, and ${name} has no server`,
    fix,
  });
  if (facts.cronJobs !== undefined)
    return server("the app's cron jobs (vercel.json) run on a server");
  if (facts.sqlite !== undefined) {
    return server("the app keeps its data in SQLite, whose file needs a server's disk");
  }
  if (facts.objectStorage !== undefined && keep.s3 === false) {
    return server(
      "the bucket OpsCrew would create for the app's files gives its keys to the app on a server",
      "Keep the storage the app uses now (answer keepExternalServices.s3: true in `opscrew interview`), or choose a server target there.",
    );
  }
  if (site.render === "ssr") {
    const framework = frameworkName(site.framework ?? "the framework");
    if (provider === "github-pages") {
      return {
        reason: `GitHub Pages serves static files only, and ${framework} renders the app's pages on the server`,
        fix: "Choose Cloudflare hosting, which runs server-rendered apps, or a server target, with `opscrew interview`.",
      };
    }
    if (site.adapter === undefined) {
      return {
        reason: `${framework} has no Cloudflare adapter OpsCrew sets up (${SUPPORTED_ADAPTERS})`,
        fix: CHOOSE_SERVER,
      };
    }
  }
  if (site.tool === "node" && site.command === undefined) {
    return {
      reason: `${under(site.dir, "package.json")} has no build script, which builds the site`,
      fix: "Add a build script that writes the site's files to a folder of their own, then run `opscrew analyze` and `opscrew design` again.",
    };
  }
  if (site.outputDir === undefined) {
    return site.tool === "none"
      ? {
          reason: `the site's files are at the repository root, so ${name} would publish the whole repository (opscrew/, .github/ and everything else) with them`,
          fix: "Move the site's files into a folder of their own, such as public/, then run `opscrew analyze` and `opscrew design` again.",
        }
      : { reason: "OpsCrew cannot tell which folder the site's build writes", fix: CHOOSE_SERVER };
  }
  return undefined;
}

/**
 * Why the interview's domain answers do not fit `provider`, or `undefined`: both targets serve the
 * site on the user's domain, with its DNS on Cloudflare (`opscrew domain connect` moves it there).
 */
function domainMisfit(
  provider: ServerlessProvider,
  requirements: Pick<Requirements, "domain" | "dnsProvider">,
): ServerlessMisfit | undefined {
  const name = serverlessName(provider);
  const { domain } = requirements;
  if (domain === undefined) {
    return {
      reason: `${name} serves the site on a domain of yours whose DNS is on Cloudflare, and you have not given one`,
      fix: "Give the domain in `opscrew interview` (`opscrew domain buy` buys one), then run `opscrew design` again.",
    };
  }
  if (requirements.dnsProvider === "cloudflare") return undefined;
  const zone = likelyCloudflareZone(domain);
  return {
    reason: `${name} needs the DNS of ${domain} on Cloudflare, and it is managed elsewhere`,
    fix: `Move it to Cloudflare with \`opscrew domain connect ${zone}\` (it copies the records into a Cloudflare zone first and asks before switching), answer cloudflare for the DNS in \`opscrew interview\`, then run \`opscrew design\` again.`,
  };
}

/** The plain refusal of design for a target that does not fit, naming why. */
function refusal(provider: ServerlessProvider, misfit: ServerlessMisfit): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `${serverlessName(provider)} is not offered for this app: ${misfit.reason}. Nothing was written.`,
    { hint: misfit.fix },
  );
}

/**
 * The server-less targets that fit the app (each `serverlessMisfit` free), for the interview's
 * provider question, from the facts, the app's files below `root` and the answers on hosted
 * services (`keep`).
 */
export async function serverlessTargetsFor(
  root: string,
  facts: ProjectFacts,
  keep: Requirements["keepExternalServices"],
): Promise<ServerlessProvider[]> {
  const site = await detectSite(root, facts);
  return (["cloudflare-workers", "github-pages"] as const).filter(
    (provider) => serverlessMisfit(provider, facts, site, keep) === undefined,
  );
}

/** Whether GitHub allows Pages for the repository, and why OpsCrew cannot tell when it cannot. */
export interface PagesAnswer {
  allowed: PagesAllowed;
  why?: string;
}

/**
 * Whether the repository's plan allows GitHub Pages (`pagesAllowed`, spike result 13), asked with
 * the user's GitHub token: "unknown", with why, when there is no GitHub remote, no token, or GitHub
 * did not answer.
 */
export async function pagesAllowedFor(
  deps: Pick<PhaseDeps, "env" | "runner" | "redactor" | "fetch" | "version">,
  facts: ProjectFacts,
): Promise<PagesAnswer> {
  const { owner, repo } = facts.git;
  if (owner === undefined || repo === undefined) {
    return { allowed: "unknown", why: "the repository has no GitHub remote yet" };
  }
  const github = await githubClientFromToken(deps);
  if (github === undefined) return { allowed: "unknown", why: "no GitHub token is set" };
  try {
    const allowed = await github.pagesAllowed(owner, repo);
    return allowed === "unknown"
      ? { allowed, why: "the GitHub token cannot read the owner's plan (Plan: Read)" }
      : { allowed };
  } catch (error) {
    return { allowed: "unknown", why: `GitHub did not say: ${reasonOf(error)}` };
  }
}

/**
 * Stops design (`PHASE_PRECONDITION`, nothing written) unless `provider` fits the app
 * ({@link serverlessMisfit}), the domain is on Cloudflare, and for GitHub Pages GitHub allows Pages
 * for the repository (a private repository on GitHub's free plan does not).
 */
export function requireServerlessFit(
  provider: ServerlessProvider,
  facts: ProjectFacts,
  site: SiteDetection | undefined,
  requirements: Requirements,
  pages: PagesAnswer | undefined,
): asserts site is SiteDetection {
  const misfit =
    serverlessMisfit(provider, facts, site, requirements.keepExternalServices) ??
    domainMisfit(provider, requirements);
  if (misfit !== undefined) throw refusal(provider, misfit);
  if (pages?.allowed === "no") throw refusal(provider, PAGES_NOT_ALLOWED);
}

/**
 * Above Workers Free's 100,000 requests a day: the interview's expected traffic, at about one
 * server-rendered request per monthly user a day, so only more than 100,000 users a month.
 */
function aboveFreeRequests(requirements: Pick<Requirements, "expectedMonthlyUsers">): boolean {
  return requirements.expectedMonthlyUsers === ">100k";
}

/** The site's own `_headers` and `_redirects`, as a list. */
function ownFiles(site: SiteDetection): string[] {
  return [site.headers, site.redirects].filter((file) => file !== undefined);
}

/** The adapter `opscrew adapt` adds, in words: `Astro's Cloudflare adapter (@astrojs/cloudflare)`. */
function adapterText(adapter: NonNullable<SiteDetection["adapter"]>): string {
  return adapter.framework === "nuxt"
    ? "Nitro's cloudflare_module preset"
    : `${frameworkName(adapter.framework)}'s Cloudflare adapter (${adapter.name})`;
}

/** The option's text on Cloudflare's hosting: what it runs, its price, its limits. */
function cloudflareText(
  site: SiteDetection,
  requirements: Requirements,
): { summary: string; tradeoffs: string[]; paid: boolean } {
  const { plans } = providerProfile("cloudflare-workers");
  const ssr = site.render === "ssr";
  const paid = ssr && aboveFreeRequests(requirements);
  const requests = plans.freeRequestsPerDay.toLocaleString("en-US");
  const source = `Prices and limits: Cloudflare's published Workers plans as of ${plans.asOf.slice(0, 10)} (${plans.sources.join(" and ")}).`;
  const adapter = site.adapter;
  const runs =
    ssr && adapter !== undefined
      ? `Cloudflare runs the app's server code (${frameworkName(adapter.framework)}, built with ${adapterText(adapter)}) as a Worker at its edge and serves its static files, on your domain, with no server to rent, patch or pay for.`
      : "Cloudflare serves the site's files from its edge on your domain, with no server to rent, patch or pay for. Static files are free and unlimited on every Workers plan.";
  // Workers Paid and its price only when the expected traffic needs it; otherwise the free limits.
  const price = !ssr
    ? ""
    : paid
      ? ` Your expected traffic (more than 100,000 users a month) is above Workers Free's ${requests} requests a day, so it needs Workers Paid: at least ${formatMoney(plans.paidMonthly)} a month per account, which includes ${plans.paidIncludes}.`
      : ` Workers Free covers it at no cost: ${requests} requests a day to the Worker (past them it answers with an error until the next day) and ${plans.freeCpuMs} ms of CPU per request.`;
  const files = `A version may have ${plans.files.free.toLocaleString("en-US")} files on Workers Free${paid ? ` (${plans.files.paid.toLocaleString("en-US")} on Workers Paid)` : ""}, each at most ${plans.fileMiB} MiB; the deploy job checks the built site first and stops with the limit named.`;
  const own = ownFiles(site);
  const nextOptions = ssr ? site.nextOptions : undefined;
  const tradeoffs = [
    files,
    "No server parts: no database, cache, queue, worker or cron job of the app's own. Services the app reaches by URL keep working.",
    ...(ssr
      ? [
          "The app's secrets reach its Worker from your repository's GitHub secrets at each deploy, never through a file, a plan or the infrastructure's state.",
        ]
      : []),
    "Preview URLs and the workers.dev address stay off (target.previewUrls and target.workersDev in opscrew/plan.yaml).",
    ...(adapter !== undefined && !adapter.installed
      ? [`\`opscrew adapt\` adds ${adapterText(adapter)} in a pull request.`]
      : []),
    // Said where `serverlessCodeChanges` adds the change: for server rendering only.
    ...(nextOptions !== undefined
      ? [
          `Next.js's ${listText(nextOptions)} ${nextOptions.length === 1 ? "makes" : "make"} every server-rendered request hang on Workers, so \`opscrew adapt\` turns ${nextOptions.length === 1 ? "it" : "them"} off.`,
        ]
      : []),
    ...(own.length > 0
      ? [
          `The site's own ${listText(own)} ${own.length === 1 ? "is" : "are"} kept, with OpsCrew's security headers merged into its headers.`,
        ]
      : []),
  ];
  return { summary: `${runs}${price} ${source}`, tradeoffs, paid };
}

/** The option's text on GitHub Pages: what it publishes, its limits and GitHub's terms. */
function pagesText(
  site: SiteDetection,
  pages: PagesAnswer | undefined,
): { summary: string; tradeoffs: string[] } {
  const { limits } = providerProfile("github-pages");
  const own = ownFiles(site);
  const summary = `GitHub publishes the site's files from your repository's own workflow on your domain, with no server and no cost. Limits and terms: GitHub's, as of ${limits.asOf.slice(0, 10)} (${limits.sources.join(" and ")}).`;
  const tradeoffs = [
    `A site of at most ${limits.siteGb} GB, and a soft limit of ${limits.trafficGbPerMonth} GB of traffic a month.`,
    "No custom response headers: OpsCrew cannot add its security headers on GitHub Pages (Cloudflare hosting can).",
    "Static files only: no server-side rendering and no runtime secrets.",
    "GitHub's terms do not allow GitHub Pages for running a business, e-commerce or a commercial SaaS.",
    "The site is public, also from a private repository.",
    "The site's hostnames stay DNS-only: Cloudflare's proxy would stop GitHub from issuing and renewing their certificate, so Cloudflare's WAF never sees their traffic.",
    ...(site.spa
      ? [
          "GitHub Pages has no fallback for a single-page app: a path that is no file gets the site's 404.html, with status 404.",
        ]
      : []),
    ...(own.length > 0
      ? [
          `GitHub Pages ignores the site's own ${listText(own)}: ${own.length === 1 ? "it does" : "they do"} not apply there (Cloudflare hosting applies them).`,
        ]
      : []),
    ...(pages?.allowed === "unknown"
      ? [
          `OpsCrew cannot tell whether GitHub allows Pages for this repository (${pages.why ?? "GitHub did not say"}): public repositories have it on every plan, private ones on GitHub Pro, Team or Enterprise. If it is not allowed, \`opscrew provision\` stops at its first step with nothing changed.`,
        ]
      : []),
  ];
  return { summary, tradeoffs };
}

/** What a server-less option needs. */
export interface ServerlessOptionInput {
  choice: ServerlessDesignChoice;
  requirements: Requirements;
  /** The services the app keeps using where they are hosted. */
  externalServices: readonly ServiceKind[];
  /** GitHub Pages: whether GitHub allows Pages for the repository. */
  pages?: PagesAnswer;
}

/**
 * The single design option on a server-less target, validated with `DesignOptionSchema`: Cloudflare
 * free, or Workers Paid's monthly minimum for a server-rendered app whose expected traffic is above
 * Workers Free's daily requests; GitHub Pages free. Prices come from the provider's published plans
 * (a dated static price, `source: static`), named in the summary, and the tradeoffs list the limits.
 * There is no server: the option's size fields are the schema's smallest placeholders.
 */
export function buildServerlessOption(input: ServerlessOptionInput): DesignOption {
  const { choice, requirements } = input;
  const { provider, site } = choice;
  const cloudflare = provider === "cloudflare-workers";
  const { plans } = providerProfile("cloudflare-workers");
  const free = { amount: 0, currency: "USD" as const };
  let text: { summary: string; tradeoffs: string[] };
  let price: { monthly: typeof free | typeof plans.paidMonthly; item: string };
  if (cloudflare) {
    const { paid, ...rest } = cloudflareText(site, requirements);
    text = rest;
    price = paid
      ? {
          monthly: plans.paidMonthly,
          item: `Cloudflare Workers Paid, per account (the monthly minimum, which includes ${plans.paidIncludes})`,
        }
      : { monthly: free, item: "Cloudflare Workers Free" };
  } else {
    text = pagesText(site, input.pages);
    price = { monthly: free, item: "GitHub Pages (free)" };
  }
  const { monthly, item } = price;
  const budget = requirements.budgetMonthly;
  return DesignOptionSchema.parse({
    id: provider,
    title: providerProfile(provider).displayName,
    summary: text.summary,
    target: {
      provider,
      location: cloudflare ? "Cloudflare's edge" : "GitHub",
      serverType: cloudflare ? "Workers with static assets" : "GitHub Pages",
      vcpus: 1,
      memoryGb: 0.01,
      diskGb: 0.01,
      cpuType: "shared",
      architecture: "x86",
    },
    services: [],
    externalServices: [...input.externalServices],
    backups: false,
    cost: CostEstimateSchema.parse({
      monthly,
      breakdown: [{ item, monthly }],
      pricesIncludeVat: false,
      source: "static",
      asOf: cloudflare ? plans.asOf : providerProfile("github-pages").limits.asOf,
    }),
    fitsBudget: convertMoney(monthly, budget.currency).amount <= budget.amount,
    recommended: true,
    tradeoffs: text.tradeoffs,
  });
}

/**
 * The plan's server-less target from the design choice: the site block (in `app.buildContext`, the
 * site's folder), and on Cloudflare the Worker named `worker` (the app's name), server rendering
 * with the adapter's Worker module and flags, and what a path that is no file gets: nothing for
 * server rendering (the app answers it), the app itself for a single-page app, else the site's
 * 404 page when it has one.
 */
export function serverlessTargetFor(choice: ServerlessDesignChoice, worker: string) {
  const { site } = choice;
  const { outputDir } = site;
  if (outputDir === undefined) {
    throw new Error("A server-less site needs its folder to publish; serverlessMisfit refuses it.");
  }
  const ssr = site.render === "ssr" && site.adapter !== undefined;
  const flags = site.adapter?.compatibilityFlags ?? [];
  const block: Site = {
    tool: site.tool,
    ...(site.tool === "node" && site.packageManager !== undefined
      ? {
          packageManager: site.packageManager,
          ...(choice.nodeVersion === undefined ? {} : { nodeVersion: choice.nodeVersion }),
        }
      : {}),
    ...(site.command === undefined ? {} : { command: site.command }),
    outputDir,
    ...(ssr && site.adapter !== undefined
      ? {
          entry: site.adapter.entry,
          ...(flags.length > 0 ? { compatibilityFlags: [...flags] } : {}),
        }
      : {}),
  };
  if (choice.provider === "github-pages") {
    return { provider: "github-pages", mode: "pages-workflow", site: block } as const;
  }
  return {
    provider: "cloudflare-workers",
    mode: "workers-assets",
    worker,
    render: ssr ? "ssr" : "static",
    notFound: ssr
      ? "none"
      : site.spa
        ? "single-page-application"
        : site.notFoundPage !== undefined
          ? "404-page"
          : "none",
    workersDev: false,
    previewUrls: false,
    site: block,
  } as const;
}

/**
 * The code changes a server-less target adds to `changes` (`deriveCodeChanges` with no image): on
 * Cloudflare with server rendering, the Cloudflare adapter when the app lacks it, and Next.js's
 * options that hang server rendering on Workers turned off. `opscrew adapt` makes them.
 */
export function serverlessCodeChanges(
  choice: ServerlessDesignChoice,
  changes: readonly CodeChange[],
): CodeChange[] {
  const { site } = choice;
  const { adapter } = site;
  const extra: CodeChange[] = [];
  if (choice.provider === "cloudflare-workers" && site.render === "ssr" && adapter !== undefined) {
    const path = site.config ?? under(site.dir, "package.json");
    if (!adapter.installed) {
      extra.push({
        id: "cloudflare-adapter",
        kind: "build-config",
        path,
        reason: `Build the app with ${adapterText(adapter)}, so its build writes the Worker Cloudflare runs (${adapter.entry}) and the site's static files (${site.outputDir}).`,
        status: "pending",
      });
    }
    if (site.nextOptions !== undefined) {
      const one = site.nextOptions.length === 1;
      extra.push({
        id: "next-workers-options",
        kind: "build-config",
        path,
        reason: `Turn off ${listText(site.nextOptions)} in the Next.js config: with ${one ? "it" : "either"} on, every server-rendered request hangs on Cloudflare's Workers.`,
        status: "pending",
      });
    }
  }
  return [...changes, ...extra];
}

/**
 * Design's warnings about a server-less plan's secrets (FR-1605): a secret whose name has a public
 * prefix (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`, `NUXT_PUBLIC_` …), whose value the build puts into
 * the published files; and on GitHub Pages any secret, since the site gets none at runtime and
 * whatever the build is given is published.
 */
export function serverlessSecretWarnings(plan: Pick<DeployPlan, "app" | "target">): string[] {
  const secrets = plan.app.env.filter((variable) => variable.secret).map((v) => v.name);
  const exposed = secrets.filter((name) => isClientExposed(name));
  const warnings: string[] = [];
  if (exposed.length > 0) {
    const one = exposed.length === 1;
    warnings.push(
      `${listText(exposed)} ${one ? "looks like a secret" : "look like secrets"}, but a variable with a public prefix (such as VITE_, PUBLIC_, NEXT_PUBLIC_ or NUXT_PUBLIC_) is built into the published files, where anyone can read its value. Keep secrets out of such variables, and rotate any value that was published.`,
    );
  }
  if (plan.target.provider === "github-pages" && secrets.length > 0) {
    warnings.push(
      `GitHub Pages gives the site no runtime secrets: the app reads ${plural(secrets.length, "secret")} (${listText(secrets)}), and anything its build is given ends up in the published files, where anyone can read it.`,
    );
  }
  return warnings;
}

/** What design says about deploys on a server-less target, instead of a server's strategy. */
export function serverlessDeployLine(provider: ServerlessProvider): string {
  return provider === "cloudflare-workers"
    ? "Deploys: each push to the deploy branch builds the site in GitHub Actions, uploads it to Cloudflare as a new version and activates it; the version before stays available for a rollback."
    : "Deploys: each push to the deploy branch builds the site in GitHub Actions, and GitHub publishes it.";
}
