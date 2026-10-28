/**
 * `opscrew destroy` for the server-less targets (feature 016, FR-1608, SC-1605): Cloudflare's
 * hosting and GitHub Pages. Each change goes through its own plan, approved by its hash with
 * `allowDestroy` and the typed app name, as on servers.
 */
import { join } from "node:path";
import { CLOUDFLARE_TOKEN_PAGE } from "@opscrew/connector-cloudflare";
import { type GitHubClient, githubConnector } from "@opscrew/connector-github";
import type { ApprovalRecord, PlanSummary, ResourceChange } from "@opscrew/contracts";
import { exists, OpsCrewError, plural, tfstateFile } from "@opscrew/core";
import { pagesVerificationRootDir } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { providerProfile } from "../providers";
import { missing } from "../provision/credentials";
import { deploySecretNames } from "../provision/secrets";
import { planFile } from "../runners/words";
import {
  PAGES_ENVIRONMENT,
  type PagesPlan,
  pagesTeardownSteps,
  planPagesTeardown,
} from "../serverless/pages/plan";
import { pagesPlanStep } from "../serverless/pages/step";
import { verificationRecordName } from "../serverless/pages/verification";
import {
  describeChanges,
  existingStateEngine,
  gitClient,
  githubClientFromToken,
  githubCoordinates,
  hasDeployment,
  PlanRefusedError,
  type ProjectEngine,
  pagesVerificationStateFile,
  refusalReason,
  stateContents,
} from "../shared";
import { planHeading } from "./checks";
import {
  COMMAND,
  CONTINUES_WITH_LEFT,
  checkCloudflare,
  checkPauseNote,
  DRIFT_THEN_DESTROY,
  deploymentFiles,
  deploySecretsLeft,
  type GitHubTarget,
  nothingDeployed,
  pauseCheckForTeardown,
  recordTeardown,
  removeDeploySecrets,
  requireInfraCode,
  resolveGitHub,
  setupEngine,
  teardownScope,
  teardownStateNotHere,
  typeNameHint,
} from "./common";
import {
  applyApprovedPlan,
  assertDeletionPlan,
  confirmDeletion,
  type DeletionPreview,
  type DeletionScope,
  type DeletionSession,
  deletionSession,
  discardPlan,
  previewDeletion,
  savePlan,
} from "./deletion";
import { applySharedRemoval, planSharedRemoval, removalDetails } from "./shared-rules";
import { destroyConfirmPrompt } from "./texts";
import type { DestroyOptions, DestroyResult } from "./types";

/** A root's destroy plan, approved by its hash but not applied yet. */
interface ApprovedDeletion {
  summary: PlanSummary;
  approval: ApprovalRecord;
}

/**
 * The destroy plan of the root `session` holds (`<stamp>-<suffix>.tfplan`), checked to delete only
 * the `confirmed` resources, shown and approved (`iac-apply`, `allowDestroy`, the typed app name),
 * not applied yet: `undefined` when nothing is left to delete. Its file is deleted on any stop;
 * `unchanged` says what still stands then.
 */
async function approveRootDeletion(
  session: DeletionSession,
  input: {
    suffix: string;
    confirmed: ReadonlySet<string>;
    title: (count: number) => string;
    notes: readonly string[];
    unchanged: string;
  },
): Promise<ApprovedDeletion | undefined> {
  const { deps, app: name } = session;
  const summary = await savePlan(session, input.suffix, { destroy: true });
  try {
    if (summary.changes.length === 0) {
      await discardPlan(summary);
      return undefined;
    }
    assertDeletionPlan(session, summary, { confirmed: input.confirmed }, (problem) => ({
      note: input.unchanged,
      hint:
        problem === "unconfirmed"
          ? `Run \`${COMMAND}\` again to see the current list and confirm it.`
          : DRIFT_THEN_DESTROY,
    }));
    const approval = await deps.approvals.request({
      kind: "iac-apply",
      title: input.title(summary.changes.length),
      details: [
        planHeading(summary, "destroy plan"),
        ...describeChanges(summary.changes),
        ...input.notes,
        `Plan hash: ${summary.planHash}`,
      ].join("\n"),
      planHash: summary.planHash,
      allowDestroy: true,
      confirmPhrase: name,
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The teardown was not approved${refusalReason(approval)}. ${input.unchanged}`,
        { hint: typeNameHint(name) },
      );
    }
    await deps.approvals.assertApprovedPlan(summary.planHash, { allowDestroy: true });
    return { summary, approval };
  } catch (error) {
    await discardPlan(summary);
    throw error;
  }
}

/** Applies an approved destroy plan (`what` names what it deletes) and deletes its file. */
async function applyRootDeletion(
  session: DeletionSession,
  approved: ApprovedDeletion,
  what: string,
): Promise<ResourceChange[]> {
  const { summary } = approved;
  try {
    session.deps.reporter.step(`Deleting ${what}`);
    await applyApprovedPlan(session, summary, {
      allowDestroy: true,
      what: `deleting ${what}`,
      hint: CONTINUES_WITH_LEFT,
    });
    session.deps.reporter.success(`Deleted ${plural(summary.changes.length, "resource")}.`);
    return summary.changes;
  } finally {
    await discardPlan(summary);
  }
}

/** The preview of a root's teardown, in the words of the summary before the typed name. */
function changeLines(lead: string, changes: readonly ResourceChange[]): string[] {
  return changes.length === 0 ? [] : [lead, ...describeChanges(changes)];
}

/** "What remains": the generated files, which build and deploy again once provisioned. */
async function filesLeft(deps: PhaseDeps, plan: DeployPlan, setUp: string): Promise<string> {
  const files = await deploymentFiles(deps, plan);
  return `The deployment files in the repository (${files.folder}/ and ${plan.cicd.workflowPath}). Pushes still run the workflow, but its deploy fails until \`${files.provision}\` ${setUp} again from these files.`;
}

/**
 * `opscrew destroy` on Cloudflare's hosting (FR-1608), each change only after the one before it
 * succeeded: the state of the Worker's root and its code → Cloudflare's token (GitHub's optional,
 * for the deploy secrets) → a preview of the Worker's destroy plan and this app's hostnames in
 * OpsCrew's shared rules (`inspectShared` reads the `www` redirect's phase when the record has
 * it), confirmed once with the typed app name → the Worker's destroy plan approved (`iac-apply`)
 * → the `www` redirect and the probe block leave the zone's shared rules first (`cloudflare-apply`)
 * → the Worker's custom domains and the Worker go (its secrets with it) → the deploy secrets in
 * GitHub (`github-secrets`) and OpsCrew's record. Running it again continues with what is left.
 */
export async function destroyCloudflareWorkers(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
): Promise<DestroyResult> {
  const services = options.services ?? {};
  const name = plan.app.name;
  const scope = teardownScope(deps, plan, "cloudflare-workers");

  // 1. Preconditions
  if (!(await exists(tfstateFile(deps.paths)))) {
    if (!hasDeployment(plan)) throw nothingDeployed(plan);
    throw await teardownStateNotHere(deps.paths.root, plan);
  }
  await requireInfraCode(deps, plan, "the teardown");

  // 2. Credentials
  deps.reporter.step("Checking your Cloudflare and GitHub access");
  await checkCloudflare(deps, plan, services);
  const github = await resolveGitHub(deps, services);

  // 3. Engine, then 4. what the teardown deletes, confirmed once
  const setup = await setupEngine(deps, plan, options);
  const session = deletionSession(scope, { ...setup, dir: join(deps.paths.root, plan.infra.dir) });
  deps.reporter.step("Planning the teardown to see what it deletes");
  const preview = await previewDeletion(session, { suffix: "destroy-preview", destroy: true });
  const shared = await planSharedRemoval(deps, plan, services);
  const rules = removalDetails(shared);
  if (preview.changes.length === 0 && rules === undefined && !hasDeployment(plan)) {
    throw nothingDeployed(plan);
  }
  deps.reporter.info(
    preview.changes.length > 0
      ? [
          "The teardown deletes these resources (the Worker's secrets go with it):",
          ...describeChanges(preview.changes),
        ].join("\n")
      : "The Worker and its custom domains are already deleted; OpsCrew finishes the cleanup.",
  );
  if (rules !== undefined) deps.reporter.info(rules);
  await confirmDeletion(
    scope,
    {
      name,
      confirmPrompt: destroyConfirmPrompt(name, "cloudflare-workers"),
      provider: "cloudflare-workers",
      deleteProtection: false,
      resources: preview.changes,
      snapshot: false,
      ...(rules !== undefined ? { cloudflarePlan: rules } : {}),
    },
    options.confirm,
  );

  // 5. The Worker's destroy plan is approved before anything changes.
  const worker = await approveRootDeletion(session, {
    suffix: "destroy",
    confirmed: preview.addresses,
    title: (count) =>
      `Delete the Worker of ${name} and its custom domains on Cloudflare (${plural(count, "resource")} to delete)`,
    notes: [
      "The Worker's secrets go with it. OpsCrew applies this plan once this app's hostnames have left its shared Cloudflare rules (the next approval).",
      ...checkPauseNote(plan),
    ],
    unchanged: "Nothing was deleted.",
  });

  // 6. The www redirect and the probe block leave the zone's shared rules first, then 7. the
  // Worker's custom domains and the Worker.
  let sharedApproval: ApprovalRecord | undefined;
  try {
    sharedApproval = await applySharedRemoval(deps, plan, shared);
  } catch (error) {
    if (worker !== undefined) await discardPlan(worker.summary);
    throw error;
  }
  const destroyed =
    worker === undefined
      ? []
      : await applyRootDeletion(session, worker, "the Worker and its custom domains");

  // 8. The deploy secrets, and OpsCrew's record of the deployment
  await pauseCheckForTeardown(deps, github, plan, worker?.approval);
  const secretsRemoved = await removeDeploySecrets(deps, github, {
    plan,
    done: "The Worker and its custom domains are deleted.",
    reach: "Cloudflare",
  });
  await recordTeardown(deps, plan, [worker?.approval, sharedApproval], {
    summary: "site removed from Cloudflare",
    forgetAddress: false,
  });
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: name,
    detail: `site removed from Cloudflare: ${plural(destroyed.length, "resource")} deleted, ${plural(secretsRemoved.length, "deploy secret")} removed`,
  });
  deps.reporter.success(`${name} is removed from Cloudflare. ${planFile(plan)} records when.`);

  // 9. What remains
  const tokenVar = providerProfile("cloudflare-workers").deployTokenVar;
  const remaining = [
    ...deploySecretsLeft(github, { plan, removed: secretsRemoved }),
    await filesLeft(deps, plan, "creates the Worker"),
    `The deploy token you created for the workflow (${tokenVar}): OpsCrew never deletes tokens. Delete it at ${CLOUDFLARE_TOKEN_PAGE} if no other app uses it.`,
  ];
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return { destroyed, secretsRemoved, remaining };
}

/** The repository on GitHub and a client with the user's token: GitHub Pages is turned off there. */
async function pagesAccess(
  deps: PhaseDeps,
): Promise<{ owner: string; repo: string; pages: GitHubClient }> {
  let coordinates: { owner: string; repo: string };
  try {
    coordinates = await githubCoordinates(gitClient(deps));
  } catch (error) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "This repository has no GitHub remote named origin, so OpsCrew cannot tell whose GitHub Pages site to turn off. Nothing was changed.",
      {
        hint: `Run \`${COMMAND}\` in the repository's checkout, with origin pointing at GitHub.`,
        cause: error,
      },
    );
  }
  const pages = await githubClientFromToken(deps);
  if (pages === undefined) {
    throw missing("GitHub", githubConnector({ token: undefined, fetch: deps.fetch }).credentials);
  }
  return { ...coordinates, pages };
}

/**
 * With `--delete-verification`: the session and preview of the deletion of GitHub's verification
 * record, from its own root and its state, {@link pagesVerificationStateFile}.
 */
async function verificationDeletion(
  scope: DeletionScope,
  plan: DeployPlan,
  setup: ProjectEngine,
): Promise<{ session: DeletionSession; preview: DeletionPreview }> {
  const { deps } = scope;
  const state = pagesVerificationStateFile(deps.paths);
  const dir = pagesVerificationRootDir(plan);
  await requireInfraCode(
    deps,
    { ...plan, infra: { ...plan.infra, dir } },
    "the deletion of GitHub's verification record",
  );
  const session = deletionSession(scope, { ...setup, dir: join(deps.paths.root, dir) });
  await setup.engine.init(session.dir, { env: setup.env, backendConfig: { path: state } });
  const preview = await previewDeletion(session, {
    suffix: "destroy-verification-preview",
    destroy: true,
  });
  return { session, preview };
}

/**
 * The Pages plan of the teardown, approved by its hash (`pages-apply`, `allowDestroy`, the typed
 * app name) and applied ({@link pagesPlanStep}); a refusal says what stands.
 */
async function removeSite(
  deps: PhaseDeps,
  input: { api: GitHubClient; plan: PagesPlan; name: string; domain: string; after: boolean },
): Promise<ApprovalRecord | undefined> {
  try {
    const step = await pagesPlanStep(deps, {
      api: input.api,
      plan: input.plan,
      planOnly: false,
      command: COMMAND,
      app: input.name,
    });
    return step.approval;
  } catch (error) {
    if (!(error instanceof PlanRefusedError)) throw error;
    throw new PlanRefusedError(
      {
        ...error.refusal,
        unchanged: input.after
          ? `The DNS records of ${input.domain} are deleted; the GitHub Pages site still claims ${input.domain}, so no other site can take it over.`
          : "Nothing was changed.",
        hint: typeNameHint(input.name),
      },
      error,
    );
  }
}

/**
 * `opscrew destroy` on GitHub Pages (FR-1608, SC-1605), in the takeover-safe order, each change
 * only after the one before it succeeded: the state of the site's DNS records (when it was
 * deployed) → Cloudflare's and GitHub's tokens → a preview of the records' destroy plan, of the
 * Pages plan that removes the site (`planPagesTeardown`) and, with `deleteVerification`, of the
 * verification record's destroy plan, confirmed once with the typed app name → the DNS records
 * (`iac-apply`), while the site still claims the domain → the Pages plan (`pages-apply`): the
 * custom domain, then the site, then its `github-pages` environment → GitHub's verification record
 * (`iac-apply`, only with `deleteVerification`: its state then holds nothing, so `app remove` can
 * go ahead) → the app's values for its build (`github-secrets`) and OpsCrew's record. No DNS record
 * ever points at GitHub while no site claims the domain. Running it again continues.
 */
export async function destroyGithubPages(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
): Promise<DestroyResult> {
  const services = options.services ?? {};
  const name = plan.app.name;
  // The schema gives every plan on GitHub Pages a domain on Cloudflare.
  const domain = plan.dns.domain as string;
  const scope = teardownScope(deps, plan, "github-pages");

  // 1. Preconditions: the state of the site's DNS records once it was deployed, and their code.
  const stateHere = await exists(tfstateFile(deps.paths));
  if (!stateHere && hasDeployment(plan)) throw await teardownStateNotHere(deps.paths.root, plan);
  if (stateHere) await requireInfraCode(deps, plan, "the teardown");

  // 2. Credentials: Cloudflare for the records; GitHub for the site and the app's values.
  deps.reporter.step("Checking your Cloudflare and GitHub access");
  await checkCloudflare(deps, plan, services);
  const { owner, repo, pages } = await pagesAccess(deps);
  const github: GitHubTarget = { owner, repo, api: services.github ?? pages };

  // 3. Engine, then 4. what the teardown changes, in its order, confirmed once
  const setup = stateHere
    ? await setupEngine(deps, plan, options)
    : await existingStateEngine(deps, plan, {
        ...(options.engine !== undefined ? { engine: options.engine } : {}),
        ...(options.services !== undefined ? { services: options.services } : {}),
        command: COMMAND,
      });
  deps.reporter.step("Planning the teardown to see what it deletes");
  const dns = stateHere
    ? deletionSession(scope, { ...setup, dir: join(deps.paths.root, plan.infra.dir) })
    : undefined;
  const records =
    dns === undefined
      ? undefined
      : await previewDeletion(dns, { suffix: "destroy-preview", destroy: true });
  const site = await pages.getPages(owner, repo);
  const environment = (await pages.getEnvironment(owner, repo, PAGES_ENVIRONMENT)) !== undefined;
  const teardown = planPagesTeardown({ owner, repo, site, environment });
  // GitHub's verification record, kept unless asked for: its state may still hold it.
  const held =
    (await stateContents(
      deps,
      pagesVerificationStateFile(deps.paths),
      async () => setup.engine,
    )) !== "nothing";
  const deleteVerification = options.deleteVerification === true;
  const verification =
    deleteVerification && held ? await verificationDeletion(scope, plan, setup) : undefined;
  const recordChanges = records?.changes ?? [];
  const verificationChanges = verification?.preview.changes ?? [];
  if (
    recordChanges.length === 0 &&
    teardown.steps.length === 0 &&
    verificationChanges.length === 0 &&
    !hasDeployment(plan)
  ) {
    throw nothingDeployed(plan);
  }
  const record = verificationRecordName(owner, domain);
  const steps = pagesTeardownSteps(teardown);
  const kept = `GitHub's domain verification record ${record} stays, so ${domain} stays verified for your GitHub account; \`${COMMAND} --delete-verification\` deletes it.`;
  // Only GitHub's verification record is left of a site an earlier run removed.
  const verificationOnly =
    plan.deployment.destroyedAt !== undefined &&
    recordChanges.length === 0 &&
    teardown.steps.length === 0;
  const lead = (first: boolean, what: string) => `${first ? "The teardown" : "Then it"} ${what}:`;
  deps.reporter.info(
    [
      ...changeLines(
        lead(
          true,
          `deletes the site's DNS records first, while the GitHub Pages site still claims ${domain}`,
        ),
        recordChanges,
      ),
      ...(steps.length === 0
        ? []
        : [
            lead(recordChanges.length === 0, `changes the GitHub Pages site of ${owner}/${repo}`),
            ...steps.map((title) => `  - ${title}`),
          ]),
      ...changeLines(
        lead(
          recordChanges.length === 0 && steps.length === 0,
          "deletes GitHub's domain verification record",
        ),
        verificationChanges,
      ),
      ...(recordChanges.length === 0 && steps.length === 0 && verificationChanges.length === 0
        ? ["The site and its DNS records are already removed; OpsCrew finishes the cleanup."]
        : []),
      ...(held && !deleteVerification ? [kept] : []),
    ].join("\n"),
  );
  await confirmDeletion(
    scope,
    {
      name,
      confirmPrompt: destroyConfirmPrompt(name, "github-pages"),
      provider: "github-pages",
      deleteProtection: false,
      resources: [...recordChanges, ...verificationChanges],
      snapshot: false,
      pagesChanges: steps,
    },
    options.confirm,
  );

  // 5. The DNS records, while the site still claims the domain.
  const approvals: (ApprovalRecord | undefined)[] = [];
  const destroyed: ResourceChange[] = [];
  // The typed confirmation the check's pause goes under (it says so).
  let recordsApproval: ApprovalRecord | undefined;
  if (dns !== undefined && records !== undefined) {
    const approved = await approveRootDeletion(dns, {
      suffix: "destroy",
      confirmed: records.addresses,
      title: (count) =>
        `Delete the DNS records of ${domain} on Cloudflare (${plural(count, "resource")} to delete)`,
      notes: [
        `They go first, while the GitHub Pages site still claims ${domain}: no record ever points at GitHub with no site claiming the domain. The Pages plan that removes the site follows (its own approval).`,
        ...checkPauseNote(plan),
      ],
      unchanged: "Nothing was deleted.",
    });
    if (approved !== undefined) {
      destroyed.push(...(await applyRootDeletion(dns, approved, `the DNS records of ${domain}`)));
      approvals.push(approved.approval);
      recordsApproval = approved.approval;
    }
  }

  // 6. The site: its custom domain, then the site, then its github-pages environment.
  if (teardown.steps.length > 0) {
    approvals.push(
      await removeSite(deps, {
        api: pages,
        plan: teardown,
        name,
        domain,
        after: destroyed.length > 0,
      }),
    );
  } else {
    deps.reporter.info(`GitHub Pages is already off for ${owner}/${repo}.`);
  }

  // 7. GitHub's verification record, only when asked for.
  if (verification !== undefined) {
    const before = destroyed.length > 0 || teardown.steps.length > 0;
    const approved = await approveRootDeletion(verification.session, {
      suffix: "destroy-verification",
      confirmed: verification.preview.addresses,
      title: (count) =>
        `Delete GitHub's domain verification record for ${domain} on Cloudflare (${plural(count, "resource")} to delete)`,
      notes: [
        `Without it, ${domain} is no longer verified for your GitHub account, so another account's GitHub Pages site could claim it while DNS records point it at GitHub.`,
      ],
      unchanged: before
        ? "The rest of the teardown is done; GitHub's verification record stays."
        : "Nothing was deleted.",
    });
    if (approved !== undefined) {
      destroyed.push(
        ...(await applyRootDeletion(
          verification.session,
          approved,
          "GitHub's domain verification record",
        )),
      );
      approvals.push(approved.approval);
    }
  }

  // 8. The app's values for its build, and OpsCrew's record of the deployment (an earlier run
  // wrote it when only the verification record was left).
  if (!verificationOnly) await pauseCheckForTeardown(deps, github, plan, recordsApproval);
  const secretsRemoved =
    verificationOnly || deploySecretNames(plan).length === 0
      ? []
      : await removeDeploySecrets(deps, github, {
          plan,
          done: "The GitHub Pages site and its DNS records are removed.",
          reach: "the app's values",
        });
  if (!verificationOnly) {
    await recordTeardown(deps, plan, approvals, {
      summary: "site removed from GitHub Pages",
      forgetAddress: false,
    });
  }
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: name,
    detail: verificationOnly
      ? `GitHub's verification record for ${domain} deleted`
      : `site removed from GitHub Pages: ${plural(destroyed.length, "DNS record")} deleted, ${plural(teardown.steps.length, "change")} to the site, ${plural(secretsRemoved.length, "deploy secret")} removed${held && !deleteVerification ? ", verification record kept" : ""}`,
  });
  deps.reporter.success(
    verificationOnly
      ? `GitHub's domain verification record for ${domain} is deleted.`
      : `${name} is removed from GitHub Pages. ${planFile(plan)} records when.`,
  );

  // 9. What remains
  const remaining = [
    ...(held && !deleteVerification ? [kept] : []),
    ...deploySecretsLeft(github, { plan, removed: secretsRemoved }),
    await filesLeft(deps, plan, "turns GitHub Pages on"),
  ];
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return { destroyed, secretsRemoved, remaining };
}
