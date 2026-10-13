import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import {
  GitClient,
  GitHubClient,
  githubConnector,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import type { ApprovalRecord, IacEngine, ResourceChange } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { DEPLOY_SECRETS } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type ProviderProfile, planProvider, providerProfile } from "../providers";
import { checkProvider, githubCoordinates } from "../provision";
import {
  dataWarning,
  deletesServer,
  deletesUnconfirmedServer,
  deletionPlanProblems,
  describeChanges,
} from "./checks";
import {
  applyApprovedPlan,
  confirmDeletion,
  type DeletionSession,
  discardPlan,
  forgetHostKeys,
  infraDeclaresVariable,
  liftProtection,
  previewDeletion,
  remainingAfterDeletion,
  removeSnapshotRecord,
  savePlan,
  snapshotKeptNote,
  snapshotWanted,
  takeSnapshotBeforeDelete,
} from "./deletion";
import { type DestroyTexts, destroyTexts } from "./texts";
import type { DestroyGitHubApi, DestroyOptions, DestroyResult, DestroyServices } from "./types";

/** The command every hint of a stopped teardown tells the user to run again. */
const COMMAND = "opscrew destroy";

/**
 * Input variable that lifts the server's delete and rebuild protection (Hetzner root module, T303).
 * Providers without delete protection (DigitalOcean) have no such variable and get no `-var`.
 */
const PROTECTION_VARIABLE = "delete_protection";

/** Everything the plan and apply steps share. */
interface DestroyContext {
  /** Engine, root module and wording shared with the move's deletion steps. */
  session: DeletionSession;
  plan: DeployPlan;
  profile: ProviderProfile;
  texts: DestroyTexts;
  /** `-var`s of every plan: delete protection off where the provider has it. */
  vars?: Readonly<Record<string, string>>;
}

/** Where the deploy secrets live, and why they cannot be removed when `api` is missing. */
interface GitHubTarget {
  owner?: string;
  repo?: string;
  api?: DestroyGitHubApi;
  skipReason?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 0. A move to another provider is in progress (`plan.retarget`): two servers may exist and the
 * state is transitional, so destroy refuses before any check or change.
 */
function moveInProgress(plan: DeployPlan): OpsCrewError {
  const to = providerProfile(planProvider(plan)).displayName;
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `A move to ${to} is in progress, so OpsCrew will not delete this deployment.`,
    {
      hint: "Run `opscrew retarget` to continue the move, `opscrew retarget --finish` to complete it once traffic reaches the new server, or `opscrew retarget --abort` to go back before the DNS switch. Then run `opscrew destroy` again if you still want to delete the deployment.",
    },
  );
}

function nothingDeployed(plan: DeployPlan): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Nothing is deployed for this project, so there is nothing to destroy.",
    {
      hint: plan.deployment.destroyedAt
        ? `OpsCrew already tore this deployment down (${plan.deployment.destroyedAt}). Run \`opscrew provision\` to create a new one.`
        : "Run `opscrew provision` to create a deployment.",
    },
  );
}

/**
 * 1. A deployment and its state must be on this computer, with its infrastructure code; on a
 * provider with delete protection, code that can lift it.
 */
async function requirePreconditions(
  deps: PhaseDeps,
  plan: DeployPlan,
  profile: ProviderProfile,
  statePath: string,
) {
  if (!(await exists(statePath))) {
    if (plan.deployment.serverIpv4 === undefined) throw nothingDeployed(plan);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The infrastructure state of ${plan.app.name} is not on this computer (.opscrew/tfstate/prod.tfstate), so OpsCrew cannot tell what to delete. Nothing was changed.`,
      {
        hint: "Run `opscrew destroy` on the computer that ran `opscrew provision`, or copy its .opscrew/tfstate folder (and, with OpenTofu, its state passphrase from ~/.opscrew/projects/<project>/state_passphrase) here, then try again.",
      },
    );
  }
  const dir = join(deps.paths.root, plan.infra.dir);
  try {
    await readdir(dir);
  } catch {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The infrastructure code (${plan.infra.dir}) is missing, so OpsCrew cannot plan the teardown. Nothing was changed.`,
      {
        hint: `Check out the branch that contains ${plan.infra.dir} (OpsCrew added it with the pull request \`opscrew provision\` opened), then run \`opscrew destroy\` again.`,
      },
    );
  }
  // Without delete protection there is nothing to lift, so no variable for it is needed.
  if (!profile.deleteProtection) return;
  if (await infraDeclaresVariable(dir, PROTECTION_VARIABLE)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The infrastructure code in ${plan.infra.dir} was generated by an older OpsCrew and cannot lift the server's delete protection. Nothing was changed.`,
    {
      hint: "Run `opscrew provision` to regenerate the infrastructure files (its plan should show no changes), then run `opscrew destroy` again.",
    },
  );
}

/** 2. Cloudflare token (only when the plan manages DNS there); stops when it is missing or broken. */
async function checkCloudflare(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: DestroyServices,
): Promise<boolean> {
  if (plan.dns.provider !== "cloudflare") return false;
  const connector = cloudflareConnector({
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
  const requirement = connector.credentials;
  const api = services.cloudflare === undefined ? (connector.client ?? null) : services.cloudflare;
  const help = `It needs: ${requirement.scopes.join(", ")}. Create one at ${requirement.createUrl}`;
  if (api === null) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No Cloudflare token found: set ${requirement.envVars.join(" or ")}. Nothing was changed.`,
      {
        hint: `The deployment's DNS records for ${plan.dns.domain ?? "the app"} are on Cloudflare; deleting the server without them would leave them pointing at a dead address. ${help}`,
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

/** 2. GitHub repository and token for the secret cleanup; optional, so problems become a reason. */
async function resolveGitHub(deps: PhaseDeps, services: DestroyServices): Promise<GitHubTarget> {
  const git = new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
  });
  let coordinates: { owner: string; repo: string };
  try {
    if (!(await git.isRepo())) return { skipReason: "this project is not a git repository" };
    coordinates = await githubCoordinates(git);
  } catch {
    return { skipReason: "the repository has no GitHub remote named origin" };
  }
  let api: DestroyGitHubApi | null | undefined = services.github;
  if (api === undefined) {
    const token = await resolveGitHubToken(deps.env, deps.runner);
    if (token) deps.redactor.addLiteral(token, "github-token");
    api = token ? new GitHubClient({ token, fetch: deps.fetch, version: deps.version }) : null;
  }
  if (api === null) {
    const variables = githubConnector({ token: undefined, fetch: deps.fetch }).credentials.envVars;
    return {
      ...coordinates,
      skipReason: `no GitHub token was found (set ${variables.join(" or ")}, or sign in with \`gh auth login\`)`,
    };
  }
  return { ...coordinates, api };
}

function secretsPage(github: GitHubTarget): string {
  return github.owner && github.repo
    ? `https://github.com/${github.owner}/${github.repo}/settings/secrets/actions`
    : "your repository's Settings → Secrets and variables → Actions";
}

/** 3. Engine, state encryption and `init` with the same backend path as provisioning. */
async function setupEngine(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
  statePath: string,
): Promise<{ engine: IacEngine; env: Record<string, string | undefined> }> {
  const services = options.services ?? {};
  const preference = options.engine ?? plan.infra.engine;
  const engine = services.engine
    ? await services.engine(preference)
    : await selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
  deps.reporter.info(`Using ${engineLabel(engine.info.name)} ${engine.info.version}.`);
  const env: Record<string, string | undefined> = { ...deps.env };
  if (plan.infra.stateEncryption) {
    if (engine.info.name === "tofu") {
      // Read, never create: a new passphrase could not decrypt the existing state.
      const passphrase = (
        await readFile(deps.paths.files.statePassphrase, "utf8").catch(() => undefined)
      )?.trim();
      if (!passphrase) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "The OpenTofu state is encrypted, but this computer does not have its passphrase. Nothing was changed.",
          {
            hint: `Copy the state passphrase file from the computer that ran \`opscrew provision\` to ${deps.paths.files.statePassphrase}, then run \`opscrew destroy\` again.`,
          },
        );
      }
      deps.redactor.addLiteral(passphrase, "state-passphrase");
      env.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
    } else {
      deps.reporter.warn(
        "Terraform cannot read state that OpenTofu encrypted. If OpenTofu provisioned this deployment, run `opscrew destroy --engine tofu` instead.",
      );
    }
  }
  await mkdir(deps.paths.files.plansDir, { recursive: true });
  deps.reporter.step(`Initialising ${engineLabel(engine.info.name)} in ${plan.infra.dir}`);
  await engine.init(join(deps.paths.root, plan.infra.dir), {
    env,
    backendConfig: { path: statePath },
  });
  return { engine, env };
}

/**
 * 7. The destroy plan, approved with `allowDestroy` and the typed server name, then applied.
 * Returns the deleted resources and the approval (none when nothing was left to delete).
 */
async function destroyInfrastructure(
  ctx: DestroyContext,
  snapshotId: string | undefined,
  protectionOff: boolean,
  confirmed: { addresses: ReadonlySet<string>; serverIds: readonly string[] },
): Promise<{ destroyed: ResourceChange[]; approval?: ApprovalRecord }> {
  const { session, plan, texts } = ctx;
  const { deps } = session;
  const name = plan.app.name;
  // Once this run lifted delete protection (Hetzner), every later stop says so and how to undo it.
  const lifted = protectionOff
    ? ` Delete protection on ${name} is already lifted, so the ${texts.noun} is not protected against deletion now.`
    : "";
  const hintAfterLift = (hint: string) =>
    protectionOff
      ? `Run \`opscrew provision\` to turn delete protection back on, or ${hint.charAt(0).toLowerCase()}${hint.slice(1)}`
      : hint;
  deps.reporter.step("Planning the teardown");
  const summary = await savePlan(session, "destroy", {
    ...(ctx.vars ? { vars: ctx.vars } : {}),
    destroy: true,
  });
  try {
    if (summary.changes.length === 0) {
      deps.reporter.info("Nothing is left to delete.");
      return { destroyed: [] };
    }
    // The whole root module is deleted (no prefix), but only what the user confirmed.
    const problems = deletionPlanProblems(summary.changes, { confirmed: confirmed.addresses });
    if (problems.notDeletes.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        [
          `The teardown plan would do more than delete, so OpsCrew stopped. ${protectionOff ? "Nothing was deleted." : "Nothing was changed."}${lifted}`,
          ...problems.notDeletes.map((p) => `  ${p}`),
        ].join("\n"),
        {
          hint: hintAfterLift(
            "Run `opscrew drift` to see what changed, then run `opscrew destroy` again.",
          ),
        },
      );
    }
    if (problems.unconfirmed.length > 0) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        [
          `The teardown plan now deletes resources that were not in the list you confirmed, so OpsCrew stopped. Nothing was deleted.${lifted}`,
          ...problems.unconfirmed.map((address) => `  ${address}`),
        ].join("\n"),
        {
          hint: hintAfterLift(
            "Run `opscrew destroy` again to see the current list and confirm it.",
          ),
        },
      );
    }
    const serverDeleted = deletesServer(summary.changes, session.provider);
    // The snapshot was taken of the server in the confirmed preview; it must be the one deleted.
    if (deletesUnconfirmedServer(summary, session.provider, confirmed.serverIds)) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `The teardown plan now deletes a ${texts.noun} other than the one you confirmed (id ${confirmed.serverIds.join(", ")}), so OpsCrew stopped. Nothing was deleted.${lifted}${snapshotKeptNote(texts, snapshotId)}`,
        {
          hint: hintAfterLift(
            "Run `opscrew drift` to see what changed, then run `opscrew destroy` again to see the current list and confirm it.",
          ),
        },
      );
    }
    const warning = dataWarning(plan, serverDeleted);
    const unrecoverable =
      plan.target.backups && texts.keptBackups
        ? `What is stored on the ${texts.noun} can only be recovered from the automatic backups ${texts.company} keeps for a while after this.`
        : `What is stored on the ${texts.noun} cannot be recovered after this.`;
    const snapshotLine =
      snapshotId !== undefined
        ? `Snapshot: ${texts.snapshotRef(snapshotId)} keeps a copy of the ${texts.noun} (${texts.snapshotBilled}; OpsCrew never deletes it).`
        : serverDeleted
          ? `Snapshot: none. ${unrecoverable}`
          : "Snapshot: none.";
    const providers =
      plan.dns.provider === "cloudflare"
        ? `${texts.displayName} and Cloudflare`
        : texts.displayName;
    const count = summary.changes.length;
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: `Delete ${name} on ${providers} (${count} ${count === 1 ? "resource" : "resources"} to delete)`,
      details: [
        `${engineLabel(summary.engine.name)} ${summary.engine.version} destroy plan:`,
        ...describeChanges(summary.changes),
        ...(warning ? [warning] : []),
        snapshotLine,
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
      allowDestroy: true,
      confirmPhrase: name,
      costDelta: { amount: -plan.cost.monthly.amount, currency: plan.cost.monthly.currency },
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The teardown was not approved${approval.reason ? ` (${approval.reason})` : ""}. Nothing was deleted.${lifted}${snapshotKeptNote(texts, snapshotId)}`,
        {
          hint: protectionOff
            ? `Run \`opscrew provision\` to turn delete protection back on, or run \`opscrew destroy\` again and type ${name} to delete the deployment.`
            : `Run \`opscrew destroy\` again and type ${name} when you are ready.`,
        },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash, { allowDestroy: true });
    deps.reporter.step("Deleting the infrastructure (this usually takes a minute or two)");
    await applyApprovedPlan(session, summary, {
      allowDestroy: true,
      what: "deleting the infrastructure",
      hint: "Fix the cause shown above, then run `opscrew destroy` again; it continues with what is left.",
    });
    deps.reporter.success(`Deleted ${count} ${count === 1 ? "resource" : "resources"}.`);
    return { destroyed: summary.changes, approval };
  } finally {
    await discardPlan(summary);
  }
}

/** 8. Removes the deploy secrets after a `github-secrets` approval. Names only, never values. */
async function removeDeploySecrets(deps: PhaseDeps, github: GitHubTarget): Promise<string[]> {
  const { api, owner, repo } = github;
  if (!api || !owner || !repo) return [];
  const names = Object.values(DEPLOY_SECRETS).sort();
  const where = `${owner}/${repo}`;
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Remove the deploy secrets from ${where}`,
    details: [
      "GitHub Actions secrets to delete (names only):",
      ...names.map((name) => `  ${name}`),
      "Without them the deploy workflow cannot reach a server; `opscrew provision` stores new ones.",
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The deploy secrets were not removed from ${where}. The infrastructure is deleted.`,
      {
        hint: "Run `opscrew destroy` again to remove them and finish the cleanup (the pinned host key and opscrew/plan.yaml).",
      },
    );
  }
  const removed: string[] = [];
  for (const name of names) {
    try {
      await api.deleteActionsSecret(owner, repo, name);
    } catch (error) {
      const reason = isUserFacingError(error) ? error.message : "unexpected error";
      throw new OpsCrewError(
        error instanceof OpsCrewError ? error.code : "PROVIDER_ERROR",
        deps.redactor.redact(
          `The infrastructure is deleted, but removing the GitHub secret ${name} failed: ${reason}`,
        ),
        {
          hint: `${error instanceof OpsCrewError && error.hint ? `${error.hint} ` : ""}Then run \`opscrew destroy\` again to finish the cleanup.`,
        },
      );
    }
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `delete secret ${name}`,
      phase: "provision",
      target: where,
      decision: "approved",
    });
    removed.push(name);
  }
  deps.reporter.success(
    `Removed ${removed.length} deploy secrets from GitHub Actions in ${where}.`,
  );
  return removed;
}

/** 8. The plan without the server's addresses, with `destroyedAt` and the approvals recorded. */
function destroyedPlan(
  plan: DeployPlan,
  at: string,
  approvals: readonly (ApprovalRecord | undefined)[],
): DeployPlan {
  const { serverIpv4, serverIpv6, url, lastCompletedPhase, ...kept } = plan.deployment;
  const recorded = approvals
    .filter((a): a is ApprovalRecord => a?.planHash !== undefined)
    .map((a) => ({
      planHash: a.planHash as string,
      approver: a.approver,
      at: a.decidedAt,
      kind: "iac-apply",
    }));
  return {
    ...plan,
    updatedAt: at,
    approvals: [...plan.approvals, ...recorded],
    deployment: { ...kept, destroyedAt: at },
  };
}

/** 9. What still exists after the teardown, in plain English. */
function remainingAfterDestroy(input: {
  plan: DeployPlan;
  texts: DestroyTexts;
  snapshotId: string | undefined;
  github: GitHubTarget;
  secretsRemoved: readonly string[];
}): string[] {
  const { plan, texts, github } = input;
  const items = remainingAfterDeletion({
    provider: plan.target.provider,
    app: plan.app.name,
    snapshotId: input.snapshotId,
    backups: plan.target.backups,
  });
  if (input.secretsRemoved.length === 0 && github.skipReason) {
    items.push(
      `The deploy secrets in GitHub Actions (${Object.values(DEPLOY_SECRETS).sort().join(", ")}): OpsCrew did not remove them because ${github.skipReason}. Delete them at ${secretsPage(github)}.`,
    );
  }
  const image =
    github.owner && github.repo
      ? `ghcr.io/${github.owner}/${github.repo}`.toLowerCase()
      : "ghcr.io/<owner>/<repo>";
  items.push(
    `The app's container images in GitHub's container registry (${image}). Delete them in the package settings on GitHub if you no longer need them.`,
  );
  items.push(
    `The deployment files in the repository (opscrew/ and ${plan.cicd.workflowPath}). Pushes still build an image, but the deploy step fails until \`opscrew provision\` creates a new ${texts.noun} from these files.`,
  );
  items.push(
    "The project's SSH deploy key on this computer, kept so a new deployment can reuse it.",
  );
  return items;
}

/**
 * `opscrew destroy`: tears a deployment down through the same plan → approval → apply path as
 * provisioning (constitution I). In order: preconditions → credentials (the planned provider;
 * Cloudflare when used; GitHub optional) → engine and `init` → a preview destroy plan (never
 * applied) and the typed confirmation → optional server snapshot → on providers with delete
 * protection (Hetzner), a protection-lifting plan that may only change the server's protection
 * (`iac-apply` approval) → the destroy plan (`iac-apply` approval with `allowDestroy` and the
 * server name typed to confirm) → removal of the GitHub deploy secrets (`github-secrets`
 * approval), the pinned host key and the plan's server addresses. A refusal or failure at any step
 * leaves everything after it untouched, and running it again continues where it stopped.
 */
export async function runDestroy(
  deps: PhaseDeps,
  options: DestroyOptions = {},
): Promise<DestroyResult> {
  const services = options.services ?? {};
  const plan = await readArtifact("plan", deps.paths.files.plan);
  // 0. Never during a move: it has its own deletions (`opscrew retarget --finish` / `--abort`).
  if (plan.retarget !== undefined) throw moveInProgress(plan);
  const name = plan.app.name;
  const provider = planProvider(plan);
  const profile = providerProfile(provider);
  const texts = destroyTexts(provider);
  const statePath = join(deps.paths.files.tfstateDir, "prod.tfstate");

  // 1. Preconditions
  await requirePreconditions(deps, plan, profile, statePath);

  // 2. Credentials
  const usesCloudflare = plan.dns.provider === "cloudflare";
  deps.reporter.step(
    `Checking your ${profile.displayName}${usesCloudflare ? ", Cloudflare" : ""} and GitHub access`,
  );
  await checkProvider(deps, provider, services);
  await checkCloudflare(deps, plan, services);
  const github = await resolveGitHub(deps, services);
  if (github.skipReason) {
    deps.reporter.warn(
      `OpsCrew cannot remove the deploy secrets from GitHub Actions: ${github.skipReason}. The teardown continues; delete them yourself afterwards at ${secretsPage(github)}.`,
    );
  }

  // 3. Engine, state encryption, init
  const { engine, env } = await setupEngine(deps, plan, options, statePath);
  const session: DeletionSession = {
    deps,
    provider,
    app: name,
    command: COMMAND,
    what: "teardown",
    phase: "provision",
    engine,
    env,
    dir: join(deps.paths.root, plan.infra.dir),
    stamp: deps.clock.now().toISOString().replace(/[:.]/g, "-"),
  };
  const vars = profile.deleteProtection ? { [PROTECTION_VARIABLE]: "false" } : undefined;
  const ctx: DestroyContext = { session, plan, profile, texts, ...(vars ? { vars } : {}) };

  // 4. Preview: what the teardown deletes (this plan is never applied)
  deps.reporter.step("Planning the teardown to see what it deletes");
  const preview = await previewDeletion(session, {
    suffix: "destroy-preview",
    ...(vars ? { vars } : {}),
    destroy: true,
  });
  if (preview.changes.length === 0 && plan.deployment.serverIpv4 === undefined) {
    throw nothingDeployed(plan);
  }
  // Which server that is, by the id the state records (names need not be unique).
  const { serverInState, serverIds } = preview;
  if (preview.changes.length > 0) {
    deps.reporter.info(
      ["The teardown deletes these resources:", ...describeChanges(preview.changes)].join("\n"),
    );
  } else {
    deps.reporter.info("The infrastructure is already deleted; OpsCrew finishes the cleanup.");
  }
  const warning = dataWarning(plan, serverInState);
  if (warning) deps.reporter.warn(warning);
  const data = { postgres: plan.services.postgres, backups: plan.target.backups };
  const snapshotFirst = serverInState && snapshotWanted(options.snapshot, data);
  if (snapshotFirst) {
    deps.reporter.info(
      `A snapshot of the ${texts.noun} is taken first, so its data can be restored later (${texts.snapshotBilling}; \`--no-snapshot\` skips it).`,
    );
  }
  if (serverInState && !profile.deleteProtection) {
    // Said before the prompt: nothing else stands between the typed name and the deletion.
    deps.reporter.warn(
      `${profile.displayName} has no delete protection for ${texts.noun}s, so the only safeguard is OpsCrew's own confirmation: once you confirm with the name ${name}, the ${texts.noun} is deleted as soon as the destroy plan is applied.`,
    );
  }
  await confirmDeletion(
    session,
    {
      name,
      provider,
      deleteProtection: profile.deleteProtection,
      resources: preview.changes,
      snapshot: snapshotFirst,
      ...(warning ? { dataWarning: warning } : {}),
    },
    options.confirm,
  );

  // 5. Snapshot (inside the confirmed flow: after the typed name, before anything is deleted)
  const snapshotId = await takeSnapshotBeforeDelete(session, {
    server: { inState: serverInState, ids: serverIds },
    choice: options.snapshot ?? "auto",
    data,
    purpose: "destroy",
    ...(services.servers ? { servers: services.servers } : {}),
    ...(services.sleep ? { sleep: services.sleep } : {}),
    ...(services.now ? { now: services.now } : {}),
  });

  // 6. Lift delete protection (only where the provider has it)
  const protection = await liftProtection(session, {
    variable: PROTECTION_VARIABLE,
    serverInState,
    ...(snapshotId !== undefined ? { snapshotId } : {}),
    mismatchHint:
      "The infrastructure was probably changed outside OpsCrew, or its files no longer match what was applied. Run `opscrew drift` to see the differences and `opscrew provision` to bring everything back in line, then run `opscrew destroy` again.",
  });

  // 7. Destroy
  const { destroyed, approval: destroyApproval } = await destroyInfrastructure(
    ctx,
    snapshotId,
    protection.off,
    { addresses: preview.addresses, serverIds },
  );

  // 8. Cleanup: deploy secrets, pinned host key, plan, stored-secrets record, phase state
  const secretsRemoved = await removeDeploySecrets(deps, github);
  const hosts = [plan.deployment.serverIpv4, plan.deployment.serverIpv6];
  if ((await forgetHostKeys(deps, hosts)) > 0) {
    deps.reporter.info(`Removed the ${texts.noun}'s SSH host key from OpsCrew's known_hosts.`);
  }
  const at = deps.clock.now().toISOString();
  await writeArtifact(
    "plan",
    deps.paths.files.plan,
    destroyedPlan(plan, at, [protection.approval, destroyApproval]),
  );
  await rm(join(deps.paths.projectHomeDir, "deploy_secrets.json"), { force: true });
  await removeSnapshotRecord(deps, "destroy");
  await deps.state.markPhase("provision", "skipped", "infrastructure destroyed");
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: name,
    detail: `infrastructure destroyed: ${destroyed.length} resources deleted, ${secretsRemoved.length} deploy secrets removed${snapshotId !== undefined ? `, ${texts.snapshotRef(snapshotId)} kept` : ""}`,
  });
  deps.reporter.success(`${name} is torn down. opscrew/plan.yaml records when.`);

  // 9. What remains
  const remaining = remainingAfterDestroy({ plan, texts, snapshotId, github, secretsRemoved });
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return {
    ...(snapshotId !== undefined ? { snapshotId } : {}),
    destroyed,
    secretsRemoved,
    remaining,
  };
}
