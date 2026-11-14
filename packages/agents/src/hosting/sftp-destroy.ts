/**
 * `opscrew destroy` for an app on an SFTP-only host (027 plan 10, FR-2707): a hosting plan listing
 * only what `.opscrew/hosting.json` records as OpsCrew's (GitHub Actions' key, the app's folder and
 * the folder OpsCrew made it in), approved by its SHA-256 hash (`hosting-apply`) with
 * `allowDestroy` and the typed hostname, and applied over SFTP; then the deploy secrets in GitHub
 * through their usual removal. The hostname, its document root and its certificate are the
 * user's, in the host's panel.
 */
import { posix } from "node:path";
import { canonicalJson, plural, sha256Hex } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  deploymentFiles,
  deploySecretsLeft,
  nothingDeployed,
  recordTeardown,
  removeDeploySecrets,
  resolveGitHub,
} from "../destroy/common";
import type { DestroyOptions, DestroyResult } from "../destroy/types";
import { type AdapterPlanItem, describeAdapterPlan, hasDeployment } from "../shared";
import { requireApprovedHash } from "./apply";
import { approveHostingDestroy, auditedDestroy, HostingDestroyError } from "./common";
import { HostnameSchema, hostingPlanFile } from "./plan";
import { environmentOf } from "./provision-plans";
import { forgetObjects, type HostingObject, type HostingRecord, readHostingRecord } from "./record";
import { reachSftpHost } from "./sftp";
import { AUTHORIZED_KEYS, CI_KEY_STEP, SftpPathSchema } from "./sftp-plan";

const SftpDestroyStepSchema = z.discriminatedUnion("kind", [
  // GitHub Actions' key's line in ~/.ssh/authorized_keys, first, so no deploy runs after it.
  z.strictObject({ kind: z.literal("key"), line: z.string().min(1) }),
  // The key the user added in the host's panel: the user removes it there.
  z.strictObject({ kind: z.literal("panel-step"), line: z.string().min(1) }),
  // The app's folder with everything in it, then `parent` (the folder OpsCrew made it in) when
  // nothing else is in it.
  z.strictObject({
    kind: z.literal("folder"),
    path: SftpPathSchema,
    parent: SftpPathSchema.optional(),
  }),
]);

/** An SFTP-only host's destroy plan, as saved in `.opscrew/plans/hosting-<env>-destroy.json`. */
const SftpDestroyPlanSchema = z.strictObject({
  plan: z.literal("sftp-destroy"),
  /** The SFTP login: `<user> at <host>`. */
  account: z.string().min(1),
  environment: z.string().min(1),
  hostname: HostnameSchema,
  steps: z.array(SftpDestroyStepSchema),
});

export type SftpDestroyPlan = z.infer<typeof SftpDestroyPlanSchema>;
type SftpDestroyStep = SftpDestroyPlan["steps"][number];

/** SHA-256 of the plan's canonical JSON: the hash `hosting-apply` binds. */
export function sftpDestroyHash(plan: SftpDestroyPlan): string {
  return sha256Hex(canonicalJson(SftpDestroyPlanSchema.parse(plan)));
}

/** One step in plain English, as the plan shows it. */
function stepItem(step: SftpDestroyStep): AdapterPlanItem {
  switch (step.kind) {
    case "key":
      return {
        title: `Remove GitHub Actions' key from ~/${AUTHORIZED_KEYS}: ${step.line}`,
        state: "change",
        reason: "First, so no deploy reaches the host after it; the file's other keys stay.",
      };
    case "panel-step":
      return {
        title: `You, in your host's panel: remove GitHub Actions' key from the SFTP user's keys: ${step.line}`,
        state: "change",
        reason:
          "You added it there, as the host doesn't show its keys over SFTP; OpsCrew forgets it.",
      };
    case "folder":
      return {
        title: `Remove ${step.path}/ with everything in it${step.parent === undefined ? "" : `, then ${step.parent}/ when nothing else is in it`}`,
        state: "change",
        reason:
          "The releases, the app's settings and its state go; nothing else on the host changes.",
      };
  }
}

/**
 * The plan from the record: GitHub Actions' key (its line, or the step the user takes in the
 * panel), then the app's folder and the folder OpsCrew made it in.
 */
function buildSftpDestroyPlan(
  header: Omit<SftpDestroyPlan, "plan" | "steps">,
  record: HostingRecord,
  folder: string,
): SftpDestroyPlan {
  const { objects } = record;
  const steps: SftpDestroyStep[] = [];
  const line = objects.find((o) => o.kind === "file" && o.key === AUTHORIZED_KEYS)?.value;
  if (line !== undefined) steps.push({ kind: "key", line });
  const listed = objects.find((o) => o.kind === "panel-step" && o.key === CI_KEY_STEP)?.value;
  if (listed !== undefined) steps.push({ kind: "panel-step", line: listed });
  const parent = posix.dirname(folder);
  if (objects.some((o) => o.kind === "folder" && o.key === folder)) {
    steps.push({
      kind: "folder",
      path: folder,
      ...(objects.some((o) => o.kind === "folder" && o.key === parent) ? { parent } : {}),
    });
  }
  return { plan: "sftp-destroy", ...header, steps };
}

/** The account's files and the record, as the apply changes them. */
interface SftpDestroyContext {
  files: Awaited<ReturnType<typeof reachSftpHost>>["files"];
  /** Forgets every recorded object `match` takes, once it is gone. */
  forget: (match: (object: HostingObject) => boolean) => Promise<void>;
}

/**
 * Applies an approved destroy plan: refuses with `PLAN_HASH_MISMATCH` before any change when its
 * hash isn't `approvedHash`, then takes the steps in order, each recorded object forgotten once it
 * is gone; the first failure stops with a {@link HostingDestroyError}. A key line already gone, or
 * a folder already removed, counts as removed. Answers the steps taken.
 */
export async function applySftpDestroy(
  plan: SftpDestroyPlan,
  ctx: SftpDestroyContext & { approvedHash: string },
): Promise<{ applied: SftpDestroyStep["kind"][] }> {
  requireApprovedHash(
    ctx.approvedHash,
    sftpDestroyHash(plan),
    "hosting destroy plan",
    "OpsCrew removes nothing from the SFTP host",
  );
  const { files } = ctx;
  const applied: SftpDestroyStep["kind"][] = [];
  try {
    for (const step of plan.steps) {
      if (step.kind === "key") {
        const keys = await files.readFile(AUTHORIZED_KEYS);
        const lines = (keys ?? "").split("\n");
        if (lines.some((line) => line.trim() === step.line)) {
          const kept = lines.filter((line) => line.trim() !== step.line).join("\n");
          await files.writeFile(AUTHORIZED_KEYS, new TextEncoder().encode(kept), 0o600);
        }
        await ctx.forget((o) => o.kind === "file" && o.key === AUTHORIZED_KEYS);
      } else if (step.kind === "panel-step") {
        await ctx.forget((o) => o.kind === "panel-step" && o.key === CI_KEY_STEP);
      } else {
        await files.remove(step.path);
        const { parent } = step;
        if (parent !== undefined && (await files.list(parent))?.length === 0) {
          await files.remove(parent);
        }
        await ctx.forget(
          (o) =>
            (o.kind === "folder" && (o.key === step.path || o.key === parent)) ||
            (o.kind === "file" && o.key.startsWith(`${step.path}/`)),
        );
      }
      applied.push(step.kind);
    }
  } catch (error) {
    throw new HostingDestroyError(error, applied, "The SFTP host");
  }
  return { applied };
}

/**
 * `opscrew destroy` for an app on an SFTP-only host (see the module's comment), each change only
 * after the one before it succeeded:
 * 1. something to remove: the record lists objects OpsCrew made, or the plan is provisioned;
 * 2. the SFTP host (the login the interview recorded, its confirmed key) and GitHub (optional:
 *    without it, the deploy secrets are listed under what remains);
 * 3. the destroy plan: saved as `.opscrew/plans/hosting-<env>-destroy.json`, shown, and approved
 *    by its hash (`hosting-apply`, `allowDestroy`, the hostname typed);
 * 4. the plan applied over SFTP ({@link applySftpDestroy});
 * 5. the deploy secrets in GitHub (`removeDeploySecrets`, their own `github-secrets` approval),
 *    then OpsCrew's record of the deployment.
 * A refusal or failure leaves everything after it as it was; running it again continues.
 */
export async function destroySftp(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DestroyOptions,
): Promise<DestroyResult> {
  const recorded = await readHostingRecord(deps.paths);
  if (!hasDeployment(plan) && (recorded?.objects.length ?? 0) === 0) throw nothingDeployed(plan);
  deps.reporter.step("Checking your SFTP host and GitHub access");
  const reach = await reachSftpHost(deps, plan);
  const github = await resolveGitHub(deps, options.services ?? {});
  const { hostname, account, folder } = reach;
  const destroyPlan = buildSftpDestroyPlan(
    { account, environment: environmentOf(plan), hostname },
    reach.record,
    folder,
  );
  const hash = sftpDestroyHash(destroyPlan);
  const approval = await approveHostingDestroy(deps, {
    plan: destroyPlan,
    hash,
    details: describeAdapterPlan({
      heading: `Hosting destroy plan for ${hostname} on the SFTP host ${account}`,
      items: destroyPlan.steps.map(stepItem),
      findings: [],
      note: "OpsCrew removes only what .opscrew/hosting.json lists as made by OpsCrew; everything else on the host stays as it is.",
      hashLabel: "Hosting plan hash",
      hash,
    }),
    title: `Remove ${hostname} from the SFTP host ${account} (${plural(destroyPlan.steps.length, "step")})`,
    file: hostingPlanFile(deps.paths, destroyPlan.environment, "destroy"),
    hostname,
    nothing: "Nothing OpsCrew made is left on the SFTP host; it finishes the cleanup.",
  });
  const taken = await auditedDestroy(deps, {
    plan: destroyPlan,
    hash,
    removing: "Removing the app from the SFTP host",
    removed: `Removed ${hostname} from the SFTP host.`,
    apply: () =>
      applySftpDestroy(destroyPlan, {
        files: reach.files,
        forget: async (match) => {
          await forgetObjects(deps.paths, match);
        },
        approvedHash: hash,
      }),
  });
  const secretsRemoved = await removeDeploySecrets(deps, github, {
    plan,
    done: `${hostname} is removed from the SFTP host.`,
    reach: "the SFTP host",
  });
  await recordTeardown(deps, plan, [approval], {
    summary: "app removed from the SFTP host",
    forgetAddress: false,
  });
  await deps.audit.append({
    kind: "phase",
    actor: "opscrew",
    action: "destroy",
    phase: "provision",
    target: plan.app.name,
    detail: `app removed from the SFTP host: ${plural(taken?.applied.length ?? 0, "step")} taken, ${plural(secretsRemoved.length, "deploy secret")} removed`,
  });
  const repoFiles = await deploymentFiles(deps, plan);
  const remaining = [
    `${hostname}, its document root and its certificate in your host's panel: point the hostname elsewhere or remove it there.`,
    ...destroyPlan.steps.flatMap((step) =>
      step.kind === "panel-step"
        ? [
            `In your host's panel, unless you did it already: remove GitHub Actions' key ${step.line}.`,
          ]
        : [],
    ),
    ...deploySecretsLeft(github, { plan, removed: secretsRemoved }),
    `The deployment files in the repository (${repoFiles.folder}/ and ${plan.cicd.workflowPath}). Pushes still run the workflow, but it can't reach the host until \`${repoFiles.provision}\` sets it up again.`,
    "Your own SFTP login and key file (OPSCREW_SFTP_KEY): OpsCrew never deletes them.",
  ];
  deps.reporter.info(["What remains:", ...remaining.map((item) => `  - ${item}`)].join("\n"));
  return { destroyed: [], secretsRemoved, remaining };
}
