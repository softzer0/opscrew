import { planAddon } from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  approveAndApplyHostPlan,
  type HostAdapterApi,
  type HostPlanOutcome,
} from "../shared/host-plan";
import type { CheckKey } from "./key";

/** The comment of `repository`'s (`owner/repo`) check key line, as the `check-key` step writes it. */
function checkKeyComment(repository: string): string {
  return `opscrew-check:${repository}`;
}

/**
 * The check key's authorized_keys line as the `check-key` host step writes it, restricted to `df`:
 * a new cloud server gets it at its first boot.
 */
export function checkKeyLine(key: CheckKey, repository: string): string {
  return `restrict,command="df -P -B1 /" ${key.publicKeyOpenSsh} ${checkKeyComment(repository)}`;
}

/**
 * True when the deploy user's authorized_keys on a server OpsCrew created already holds `key` as
 * the check key of `repository` (`owner/repo`): read over `remote` as deploy (read-only, audited
 * without the address).
 */
export async function hasCheckKey(
  deps: Pick<PhaseDeps, "audit">,
  remote: RemoteExec,
  key: CheckKey,
  repository: string,
): Promise<boolean> {
  const result = await remote.run("cat ~/.ssh/authorized_keys", { timeoutMs: 30_000 });
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the deploy user's authorized keys (read-only)",
    target: "server",
    decision: "allow",
  });
  if (result.exitCode !== 0) return false;
  const blob = ` ${key.publicKeyOpenSsh.split(" ")[1]} `;
  return result.stdout
    .split(/\r?\n/)
    .some(
      (line) => line.includes(blob) && line.trimEnd().endsWith(` ${checkKeyComment(repository)}`),
    );
}

/**
 * The `check-key` host step (`planAddon`): the scheduled check's public key of `repository` in
 * the deploy user's authorized_keys, where it can run only `df`. Shown, approved by its hash
 * (`host-apply`) and applied over `remote`: as deploy (`login`) on a server OpsCrew created, as
 * root on the user's own.
 */
export async function addCheckKey(
  deps: Pick<PhaseDeps, "paths" | "reporter" | "approvals" | "audit" | "version" | "clock">,
  input: {
    plan: DeployPlan;
    key: CheckKey;
    repository: string;
    remote: RemoteExec;
    runAs: "login" | "root";
    apply: HostAdapterApi["apply"];
    command: string;
    phase: PhaseName;
    /** Show and save the plan only. */
    planOnly?: boolean;
  },
): Promise<HostPlanOutcome> {
  const { runAs, repository } = input;
  const plan = planAddon("check-key", {
    app: input.plan.app.name,
    runAs,
    repository,
    enable: { publicKey: input.key.publicKeyOpenSsh },
  });
  const server = runAs === "root" ? "your server" : "the server";
  return approveAndApplyHostPlan(deps, {
    plan,
    remote: input.remote,
    apply: input.apply,
    // The step changes no SSH or firewall setting.
    verifyLogin: async () => true,
    title: `Let the scheduled check of ${repository} read the disk of ${server} with its own key`,
    server,
    planOf: server,
    upToDate: `The scheduled check's key is on ${server}; nothing on it changes.`,
    command: input.command,
    phase: input.phase,
    secrets: async () => ({}),
    applying: `Adding the scheduled check's key to ${server}`,
    ...(input.planOnly === true ? { planOnly: true } : {}),
  });
}
