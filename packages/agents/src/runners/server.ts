/**
 * The server's runner (`environment.runner: server`, plan.md "12."): the `github-runner` step of
 * the host plan, approved with it by its hash, after the repository's check; the registration
 * token fetched only while the step runs; and a registration GitHub kept after a removal deleted
 * through its API.
 */
import type { ApplyOptions, DesiredRunner } from "@opscrew/connector-ssh-host";
import type { PhaseName } from "@opscrew/contracts";
import { listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import { runnerLabel, TOOLS } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  checkRunnerRepository,
  deleteRegistrations,
  type GithubSettingsChange,
  type RunnerRepository,
  repositoryUrl,
} from "./github";
import { planWhere, runnerSuffix } from "./words";

/**
 * The server's runner's name on GitHub, `<8 hex of the SHA-256 of host>-<app>-<env>`: two servers
 * of one environment never share it, and GitHub never sees the server's address or name (`host`,
 * the login's host on this computer).
 */
export function serverRunnerName(plan: DeployPlan, host: string): string {
  return `${sha256Hex(host).slice(0, 8)}-${runnerSuffix(plan)}`;
}

/**
 * The server's runner as the `github-runner` step installs it, for `plan` on the server `host`
 * of `arch`.
 */
export function serverRunner(
  plan: DeployPlan,
  server: { arch: "amd64" | "arm64"; host: string },
  repository: Pick<RunnerRepository, "owner" | "repo">,
): DesiredRunner {
  const { arch } = server;
  const asset = arch === "arm64" ? "linux-arm64" : "linux-x64";
  const label = runnerLabel(plan);
  const pin = TOOLS.githubRunner;
  return {
    label,
    name: serverRunnerName(plan, server.host),
    repositoryUrl: repositoryUrl(repository),
    version: pin.version,
    url: pin.assets[asset].url,
    sha256: pin.assets[asset].sha256,
    asset,
  };
}

/**
 * The server's runner for `plan` (contracts/runners.md "Agents"): none unless its environment's
 * runner is `server`; otherwise the `github-runner` step for the server (its login's `host` and
 * its CPU), after checking the repository. A public repository whose outside contributors' runs need no approval gives the
 * `github-settings` change that allows the runner, and the refusal without it.
 */
export async function planServerRunner(
  repository: RunnerRepository,
  plan: DeployPlan,
  server: { arch: "amd64" | "arm64"; host: string },
): Promise<{ step?: DesiredRunner; settings?: GithubSettingsChange; refusal?: string }> {
  if (plan.environment?.runner !== "server") return {};
  requireServerRunnerTarget(plan);
  return {
    step: serverRunner(plan, server, repository),
    ...(await checkRunnerRepository(repository)),
  };
}

/** The stop for the server's runner on a server OpsCrew created. */
function cloudServerRunner(plan: DeployPlan): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew installs the server's runner only on a server you own for now: it needs root once for its system packages and its service, and the servers OpsCrew creates allow no root login. Nothing was changed.",
    {
      hint: `Set environment.runner to github in ${planWhere(plan).file}, then run the command again.`,
    },
  );
}

/**
 * Stops before any change when the plan asks for the server's runner on a server OpsCrew creates
 * (see {@link cloudServerRunner}).
 */
export function requireServerRunnerTarget(plan: DeployPlan): void {
  if (plan.environment?.runner === "server" && plan.target.provider !== "own") {
    throw cloudServerRunner(plan);
  }
}

/**
 * The host adapter's `runnerToken`: a registration or remove token from GitHub, fetched only when
 * the `github-runner` step runs and registered with the redactor; never written anywhere.
 */
export function runnerTokens(
  deps: Pick<PhaseDeps, "redactor">,
  repository: () => Promise<RunnerRepository>,
): NonNullable<ApplyOptions["runnerToken"]> {
  return async (kind) => {
    const { api, owner, repo } = await repository();
    const token =
      kind === "registration"
        ? await api.runnerRegistrationToken(owner, repo)
        : await api.runnerRemoveToken(owner, repo);
    deps.redactor.addLiteral(token, `github-runner-${kind}-token`);
    return token;
  };
}

/**
 * After a host plan removed a runner whose registration GitHub kept (`ApplyResult.stillRegistered`),
 * deletes this environment's registration through GitHub's API; another app's is only named, for
 * the user to delete in the repository's settings.
 */
export async function removeKeptRegistrations(
  deps: Pick<PhaseDeps, "audit" | "reporter">,
  repository: () => Promise<RunnerRepository>,
  plan: DeployPlan,
  run: {
    phase: PhaseName;
    stillRegistered: readonly string[];
    /** The login's host on this computer, which the runner's name is made from. */
    host: string;
  },
): Promise<void> {
  const others = run.stillRegistered.filter((app) => app !== plan.app.name);
  if (run.stillRegistered.includes(plan.app.name)) {
    const repo = await repository();
    const deleted = await deleteRegistrations(deps, repo, plan, {
      phase: run.phase,
      name: serverRunnerName(plan, run.host),
    });
    if (deleted > 0) {
      deps.reporter.info(
        `GitHub still listed the server's runner of ${plan.app.name}, so OpsCrew removed its registration through GitHub's API.`,
      );
    }
  }
  if (others.length > 0) {
    deps.reporter.warn(
      `GitHub may still list the runners of ${listText(others)} that OpsCrew removed from your server. Remove them under the repository's Settings → Actions → Runners.`,
    );
  }
}
