/**
 * The run of a site's move between Cloudflare's hosting and GitHub Pages (FR-2304, plan.md "6."):
 * its credentials checked, its engine ready, and the files and plans of each step.
 */
import { join } from "node:path";
import type { GitClient } from "@opscrew/connector-github";
import { OpsCrewError, tfstateFile } from "@opscrew/core";
import type { EnginePreference } from "@opscrew/iac-engine";
import { type RenderedFile, type RuntimeContext, renderDeployment } from "@opscrew/iac-templates";
import type {
  CloudflareWorkersDeployTarget,
  DeployPlan,
  GithubPagesDeployTarget,
  Requirements,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  type CloudflareSetup,
  deploymentRenderContext,
  type GitHubSetup,
  readRequirements,
  setupCloudflare,
  setupGitHub,
} from "../provision";
import { withCloudflareZone } from "../provision/render";
import {
  diffRenderedFiles,
  existingStateEngine,
  githubClientFromToken,
  requireGitRepo,
  serverlessName,
  writeRenderedFiles,
} from "../shared";
import type { PlanSession } from "./plans";
import { moveOf, requireState } from "./session";
import type { RetargetGitHubApi, RetargetServices } from "./types";

/** A site's target: Cloudflare's hosting or GitHub Pages. */
export type SiteTarget = CloudflareWorkersDeployTarget | GithubPagesDeployTarget;

/** Everything the steps of a site's move share: credentials checked, engine ready. */
export interface SiteSession extends PlanSession {
  services: RetargetServices;
  requirements: Requirements | undefined;
  git: GitClient;
  github: GitHubSetup;
  githubApi: RetargetGitHubApi;
  cloudflare: CloudflareSetup;
}

/** A site host in a sentence: `Cloudflare hosting`, `GitHub Pages`. */
export function hostWords(target: Pick<SiteTarget, "provider">): string {
  return serverlessName(target.provider);
}

/** GitHub Pages' own address of a repository's site, before it has a custom domain. */
export function pagesAddress(owner: string, repo: string): string {
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}

/** The move's old side, a site's target (a site moves only from a site). */
export function oldSite(plan: DeployPlan): SiteTarget {
  const from = moveOf({ plan }).from.target;
  if (from.provider !== "cloudflare-workers" && from.provider !== "github-pages") {
    throw new OpsCrewError("INTERNAL", "A site's move from a server is recorded.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  return from;
}

/** The plan's target, a site's. */
export function newSite(plan: DeployPlan): SiteTarget {
  const { target } = plan;
  if (target.provider !== "cloudflare-workers" && target.provider !== "github-pages") {
    throw new OpsCrewError("INTERNAL", "A site's move to a server is recorded.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  return target;
}

/** The move's Worker, on whichever side it is: a site moves between a Worker and GitHub Pages. */
export function movingWorker(plan: DeployPlan): CloudflareWorkersDeployTarget {
  for (const site of [newSite(plan), oldSite(plan)]) {
    if (site.provider === "cloudflare-workers") return site;
  }
  throw new OpsCrewError("INTERNAL", "A site's move with no Worker on either side is recorded.", {
    hint: "This is a bug in OpsCrew; please report it.",
  });
}

/**
 * `plan` on the site host `target`, with the DNS and security settings that host needs: a
 * Worker's custom domains are always behind Cloudflare's proxy (with its WAF), GitHub Pages'
 * records are DNS only (no WAF sees them).
 */
export function onSiteHost(plan: DeployPlan, target: SiteTarget): DeployPlan {
  const workers = target.provider === "cloudflare-workers";
  return {
    ...plan,
    target,
    dns: { ...plan.dns, proxied: workers },
    security: {
      ...plan.security,
      wafCustomRules: workers,
      httpAllowedFrom: workers ? "cloudflare" : "any",
    },
  };
}

/** The plan as it was before the move: the old host's, with no move recorded. */
export function beforeMove(plan: DeployPlan): DeployPlan {
  const { retarget: _move, ...rest } = onSiteHost(plan, oldSite(plan));
  return rest;
}

/** The plan once the move is over: the new host's, with no move recorded. */
export function afterMove(plan: DeployPlan): DeployPlan {
  const { retarget: _move, ...rest } = plan;
  return rest;
}

/**
 * Checks what a site's move needs before any change (the infrastructure state here, Cloudflare,
 * GitHub, the state's passphrase) and prepares the engine. `plan` is the move's, or the site's
 * before it starts.
 */
export async function openSiteSession(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: {
    command: string;
    services: RetargetServices;
    engine?: EnginePreference;
    approvePlanHash?: string;
  },
): Promise<SiteSession> {
  const { services, command } = input;
  await requireState(deps, plan);
  const git = await requireGitRepo(deps);
  deps.reporter.step("Checking your Cloudflare and GitHub access");
  // A Worker's custom domains bring records without OpsCrew's comment: the steps check them.
  const cloudflare = await setupCloudflare(deps, plan, services, { foreignRecords: "report" });
  if (cloudflare === undefined) {
    throw new OpsCrewError("INTERNAL", "A site's plan without a domain on Cloudflare.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  const githubApi = services.github ?? (await githubClientFromToken(deps)) ?? null;
  // Stops with CREDENTIALS_MISSING when there is no token, so the API exists after it.
  const github = await setupGitHub(deps, git, { github: githubApi });
  if (githubApi === null) {
    throw new OpsCrewError("INTERNAL", "The GitHub API is not available.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  const { engine, env } = await existingStateEngine(deps, plan, {
    ...(input.engine !== undefined ? { engine: input.engine } : {}),
    services,
    command,
  });
  return {
    deps,
    services,
    plan,
    requirements: await readRequirements(deps),
    git,
    github,
    githubApi,
    cloudflare,
    engine,
    env,
    dir: join(deps.paths.root, plan.infra.dir),
    command,
    approve: input.approvePlanHash?.trim() || undefined,
  };
}

/** What the site's files for `plan` are rendered from: the plan with its zone, and the context. */
export async function siteContext(
  session: SiteSession,
  plan: DeployPlan,
): Promise<{ plan: DeployPlan; ctx: RuntimeContext }> {
  const zoned = withCloudflareZone(plan, session.cloudflare);
  const ctx = await deploymentRenderContext(session.deps, {
    plan: zoned,
    requirements: session.requirements,
    github: { owner: session.github.owner, repo: session.github.repo },
    // A site has no SSH deploy: its files never use the deploy key.
    deployPublicKey: "",
    cloudflare: session.cloudflare,
  });
  return { plan: zoned, ctx };
}

/**
 * Every file of the site's deployment for `plan`: its plain root, or with `siteMove` the move's
 * root (the Worker's shell beside GitHub Pages' records).
 */
export async function renderSiteFiles(
  session: SiteSession,
  plan: DeployPlan,
  siteMove = false,
): Promise<RenderedFile[]> {
  const { plan: zoned, ctx } = await siteContext(session, plan);
  return renderDeployment(zoned, { ...ctx, ...(siteMove ? { siteMove: true } : {}) });
}

/**
 * Writes the root of the move's plan into the working tree (with `siteMove`, the Worker's shell
 * beside GitHub Pages' records; else the plain root of its target) and initialises the engine
 * again (a new module call needs `init` before any plan). Returns the root's files.
 */
export async function useSiteRoot(
  session: SiteSession,
  siteMove: boolean,
): Promise<RenderedFile[]> {
  const { deps } = session;
  const files = (await renderSiteFiles(session, session.plan, siteMove)).filter(
    (file) => file.kind === "infra",
  );
  const diff = await diffRenderedFiles(deps.paths.root, files);
  const toWrite = [...diff.created, ...diff.changed];
  if (toWrite.length > 0) {
    await writeRenderedFiles(deps.paths.root, toWrite);
    deps.reporter.info(
      `Updated the move's transitional infrastructure files in ${session.plan.infra.dir}; the final files are published when the move is finished.`,
    );
  }
  await session.engine.init(session.dir, {
    env: session.env,
    backendConfig: { path: tfstateFile(deps.paths) },
  });
  return files;
}
