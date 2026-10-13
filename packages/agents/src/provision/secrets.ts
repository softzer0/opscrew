import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError, writeFileAtomic } from "@opscrew/core";
import { DEPLOY_SECRETS } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { type AppEnvironment, assembleAppEnv, type GeneratedValues, parseDotenv } from "../shared";
import type { GitHubSetup } from "./credentials";
import type { ProvisionServices } from "./types";

/** Private file (0600) beside the deploy key holding generated values between runs. */
export function generatedValuesFile(deps: PhaseDeps): string {
  return join(deps.paths.projectHomeDir, "generated_values.json");
}

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readGenerated(deps: PhaseDeps): Promise<GeneratedValues | undefined> {
  const text = await readIfExists(generatedValuesFile(deps));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as GeneratedValues;
  } catch {
    return undefined;
  }
}

/**
 * Production environment for the deploy secrets. Interactive runs offer each value from the local
 * `.env` (only after the user confirms it) or let them type it; non-interactive runs read the file
 * named by `OPSCREW_APP_ENV_FILE`. Generated values (database password, app secrets) are kept in
 * a private file so re-running provision never changes the password Postgres was created with.
 */
export async function buildAppEnvironment(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ProvisionServices,
): Promise<AppEnvironment> {
  let dotenvText: string | undefined;
  const ask = deps.interactive ? services.askEnv : undefined;
  if (ask) {
    dotenvText = await readIfExists(join(deps.paths.root, ".env"));
  } else {
    const file = deps.env.OPSCREW_APP_ENV_FILE?.trim();
    if (file) {
      const path = isAbsolute(file) ? file : join(deps.paths.root, file);
      dotenvText = await readIfExists(path);
      if (dotenvText === undefined) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `OPSCREW_APP_ENV_FILE points to ${file}, which does not exist.`,
        );
      }
    }
  }
  const environment = await assembleAppEnv({
    plan,
    ...(dotenvText !== undefined ? { dotenvText } : {}),
    ...(ask ? { ask } : {}),
    ...(await readGenerated(deps).then((previous) => (previous ? { previous } : {}))),
  });
  await writeFileAtomic(generatedValuesFile(deps), `${JSON.stringify(environment.generated)}\n`);
  for (const text of [environment.appEnv, environment.dbEnv ?? "", environment.buildEnv]) {
    for (const value of parseDotenv(text).values()) {
      if (value.length >= 8) deps.redactor.addLiteral(value, "app-env");
    }
  }
  return environment;
}

/** The GitHub Actions secrets the deploy workflow reads. */
export function deploySecrets(input: {
  host: string;
  privateKey: string;
  knownHosts: string;
  environment: AppEnvironment;
}): Record<string, string> {
  return {
    [DEPLOY_SECRETS.host]: input.host,
    [DEPLOY_SECRETS.sshKey]: input.privateKey,
    [DEPLOY_SECRETS.knownHosts]: input.knownHosts,
    [DEPLOY_SECRETS.appEnv]: input.environment.appEnv,
    ...(input.environment.dbEnv !== undefined
      ? { [DEPLOY_SECRETS.dbEnv]: input.environment.dbEnv }
      : {}),
    [DEPLOY_SECRETS.buildEnv]: input.environment.buildEnv,
  };
}

/** Private file recording the server and repository the deploy secrets were last stored for. */
function deploySecretsRecordFile(deps: PhaseDeps): string {
  return join(deps.paths.projectHomeDir, "deploy_secrets.json");
}

/**
 * True when OpsCrew stored the deploy secrets for this server (`host`) in this repository from
 * this computer. The record holds names only, never values.
 */
export async function deploySecretsStoredFor(
  deps: PhaseDeps,
  where: { host: string; owner: string; repo: string },
): Promise<boolean> {
  const text = await readIfExists(deploySecretsRecordFile(deps));
  if (text === undefined) return false;
  try {
    const record = JSON.parse(text) as { host?: unknown; repo?: unknown };
    return record.host === where.host && record.repo === `${where.owner}/${where.repo}`;
  } catch {
    return false;
  }
}

/**
 * Stores the deploy secrets in the repository's GitHub Actions after a `github-secrets` approval
 * that lists their names. Values are sealed locally; only names reach the reporter and audit log.
 */
export async function setDeploySecrets(
  deps: PhaseDeps,
  github: GitHubSetup,
  secrets: Record<string, string>,
  variableNames: readonly string[],
  phase: Extract<PhaseName, "provision" | "dns" | "retarget"> = "provision",
): Promise<void> {
  const names = Object.keys(secrets).sort();
  const repo = `${github.owner}/${github.repo}`;
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Store ${names.length} deploy secrets in GitHub Actions for ${repo}`,
    details: [
      "Secrets (names only; values are encrypted on this computer before upload and never shown):",
      ...names.map((name) => `  ${name}`),
      `The app environment contains: ${variableNames.length > 0 ? variableNames.join(", ") : "no variables"}.`,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "The deploy secrets were not stored, so GitHub Actions cannot deploy yet. The server is running.",
      { hint: "Run `opscrew provision` again when you are ready; it continues from here." },
    );
  }
  const key = await github.api.getActionsPublicKey(github.owner, github.repo);
  for (const name of names) {
    await github.api.setActionsSecret(
      github.owner,
      github.repo,
      name,
      secrets[name] as string,
      key,
    );
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `set secret ${name}`,
      phase,
      target: repo,
      decision: "approved",
    });
  }
  await writeFileAtomic(
    deploySecretsRecordFile(deps),
    `${JSON.stringify({
      host: secrets[DEPLOY_SECRETS.host],
      repo,
      names,
      storedAt: deps.clock.now().toISOString(),
    })}\n`,
  );
  deps.reporter.success(`Stored ${names.length} deploy secrets in GitHub Actions.`);
}
