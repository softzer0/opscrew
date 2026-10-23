import type { ApprovalRecord } from "@opscrew/contracts";
import { plural, writeFileAtomic } from "@opscrew/core";
import type { PhaseDeps } from "../../context";
import { approveLaterHint } from "../../provision/plan-apply";
import { PlanRefusedError } from "../../shared";
import {
  applyPagesPlan,
  describePagesPlan,
  PAGES_STEP_TEXT,
  type PagesApi,
  PagesApplyError,
  type PagesPlan,
  type PagesStep,
  pagesPlanDeletes,
  pagesPlanFile,
  pagesPlanHash,
} from "./plan";

/** The outcome of {@link pagesPlanStep}. */
export interface PagesStepResult {
  plan: PagesPlan;
  hash: string;
  /** The steps this run applied (none with `planOnly` or when nothing changes). */
  applied: PagesStep["kind"][];
  /** The `pages-apply` approval of this run. */
  approval?: ApprovalRecord;
}

/**
 * The Pages plan shown, saved in `.opscrew/plans/pages-<hash>.json` when it changes something,
 * approved by its hash (`pages-apply`, with the typed app name when it takes a custom domain away;
 * `--yes` never grants it), then applied, with an audit entry for the start, each change and a
 * failure. With `planOnly` it is only shown and saved.
 */
export async function pagesPlanStep(
  deps: PhaseDeps,
  input: { api: PagesApi; plan: PagesPlan; planOnly: boolean; command: string; app: string },
): Promise<PagesStepResult> {
  const { plan, command } = input;
  const hash = pagesPlanHash(plan);
  const details = describePagesPlan(plan, hash);
  deps.reporter.info(details);
  if (plan.steps.length === 0) {
    deps.reporter.success(
      "The GitHub Pages site is already set up as planned; nothing in it changes.",
    );
    return { plan, hash, applied: [] };
  }
  await writeFileAtomic(pagesPlanFile(deps.paths, hash), `${JSON.stringify(plan, null, 2)}\n`);
  if (input.planOnly) {
    deps.reporter.info(`Saved the Pages plan (hash ${hash}); nothing in GitHub Pages was changed.`);
    return { plan, hash, applied: [] };
  }
  const deletes = pagesPlanDeletes(plan);
  const repository = `${plan.owner}/${plan.repo}`;
  const changes = plural(plan.steps.length, "change");
  const approval = await deps.approvals.request({
    kind: "pages-apply",
    title: `Apply the Pages plan to the GitHub Pages site of ${repository} (${changes})`,
    details,
    planHash: hash,
    ...(deletes ? { allowDestroy: true, confirmPhrase: input.app } : {}),
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "Pages plan",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: "Nothing was changed.",
      hint: approveLaterHint(command, hash, deletes ? input.app : undefined),
    });
  }
  await deps.approvals.assertApprovedPagesPlan(hash, { allowDestroy: deletes });
  deps.reporter.step(`Changing the GitHub Pages site of ${repository} (${changes})`);
  const audit = (action: string, decision: "approved" | "refused", detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: "provision",
      target: hash,
      decision,
      detail,
    });
  await audit(
    "pages apply started",
    "approved",
    `steps: ${plan.steps.map((step) => step.kind).join(", ")}`,
  );
  let applied: PagesStep["kind"][];
  try {
    applied = await applyPagesPlan(input.api, plan, { approvedHash: hash, command });
  } catch (error) {
    // What changed before the failure is in the audit log too.
    const done = error instanceof PagesApplyError ? error.applied : [];
    for (const kind of done) await audit(`pages change ${kind}`, "approved", PAGES_STEP_TEXT[kind]);
    await audit(
      "pages apply failed",
      "refused",
      `steps applied before the failure: ${done.length > 0 ? done.join(", ") : "none"}`,
    );
    throw error;
  }
  for (const kind of applied)
    await audit(`pages change ${kind}`, "approved", PAGES_STEP_TEXT[kind]);
  deps.reporter.success(
    `Changed the GitHub Pages site of ${repository} (${plural(applied.length, "change")} applied).`,
  );
  return { plan, hash, applied, approval };
}
