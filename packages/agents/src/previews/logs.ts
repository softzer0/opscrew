/**
 * `opscrew preview logs <n>` (FR-2219): the last 200 lines of each of a preview's containers,
 * read-only through the preview command's `logs <n>`, each line masked by the redactor.
 */
import { join } from "node:path";
import { OpsCrewError, readTextIfExists } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { parseDotenv } from "../shared/app-env";
import { registerAppSecrets } from "../shared/app-secrets";
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
 * Preview `number`'s latest lines (read-only), redacted after the app's known values and the
 * preview values (`.env.<env>`) are registered. Audited as `remote-exec` without the address.
 * @throws OpsCrewError `INVALID_INPUT` for an environment without previews or a bad number,
 * `PHASE_PRECONDITION` when the server has no such preview, `COMMAND_FAILED` when the command
 * fails.
 */
export async function previewLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  number: string,
  options: { services?: PreviewServices } = {},
): Promise<string[]> {
  requirePreviews(plan, deps.paths.environment, "opscrew preview logs");
  const n = previewNumber(number);
  await registerAppSecrets(deps, plan);
  // The preview values, from the environment's own file.
  const values = await readTextIfExists(join(deps.paths.root, `.env.${deps.paths.environment}`));
  for (const value of parseDotenv(values ?? "").values()) {
    if (value !== "") deps.redactor.addLiteral(value, "app-env");
  }
  const remote = await previewShell(deps, plan, options.services);
  deps.reporter.step(`Reading the lines of preview pr-${n} (read-only)`);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read a preview's logs (read-only)",
    target: previewServerTarget(plan),
    decision: "allow",
    detail: `pr-${n}`,
  });
  const answer = await runPreviewCommand(deps, plan, remote, `logs ${n}`, 60_000);
  if (answer.exitCode === 0 && answer.reply.state === "removed") {
    const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `There is no preview pr-${n} on the preview server, so it has no lines.`,
      { hint: `\`opscrew preview list${flag}\` shows the previews there.` },
    );
  }
  if (answer.exitCode !== 0 || answer.reply.state !== "listed") {
    throw await previewCommandFailed(deps, answer, `read pr-${n}'s logs`);
  }
  return answer.lines.map((line) => deps.redactor.redact(line));
}
