/**
 * `opscrew preview destroy <n>` (FR-2219, spec.md US6): removes one preview as if its pull
 * request closed, through the preview command's `down <n>`, after the typed `pr-<n>`.
 */
import { previewCommand } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { refusalReason } from "../shared";
import {
  type PreviewServices,
  previewCommandFailed,
  previewNumber,
  previewServerTarget,
  previewShell,
  requirePreviews,
  runPreviewCommand,
} from "./remote";

/**
 * Removes preview `number` (its containers, data, site and route) once the user typed
 * `pr-<number>` (a `remote-exec` approval with `allowDestroy`; `--confirm pr-<n>` in scripts),
 * then runs `down <n>` as the deploy user, audited as `remote-exec`. A preview that is not there
 * is removed already. A push to its pull request creates it again, empty.
 * @throws OpsCrewError `INVALID_INPUT` for an environment without previews or a bad number,
 * `APPROVAL_REFUSED` when not confirmed (nothing changed), `COMMAND_FAILED` when `down` fails.
 */
export async function destroyPreview(
  deps: PhaseDeps,
  plan: DeployPlan,
  number: string,
  options: { services?: PreviewServices } = {},
): Promise<void> {
  requirePreviews(plan, deps.paths.environment, "opscrew preview destroy");
  const n = previewNumber(number);
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const remote = await previewShell(deps, plan, options.services);
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Remove preview pr-${n} of ${plan.app.name} with its data`,
    details: [
      `Preview pr-${n} is removed as if its pull request closed: its containers, its databases and files, its site and its route. This cannot be undone.`,
      "A new push to the pull request creates it again, empty (seeded when the recipe has a seed).",
      "On the preview server, as deploy:",
      `  ${previewCommand(plan.app.name)} down ${n}`,
    ].join("\n"),
    allowDestroy: true,
    confirmPhrase: `pr-${n}`,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `Preview pr-${n} was not removed${refusalReason(approval)}. Nothing was changed.`,
      {
        hint: `Run \`opscrew preview destroy ${n}${flag}\` again and type pr-${n} (in a script: --confirm pr-${n}).`,
      },
    );
  }
  deps.reporter.step(`Removing preview pr-${n}`);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "remove a preview",
    target: previewServerTarget(plan),
    decision: "approved",
    detail: `pr-${n}`,
  });
  // `down` waits up to 600 seconds for the preview's lock.
  const answer = await runPreviewCommand(deps, plan, remote, `down ${n}`, 15 * 60_000);
  if (answer.exitCode !== 0 || answer.reply.state !== "removed") {
    throw await previewCommandFailed(deps, answer, `remove pr-${n}`);
  }
  deps.reporter.success(`Removed preview pr-${n} with its data.`);
}
