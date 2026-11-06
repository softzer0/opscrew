/**
 * The preview recipe (ADR 0026): what OpsCrew installs in a preview environment's own app folder
 * on its server, `/srv/apps/<app>/`, so that `opscrew-preview` can start, update and remove each
 * pull request's preview there within the bounds the host plan's approval names.
 */
import type { OpsCrewError } from "@opscrew/core";
import type { DeployPlan, Previews } from "@opscrew/plan-schema";
import { initStepsFor } from "../catalog";
import { renderEdgeCompose } from "../edge";
import { usesCloudflare } from "../predicates";
import { wrongTarget } from "../providers";
import { renderCompose, renderEdgeSite, renderRuntimeFiles } from "../runtime";
import { artefactsFolder, runtimeDir } from "../runtime-dir";
import type { RenderedFile } from "../types";
import { planFilePath } from "../workflow/shared";
import { rollbackCommands, switchCommands } from "../workflow/switch";
import {
  PREVIEW_SECRET_NAME,
  PREVIEW_SECRET_PLACEHOLDER,
  type PreviewSecretFormat,
  previewScript,
} from "./script";

export { PREVIEW_SECRET_FORMATS, type PreviewSecretFormat } from "./script";

/**
 * The word in a preview's number's place while the recipe is rendered: 6 lower-case letters, as
 * long as the longest number, so `<app>-pr-<token>` fits the app-name pattern exactly when every
 * preview's name does. The recipe turns `pr-<token>` into `pr-@N@`.
 */
const NUMBER_TOKEN = "xnumbx";

/** Where the server puts the preview's number in a recipe file: `@N@`. */
const NUMBER = "@N@";

/**
 * The word in the place of a preview's random part while the recipe is rendered: 10 lower-case
 * letters, as long as the random part. The recipe turns `pr-<number token>-<token>` into
 * `pr-@N@-@R@`.
 */
const RANDOM_TOKEN = "xrandpartx";

/** Where the server puts the preview's random part in a recipe file: `@R@`. */
const RANDOM = "@R@";

/** Every `@SECRET:<name>:<format>@` placeholder in a text. */
const SECRET_PLACEHOLDERS = new RegExp(PREVIEW_SECRET_PLACEHOLDER, "g");

/**
 * The placeholder of a value the preview server generates once per preview, in `format`:
 * `@SECRET:<name>:<format>@`. Provision writes these into the env templates instead of values.
 * @throws OpsCrewError for a name that is not a letter, then letters, digits, `_` or `-` (at most 64).
 */
export function previewSecret(name: string, format: PreviewSecretFormat): string {
  if (!PREVIEW_SECRET_NAME.test(name)) {
    throw wrongTarget(`A preview's generated value can't be named ${JSON.stringify(name)}.`);
  }
  return `@SECRET:${name}:${format}@`;
}

/**
 * A preview environment's env templates, which provision builds from {@link previewTemplatePlan}
 * without any value: generated values are {@link previewSecret} placeholders, and the user's own
 * preview values stay out (they are `values.env` on the server, which the app's env file starts
 * with).
 */
export interface PreviewEnvTemplates {
  /** The app's env file, `app.env`. */
  app: string;
  /** Each service's env file, `<service>.env`, by the service's name: one per enabled service. */
  services: Readonly<Record<string, string>>;
}

/** What a preview recipe needs besides the preview environment's plan. */
export interface PreviewRecipeOptions {
  /** The repository whose pull requests get previews, `<owner>/<repo>`. */
  repository: string;
  /** The image every preview runs, `ghcr.io/<owner>/<repo>[/<app key>]` (`ghcrImageFor`). */
  imageName: string;
  env: PreviewEnvTemplates;
  /**
   * Previews on another environment's server (`previews.server`): that environment's plan and
   * Cloudflare's IP ranges, so the recipe's edge Compose file (with Caddy's global settings) is the
   * one that environment's deploys put in `/srv/edge`. The ranges count only when the host's plan
   * has a Cloudflare domain, as for its deploys.
   */
  host?: { plan: DeployPlan; cloudflareRanges?: readonly string[] };
}

/** A preview environment's environment, or a bug: only a preview environment has a recipe. */
function previewEnvironment(plan: DeployPlan) {
  const environment = plan.environment;
  const previews = environment?.previews;
  if (environment === undefined || previews === undefined) {
    throw wrongTarget(
      `The environment of ${planFilePath(plan)} has no previews (environment.previews), so it has no preview recipe.`,
    );
  }
  return { ...environment, previews };
}

/**
 * The plan every preview's files come from: the preview environment's `plan` as the app
 * `<app>-pr-<token>` at `pr-<token>-<random token>.<previews.domain>`, without
 * `environment.previews`, where the tokens are fixed words the recipe turns into the preview's
 * number and random part, and with `deploy.snapshots` false: a preview takes no snapshots. Provision
 * builds the {@link PreviewEnvTemplates} from it. Not parsed again: plan-schema wants a named
 * environment's app name to end with `-<env>`, which a preview's doesn't, and the fields it changes
 * stay valid (the app name is at most 31 characters).
 * @throws OpsCrewError for a plan without `environment.previews`.
 */
export function previewTemplatePlan(plan: DeployPlan): DeployPlan {
  const { previews, ...environment } = previewEnvironment(plan);
  return {
    ...plan,
    environment,
    app: { ...plan.app, name: `${plan.app.name}-pr-${NUMBER_TOKEN}` },
    dns: { ...plan.dns, domain: `pr-${NUMBER_TOKEN}-${RANDOM_TOKEN}.${previews.domain}` },
    // Without `environment.previews`, the template would look like a named environment's plan.
    deploy: { ...plan.deploy, snapshots: false },
  };
}

/**
 * The repository folder of an environment's preview recipe, `opscrew/environments/<env>/previews`
 * (a further app's under `opscrew/apps/<key>/`): the files of {@link renderPreviewRecipe} are under
 * it as they are under `/srv/apps/<app>/` on the server.
 */
export function previewRecipeDir(plan: DeployPlan): string {
  return `${artefactsFolder(plan)}/previews`;
}

/** Shown when an env template holds a placeholder the server can't fill. */
function badTemplate(file: string, why: string): OpsCrewError {
  return wrongTarget(`The preview env template ${file} ${why}.`);
}

/**
 * Checks the env templates: every `@SECRET` a placeholder of one of the formats, each name with one
 * format.
 */
function checkEnv(env: PreviewEnvTemplates): void {
  const formats = new Map<string, string>();
  for (const [file, text] of [
    ["app.env", env.app],
    ...Object.entries(env.services).map(([name, t]) => [`${name}.env`, t] as const),
  ] as const) {
    const placeholders = [...text.matchAll(SECRET_PLACEHOLDERS)];
    if (placeholders.length !== text.split("@SECRET:").length - 1) {
      throw badTemplate(file, "holds an @SECRET: placeholder the server can't fill");
    }
    for (const [placeholder, format = ""] of placeholders) {
      const [, name = ""] = placeholder.split(":");
      if (!PREVIEW_SECRET_NAME.test(name)) {
        throw badTemplate(file, `names a generated value ${name}, which is too long`);
      }
      if ((formats.get(name) ?? format) !== format) {
        throw badTemplate(file, `gives the generated value ${name} two formats`);
      }
      formats.set(name, format);
    }
  }
}

/**
 * `text` with the address's tokens as `@N@` and `@R@` and the number's elsewhere as `@N@`; throws
 * when a token is left in another form.
 */
function withNumber(file: string, text: string): string {
  const filled = text
    .replaceAll(`pr-${NUMBER_TOKEN}-${RANDOM_TOKEN}.`, `pr-${NUMBER}-${RANDOM}.`)
    .replaceAll(`pr-${NUMBER_TOKEN}`, `pr-${NUMBER}`);
  const lower = filled.toLowerCase();
  if (lower.includes(NUMBER_TOKEN) || lower.includes(RANDOM_TOKEN)) {
    throw wrongTarget(
      `The preview recipe's ${file} holds the preview's number or address in a form the server can't fill.`,
    );
  }
  return filled;
}

/** `ghcr.io/<owner>/<repo>[/<key>]`, lower case: what the settings may hold. */
const IMAGE_NAME = /^ghcr\.io(?:\/[a-z0-9][a-z0-9._-]*){2,3}$/;

/** `<owner>/<repo>` as GitHub names them. */
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * `settings.env`, the bounds `opscrew-preview` reads (it sources the file): each value checked to
 * be digits or of `[a-z0-9._/-]` before it is written.
 */
function settingsFile(plan: DeployPlan, previews: Previews, o: PreviewRecipeOptions): string {
  if (!IMAGE_NAME.test(o.imageName)) {
    throw wrongTarget(`The image name ${JSON.stringify(o.imageName)} is not a GHCR image's.`);
  }
  if (!REPOSITORY.test(o.repository)) {
    throw wrongTarget(`${JSON.stringify(o.repository)} is not a GitHub repository's name.`);
  }
  const settings: Record<string, string | number> = {
    APP: plan.app.name,
    CAP: previews.cap,
    LIFETIME_DAYS: previews.lifetimeDays,
    IMAGE_NAME: o.imageName,
    BASE: previews.domain,
    SEED: typeof previews.seed === "string" ? 1 : 0,
  };
  for (const [name, value] of Object.entries(settings)) {
    if (!/^[a-z0-9._/-]+$/.test(String(value))) {
      throw wrongTarget(`The preview setting ${name} can't be ${JSON.stringify(value)}.`);
    }
  }
  return [
    `# The bounds of the previews of ${o.repository}'s pull requests, from ${planFilePath(plan)}:`,
    "# opscrew-preview reads them. `opscrew provision` rewrites this file; a change is a new approval.",
    ...Object.entries(settings).map(([name, value]) => `${name}=${value}`),
    "",
  ].join("\n");
}

/**
 * The preview recipe of a preview environment's `plan`, each file under {@link previewRecipeDir}
 * as under `/srv/apps/<app>/` on the server:
 * - `settings.env`: `APP`, `CAP`, `LIFETIME_DAYS`, `IMAGE_NAME` (`o.imageName`), `BASE` and `SEED`;
 * - `template/`: what a preview's folder gets, rendered from {@link previewTemplatePlan}: every
 *   file a deploy uploads to an app's folder (the Compose file, with the `seed` service when the
 *   plan has a seed command, the services' files, the crontab, the edge's Compose file and the
 *   site, served with the Origin CA certificate in `/srv/edge/tls/<app>/` and sending
 *   `X-Robots-Tag: noindex`), `start.sh` and `rollback.sh` (the deploy's start and rollback
 *   scripts) and `env/app.env` and `env/<service>.env` from `o.env`, with `@N@` in the number's
 *   place and the address `pr-@N@-@R@.<base>`, `@R@` the preview's random part; on another
 *   environment's server (`o.host`) the edge's Compose file is that environment's;
 * - `bin/opscrew-preview` (0755), the command that enforces it.
 * Filled with a number, a random part and values, `template/` is what OpsCrew renders for
 * `<app>-pr-<number>` at `pr-<number>-<random>.<base>`.
 * @throws OpsCrewError for a plan without previews,
 * an image name or repository that isn't one, or an env template with a placeholder the server can't fill.
 */
export function renderPreviewRecipe(plan: DeployPlan, o: PreviewRecipeOptions): RenderedFile[] {
  const { previews } = previewEnvironment(plan);
  checkEnv(o.env);
  const settings = settingsFile(plan, previews, o);
  const template = previewTemplatePlan(plan);
  const seed = typeof previews.seed === "string" ? { seed: previews.seed } : {};
  const runtime = runtimeDir(template);
  // On another environment's server, the edge is the host's: its deploys and a preview's `up`
  // then put the same file in /srv/edge.
  const { host } = o;
  const hostEdge =
    host === undefined
      ? undefined
      : renderEdgeCompose(host.plan, usesCloudflare(host.plan) ? host.cloudflareRanges : []);
  const edgePath = `${runtime}/edge/compose.yaml`;
  const rendered = [
    renderCompose(template, seed),
    ...renderRuntimeFiles(template).map((file) =>
      hostEdge !== undefined && file.path === edgePath
        ? { ...file, content: hostEdge.content }
        : file,
    ),
    ...renderEdgeSite(template, { preview: { app: plan.app.name } }),
  ].map((file) => ({ path: file.path.slice(runtime.length + 1), content: file.content }));
  const script = (lines: readonly string[]) => `${lines.join("\n")}\n`;
  const files = [
    ...rendered,
    // A preview's data is never restored: its scripts have no database step.
    {
      path: "start.sh",
      content: script(
        switchCommands(template, initStepsFor(template), undefined, { preview: true }),
      ),
    },
    {
      path: "rollback.sh",
      content: script(rollbackCommands(template, undefined, { preview: true })),
    },
    { path: "env/app.env", content: o.env.app },
    ...Object.entries(o.env.services).map(([name, content]) => ({
      path: `env/${name}.env`,
      content,
    })),
  ];
  const dir = previewRecipeDir(plan);
  return [
    { path: `${dir}/settings.env`, content: settings, kind: "runtime" },
    ...files.map(({ path, content }) => ({
      path: `${dir}/template/${withNumber(path, path)}`,
      content: withNumber(path, content),
      kind: "runtime" as const,
    })),
    { path: `${dir}/bin/opscrew-preview`, content: previewScript(), kind: "runtime", mode: 0o755 },
  ];
}
