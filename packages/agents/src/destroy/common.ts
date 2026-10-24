import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import { githubConnector } from "@opscrew/connector-github";
import type { ApprovalRecord, PlanSummary, ResourceChange } from "@opscrew/contracts";
import {
  errorMessage,
  isUserFacingError,
  OpsCrewError,
  plural,
  tfstateFile,
  toPosixRelative,
  upperFirst,
} from "@opscrew/core";
import { engineLabel } from "@opscrew/iac-engine";
import {
  type DeployPlan,
  ghcrImageFor,
  isServerlessTarget,
  writeArtifact,
} from "@opscrew/plan-schema";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";
import { VPS_PROVIDERS } from "../providers";
import {
  deploySecretNames,
  deploySecretPlaces,
  readSecretsRecord,
  secretsEnvironment,
} from "../provision/secrets";
import { planWhere } from "../runners/words";
import {
  approvalEntry,
  describeChanges,
  existingStateEngine,
  gitClient,
  githubClientFromToken,
  githubCoordinates,
  type ProjectEngine,
  planStop,
  recordServerAddress,
  refusalReason,
  stateCopyPaths,
  stateNotHere,
} from "../shared";
import { hintOf } from "../shared/errors";
import {
  requireTunnelClosed,
  tunnelBusyError,
  tunnelChange,
  tunnelSafeEngine,
} from "../shared/tunnel-connections";
import { planHeading } from "./checks";
import {
  applyApprovedPlan,
  assertDeletionPlan,
  type DeletionScope,
  type DeletionSession,
  discardPlan,
  previewDeletion,
  savePlan,
} from "./deletion";
import type { DeletionProvider, DestroyGitHubApi, DestroyOptions, DestroyServices } from "./types";

/** The command every hint of a stopped teardown tells the user to run again. */
export const COMMAND = "opscrew destroy";

/** The next step after the user did not approve a teardown's host or stack plan. */
export const SHOWS_PLAN_AGAIN = `Run \`${COMMAND}\` again when you are ready; it shows the plan again.`;

/** The next step after a teardown's apply failed part of the way. */
export const CONTINUES_WITH_LEFT = `Fix the cause shown above, then run \`${COMMAND}\` again; it continues with what is left.`;

/** The next step after the user did not type the app's name to approve a teardown. */
export function typeNameHint(name: string): string {
  return `Run \`${COMMAND}\` again and type ${name} when you are ready.`;
}

/** The next step when the plan to delete differs from what was confirmed or applied. */
export const DRIFT_THEN_DESTROY =
  "Run `opscrew drift` to see what changed, then run `opscrew destroy` again.";

/** Where the deploy secrets live, and why they cannot be removed when `api` is missing. */
export interface GitHubTarget {
  owner?: string;
  repo?: string;
  api?: DestroyGitHubApi;
  skipReason?: string;
}

/** The teardown's deletion scope (`opscrew destroy`) where the app runs. */
export function teardownScope<P extends DeletionProvider>(
  deps: PhaseDeps,
  plan: DeployPlan,
  provider: P,
): DeletionScope & { provider: P } {
  return {
    deps,
    provider,
    app: plan.app.name,
    command: COMMAND,
    what: "teardown",
    phase: "provision",
  };
}

export function nothingDeployed(plan: DeployPlan): OpsCrewError {
  const own = plan.target.provider === "own";
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Nothing is deployed for this project, so there is nothing to destroy.",
    {
      hint: plan.deployment.destroyedAt
        ? `OpsCrew already tore this deployment down (${plan.deployment.destroyedAt}). Run \`opscrew provision\` to create a new one.${own ? " To also undo OpsCrew's changes to your server, run `opscrew destroy --undo-host`." : ""}`
        : "Run `opscrew provision` to create a deployment.",
    },
  );
}

/** 1. The infrastructure state is not on this computer: nothing can be planned, nothing changes. */
export async function teardownStateNotHere(root: string, plan: DeployPlan): Promise<OpsCrewError> {
  const { flag } = await planWhere(root, plan);
  const { folder, passphrase } = stateCopyPaths(plan);
  return stateNotHere(
    plan,
    "tell what to delete",
    `Run \`opscrew destroy${flag}\` on the computer that ran \`opscrew provision${flag}\`, or copy its ${folder} folder (and, with OpenTofu, its state passphrase from ${passphrase}) here, then try again.`,
  );
}

/**
 * 1. Stops (nothing changed) unless the infrastructure code is in the working tree: without it
 * OpsCrew cannot plan `what` (`the teardown`).
 */
export async function requireInfraCode(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  what: string,
): Promise<void> {
  try {
    await readdir(join(deps.paths.root, plan.infra.dir));
  } catch {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The infrastructure code (${plan.infra.dir}) is missing, so OpsCrew cannot plan ${what}. Nothing was changed.`,
      {
        hint: `Check out the branch that contains ${plan.infra.dir} (OpsCrew added it with the pull request \`opscrew provision\` opened), then run \`opscrew destroy\` again.`,
      },
    );
  }
}

/** 2. Cloudflare token (only when the plan manages DNS there); stops when it is missing or broken. */
export async function checkCloudflare(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: DestroyServices,
): Promise<boolean> {
  if (plan.dns.provider !== "cloudflare") return false;
  const connector = cloudflareConnector(deps);
  const requirement = connector.credentials;
  const api = services.cloudflare === undefined ? (connector.client ?? null) : services.cloudflare;
  const help = `It needs: ${requirement.scopes.join(", ")}. Create one at ${requirement.createUrl}`;
  if (api === null) {
    const { target } = plan;
    const domain = plan.dns.domain ?? "the app";
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No Cloudflare token found: set ${requirement.envVars.join(" or ")}. Nothing was changed.`,
      {
        hint:
          target.provider === "own"
            ? `The app's DNS records${target.access === "tunnel" ? ", its Cloudflare Tunnel and Access" : ""} for ${domain} are on Cloudflare, and OpsCrew removes them as part of the teardown. ${help}`
            : isServerlessTarget(target)
              ? `The site's ${target.provider === "github-pages" ? "DNS records" : "Worker and its custom domains"} for ${domain} are on Cloudflare, and OpsCrew removes them as part of the teardown. ${help}`
              : `The deployment's DNS records for ${domain} are on Cloudflare; deleting the server without them would leave them pointing at a dead address. ${help}`,
      },
    );
  }
  const check = await api.verifyToken();
  if (!check.ok) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `Cloudflare: ${deps.redactor.redact(check.message)}`,
      {
        hint: `The token ${help}`,
      },
    );
  }
  return true;
}

/**
 * 2. GitHub repository and token for the secret cleanup; optional, so a problem becomes the reason
 * the teardown cannot remove the deploy secrets, said as a warning.
 */
export async function resolveGitHub(
  deps: PhaseDeps,
  services: DestroyServices,
): Promise<GitHubTarget> {
  const skipped = (github: GitHubTarget & { skipReason: string }): GitHubTarget => {
    deps.reporter.warn(
      `OpsCrew cannot remove the deploy secrets from GitHub Actions: ${github.skipReason}. The teardown continues; delete them yourself afterwards at ${secretsPage(github)}.`,
    );
    return github;
  };
  const git = gitClient(deps);
  let coordinates: { owner: string; repo: string };
  try {
    if (!(await git.isRepo())) {
      return skipped({ skipReason: "this project is not a git repository" });
    }
    coordinates = await githubCoordinates(git);
  } catch {
    return skipped({ skipReason: "the repository has no GitHub remote named origin" });
  }
  const api = services.github === undefined ? await githubClientFromToken(deps) : services.github;
  if (!api) {
    const variables = githubConnector({ token: undefined, fetch: deps.fetch }).credentials.envVars;
    return skipped({
      ...coordinates,
      skipReason: `no GitHub token was found (set ${variables.join(" or ")}, or sign in with \`gh auth login\`)`,
    });
  }
  return { ...coordinates, api };
}

export function secretsPage(github: GitHubTarget): string {
  return github.owner && github.repo
    ? `https://github.com/${github.owner}/${github.repo}/settings/secrets/actions`
    : "your repository's Settings → Secrets and variables → Actions";
}

/** 3. Engine, state encryption and `init` with the same backend path as provisioning. */
export async function setupEngine(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: Pick<DestroyOptions, "engine" | "services">,
): Promise<ProjectEngine> {
  const setup = await existingStateEngine(deps, plan, {
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    ...(options.services !== undefined ? { services: options.services } : {}),
    command: COMMAND,
  });
  deps.reporter.step(`Initialising ${engineLabel(setup.engine.info.name)} in ${plan.infra.dir}`);
  await setup.engine.init(join(deps.paths.root, plan.infra.dir), {
    env: setup.env,
    backendConfig: { path: tfstateFile(deps.paths) },
  });
  return setup;
}

/**
 * How the Cloudflare part of a teardown on a server the user owns or in their Portainer is worded:
 * what it deletes, where the app runs and why the tunnel goes last there.
 */
export interface CloudflareRemovalWords {
  /** What the plan deletes, e.g. `DNS records on Cloudflare`. */
  what: string;
  /** Where the app runs, as in "removed from your server": `your server` or `your Portainer`. */
  place: string;
  /**
   * Why the tunnel goes last, ending with a comma: `Cloudflare deletes a tunnel only after its
   * connector on your server has stopped,`.
   */
  tunnelAfter: string;
  /** What always stays, said with the approval. */
  stays: string;
}

/** The Cloudflare part of the teardown, planned and approved but not applied yet. */
export interface CloudflareRemoval {
  summary: PlanSummary;
  approval: ApprovalRecord;
  /** The plan deletes the app's Cloudflare Tunnel: it is applied after the app is gone. */
  tunnel: boolean;
  words: CloudflareRemovalWords;
}

/** The Cloudflare resources are the only ones in such a root module: anything else stops. */
function cloudflareOnly(changes: readonly ResourceChange[], note: string): void {
  const others = changes
    .filter((change) => !change.type.startsWith("cloudflare_"))
    .map((change) => change.address);
  if (others.length === 0) return;
  throw planStop(
    `The teardown plan would delete resources other than the app's Cloudflare DNS records, tunnel and Access, so OpsCrew stopped. ${note}`,
    others,
    "Run `opscrew drift` to see what changed in the infrastructure code, then run `opscrew destroy` again.",
  );
}

/**
 * 4. What the Cloudflare part of the teardown deletes, from a preview plan that is discarded (it
 * may only delete Cloudflare resources): the changes and their addresses to confirm.
 */
export async function previewCloudflareRemoval(
  session: DeletionSession,
  words: Pick<CloudflareRemovalWords, "what">,
): Promise<{ resources: ResourceChange[]; confirmed: ReadonlySet<string> }> {
  session.deps.reporter.step(
    `Planning the removal of the app's ${words.what} to see what it deletes`,
  );
  const preview = await previewDeletion(session, { suffix: "destroy-preview", destroy: true });
  cloudflareOnly(preview.changes, "Nothing was changed.");
  return { resources: preview.changes, confirmed: preview.addresses };
}

/**
 * 4. The teardown in words, shown before the typed confirmation: the Cloudflare resources and what
 * is `removed` where the app runs (step or change titles), in the order they go (the app first
 * when the Cloudflare plan deletes its tunnel), then `notes` and what stays.
 */
export function teardownSummary(input: {
  resources: readonly ResourceChange[];
  removed: readonly string[];
  words: CloudflareRemovalWords;
  notes?: readonly string[];
}): string {
  const { resources, removed, words } = input;
  const appFirst = tunnelChange(resources, "delete") && removed.length > 0;
  const cloudflare =
    resources.length > 0
      ? [
          appFirst
            ? `and then deletes these Cloudflare resources (${words.tunnelAfter} so they go last):`
            : "The teardown deletes these Cloudflare resources:",
          ...describeChanges(resources),
        ]
      : [];
  const app =
    removed.length > 0
      ? [
          appFirst || resources.length === 0
            ? `The teardown removes from ${words.place}:`
            : `and removes from ${words.place}:`,
          ...removed.map((title) => `  - ${title}`),
        ]
      : [];
  return [
    ...(appFirst ? [...app, ...cloudflare] : [...cloudflare, ...app]),
    ...(resources.length === 0 && removed.length === 0
      ? [
          `Nothing of the app is left to remove from Cloudflare or ${words.place}; OpsCrew finishes the cleanup.`,
        ]
      : []),
    ...(input.notes ?? []),
    words.stays,
  ].join("\n");
}

/**
 * 5. The Cloudflare part of the teardown, up to its approval: a destroy plan that may only delete
 * Cloudflare resources the user confirmed, approved with `allowDestroy` and the typed app name.
 * `appChanges` says whether the app is removed from where it runs (the next approval). `undefined`
 * (its plan file deleted) when nothing is left to delete; on any stop the plan file is deleted
 * too. {@link applyCloudflareRemoval} applies it and always deletes the plan file.
 */
export async function approveCloudflareRemoval(
  session: DeletionSession,
  input: {
    confirmed: ReadonlySet<string>;
    appChanges: boolean;
    words: CloudflareRemovalWords;
    notes?: readonly string[];
  },
): Promise<CloudflareRemoval | undefined> {
  const { deps, app: name } = session;
  const { words } = input;
  deps.reporter.step(`Planning the removal of the app's ${words.what}`);
  const summary = await savePlan(session, "destroy", { destroy: true });
  try {
    if (summary.changes.length === 0) {
      deps.reporter.info("Nothing is left to delete on Cloudflare.");
      await discardPlan(summary);
      return undefined;
    }
    assertDeletionPlan(session, summary, { confirmed: input.confirmed }, (problem) =>
      problem === "unconfirmed"
        ? {
            note: "Nothing was deleted.",
            hint: "Run `opscrew destroy` again to see the current list and confirm it.",
          }
        : {
            note: "Nothing was changed.",
            hint: DRIFT_THEN_DESTROY,
          },
    );
    cloudflareOnly(summary.changes, "Nothing was deleted.");
    const tunnel = tunnelChange(summary.changes, "delete");
    const count = summary.changes.length;
    const place = upperFirst(words.place);
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `Delete the ${words.what} of ${name} (${plural(count, "resource")} to delete)`,
      details: [
        planHeading(summary, "destroy plan"),
        ...describeChanges(summary.changes),
        !tunnel
          ? input.appChanges
            ? `${place} is not part of this plan; the app is removed from it in the next step.`
            : `${place} is not part of this plan.`
          : input.appChanges
            ? `${place} is not part of this plan. ${words.tunnelAfter} so OpsCrew removes the app from ${words.place} first (the next approval) and applies this plan after that.`
            : `${place} is not part of this plan. ${words.tunnelAfter} so OpsCrew applies this plan once Cloudflare reports no active connections for the tunnel.`,
        ...(input.notes ?? []),
        words.stays,
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
      allowDestroy: true,
      confirmPhrase: name,
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The teardown was not approved${refusalReason(approval)}. Nothing was deleted.`,
        { hint: typeNameHint(name) },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash, { allowDestroy: true });
    return { summary, approval, tunnel, words };
  } catch (error) {
    await discardPlan(summary);
    throw error;
  }
}

/**
 * 6. Applies the approved Cloudflare part of the teardown and deletes its plan file. A plan that
 * deletes a tunnel runs after the app is gone, and only once Cloudflare reports no active
 * connections for every tunnel it deletes (read-only polls, up to 3 minutes each); if they stay
 * open it stops before the apply, and Cloudflare's error 1022 during the apply becomes the same
 * plain message.
 */
export async function applyCloudflareRemoval(
  session: DeletionSession,
  removal: CloudflareRemoval,
  sleep: ((ms: number) => Promise<void>) | undefined,
): Promise<ResourceChange[]> {
  const { deps } = session;
  const { summary, words } = removal;
  const left = `The app is removed from ${words.place}; its Cloudflare resources are still there.`;
  try {
    const engine = tunnelSafeEngine(session.engine);
    if (removal.tunnel) {
      await requireTunnelClosed(deps, summary, {
        command: COMMAND,
        already: left,
        ...(sleep !== undefined ? { options: { sleep } } : {}),
      });
    }
    deps.reporter.step(`Deleting the ${words.what}`);
    try {
      await applyApprovedPlan(removal.tunnel ? { ...session, engine } : session, summary, {
        allowDestroy: true,
        what: "deleting the Cloudflare resources",
        hint: removal.tunnel
          ? `${left} Fix the cause shown above, then run \`opscrew destroy\` again to finish; it continues with what is left.`
          : CONTINUES_WITH_LEFT,
      });
    } catch (error) {
      if (!engine.refusedBusyTunnel) throw error;
      throw tunnelBusyError({ command: COMMAND, reason: "refused", already: left, cause: error });
    }
    deps.reporter.success(`Deleted ${plural(summary.changes.length, "Cloudflare resource")}.`);
    return summary.changes;
  } finally {
    await discardPlan(summary);
  }
}

/**
 * The error when a change on the user's server or in their Portainer stopped part-way: its own
 * words (an unexpected error as `Changing <place> stopped: …`), with `afterFailure` (what already
 * happened, and how to finish) after its hint, all passed through `say` (the redactor, and on a
 * server the user owns the server's names).
 */
export function stoppedPartWay(
  error: unknown,
  input: { place: string; afterFailure: string; say: (text: string) => string },
): OpsCrewError {
  const facing = isUserFacingError(error);
  const message = facing
    ? error.message
    : `Changing ${input.place} stopped: ${errorMessage(error)}`;
  const hint = facing && error.hint ? `${error.hint} ${input.afterFailure}` : input.afterFailure;
  return new OpsCrewError(
    error instanceof OpsCrewError ? error.code : "COMMAND_FAILED",
    input.say(message),
    { hint: input.say(hint), cause: error },
  );
}

/**
 * The GitHub environment destroy deletes with the plan environment's deploy secrets: the one they
 * live in ({@link secretsEnvironment}), never prod's `production` from another environment.
 */
function ownSecretsEnvironment(plan: DeployPlan): string | undefined {
  const environment = secretsEnvironment(plan);
  const prods = plan.environment?.name !== undefined && environment === "production";
  return prods ? undefined : environment;
}

/**
 * 8. Removes the plan environment's deploy secrets ({@link deploySecretPlaces}, its own names only)
 * after one `github-secrets` approval, the teardown's typed name confirms: the repository's, and
 * those in its GitHub environment one by one when the user made that environment (it stays, with
 * everything else in it). A GitHub environment OpsCrew created (its record says so) is deleted
 * with its secrets under the same approval. Names only, never values. Returns the names really
 * deleted. `done` says what is already gone when this step stops (for example `The
 * infrastructure is deleted.`).
 */
export async function removeDeploySecrets(
  deps: PhaseDeps,
  github: GitHubTarget,
  input: { plan: DeployPlan; done: string; reach: string },
): Promise<string[]> {
  const { api, owner, repo } = github;
  if (!api || !owner || !repo) return [];
  const where = `${owner}/${repo}`;
  const environment = ownSecretsEnvironment(input.plan);
  const created =
    environment !== undefined && (await readSecretsRecord(deps))?.createdEnvironment === true;
  const places = deploySecretPlaces(input.plan, environment);
  const inEnvironment = places.filter((place) => place.environment !== undefined);
  const oneByOne = created ? places.filter((place) => place.environment === undefined) : places;
  const repository = oneByOne.filter((place) => place.environment === undefined);
  const kept = created ? [] : inEnvironment;
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: created
      ? `Remove the deploy secrets from ${where}, with the GitHub environment ${environment} OpsCrew created`
      : `Remove the deploy secrets from ${where}`,
    details: [
      ...(repository.length > 0
        ? [
            "GitHub Actions secrets to delete (names only):",
            ...repository.map((place) => `  ${place.name}`),
          ]
        : []),
      ...(kept.length > 0
        ? [
            `Secrets to delete from the GitHub environment ${environment}, which stays as you set it up (names only):`,
            ...kept.map((place) => `  ${place.name}`),
          ]
        : []),
      ...(created
        ? [
            `The GitHub environment ${environment}, which OpsCrew created, to delete with the deploy secrets it holds (names only):`,
            ...inEnvironment.map((place) => `  ${place.name}`),
          ]
        : []),
      `Without them the deploy workflow cannot reach ${input.reach}; \`opscrew provision\` stores new ones.`,
    ].join("\n"),
  });
  if (!approval.approved) {
    // Only a server OpsCrew created has a pinned host key that destroy forgets.
    const vps = (VPS_PROVIDERS as readonly string[]).includes(input.plan.target.provider);
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The deploy secrets were not removed from ${where}. ${input.done}`,
      {
        hint: `Run \`opscrew destroy\` again to remove them and finish the cleanup (${vps ? "the pinned host key and " : ""}opscrew/plan.yaml).`,
      },
    );
  }
  const removed: string[] = [];
  for (const place of oneByOne) {
    try {
      if (place.environment === undefined) {
        await api.deleteActionsSecret(owner, repo, place.name);
      } else {
        await api.deleteEnvironmentSecret(owner, repo, place.environment, place.name);
      }
    } catch (error) {
      throw gitHubFailed(deps, error, {
        done: input.done.replace(/\.$/, ""),
        what: `removing the GitHub secret ${place.name}`,
      });
    }
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `delete secret ${place.name}${place.environment === undefined ? "" : ` in the environment ${place.environment}`}`,
      phase: "provision",
      target: where,
      decision: "approved",
    });
    removed.push(place.name);
  }
  if (removed.length > 0) {
    deps.reporter.success(
      `Removed ${removed.length} deploy secrets from GitHub Actions in ${where}.`,
    );
  }
  if (created && environment !== undefined) {
    try {
      await api.deleteEnvironment(owner, repo, environment);
    } catch (error) {
      throw gitHubFailed(deps, error, {
        done: `${input.done.replace(/\.$/, "")}, and the deploy secrets outside it are removed`,
        what: `deleting the GitHub environment ${environment}`,
      });
    }
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `delete environment ${environment}`,
      phase: "provision",
      target: where,
      decision: "approved",
    });
    deps.reporter.success(
      `Deleted the GitHub environment ${environment} of ${where}, with its ${inEnvironment.length} deploy secrets.`,
    );
    removed.push(...inEnvironment.map((place) => place.name));
  }
  return removed;
}

/**
 * 8. The error when GitHub refused or failed `what` after `done`: GitHub's own reason (the
 * connector's message: the HTTP status or GitHub's message) and its hint, redacted, and how to
 * finish.
 */
function gitHubFailed(
  deps: PhaseDeps,
  error: unknown,
  input: { done: string; what: string },
): OpsCrewError {
  const reason = isUserFacingError(error) ? error.message : "unexpected error";
  return new OpsCrewError(
    error instanceof OpsCrewError ? error.code : "PROVIDER_ERROR",
    deps.redactor.redact(`${input.done}, but ${input.what} failed: ${reason}`),
    {
      hint: deps.redactor.redact(
        `${hintOf(error)}Then run \`opscrew destroy\` again to finish the cleanup.`,
      ),
      cause: error,
    },
  );
}

/**
 * 8. OpsCrew's record of a finished teardown: `opscrew/plan.yaml` without the app's URL, with
 * `destroyedAt` and the plans this run's `approvals` approved; the record of the stored deploy
 * secrets goes (with `forgetAddress`, the server's address in `.opscrew/server.json` too) and the
 * `provision` phase is recorded as skipped with `summary`. Returns the plan as written.
 */
export async function recordTeardown(
  deps: Pick<PhaseDeps, "paths" | "clock" | "state">,
  plan: DeployPlan,
  approvals: readonly (ApprovalRecord | undefined)[],
  opts: { summary: string; forgetAddress: boolean },
): Promise<DeployPlan> {
  const at = deps.clock.now().toISOString();
  const { url, ...kept } = plan.deployment;
  const recorded = approvals.flatMap((record) =>
    record?.planHash === undefined ? [] : [approvalEntry(record)],
  );
  const destroyed: DeployPlan = {
    ...plan,
    updatedAt: at,
    approvals: [...plan.approvals, ...recorded],
    deployment: { ...kept, destroyedAt: at },
  };
  await writeArtifact("plan", deps.paths.files.plan, destroyed);
  if (opts.forgetAddress) await recordServerAddress(deps.paths, undefined);
  await rm(deps.paths.files.deploySecrets, { force: true });
  await deps.state.markPhase("provision", "skipped", opts.summary);
  return destroyed;
}

/**
 * 9. "What remains": the plan environment's deploy secrets, and the GitHub environment they live
 * in, when OpsCrew could not remove them (none when it could).
 */
export function deploySecretsLeft(
  github: GitHubTarget,
  input: { plan: DeployPlan; removed: readonly string[] },
): string[] {
  if (input.removed.length > 0 || github.skipReason === undefined) return [];
  const environment = ownSecretsEnvironment(input.plan);
  return [
    `The deploy secrets in GitHub Actions (${deploySecretNames(input.plan).sort().join(", ")}): OpsCrew did not remove them because ${github.skipReason}. Delete them at ${secretsPage(github)}${environment === undefined ? "" : `, and those in the GitHub environment ${environment} in the repository's Settings → Environments`}.`,
  ];
}

/**
 * 9. "What remains": the app's container images in GitHub's container registry, a further app's
 * package `<repo>/<key>` (`ghcrImageFor`).
 */
export function containerImagesLeft(github: GitHubTarget, plan: Pick<DeployPlan, "app">): string {
  const image = ghcrImageFor(
    github.owner && github.repo ? `${github.owner}/${github.repo}` : "<owner>/<repo>",
    plan.app.key,
  );
  return `The app's container images in GitHub's container registry (${image}). Delete them in the package settings on GitHub if you no longer need them.`;
}

/** What "What remains" names of the app's deployment files and the command that uses them. */
export interface DeploymentFiles {
  /** The app's artefacts folder (its prod's): `opscrew`, a further app's `opscrew/apps/<key>`. */
  folder: string;
  /** `opscrew provision` with the flags of the plan's app and environment (`planWhere`). */
  provision: string;
}

/** 9. "What remains": {@link DeploymentFiles} of the app `deps.paths` belong to. */
export async function deploymentFiles(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
): Promise<DeploymentFiles> {
  const { root } = deps.paths;
  return {
    folder: toPosixRelative(root, appPaths(deps.paths, deps.paths.app).artefactsDir),
    provision: `opscrew provision${(await planWhere(root, plan)).flag}`,
  };
}
