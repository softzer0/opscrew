import { type HostFacts, inspectHost } from "@opscrew/connector-ssh-host";
import type { ResourceChange } from "@opscrew/contracts";
import { OpsCrewError, tfstateFile } from "@opscrew/core";
import { usesTunnel } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  isServerlessProvider,
  readArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { hostingDrift } from "../hosting/drift";
import { localDrift } from "../localhost/drift";
import { previewServer, previewServerAddress } from "../previews/host";
import { planProvider, providerProfile } from "../providers";
import { checkProvider } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import { ownEngineEnv, ownTarget } from "../provision/own";
import { previewDeploymentFiles } from "../provision/render";
import { requireStorageKey } from "../provision/storage";
import { hasDeployment, stringOutput } from "../shared";
import { appDeployed } from "../status/run";
import { cloudflareRulesDrift } from "./cloudflare-rules";
import { firewallDrift } from "./firewalls";
import { cloudRunnerDrift, type HostDrift, ownHostDrift, serverComponentDrift } from "./host";
import {
  compareInfrastructure,
  driftEngine,
  finishDriftReport,
  inspectState,
  stateHoldsNothing,
  storageDrift,
} from "./infra";
import { monitoringDrift } from "./monitoring";
import { portainerDrift } from "./portainer";
import { appZoneDrift, previewRecipeDrift } from "./previews";
import { namedDifferences, type ServersDriftOptions, serversDrift } from "./servers";
import { siteDrift } from "./site";
import type { DriftedResource, DriftOptions, DriftReport } from "./types";

/**
 * A server the user owns whose plan manages nothing on Cloudflare (no DNS, no tunnel) has no cloud
 * resources at all: its check is the server alone, so missing or empty state is no reason to stop.
 */
async function ownWithoutCloudResources(plan: DeployPlan, statePath: string): Promise<boolean> {
  if (plan.target.provider !== "own") return false;
  if (plan.dns.provider === "cloudflare" || usesTunnel(plan)) return false;
  return stateHoldsNothing(statePath);
}

/** Shown when a server the user owns has no cloud resources to compare. */
const NO_CLOUD_RESOURCES_NOTE =
  "OpsCrew manages no DNS records or tunnel for this app, so there are no cloud resources to compare; only your server and the generated files were checked.";

/**
 * `opscrew drift`: compares the live infrastructure with the state (refresh-only plan, changes made
 * outside OpsCrew), the state with the infrastructure code (normal plan, changes not applied yet)
 * and the repository's generated files with what OpsCrew renders from `opscrew/plan.yaml`; the
 * app's bucket at a provider, once created, the same way in its own root and state.
 * Read-only: never applies, writes its plan files under `.opscrew/plans/drift-*.tfplan` without a
 * sidecar (so they can never be approved) and deletes them afterwards, even on errors. Stops with
 * `PHASE_PRECONDITION` while `opscrew retarget` is moving the deployment.
 *
 * On a server the user owns (FR-911) the infrastructure is Cloudflare's alone (DNS, tunnel,
 * Access), planned with the server's address only in `TF_VAR_*`; then OpsCrew connects with the
 * pinned host key, inspects the server read-only and reports every way it differs from OpsCrew's
 * host record and setup (`report.host`). Without DNS or a tunnel there are no cloud resources, so
 * missing state is no reason to stop there.
 *
 * In the user's Portainer (FR-1013) it compares the stacks, the registry entry and the deploy
 * branch with what OpsCrew sets up now (`report.portainer`, see `portainerDrift`).
 *
 * On Cloudflare's hosting and GitHub Pages it compares the site with its plan and its IaC state
 * (`report.site`, see `siteDrift`).
 *
 * On a hosting account it compares the account and the agent's deploy key with OpsCrew's record and
 * the committed files (`report.hosting`, see `hostingDrift`).
 *
 * In a preview environment it also compares the recipe on the preview server with the committed
 * one (`previewRecipeDrift`).
 */
export async function runDrift(deps: PhaseDeps, options: DriftOptions = {}): Promise<DriftReport> {
  const services = options.services ?? {};
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const ownServer = plan.target.provider === "own";
  // Previews on another environment's server (spec.md US9): only their root and their recipe are
  // theirs; the server and its setup are that environment's (`opscrew drift --env <it>`).
  const sharedHost = plan.environment?.previews?.server?.environment;

  // 1. Preconditions: no move in progress, a deployment and its state (no network yet)
  requireNoMoveInProgress(plan);
  if (!hasDeployment(plan)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Nothing is deployed yet, so there is nothing to check for drift.",
      { hint: "Run `opscrew provision` first." },
    );
  }
  if (plan.target.provider === "portainer") return portainerDrift(deps, plan, options);
  if (plan.target.provider === "localhost") return localDrift(deps, plan);
  if (plan.target.provider === "hosting") return hostingDrift(deps, plan);
  if (isServerlessProvider(plan.target.provider)) return siteDrift(deps, plan, options);
  const statePath = tfstateFile(deps.paths);
  const cloudResources = !(await ownWithoutCloudResources(plan, statePath));
  const stateKind = cloudResources ? await inspectState(deps, statePath) : undefined;

  // 2. Credentials (Cloudflare inside the file preview) and the rendered-file comparison
  const usesCloudflare = plan.dns.provider === "cloudflare";
  const provider = planProvider(plan);
  const cloud = providerProfile(provider).displayName;
  deps.reporter.step(
    sharedHost !== undefined
      ? "Checking your Cloudflare access"
      : ownServer
        ? `Checking the login to your server${usesCloudflare ? " and your Cloudflare access" : ""}`
        : `Checking your ${cloud}${usesCloudflare ? " and Cloudflare" : ""} access`,
  );
  if (sharedHost === undefined) await checkProvider(deps, provider, services);
  const rules = await cloudflareRulesDrift(deps, services);
  // Previews below the app's zone: their certificate pack and Total TLS, in the same zone.
  const zone = await appZoneDrift(deps, plan, services);
  const cloudflareRules =
    rules === undefined && zone.length === 0 ? undefined : [...(rules ?? []), ...zone];
  deps.reporter.step("Comparing the generated files with what OpsCrew renders from the plan");
  const preview = await previewDeploymentFiles(deps, {
    services,
    foreignRecords: "report",
    createDeployKey: false,
  });

  // 3. Engine, state encryption, and 4. the refresh-only plan (drift) and normal plan (pending)
  const { engine, env } = await driftEngine(deps, plan, options, stateKind);
  let drift: DriftedResource[] = [];
  let pending: ResourceChange[] = [];
  let tunnelId: string | undefined;
  const notes: string[] = [];

  if (!cloudResources) {
    notes.push(NO_CLOUD_RESOURCES_NOTE);
  } else {
    const compared = await compareInfrastructure(deps, {
      plan,
      engine,
      engineEnv: env,
      statePath,
      mirrored: providerProfile(provider).mirroredAttributes,
      changedFiles: preview.changed,
      ...(ownServer
        ? {
            // The server's address reaches the engine only as TF_VAR_* (FR-902), as in provision.
            prepare: async (readOutputs) => {
              // On another environment's server, that environment's address (`previewServer`).
              const address =
                sharedHost === undefined
                  ? undefined
                  : await previewServerAddress(await previewServer(deps, plan));
              await ownEngineEnv(
                deps,
                { target: ownTarget(plan), ...(address === undefined ? {} : { address }) },
                env,
                readOutputs,
              );
            },
          }
        : {}),
    });
    // The firewalls the providers' connectors apply (ADR 0029, D8), against the state's outputs.
    drift = [
      ...compared.drift,
      ...(await firewallDrift(deps, plan, compared.outputs, services.firewalls)),
    ];
    pending = compared.pending;
    notes.push(...compared.notes);
    // The connector on the server must run for the tunnel the state holds.
    if (ownServer && usesTunnel(plan)) {
      tunnelId = stringOutput((await compared.outputs()) ?? {}, "tunnel_id");
    }
  }

  // 4b. The app's bucket at a provider, once created (FR-1331).
  const storage = await storageDrift(deps, {
    plan,
    engine,
    engineEnv: env,
    changedFiles: preview.changed,
    key: () => requireStorageKey(deps, plan, services, { command: "opscrew drift", asks: false }),
  });
  drift = [...drift, ...storage.drift];
  pending = [...pending, ...storage.pending];
  notes.push(...storage.notes);

  // 5. A server the user owns: compare the server with OpsCrew's record and setup (read-only);
  // a server OpsCrew created: the app's components, once it was deployed, and the server's runner
  // (read-only, as deploy).
  let host: HostDrift | undefined;
  if (sharedHost !== undefined) {
    const flags = await commandFlags(deps.paths.root, sharedHost, deps.paths.app);
    notes.push(
      `The previews run on ${sharedHost}'s server: \`opscrew drift${flags}\` checks that server and its setup.`,
    );
  } else if (ownServer) {
    host = await ownHostDrift(deps, plan, {
      ...(services.own !== undefined ? { own: services.own } : {}),
      ...(options.hostKey !== undefined ? { hostKey: options.hostKey } : {}),
      ...(tunnelId !== undefined ? { tunnelId } : {}),
      ...(services.cloudflare !== undefined ? { cloudflare: services.cloudflare } : {}),
    });
  } else {
    const components = appDeployed(plan)
      ? await serverComponentDrift(deps, plan, services, notes)
      : undefined;
    const runner = await cloudRunnerDrift(deps, plan, services, notes);
    host =
      runner === undefined
        ? components
        : { differences: [...(components?.differences ?? []), ...runner] };
  }

  // 5b. The private network on every server, and the extra servers' files and containers (feature
  // 018); with extra servers, each of the app server's differences names it too.
  // Each server is inspected once, for its network and its monitoring alike.
  const inspected = new Map<string, Promise<HostFacts>>();
  const inspect: ServersDriftOptions["inspect"] = (remote, options) => {
    const facts = inspected.get(remote.host) ?? inspectHost(remote, options);
    inspected.set(remote.host, facts);
    return facts;
  };
  if (plan.network !== undefined) {
    const servers = await serversDrift(deps, plan, notes, { services, inspect });
    const app = namedDifferences(plan, APP_SERVER, host?.differences ?? []);
    host = { differences: [...app, ...servers] };
  }
  // 5c. Self-hosted monitoring (feature 020): each server's Alloy, and the stack on its server.
  const monitoring = await monitoringDrift(deps, plan, notes, { services, inspect });
  if (monitoring.length > 0) {
    host = { ...host, differences: [...(host?.differences ?? []), ...monitoring] };
  }
  // 5d. A preview environment (feature 022): the recipe on its server against the committed one.
  if (plan.environment?.previews !== undefined) {
    const recipe = await previewRecipeDrift(deps, plan, notes, { services, inspect });
    host = { ...host, differences: [...(host?.differences ?? []), ...recipe] };
  }

  return finishDriftReport(deps, plan, {
    drift,
    pending,
    files: { changed: preview.changed, created: preview.created },
    foreignDnsRecords: preview.foreignDnsRecords ?? [],
    ...(host !== undefined ? { host } : {}),
    ...(cloudflareRules !== undefined ? { cloudflareRules } : {}),
    engine: engine.info,
    provider,
    notes,
  });
}
