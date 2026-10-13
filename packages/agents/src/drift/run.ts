import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { OpsCrewError, toPosixRelative } from "@opscrew/core";
import { engineLabel, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import { checkProvider } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import { previewDeploymentFiles } from "../provision/render";
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
 */
export async function runDrift(deps: PhaseDeps, options: DriftOptions = {}): Promise<DriftReport> {
  const services = options.services ?? {};
  const plan = await readArtifact("plan", deps.paths.files.plan);

  // 1. Preconditions: no move in progress, a deployment and its state (no network yet)
  requireNoMoveInProgress(plan);
  if (!plan.deployment.serverIpv4 || plan.deployment.destroyedAt !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "Nothing is deployed yet, so there is nothing to check for drift.",
      { hint: "Run `opscrew provision` first." },
    );
  }
  const statePath = join(deps.paths.files.tfstateDir, STATE_FILE);
  const stateKind = await inspectState(deps, statePath);

  // 2. Credentials (Cloudflare inside the file preview) and the rendered-file comparison
  const usesCloudflare = plan.dns.provider === "cloudflare";
  const provider = planProvider(plan);
  const cloud = providerProfile(provider).displayName;
  deps.reporter.step(`Checking your ${cloud}${usesCloudflare ? " and Cloudflare" : ""} access`);
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
  const encryption = await encryptionEnv(deps, engine, stateKind, plan.infra.stateEncryption);
  if (encryption !== undefined) engineEnv.TF_ENCRYPTION = encryption;

  // 4. Refresh-only plan (drift) and normal plan (pending), both discarded afterwards
  const dir = join(deps.paths.root, plan.infra.dir);
  const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
  const refreshFile = join(deps.paths.files.plansDir, `drift-${stamp}-refresh.tfplan`);
  const pendingFile = join(deps.paths.files.plansDir, `drift-${stamp}-pending.tfplan`);
  let drift: ResourceDrift[];
  let pending: ResourceChange[];
  try {
    await mkdir(deps.paths.files.plansDir, { recursive: true });
    deps.reporter.step(`Initialising ${engineLabel(engine.info.name)} in ${plan.infra.dir}`);
    await engine.init(dir, { env: engineEnv, backendConfig: { path: statePath } });
    deps.reporter.step("Reading the live infrastructure (nothing is changed)");
    const refreshed = await engine.plan(dir, refreshFile, { env: engineEnv, refreshOnly: true });
    drift = [...(refreshed.drift ?? [])].sort(byAddress);
    deps.reporter.step("Comparing the state with the infrastructure code (nothing is applied)");
    const planned = await engine.plan(dir, pendingFile, { env: engineEnv });
    pending = [...planned.changes].sort(byAddress);
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

  const files = {
    changed: [...preview.changed].sort(),
    created: [...preview.created].sort(),
  };
  const foreignDnsRecords = [...(preview.foreignDnsRecords ?? [])].sort((a, b) =>
    `${a.name} ${a.type}`.localeCompare(`${b.name} ${b.type}`),
  );
  const clean =
    drift.length === 0 &&
    pending.length === 0 &&
    files.changed.length === 0 &&
    files.created.length === 0 &&
    foreignDnsRecords.length === 0;
  const report: DriftReport = {
    drift,
    pending,
    files,
    foreignDnsRecords,
    clean,
    engine: engine.info,
    checkedAt: deps.clock.now().toISOString(),
    provider,
  };
  await deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action: "drift-check",
    target: plan.infra.dir,
    detail: clean
      ? "no drift"
      : `${drift.length} changed outside OpsCrew, ${pending.length} pending, ${files.changed.length + files.created.length} files differ`,
  });
  return report;
}
