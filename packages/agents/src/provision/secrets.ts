import { isAbsolute, join } from "node:path";
import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError, readTextIfExists, writeFileAtomic } from "@opscrew/core";
import {
  DEPLOY_SECRETS,
  deploySecretName,
  deploySecretNamesFor,
  githubEnvironment,
  PORTAINER_DEPLOY_SECRETS,
  serviceEnvSecret,
  serviceSpec,
  TUNNEL_DEPLOY_SECRETS,
} from "@opscrew/iac-templates";
import { type DeployPlan, EnvironmentSchema, environmentsOf } from "@opscrew/plan-schema";
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
 * Every GitHub Actions secret provision may have set for the plan's environment, by its name there
 * (`deploySecretName`: `OPSCREW_<ENV>_…` outside prod). On a server: the deploy secrets, one per
 * service with secrets (enabled or not, an earlier run may have set it) and, on a server the user
 * owns, the tunnel's service token. In the user's Portainer: the build values and the webhook's.
 * Destroy deletes them all.
 */
export function deploySecretNames(plan: DeployPlan): string[] {
  const names =
    plan.target.provider === "portainer"
      ? [
          DEPLOY_SECRETS.buildEnv,
          DEPLOY_SECRETS.buildSecrets,
          ...Object.values(PORTAINER_DEPLOY_SECRETS),
        ]
      : [
          ...Object.values(DEPLOY_SECRETS),
          ...servicesWithSecrets(plan).map((service) => serviceEnvSecret(service.name)),
          ...(plan.target.provider === "own" ? Object.values(TUNNEL_DEPLOY_SECRETS) : []),
        ];
  return [...new Set(names.map((name) => deploySecretName(plan, name)))];
}

/** The build values, which the build job reads outside any GitHub environment. */
const BUILD_VALUES: readonly string[] = [DEPLOY_SECRETS.buildEnv, DEPLOY_SECRETS.buildSecrets];

/**
 * The GitHub environment that holds the plan environment's deploy secrets apart from the build
 * values: its own (`githubEnvironment`, prod's `production`) when `environment.secrets` is
 * `environment`; none (repository secrets) otherwise.
 */
export function secretsEnvironment(plan: DeployPlan): string | undefined {
  return plan.environment?.secrets === "environment" ? githubEnvironment(plan) : undefined;
}

/**
 * Where the deploy secrets of the plan's environment live, checked at each of its provisions once
 * the app has more than one environment (a prod-only app keeps its repository secrets and its plan
 * as they are, with no check). After a `github-settings` approval, `environmentCapability` creates
 * (or briefly changes) the environment's GitHub environment, reads it back and leaves it as it was.
 * Where environments work, that GitHub environment is kept (created when missing) and
 * `environment.secrets` becomes `environment`; otherwise `prefixed`. Says which applies, and when it
 * changed, that the deploy secrets move ({@link setDeploySecrets} shows and makes the move).
 * Returns the plan with the answer.
 */
export async function checkSecretsPlacement(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
  run: { command: string; phase: Extract<PhaseName, "provision" | "dns">; planOnly: boolean },
): Promise<DeployPlan> {
  // A named environment is never the only one: prod is always there.
  const several =
    plan.environment?.name !== undefined || (await environmentsOf(deps.paths.root)).length > 1;
  if (!several) return plan;
  const { api, owner, repo } = github;
  const where = `${owner}/${repo}`;
  const name = plan.environment?.name ?? "prod";
  const withSecrets = (secrets: "environment" | "prefixed"): DeployPlan => ({
    ...plan,
    environment: EnvironmentSchema.parse({ ...plan.environment, secrets }),
  });
  const probe = githubEnvironment(withSecrets("environment")) as string;
  const prefixed = deploySecretName(plan, "OPSCREW_…");
  if (run.planOnly) {
    // A plan-only run changes nothing at GitHub and keeps the recorded answer. Without one, the
    // plan stays as it is: a named environment's workflow then reads repository secrets, and
    // prod's reads them as before the check.
    if (plan.environment?.secrets === undefined) {
      deps.reporter.info(
        `A plan-only run changes nothing at GitHub, so it does not check where the deploy secrets of ${name} live: this plan shows them as repository secrets${plan.environment?.name === undefined ? "" : ` named ${prefixed}`}. \`${run.command}\` checks it before it stores them.`,
      );
    }
    return plan;
  }
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title: `Check whether ${where} supports GitHub environments, for the deploy secrets of ${name}`,
    details: [
      `OpsCrew creates the GitHub environment ${probe} (or changes its rules for a moment), reads it back to see what GitHub enforces there, and leaves it as it was.`,
      `Where environments work, ${probe} is kept (created when missing) and holds the deploy secrets of ${name}, apart from the build values, which stay repository secrets. Otherwise all of them are repository secrets named ${prefixed}.`,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `OpsCrew did not check whether ${where} supports GitHub environments, so it does not know where the deploy secrets of ${name} go. Nothing was changed.`,
      { hint: `Run \`${run.command}\` again when you are ready.` },
    );
  }
  const providerCall = (action: string, detail?: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: run.phase,
      target: where,
      decision: "approved",
      ...(detail !== undefined ? { detail } : {}),
    });
  let capability: Awaited<ReturnType<typeof api.environmentCapability>>;
  try {
    capability = await api.environmentCapability(owner, repo, probe);
  } finally {
    // Created or changed for the check, then put back as it was, also when the check failed.
    await providerCall(
      `check environment ${probe}`,
      "created or changed to read back what GitHub enforces, then left as it was",
    );
  }
  const secrets = capability.environments ? "environment" : "prefixed";
  if (secrets === "environment" && (await api.getEnvironment(owner, repo, probe)) === undefined) {
    await api.putEnvironment(owner, repo, probe, {});
    await providerCall(`create environment ${probe}`);
    // Only a GitHub environment OpsCrew created is deleted by destroy.
    const record = await readSecretsRecord(deps);
    await writeFileAtomic(
      deps.paths.files.deploySecrets,
      `${JSON.stringify({
        ...(record?.repo === where ? record : { repo: where, names: [] }),
        createdEnvironment: true,
      })}\n`,
    );
  }
  deps.reporter.info(
    secrets === "environment"
      ? `${where} supports GitHub environments: the deploy secrets of ${name} live in the GitHub environment ${probe}, and its build values are repository secrets.`
      : `${where} does not support GitHub environments (GitHub Free has them only in public repositories), so the deploy secrets of ${name} are repository secrets named ${prefixed}.`,
  );
  const before = plan.environment?.secrets;
  if (before !== undefined && before !== secrets) {
    deps.reporter.warn(
      secrets === "environment"
        ? `The deploy secrets of ${name} move from repository secrets into the GitHub environment ${probe}; the approval of the deploy secrets lists the move.`
        : `The deploy secrets of ${name} move from the GitHub environment ${probe} to repository secrets; the approval of the deploy secrets lists the move.`,
    );
  }
  return withSecrets(secrets);
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
 * this computer, where the plan's environment keeps them now ({@link secretsEnvironment}): after
 * a move between a GitHub environment and repository secrets they count as not stored. The record
 * holds names only, never values.
 */
export async function deploySecretsStoredFor(
  deps: PhaseDeps,
  plan: DeployPlan,
  where: { host: string; owner: string; repo: string },
): Promise<boolean> {
  const text = await readTextIfExists(deps.paths.files.deploySecrets);
  if (text === undefined) return false;
  try {
    const record = JSON.parse(text) as { host?: unknown; repo?: unknown; environment?: unknown };
    return (
      record.host === where.host &&
      record.repo === `${where.owner}/${where.repo}` &&
      record.environment === secretsEnvironment(plan)
    );
  } catch {
    return false;
  }
}

/**
 * Where each of {@link deploySecretNames} lives: in `environment` (the plan environment's GitHub
 * environment, when its secrets live in one), apart from the build values, which are always
 * repository secrets. Sorted by name.
 */
export function deploySecretPlaces(
  plan: DeployPlan,
  environment: string | undefined,
): SecretPlace[] {
  const build = BUILD_VALUES.map((name) => deploySecretName(plan, name));
  return deploySecretNames(plan)
    .sort()
    .map((name) =>
      environment === undefined || build.includes(name) ? { name } : { name, environment },
    );
}

/** A deploy secret by its name in GitHub: in a GitHub environment, or a repository secret. */
export interface SecretPlace {
  name: string;
  environment?: string;
}

/** A secret's name with where it lives, when that is a GitHub environment. */
function placeText(place: SecretPlace): string {
  return place.environment === undefined
    ? place.name
    : `${place.name} (in the GitHub environment ${place.environment})`;
}

/**
 * OpsCrew's record of the deploy secrets it stored last time from this computer (names only):
 * the repository, every secret's name, the GitHub environment that holds them apart from the
 * build values (absent: all are repository secrets), and whether OpsCrew created that GitHub
 * environment (only then does destroy delete it).
 */
const SecretsRecordSchema = z.looseObject({
  repo: z.string(),
  names: z.array(z.string()),
  environment: z.string().optional(),
  createdEnvironment: z.literal(true).optional(),
});

type SecretsRecord = z.infer<typeof SecretsRecordSchema>;

/** The environment's record of its deploy secrets (`deps.paths.files.deploySecrets`), if any. */
export async function readSecretsRecord(
  deps: Pick<PhaseDeps, "paths">,
): Promise<SecretsRecord | undefined> {
  return readValidJson(deps.paths.files.deploySecrets, SecretsRecordSchema);
}

/**
 * What to delete of the secrets OpsCrew stored last time (`previous`, the record for this
 * repository), each where it is. `stale`: the env file secrets of this environment's services that
 * no longer run (`names` no longer holds them; only names of that form, never another secret).
 * `moved`: on a move between a GitHub environment and repository secrets (`environment` is where
 * they go now), the old copies: into a GitHub environment, the repository secrets of the same
 * names (GitHub would read them instead of a missing environment secret, also without a record of
 * this computer's); out of one, every secret the record lists there.
 */
function secretsToDelete(
  plan: DeployPlan,
  previous: SecretsRecord | undefined,
  names: readonly string[],
  environment: string | undefined,
): { stale: SecretPlace[]; moved: SecretPlace[] } {
  const was = previous?.environment;
  const at = (name: string, where: string | undefined): SecretPlace =>
    where === undefined ? { name } : { name, environment: where };
  // `OPSCREW_SERVICE_<NAME>_ENV` (`serviceEnvSecret`), `OPSCREW_<ENV>_SERVICE_<NAME>_ENV` outside prod.
  const service = new RegExp(`^${deploySecretName(plan, "OPSCREW_SERVICE_")}[A-Z0-9_]+_ENV$`);
  const stale = (previous?.names ?? [])
    .filter((name) => service.test(name) && !names.includes(name))
    .sort()
    .map((name) => at(name, was));
  if (environment === was) return { stale, moved: [] };
  if (environment !== undefined) {
    const moved = deploySecretNamesFor(plan)
      .filter((name) => !BUILD_VALUES.includes(name))
      .map((name) => deploySecretName(plan, name))
      .sort()
      .map((name) => at(name, undefined));
    return { stale, moved };
  }
  // Out of a GitHub environment: everything the record lists there goes, the stale ones too.
  const build = BUILD_VALUES.map((name) => deploySecretName(plan, name));
  const moved = (previous?.names ?? [])
    .filter((name) => !build.includes(name))
    .sort()
    .map((name) => at(name, was));
  return { stale: [], moved };
}

/** What the approval says before the names of the secrets stored. */
const SEALED = "(names only; values are encrypted on this computer before upload and never shown)";

/**
 * Stores the deploy secrets of the plan's environment in the repository's GitHub Actions after a
 * `github-secrets` approval that lists their names. `secrets` holds today's names, of which only
 * those the environment's workflow reads (`deploySecretNamesFor`) are stored, each by its name
 * there (`deploySecretName`: `OPSCREW_<ENV>_…` outside prod). With `environment.secrets:
 * environment` they go into the environment's GitHub environment ({@link secretsEnvironment}),
 * apart from the build values, which stay repository secrets. Also deletes, named in the same
 * approval, the env file secrets of services that no longer run and, on a move between a GitHub
 * environment and repository secrets, the old copies ({@link secretsToDelete}). Values are sealed
 * locally; only names reach the reporter and audit log.
 */
export async function setDeploySecrets(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
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
  const { api, owner } = github;
  const repo = `${owner}/${github.repo}`;
  const environment = secretsEnvironment(plan);
  const read = new Set(deploySecretNamesFor(plan));
  const placed = new Map<string, SecretPlace & { value: string }>();
  for (const [name, value] of Object.entries(secrets)) {
    if (!read.has(name)) continue;
    const inEnvironment = environment !== undefined && !BUILD_VALUES.includes(name);
    const stored = deploySecretName(plan, name);
    placed.set(stored, { name: stored, value, ...(inEnvironment ? { environment } : {}) });
  }
  const names = [...placed.keys()].sort();
  const all = names.map((name) => placed.get(name) as SecretPlace & { value: string });
  const inRepository = all.filter((place) => place.environment === undefined);
  const inEnvironment = all.filter((place) => place.environment !== undefined);
  const record = await readSecretsRecord(deps);
  const previous = record?.repo === repo ? record : undefined;
  const { stale, moved } = secretsToDelete(plan, previous, names, environment);
  const list = (places: readonly SecretPlace[]) => places.map((place) => `  ${placeText(place)}`);
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Store ${names.length} deploy secrets in GitHub Actions for ${repo}`,
    details: [
      ...(environment === undefined
        ? [`Secrets ${SEALED}:`, ...names.map((name) => `  ${name}`)]
        : [
            `Secrets in the GitHub environment ${environment} ${SEALED}:`,
            ...inEnvironment.map((place) => `  ${place.name}`),
            ...(inRepository.length > 0
              ? [
                  `Repository secrets, which the build job reads outside any GitHub environment ${SEALED}:`,
                  ...inRepository.map((place) => `  ${place.name}`),
                ]
              : []),
          ]),
      `The app environment contains: ${variableNames.length > 0 ? variableNames.join(", ") : "no variables"}.`,
      ...(stale.length > 0
        ? ["Deleted, since their services no longer run (names only):", ...list(stale)]
        : []),
      ...(moved.length > 0
        ? [
            environment !== undefined
              ? `Deleted from the repository's secrets, since these secrets now live in the GitHub environment ${environment} (names only):`
              : "Deleted from their GitHub environment, since these secrets are now repository secrets (names only):",
            ...list(moved),
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
  const audit = (action: string, place: SecretPlace) =>
    deps.audit.append({
      kind: "secret-set",
      actor: "opscrew",
      action: `${action} secret ${place.name}${place.environment === undefined ? "" : ` in the environment ${place.environment}`}`,
      phase,
      target: repo,
      decision: "approved",
    });
  const repositoryKey =
    inRepository.length > 0 ? await api.getActionsPublicKey(owner, github.repo) : undefined;
  const environmentKey =
    environment !== undefined && inEnvironment.length > 0
      ? await api.environmentPublicKey(owner, github.repo, environment)
      : undefined;
  for (const place of all) {
    if (place.environment === undefined) {
      await api.setActionsSecret(owner, github.repo, place.name, place.value, repositoryKey);
    } else {
      await api.setEnvironmentSecret(
        owner,
        github.repo,
        place.environment,
        place.name,
        place.value,
        environmentKey,
      );
    }
    await audit("set", place);
  }
  for (const place of [...stale, ...moved]) {
    if (place.environment === undefined) {
      await api.deleteActionsSecret(owner, github.repo, place.name);
    } else {
      await api.deleteEnvironmentSecret(owner, github.repo, place.environment, place.name);
    }
    await audit("delete", place);
  }
  await writeFileAtomic(
    deps.paths.files.deploySecrets,
    `${JSON.stringify({
      host: secrets[DEPLOY_SECRETS.host] ?? options.record,
      repo,
      names,
      ...(environment !== undefined ? { environment } : {}),
      ...(previous?.createdEnvironment === true ? { createdEnvironment: true } : {}),
    })}\n`,
  );
  deps.reporter.success(
    environment === undefined
      ? `Stored ${names.length} deploy secrets in GitHub Actions.`
      : `Stored ${names.length} deploy secrets in GitHub Actions, ${inEnvironment.length} of them in the GitHub environment ${environment}.`,
  );
}
