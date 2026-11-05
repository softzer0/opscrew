/**
 * The preview server's command, `/srv/apps/<app>/bin/opscrew-preview`
 * (specs/022-preview-environments/contracts/opscrew-preview.md), as `opscrew preview …` runs it:
 * as `deploy` with the environment's deploy key and the pinned host key, the request as its
 * arguments. Its last line, `opscrew-preview: <state> <detail>`, is checked with zod.
 */
import { previewCommand } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan, Previews } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import type { ProvisionServices } from "../provision/types";
import { deployShell } from "../status/certificates";

/** The fakes `opscrew preview …` takes in tests: the deploy user's shell. */
export type PreviewServices = Pick<ProvisionServices, "remote">;

/** A preview's state in the command's `list`. */
export const PreviewStateSchema = z.enum(["running", "seed-failed", "failed"]);

/** The command's last line: its state and detail (the contract's table). */
const ReplySchema = z.object({
  state: z.enum([
    "running",
    "removed",
    "listed",
    "refused",
    "cap",
    "failed",
    "seed-failed",
    "busy",
  ]),
  detail: z.string().regex(/^\S+$/),
});

/** What the command answered: its exit code, its lines before its last line, and that line. */
export interface PreviewReply {
  exitCode: number;
  lines: string[];
  reply: z.infer<typeof ReplySchema>;
}

/** A pull request number the command accepts (`^[1-9][0-9]{0,5}$`). */
export const PREVIEW_NUMBER = /^[1-9][0-9]{0,5}$/;

/** The previews of `plan`'s environment, or a refusal when it is no preview environment. */
export function requirePreviews(plan: DeployPlan, environment: string, command: string): Previews {
  const previews = plan.environment?.previews;
  if (previews !== undefined) return previews;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `The ${environment} environment has no previews: \`${command}\` works on a preview environment. Nothing was changed.`,
    {
      hint: "Name the preview environment with --env (`opscrew env list` shows it), or add one with `opscrew env add preview --previews`.",
    },
  );
}

/**
 * `text` as a pull request number the preview command accepts.
 * @throws OpsCrewError `INVALID_INPUT` for anything else.
 */
export function previewNumber(text: string): number {
  if (PREVIEW_NUMBER.test(text)) return Number(text);
  throw new OpsCrewError(
    "INVALID_INPUT",
    `"${text}" is not a pull request number. Nothing was changed.`,
    { hint: "Give the number of the pull request, for example 42 for pr-42." },
  );
}

/** The address of preview `n`: `https://pr-<n>.<base>`. */
export function previewAddress(previews: Previews, n: number): string {
  return `https://pr-${n}.${previews.domain}`;
}

/**
 * The deploy user's shell on the preview server, with the environment's deploy key.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no address or deploy key.
 */
export async function previewShell(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: PreviewServices = {},
): Promise<RemoteExec> {
  const remote = await deployShell(deps, plan, services);
  if (remote !== undefined) return remote;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew has no SSH login to the preview server on this computer (its address or the environment's deploy key is missing), so it could not reach the previews.",
    {
      hint: `Run the command on the computer that ran \`opscrew provision${await flagOf(deps)}\`, or run that command here first.`,
    },
  );
}

/**
 * Runs the preview command with `request` (`list`, `logs <n>` or `down <n>`, fixed words and a
 * checked number) over `remote`, and reads its last line. `timeoutMs` bounds the run.
 * @throws OpsCrewError `COMMAND_FAILED` when the server does not answer, or the command is not
 * there or answers without the contract's last line.
 */
export async function runPreviewCommand(
  deps: PhaseDeps,
  plan: DeployPlan,
  remote: RemoteExec,
  request: string,
  timeoutMs: number,
): Promise<PreviewReply> {
  const result = await remote.run(`${previewCommand(plan.app.name)} ${request}`, {
    timeoutMs,
  });
  if (result.exitCode === 255 || result.timedOut === true) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      "The preview server did not answer over SSH, so OpsCrew could not reach the previews.",
      { hint: `Check that it is on, then run \`opscrew status${await flagOf(deps)}\`.` },
    );
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
  const last = /^opscrew-preview: (\S+) (\S+)$/.exec(lines.at(-1)?.trim() ?? "");
  const reply = ReplySchema.safeParse({ state: last?.[1], detail: last?.[2] });
  if (!reply.success) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The preview command on the server did not answer as OpsCrew expects (exit code ${result.exitCode}), so the previews' recipe there is missing or not the one OpsCrew installs.`,
      { hint: `Run \`opscrew provision${await flagOf(deps)}\`: it installs the recipe again.` },
    );
  }
  return { exitCode: result.exitCode, lines: lines.slice(0, -1), reply: reply.data };
}

/**
 * The plain error of an answer other than the one the request expects, after OpsCrew tried to
 * `what`: a lock held too long, or anything else the command said.
 */
export async function previewCommandFailed(
  deps: PhaseDeps,
  answer: PreviewReply,
  what: string,
): Promise<OpsCrewError> {
  const { reply, exitCode } = answer;
  if (reply.state === "busy") {
    return new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not ${what}: the preview was busy for ${reply.detail} seconds (a pull request's deploy may be running).`,
      { hint: "Wait until its preview job in GitHub Actions ends, then try again." },
    );
  }
  return new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew could not ${what}: the preview command answered "${reply.state} ${reply.detail}" (exit code ${exitCode}).`,
    {
      hint: `Run \`opscrew provision${await flagOf(deps)}\` to install the previews' recipe again, then try again.`,
    },
  );
}

/** The flags of the environment `deps.paths` belong to, for the commands an error names. */
function flagOf(deps: PhaseDeps): Promise<string> {
  return commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
}

/** The audit entry's target of the preview server: never its address. */
export function previewServerTarget(plan: DeployPlan): string {
  return plan.target.provider === "own" ? "own server" : "server";
}
