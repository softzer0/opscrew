/**
 * `opscrew destroy --env <preview>` for previews on another environment's server (FR-2230, spec.md
 * US9 #4): the previews with their data, the recipe, the preview key and the cleanup go from that
 * server through its environment's login, then the wildcard record and the previews' Cloudflare
 * pieces, then the GitHub secrets. The server and everything of its environment stay.
 */
import { join } from "node:path";
import { planAddon } from "@opscrew/connector-ssh-host";
import type { ApprovalRecord, ResourceChange } from "@opscrew/contracts";
import { OpsCrewError, plural } from "@opscrew/core";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { previewServer, previewServerAddress } from "../previews/host";
import { ownEngineEnv, ownTarget } from "../provision/own";
import { serverForNetwork } from "../provision/servers";
import { approveAndApplyHostPlan, hasDeployment, hasState } from "../shared";
import {
  applyCloudflareRemoval,
  approveCloudflareRemoval,
  type CloudflareRemoval,
  type CloudflareRemovalWords,
  COMMAND,
  checkCloudflare,
  containerImagesLeft,
  deploySecretsLeft,
  nothingDeployed,
  previewCloudflareRemoval,
  recordTeardown,
  removeDeploySecrets,
  requireInfraCode,
  resolveGitHub,
  SHOWS_PLAN_AGAIN,
  setupEngine,
  teardownScope,
  teardownStateNotHere,
  teardownSummary,
} from "./common";
import { confirmDeletion, deletionSession, discardPlan } from "./deletion";
import {
  applySharedRemoval,
  planSharedRemoval,
  removalDetails,
  removeSharedOnly,
} from "./shared-rules";
import { destroyConfirmPrompt } from "./texts";
import type { DestroyOptions, DestroyResult } from "./types";

/**
 * Removes the previews that run on another environment's server (see the module's comment). Each
 * step only after the one before succeeded: preconditions (the state and the infrastructure code
 * here) → Cloudflare and GitHub → that server, reached and inspected through its environment's
 * login (`previewServer`) → the Cloudflare destroy preview and the previews' removal, shown and
 * confirmed once with the typed app name → the removal on the server (`host-apply`, `allowDestroy`
 * and the typed name), then the Cloudflare plan (`iac-apply`) and OpsCrew's shared rules → the
 * deploy secrets and the record of the teardown.
 */
export async function destroySharedPreviews(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
): Promise<DestroyResult> {
  const services = options.services ?? {};
  const name = plan.app.name;
  const host = plan.environment?.previews?.server?.environment as string;
  const stateHere = await hasState(deps.paths);
  if (options.undoHost === true) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The previews run on ${host}'s server, which has no setup of the previews' own to undo. Nothing was changed.`,
      { hint: `Run \`${COMMAND}\` without --undo-host to remove the previews.` },
    );
  }
  if (!hasDeployment(plan) && !(stateHere && plan.deployment.destroyedAt === undefined)) {
    // Only what a stopped provision left in OpsCrew's shared Cloudflare rules, when any.
    const removed = await removeSharedOnly(deps, plan, services);
    if (removed !== undefined) return removed;
    throw nothingDeployed(plan);
  }
  // 1. Preconditions: without the state OpsCrew cannot remove the wildcard record.
  if (!stateHere) throw await teardownStateNotHere(deps.paths.root, plan);
  await requireInfraCode(deps, plan, "the removal of the previews' wildcard record");

  // 2. Credentials, and the server previews share, through its environment's login.
  deps.reporter.step(`Checking the login to ${host}'s server, your Cloudflare and GitHub access`);
  await checkCloudflare(deps, plan, services);
  const github = await resolveGitHub(deps, services);
  const server = await previewServer(deps, plan);
  const reached = await serverForNetwork(
    server.deps,
    {
      plan: server.plan,
      services: {
        ...(services.remote !== undefined ? { remote: services.remote } : {}),
        ...(services.serverHost !== undefined ? { serverHost: services.serverHost } : {}),
      },
      phase: "provision",
      ownRun: undefined,
      extraOwn: [],
    },
    APP_SERVER,
  );

  // 3. What goes: the wildcard record (its address only as TF_VAR_*, the host's), and the previews.
  const scope = teardownScope(deps, plan, "own");
  const setup = await setupEngine(deps, plan, options);
  const dir = join(deps.paths.root, plan.infra.dir);
  await ownEngineEnv(
    deps,
    { target: ownTarget(plan), address: await previewServerAddress(server) },
    setup.env,
  );
  const iac = deletionSession(scope, { ...setup, dir });
  const place = `${host}'s server`;
  const stays = `${host}'s server and everything of ${host} on it stay as they are.`;
  const words: CloudflareRemovalWords = {
    what: "wildcard record on Cloudflare",
    place,
    tunnelAfter: "",
    stays,
  };
  const { resources, confirmed } = await previewCloudflareRemoval(iac, words);
  const previews = planAddon("previews", {
    app: name,
    runAs: server.plan.target.provider === "own" ? "root" : "login",
    facts: reached.facts,
    ...(github.owner !== undefined && github.repo !== undefined
      ? { repository: `${github.owner}/${github.repo}` }
      : {}),
    disable: {},
  });
  const removed = previews.steps.filter((step) => step.state === "change").map((s) => s.title);
  const shared = await planSharedRemoval(deps, plan, services);
  const cloudflarePlan = removalDetails(shared);
  deps.reporter.info(teardownSummary({ resources, removed, words }));
  if (cloudflarePlan !== undefined) deps.reporter.info(cloudflarePlan);
  await confirmDeletion(
    scope,
    {
      name,
      confirmPrompt: destroyConfirmPrompt(name, "own"),
      provider: "own",
      deleteProtection: false,
      resources,
      snapshot: false,
      hostSteps: removed,
      ...(cloudflarePlan !== undefined ? { cloudflarePlan } : {}),
    },
    options.confirm,
  );

  // 4. The previews off the server first, so none starts again; then the record and the rules.
  let previewsApproval: ApprovalRecord | undefined;
  let removal: CloudflareRemoval | undefined;
  let destroyed: ResourceChange[] = [];
  try {
    if (removed.length > 0) {
      const outcome = await approveAndApplyHostPlan(deps, {
        plan: previews,
        remote: reached.remote,
        apply: reached.apply,
        verifyLogin: reached.verifyLogin,
        title: `Remove the previews of ${name} from ${place} with their data`,
        server: place,
        planOf: place,
        upToDate: `Nothing of the previews is left on ${place}.`,
        command: COMMAND,
        phase: "provision",
        allowDestroy: true,
        confirmPhrase: name,
        intro: [
          `This removes every preview of ${name} with its data, then the previews' recipe and values, the preview key and the hourly cleanup; the wildcard record follows.`,
          stays,
        ],
        refused: {
          message: `The removal of the previews of ${name} was not approved, so nothing on ${place} was changed.`,
          hint: SHOWS_PLAN_AGAIN,
        },
        auditAs: "host previews removal",
        secrets: async () => ({}),
      });
      previewsApproval = outcome.approval;
      deps.reporter.success(`Removed the previews of ${name} from ${place}.`);
    }
    if (resources.length > 0) {
      removal = await approveCloudflareRemoval(iac, {
        confirmed,
        appChanges: removed.length > 0,
        words,
      });
    }
    if (removal !== undefined) {
      destroyed = await applyCloudflareRemoval(iac, removal, services.sleep);
    }
  } finally {
    if (removal !== undefined) await discardPlan(removal.summary);
  }
  const sharedApproval = await applySharedRemoval(deps, plan, shared);

  // 5. The deploy secrets and OpsCrew's record of the deployment; the server is not this one's.
  const secretsRemoved = await removeDeploySecrets(deps, github, {
    plan,
    done: `The previews are removed from ${place} and Cloudflare.`,
    reach: place,
  });
  await recordTeardown(deps, plan, [previewsApproval, removal?.approval, sharedApproval], {
    summary: `previews removed from ${place}`,
    forgetAddress: false,
  });
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: name,
    detail: `previews removed: ${plural(destroyed.length, "Cloudflare resource")} deleted, ${plural(removed.length, "change")} on ${place}, ${plural(secretsRemoved.length, "deploy secret")} removed; ${place} stays`,
  });
  deps.reporter.success(`The previews of ${name} are removed. ${stays}`);
  const remaining = [
    stays,
    ...deploySecretsLeft(github, { plan, removed: secretsRemoved }),
    containerImagesLeft(github, plan),
  ];
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return { destroyed, secretsRemoved, remaining };
}
