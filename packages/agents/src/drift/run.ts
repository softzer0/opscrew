import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { OpsCrewError, toPosixRelative } from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import { checkProvider } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import { ownEngineEnv, ownTarget } from "../provision/own";
import { previewDeploymentFiles } from "../provision/render";
import { hasDeployment } from "../shared";
import { type HostDrift, ownHostDrift } from "./host";
import {
  mergeAttributes,
  providerReadOnlyAttributes,
  SCHEMA_UNREADABLE_NOTE,
  withoutIgnored,
} from "./schema";
import type { DriftOptions, DriftReport } from "./types";

/** The engine state file `opscrew provision` uses (local backend). */
const STATE_FILE = "prod.tfstate";

/** Just enough of a state file to tell empty, plain and OpenTofu-encrypted state apart. */
const StateFileSchema = z.looseObject({
  resources: z.array(z.unknown()).optional(),
  encrypted_data: z.string().optional(),
  encryption_version: z.string().optional(),
});

type StateKind = "plain" | "encrypted" | "unknown";

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

const byAddress = (a: { address: string }, b: { address: string }) =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0;

/**
 * Classifies the state file and refuses when it is missing or empty: planning against empty state
 * would report every resource as new.
 */
async function inspectState(deps: PhaseDeps, statePath: string): Promise<StateKind> {
  const relative = toPosixRelative(deps.paths.root, statePath);
  const text = await readOptional(statePath);
  const copyHint = `The state lives on the computer that ran \`opscrew provision\`, in ${relative} inside the project. Copy the .opscrew/tfstate folder from there into this project (with OpenTofu state encryption, also copy the state passphrase file; on this computer OpsCrew reads it from ${deps.paths.files.statePassphrase}), then run \`opscrew drift\` again.`;
  if (text === undefined || text.trim() === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `No infrastructure state found at ${relative}, so OpsCrew cannot tell what it created. Nothing was checked.`,
      { hint: copyHint },
    );
  }
  let parsed: z.infer<typeof StateFileSchema> | undefined;
  try {
    const result = StateFileSchema.safeParse(JSON.parse(text));
    parsed = result.success ? result.data : undefined;
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) return "unknown";
  if (parsed.encrypted_data !== undefined || parsed.encryption_version !== undefined) {
    return "encrypted";
  }
  if (parsed.resources !== undefined && parsed.resources.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The infrastructure state at ${relative} is empty, so OpsCrew cannot tell what it created. Nothing was checked.`,
      { hint: copyHint },
    );
  }
  return "plain";
}

/** True when the state file is missing, blank or holds no resources (OpenTofu-encrypted is not). */
async function stateHoldsNothing(statePath: string): Promise<boolean> {
  const text = await readOptional(statePath);
  if (text === undefined || text.trim() === "") return true;
  try {
    const parsed = StateFileSchema.safeParse(JSON.parse(text));
    return (
      parsed.success && parsed.data.resources !== undefined && parsed.data.resources.length === 0
    );
  } catch {
    return false;
  }
}

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

/** `TF_ENCRYPTION` for OpenTofu from the existing passphrase; never creates a new one. */
async function encryptionEnv(
  deps: PhaseDeps,
  engine: IacEngine,
  stateKind: StateKind,
  stateEncryption: boolean,
): Promise<string | undefined> {
  if (stateKind === "encrypted" && engine.info.name === "terraform") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The infrastructure state was written by OpenTofu with encryption, and Terraform cannot read encrypted state. Nothing was checked.",
      {
        hint: "Run `opscrew drift --engine tofu` (install OpenTofu 1.6 or newer first if it is missing).",
      },
    );
  }
  if (engine.info.name !== "tofu" || !(stateEncryption || stateKind === "encrypted")) {
    return undefined;
  }
  const passphrase = (await readOptional(deps.paths.files.statePassphrase))?.trim();
  if (!passphrase) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The OpenTofu state is encrypted, but this computer does not have its passphrase. Nothing was checked.",
      {
        hint: `Copy the state passphrase file from the computer that ran \`opscrew provision\` to ${deps.paths.files.statePassphrase}, then run \`opscrew drift\` again.`,
      },
    );
  }
  deps.redactor.addLiteral(passphrase, "state-passphrase");
  return tofuEncryptionEnv(passphrase);
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

  // 3. Engine and state encryption
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
  const engineEnv: Record<string, string | undefined> = { ...deps.env };
  const dir = join(deps.paths.root, plan.infra.dir);
  let drift: ResourceDrift[] = [];
  let pending: ResourceChange[] = [];
  let tunnelId: string | undefined;
  const notes: string[] = [];

  if (!cloudResources) {
    notes.push(NO_CLOUD_RESOURCES_NOTE);
  } else {
    const encryption = await encryptionEnv(deps, engine, stateKind, plan.infra.stateEncryption);
    if (encryption !== undefined) engineEnv.TF_ENCRYPTION = encryption;

    // 4. Refresh-only plan (drift) and normal plan (pending), both discarded afterwards
    const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
    const refreshFile = join(deps.paths.files.plansDir, `drift-${stamp}-refresh.tfplan`);
    const pendingFile = join(deps.paths.files.plansDir, `drift-${stamp}-pending.tfplan`);
    try {
      await mkdir(deps.paths.files.plansDir, { recursive: true });
      deps.reporter.step(`Initialising ${engineLabel(engine.info.name)} in ${plan.infra.dir}`);
      await engine.init(dir, { env: engineEnv, backendConfig: { path: statePath } });
      let outputs: Record<string, unknown> | undefined;
      const readOutputs = async () => {
        outputs ??= await engine.output(dir, { env: engineEnv }).catch(() => undefined);
        return outputs;
      };
      if (ownServer) {
        // The server's address reaches the engine only as TF_VAR_* (FR-902), as in provision.
        await ownEngineEnv(deps, { target: ownTarget(plan) }, engineEnv, readOutputs);
      }
      deps.reporter.step("Reading the live infrastructure (nothing is changed)");
      const refreshed = await engine.plan(dir, refreshFile, { env: engineEnv, refreshOnly: true });
      const refreshedDrift = refreshed.drift ?? [];
      // Values the cloud maintains itself (status, counts, timestamps) change on every refresh; the
      // provider schema names them, so read it (once, offline) only when something was updated.
      const readOnly = refreshedDrift.some((entry) => entry.action === "update")
        ? await providerReadOnlyAttributes(engine, dir, engineEnv)
        : {};
      drift = withoutIgnored(
        refreshedDrift,
        mergeAttributes(providerProfile(provider).mirroredAttributes, readOnly ?? {}),
      ).sort(byAddress);
      if (readOnly === undefined && drift.some((entry) => entry.action === "update")) {
        notes.push(SCHEMA_UNREADABLE_NOTE);
      }
      deps.reporter.step("Comparing the state with the infrastructure code (nothing is applied)");
      const planned = await engine.plan(dir, pendingFile, { env: engineEnv });
      pending = [...planned.changes].sort(byAddress);
      // The connector on the server must run for the tunnel the state holds.
      if (ownServer && usesTunnel(plan)) tunnelId = stringOutput(await readOutputs(), "tunnel_id");
    } catch (error) {
      if (preview.changed.length > 0) {
        deps.reporter.warn(
          `These generated files were edited and may be the cause: ${preview.changed.join(", ")}.`,
        );
      }
      throw error;
    } finally {
      await Promise.all([rm(refreshFile, { force: true }), rm(pendingFile, { force: true })]);
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
