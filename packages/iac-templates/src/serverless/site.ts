// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash and GitHub Actions syntax, not JavaScript templates.
import { posix } from "node:path";
import {
  type CloudflareWorkersDeployTarget,
  cleanRepoPath,
  type DeployPlan,
  type GithubPagesDeployTarget,
  isServerlessTarget,
  type Site,
} from "@opscrew/plan-schema";
import { packageManagerSpec } from "../docker/stacks";
import { ACTIONS, RUNTIME_DEFAULTS, TOOLS } from "../pins";
import { wrongTarget } from "../providers";
import { shellQuote } from "../runtime/services";
import { artefactsFolder } from "../runtime-dir";
import { planFilePath, provisionCommand, run, secret } from "../workflow/shared";

/** A server-less target: Cloudflare's hosting or GitHub Pages. */
export type ServerlessTarget = CloudflareWorkersDeployTarget | GithubPagesDeployTarget;

/** The plan's server-less target; throws `wrongTarget` for any other. */
export function serverlessTarget(plan: DeployPlan): ServerlessTarget {
  if (!isServerlessTarget(plan.target)) {
    throw wrongTarget("This step only applies to an app on Cloudflare's hosting or GitHub Pages.");
  }
  return plan.target;
}

/** The plan's Cloudflare hosting target; throws `wrongTarget` for any other. */
export function workersTarget(plan: DeployPlan): CloudflareWorkersDeployTarget {
  if (plan.target.provider !== "cloudflare-workers") {
    throw wrongTarget("This step only applies to an app on Cloudflare's hosting.");
  }
  return plan.target;
}

/**
 * The Workers plan the design chose for a site on Cloudflare's hosting, in words, and the files a
 * version may have on it (016's spike, result 8): Workers Paid when the plan has a monthly cost
 * (design prices only Workers Paid's minimum), else Cloudflare's free plan.
 */
export function workersPlan(plan: DeployPlan): { name: string; files: number } {
  return plan.cost.monthly.amount > 0
    ? { name: "Cloudflare's Workers Paid plan", files: 100_000 }
    : { name: "Cloudflare's free plan", files: 20_000 };
}

/**
 * The repository folder of the environment's Cloudflare files (the Wrangler config and, for
 * server rendering, the headers wrapper), `<artefactsFolder>/cloudflare` ({@link artefactsFolder}):
 * `opscrew/cloudflare` for the first app's prod, `opscrew/environments/<env>/cloudflare` for a
 * named environment, `opscrew/apps/<key>/…` for a further app.
 */
export function cloudflareDir(plan: DeployPlan): string {
  return `${artefactsFolder(plan)}/cloudflare`;
}

/**
 * The GitHub Actions secret that holds the app's variable `name` (from `app.env`) for a
 * server-less target, `OPSCREW_ENV_<NAME>` (before `deploySecretName`). The build job reads every
 * one of them, outside any GitHub environment, so `opscrew provision` stores them as repository
 * secrets; on Cloudflare with `render: ssr` the deploy job also gives them to the new version.
 */
export function siteEnvSecret(name: string): string {
  return `OPSCREW_ENV_${name.toUpperCase()}`;
}

/** The name of the build's artifact, which the deploy job and a promoted environment download. */
export const SITE_ARTIFACT = "opscrew-site";

/** The site's built files, from the repository root (inside `app.buildContext`). */
export interface SiteFiles {
  /** The folder of static files, `site.outputDir`. */
  assets: string;
  /** With `render: ssr`: the Worker module the adapter builds, `site.entry`. */
  entry?: string;
}

/** The site's built files: `site.outputDir` and, for server rendering, `site.entry`. */
export function siteFiles(plan: DeployPlan): SiteFiles {
  const { site } = serverlessTarget(plan);
  const at = (path: string) => cleanRepoPath(posix.join(plan.app.buildContext, path));
  return {
    assets: at(site.outputDir),
    ...(site.entry === undefined ? {} : { entry: at(site.entry) }),
  };
}

/** How each package manager installs the site's dependencies: from its lockfile when there is one. */
const INSTALL: Record<NonNullable<Site["packageManager"]>, string> = {
  npm: "if [ -f package-lock.json ]; then npm ci; else npm install; fi",
  pnpm: "if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; else pnpm install; fi",
  yarn: "if [ -f yarn.lock ]; then yarn install --frozen-lockfile; else yarn install; fi",
  bun: "if [ -f bun.lock ] || [ -f bun.lockb ]; then bun install --frozen-lockfile; else bun install; fi",
};

/** Installs the pinned Hugo extended release after checking its SHA-256 against pins.ts. */
const INSTALL_HUGO = [
  `- name: Install Hugo ${TOOLS.hugo.version}`,
  ...run([
    "set -euo pipefail",
    `curl -fsSL --retry 3 -o "$RUNNER_TEMP/hugo.tar.gz" ${TOOLS.hugo.url}`,
    `echo "${TOOLS.hugo.sha256}  $RUNNER_TEMP/hugo.tar.gz" | sha256sum -c -`,
    'mkdir -p "$RUNNER_TEMP/hugo"',
    'tar -xzf "$RUNNER_TEMP/hugo.tar.gz" -C "$RUNNER_TEMP/hugo"',
    'sudo install -m 0755 "$RUNNER_TEMP/hugo/hugo" /usr/local/bin/hugo',
    "hugo version",
  ]),
];

/**
 * The steps that set up the site's tool: Node.js at `site.nodeVersion` (OpsCrew's default when
 * absent), then the package manager at the exact version package.json's `packageManager` names,
 * else OpsCrew's pin ({@link packageManagerSpec}): Bun from its action, pnpm or Yarn installed with
 * npm as the generated Dockerfiles install them; Hugo; or nothing for `none`.
 */
function toolSteps(site: Site, dir: string): string[] {
  if (site.tool === "hugo") return INSTALL_HUGO;
  if (site.tool === "none") return [];
  const pm = site.packageManager;
  return [
    `- uses: ${ACTIONS.setupNode}`,
    "  with:",
    `    node-version: ${JSON.stringify(site.nodeVersion ?? RUNTIME_DEFAULTS.node)}`,
    ...(pm === "bun"
      ? [
          "- id: bun",
          "  name: Choose the Bun version",
          `  working-directory: ${dir}`,
          ...run([
            "set -euo pipefail",
            packageManagerSpec(pm),
            'echo "version=${spec#bun@}" >> "$GITHUB_OUTPUT"',
          ]),
          `- uses: ${ACTIONS.setupBun}`,
          "  with:",
          "    bun-version: ${{ steps.bun.outputs.version }}",
        ]
      : []),
    ...(pm === "pnpm" || pm === "yarn"
      ? [
          `- name: Install ${pm === "pnpm" ? "pnpm" : "Yarn"}`,
          `  working-directory: ${dir}`,
          ...run([
            "set -euo pipefail",
            packageManagerSpec(pm),
            'npm install -g --no-audit --no-fund "$spec"',
          ]),
        ]
      : []),
  ];
}

/**
 * The build job's steps up to the built site, on GitHub's machines with no image: the checkout
 * (its token kept out of the build), the site's tool ({@link toolSteps}), the install from the
 * lockfile and `site.command` in `app.buildContext`. The build gets every variable of `app.env`
 * from its GitHub secret ({@link siteEnvSecret}), and `extra` (name, value) environment lines.
 * Nothing is built for `tool: none`: the files are in the repository as they are.
 */
export function siteBuildSteps(
  plan: DeployPlan,
  extra: readonly (readonly [string, string])[],
): string[] {
  const { site } = serverlessTarget(plan);
  const dir = JSON.stringify(plan.app.buildContext);
  const env = [
    ...extra.map(([name, value]) => `    ${name}: ${value}`),
    ...plan.app.env.map(
      (variable) => `    ${variable.name}: ${secret(plan, siteEnvSecret(variable.name))}`,
    ),
  ];
  const command = site.command;
  const build =
    command === undefined
      ? []
      : [
          "- name: Build the site",
          `  working-directory: ${dir}`,
          ...(env.length === 0 ? [] : ["  env:", ...env]),
          ...run(["set -euo pipefail", command]),
        ];
  const pm = site.packageManager;
  return [
    `- uses: ${ACTIONS.checkout}`,
    "  with:",
    "    persist-credentials: false",
    ...toolSteps(site, dir),
    ...(pm === undefined
      ? []
      : [
          "- name: Install the site's dependencies",
          `  working-directory: ${dir}`,
          ...run(["set -euo pipefail", INSTALL[pm]]),
        ]),
    ...build,
  ];
}

/**
 * Script lines that stop the job when the build left no site folder (or, with server rendering,
 * no Worker module) where the plan says.
 */
export function siteExists(plan: DeployPlan, files: SiteFiles): string[] {
  const fix = `change target.site in ${planFilePath(plan)} to what the build writes, then run \\\`${provisionCommand(plan)}\\\` again`;
  return [
    `if [[ ! -d ${shellQuote(files.assets)} ]]; then`,
    `  echo "::error::The build left no folder ${files.assets}, where ${planFilePath(plan)} expects the site's files (target.site.outputDir): ${fix}."`,
    "  exit 1",
    "fi",
    ...(files.entry === undefined
      ? []
      : [
          `if [[ ! -f ${shellQuote(files.entry)} ]]; then`,
          `  echo "::error::The build left no ${files.entry}, the Worker module ${planFilePath(plan)} names (target.site.entry): ${fix}."`,
          "  exit 1",
          "fi",
        ]),
  ];
}

/**
 * The check of the site's answer at the step's `$URL` after a deploy: 30 tries, 6 seconds apart.
 * When every try failed the TLS handshake (curl's exit 35, 51 or 60), the host has no certificate
 * for the domain yet and nothing can be said about the site: `pending` is shown as a warning and
 * the step passes. Any other failure fails the step.
 */
export function answerCheck(pending: string): string[] {
  return [
    "set -uo pipefail",
    "tls_only=1",
    "for attempt in $(seq 1 30); do",
    "  code=0",
    '  curl -fsS --max-time 10 -o /dev/null "$URL" || code=$?',
    '  if [[ "$code" -eq 0 ]]; then',
    '    echo "The site answers after $attempt attempt(s)."',
    "    exit 0",
    "  fi",
    '  case "$code" in 35 | 51 | 60) ;; *) tls_only=0 ;; esac',
    "  sleep 6",
    "done",
    'if [[ "$tls_only" -eq 1 ]]; then',
    `  echo "::warning::${pending}"`,
    "  exit 0",
    "fi",
    'echo "::error::The site did not answer at $URL."',
    "exit 1",
  ];
}

/** The site's address the deploy job checks: its domain's front page (the plan requires one). */
export function siteUrl(plan: DeployPlan): string {
  const { domain } = plan.dns;
  if (domain === undefined) throw wrongTarget("A server-less site needs dns.domain.");
  return `https://${domain}/`;
}
