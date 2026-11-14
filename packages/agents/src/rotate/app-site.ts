/**
 * `opscrew rotate app…` for a server-less site, on Cloudflare or GitHub Pages (025 plan.md 6.,
 * US4): the site reads each of the app's values from its own GitHub secret (`OPSCREW_ENV_<NAME>`)
 * when its workflow deploys, so the new values replace those secrets and a deploy, started and
 * followed to its end, gives them to the site. One plan approved by its hash (`remote-exec`, as
 * `keys.ts`: never granted by `--yes`), with the app's name typed when users are logged out
 * (`./app-values`); the old and new values
 * stay in the environment's unfinished rotation (`./values-pending`, target `site`) until the
 * deploy passed, so running the command again goes on with the same values and `--undo` puts the
 * old ones back with a deploy. The site's workflow reads the previous values a rotation keeps
 * (`APP_PREVIOUS_KEYS`) from their own secrets too, left out while a secret is empty or unset. No
 * value is shown, logged or audited.
 */
import { posix } from "node:path";
import type { GitHubClient } from "@opscrew/connector-github";
import { canonicalJson, listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import { deploySecretName, deploySecretNamesFor, siteEnvSecret } from "@opscrew/iac-templates";
import { type DeployPlan, isServerlessTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { requireNoCloudflareMove } from "../provision/guard";
import { setSecretAt } from "../provision/secrets";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { registerAppSecrets } from "../shared/app-secrets";
import { requestApproval } from "../shared/approvals";
import { type DispatchRepository, dispatchAndFollow } from "../shared/deploy-run";
import { continued } from "../shared/errors";
import {
  type AppValues,
  appConsequence,
  appFingerprints,
  appSecretLines,
  appSecretNames,
  isAppName,
  newAppValues,
} from "./app-values";
import { undoHash } from "./plan";
import { assertValuesCurrent } from "./record";
import { completePendingRotation } from "./values";
import {
  beganElsewhere,
  dropPendingRotation,
  forgetPlannedRotation,
  keepPendingRotation,
  nothingToUndo,
  type PendingRotation,
  type RotationValues,
  readPendingRotation,
  rotateCommand,
  sameNames,
  unfinishedRotation,
} from "./values-pending";

/** What a site's rotation reaches: the repository's secrets and its deploy workflow. */
export interface SiteRotationOptions {
  github: DispatchRepository & {
    api: Pick<
      GitHubClient,
      | "setActionsSecret"
      | "setEnvironmentSecret"
      | "deleteActionsSecret"
      | "dispatchWorkflow"
      | "waitForWorkflowRun"
    >;
  };
  /** `--undo`: puts the old values of the unfinished rotation back instead. */
  undo?: boolean;
}

/** A finished rotation, or its undo. */
export interface SiteRotation {
  /** The hash its plan (or its undo) was approved by. */
  hash: string;
  /** The recovery copy, refreshed: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/** A variable of the app and the repository secret the site's workflow reads it from. */
interface SiteSecret {
  variable: string;
  name: string;
}

/**
 * The repository secret of each variable of `values` (`OPSCREW_ENV_<NAME>`, with the environment's
 * prefix).
 * @throws OpsCrewError `PHASE_PRECONDITION` when the site's workflow does not read them: a
 * promoted environment deploys the build of another, which holds its values.
 */
function siteSecrets(plan: DeployPlan, values: AppValues, environment: string): SiteSecret[] {
  const read = new Set(deploySecretNamesFor(plan));
  const variables = Object.keys(values);
  if (variables.every((variable) => read.has(siteEnvSecret(variable)))) {
    return variables.map((variable) => ({
      variable,
      name: deploySecretName(plan, siteEnvSecret(variable)),
    }));
  }
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The ${environment} environment deploys the site built for the environment it is promoted from, which holds the app's values, so its own secrets change nothing. Nothing was changed.`,
    { hint: "Rotate the app's secrets in the environment the site is built in." },
  );
}

/** The SHA-256 the rotation's approval is bound to: where, which secrets, the values' fingerprints. */
function siteHash(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  values: AppValues,
  secrets: readonly string[],
): string {
  return sha256Hex(
    canonicalJson({
      rotation: "app",
      target: "site",
      environment: deps.paths.environment,
      app: plan.app.name,
      secrets,
      workflow: plan.cicd.workflowPath,
      branch: plan.cicd.branch,
      values: appFingerprints(values),
    }),
  );
}

/**
 * Each of `secrets` set to `values`' `side`, as a repository secret, or deleted where that side is
 * empty (a previous value not kept, or dropped); audited by name only.
 */
async function setSecrets(
  deps: PhaseDeps,
  github: SiteRotationOptions["github"],
  values: AppValues,
  secrets: readonly SiteSecret[],
  side: "old" | "new",
): Promise<void> {
  const { api, owner, repo } = github;
  for (const { variable, name } of secrets) {
    const value = values[variable]?.[side];
    if (value === undefined) throw new Error(`The rotation has no value of ${variable}.`);
    if (value !== "") {
      await setSecretAt(deps, github, { name }, value);
      continue;
    }
    await api.deleteActionsSecret(owner, repo, name);
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `delete secret ${name}`,
      target: `${owner}/${repo}`,
      decision: "approved",
    });
  }
}

/** The site's deploy workflow, started on its branch and followed to a deploy. */
async function deploy(
  deps: PhaseDeps,
  plan: DeployPlan,
  github: SiteRotationOptions["github"],
  input: { again: string; hash: string },
): Promise<void> {
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const { branch } = plan.cicd;
  deps.reporter.step(`Starting ${workflowFile} on ${branch}, which deploys the site with them`);
  const run = await dispatchAndFollow(deps, github, {
    workflowFile,
    ref: branch,
    inputs: {},
    target: deps.paths.environment,
    command: input.again,
    detail: `${workflowFile} on ${branch}: the deploy of the app's rotated secrets (rotation ${input.hash})`,
  });
  if (run.status === "deployed") return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${deps.paths.environment}'s deploy run waits in GitHub for a required reviewer (${run.runUrl}), so the site does not run on the values yet.`,
    { hint: "Approve the run in GitHub and let it finish." },
  );
}

/** `error` with what stays true and how to go on: the values kept, run again or undo. */
function stopped(error: unknown, again: string, undoing: boolean): unknown {
  return continued(error, {
    said: "The old and the new values stay on this computer until the rotation is done or undone.",
    next: undoing
      ? `Then run \`${again} --undo\` again to finish the undo.`
      : `Then run \`${again}\` again to go on, or \`${again} --undo\` to put the old values back.`,
  });
}

/**
 * Rotates the app's own secrets `names` (`app`, `app:<NAME>`) of `plan`'s server-less site, or
 * with `options.undo` puts the old values of the unfinished rotation back: refused before any
 * change for another name, by the two-computer guard, while another rotation is unfinished (or
 * began elsewhere), and for a promoted environment that reads none of its own values. New values
 * (each in its format) are kept beside the old in the unfinished rotation, with the plan's hash,
 * before the approval (`remote-exec`, by its hash; the app's name typed when users are logged
 * out); then the site's GitHub secrets are replaced and its deploy started and followed to its
 * end; the new values become the app's own, the rotation is recorded and the recovery copy
 * refreshed. A failure keeps the values and says how to go on or undo.
 * @throws OpsCrewError `INVALID_INPUT`, `PHASE_PRECONDITION` for the refusals, `APPROVAL_REFUSED`,
 * and the failed step's error.
 */
export async function rotateSiteAppSecrets(
  deps: PhaseDeps,
  plan: DeployPlan,
  names: readonly string[],
  options: SiteRotationOptions,
): Promise<SiteRotation> {
  requireNoCloudflareMove(plan);
  if (!isServerlessTarget(plan.target)) {
    throw new Error(
      `rotateSiteAppSecrets rotates a site's secrets, not on ${plan.target.provider}.`,
    );
  }
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const others = names.filter((name) => !isAppName(name));
  if (others.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${listText(others)} ${others.length === 1 ? "is" : "are"} not among the credentials of the site ${plan.app.name}: it runs no service, and only its own secrets (app, app:<NAME>) rotate here. Nothing was changed.`,
      { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
    );
  }
  await assertValuesCurrent(deps);
  await registerAppSecrets(deps, plan);
  const named = await appSecretNames(deps, plan, names);
  const again = rotateCommand(named, flags);
  const existing = await readPendingRotation(deps);
  const reused = existing !== undefined && sameNames(existing.names, named) ? existing : undefined;
  if (existing !== undefined && reused === undefined && existing.step !== "planned") {
    throw unfinishedRotation(existing, environment, flags);
  }
  const began = reused !== undefined && reused.step !== "planned" ? reused : undefined;
  if (began !== undefined && began.target !== "site") throw beganElsewhere(began, "site", again);
  if (options.undo === true && reused === undefined) throw nothingToUndo(named, environment);
  if (options.undo === true && began === undefined && reused !== undefined) {
    await forgetPlannedRotation(deps, named);
    return { hash: reused.hash, copy: { changed: false } };
  }
  const appValues = reused?.app ?? (await newAppValues(deps, plan, named));
  const values: RotationValues = { names: named, services: {}, app: appValues };
  const secrets = siteSecrets(plan, appValues, environment);
  const hash = siteHash(
    deps,
    plan,
    appValues,
    secrets.map((secret) => secret.name),
  );
  if (began !== undefined && began.hash !== hash) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The rotation of ${listText(named)} began under another plan (the plan or its workflow changed since), and GitHub may hold its new values. Nothing was changed.`,
      {
        hint: `Put opscrew/ back as it was when the rotation began, then run \`${again}\` again.`,
      },
    );
  }
  const pending: PendingRotation = {
    ...values,
    hash,
    step: began?.step ?? "planned",
    target: "site",
  };
  // Kept before the approval, so a run approved by the hash shown reuses the same values.
  await keepPendingRotation(deps, pending);
  const repository = `${options.github.owner}/${options.github.repo}`;
  const secretsText = `${repository}'s repository secret${secrets.length === 1 ? "" : "s"} ${listText(secrets.map((secret) => secret.name))}`;

  if (options.undo === true) {
    const undo = undoHash(hash);
    await requestApproval(deps, {
      title: `Put the old values of ${listText(named)} back in ${environment}`,
      details: [
        `The rotation ${hash} of ${listText(named)} in ${environment} stopped before it finished; its old values come back, and the new ones are dropped.`,
        `1. ${secretsText} get the old values back.`,
        "2. The site's deploy is started and followed to its end, so the site runs on them again.",
        `Undo hash: ${undo}`,
      ].join("\n"),
      hash: undo,
      refused: {
        plan: `undo of the rotation of ${listText(named)}`,
        unchanged: "Nothing in GitHub was changed.",
        again: `${again} --undo`,
      },
    });
    try {
      deps.reporter.step("Putting the old values back in the site's GitHub secrets");
      await setSecrets(deps, options.github, appValues, secrets, "old");
      await deploy(deps, plan, options.github, { again: `${again} --undo`, hash });
    } catch (error) {
      throw stopped(error, again, true);
    }
    await dropPendingRotation(deps);
    deps.reporter.success(
      `Put the old values of ${listText(named)} back in ${environment}: the site runs on them again, and the new ones are forgotten.`,
    );
    return { hash: undo, copy: await refreshRecoveryCopy(deps, plan) };
  }

  const consequence = appConsequence(plan, appValues);
  await requestApproval(deps, {
    title: `Rotate the credentials of ${listText(named)} in ${environment}`,
    details: [
      ...(consequence === undefined ? [] : [consequence.line]),
      `New values made on this computer replace those of ${listText(named)} in ${environment}; neither the old nor the new ones are ever shown.`,
      ...appSecretLines(appValues),
      `1. ${secretsText} ${secrets.length === 1 ? "is" : "are"} replaced with the new values, encrypted on this computer before upload.`,
      `2. The site's deploy (${posix.basename(plan.cicd.workflowPath)} on ${plan.cicd.branch}) is started and followed to its end: the site runs on the new values from then on.`,
      "3. The new values become the app's own on this computer, the rotation is recorded, and the recovery copy is refreshed.",
      `The old values stay on this computer until the deploy passed: if a step fails, \`${again}\` goes on, and \`${again} --undo\` puts the old values back.`,
      `Rotation hash: ${hash}`,
    ].join("\n"),
    hash,
    guard: consequence?.guard,
    refused: {
      plan: `rotation of ${listText(named)}`,
      unchanged: "Nothing in GitHub was changed.",
      again,
    },
  });
  await keepPendingRotation(deps, { ...pending, step: "started" });
  try {
    deps.reporter.step("Replacing the site's GitHub secrets with the new values");
    await setSecrets(deps, options.github, appValues, secrets, "new");
    await deploy(deps, plan, options.github, { again, hash });
  } catch (error) {
    throw stopped(error, again, false);
  }
  await completePendingRotation(deps, plan, values);
  deps.reporter.success(
    `Rotated ${listText(named)} in ${environment}: the site runs on the new values, and the old ones no longer work.`,
  );
  return { hash, copy: await refreshRecoveryCopy(deps, plan) };
}
