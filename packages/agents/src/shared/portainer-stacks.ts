import {
  applyStackPlan,
  type CreatedRecord,
  DEPLOY_BRANCH,
  DEPLOY_COMPOSE_FILE,
  type DesiredStacks,
  type DesiredValueFingerprints,
  type inspectCertificate,
  inspectPortainer,
  normalizeCertFingerprint,
  opscrewStackNames,
  PortainerCertificateError,
  type PortainerClient,
  type PortainerClientDeps,
  type PortainerEndpoint,
  type PortainerFacts,
  type PortainerStackFacts,
  portainerClient,
  StackApplyError,
  type StackPlan,
} from "@opscrew/connector-portainer";
import type { PhaseName } from "@opscrew/contracts";
import {
  keepNewerPins,
  PORTAINER_STACK_TEMPLATE_PATH,
  portainerStackEnvKeys,
  portainerStackVolumes,
  portainerTarget,
  renderPortainerConnectorStack,
  renderUpdaterStack,
} from "@opscrew/iac-templates";
import type { DeployPlan, PortainerDeployTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { committedText } from "./files";
import type { PortainerConnection } from "./server-record";

/**
 * The committed stack template (`opscrew/runtime/compose.yaml`) of the project at `root`, for
 * {@link desiredStacks}: in tunnel web mode it names the cloudflared image the connector stack
 * (which lives only in Portainer) runs too, and Dependabot keeps it current. Empty when the
 * repository has none yet.
 */
export function committedStackPins(root: string): Promise<string> {
  return committedText(root, [PORTAINER_STACK_TEMPLATE_PATH]);
}

/** The host ports the app's stack publishes in the plan's web mode (none through the tunnel). */
export function publishedPorts(target: PortainerDeployTarget): number[] {
  if (target.web.mode === "proxy") return [target.web.port];
  return target.web.mode === "caddy" ? [80, 443] : [];
}

/** OpsCrew's stack of `role` as Portainer reports it, found by the id OpsCrew recorded for it. */
export function recordedStack(
  connection: Pick<PortainerConnection, "created">,
  facts: Pick<PortainerFacts, "stacks">,
  role: "app" | "updater" | "tunnel-connector",
): PortainerStackFacts | undefined {
  const recorded = connection.created.stacks.find((stack) => stack.role === role);
  return recorded === undefined
    ? undefined
    : facts.stacks.find((stack) => stack.id === recorded.id);
}

/**
 * What OpsCrew sets up in the user's Portainer for `plan`, for `planStacks`: the app's Git stack
 * built from the deploy branch of `github`'s repository, the registry entry of its image, the
 * updater or the Cloudflare connector, the published ports and volumes and OpsCrew's record of
 * what it created; with the values' keyed fingerprints (and the tokens to send again) when given.
 * The connector stack keeps the newer pins of `opts.committed` (FR-1222). `opscrew provision`
 * applies exactly this and `opscrew drift` compares with it.
 */
export function desiredStacks(
  plan: DeployPlan,
  opts: {
    connection: Pick<PortainerConnection, "created">;
    github: { owner: string; repo: string };
    repositoryPrivate: boolean;
    imagePrivate: boolean;
    /** The committed stack template (`committedStackPins`), whose pins Dependabot updates. */
    committed: string;
    fingerprints?: DesiredValueFingerprints;
    replaceTokens?: DesiredStacks["replaceTokens"];
  },
): DesiredStacks {
  const target = portainerTarget(plan.target);
  const keys = portainerStackEnvKeys(plan);
  const { fingerprints, replaceTokens } = opts;
  return {
    app: plan.app.name,
    environmentId: target.environmentId,
    repository: {
      url: `https://github.com/${opts.github.owner}/${opts.github.repo}`,
      branch: DEPLOY_BRANCH,
      composeFile: DEPLOY_COMPOSE_FILE,
      private: opts.repositoryPrivate,
    },
    envKeys: [...keys.app, ...keys.opscrew].sort(),
    registry: { url: "ghcr.io", private: opts.imagePrivate },
    redeploy: target.redeploy,
    ...(target.redeploy === "updater"
      ? { updater: { compose: renderUpdaterStack(plan).content } }
      : {
          tunnelConnector: {
            compose: keepNewerPins(opts.committed, renderPortainerConnectorStack(plan).content),
          },
        }),
    record: opts.connection.created,
    ports: publishedPorts(target),
    volumes: portainerStackVolumes(plan),
    ...(fingerprints !== undefined ? { valueFingerprints: fingerprints } : {}),
    ...(fingerprints !== undefined && replaceTokens !== undefined ? { replaceTokens } : {}),
  };
}

/**
 * The public-key pin the updater checks Portainer's certificate with: read with a TLS handshake
 * (`inspect`, read-only) and only when Portainer presents the confirmed certificate (else
 * `PortainerCertificateError`), registered with the redactor; empty for plain HTTP.
 */
export async function pinnedPublicKey(
  deps: Pick<PhaseDeps, "redactor">,
  connection: Pick<PortainerConnection, "url" | "certFingerprint">,
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

/** Makes a Portainer client (`portainerClient` or a fake in tests). */
type PortainerClientFactory = (
  endpoint: PortainerEndpoint,
  token: string,
  deps: PortainerClientDeps,
) => PortainerClient;

/**
 * The client for the user's Portainer, pinned to the confirmed certificate (`client` makes it,
 * default `portainerClient`; the value key, when given, lets it fingerprint the stacks' values).
 */
export function portainerClientFor(
  deps: Pick<PhaseDeps, "redactor">,
  input: {
    connection: PortainerConnection;
    token: string;
    client: PortainerClientFactory | undefined;
    valueKey?: Uint8Array;
  },
): PortainerClient {
  const { connection } = input;
  return (input.client ?? portainerClient)(
    {
      url: connection.url,
      ...(connection.certFingerprint !== undefined
        ? { certFingerprint: connection.certFingerprint }
        : {}),
    },
    input.token,
    {
      redactor: deps.redactor,
      ...(input.valueKey !== undefined ? { valueKey: input.valueKey } : {}),
    },
  );
}

/**
 * Reads the user's Portainer read-only for the app's stacks through `client` (`step` is what the
 * reporter says meanwhile) and audits the reading without Portainer's address (`detail` says for
 * what; `phase` when the command has one).
 */
export async function inspectAudited(
  deps: Pick<PhaseDeps, "audit" | "reporter">,
  client: PortainerClient,
  input: {
    plan: Pick<DeployPlan, "app">;
    target: PortainerDeployTarget;
    step: string;
    phase?: PhaseName;
    detail?: string;
  },
): Promise<PortainerFacts> {
  const { target } = input;
  deps.reporter.step(input.step);
  const facts = await inspectPortainer(client, {
    environmentId: target.environmentId,
    names: opscrewStackNames(input.plan.app.name),
  });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "inspect Portainer (read-only)",
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    target: `portainer environment ${target.environmentId}`,
    decision: "allow",
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
  return facts;
}

/** {@link portainerClientFor}, then {@link inspectAudited}: the client and what it read. */
export async function inspectRecordedPortainer(
  deps: Pick<PhaseDeps, "redactor" | "audit" | "reporter">,
  input: Parameters<typeof portainerClientFor>[1] & Parameters<typeof inspectAudited>[2],
): Promise<{ client: PortainerClient; facts: PortainerFacts }> {
  const client = portainerClientFor(deps, input);
  return { client, facts: await inspectAudited(deps, client, input) };
}

/**
 * Applies an approved stack plan through the Portainer adapter (which refuses any other plan) and
 * audits it by the plan's hash only: the start, every applied change, and a failure with the
 * changes applied before it. `record` writes what OpsCrew has in Portainer afterwards (`finished`
 * once the apply is done), also when it stopped part-way. The audit names a teardown's actions
 * `stack teardown started`, `stack teardown <id>` and `stack teardown failed` (otherwise `stack
 * apply started`, `stack change <id>` and `stack apply failed`).
 */
export async function applyStackPlanAudited(
  deps: Pick<PhaseDeps, "audit">,
  input: {
    client: PortainerClient;
    plan: StackPlan;
    hash: string;
    options: Omit<Parameters<typeof applyStackPlan>[2], "approvedHash">;
    phase: PhaseName;
    teardown?: boolean;
    record: (created: CreatedRecord, finished: boolean) => Promise<void>;
  },
): Promise<Awaited<ReturnType<typeof applyStackPlan>>> {
  const { plan, hash } = input;
  const [applying, each] =
    input.teardown === true
      ? ["stack teardown", "stack teardown"]
      : ["stack apply", "stack change"];
  const work = plan.changes.filter((change) => change.state === "change");
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `${applying} started`,
    phase: input.phase,
    target: hash,
    decision: "approved",
    detail: `changes: ${work.map((change) => change.id).join(", ")}`,
  });
  let result: Awaited<ReturnType<typeof applyStackPlan>>;
  try {
    result = await applyStackPlan(input.client, plan, { ...input.options, approvedHash: hash });
  } catch (error) {
    if (error instanceof StackApplyError) {
      // What was created before the failure is OpsCrew's: record it before the error is shown.
      await input.record(error.record, false);
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: `${applying} failed`,
        phase: input.phase,
        target: hash,
        decision: "refused",
        detail: `changes applied before the failure: ${error.applied.length > 0 ? error.applied.join(", ") : "none"}`,
      });
    }
    throw error;
  }
  await input.record(result.record, true);
  for (const id of result.applied) {
    const change = plan.changes.find((item) => item.id === id);
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `${each} ${id}`,
      phase: input.phase,
      target: hash,
      decision: "approved",
      ...(change !== undefined ? { detail: change.title } : {}),
    });
  }
  return result;
}
