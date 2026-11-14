/**
 * `opscrew rotate portainer` (025 plan.md 10., US8, FR-2511): the admin password of the Portainer
 * OpsCrew installed on the app's server, changed through Portainer's own API on that server
 * (`PUT /api/users/{id}/passwd`, logged in with the current password), then the file on this
 * computer. The new password is kept before Portainer gets it, so a run that stopped half way
 * goes on with it. Both passwords travel only on the SSH session's standard input.
 */
import { rm } from "node:fs/promises";
import type { CommandResult } from "@opscrew/contracts";
import {
  canonicalJson,
  OpsCrewError,
  readTextIfExists,
  sha256Hex,
  upperFirst,
  writeFileAtomic,
} from "@opscrew/core";
import { PORTAINER_PORT } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { requireNoCloudflareMove } from "../provision/guard";
import { portainerPasswordFile, portainerPasswordToSend } from "../provision/own";
import type { ProvisionServices } from "../provision/types";
import { type RefreshRecoveryResult, refreshRecoveryCopy } from "../secrets/copy";
import { requestApproval } from "../shared/approvals";
import { serverWords } from "../shared/server-address";
import { randomPassword } from "../shared/ssh-keys";
import { READ_TIMEOUT_MS, scriptSaid } from "../snapshot/hosts";
import { serverShell } from "../status/servers";
import { assertValuesCurrent, recordRotation } from "./record";

/** What {@link rotatePortainerPassword} reaches besides this computer. */
export interface PortainerPasswordOptions {
  /** Tests: the server's shell, given its address (default: ssh with the login `opscrew logs` uses). */
  remote?: ProvisionServices["remote"];
}

/** A finished rotation. */
export interface PortainerPasswordRotation {
  /** The hash its plan was approved by. */
  hash: string;
  /** The recovery copy, refreshed: its files for the caller's pull request. */
  copy: RefreshRecoveryResult;
}

/**
 * The script run on the app's server: the current and the new password on its first two lines of
 * standard input, never on a command line (curl reads the request's body and headers from its own
 * standard input). It logs in to Portainer on its loopback port with the current password (with
 * the new one when an earlier run already changed it, then it only says so) and sets the new one.
 */
const PASSWORD_SCRIPT = String.raw`set -u
PORT=${PORTAINER_PORT}
IFS= read -r old || exit 2
IFS= read -r new || exit 2
command -v curl > /dev/null 2>&1 || { echo 'curl is missing on the server; install it, then run the command again.' >&2; exit 3; }
api() { curl -ksS --max-time 30 "$@"; }
code=$(api -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/api/users/admin/check" 2> /dev/null || true)
[ "$code" = 204 ] || { echo "Portainer does not answer on 127.0.0.1:$PORT with an admin account (HTTP $code)." >&2; exit 4; }
jwt_of() { printf '{"username":"admin","password":"%s"}' "$1" | api -X POST -H 'Content-Type: application/json' --data-binary @- "https://127.0.0.1:$PORT/api/auth" | sed -n 's/.*"jwt": *"\([^"]*\)".*/\1/p'; }
jwt=$(jwt_of "$old")
if [ -z "$jwt" ]; then
  if [ -n "$(jwt_of "$new")" ]; then echo 'opscrew-rotate: portainer already'; exit 0; fi
  echo "Portainer did not accept the admin password OpsCrew keeps." >&2
  exit 5
fi
id=$(printf 'header = "Authorization: Bearer %s"\n' "$jwt" | api -K - "https://127.0.0.1:$PORT/api/users/me" | sed -n 's/.*"Id": *\([0-9][0-9]*\).*/\1/p')
[ -n "$id" ] || { echo 'Portainer did not say which user the admin is.' >&2; exit 6; }
code=$(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\ndata-binary = "{\\"password\\":\\"%s\\",\\"newPassword\\":\\"%s\\"}"\n' "$jwt" "$old" "$new" | api -K - -X PUT -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/api/users/$id/passwd")
[ "$code" = 204 ] || { echo "Portainer refused the new admin password (HTTP $code)." >&2; exit 7; }
echo 'opscrew-rotate: portainer changed'
`;

/** The new password of an unfinished rotation, beside the current one (0600). */
function nextPasswordFile(deps: Pick<PhaseDeps, "paths">): string {
  return `${portainerPasswordFile(deps.paths)}.next`;
}

/** The plain error of the script's run on `words` that failed. */
function runFailure(deps: PhaseDeps, words: string, result: CommandResult, again: string) {
  if (result.exitCode === 255 || result.timedOut === true) {
    return new OpsCrewError(
      "COMMAND_FAILED",
      `${upperFirst(words)} did not answer over SSH, so OpsCrew does not know whether Portainer has the new password. The current and the new one stay on this computer.`,
      {
        hint: `Check that it is on and reachable (\`opscrew status\`), then run \`${again}\` again.`,
      },
    );
  }
  const said = scriptSaid(result, deps.redactor.redact);
  return new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew could not change Portainer's admin password on ${words} (exit code ${result.exitCode})${said === "" ? "." : `: ${said.replace(/\.?$/, ".")}`} Portainer keeps its current password.`,
    { hint: `Fix what it names, then run \`${again}\` again.` },
  );
}

/**
 * Rotates the admin password of the Portainer OpsCrew installed on `plan`'s app server
 * (`plan.portainer`), after the two-computer guard: a new password (32 letters and digits) is
 * registered with the redactor and kept on this computer before it is asked
 * (`portainer_password.next`, 0600; an unfinished or refused rotation's is reused, so its plan has
 * the same hash); the plan shown and approved by
 * its hash (`remote-exec`); then, on the server over SSH, {@link PASSWORD_SCRIPT} with both
 * passwords on its standard input (audited without them); then the new one replaces the current
 * one in `portainer_password`, the rotation is recorded and the recovery copy refreshed.
 * @throws OpsCrewError `INVALID_INPUT` without Portainer, `PHASE_PRECONDITION` without its
 * password on this computer, `APPROVAL_REFUSED`, `COMMAND_FAILED` when the server's run fails.
 */
export async function rotatePortainerPassword(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: PortainerPasswordOptions = {},
): Promise<PortainerPasswordRotation> {
  requireNoCloudflareMove(plan);
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const again = `opscrew rotate portainer${flags}`;
  const file = portainerPasswordFile(deps.paths);
  if (plan.portainer?.enabled !== true) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew did not install Portainer for ${environment}, so it has no admin password of it to rotate. Nothing was changed.`,
      { hint: `\`opscrew rotate${flags}\` lists what can be rotated.` },
    );
  }
  await assertValuesCurrent(deps);
  const current = await portainerPasswordToSend(deps, false);
  if (current === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer has no Portainer admin password of ${environment} (${file}), so OpsCrew can't log in to change it. Nothing was changed.`,
      {
        hint: `Bring it from your recovery copy (\`opscrew secrets restore${flags}\`) or run the command on the computer that turned Portainer on.`,
      },
    );
  }
  const kept = (await readTextIfExists(nextPasswordFile(deps)))?.trim();
  const next = kept !== undefined && kept.length >= 12 ? kept : randomPassword(32);
  deps.redactor.addLiteral(next, "portainer-password");
  // Kept before it is asked (local only): a run after a refusal asks the same hash, and the new
  // password is never lost once Portainer has it.
  if (kept !== next) await writeFileAtomic(nextPasswordFile(deps), `${next}\n`, { mode: 0o600 });
  const words = serverWords(APP_SERVER);
  const hash = sha256Hex(
    canonicalJson({
      rotation: "portainer",
      environment,
      app: plan.app.name,
      old: sha256Hex(current),
      new: sha256Hex(next),
    }),
  );
  await requestApproval(deps, {
    title: `Rotate the admin password of Portainer in ${environment}`,
    details: [
      `A new admin password made on this computer replaces Portainer's current one on ${words}; neither is ever shown.`,
      `1. OpsCrew logs in to Portainer on the server (127.0.0.1:${PORTAINER_PORT}, over SSH) with the current password and sets the new one through Portainer's API. Both reach the server only on the SSH session's standard input.`,
      `2. The new password replaces the current one in ${file}: you sign in to Portainer with it from then on. The rotation is recorded and the recovery copy refreshed.`,
      `If a step fails, both passwords stay on this computer, and \`${again}\` goes on from where it stopped.`,
      `Rotation hash: ${hash}`,
    ].join("\n"),
    hash,
    refused: {
      plan: "rotation of Portainer's admin password",
      unchanged: "Nothing was changed.",
      again,
    },
  });
  const { docker } = await serverShell(
    deps,
    plan,
    APP_SERVER,
    options.remote === undefined ? {} : { remote: options.remote },
  );
  deps.reporter.step(`Changing Portainer's admin password on ${words}`);
  const result = await docker.run(PASSWORD_SCRIPT, {
    input: `${current}\n${next}\n`,
    timeoutMs: READ_TIMEOUT_MS,
  });
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "rotate Portainer's admin password",
    target: `${environment} server ${APP_SERVER}`,
    decision: "approved",
    detail: `rotation ${hash}: ${result.exitCode === 0 ? "done" : `exit code ${result.exitCode}`}`,
  });
  if (result.exitCode !== 0) throw runFailure(deps, words, result, again);
  await writeFileAtomic(file, `${next}\n`, { mode: 0o600 });
  await rm(nextPasswordFile(deps), { force: true });
  await recordRotation(deps, ["portainer"]);
  deps.reporter.success(
    `Rotated Portainer's admin password in ${environment}: sign in with the new one, kept in ${file}.`,
  );
  return { hash, copy: await refreshRecoveryCopy(deps, plan) };
}
