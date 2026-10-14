import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import {
  GitClient,
  GitHubClient,
  githubConnector,
  resolveGitHubToken,
} from "@opscrew/connector-github";
import type { ApprovalRecord, IacEngine } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError } from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { githubCoordinates } from "../provision";
import type { DestroyGitHubApi, DestroyOptions, DestroyServices } from "./types";

/** The command every hint of a stopped teardown tells the user to run again. */
export const COMMAND = "opscrew destroy";

/** Where the deploy secrets live, and why they cannot be removed when `api` is missing. */
export interface GitHubTarget {
  owner?: string;
  repo?: string;
  api?: DestroyGitHubApi;
  skipReason?: string;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function nothingDeployed(plan: DeployPlan): OpsCrewError {
  const own = plan.target.provider === "own";
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "Nothing is deployed for this project, so there is nothing to destroy.",
    {
      hint: plan.deployment.destroyedAt
        ? `OpsCrew already tore this deployment down (${plan.deployment.destroyedAt}). Run \`opscrew provision\` to create a new one.${own ? " To also undo OpsCrew's changes to your server, run `opscrew destroy --undo-host`." : ""}`
        : "Run `opscrew provision` to create a deployment.",
    },
  );
}

/** 1. The infrastructure state is not on this computer: nothing can be planned, nothing changes. */
export function stateNotHere(plan: DeployPlan): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The infrastructure state of ${plan.app.name} is not on this computer (.opscrew/tfstate/prod.tfstate), so OpsCrew cannot tell what to delete. Nothing was changed.`,
    {
      hint: "Run `opscrew destroy` on the computer that ran `opscrew provision`, or copy its .opscrew/tfstate folder (and, with OpenTofu, its state passphrase from ~/.opscrew/projects/<project>/state_passphrase) here, then try again.",
    },
  );
}

/** 2. Cloudflare token (only when the plan manages DNS there); stops when it is missing or broken. */
export async function checkCloudflare(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: DestroyServices,
): Promise<boolean> {
  if (plan.dns.provider !== "cloudflare") return false;
  const connector = cloudflareConnector({
    env: deps.env,
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
  const requirement = connector.credentials;
  const api = services.cloudflare === undefined ? (connector.client ?? null) : services.cloudflare;
  const help = `It needs: ${requirement.scopes.join(", ")}. Create one at ${requirement.createUrl}`;
  if (api === null) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No Cloudflare token found: set ${requirement.envVars.join(" or ")}. Nothing was changed.`,
      {
        hint:
          plan.target.provider === "own"
            ? `The app's DNS records${plan.target.access === "tunnel" ? ", its Cloudflare Tunnel and Access" : ""} for ${plan.dns.domain ?? "the app"} are on Cloudflare, and OpsCrew removes them first. ${help}`
            : `The deployment's DNS records for ${plan.dns.domain ?? "the app"} are on Cloudflare; deleting the server without them would leave them pointing at a dead address. ${help}`,
      },
    );
  }
  const check = await api.verifyToken();
  if (!check.ok) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `Cloudflare: ${deps.redactor.redact(check.message)}`,
      {
        hint: `The token ${help}`,
      },
    );
  }
  return true;
}

/** 2. GitHub repository and token for the secret cleanup; optional, so problems become a reason. */
export async function resolveGitHub(
  deps: PhaseDeps,
  services: DestroyServices,
): Promise<GitHubTarget> {
  const git = new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
  });
  let coordinates: { owner: string; repo: string };
  try {
    if (!(await git.isRepo())) return { skipReason: "this project is not a git repository" };
    coordinates = await githubCoordinates(git);
  } catch {
    return { skipReason: "the repository has no GitHub remote named origin" };
  }
  let api: DestroyGitHubApi | null | undefined = services.github;
  if (api === undefined) {
    const token = await resolveGitHubToken(deps.env, deps.runner);
    if (token) deps.redactor.addLiteral(token, "github-token");
    api = token ? new GitHubClient({ token, fetch: deps.fetch, version: deps.version }) : null;
  }
  if (api === null) {
    const variables = githubConnector({ token: undefined, fetch: deps.fetch }).credentials.envVars;
    return {
      ...coordinates,
      skipReason: `no GitHub token was found (set ${variables.join(" or ")}, or sign in with \`gh auth login\`)`,
    };
  }
  return { ...coordinates, api };
}

export function secretsPage(github: GitHubTarget): string {
  return github.owner && github.repo
    ? `https://github.com/${github.owner}/${github.repo}/settings/secrets/actions`
    : "your repository's Settings → Secrets and variables → Actions";
}

/** 3. Engine, state encryption and `init` with the same backend path as provisioning. */
export async function setupEngine(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: Pick<DestroyOptions, "engine" | "services">,
  statePath: string,
): Promise<{ engine: IacEngine; env: Record<string, string | undefined> }> {
  const services = options.services ?? {};
  const preference = options.engine ?? plan.infra.engine;
  const engine = services.engine
    ? await services.engine(preference)
    : await selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
  deps.reporter.info(`Using ${engineLabel(engine.info.name)} ${engine.info.version}.`);
  const env: Record<string, string | undefined> = { ...deps.env };
  if (plan.infra.stateEncryption) {
    if (engine.info.name === "tofu") {
      // Read, never create: a new passphrase could not decrypt the existing state.
      const passphrase = (
        await readFile(deps.paths.files.statePassphrase, "utf8").catch(() => undefined)
      )?.trim();
      if (!passphrase) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "The OpenTofu state is encrypted, but this computer does not have its passphrase. Nothing was changed.",
          {
            hint: `Copy the state passphrase file from the computer that ran \`opscrew provision\` to ${deps.paths.files.statePassphrase}, then run \`opscrew destroy\` again.`,
          },
        );
      }
      deps.redactor.addLiteral(passphrase, "state-passphrase");
      env.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
    } else {
      deps.reporter.warn(
        "Terraform cannot read state that OpenTofu encrypted. If OpenTofu provisioned this deployment, run `opscrew destroy --engine tofu` instead.",
      );
    }
  }
  await mkdir(deps.paths.files.plansDir, { recursive: true });
  deps.reporter.step(`Initialising ${engineLabel(engine.info.name)} in ${plan.infra.dir}`);
  await engine.init(join(deps.paths.root, plan.infra.dir), {
    env,
    backendConfig: { path: statePath },
  });
  return { engine, env };
}

/**
 * 8. Removes the deploy secrets `names` after a `github-secrets` approval. Names only, never values.
 * `done` says what is already gone when this step stops (for example `The infrastructure is
 * deleted.`).
 */
export async function removeDeploySecrets(
  deps: PhaseDeps,
  github: GitHubTarget,
  input: { names: readonly string[]; done: string; reach: string },
): Promise<string[]> {
  const { api, owner, repo } = github;
  if (!api || !owner || !repo) return [];
  const names = [...input.names].sort();
  const where = `${owner}/${repo}`;
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Remove the deploy secrets from ${where}`,
    details: [
      "GitHub Actions secrets to delete (names only):",
      ...names.map((name) => `  ${name}`),
      `Without them the deploy workflow cannot reach ${input.reach}; \`opscrew provision\` stores new ones.`,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The deploy secrets were not removed from ${where}. ${input.done}`,
      {
        hint: "Run `opscrew destroy` again to remove them and finish the cleanup (the pinned host key and opscrew/plan.yaml).",
      },
    );
  }
  const removed: string[] = [];
  for (const name of names) {
    try {
      await api.deleteActionsSecret(owner, repo, name);
    } catch (error) {
      const reason = isUserFacingError(error) ? error.message : "unexpected error";
      const done = input.done.replace(/\.$/, "");
      throw new OpsCrewError(
        error instanceof OpsCrewError ? error.code : "PROVIDER_ERROR",
        deps.redactor.redact(`${done}, but removing the GitHub secret ${name} failed: ${reason}`),
        {
          hint: `${error instanceof OpsCrewError && error.hint ? `${error.hint} ` : ""}Then run \`opscrew destroy\` again to finish the cleanup.`,
        },
      );
    }
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `delete secret ${name}`,
      phase: "provision",
      target: where,
      decision: "approved",
    });
    removed.push(name);
  }
  deps.reporter.success(
    `Removed ${removed.length} deploy secrets from GitHub Actions in ${where}.`,
  );
  return removed;
}

/** 8. The plan without the app's URL, with `destroyedAt` and the approvals recorded. */
export function destroyedPlan(
  plan: DeployPlan,
  at: string,
  approvals: readonly (
    | { record: ApprovalRecord | undefined; kind: "iac-apply" | "host-apply" }
    | undefined
  )[],
): DeployPlan {
  const { url, lastCompletedPhase, ...kept } = plan.deployment;
  const recorded = approvals.flatMap((entry) =>
    entry?.record?.planHash === undefined
      ? []
      : [
          {
            planHash: entry.record.planHash,
            approver: entry.record.approver,
            at: entry.record.decidedAt,
            kind: entry.kind,
          },
        ],
  );
  return {
    ...plan,
    updatedAt: at,
    approvals: [...plan.approvals, ...recorded],
    deployment: { ...kept, destroyedAt: at },
  };
}
