import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { GitClient } from "@opscrew/connector-github";
import {
  DEPLOY_BRANCH,
  DEPLOY_COMPOSE_FILE,
  type DesiredStacks,
  type DesiredValueFingerprints,
  inspectCertificate,
  inspectPortainer,
  normalizeCertFingerprint,
  opscrewStackNames,
  PortainerCertificateError,
  type PortainerClient,
  type PortainerFacts,
  type PortainerStackFacts,
  planStacks,
  portainerClient,
  type StackPlan,
  valueFingerprints,
} from "@opscrew/connector-portainer";
import type { ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import {
  fillPortainerStack,
  PORTAINER_STACK_TEMPLATE_PATH,
  PORTAINER_STACK_VARIABLES,
  portainerStackEnvKeys,
  portainerStackVolumes,
  renderPlaceholderStack,
  renderPortainerConnectorStack,
  renderUpdaterStack,
} from "@opscrew/iac-templates";
import type { DeployPlan, PortainerDeployTarget } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { hidePortainerAddress } from "../interview/portainer-access";
import { portainerCloudflare, setupCloudflare, setupGitHub } from "../provision/credentials";
import {
  ensurePortainerValueKey,
  portainerContainerUrl,
  portainerTargetOf,
  portainerValueKeyFile,
  portainerWebhookId,
  REGISTRY_TOKEN_VAR,
  REPOSITORY_TOKEN_VAR,
  requirePortainerConnection,
  requirePortainerToken,
} from "../provision/portainer";
import {
  committedTfvars,
  deploymentFiles,
  deploymentRenderContext,
  ownRenderFromTfvars,
  readRequirements,
} from "../provision/render";
import { generatedValuesFile } from "../provision/secrets";
import {
  type AppEnvironment,
  assembleAppEnv,
  diffRenderedFiles,
  type PortainerConnection,
  parseDotenv,
} from "../shared";
import {
  compareInfrastructure,
  driftEngine,
  inspectState,
  readOptional,
  STATE_FILE,
  stateHoldsNothing,
} from "./infra";
import type { DriftOptions, DriftReport, PortainerDifference } from "./types";

/** Said when the plan has no Cloudflare root and the state holds nothing either. */
const NO_CLOUDFLARE_NOTE =
  "OpsCrew manages no Cloudflare resources for this app (it serves the app without a Cloudflare Tunnel), so there are none to compare; your Portainer, the deploy branch and the generated files were checked.";

/** Said when the app's values cannot be read on this computer without asking for them. */
const APP_VALUES_NOTE = `OpsCrew compared the names of the app stack's variables in Portainer, not their values: it reads the production values only from the file OPSCREW_APP_ENV_FILE names (as \`opscrew provision\` does in scripts), together with the values it generated on this computer. Set OPSCREW_APP_ENV_FILE and run \`opscrew drift\` again to compare the values too (by keyed fingerprints; no value is shown).`;

/** Said when the value key is not on this computer. */
const NO_VALUE_KEY_NOTE =
  "OpsCrew compared the names of the stacks' variables, not their values: its value key for your Portainer (portainer-env.key in OpsCrew's folder for this project) is not on this computer. Run `opscrew drift` on the computer that ran `opscrew provision` to compare the values too.";

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function stringOutput(outputs: Record<string, unknown> | undefined, name: string) {
  const value = outputs?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The fingerprints of `keys` as Portainer holds them, standing in for values this computer cannot
 * read: they compare as unchanged, a key Portainer lacks as changed (it differs anyway).
 */
function asRemote(
  key: Uint8Array,
  remote: Record<string, string> | undefined,
  keys: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    keys.map((name) => [
      name,
      remote?.[name] ?? (valueFingerprints(key, { [name]: "" })[name] as string),
    ]),
  );
}

/** The values provision generated before (`generated_values.json`), as far as they are valid. */
const GeneratedValuesSchema = z.looseObject({
  dbPassword: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

/** Stands for a value provision would generate now: this computer does not know it. */
const UNKNOWN = "__OPSCREW_DRIFT_UNKNOWN__";

/**
 * The app stack's values as `opscrew provision` would send them, into `values` (by name; a value
 * this computer cannot know is left out, so it compares as Portainer has it): the production
 * values from the file `OPSCREW_APP_ENV_FILE` names, and the values provision generated, read from
 * its record without writing it or anything else, and without a note. False when the production
 * values cannot be read without asking for them.
 */
async function readAppValues(
  deps: PhaseDeps,
  plan: DeployPlan,
  appKeys: readonly string[],
  values: Record<string, string | undefined>,
): Promise<boolean> {
  const envFile = deps.env.OPSCREW_APP_ENV_FILE?.trim();
  if (!envFile) return false;
  const path = isAbsolute(envFile) ? envFile : join(deps.paths.root, envFile);
  const dotenvText = await readOptional(path);
  if (dotenvText === undefined) return false;
  let previous: z.infer<typeof GeneratedValuesSchema> | undefined;
  try {
    const parsed = GeneratedValuesSchema.safeParse(
      JSON.parse((await readOptional(generatedValuesFile(deps))) ?? "null"),
    );
    previous = parsed.success ? parsed.data : undefined;
  } catch {
    previous = undefined;
  }
  let environment: AppEnvironment;
  try {
    environment = await assembleAppEnv({
      plan,
      dotenvText,
      // A value provision would generate now is unknown here: it compares as Portainer has it.
      password: () => UNKNOWN,
      ...(previous !== undefined
        ? {
            previous: {
              ...(previous.dbPassword !== undefined ? { dbPassword: previous.dbPassword } : {}),
              ...(previous.env !== undefined ? { env: previous.env } : {}),
            },
          }
        : {}),
    });
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "INVALID_INPUT") return false;
    throw error;
  }
  const known = (value: string | undefined) =>
    value === undefined || value.includes(UNKNOWN) ? undefined : value;
  for (const name of appKeys) values[name] = known(environment.values.app[name] ?? "");
  const db = parseDotenv(environment.dbEnv ?? "");
  values[PORTAINER_STACK_VARIABLES.dbUser] = known(db.get("POSTGRES_USER"));
  values[PORTAINER_STACK_VARIABLES.dbName] = known(db.get("POSTGRES_DB"));
  values[PORTAINER_STACK_VARIABLES.dbPassword] = known(db.get("POSTGRES_PASSWORD"));
  for (const value of Object.values(values)) {
    if (value !== undefined && value.length >= 8) deps.redactor.addLiteral(value, "app-env");
  }
  return true;
}

/** What the value comparison needs to know, and what it could not compare. */
interface ValueInputs {
  key: Uint8Array;
  plan: DeployPlan;
  target: PortainerDeployTarget;
  facts: PortainerFacts;
  connection: PortainerConnection;
  outputs: Record<string, unknown> | undefined;
  repositoryPrivate: boolean;
  imagePrivate: boolean;
  /** Reads the certificate Portainer presents (a TLS handshake, nothing sent). */
  inspectCertificate: typeof inspectCertificate;
}

/**
 * The keyed fingerprints of the values `opscrew provision` would send now, computed as provision
 * does (the app's values, OpsCrew's own, the webhook, the updater's or the connector's), without
 * asking for anything and without creating anything: what this computer cannot read compares as
 * Portainer has it (see {@link asRemote}), and `notes` say so. The values never leave memory.
 */
async function desiredFingerprints(
  deps: PhaseDeps,
  input: ValueInputs,
  notes: string[],
  differences: PortainerDifference[],
): Promise<DesiredValueFingerprints> {
  const { key, plan, target, facts, connection, outputs } = input;
  const stackOf = (
    role: "app" | "updater" | "tunnel-connector",
  ): PortainerStackFacts | undefined => {
    const recorded = connection.created.stacks.find((stack) => stack.role === role);
    return recorded === undefined
      ? undefined
      : facts.stacks.find((stack) => stack.id === recorded.id);
  };
  const keys = portainerStackEnvKeys(plan);
  const envKeys = [...keys.app, ...keys.opscrew].sort();

  // The app stack: the production values only from OPSCREW_APP_ENV_FILE, never asked for, and the
  // values provision generated, read without writing anything.
  const values: Record<string, string | undefined> = {};
  const appKnown = await readAppValues(deps, plan, keys.app, values);
  if (!appKnown) notes.push(APP_VALUES_NOTE);
  if (target.web.mode === "tunnel") {
    const token = stringOutput(outputs, "tunnel_token");
    if (token !== undefined) deps.redactor.addLiteral(token, "tunnel_token");
    values[PORTAINER_STACK_VARIABLES.tunnelToken] = token;
  }
  const remoteApp = asRemote(key, stackOf("app")?.envFingerprints, envKeys);
  const app: Record<string, string> = {};
  for (const name of envKeys) {
    const value = values[name];
    app[name] =
      value === undefined
        ? (remoteApp[name] as string)
        : (valueFingerprints(key, { [name]: value })[name] as string);
  }

  // The webhook: OpsCrew's record of it, never a new one.
  const webhookId = await portainerWebhookId(deps, { create: false });
  const appStack = stackOf("app");
  if (webhookId === undefined && appStack !== undefined) {
    differences.push({
      area: "stack",
      title: "OpsCrew's record of the app stack's webhook is not on this computer",
      detail:
        "`opscrew provision` makes a new webhook and sets it on the app's stack and the updater (you approve that plan as usual).",
    });
  }
  const webhook =
    webhookId !== undefined
      ? (valueFingerprints(key, { webhook: webhookId }).webhook as string)
      : (appStack?.autoUpdate?.webhookFingerprint ??
        (valueFingerprints(key, { webhook: "" }).webhook as string));

  const tokens = valueFingerprints(key, {
    repositoryToken: input.repositoryPrivate ? (deps.env[REPOSITORY_TOKEN_VAR]?.trim() ?? "") : "",
    registryToken: input.imagePrivate ? (deps.env[REGISTRY_TOKEN_VAR]?.trim() ?? "") : "",
  });
  const out: DesiredValueFingerprints = {
    app,
    webhook,
    repositoryToken: tokens.repositoryToken as string,
    registryToken: tokens.registryToken as string,
  };
  if (target.redeploy === "updater") {
    const updaterKeys = ["PORTAINER_PINNED_KEY", "PORTAINER_WEBHOOK_URL"];
    const remote = asRemote(key, stackOf("updater")?.envFingerprints, updaterKeys);
    out.updater =
      webhookId === undefined
        ? remote
        : valueFingerprints(key, {
            PORTAINER_WEBHOOK_URL: `${portainerContainerUrl(connection.url)}/api/stacks/webhooks/${webhookId}`,
            PORTAINER_PINNED_KEY: await publicKeyPin(deps, connection, input.inspectCertificate),
          });
  } else {
    const token = stringOutput(outputs, "portainer_tunnel_token");
    if (token !== undefined) deps.redactor.addLiteral(token, "portainer_tunnel_token");
    out.connector =
      token === undefined
        ? asRemote(key, stackOf("tunnel-connector")?.envFingerprints, ["TUNNEL_TOKEN"])
        : valueFingerprints(key, { TUNNEL_TOKEN: token });
  }
  return out;
}

/**
 * The public-key pin the updater checks Portainer's certificate with (as provision computes it):
 * read with a TLS handshake (read-only) and only when the certificate is the confirmed one; empty
 * for plain HTTP to this computer.
 */
async function publicKeyPin(
  deps: Pick<PhaseDeps, "redactor">,
  connection: PortainerConnection,
  inspect: typeof inspectCertificate,
): Promise<string> {
  if (new URL(connection.url).protocol !== "https:") return "";
  const pinned = normalizeCertFingerprint(connection.certFingerprint ?? "");
  const details = await inspect(connection.url);
  const actual = normalizeCertFingerprint(details.fingerprint);
  if (pinned === undefined || actual === undefined || actual !== pinned) {
    throw new PortainerCertificateError(
      pinned ?? "no confirmed certificate",
      actual ?? "an unreadable fingerprint",
    );
  }
  deps.redactor.addLiteral(details.publicKeyPin, "portainer-key");
  return details.publicKeyPin;
}

/** The plan's changes and findings as drift: what `opscrew provision` would change in Portainer. */
function stackDifferences(plan: StackPlan): PortainerDifference[] {
  const out: PortainerDifference[] = [];
  for (const change of plan.changes) {
    if (change.state === "in-place") continue;
    const area = change.id === "registry" ? "registry" : "stack";
    out.push(
      change.state === "blocked"
        ? {
            area,
            title: `${change.title} (blocked)`,
            ...(change.reason !== undefined ? { detail: change.reason } : {}),
          }
        : {
            area,
            title: change.title,
            ...(change.reason !== undefined ? { detail: change.reason } : {}),
          },
    );
  }
  for (const finding of plan.findings) {
    out.push({ area: "portainer", title: finding.message, detail: finding.hint });
  }
  return out;
}

/** The first GHCR image pinned by digest in a stack file. */
function imageIn(file: string): string | undefined {
  return /ghcr\.io\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}/.exec(file)?.[0];
}

/**
 * The deploy branch's `compose.yaml` at `sha`, read with git (read-only: the commit is fetched from
 * where pushes go, no branch or ref is written). `undefined` when it cannot be read.
 */
async function deployBranchFile(deps: PhaseDeps, sha: string): Promise<string | undefined> {
  const root = deps.paths.root;
  // Never a prompt for a login, never a lock that could get in the user's way, bounded in time.
  const options = {
    env: { ...deps.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 120_000,
  };
  const url = (
    await deps.runner.run("git", ["-C", root, "remote", "get-url", "--push", "origin"], options)
  ).stdout.trim();
  // A URL that looks like an option is never passed as one; the remote name is used instead.
  const source = url === "" || url.startsWith("-") ? "origin" : url;
  const fetched = await deps.runner.run(
    "git",
    [
      "-C",
      root,
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      // No remote-tracking ref is updated either, whatever the remote's fetch refspecs say.
      "--refmap=",
      source,
      `refs/heads/${DEPLOY_BRANCH}`,
    ],
    options,
  );
  if (fetched.exitCode !== 0) return undefined;
  const shown = await deps.runner.run(
    "git",
    ["-C", root, "show", `${sha}:${DEPLOY_COMPOSE_FILE}`],
    options,
  );
  return shown.exitCode === 0 ? shown.stdout : undefined;
}

/**
 * How the deploy branch differs from what the deploy workflow writes from OpsCrew's template: the
 * branch is gone while the app's stack deploys from it, it still holds the placeholder, it names
 * an image that is not the app's, or its file is not the template with that image filled in.
 */
async function deployBranchDifferences(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    plan: DeployPlan;
    template: string | undefined;
    repo: string;
    appStackExists: boolean;
  },
  notes: string[],
): Promise<PortainerDifference[]> {
  const where = `${DEPLOY_BRANCH} branch of ${input.repo}`;
  let sha: string | undefined;
  try {
    sha = await input.git.remoteBranchSha(DEPLOY_BRANCH);
  } catch {
    notes.push(
      `OpsCrew could not read the ${where} (check that this computer can reach GitHub with \`git ls-remote origin\`), so it did not compare it.`,
    );
    return [];
  }
  if (sha === undefined) {
    return input.appStackExists
      ? [
          {
            area: "deploy-branch",
            title: `The ${where} is missing, but the app's stack in Portainer deploys from it`,
            detail:
              "Portainer cannot redeploy the app until the branch is back: the next run of the deploy workflow writes it again (re-run the latest deploy in GitHub Actions, or merge a change).",
          },
        ]
      : [];
  }
  const file = await deployBranchFile(deps, sha);
  if (file === undefined) {
    notes.push(
      `OpsCrew could not read ${DEPLOY_COMPOSE_FILE} on the ${where}, so it did not compare it.`,
    );
    return [];
  }
  const text = file.trimEnd();
  if (text === renderPlaceholderStack(input.plan).content.trimEnd()) {
    return [
      {
        area: "deploy-branch",
        title: `The ${where} still holds the placeholder OpsCrew created`,
        detail:
          "The deploy workflow has not deployed the app yet: merge the deploy pull request (or re-run the deploy workflow), and it writes the app's stack file there.",
      },
    ];
  }
  const image = imageIn(text);
  const appImage = `ghcr.io/${input.repo}@sha256:`.toLowerCase();
  if (image === undefined || !image.startsWith(appImage)) {
    return [
      {
        area: "deploy-branch",
        title:
          image === undefined
            ? `${DEPLOY_COMPOSE_FILE} on the ${where} names no image of the app pinned by digest`
            : `${DEPLOY_COMPOSE_FILE} on the ${where} runs ${image}, which is not the app's image`,
        detail:
          "It was changed outside the deploy workflow. The next run of the deploy workflow writes the app's stack file again; until then Portainer deploys what the branch holds.",
      },
    ];
  }
  if (input.template === undefined) return [];
  if (fillPortainerStack(input.template.trimEnd(), image) !== text) {
    return [
      {
        area: "deploy-branch",
        title: `${DEPLOY_COMPOSE_FILE} on the ${where} differs from OpsCrew's template with the image ${image}`,
        detail:
          "It was changed by hand, or written from an older template. The next run of the deploy workflow writes it again from the committed template; until then Portainer deploys what the branch holds.",
      },
    ];
  }
  return [];
}

/**
 * `opscrew drift` for the user's Portainer (FR-1013), read-only: the generated files against what
 * OpsCrew renders; the Cloudflare root (when the plan has one) with a refresh-only and a normal
 * plan, Portainer's address only in the sensitive `TF_VAR_portainer_origin`; then, through the
 * pinned client, the stacks OpsCrew created against what it sets up now: their files, the
 * variables' names and (with the value key on this computer) their values as keyed fingerprints,
 * the webhook (`AutoUpdate`), the registry entry, and the redeploy mode; and the deploy branch's
 * head against the committed template with its image. Nothing is created: no value key, webhook,
 * token or generated value. No value, token or Portainer address reaches the report.
 */
export async function portainerDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DriftOptions,
): Promise<DriftReport> {
  const services = options.services ?? {};
  const target = portainerTargetOf(plan);
  const root = portainerCloudflare(plan) ?? { appTunnel: false, webhook: false };
  const hasRoot = root.appTunnel || root.webhook;
  const statePath = join(deps.paths.files.tfstateDir, STATE_FILE);
  const stateKind = hasRoot ? await inspectState(deps, statePath) : "unknown";
  const leftovers = !hasRoot && !(await stateHoldsNothing(statePath));

  // 1. Credentials: Portainer's token and connection, GitHub, Cloudflare when the plan has a tunnel.
  deps.reporter.step(
    hasRoot
      ? "Checking your Portainer, Cloudflare and GitHub access"
      : "Checking your Portainer and GitHub access",
  );
  const connection = await requirePortainerConnection(deps, plan);
  const token = requirePortainerToken(deps);
  const git = new GitClient({
    cwd: deps.paths.root,
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
  });
  const github = await setupGitHub(deps, git, services);
  const repository = await github.api.getRepo(github.owner, github.repo);
  const repo = `${github.owner}/${github.repo}`;
  const cloudflare = hasRoot
    ? await setupCloudflare(deps, plan, services, { foreignRecords: "report" })
    : undefined;
  const current =
    cloudflare !== undefined && plan.dns.zone !== cloudflare.zoneName
      ? { ...plan, dns: { ...plan.dns, zone: cloudflare.zoneName } }
      : plan;

  // 2. The generated files against what OpsCrew renders (no deploy key on this target).
  deps.reporter.step("Comparing the generated files with what OpsCrew renders from the plan");
  const committed = ownRenderFromTfvars(await committedTfvars(deps.paths.root, current));
  const files = deploymentFiles(
    current,
    deploymentRenderContext(deps, {
      plan: current,
      requirements: await readRequirements(deps),
      github,
      deployPublicKey: "",
      cloudflare,
      ...(root.webhook
        ? { own: { createZeroTrustOrganization: committed.createZeroTrustOrganization ?? false } }
        : {}),
    }),
  );
  const diff = await diffRenderedFiles(deps.paths.root, files);
  const changedFiles = diff.changed.map((file) => file.path).sort();
  const createdFiles = diff.created.map((file) => file.path).sort();
  const template = files.find((file) => file.path === PORTAINER_STACK_TEMPLATE_PATH)?.content;

  // 3. The Cloudflare root: refresh-only and normal plans, both discarded.
  const engine = await driftEngine(deps, current, options);
  const engineEnv: Record<string, string | undefined> = { ...deps.env };
  delete engineEnv.TF_VAR_portainer_origin;
  let drift: ResourceDrift[] = [];
  let pending: ResourceChange[] = [];
  let outputs: Record<string, unknown> | undefined;
  const notes: string[] = [];
  const differences: PortainerDifference[] = [];
  if (hasRoot) {
    if (root.webhook) {
      // Portainer's address reaches the engine only as a sensitive variable, never in a file.
      const origin = portainerContainerUrl(connection.url);
      hidePortainerAddress(deps.redactor, origin);
      engineEnv.TF_VAR_portainer_origin = origin;
    }
    const compared = await compareInfrastructure(deps, {
      plan: current,
      engine,
      engineEnv,
      statePath,
      stateKind,
      mirrored: {},
      changedFiles,
    });
    drift = compared.drift;
    pending = compared.pending;
    notes.push(...compared.notes);
    outputs = await compared.outputs();
  } else if (leftovers) {
    differences.push({
      area: "cloudflare",
      title:
        "The infrastructure state still holds what an earlier setup of this app created in Cloudflare (its Cloudflare Tunnel, DNS records or Access)",
      detail:
        "This setup no longer uses them: `opscrew provision` shows a plan that removes them, and nothing changes until you approve it.",
    });
  } else {
    notes.push(NO_CLOUDFLARE_NOTE);
  }

  // 4. Portainer, read-only through the pinned client.
  const keyFile = portainerValueKeyFile(deps.paths);
  const valueKey = (await exists(keyFile)) ? await ensurePortainerValueKey(deps) : undefined;
  const makeClient = services.portainer?.client ?? portainerClient;
  const client: PortainerClient = makeClient(
    {
      url: connection.url,
      ...(connection.certFingerprint !== undefined
        ? { certFingerprint: connection.certFingerprint }
        : {}),
    },
    token,
    { redactor: deps.redactor, ...(valueKey !== undefined ? { valueKey } : {}) },
  );
  deps.reporter.step("Inspecting your Portainer (read-only)");
  const facts = await inspectPortainer(client, {
    environmentId: target.environmentId,
    names: opscrewStackNames(plan.app.name),
  });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "inspect Portainer (read-only)",
    phase: "provision",
    target: `portainer environment ${target.environmentId}`,
    decision: "allow",
    detail: "drift",
  });
  if (facts.findings.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      deps.redactor.redact(
        `OpsCrew cannot check your Portainer, so it compared nothing there:\n${facts.findings.map((finding) => `  - ${finding.message}`).join("\n")}`,
      ),
      {
        hint: `${[...new Set(facts.findings.map((finding) => finding.hint))].join(" ")} Then run \`opscrew drift\` again.`,
      },
    );
  }
  const arch = facts.environment?.arch;
  if (arch !== undefined && arch !== target.arch) {
    differences.push({
      area: "portainer",
      title: `Your Portainer environment runs on ${arch}, but opscrew/plan.yaml builds the app for ${target.arch}`,
      detail: `Run \`opscrew design\` again so OpsCrew builds the image for ${arch}, then \`opscrew provision\`.`,
    });
  }

  const publicImage = connection.publicImage ?? false;
  const keys = portainerStackEnvKeys(current);
  let fingerprints: DesiredValueFingerprints | undefined;
  if (valueKey === undefined) {
    notes.push(NO_VALUE_KEY_NOTE);
  } else {
    fingerprints = await desiredFingerprints(
      deps,
      {
        key: valueKey,
        plan: current,
        target,
        facts,
        connection,
        outputs,
        repositoryPrivate: repository.private,
        imagePrivate: !publicImage,
        inspectCertificate: services.portainer?.inspectCertificate ?? inspectCertificate,
      },
      notes,
      differences,
    );
  }
  const updater = target.redeploy === "updater";
  const desired: DesiredStacks = {
    app: plan.app.name,
    environmentId: target.environmentId,
    repository: {
      url: `https://github.com/${repo}`,
      branch: DEPLOY_BRANCH,
      composeFile: DEPLOY_COMPOSE_FILE,
      private: repository.private,
    },
    envKeys: [...keys.app, ...keys.opscrew].sort(),
    registry: { url: "ghcr.io", private: !publicImage, username: github.owner },
    redeploy: target.redeploy,
    ...(updater
      ? { updater: { compose: renderUpdaterStack(current).content } }
      : { tunnelConnector: { compose: renderPortainerConnectorStack(current).content } }),
    record: connection.created,
    ports:
      target.web.mode === "proxy"
        ? [target.web.port]
        : target.web.mode === "caddy"
          ? [80, 443]
          : [],
    volumes: portainerStackVolumes(current),
    ...(fingerprints !== undefined ? { valueFingerprints: fingerprints } : {}),
  };
  differences.push(...stackDifferences(planStacks(facts, desired)));

  // 5. The deploy branch's head against the committed template with its image.
  const appRecorded = connection.created.stacks.find((stack) => stack.role === "app");
  differences.push(
    ...(await deployBranchDifferences(
      deps,
      {
        git,
        plan: current,
        template,
        repo,
        appStackExists:
          appRecorded !== undefined && facts.stacks.some((stack) => stack.id === appRecorded.id),
      },
      notes,
    )),
  );

  const portainer = {
    environment: facts.environment?.name ?? connection.environmentName,
    differences: differences.map((item) => ({
      area: item.area,
      title: deps.redactor.redact(item.title),
      ...(item.detail !== undefined ? { detail: deps.redactor.redact(item.detail) } : {}),
    })),
  };
  const foreignDnsRecords = [...(cloudflare?.foreignRecords ?? [])].sort((a, b) =>
    `${a.name} ${a.type}`.localeCompare(`${b.name} ${b.type}`),
  );
  const clean =
    drift.length === 0 &&
    pending.length === 0 &&
    changedFiles.length === 0 &&
    createdFiles.length === 0 &&
    foreignDnsRecords.length === 0 &&
    portainer.differences.length === 0;
  const report: DriftReport = {
    drift,
    pending,
    files: { changed: changedFiles, created: createdFiles },
    foreignDnsRecords,
    portainer,
    clean,
    engine: engine.info,
    checkedAt: deps.clock.now().toISOString(),
    provider: "portainer",
    ...(notes.length > 0 ? { notes: notes.map((note) => deps.redactor.redact(note)) } : {}),
  };
  await deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action: "drift-check",
    target: plan.infra.dir,
    detail: clean
      ? "no drift"
      : `${drift.length} changed outside OpsCrew, ${pending.length} pending, ${changedFiles.length + createdFiles.length} files differ, ${portainer.differences.length} differences in Portainer`,
  });
  return report;
}
