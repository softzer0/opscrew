import { join } from "node:path";
import type { ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import { checkProvider } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import { ownEngineEnv, ownTarget } from "../provision/own";
import { previewDeploymentFiles } from "../provision/render";
import { hasDeployment } from "../shared";
import { type HostDrift, ownHostDrift } from "./host";
import {
  compareInfrastructure,
  driftEngine,
  inspectState,
  STATE_FILE,
  stateHoldsNothing,
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

function stringOutput(outputs: Record<string, unknown> | undefined, name: string) {
  const value = outputs?.[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * `opscrew drift`: compares the live infrastructure with the state (refresh-only plan, changes made
 * outside OpsCrew), the state with the infrastructure code (normal plan, changes not applied yet)
 * and the repository's generated files with what OpsCrew renders from `opscrew/plan.yaml`.
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
  const statePath = join(deps.paths.files.tfstateDir, STATE_FILE);
  const cloudResources = !(await ownWithoutCloudResources(plan, statePath));
  const stateKind = cloudResources ? await inspectState(deps, statePath) : "unknown";

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
  deps.reporter.step("Comparing the generated files with what OpsCrew renders from the plan");
  const preview = await previewDeploymentFiles(deps, {
    services,
    foreignRecords: "report",
    createDeployKey: false,
  });

  // 3. Engine, state encryption, and 4. the refresh-only plan (drift) and normal plan (pending)
  const engine = await driftEngine(deps, plan, options);
  const engineEnv: Record<string, string | undefined> = { ...deps.env };
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
      engineEnv,
      statePath,
      stateKind,
      mirrored: providerProfile(provider).mirroredAttributes,
      changedFiles: preview.changed,
      ...(ownServer
        ? {
            // The server's address reaches the engine only as TF_VAR_* (FR-902), as in provision.
            prepare: async (readOutputs) => {
              await ownEngineEnv(deps, { target: ownTarget(plan) }, engineEnv, readOutputs);
            },
          }
        : {}),
    });
    drift = compared.drift;
    pending = compared.pending;
    notes.push(...compared.notes);
    // The connector on the server must run for the tunnel the state holds.
    if (ownServer && usesTunnel(plan)) {
      tunnelId = stringOutput(await compared.outputs(), "tunnel_id");
    }
  }

  // 5. A server the user owns: compare the server with OpsCrew's record and setup (read-only)
  let host: HostDrift | undefined;
  if (ownServer) {
    host = await ownHostDrift(deps, plan, {
      ...(services.own !== undefined ? { own: services.own } : {}),
      ...(options.hostKey !== undefined ? { hostKey: options.hostKey } : {}),
      ...(tunnelId !== undefined ? { tunnelId } : {}),
      ...(services.cloudflare !== undefined ? { cloudflare: services.cloudflare } : {}),
    });
  }

  const files = {
    changed: [...preview.changed].sort(),
    created: [...preview.created].sort(),
  };
  const foreignDnsRecords = [...(preview.foreignDnsRecords ?? [])].sort((a, b) =>
    `${a.name} ${a.type}`.localeCompare(`${b.name} ${b.type}`),
  );
  const hostDifferences = host?.differences.length ?? 0;
  const clean =
    drift.length === 0 &&
    pending.length === 0 &&
    files.changed.length === 0 &&
    files.created.length === 0 &&
    foreignDnsRecords.length === 0 &&
    hostDifferences === 0;
  const report: DriftReport = {
    drift,
    pending,
    files,
    foreignDnsRecords,
    ...(host !== undefined ? { host } : {}),
    clean,
    engine: engine.info,
    checkedAt: deps.clock.now().toISOString(),
    provider,
    ...(notes.length > 0 ? { notes } : {}),
  };
  await deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action: "drift-check",
    target: plan.infra.dir,
    detail: clean
      ? "no drift"
      : `${drift.length} changed outside OpsCrew, ${pending.length} pending, ${files.changed.length + files.created.length} files differ${host !== undefined ? `, ${hostDifferences} differences on the server` : ""}`,
  });
  return report;
}
