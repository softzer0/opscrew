import { isAbsolute, join } from "node:path";
import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import {
  DEPLOY_SECRETS,
  PORTAINER_DEPLOY_SECRETS,
  serviceEnvSecret,
  serviceSpec,
  TUNNEL_DEPLOY_SECRETS,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import {
  type AppEnvironment,
  assembleAppEnv,
  dotenvLine,
  fixedProductionValue,
  type GeneratedValues,
  hostListKind,
  readValidJson,
  type StorageLogin,
} from "../shared";
import type { GitHubSetup } from "./credentials";
import type { ProvisionServices } from "./types";

/** Private file (0600) beside the deploy key holding generated values between runs. */
export function generatedValuesFile(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.projectHomeDir, "generated_values.json");
}

/**
 * The generated values of earlier runs, with the app's origin TLS values (`originTls`, kept by
 * `./origin-tls`) as they are.
 */
async function readGenerated(
  deps: PhaseDeps,
): Promise<(GeneratedValues & { originTls?: unknown }) | undefined> {
  const text = await readTextIfExists(generatedValuesFile(deps));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as GeneratedValues & { originTls?: unknown };
  } catch {
    return undefined;
  }
}

/**
 * Production environment for the deploy secrets. Interactive runs offer each value from the local
 * `.env` (only after the user confirms it) or let them type it; non-interactive runs read the file
 * named by `OPSCREW_APP_ENV_FILE`. Generated values (database password, app secrets) are kept in
 * a private file so re-running provision never changes the password Postgres was created with.
 * `serverHost` (the address the deploy secrets point to) fills host lists such as
 * `ALLOWED_HOSTS` when the plan has no domain; it is never printed. For the user's Portainer
 * (`options.portainer`) the notes about unset variables say what a stack does with them: they are
 * sent empty, because a stack's variable cannot be left unset. `options.storage` is the key of the
 * plan's provider bucket (`requireStorageKey`, `storageLogin`), which the app receives. Every
 * generated and stored secret is registered with the redactor.
 */
export async function buildAppEnvironment(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: ProvisionServices,
  serverHost?: string,
  options: { portainer?: boolean; storage?: StorageLogin } = {},
): Promise<AppEnvironment> {
  let dotenvText: string | undefined;
  const ask = deps.interactive ? services.askEnv : undefined;
  if (ask) {
    dotenvText = await readTextIfExists(join(deps.paths.root, ".env"));
  } else {
    const file = deps.env.OPSCREW_APP_ENV_FILE?.trim();
    if (file) {
      const path = isAbsolute(file) ? file : join(deps.paths.root, file);
      dotenvText = await readTextIfExists(path);
      if (dotenvText === undefined) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `OPSCREW_APP_ENV_FILE points to ${file}, which does not exist.`,
        );
      }
    }
  }
  const previous = await readGenerated(deps);
  const environment = await assembleAppEnv({
    plan,
    ...(dotenvText !== undefined ? { dotenvText } : {}),
    ...(ask ? { ask } : {}),
    ...(serverHost !== undefined ? { serverHost } : {}),
    ...(previous ? { previous } : {}),
    ...(options.storage !== undefined ? { storage: options.storage } : {}),
  });
  // The origin TLS values stay as provision's Cloudflare step left them.
  const kept = previous?.originTls === undefined ? {} : { originTls: previous.originTls };
  await writeFileAtomic(
    generatedValuesFile(deps),
    `${JSON.stringify({ ...environment.generated, ...kept })}\n`,
  );
  const { app, build, services: secrets } = environment.values;
  for (const [name, value] of Object.entries({ ...app, ...build })) {
    // Host lists hold the domain (or the address), which OpsCrew's own messages show as usual, and
    // a fixed production setting is a plain word (`production`), masked nowhere.
    if (hostListKind(name) === undefined && fixedProductionValue(name) !== value) {
      deps.redactor.addLiteral(value, "app-env");
    }
  }
  // Each service's generated secrets (Postgres's password among them).
  for (const value of Object.values(secrets).flatMap(Object.values)) {
    deps.redactor.addLiteral(value, "app-env");
  }
  if (options.portainer === true) reportUnsetStackVariables(deps, environment);
  else reportUnsetVariables(deps, environment);
  return environment;
}

/**
 * The user's Portainer: which variables are sent empty and why (names only, never values). A
 * stack's variable is never left unset, so the app sees an empty value instead of its default.
 */
function reportUnsetStackVariables(deps: PhaseDeps, environment: AppEnvironment): void {
  const list = (names: string[]) => names.join(", ");
  if (environment.defaulted.length > 0) {
    const one = environment.defaulted.length === 1;
    deps.reporter.info(
      `${list(environment.defaulted)} ${one ? "has" : "have"} no production value, so the app's stack gets ${one ? "it" : "them"} as an empty value (a Portainer stack cannot leave a variable unset); give ${one ? "it a value" : "them values"} if the app's default needs ${one ? "it" : "them"} to be missing.`,
    );
  }
  if (environment.unresolved.length > 0) {
    deps.reporter.warn(
      `${list(environment.unresolved)} must list the app's address, but opscrew/plan.yaml has no domain, so the app's stack gets them empty. Give the app a domain with \`opscrew dns --domain <hostname>\`, then run \`opscrew provision\` again.`,
    );
  }
}

/** Says which variables were left unset and why (names only, never values). */
function reportUnsetVariables(deps: PhaseDeps, environment: AppEnvironment): void {
  const list = (names: string[]) => names.join(", ");
  if (environment.defaulted.length > 0) {
    const [one] = environment.defaulted;
    deps.reporter.info(
      environment.defaulted.length === 1
        ? `${one} has no production value, so the app uses the default in its code.`
        : `${list(environment.defaulted)} have no production values, so the app uses the defaults in its code.`,
    );
  }
  if (environment.unresolved.length > 0) {
    deps.reporter.warn(
      `${list(environment.unresolved)} must list the app's address, but the plan has no domain and the server's address is not known yet, so they are left unset for now. Run \`opscrew provision\` again once the server exists; it fills them in.`,
    );
  }
}

/** The plan's services with secrets: each reads `<name>.env` on a server. */
function servicesWithSecrets(plan: DeployPlan): DeployPlan["services"] {
  return plan.services.filter((service) => serviceSpec(service.kind).secrets.length > 0);
}

/**
 * `<name>.env` of every running service with secrets, by its GitHub secret
 * (`serviceEnvSecret(name)`): the catalog's `environment(ctx)` with the real values, as the
 * deploy writes it next to compose.yaml (`db.env` for Postgres).
 */
export function serviceEnvSecrets(
  plan: DeployPlan,
  environment: Pick<AppEnvironment, "values">,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const service of servicesWithSecrets(plan).filter((s) => s.enabled)) {
    const values = environment.values.services[service.name] ?? {};
    const env = serviceSpec(service.kind).environment({
      plan,
      service,
      secretRef: (name) => {
        const value = values[name];
        if (value === undefined) throw new Error(`${service.name} has no secret ${name}.`);
        return value;
      },
    });
    const lines = Object.entries(env).map(([name, value]) => dotenvLine(name, value));
    secrets[serviceEnvSecret(service.name)] = `${lines.join("\n")}\n`;
  }
  return secrets;
}

/**
 * Every GitHub Actions secret provision may have set for the plan on a server: the deploy
 * secrets, and one per service with secrets (enabled or not, an earlier run may have set it).
 * Destroy deletes them all.
 */
export function deploySecretNames(plan: DeployPlan): string[] {
  return [
    ...new Set([
      ...Object.values(DEPLOY_SECRETS),
      ...servicesWithSecrets(plan).map((service) => serviceEnvSecret(service.name)),
    ]),
  ];
}

/**
 * The GitHub Actions secrets the deploy workflow reads, with one per service with secrets
 * ({@link serviceEnvSecrets}). In tunnel mode (a server the user owns without a public address)
 * `tunnel` adds the Cloudflare Access service token the workflow reaches SSH through; `host` is
 * then the tunnel's SSH hostname and `knownHosts` holds the server's host key under that name.
 * With origin TLS, `originTls` is the origin certificate's PEM, then its key's
 * (`OPSCREW_ORIGIN_TLS`).
 */
export function deploySecrets(input: {
  plan: DeployPlan;
  host: string;
  privateKey: string;
  knownHosts: string;
  environment: AppEnvironment;
  tunnel?: { serviceTokenId: string; serviceTokenSecret: string };
  originTls?: string;
}): Record<string, string> {
  return {
    [DEPLOY_SECRETS.host]: input.host,
    [DEPLOY_SECRETS.sshKey]: input.privateKey,
    [DEPLOY_SECRETS.knownHosts]: input.knownHosts,
    [DEPLOY_SECRETS.appEnv]: input.environment.appEnv,
    ...serviceEnvSecrets(input.plan, input.environment),
    [DEPLOY_SECRETS.buildEnv]: input.environment.buildEnv,
    [DEPLOY_SECRETS.buildSecrets]: input.environment.buildSecrets,
    ...(input.tunnel !== undefined
      ? {
          [TUNNEL_DEPLOY_SECRETS.serviceTokenId]: input.tunnel.serviceTokenId,
          [TUNNEL_DEPLOY_SECRETS.serviceTokenSecret]: input.tunnel.serviceTokenSecret,
        }
      : {}),
    ...(input.originTls !== undefined ? { [DEPLOY_SECRETS.originTls]: input.originTls } : {}),
  };
}

/**
 * The GitHub Actions secrets of the deploy workflow for the user's Portainer: the build's
 * client-side values (`OPSCREW_BUILD_ENV`, and `OPSCREW_BUILD_SECRETS` for the secret ones) and,
 * in redeploy mode `cloudflare`, Portainer's webhook URL behind Cloudflare Access with the Access
 * service token. The app's own values are not among them: they live only in the stack's
 * environment in Portainer.
 */
export function portainerDeploySecrets(input: {
  environment: AppEnvironment;
  webhook?: { url: string; accessClientId: string; accessClientSecret: string };
}): Record<string, string> {
  return {
    [DEPLOY_SECRETS.buildEnv]: input.environment.buildEnv,
    [DEPLOY_SECRETS.buildSecrets]: input.environment.buildSecrets,
    ...(input.webhook !== undefined
      ? {
          [PORTAINER_DEPLOY_SECRETS.webhookUrl]: input.webhook.url,
          [PORTAINER_DEPLOY_SECRETS.accessClientId]: input.webhook.accessClientId,
          [PORTAINER_DEPLOY_SECRETS.accessClientSecret]: input.webhook.accessClientSecret,
        }
      : {}),
  };
}

/**
 * What the deploy secrets' record names instead of a server's address for the user's Portainer
 * (whose address is never written outside `.opscrew/server.json`).
 */
export const PORTAINER_SECRETS_RECORD = "portainer";

/**
 * True when OpsCrew stored the deploy secrets for this server (`host`) in this repository from
 * this computer. The record holds names only, never values.
 */
export async function deploySecretsStoredFor(
  deps: PhaseDeps,
  where: { host: string; owner: string; repo: string },
): Promise<boolean> {
  const text = await readTextIfExists(deps.paths.files.deploySecrets);
  if (text === undefined) return false;
  try {
    const record = JSON.parse(text) as { host?: unknown; repo?: unknown };
    return record.host === where.host && record.repo === `${where.owner}/${where.repo}`;
  } catch {
    return false;
  }
}

/** A service's env file secret: `OPSCREW_SERVICE_<NAME>_ENV` (`serviceEnvSecret`). */
const SERVICE_SECRET = /^OPSCREW_SERVICE_[A-Z0-9_]+_ENV$/;

/**
 * The service env file secrets OpsCrew stored last time for `repo` (its record of the deploy
 * secrets) that `names` no longer holds: their services are turned off or removed. Only names of
 * that form, never another secret.
 */
async function staleServiceSecrets(
  deps: PhaseDeps,
  repo: string,
  names: readonly string[],
): Promise<string[]> {
  const record = await readValidJson(
    deps.paths.files.deploySecrets,
    z.looseObject({ repo: z.string(), names: z.array(z.string()) }),
  );
  if (record === undefined || record.repo !== repo) return [];
  return record.names.filter((name) => SERVICE_SECRET.test(name) && !names.includes(name)).sort();
}

/**
 * Stores the deploy secrets in the repository's GitHub Actions after a `github-secrets` approval
 * that lists their names, and deletes the env file secrets of services that no longer run
 * ({@link staleServiceSecrets}, named in the same approval). Values are sealed locally; only
 * names reach the reporter and audit log.
 */
export async function setDeploySecrets(
  deps: PhaseDeps,
  github: GitHubSetup,
  secrets: Record<string, string>,
  variableNames: readonly string[],
  phase: Extract<PhaseName, "provision" | "dns" | "retarget"> = "provision",
  options: {
    /**
     * What the record names as the deploy target when the secrets hold no `OPSCREW_HOST` (the
     * user's Portainer: {@link PORTAINER_SECRETS_RECORD}).
     */
    record?: string;
    /** The text after "the app is not deployed yet" when the user refuses (default: the server's). */
    refusedState?: string;
  } = {},
): Promise<void> {
  const names = Object.keys(secrets).sort();
  const repo = `${github.owner}/${github.repo}`;
  const stale = await staleServiceSecrets(deps, repo, names);
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Store ${names.length} deploy secrets in GitHub Actions for ${repo}`,
    details: [
      "Secrets (names only; values are encrypted on this computer before upload and never shown):",
      ...names.map((name) => `  ${name}`),
      `The app environment contains: ${variableNames.length > 0 ? variableNames.join(", ") : "no variables"}.`,
      ...(stale.length > 0
        ? [
            "Deleted, since their services no longer run (names only):",
            ...stale.map((name) => `  ${name}`),
          ]
        : []),
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The deploy secrets were not stored, so GitHub Actions cannot deploy yet. ${options.refusedState ?? "The server is running."}`,
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
  for (const name of stale) {
    await github.api.deleteActionsSecret(github.owner, github.repo, name);
    await deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `delete secret ${name}`,
      phase,
      target: repo,
      decision: "approved",
    });
  }
  await writeFileAtomic(
    deps.paths.files.deploySecrets,
    `${JSON.stringify({
      host: secrets[DEPLOY_SECRETS.host] ?? options.record,
      repo,
      names,
      storedAt: deps.clock.now().toISOString(),
    })}\n`,
  );
  deps.reporter.success(`Stored ${names.length} deploy secrets in GitHub Actions.`);
}
