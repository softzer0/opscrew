/**
 * `opscrew provision` for Cloudflare's hosting (`target.provider: cloudflare-workers`, feature 016,
 * plan.md "9."): the Worker's shell and custom domains through the IaC plan, the zone's shared
 * rules, the deploy secrets and the deploy-setup pull request. No Dockerfile, image or server.
 */
import { join } from "node:path";
import type { ProjectPaths } from "@opscrew/core";
import { CLOUDFLARE_DEPLOY_SECRETS, type RenderContext } from "@opscrew/iac-templates";
import type { CloudflareWorkersDeployTarget, DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../../context";
import { builderCicd } from "../../environments/branches";
import { setupCloudflare, setupGitHub } from "../../provision/credentials";
import { deploySetupDependabot } from "../../provision/dependabot";
import { planAndApply } from "../../provision/plan-apply";
import { deploymentFiles, deploymentRenderContext } from "../../provision/render";
import {
  applySharedCloudflare,
  cloudflarePlanHashes,
  type PlannedCloudflare,
  planSharedCloudflare,
  sharedCloudflareClient,
} from "../../provision/shared-cloudflare";
import {
  deployBranchFor,
  deploymentRecord,
  mergeDeploysNote,
  provisionEngine,
  publicOutputs,
  publishDeployment,
  withLearnedZone,
} from "../../provision/steps";
import type { ProvisionOptions, ProvisionResult } from "../../provision/types";
import { planWhere } from "../../runners/words";
import {
  approvalEntry,
  approveAndWriteRenderedFiles,
  type PlanApproval,
  writePlanIfChanged,
} from "../../shared";
import type { ServerlessProvisionInput } from "../index";
import { storeSiteSecrets } from "../shared";
import { requireFreeHostnames, requireOwnWorker, requireWorkersTokens } from "./checks";

/** What is set up at Cloudflare once the infrastructure plan is applied. */
const SET_UP = "The app's Worker and its custom domains are set up at Cloudflare.";

/**
 * What the workflow of the promoted environment `plan` checks the build's run against: the branch
 * and the workflow of the environment that builds the sites it is promoted with
 * ({@link builderCicd}). Nothing for an environment that follows a branch.
 */
async function builder(
  paths: ProjectPaths,
  plan: DeployPlan,
): Promise<Pick<RenderContext, "builderBranch" | "builderWorkflowPath">> {
  const cicd = await builderCicd(paths, plan);
  return cicd === undefined
    ? {}
    : { builderBranch: cicd.branch, builderWorkflowPath: cicd.workflowPath };
}

/**
 * Provisions an app on Cloudflare's hosting (FR-1603–FR-1607), each change after its approval:
 * 1. the checks, before anything changes: Cloudflare's token and the zone (the DNS records at the
 *    app's hostnames are collected), GitHub, both tokens' Workers permission
 *    ({@link requireWorkersTokens}; the deploy token from `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN`), the
 *    Worker's name ({@link requireOwnWorker}), the DNS records ({@link requireFreeHostnames}), the
 *    Cloudflare plan read-only ({@link planSharedCloudflare}, as for servers: the zone's shared
 *    rules, the zone's minimum TLS where every proxied hostname there is OpsCrew's, and the
 *    removal of this app's hostnames from a zone its record names and it no longer uses) and the
 *    deploy branch;
 * 2. the generated files (`repo-write`): the root and its module, the Wrangler config (and for
 *    `render: ssr` the headers wrapper) and the workflow, whose promoted form gets the builder's
 *    branch and workflow;
 * 3. the IaC plan of the Worker's shell and custom domains (`iac-apply`), then the plan recorded;
 * 4. the Cloudflare plans (`cloudflare-apply`, {@link applySharedCloudflare}): the removal from
 *    the zone the app leaves first, then the `www` redirect, the probe block and the minimum TLS;
 * 5. the deploy secrets (`github-secrets`, {@link storeSiteSecrets}): the deploy token, the account
 *    id and the app's values, all repository secrets;
 * 6. the deploy-setup pull request (`git-push`, `pull-request`) with the plan's record.
 *
 * Origin TLS, Authenticated Origin Pulls, a host plan and the edge do not apply: there is no
 * origin. `--plan-only` writes the files, shows the IaC plan and the Cloudflare plan with their
 * hashes and changes nothing at Cloudflare or GitHub; `--approve` names them (the approval handler
 * grants the Cloudflare plan's).
 */
export async function provisionCloudflareWorkers(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: ServerlessProvisionInput,
): Promise<ProvisionResult> {
  const services = options.services ?? {};
  const { git } = input;
  const target = input.plan.target as CloudflareWorkersDeployTarget;
  const command = `opscrew provision${(await planWhere(deps.paths.root, input.plan)).flag}`;
  const storesSecrets = options.secrets !== false;

  // 1. The checks.
  deps.reporter.step("Checking your Cloudflare and GitHub access");
  const cloudflare = await setupCloudflare(deps, input.plan, services, {
    foreignRecords: "report",
  });
  // The schema gives every plan on Cloudflare's hosting a domain on Cloudflare.
  if (cloudflare === undefined) throw new Error("A Cloudflare hosting plan without a domain.");
  const github = await setupGitHub(deps, git, services);
  const client = sharedCloudflareClient(deps, services);
  const deployToken = await requireWorkersTokens(deps, {
    client,
    cloudflare,
    deployToken: storesSecrets,
    command,
  });
  let plan = withLearnedZone(deps, input.plan, cloudflare, command).plan;
  const { engine, env } = await provisionEngine(deps, plan, options);
  const { accountId } = cloudflare;
  await requireOwnWorker(deps, { client, accountId, plan, target, engine, env, command });
  await requireFreeHostnames(deps, {
    client,
    accountId,
    plan,
    worker: target.worker,
    foreign: cloudflare.foreignRecords,
    command,
  });
  // With the plan's zone there is always a Cloudflare plan.
  const shared = (await planSharedCloudflare(deps, {
    services: { sharedCloudflare: client },
    plan,
    cloudflare,
    command,
    tls: { minTls: true },
  })) as PlannedCloudflare;
  // A hash given with `--approve` that names a Cloudflare plan is never the IaC plan's.
  const approvePlanHash = cloudflarePlanHashes(shared).includes(
    input.saved.apply?.toLowerCase() ?? "",
  )
    ? undefined
    : input.saved.apply;
  const commits = !(options.planOnly && approvePlanHash === undefined);
  const push = options.push !== false;
  const branch = await deployBranchFor(deps, {
    git,
    github,
    plan,
    phase: "provision",
    commits,
    push,
  });

  // 2. The generated files. Applying a saved plan keeps the infrastructure code the --plan-only
  // run wrote, which that plan was made from.
  const ctx = {
    ...(await deploymentRenderContext(deps, {
      plan,
      requirements: input.requirements,
      github,
      // A Worker has no SSH deploy: its files never use the deploy key.
      deployPublicKey: "",
      cloudflare,
    })),
    ...(await builder(deps.paths, plan)),
  };
  const writes = approvePlanHash === undefined;
  const dependabot = await deploySetupDependabot(deps, plan, { writes });
  const files = [
    ...deploymentFiles(plan, ctx),
    ...(dependabot?.action === "write" ? [dependabot.file] : []),
  ];
  await approveAndWriteRenderedFiles(
    deps,
    deps.paths.root,
    writes ? files : files.filter((file) => file.kind !== "infra"),
  );

  // 3. The Worker's shell and custom domains: plan → policies → iac-apply approval → apply.
  const iac = await planAndApply(deps, {
    engine,
    dir: join(deps.paths.root, plan.infra.dir),
    env,
    deployPlan: plan,
    files,
    command,
    phase: "provision",
    ...(approvePlanHash !== undefined ? { approvePlanHash } : {}),
    ...(options.planOnly ? { planOnly: true } : {}),
  });
  const sharedInput = { app: plan.app.name, command, phase: "provision" as const };
  if (!commits) {
    // The Cloudflare plan is shown with its hash too; it is approved next to the IaC plan's.
    const shown = await applySharedCloudflare(deps, shared, { ...sharedInput, planOnly: true });
    await writePlanIfChanged(deps, plan);
    return {
      ...(iac.planHash ? { planHash: iac.planHash } : {}),
      ...shown.fields,
      applied: false,
      outputs: {},
    };
  }
  const approvals: PlanApproval[] = iac.approval ? [approvalEntry(iac.approval)] : [];
  const record = deploymentRecord(deps, {
    plan,
    url: `https://${plan.dns.domain}`,
    iac,
    approvals,
  });
  plan = record(false);
  await writePlanIfChanged(deps, plan);

  // 4. The Cloudflare plans: the zone the app leaves, then the shared rules and the minimum TLS.
  const applied = await applySharedCloudflare(deps, shared, { ...sharedInput, planOnly: false });
  if (applied.approvals.length > 0) {
    approvals.push(...applied.approvals.map(approvalEntry));
    plan = record(applied.applied);
    await writePlanIfChanged(deps, plan);
  }

  // 5. The deploy secrets: the deploy token, the account id and the app's values.
  const secretsStored = await storeSiteSecrets(deps, {
    github,
    plan,
    services,
    store: storesSecrets,
    // The deploy token is read (and checked) only when this run stores the secrets.
    deploy:
      deployToken === undefined
        ? {}
        : {
            [CLOUDFLARE_DEPLOY_SECRETS.apiToken]: deployToken,
            [CLOUDFLARE_DEPLOY_SECRETS.accountId]: accountId,
          },
    done: SET_UP,
  });

  // 6. Commit, push and open the deploy-setup pull request.
  const published = await publishDeployment(deps, {
    git,
    github,
    plan,
    files: files.map((file) => file.path),
    push,
    secretsStored,
    phase: "provision",
    branch,
    dependabot,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  });
  const merge = mergeDeploysNote(plan, published.published, storesSecrets);
  if (secretsStored && merge !== undefined) deps.reporter.info(merge);
  return {
    ...(iac.planHash ? { planHash: iac.planHash } : {}),
    ...applied.fields,
    applied: iac.applied,
    outputs: publicOutputs(iac.outputs),
    branch: published.published.branch,
    base: published.published.base,
    ...(published.published.prUrl ? { prUrl: published.published.prUrl } : {}),
    published: published.published.published,
    pushed: published.published.pushed,
  };
}
