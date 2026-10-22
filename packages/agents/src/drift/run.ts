import type { ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { localDrift } from "../localhost/drift";
import { planProvider, providerProfile } from "../providers";
import { checkProvider } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import { ownEngineEnv, ownTarget } from "../provision/own";
import { previewDeploymentFiles } from "../provision/render";
import { requireStorageKey } from "../provision/storage";
import { hasDeployment, stateFile, stringOutput } from "../shared";
import { appDeployed } from "../status/run";
import { cloudflareRulesDrift } from "./cloudflare-rules";
import { type HostDrift, ownHostDrift, serverComponentDrift } from "./host";
import {
  compareInfrastructure,
  driftEngine,
  finishDriftReport,
  inspectState,
  stateHoldsNothing,
  storageDrift,
} from "./infra";
import { portainerDrift } from "./portainer";
import type { DriftOptions, DriftReport } from "./types";

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
 */
export async function runDrift(deps: PhaseDeps, options: DriftOptions = {}): Promise<DriftReport> {
  const services = options.services ?? {};
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const ownServer = plan.target.provider === "own";

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
  const statePath = stateFile(deps.paths);
  const cloudResources = !(await ownWithoutCloudResources(plan, statePath));
  const stateKind = cloudResources ? await inspectState(deps, statePath) : undefined;

  // 2. Credentials (Cloudflare inside the file preview) and the rendered-file comparison
  const usesCloudflare = plan.dns.provider === "cloudflare";
  const provider = planProvider(plan);
  const cloud = providerProfile(provider).displayName;
  deps.reporter.step(
    ownServer
      ? `Checking the login to your server${usesCloudflare ? " and your Cloudflare access" : ""}`
      : `Checking your ${cloud}${usesCloudflare ? " and Cloudflare" : ""} access`,
  );
  await checkProvider(deps, provider, services);
  const cloudflareRules = await cloudflareRulesDrift(deps, services);
  deps.reporter.step("Comparing the generated files with what OpsCrew renders from the plan");
  const preview = await previewDeploymentFiles(deps, {
    services,
    foreignRecords: "report",
    createDeployKey: false,
  });

  // 3. Engine, state encryption, and 4. the refresh-only plan (drift) and normal plan (pending)
  const { engine, env } = await driftEngine(deps, plan, options, stateKind);
  let drift: ResourceDrift[] = [];
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
              await ownEngineEnv(deps, { target: ownTarget(plan) }, env, readOutputs);
            },
          }
        : {}),
    });
    drift = compared.drift;
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
  // a server OpsCrew created: the app's components, once it was deployed (read-only).
  let host: HostDrift | undefined;
  if (ownServer) {
    host = await ownHostDrift(deps, plan, {
      ...(services.own !== undefined ? { own: services.own } : {}),
      ...(options.hostKey !== undefined ? { hostKey: options.hostKey } : {}),
      ...(tunnelId !== undefined ? { tunnelId } : {}),
      ...(services.cloudflare !== undefined ? { cloudflare: services.cloudflare } : {}),
    });
  } else if (appDeployed(plan)) {
    host = await serverComponentDrift(deps, plan, services, notes);
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
