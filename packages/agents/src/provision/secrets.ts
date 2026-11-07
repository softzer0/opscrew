import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type {
  BranchPolicy,
  EnvironmentCapability,
  EnvironmentReviewer,
  EnvironmentView,
} from "@opscrew/connector-github";
import type { PhaseName } from "@opscrew/contracts";
import {
  errorText,
  listText,
  OpsCrewError,
  readTextIfExists,
  writeFileAtomic,
} from "@opscrew/core";
import {
  CHECK_SECRETS,
  DEPLOY_SECRETS,
  deploySecretName,
  deploySecretNamesFor,
  githubEnvironment,
  grantHashSecret,
  OFFSITE_ENV_SECRET,
  PORTAINER_DEPLOY_SECRETS,
  serverDeploySecrets,
  serviceEnvSecret,
  serviceSpec,
  siteEnvSecret,
  TUNNEL_DEPLOY_SECRETS,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  EnvironmentSchema,
  environmentsOf,
  isServerlessProvider,
  snapshotOffsiteOf,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { environmentText } from "../apps/names";
import { otherPlans } from "../check/files";
import type { PhaseDeps } from "../context";
import { workflowBranch } from "../environments/branches";
import { commandFlags } from "../environments/choice";
import {
  type AppEnvironment,
  assembleAppEnv,
  dotenvLine,
  type GeneratedValues,
  hasDeployment,
  randomPassword,
  readValidJson,
  type StorageLogin,
} from "../shared";
import {
  changeGenerated,
  GeneratedValuesSchema,
  generatedValuesFile,
  MonitoringValuesSchema,
  registerAppSecrets,
} from "../shared/app-secrets";
import { codeOf, hintOf } from "../shared/errors";
import type { GitHubSetup } from "./credentials";
import type { ProvisionServices } from "./types";

/**
 * What the generated values hold besides the app's environment, which provision's rewrite keeps as
 * it is: the origin TLS values (`./origin-tls`), the private network's keys, the device logins'
 * passwords and the self-hosted monitoring's values.
 */
const KEPT_VALUES = ["originTls", "network", "grants", "monitoring"] as const;

/** The self-hosted monitoring's values this computer keeps for an environment. */
export type MonitoringValues = z.infer<typeof MonitoringValuesSchema>;

/**
 * The generated values of earlier runs as an object, every value as it is (`{}` without the file);
 * `undefined` when the file is damaged.
 */
async function readGenerated(
  deps: Pick<PhaseDeps, "paths">,
): Promise<Record<string, unknown> | undefined> {
  const text = await readTextIfExists(generatedValuesFile(deps));
  if (text === undefined) return {};
  try {
    return z.looseObject({}).parse(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * The self-hosted monitoring's values kept with the generated values of `deps.paths` (another
 * environment's too, with its paths), each password registered with the redactor; `undefined` when
 * there are none, or the file or its values are damaged (writing them then stops).
 */
export async function monitoringValues(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<MonitoringValues | undefined> {
  const values = MonitoringValuesSchema.safeParse((await readGenerated(deps))?.monitoring).data;
  for (const password of [values?.grafanaAdminPassword, values?.postgresPassword]) {
    if (password !== undefined) deps.redactor.addLiteral(password, "monitoring-password");
  }
  return values;
}

/**
 * Changes the self-hosted monitoring's values (`change` gets the current ones, `{}` for none) and
 * keeps every other generated value (0600); `undefined` removes them.
 * @throws OpsCrewError `ARTIFACT_INVALID` when the file is damaged ({@link changeGenerated}).
 */
export async function keepMonitoringValues(
  deps: Pick<PhaseDeps, "paths">,
  change: (current: MonitoringValues) => MonitoringValues | undefined,
): Promise<void> {
  await changeGenerated(deps, ({ monitoring, ...rest }) => {
    const next = change(monitoring ?? {});
    return next === undefined || Object.keys(next).length === 0
      ? rest
      : { ...rest, monitoring: next };
  });
}

/**
 * The monitoring password `name` of this environment, generated the first time (32 letters and
 * digits) and kept with the generated values, which the recovery copy holds; registered with the
 * redactor.
 */
export async function monitoringPassword(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  name: "grafanaAdminPassword" | "postgresPassword",
): Promise<string> {
  let password = (await monitoringValues(deps))?.[name];
  if (password === undefined) {
    const made = randomPassword(32);
    await keepMonitoringValues(deps, (current) => ({ ...current, [name]: made }));
    password = made;
  }
  deps.redactor.addLiteral(password, "monitoring-password");
  return password;
}

/**
 * Production environment for the deploy secrets. Interactive runs offer each value from the
 * environment's own local file (only after the user confirms it), `.env` for prod and
 * `.env.<env>` for another environment (FR-1538: never prod's), or let them type it;
 * non-interactive runs read the file named by `OPSCREW_APP_ENV_FILE`. Generated values (database
 * password, app secrets) are kept in a private file so re-running provision never changes the
 * password Postgres was created with.
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
  // Each environment's own values: prod's `.env` never reaches another environment.
  const name = deps.paths.environment;
  const file = name === "prod" ? ".env" : `.env.${name}`;
  if (ask) {
    dotenvText = await readTextIfExists(join(deps.paths.root, file));
    if (dotenvText === undefined && name !== "prod") {
      deps.reporter.info(
        `There is no ${file}, so OpsCrew offers none of your own values for the ${name} environment and asks for each one. It never offers prod's .env there; put the ${name} environment's values in ${file} to have them offered.`,
      );
    }
  } else {
    const named = deps.env.OPSCREW_APP_ENV_FILE?.trim();
    if (named) {
      const path = isAbsolute(named) ? named : join(deps.paths.root, named);
      dotenvText = await readTextIfExists(path);
      if (dotenvText === undefined) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `OPSCREW_APP_ENV_FILE points to ${named}, which does not exist.`,
        );
      }
    }
  }
  const previous = (await readGenerated(deps)) as
    | (GeneratedValues & Partial<Record<(typeof KEPT_VALUES)[number], unknown>>)
    | undefined;
  const environment = await assembleAppEnv({
    plan,
    ...(dotenvText !== undefined ? { dotenvText } : {}),
    ...(ask ? { ask, local: { environment: name, file } } : {}),
    ...(serverHost !== undefined ? { serverHost } : {}),
    ...(previous ? { previous } : {}),
    ...(options.storage !== undefined ? { storage: options.storage } : {}),
  });
  // The origin TLS values stay as provision's Cloudflare step left them, and the network's keys
  // and the device logins' passwords as design and `vpn` made them.
  const kept = Object.fromEntries(
    KEPT_VALUES.flatMap((name) => (previous?.[name] === undefined ? [] : [[name, previous[name]]])),
  );
  // A device's login declares only its password's SHA-256 (lower-case hex) in the service's
  // OPSCREW_ACL_USERS, by the secret `grantHashSecret(device)`, never the password.
  const passwords = GeneratedValuesSchema.shape.grants.safeParse(previous?.grants).data ?? {};
  for (const grant of plan.network?.grants ?? []) {
    const password = passwords[`${grant.device}/${grant.service}`];
    if (password === undefined) continue;
    environment.values.services[grant.service] = {
      ...environment.values.services[grant.service],
      [grantHashSecret(grant.device)]: createHash("sha256").update(password).digest("hex"),
    };
  }
  await writeFileAtomic(
    generatedValuesFile(deps),
    `${JSON.stringify({ ...environment.generated, ...kept })}\n`,
  );
  await registerAppSecrets(deps, plan, environment);
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

/**
 * `<name>.env` of every running service, by its GitHub secret
 * (`serviceEnvSecret(name)`): the catalog's `environment(ctx)` with the real values, as the
 * deploy writes it next to compose.yaml (`db.env` for Postgres).
 */
export function serviceEnvSecrets(
  plan: DeployPlan,
  environment: Pick<AppEnvironment, "values">,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(serviceEnvFiles(plan, environment)).map(([name, text]) => [
      serviceEnvSecret(name),
      text,
    ]),
  );
}

/**
 * `<name>.env` of every running service, by the service's name: the catalog's `environment(ctx)`
 * with `environment`'s values (a preview environment's placeholders for its env templates).
 */
export function serviceEnvFiles(
  plan: DeployPlan,
  environment: Pick<AppEnvironment, "values">,
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const service of plan.services.filter((s) => s.enabled)) {
    const values = environment.values.services[service.name] ?? {};
    const env = serviceSpec(service.kind).environment({
      plan,
      service,
      secretRef: (name) => {
        const value = values[name];
        if (value !== undefined) return value;
        const grant = plan.network?.grants.find(
          (g) => g.service === service.name && grantHashSecret(g.device) === name,
        );
        if (grant !== undefined) {
          throw new OpsCrewError(
            "PHASE_PRECONDITION",
            `Device ${grant.device}'s login to ${service.name} needs its password, and this computer does not have it, so OpsCrew can't store ${service.name}'s settings.`,
            {
              hint: `Put OpsCrew's generated values back from your recovery copy (\`opscrew secrets restore\`) or from the computer that ran \`opscrew vpn grant\`, or run \`opscrew vpn revoke ${grant.device} ${service.name}\` and grant it again.`,
            },
          );
        }
        throw new Error(`${service.name} has no secret ${name}.`);
      },
    });
    const lines = Object.entries(env).map(([name, value]) => dotenvLine(name, value));
    files[service.name] = `${lines.join("\n")}\n`;
  }
  return files;
}

/**
 * Every GitHub Actions secret provision may have set for the plan's environment, by its name there
 * (`deploySecretName`: `OPSCREW_<ENV>_…` outside prod). On a server: the deploy secrets, one per
 * service (enabled or not, an earlier run may have set it), the off-server copy's env file
 * (`OFFSITE_ENV_SECRET`) while `snapshots.offsite` is on (turning it off deletes it as stale),
 * each extra server's
 * address and known hosts and, on a server the user owns, the tunnel's service token. In the user's
 * Portainer: the build values and the webhook's.
 * On a server-less target: those its workflow reads (`deploySecretNamesFor`: on Cloudflare the
 * deploy token and the account id, and the app's values). Destroy deletes them all.
 */
export function deploySecretNames(plan: DeployPlan): string[] {
  const names = isServerlessProvider(plan.target.provider)
    ? deploySecretNamesFor(plan)
    : plan.target.provider === "portainer"
      ? [
          DEPLOY_SECRETS.buildEnv,
          DEPLOY_SECRETS.buildSecrets,
          ...Object.values(PORTAINER_DEPLOY_SECRETS),
        ]
      : [
          ...Object.values(DEPLOY_SECRETS),
          ...plan.services.map((service) => serviceEnvSecret(service.name)),
          ...(snapshotOffsiteOf(plan) !== undefined ? [OFFSITE_ENV_SECRET] : []),
          ...(plan.servers ?? []).flatMap((server) =>
            Object.values(serverDeploySecrets(server.name)),
          ),
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
 * the app has more than one environment or any app of the repository has a preview environment,
 * whose pull requests' workflows could read repository secrets (a prod-only app of a repository
 * without previews keeps its repository secrets and its plan as they are, with no check). After a
 * `github-settings` approval, `environmentCapability` creates
 * a throwaway GitHub environment (`opscrew-probe-<8 random hex>`) with test rules, reads it back
 * and deletes it; no existing environment is changed. Where environments work, the environment's
 * own GitHub environment holds its deploy secrets (created when missing; one the user or GitHub
 * made gets only OpsCrew's secrets, never its rules) and `environment.secrets` becomes
 * `environment`; otherwise `prefixed`. Says which applies, and when it
 * changed, that the deploy secrets move ({@link setDeploySecrets} shows and makes the move). A
 * GitHub environment OpsCrew created then gets the rules GitHub enforces ({@link
 * setEnvironmentRules}); where GitHub enforces no required reviewers, says once what OpsCrew's own
 * approval guards against. Returns the plan with the answer.
 */
export async function checkSecretsPlacement(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
  run: { command: string; phase: Extract<PhaseName, "provision" | "dns">; planOnly: boolean },
): Promise<DeployPlan> {
  return (await placeDeploySecrets(deps, github, plan, run)).plan;
}

/**
 * {@link checkSecretsPlacement}, with whether GitHub enforces branch rules on the repository's
 * environments (`branchRules`; absent when nothing was checked). A preview environment (ADR 0026)
 * is refused right after the check, before any change, while GitHub enforces them and a pull
 * request could read another environment's deploy secrets ({@link requireOtherSecretsApart}); its
 * own GitHub environment gets no branch rule (each pull request deploys there) and no reviewer.
 * `readable` names the sites' secrets pull requests can read anyway, for the host plan's text.
 */
export async function placeDeploySecrets(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
  run: { command: string; phase: Extract<PhaseName, "provision" | "dns">; planOnly: boolean },
): Promise<{ plan: DeployPlan; branchRules?: boolean; readable?: string[] }> {
  // A named environment is never the only one: prod is always there.
  const several =
    plan.environment?.name !== undefined ||
    (await environmentsOf(deps.paths.root, deps.paths.app)).length > 1 ||
    (await otherPlans(deps.paths, plan)).some((o) => o.plan.environment?.previews !== undefined);
  if (!several) return { plan };
  const { api, owner, repo } = github;
  const where = `${owner}/${repo}`;
  const name = plan.environment?.name ?? "prod";
  const withSecrets = (secrets: "environment" | "prefixed"): DeployPlan => ({
    ...plan,
    environment: EnvironmentSchema.parse({ ...plan.environment, secrets }),
  });
  const githubEnv = githubEnvironment(withSecrets("environment")) as string;
  // A fresh name, so the check never changes an environment that exists (the user's, or GitHub's).
  const probe = `opscrew-probe-${randomBytes(4).toString("hex")}`;
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
    return { plan };
  }
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title: `Check whether ${where} supports GitHub environments, for the deploy secrets of ${name}`,
    details: [
      `OpsCrew creates the throwaway GitHub environment ${probe}, tries a branch rule on it and then a required reviewer and a wait timer, reads it back to see what GitHub enforces there, and removes it again. It changes no other environment.`,
      `Where environments work, ${githubEnv} is kept (created when missing) and holds the deploy secrets of ${name}, apart from the build values, which stay repository secrets. Otherwise all of them are repository secrets named ${prefixed}.`,
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
    capability = await api.environmentCapability(owner, repo, probe, github.defaultBranch);
  } finally {
    // Created for the check, then deleted, also when the check failed.
    await providerCall(
      `check environment ${probe}`,
      "created with test rules to read back what GitHub enforces, then deleted",
    );
  }
  const previews = plan.environment?.previews !== undefined;
  const readable =
    previews && capability.branchPolicies
      ? await requireOtherSecretsApart(deps, github, plan, run.command)
      : [];
  const secrets = capability.environments ? "environment" : "prefixed";
  let kept: { view: EnvironmentView; created: boolean; declined: boolean } | undefined;
  if (secrets === "environment") {
    const record = await readSecretsRecord(deps);
    const ours = record?.repo === where ? record : undefined;
    const view = await api.getEnvironment(owner, repo, githubEnv);
    if (view === undefined) {
      kept = {
        view: await api.putEnvironment(owner, repo, githubEnv, {}),
        created: true,
        declined: false,
      };
      await providerCall(`create environment ${githubEnv}`);
      // Only a GitHub environment OpsCrew created is deleted by destroy, or gets its rules.
      await addToSecretsRecord(deps, where, { createdEnvironment: true });
    } else {
      kept = {
        view,
        created: ours?.createdEnvironment === true,
        declined: ours?.reviewersDeclined === true,
      };
    }
  }
  deps.reporter.info(
    secrets === "environment"
      ? `${where} supports GitHub environments: the deploy secrets of ${name} live in the GitHub environment ${githubEnv}, and its build values are repository secrets.`
      : `${where} does not support GitHub environments (GitHub Free has them only in public repositories), so the deploy secrets of ${name} are repository secrets named ${prefixed}.`,
  );
  // A preview environment's GitHub environment serves every pull request: no branch rule.
  if (kept !== undefined && !previews) {
    await setEnvironmentRules(deps, github, plan, {
      ...kept,
      capability,
      command: run.command,
      audit: providerCall,
    });
  }
  if (!capability.reviewers && !previews) {
    deps.reporter.info(
      `GitHub enforces no required reviewers in ${where} (a private repository has them only on GitHub Enterprise), so OpsCrew's approval guards against mistakes, not against someone with write access to the repository: they can start the deploy workflow of ${name} themselves.`,
    );
  }
  const before = plan.environment?.secrets;
  if (before !== undefined && before !== secrets) {
    deps.reporter.warn(
      secrets === "environment"
        ? `The deploy secrets of ${name} move from repository secrets into the GitHub environment ${githubEnv}; the approval of the deploy secrets lists the move.`
        : `The deploy secrets of ${name} move from the GitHub environment ${githubEnv} to repository secrets; the approval of the deploy secrets lists the move.`,
    );
  }
  return { plan: withSecrets(secrets), branchRules: capability.branchPolicies, readable };
}

/**
 * Refuses the preview environment of `plan` (FR-2209, ADR 0026 D4) while a pull request's workflow
 * could read the deploy secrets of another environment, of any app of the repository, that was set
 * up (`hasDeployment`): they are repository secrets (provisioning that environment again moves
 * them into a GitHub environment only its branch can use), or its GitHub environment lets every
 * branch deploy (its deployment branch policy, read from GitHub). Called where GitHub enforces
 * branch rules on environments; stops before any change. Another preview environment is left out:
 * its key is meant for pull requests and runs only its preview command. A site's secrets are
 * repository secrets OpsCrew never moves, so they stop nothing: a GitHub Pages site without any is
 * left out, and the others are returned as lines for the previews host plan's text.
 */
async function requireOtherSecretsApart(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
  command: string,
): Promise<string[]> {
  const { root, app, environment } = deps.paths;
  const { api, owner, repo } = github;
  const where = `${owner}/${repo}`;
  /** Each environment that could leak, named and with the command that provisions it. */
  const repository: { text: string; run: string }[] = [];
  /** `userRules`: it has a rule of the user's, so provision leaves its rules alone. */
  const open: { text: string; run: string; githubEnv: string; userRules: boolean }[] = [];
  const readable: string[] = [];
  const anyWorkflow = "any workflow, a pull request's included, can read";
  for (const other of await otherPlans(deps.paths, plan)) {
    if (!hasDeployment(other.plan) || other.plan.environment?.previews !== undefined) continue;
    const at = { app: other.paths.app, environment: other.paths.environment };
    const named = {
      text: at.app === app ? at.environment : environmentText(at),
      run: `\`opscrew provision${await commandFlags(root, at.environment, at.app)}\``,
    };
    const provider = other.plan.target.provider;
    if (provider === "cloudflare-workers") {
      readable.push(
        `The Cloudflare token of ${named.text} is a repository secret: ${anyWorkflow} it.`,
      );
      continue;
    }
    if (provider === "github-pages") {
      if (deploySecretNamesFor(other.plan).length > 0) {
        readable.push(
          `The site values of ${named.text} are repository secrets: ${anyWorkflow} them.`,
        );
      }
      continue;
    }
    if (other.plan.environment?.secrets !== "environment") {
      repository.push(named);
      continue;
    }
    const githubEnv = githubEnvironment(other.plan) as string;
    const view = await api.getEnvironment(owner, repo, githubEnv);
    if (view !== undefined && view.branchPolicy === null) {
      const userRules = view.reviewers.length > 0 || view.waitTimer > 0;
      open.push({ ...named, githubEnv, userRules });
    }
  }
  const again = `${command}${await commandFlags(root, environment, app)}`;
  const one = (list: readonly unknown[]) => list.length === 1;
  if (repository.length > 0) {
    const its = one(repository) ? "its" : "their";
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A pull request could read the deploy key of ${listText(repository.map((e) => e.text))}: ${its} deploy secrets are repository secrets, which every workflow in ${where} can read, a pull request's included. Nothing was changed.`,
      {
        hint: `Run ${listText(repository.map((e) => e.run))} first, which ${one(repository) ? "moves" : "move"} ${its} secrets into a GitHub environment only ${its} branch can use, then run \`${again}\` again.`,
      },
    );
  }
  if (open.length > 0) {
    const its = one(open) ? "its" : "their";
    const githubEnvs = listText(open.map((e) => e.githubEnv));
    const settings = `https://github.com/${where}/settings/environments`;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A pull request could read the deploy key of ${listText(open.map((e) => e.text))}: ${one(open) ? "the GitHub environment" : "the GitHub environments"} ${githubEnvs} that ${one(open) ? "holds" : "hold"} ${its} deploy secrets ${one(open) ? "lets" : "let"} every branch deploy, a pull request's included. Nothing was changed.`,
      {
        // Provision adds the branch rule only where the user set no rule.
        hint: open.some((e) => e.userRules)
          ? `Let only ${its} branch deploy to ${githubEnvs} in ${settings} (OpsCrew changes no rule of an environment that has rules of yours); then run \`${again}\` again.`
          : `Run ${listText(open.map((e) => e.run))} again and accept ${its} branch rule, or let only ${its} branch deploy to ${githubEnvs} in ${settings}; then run \`${again}\` again.`,
      },
    );
  }
  return readable;
}

/** Custom branch policies: only the branches added with `addDeploymentBranch` may deploy. */
const CUSTOM_BRANCHES: BranchPolicy = { protectedBranches: false, customBranchPolicies: true };

/**
 * The rules of the GitHub environment `view` that holds the deploy secrets of the plan's
 * environment, where GitHub enforces them (FR-1521), after a `github-settings` approval naming
 * each change. Only in an environment OpsCrew created (`created`), or one it did not create that has
 * no rule at all (GitHub creates `production` itself at prod's first deploy), which gets only the
 * branch rule and is not recorded as created. One with any rule of the user's is left as it is, and
 * the user is told so.
 * - The branch rule (`capability.branchPolicies`): only the branch its workflow runs on may deploy
 *   (`workflowBranch`: the branch it follows, or the default branch for a promoted environment),
 *   as custom branch policies with that branch, where the environment still lets every branch
 *   deploy, or none (custom branch policies without a branch, left by a failed earlier run).
 * - A required reviewer (`capability.reviewers`), for an environment promoted to that has none:
 *   offered only in an interactive run, the repository's owner when it is a user. Otherwise
 *   none is added, and the setting to add one is shown. Once declined (`declined`, the record's
 *   `reviewersDeclined`), it is not offered again.
 * A refusal leaves the rules as they are, and provisioning goes on.
 */
async function setEnvironmentRules(
  deps: PhaseDeps,
  github: GitHubSetup,
  plan: DeployPlan,
  input: {
    view: EnvironmentView;
    created: boolean;
    declined: boolean;
    capability: EnvironmentCapability;
    command: string;
    audit: (action: string, detail?: string) => Promise<unknown>;
  },
): Promise<void> {
  const { api, owner, repo, defaultBranch } = github;
  const { view, capability, command } = input;
  if (!capability.reviewers && !capability.branchPolicies) return;
  const where = `${owner}/${repo}`;
  const env = view.name;
  const name = plan.environment?.name ?? "prod";
  const settings = `https://github.com/${where}/settings/environments`;
  const promoted = plan.environment?.deploySource?.from === "promote";
  // The branch whose runs deploy.
  const branch = workflowBranch(plan, defaultBranch);
  // Every branch may deploy, no required reviewer, no wait timer: nothing of the user's to change.
  const ruleless =
    view.branchPolicy === null && view.reviewers.length === 0 && view.waitTimer === 0;
  if (!input.created && !ruleless) {
    deps.reporter.info(
      `OpsCrew did not create the GitHub environment ${env}, so it changes none of its rules. To let only ${branch} deploy to it, or to have each deploy wait for a reviewer, set its rules yourself in ${settings}.`,
    );
    return;
  }
  // Every branch may deploy, or custom branch policies without a branch (none may).
  const branchRule =
    capability.branchPolicies &&
    (view.branchPolicy === null ||
      (view.branchPolicy.customBranchPolicies &&
        (await api.listDeploymentBranches(owner, repo, env)).length === 0));
  let reviewer: EnvironmentReviewer | undefined;
  if (
    capability.reviewers &&
    input.created &&
    promoted &&
    view.reviewers.length === 0 &&
    !input.declined
  ) {
    const account = deps.interactive ? await api.account(owner) : undefined;
    if (account?.type === "User") {
      reviewer = { type: "User", id: account.id };
    } else {
      const why = deps.interactive
        ? `${owner} is an organization, so OpsCrew has no reviewer to offer`
        : `This run is not interactive, so OpsCrew adds no required reviewer`;
      deps.reporter.info(
        `${why} for ${name}, which is deployed by promotion. To have each deploy to ${name} wait in GitHub for a reviewer's approval, add required reviewers to the GitHub environment ${env} in ${settings}.`,
      );
    }
  }
  if (reviewer === undefined && !branchRule) return;
  const changes = [
    ...(reviewer !== undefined
      ? [
          `Required reviewer: ${owner}, the repository's owner. Each deploy to ${name} waits in GitHub until they approve it.`,
        ]
      : []),
    ...(branchRule
      ? [
          `Deployment branches: only ${branch}, ${branch === defaultBranch ? "the default branch" : `the branch ${name} follows`}. A workflow run on any other branch cannot deploy to ${env} or read its secrets.`,
        ]
      : []),
  ];
  const approval = await deps.approvals.request({
    kind: "github-settings",
    title: `Set the rules of the GitHub environment ${env} in ${where}`,
    details: [
      `${input.created ? `OpsCrew created ${env}` : `${env} has no rules yet, so OpsCrew uses it`} for the deploy secrets of ${name}, and changes only these of its rules:`,
      ...changes.map((change) => `  ${change}`),
    ].join("\n"),
  });
  if (!approval.approved) {
    if (reviewer === undefined) {
      deps.reporter.info(
        `OpsCrew left the rules of the GitHub environment ${env} as they are. Set them in ${settings}, or run \`${command}\` again to be offered them again.`,
      );
      return;
    }
    // A declined reviewer is not offered again.
    await addToSecretsRecord(deps, where, { reviewersDeclined: true });
    deps.reporter.info(
      `OpsCrew left the rules of the GitHub environment ${env} as they are, and does not offer a reviewer for ${name} again. To add one later, add required reviewers to ${env} in ${settings}.${branchRule ? ` The branch rule is offered again at the next \`${command}\`.` : ""}`,
    );
    return;
  }
  // GitHub merges a PUT of an environment: a rule not sent keeps its value (checked live on a
  // public repository), so only the rules that change are sent.
  const custom = branchRule && view.branchPolicy === null;
  if (reviewer !== undefined || custom) {
    await api.putEnvironment(owner, repo, env, {
      ...(reviewer !== undefined ? { reviewers: [reviewer] } : {}),
      ...(custom ? { branchPolicy: CUSTOM_BRANCHES } : {}),
    });
  }
  if (branchRule) {
    try {
      await api.addDeploymentBranch(owner, repo, env, branch);
    } catch (error) {
      // Custom branch policies without a branch stop every deploy: put back what changed.
      let undone = true;
      try {
        if (reviewer !== undefined || custom) {
          await api.putEnvironment(owner, repo, env, {
            ...(reviewer !== undefined ? { reviewers: view.reviewers } : {}),
            ...(custom ? { branchPolicy: null } : {}),
          });
        }
      } catch {
        undone = false;
      }
      await input.audit(
        `set rules of environment ${env} (failed)`,
        `${branch} could not be added to its deployment branches; ${undone ? "the rules were put back as they were" : "the rules could not be put back"}`,
      );
      const reason = `OpsCrew could not let ${branch} deploy to the GitHub environment ${env} (${errorText(error)})`;
      // Still custom branch policies without a branch: when the rules could not be put back, or
      // when that was already the state before.
      if (!undone || !custom) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          deps.redactor.redact(
            `${reason}${undone ? "" : ", and could not put its rules back"}: no branch can deploy to ${env} now.`,
          ),
          {
            hint: `In ${settings}, add ${branch} under Deployment branches of ${env}, or set them to No restriction. Then run \`${command}\` again.`,
            cause: error,
          },
        );
      }
      throw new OpsCrewError(
        codeOf(error),
        deps.redactor.redact(`${reason}, so it put the environment's rules back as they were.`),
        { hint: `${hintOf(error)}Then run \`${command}\` again.`, cause: error },
      );
    }
  }
  await input.audit(`set rules of environment ${env}`, changes.join(" "));
  deps.reporter.success(`Set the rules of the GitHub environment ${env}: ${changes.join(" ")}`);
}

/**
 * How the deploy reaches an extra server: its address (the private one once public SSH is closed)
 * and its known hosts lines there.
 */
export interface ServerReach {
  /** The server's name in the plan. */
  name: string;
  host: string;
  /** `[host]:port` when its SSH port is not 22, as ssh looks the key up. */
  knownHosts: string;
}

/**
 * The GitHub Actions secrets the deploy workflow reads, with one per running service
 * ({@link serviceEnvSecrets}). In tunnel mode (a server the user owns without a public address)
 * `tunnel` adds the Cloudflare Access service token the workflow reaches SSH through; `host` is
 * then the tunnel's SSH hostname and `knownHosts` holds the server's host key under that name.
 * With origin TLS, `originTls` is the origin certificate's PEM, then its key's
 * (`OPSCREW_ORIGIN_TLS`). Each of `servers`, the app's extra servers, gets its address and its
 * known hosts lines (`serverDeploySecrets`), which the deploy reaches it with. With the off-server
 * copy on, `offsite` is its env file (`offsiteEnvFile`) as `OFFSITE_ENV_SECRET`.
 */
export function deploySecrets(input: {
  plan: DeployPlan;
  host: string;
  privateKey: string;
  knownHosts: string;
  environment: AppEnvironment;
  tunnel?: { serviceTokenId: string; serviceTokenSecret: string };
  originTls?: string;
  servers?: readonly ServerReach[];
  offsite?: string;
}): Record<string, string> {
  return {
    [DEPLOY_SECRETS.host]: input.host,
    [DEPLOY_SECRETS.sshKey]: input.privateKey,
    [DEPLOY_SECRETS.knownHosts]: input.knownHosts,
    ...Object.fromEntries(
      (input.servers ?? []).flatMap(({ name, host, knownHosts }) => {
        const secret = serverDeploySecrets(name);
        return [
          [secret.host, host],
          [secret.knownHosts, knownHosts],
        ];
      }),
    ),
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
    ...(input.offsite !== undefined ? { [OFFSITE_ENV_SECRET]: input.offsite } : {}),
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
  /** The user declined OpsCrew's offer of a required reviewer for that GitHub environment. */
  reviewersDeclined: z.literal(true).optional(),
});

type SecretsRecord = z.infer<typeof SecretsRecordSchema>;

/**
 * Adds `fields` to the environment's record of its deploy secrets for the repository `where` (a
 * record of another repository is replaced).
 */
async function addToSecretsRecord(
  deps: Pick<PhaseDeps, "paths">,
  where: string,
  fields: Pick<SecretsRecord, "createdEnvironment" | "reviewersDeclined">,
): Promise<void> {
  const record = await readSecretsRecord(deps);
  const base = record?.repo === where ? record : { repo: where, names: [] };
  await writeFileAtomic(
    deps.paths.files.deploySecrets,
    `${JSON.stringify({ ...base, ...fields })}\n`,
  );
}

/** The environment's record of its deploy secrets (`deps.paths.files.deploySecrets`), if any. */
export async function readSecretsRecord(
  deps: Pick<PhaseDeps, "paths">,
): Promise<SecretsRecord | undefined> {
  return readValidJson(deps.paths.files.deploySecrets, SecretsRecordSchema);
}

/**
 * What to delete of the secrets OpsCrew stored last time (`previous`, the record for this
 * repository), each where it is. `stale`: every deploy secret the record names that `names` no
 * longer holds (the env file secrets of services that no longer run, the addresses of extra
 * servers that are gone, origin TLS turned off, or the other kind of side's after a move between a
 * server and Portainer); only names OpsCrew recorded, never the scheduled check's, `keep`'s, or
 * one holding an app variable of the plan (`siteEnvSecret`: a value not given this run keeps the
 * earlier one).
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
  keep: readonly string[],
): { stale: SecretPlace[]; moved: SecretPlace[] } {
  const was = previous?.environment;
  const at = (name: string, where: string | undefined): SecretPlace =>
    where === undefined ? { name } : { name, environment: where };
  // The build values stay repository secrets beside a GitHub environment.
  const build = BUILD_VALUES.map((name) => deploySecretName(plan, name));
  const kept = [...plan.app.env.map((v) => siteEnvSecret(v.name)), ...keep].map((name) =>
    deploySecretName(plan, name),
  );
  const stale = (previous?.names ?? [])
    .filter((name) => !names.includes(name) && !kept.includes(name))
    .sort()
    .map((name) => at(name, build.includes(name) ? undefined : was));
  if (environment === was) return { stale, moved: [] };
  if (environment !== undefined) {
    // A stale one (read, but no longer stored) is deleted once.
    const moved = deploySecretNamesFor(plan)
      .filter((name) => !BUILD_VALUES.includes(name))
      .map((name) => deploySecretName(plan, name))
      .filter((name) => !stale.some((place) => place.name === name))
      .sort()
      .map((name) => at(name, undefined));
    return { stale, moved };
  }
  // Out of a GitHub environment: everything the record lists there goes, the stale ones too.
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
 * approval, the recorded deploy secrets the deploy no longer reads and, on a move between a GitHub
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
    /**
     * The scheduled check's reach of this server (`checkServerSecret`), stored with the deploy
     * secrets as the repository secret `<prefix>CHECK_SERVER` (a move re-points it).
     */
    checkServer?: string;
    /** What the approval says of the values instead of the app environment's names. */
    about?: string;
    /** Deploy secrets (unprefixed names) that stay although this set does not hold them. */
    keep?: readonly string[];
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
  const checkName = deploySecretName(plan, CHECK_SECRETS.server);
  if (options.checkServer !== undefined) {
    placed.set(checkName, { name: checkName, value: options.checkServer });
  }
  const names = [...placed.keys()].sort();
  const all = names.map((name) => placed.get(name) as SecretPlace & { value: string });
  const inRepository = all.filter((place) => place.environment === undefined);
  const inEnvironment = all.filter((place) => place.environment !== undefined);
  const record = await readSecretsRecord(deps);
  const previous = record?.repo === repo ? record : undefined;
  const { stale, moved } = secretsToDelete(plan, previous, names, environment, options.keep ?? []);
  const deleted = new Set([...stale, ...moved].map((place) => place.name));
  const left = (previous?.names ?? []).filter(
    (name) => !names.includes(name) && !deleted.has(name),
  );
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
      options.about ??
        `The app environment contains: ${variableNames.length > 0 ? variableNames.join(", ") : "no variables"}.`,
      ...(stale.length > 0
        ? ["Deleted, since the deploy no longer reads them (names only):", ...list(stale)]
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
      // The check's secret is the check's, never a deploy secret to move or delete. The recorded
      // ones this run keeps without storing them stay recorded.
      names: [...names.filter((name) => name !== checkName), ...left].sort(),
      ...(environment !== undefined ? { environment } : {}),
      ...(previous?.createdEnvironment === true ? { createdEnvironment: true } : {}),
      ...(previous?.reviewersDeclined === true ? { reviewersDeclined: true } : {}),
    })}\n`,
  );
  deps.reporter.success(
    environment === undefined
      ? `Stored ${names.length} deploy secrets in GitHub Actions.`
      : `Stored ${names.length} deploy secrets in GitHub Actions, ${inEnvironment.length} of them in the GitHub environment ${environment}.`,
  );
}
