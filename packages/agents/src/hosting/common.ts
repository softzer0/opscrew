/**
 * What `opscrew provision` and `opscrew destroy` share between a hosting account with a panel and
 * an SFTP-only host (027 plan 2, 6, 10; ADR 0030 D3): a plan approved by its hash (`hosting-apply`)
 * with an audit entry for its start, each change and a failure; the deploy secrets in GitHub; the
 * deploy workflow and the provision pull request.
 */
import type { GitClient } from "@opscrew/connector-github";
import type { ApprovalRecord } from "@opscrew/contracts";
import { OpsCrewError, plural, upperFirst, writeFileAtomic } from "@opscrew/core";
import { type RenderedFile, renderWorkflow } from "@opscrew/iac-templates";
import type { DeployPlan, Requirements } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { COMMAND, typeNameHint } from "../destroy/common";
import type { CloudflareSetup, GitHubSetup } from "../provision/credentials";
import { approveLaterHint } from "../provision/plan-apply";
import type { DeployBranch } from "../provision/publish";
import { deploymentRenderContext } from "../provision/render";
import { placeDeploySecrets, setDeploySecrets } from "../provision/secrets";
import { publishDeployment } from "../provision/steps";
import type { ProvisionOptions, ProvisionResult } from "../provision/types";
import { approveAndWriteRenderedFiles, PlanRefusedError, refusalReason } from "../shared";
import { HostingApplyError } from "./apply";
import { hostnameOf } from "./provision-plans";

/** A hosting plan as its approval and audit entries see it: its steps, by kind. */
interface StepsPlan {
  steps: readonly { kind: string }[];
}

/** The audit entry of a change on the hosting account, bound to the approved plan's `hash`. */
function auditOf(deps: PhaseDeps, hash: string) {
  return (action: string, decision: "approved" | "refused", detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: "provision",
      target: hash,
      decision,
      detail,
    });
}

/**
 * Provision's hosting plan shown, saved in `file` when it changes something, approved by its
 * `hash` (`hosting-apply`; `--yes` never grants it), then applied, with an audit entry for the
 * start, each change (a panel step is the user's to take, so none) and a failure. With
 * `planOnly` it is only shown and saved. Answers the apply's result with its approval;
 * `undefined` when nothing was applied (no change, `planOnly`).
 */
export async function hostingPlanStep<Result extends { applied: readonly string[] }>(
  deps: PhaseDeps,
  input: {
    plan: StepsPlan;
    hash: string;
    /** The plan in words, ending with its hash: shown, and the approval's details. */
    details: string;
    title: string;
    file: string;
    /** The plan as the messages name it: `Hosting plan A (the agent)`, `the hosting plan`. */
    which: string;
    /** What it changes: `account`, `SFTP host`. */
    place: string;
    /** What the step that changes it names: `cPanel account`, `SFTP host`. */
    changing: string;
    /** The plan in the audit entries: `agent`, `app`, `sftp`. */
    auditLabel: string;
    planOnly: boolean;
    command: string;
    apply: (hash: string) => Promise<Result>;
  },
): Promise<(Result & { approval: ApprovalRecord }) | undefined> {
  const { plan, hash, details, which, place } = input;
  deps.reporter.info(details);
  if (plan.steps.length === 0) {
    deps.reporter.success(
      `${upperFirst(which)} has nothing to change: the ${place} is as planned.`,
    );
    return undefined;
  }
  await writeFileAtomic(input.file, `${JSON.stringify(plan, null, 2)}\n`);
  if (input.planOnly) {
    deps.reporter.info(`Saved ${which} (hash ${hash}); nothing on the ${place} was changed.`);
    return undefined;
  }
  const approval = await deps.approvals.request({
    kind: "hosting-apply",
    title: input.title,
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      // Said as `The <plan> was not approved`.
      plan: which.replace(/^the /, ""),
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: `Nothing on the ${place} was changed by it.`,
      hint: approveLaterHint(input.command, hash),
    });
  }
  await deps.approvals.assertApprovedHostingPlan(hash);
  deps.reporter.step(`Changing the ${input.changing} (${plural(plan.steps.length, "change")})`);
  const audit = auditOf(deps, hash);
  const changes = (kinds: readonly string[]) => kinds.filter((kind) => kind !== "panel-step");
  await audit(
    "hosting apply started",
    "approved",
    `${input.auditLabel}: ${plan.steps.map((step) => step.kind).join(", ")}`,
  );
  let result: Result;
  try {
    result = await input.apply(hash);
  } catch (error) {
    const done = error instanceof HostingApplyError ? error.applied : [];
    for (const kind of changes(done)) {
      await audit(`hosting change ${kind}`, "approved", input.auditLabel);
    }
    await audit(
      "hosting apply failed",
      "refused",
      `steps applied before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  for (const kind of changes(result.applied)) {
    await audit(`hosting change ${kind}`, "approved", input.auditLabel);
  }
  deps.reporter.success(`Applied ${which} (${plural(result.applied.length, "change")}).`);
  return { ...result, approval };
}

/**
 * Stores `secrets` as the deploy environment's GitHub secrets after their own approval
 * (`github-secrets`, which says `about` of them and `refusedState` on a refusal), the environment
 * placed first. Answers the plan as placing it left it.
 */
export async function storeHostingSecrets(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
  input: {
    command: string;
    planOnly: boolean;
    secrets: Record<string, string>;
    about: string;
    refusedState: string;
  },
): Promise<DeployPlan> {
  const { command, planOnly } = input;
  const placed = (
    await placeDeploySecrets(deps, github, plan, { command, phase: "provision", planOnly })
  ).plan;
  await setDeploySecrets(deps, github, placed, input.secrets, [], "provision", {
    about: input.about,
    refusedState: input.refusedState,
  });
  return placed;
}

/**
 * Provision's end on a hosting account: the deploy workflow and `files` approved and written
 * (`refused` says what is set up when they aren't), then the provision pull request. Answers
 * provision's result, the app's URL as its output.
 */
export async function publishHostingWorkflow(
  deps: PhaseDeps,
  options: ProvisionOptions,
  input: {
    plan: DeployPlan;
    requirements: Requirements | undefined;
    git: GitClient;
    github: GitHubSetup;
    cloudflare: CloudflareSetup | undefined;
    branch: DeployBranch | undefined;
    /** The files besides the workflow. */
    files: readonly RenderedFile[];
    refused: string;
  },
): Promise<ProvisionResult> {
  const { plan, github } = input;
  const ctx = await deploymentRenderContext(deps, {
    plan,
    requirements: input.requirements,
    github,
    deployPublicKey: "",
    cloudflare: input.cloudflare,
  });
  const rendered: RenderedFile[] = [renderWorkflow(plan, ctx), ...input.files];
  await approveAndWriteRenderedFiles(deps, deps.paths.root, rendered, { refused: input.refused });
  const { published } = await publishDeployment(deps, {
    git: input.git,
    github,
    plan,
    files: rendered.map((file) => file.path),
    push: options.push !== false,
    secretsStored: true,
    phase: "provision",
    branch: input.branch,
    dependabot: undefined,
    ...(options.recovery !== undefined ? { recovery: options.recovery } : {}),
  });
  return {
    applied: true,
    outputs: { url: `https://${hostnameOf(plan)}` },
    branch: published.branch,
    base: published.base,
    ...(published.prUrl ? { prUrl: published.prUrl } : {}),
    published: published.published,
    pushed: published.pushed,
  };
}

/**
 * A destroy that stopped at a failure: `applied` lists the steps taken before it; `who` answered
 * what OpsCrew can't read (`The panel`, `The SFTP host`).
 */
export class HostingDestroyError extends OpsCrewError {
  readonly applied: readonly string[];

  constructor(cause: unknown, applied: readonly string[], who: string) {
    const known = cause instanceof OpsCrewError;
    super(
      known ? cause.code : "PROVIDER_ERROR",
      `${known ? cause.message : `${who}'s answer was unexpected.`} ${
        applied.length === 0
          ? "Nothing was removed before it."
          : `OpsCrew took ${plural(applied.length, "step")} of the destroy plan before it; .opscrew/hosting.json lists what is left.`
      }`,
      {
        hint: `${known && cause.hint !== undefined ? `${cause.hint} ` : ""}Then run \`${COMMAND}\` again: it continues with what is left.`,
        cause,
      },
    );
    this.name = "HostingDestroyError";
    this.applied = applied;
  }
}

/**
 * A destroy plan shown, saved in `file` and approved by its `hash` (`hosting-apply`) with
 * `allowDestroy` and `hostname` typed; for a plan without steps, `nothing` is said instead.
 * Answers the approval, `undefined` without steps.
 */
export async function approveHostingDestroy(
  deps: PhaseDeps,
  input: {
    plan: StepsPlan;
    hash: string;
    details: string;
    title: string;
    file: string;
    hostname: string;
    nothing: string;
  },
): Promise<ApprovalRecord | undefined> {
  const { plan, hash, details, hostname } = input;
  if (plan.steps.length === 0) {
    deps.reporter.info(input.nothing);
    return undefined;
  }
  deps.reporter.info(details);
  await writeFileAtomic(input.file, `${JSON.stringify(plan, null, 2)}\n`);
  const approval = await deps.approvals.request({
    kind: "hosting-apply",
    title: input.title,
    details,
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: hostname,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The teardown was not approved${refusalReason(approval)}. Nothing was changed.`,
      { hint: typeNameHint(hostname) },
    );
  }
  await deps.approvals.assertApprovedHostingPlan(hash, { allowDestroy: true });
  return approval;
}

/**
 * An approved destroy plan applied (`apply`), with an audit entry for its start, each step taken
 * and a failure (a {@link HostingDestroyError} says which steps were taken); `removing` is said
 * before, `removed` after. Answers the apply's result, `undefined` for a plan without steps.
 */
export async function auditedDestroy<Result extends { applied: readonly string[] }>(
  deps: PhaseDeps,
  input: {
    plan: StepsPlan;
    hash: string;
    removing: string;
    removed: string;
    apply: () => Promise<Result>;
  },
): Promise<Result | undefined> {
  const { plan } = input;
  if (plan.steps.length === 0) return undefined;
  deps.reporter.step(input.removing);
  const audit = auditOf(deps, input.hash);
  await audit("hosting destroy started", "approved", plan.steps.map((s) => s.kind).join(", "));
  let result: Result;
  try {
    result = await input.apply();
  } catch (error) {
    const done = error instanceof HostingDestroyError ? error.applied : [];
    for (const kind of done) await audit(`hosting removal ${kind}`, "approved", "destroy");
    await audit(
      "hosting destroy failed",
      "refused",
      `steps taken before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  for (const kind of result.applied) await audit(`hosting removal ${kind}`, "approved", "destroy");
  deps.reporter.success(input.removed);
  return result;
}
