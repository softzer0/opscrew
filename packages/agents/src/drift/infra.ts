import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { OpsCrewError, toPosixRelative } from "@opscrew/core";
import { engineLabel } from "@opscrew/iac-engine";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { type ProjectEngine, projectEngine, readIfExists } from "../shared";
import {
  type AttributesByType,
  mergeAttributes,
  providerReadOnlyAttributes,
  SCHEMA_UNREADABLE_NOTE,
  withoutIgnored,
} from "./schema";
import type { DriftOptions, DriftReport } from "./types";

/** Just enough of a state file to tell empty, plain and OpenTofu-encrypted state apart. */
const StateFileSchema = z.looseObject({
  resources: z.array(z.unknown()).optional(),
  encrypted_data: z.string().optional(),
  encryption_version: z.string().optional(),
});

export type StateKind = "plain" | "encrypted" | "unknown";

/**
 * Classifies the state file and refuses when it is missing or empty: planning against empty state
 * would report every resource as new.
 */
export async function inspectState(deps: PhaseDeps, statePath: string): Promise<StateKind> {
  const relative = toPosixRelative(deps.paths.root, statePath);
  const text = await readIfExists(statePath);
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
export async function stateHoldsNothing(statePath: string): Promise<boolean> {
  const text = await readIfExists(statePath);
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
 * The engine `opscrew drift` plans with and its environment (`projectEngine`): the state
 * passphrase is only read, never created, and required when there is a state to compare
 * (`stateKind`). Terraform cannot read OpenTofu-encrypted state, which stops plainly. Says which
 * engine it uses.
 */
export async function driftEngine(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DriftOptions,
  stateKind: StateKind | undefined,
): Promise<ProjectEngine> {
  const project = await projectEngine(deps, plan, {
    ...(options.engine !== undefined ? { preference: options.engine } : {}),
    ...(options.services !== undefined ? { services: options.services } : {}),
    passphrase: stateKind === undefined ? "if-present" : { requiredBy: "opscrew drift" },
  });
  if (stateKind === "encrypted" && project.engine.info.name === "terraform") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "The infrastructure state was written by OpenTofu with encryption, and Terraform cannot read encrypted state. Nothing was checked.",
      {
        hint: "Run `opscrew drift --engine tofu` (install OpenTofu 1.6 or newer first if it is missing).",
      },
    );
  }
  const { info } = project.engine;
  deps.reporter.info(`Using ${engineLabel(info.name)} ${info.version}.`);
  return project;
}

/** What {@link compareInfrastructure} found. */
export interface InfrastructureComparison {
  drift: ResourceDrift[];
  pending: ResourceChange[];
  notes: string[];
  /** The root module's outputs (read once, after `init`; `undefined` when unreadable). */
  outputs: () => Promise<Record<string, unknown> | undefined>;
}

/**
 * The read-only part of `opscrew drift` on the infrastructure code: `init`, a refresh-only plan
 * (changes made outside OpsCrew, without values the cloud maintains itself) and a normal plan
 * (changes not applied yet). Both plan files are written under `.opscrew/plans/drift-*.tfplan`
 * without a sidecar, so they can never be approved, and deleted afterwards, even on errors.
 * `prepare` runs after `init`, before the plans (it may set `TF_VAR_*` in `engineEnv`);
 * `changedFiles` are named when a plan fails.
 */
export async function compareInfrastructure(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    engine: IacEngine;
    engineEnv: Record<string, string | undefined>;
    statePath: string;
    mirrored: AttributesByType;
    changedFiles: readonly string[];
    prepare?: (outputs: () => Promise<Record<string, unknown> | undefined>) => Promise<void>;
  },
): Promise<InfrastructureComparison> {
  const { plan, engine, engineEnv, statePath } = input;
  const notes: string[] = [];
  const dir = join(deps.paths.root, plan.infra.dir);
  const stamp = deps.clock.now().toISOString().replace(/[:.]/g, "-");
  const refreshFile = join(deps.paths.files.plansDir, `drift-${stamp}-refresh.tfplan`);
  const pendingFile = join(deps.paths.files.plansDir, `drift-${stamp}-pending.tfplan`);
  let outputs: Record<string, unknown> | undefined;
  let read = false;
  const readOutputs = async () => {
    if (!read) {
      outputs = await engine.output(dir, { env: engineEnv }).catch(() => undefined);
      read = true;
    }
    return outputs;
  };
  try {
    await mkdir(deps.paths.files.plansDir, { recursive: true });
    deps.reporter.step(`Initialising ${engineLabel(engine.info.name)} in ${plan.infra.dir}`);
    await engine.init(dir, { env: engineEnv, backendConfig: { path: statePath } });
    await input.prepare?.(readOutputs);
    deps.reporter.step("Reading the live infrastructure (nothing is changed)");
    const refreshed = await engine.plan(dir, refreshFile, { env: engineEnv, refreshOnly: true });
    const refreshedDrift = refreshed.drift ?? [];
    // Values the cloud maintains itself (status, counts, timestamps) change on every refresh; the
    // provider schema names them, so read it (once, offline) only when something was updated.
    const readOnly = refreshedDrift.some((entry) => entry.action === "update")
      ? await providerReadOnlyAttributes(engine, dir, engineEnv)
      : {};
    const drift = withoutIgnored(refreshedDrift, mergeAttributes(input.mirrored, readOnly ?? {}));
    if (readOnly === undefined && drift.some((entry) => entry.action === "update")) {
      notes.push(SCHEMA_UNREADABLE_NOTE);
    }
    deps.reporter.step("Comparing the state with the infrastructure code (nothing is applied)");
    const planned = await engine.plan(dir, pendingFile, { env: engineEnv });
    return { drift, pending: planned.changes, notes, outputs: readOutputs };
  } catch (error) {
    if (input.changedFiles.length > 0) {
      deps.reporter.warn(
        `These generated files were edited and may be the cause: ${input.changedFiles.join(", ")}.`,
      );
    }
    throw error;
  } finally {
    await Promise.all([rm(refreshFile, { force: true }), rm(pendingFile, { force: true })]);
  }
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const byAddress = (a: { address: string }, b: { address: string }) => byText(a.address, b.address);

/**
 * The drift report from what a check found: resources by address (with their attribute names
 * sorted), files by path, foreign DNS records by name, type and content; `clean` when nothing
 * differs anywhere; the notes redacted. The check is audited by its counts.
 */
export async function finishDriftReport(
  deps: Pick<PhaseDeps, "audit" | "clock" | "redactor">,
  plan: Pick<DeployPlan, "infra">,
  found: Omit<DriftReport, "clean" | "checkedAt" | "notes"> & { notes: readonly string[] },
): Promise<DriftReport> {
  const drift = found.drift
    .map((entry) => ({ ...entry, attributes: [...entry.attributes].sort(byText) }))
    .sort(byAddress);
  const pending = [...found.pending].sort(byAddress);
  const files = {
    changed: [...found.files.changed].sort(byText),
    created: [...found.files.created].sort(byText),
  };
  const foreignDnsRecords = [...found.foreignDnsRecords].sort(
    (a, b) => byText(a.name, b.name) || byText(a.type, b.type) || byText(a.content, b.content),
  );
  const hostDifferences = found.host?.differences.length ?? 0;
  const portainerDifferences = found.portainer?.differences.length ?? 0;
  const clean =
    drift.length === 0 &&
    pending.length === 0 &&
    files.changed.length === 0 &&
    files.created.length === 0 &&
    foreignDnsRecords.length === 0 &&
    hostDifferences === 0 &&
    portainerDifferences === 0;
  const { notes, ...rest } = found;
  const report: DriftReport = {
    ...rest,
    drift,
    pending,
    files,
    foreignDnsRecords,
    clean,
    checkedAt: deps.clock.now().toISOString(),
    ...(notes.length > 0 ? { notes: notes.map((note) => deps.redactor.redact(note)) } : {}),
  };
  await deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action: "drift-check",
    target: plan.infra.dir,
    detail: clean
      ? "no drift"
      : `${drift.length} changed outside OpsCrew, ${pending.length} pending, ${files.changed.length + files.created.length} files differ${found.host !== undefined ? `, ${hostDifferences} differences on the server` : ""}${found.portainer !== undefined ? `, ${portainerDifferences} differences in Portainer` : ""}`,
  });
  return report;
}
