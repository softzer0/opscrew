/**
 * Provisioning a preview environment (ADR 0026, plan.md "7."): the env templates the recipe holds
 * and the preview values from `.env.<env>`, kept apart; the recipe's host plan, which is the
 * standing approval GitHub Actions acts under; and the secrets the preview workflow reads.
 */
import { join } from "node:path";
import {
  type HostFacts,
  planAddon,
  previewCommand,
  readableRecords,
} from "@opscrew/connector-ssh-host";
import type { PhaseName } from "@opscrew/contracts";
import {
  exists,
  listText,
  OpsCrewError,
  plural,
  readTextIfExists,
  sha256Hex,
  writeFileAtomic,
} from "@opscrew/core";
import {
  appDir,
  DEPLOY_SECRETS,
  type PreviewEnvTemplates,
  previewRecipeDir,
  previewTemplatePlan,
  type RenderedFile,
} from "@opscrew/iac-templates";
import type { DeployPlan, Previews } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { NetworkServer } from "../provision/network";
import { serviceEnvFiles } from "../provision/secrets";
import { assembleAppEnv, dotenvLine } from "../shared/app-env";
import { readValidJson } from "../shared/files";
import { approveAndApplyHostPlan, type HostPlanOutcome } from "../shared/host-plan";
import { appMemoryLimits } from "../shared/memory";
import type { KeyPair } from "../shared/ssh-keys";

/** A preview environment's env templates and its own values, as provision reads them. */
export interface PreviewEnvironment {
  /** The recipe's env templates: no value, each generated one the server's placeholder. */
  templates: PreviewEnvTemplates;
  /** The server's `values.env`: one `NAME=value` line per value of `.env.<env>` the app uses. */
  values: string;
  /** Their names, sorted. */
  valueNames: string[];
  /** Variables the app needs that `.env.<env>` has no value for. */
  missing: string[];
  /** Variables left to the defaults in the app's code. */
  defaulted: string[];
  /** The build values (client-exposed), as for any named environment, and their names. */
  build: { env: string; secrets: string; names: string[] };
}

/** The file a preview environment's own values come from: `.env.<env>`, never prod's `.env`. */
function valuesFile(deps: Pick<PhaseDeps, "paths">): string {
  return `.env.${deps.paths.environment}`;
}

/**
 * Stops (`INVALID_INPUT`, before any change and before it is read) when `.env.<env>` is there
 * and git doesn't ignore it (`git check-ignore`): a commit could take the previews' values.
 */
export async function requireIgnoredValues(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env">,
  command: string,
): Promise<void> {
  const { root } = deps.paths;
  const file = valuesFile(deps);
  if (!(await exists(join(root, file)))) return;
  // As the git client runs git: never a prompt, never a lock in the user's way.
  const ignored = await deps.runner.run("git", ["-C", root, "check-ignore", "-q", "--", file], {
    env: { ...deps.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 120_000,
  });
  if (ignored.exitCode === 0) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${file} holds the previews' values, and git doesn't ignore it, so a commit could take them. Nothing was changed.`,
    {
      hint: `Add .env.* to .gitignore (if ${file} is committed already, also run \`git rm --cached ${file}\`), then run \`${command}\` again.`,
    },
  );
}

/**
 * The env templates of the preview environment's `plan` (`assembleAppEnv` with its preview
 * templates, for `previewTemplatePlan`) and the values its `.env.<env>` gives, which are
 * registered with the redactor. Never stops on a missing value: {@link requirePreviewValues}
 * does, where the values are needed.
 */
export async function previewEnvironment(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: DeployPlan,
): Promise<PreviewEnvironment> {
  const dotenvText = await readTextIfExists(join(deps.paths.root, valuesFile(deps)));
  const template = previewTemplatePlan(plan);
  const env = await assembleAppEnv({
    plan: template,
    ...(dotenvText !== undefined ? { dotenvText } : {}),
    previewTemplates: true,
  });
  const own = env.preview as NonNullable<typeof env.preview>;
  for (const value of [...Object.values(own.values), ...Object.values(env.values.build)]) {
    deps.redactor.addLiteral(value, "preview-value");
  }
  const names = Object.keys(own.values);
  return {
    templates: { app: env.appEnv, services: serviceEnvFiles(template, env) },
    values: names.map((name) => `${dotenvLine(name, own.values[name] as string)}\n`).join(""),
    valueNames: names,
    missing: own.missing,
    defaulted: env.defaulted,
    build: { env: env.buildEnv, secrets: env.buildSecrets, names: Object.keys(env.values.build) },
  };
}

/**
 * Stops (`INVALID_INPUT`, before any change) when `.env.<env>` lacks a value the app needs, and
 * says which variables previews leave to the app's defaults (names only).
 */
export function requirePreviewValues(
  deps: Pick<PhaseDeps, "paths" | "reporter">,
  env: Pick<PreviewEnvironment, "missing" | "defaulted">,
  command: string,
): void {
  const file = valuesFile(deps);
  if (env.missing.length > 0) {
    const one = env.missing.length === 1;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${file} has no value for ${listText(env.missing)}, which the app needs, so previews could not start. Nothing was changed.`,
      {
        hint: `Put test values for ${one ? "it" : "them"} in ${file} (anyone who can push a branch can read them), then run \`${command}\` again.`,
      },
    );
  }
  if (env.defaulted.length > 0) {
    const one = env.defaulted.length === 1;
    deps.reporter.info(
      `${listText(env.defaulted)} ${one ? "has" : "have"} no value in ${file}, so previews use the default${one ? "" : "s"} in the app's code.`,
    );
  }
}

/**
 * Stops (`PHASE_PRECONDITION`, before any change on it) when the inspected facts of the user's own
 * server show another app recorded there, as design does: previews run pull requests' code, so
 * their server runs nothing else. `app` is the preview environment's own.
 */
export function requireServerForPreviews(facts: HostFacts, app: string, command: string): void {
  const others = readableRecords(facts.apps)
    .map((record) => record.app)
    .filter((name) => name !== app);
  if (others.length === 0) return;
  const one = others.length === 1;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `Your server holds ${listText(others.map((name) => `"${name}"`))}, and previews run pull requests' code: it would run beside ${one ? "it" : "them"}, so previews need a server with nothing else on it. Nothing on it was changed.`,
    { hint: `Give the preview environment a server of its own, then run \`${command}\` again.` },
  );
}

/** The SHA-256 of the preview values this computer last installed on the preview server. */
const ValuesDigestSchema = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** Where it is kept: the environment's folder in the user's OpsCrew home. */
function valuesDigestFile(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.projectHomeDir, "preview_values.json");
}

/** What {@link applyPreviewsHostPlan} needs besides the preview environment's plan. */
export interface PreviewsHostInput {
  /** The preview server, inspected now (`serverForNetwork`). */
  server: NetworkServer;
  /** The rendered recipe (`renderPreviewRecipe`), as the deploy-setup pull request commits it. */
  recipe: readonly RenderedFile[];
  env: PreviewEnvironment;
  key: KeyPair;
  /** `<owner>/<repo>`. */
  repository: string;
  /** The image previews may run, `ghcr.io/<owner>/<repo>[/<app key>]`. */
  imageName: string;
  /** GitHub enforces branch rules on the repository's environments (`placeDeploySecrets`). */
  branchRules: boolean | undefined;
  /** The sites' secrets any workflow can read anyway (`placeDeploySecrets`' `readable`). */
  readable: readonly string[];
  command: string;
  phase: PhaseName;
}

/**
 * The previews' bounds in words (FR-2206), for the host plan's approval; `file` is the values'
 * file.
 */
function bounds(
  plan: DeployPlan,
  previews: Previews,
  input: PreviewsHostInput,
  file: string,
): string[] {
  const prefix = `${previewRecipeDir(plan)}/template/`;
  const files = input.recipe.flatMap((file) =>
    file.path.startsWith(prefix) ? [file.path.slice(prefix.length)] : [],
  );
  const limits = appMemoryLimits(plan).map((limit) => `${limit.name} ${limit.memoryMb} MB`);
  const names = input.env.valueNames;
  return [
    `  At most ${plural(previews.cap, "preview")} at once; a preview with no push for ${plural(previews.lifetimeDays, "day")} is removed.`,
    `  Addresses: pr-<number>.${previews.domain}, DNS only, each with its own certificate and marked noindex.`,
    `  Image: only ${input.imageName}, pinned by digest.`,
    `  Each preview runs ${listText(limits)} (their memory limits), on its own network with its own volumes; its passwords and keys are made on the server for it and never leave it.`,
    typeof previews.seed === "string"
      ? `  Seed: \`${previews.seed}\`, once for each new preview (tried again at its next update until it succeeds).`
      : "  Seed: none; each preview starts with empty databases.",
    `  Each preview's files, from template/ in ${appDir(plan)}: ${listText(files)}.`,
    `  Preview values from ${file} (names only): ${names.length === 0 ? "none" : listText(names)}.`,
  ];
}

/**
 * The previews host plan (`planAddon("previews")`, plan.md "7." step 3): the rendered recipe, the
 * preview key's restricted line and the hourly cleanup on the preview server, and `values.env`
 * from the preview values, supplied only at apply. Its approval states the standing approval with
 * every bound and the values' names (and, where GitHub enforces no branch rules, that any
 * workflow can read every secret of the repository), and needs `allowDestroy` with `<app>-<env>`
 * typed. A changed recipe is a change the server's facts show; changed values are one when their
 * digest differs from the one this computer kept after the last apply (`secretsChanged`), which is
 * written once the plan is applied.
 */
export async function applyPreviewsHostPlan(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: PreviewsHostInput,
): Promise<HostPlanOutcome> {
  const previews = plan.environment?.previews as Previews;
  const { server, repository } = input;
  const dir = previewRecipeDir(plan);
  const files = Object.fromEntries(
    input.recipe.map((file) => [file.path.slice(dir.length + 1), file.content]),
  );
  const digest = sha256Hex(input.env.values);
  const kept = await readValidJson(valuesDigestFile(deps), ValuesDigestSchema);
  const own = plan.target.provider === "own";
  const hostPlan = planAddon("previews", {
    app: plan.app.name,
    runAs: own ? "root" : "login",
    facts: server.facts,
    repository,
    enable: { files, publicKey: input.key.publicKeyOpenSsh, valueNames: input.env.valueNames },
    secretsChanged: kept?.sha256 !== digest,
  });
  const words = own ? "your server" : "the preview server";
  const outcome = await approveAndApplyHostPlan(deps, {
    plan: hostPlan,
    remote: server.remote,
    apply: server.apply,
    verifyLogin: server.verifyLogin,
    title: `Let GitHub Actions run previews of ${repository}'s pull requests on ${words}, within the recipe's bounds`,
    server: words,
    planOf: words,
    upToDate: `The previews' recipe on ${words} is as approved; nothing on it changes.`,
    command: input.command,
    phase: input.phase,
    allowDestroy: true,
    intro: [
      "The standing approval: GitHub Actions will create, update and delete previews of same-repository pull requests within these bounds without asking again; each preview's data is deleted when it ends.",
      `Its bounds, which ${previewCommand(plan.app.name)} enforces on the server whatever a pull request's workflow asks:`,
      ...bounds(plan, previews, input, valuesFile(deps)),
      `Only runs of pull requests from branches of ${repository} get the preview key: forks' and Dependabot's runs get no secrets. Changing a bound or a value is a new plan to approve.`,
      ...(input.branchRules === true
        ? input.readable
        : [
            `GitHub enforces no branch rules on the environments of ${repository} (GitHub Free has none in private repositories), so any workflow, a pull request's included, can read every secret of the repository.`,
          ]),
    ],
    secrets: async () => ({ previewValues: input.env.values }),
    applying: `Installing the previews' recipe on ${words}`,
  });
  if (outcome.applied) {
    await writeFileAtomic(valuesDigestFile(deps), `${JSON.stringify({ sha256: digest })}\n`, {
      mode: 0o600,
    });
  }
  return outcome;
}

/**
 * The secrets the preview workflow reads (FR-2209): the server's address and known hosts, the
 * preview key's private half (never the deploy key's) and the build values; no app or service env
 * secret.
 */
export function previewDeploySecrets(input: {
  host: string;
  knownHosts: string;
  key: KeyPair;
  env: Pick<PreviewEnvironment, "build">;
}): Record<string, string> {
  return {
    [DEPLOY_SECRETS.host]: input.host,
    [DEPLOY_SECRETS.sshKey]: input.key.privateKeyOpenSsh,
    [DEPLOY_SECRETS.knownHosts]: input.knownHosts,
    [DEPLOY_SECRETS.buildEnv]: input.env.build.env,
    [DEPLOY_SECRETS.buildSecrets]: input.env.build.secrets,
  };
}
