import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import type { ProjectPaths } from "@opscrew/core";
import {
  CHECK_SECRETS,
  deploySecretName,
  type RenderedFile,
  tunnelMode,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubSetup } from "../provision/credentials";
import type { ProvisionServices } from "../provision/types";
import type { HostAdapterApi, HostPlanOutcome } from "../shared/host-plan";
import { checkFiles, otherPlans } from "./files";
import { addCheckKey, checkKeyLine } from "./host";
import { type CheckKey, ensureCheckKey, readCheckKey } from "./key";
import { changeCheckPause } from "./pause";
import { type CheckServerReach, storeCheckSecrets } from "./secrets";
import { repositoryCheckSettings } from "./settings";

/**
 * True when the check reads `plan`'s server's disk over SSH with the check key: a cloud or own
 * server deployed from GitHub's machines or a runner machine, never through a tunnel (the check's
 * `ssh` can't pass Cloudflare Access). The server's own runner reads it there, with no key.
 */
export function checkReachesOverSsh(plan: DeployPlan): boolean {
  return (
    plan.target.mode === "vps-compose" && plan.environment?.runner !== "server" && !tunnelMode(plan)
  );
}

/**
 * The scheduled check's files for the deploy-setup pull request (`checkFiles`), with the
 * repository's visibility from GitHub.
 */
export async function deploySetupCheckFiles(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  github: Pick<GitHubSetup, "api" | "owner" | "repo">,
): Promise<RenderedFile[]> {
  const repo = await github.api.getRepo(github.owner, github.repo);
  return checkFiles(deps.paths, plan, {
    owner: github.owner,
    name: github.repo,
    public: !repo.private,
  });
}

/** The check key of `plan`'s environment, when the check is on and reads the disk over SSH. */
export async function environmentCheckKey(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: DeployPlan,
): Promise<CheckKey | undefined> {
  if (plan.observability?.check?.enabled !== true || !checkReachesOverSsh(plan)) return undefined;
  return ensureCheckKey(deps.paths, deps.redactor);
}

/**
 * The check key's authorized_keys line for rendering `plan`'s files, which a new cloud server
 * gets at its first boot: none on the user's own server or without the check over SSH. With
 * `create` false (a preview) a key this computer lacks is not made, and there is no line.
 */
export async function renderedCheckKeyLine(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  plan: DeployPlan,
  repository: string,
  create = true,
): Promise<string | undefined> {
  if (plan.target.provider === "own") return undefined;
  if (plan.observability?.check?.enabled !== true || !checkReachesOverSsh(plan)) return undefined;
  const key = create
    ? await ensureCheckKey(deps.paths, deps.redactor)
    : await readCheckKey(deps.paths, deps.redactor);
  return key === undefined ? undefined : checkKeyLine(key, repository);
}

/** The server whose disk the check reads, and how OpsCrew changes it. */
export interface CheckServer {
  /** The shell the host step runs through: deploy's (`login`) or the admin login's (`root`). */
  remote: RemoteExec;
  runAs: "login" | "root";
  apply: HostAdapterApi["apply"];
  /** True when the server already has the key as the repository's check key. */
  hasKey: () => Promise<boolean>;
  /** What `<prefix>CHECK_SERVER` holds. */
  reach: CheckServerReach;
}

/**
 * The `check-key` host plan (`addCheckKey`) when `server` lacks `key`; with `planOnly` it is only
 * shown and saved, and a line names its hash for scripts. `undefined` when the server has it.
 */
export async function checkKeyStep(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    key: CheckKey;
    repository: string;
    server: Omit<CheckServer, "reach">;
    command: string;
    phase: PhaseName;
    planOnly?: boolean;
  },
): Promise<HostPlanOutcome | undefined> {
  const { server } = input;
  if (await server.hasKey()) return undefined;
  const outcome = await addCheckKey(deps, {
    plan: input.plan,
    key: input.key,
    repository: input.repository,
    remote: server.remote,
    runAs: server.runAs,
    apply: server.apply,
    command: input.command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
  });
  if (input.planOnly === true) {
    deps.reporter.info(
      `The scheduled check's key has a host plan of its own: check-key plan ${outcome.hash}. In a script, approve it too (\`--approve ${outcome.hash}\`).`,
    );
  }
  return outcome;
}

/**
 * Provision's part of the scheduled check, for an environment with it on, after the server is
 * ready: the check key (`key`, the repository's) added by the `check-key` host step when `server`
 * lacks it, then (with `storeSecrets`) the check's repository secrets. `key` and `server` are
 * given only where the check reads the disk over SSH ({@link checkReachesOverSsh}). Returns the
 * host step's outcome, when one was shown.
 */
export async function provisionCheck(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    github: GitHubSetup;
    key?: CheckKey;
    server?: CheckServer;
    storeSecrets: boolean;
    services: Pick<ProvisionServices, "askEnv">;
    command: string;
    phase: PhaseName;
  },
): Promise<HostPlanOutcome | undefined> {
  const { plan, github, server, key } = input;
  if (plan.observability?.check?.enabled !== true) return undefined;
  const host =
    server === undefined || key === undefined
      ? undefined
      : await checkKeyStep(deps, {
          plan,
          key,
          repository: `${github.owner}/${github.repo}`,
          server,
          command: input.command,
          phase: input.phase,
        });
  if (input.storeSecrets) {
    await storeCheckSecrets(deps, github, {
      plan,
      settings: await repositoryCheckSettings(deps.paths, plan),
      ...(key === undefined ? {} : { key }),
      ...(server === undefined ? {} : { server: server.reach }),
      services: input.services,
      phase: input.phase,
    });
  }
  return host;
}

/**
 * The check's repository secrets a teardown of `plan`'s environment deletes, when it has the
 * check on: its server's (`<prefix>CHECK_SERVER`, which holds the address) where the check reads
 * the disk over SSH, and the check key (`OPSCREW_CHECK_SSH_KEY`) when no other environment of
 * the repository still has the check on.
 */
export async function teardownCheckSecretNames(
  paths: Pick<ProjectPaths, "root" | "homeDir">,
  plan: DeployPlan,
): Promise<string[]> {
  if (plan.observability?.check?.enabled !== true) return [];
  const names = checkReachesOverSsh(plan) ? [deploySecretName(plan, CHECK_SECRETS.server)] : [];
  const checked = (await otherPlans(paths, plan)).some(
    (other) =>
      other.plan.observability?.check?.enabled === true &&
      other.plan.deployment.destroyedAt === undefined,
  );
  return checked ? names : [...names, CHECK_SECRETS.sshKey];
}

/**
 * After a provision: the environment's entry in `OPSCREW_CHECK_PAUSED` (a move's window or a
 * teardown) is removed, so the check watches it again; declined, a warning says it stays paused.
 */
export async function resumeCheck(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
  input: { command: string; phase: PhaseName },
): Promise<void> {
  const outcome = await changeCheckPause(deps, github, plan, undefined, input.phase);
  if (outcome === "refused") {
    deps.reporter.warn(
      `The scheduled check stays paused for this environment, so it opens no issue when the app is down. Run \`${input.command}\` again to resume it.`,
    );
  }
}
