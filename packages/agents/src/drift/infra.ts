import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, ResourceChange, ResourceDrift } from "@opscrew/contracts";
import { OpsCrewError, toPosixRelative } from "@opscrew/core";
import {
  type EnginePreference,
  engineLabel,
  readsStateResources,
  selectEngine,
  tofuEncryptionEnv,
} from "@opscrew/iac-engine";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { ProvisionServices } from "../provision/types";
import {
  type AttributesByType,
  mergeAttributes,
  providerReadOnlyAttributes,
  SCHEMA_UNREADABLE_NOTE,
  withoutIgnored,
} from "./schema";
import type { DriftOptions } from "./types";

/** The engine state file `opscrew provision` uses (local backend). */
export const STATE_FILE = "prod.tfstate";

/** Just enough of a state file to tell empty, plain and OpenTofu-encrypted state apart. */
const StateFileSchema = z.looseObject({
  resources: z.array(z.unknown()).optional(),
  encrypted_data: z.string().optional(),
  encryption_version: z.string().optional(),
});

export type StateKind = "plain" | "encrypted" | "unknown";

export async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export const byAddress = (a: { address: string }, b: { address: string }) =>
  a.address < b.address ? -1 : a.address > b.address ? 1 : 0;

/**
 * Classifies the state file and refuses when it is missing or empty: planning against empty state
 * would report every resource as new.
 */
export async function inspectState(deps: PhaseDeps, statePath: string): Promise<StateKind> {
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
export async function stateHoldsNothing(statePath: string): Promise<boolean> {
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
 * What the infrastructure state holds: `resources` when it has at least one managed resource,
 * `nothing` when the file is missing or blank or has none (outputs and data sources do not count:
 * they are no infrastructure), `unknown` when it cannot be read.
 */
export type StateContents = "resources" | "nothing" | "unknown";

/** Just enough of a plain state file (format 4) to count its managed resource instances. */
const PlainStateSchema = z.looseObject({
  resources: z.array(
    z.looseObject({
      mode: z.string().optional(),
      instances: z.array(z.unknown()).optional(),
    }),
  ),
});

/** Managed resources in a plain state file parsed here (an engine without `stateResources`). */
function plainContents(raw: unknown): StateContents {
  const state = PlainStateSchema.safeParse(raw);
  if (!state.success) return "unknown";
  // Data sources (`mode: "data"`) are only read; anything else counts unless it has no instance.
  const managed = state.data.resources.some(
    (resource) =>
      resource.mode !== "data" &&
      (resource.instances === undefined || resource.instances.length > 0),
  );
  return managed ? "resources" : "nothing";
}

/**
 * Whether the state file at `statePath` holds managed resources ({@link StateContents}). The engine
 * `engine()` returns (asked for only when the file has content) lists them with `state list` from
 * no root module, so neither the infrastructure code nor a credential is needed; an
 * OpenTofu-encrypted state opens with `TF_ENCRYPTION` from the passphrase on this computer (read,
 * never created), exactly as for every other engine command. A destroy empties the state, encrypted
 * or not, so after a removal it holds `nothing`. `unknown` when the engine cannot read it (no
 * passphrase, Terraform on encrypted state, a damaged file) or no engine is available. An engine
 * without that capability (a test fake) gets a plain state counted here and `unknown` for an
 * encrypted one.
 */
export async function stateContents(
  deps: Pick<PhaseDeps, "env" | "paths" | "redactor">,
  statePath: string,
  engine: () => Promise<IacEngine>,
): Promise<StateContents> {
  const text = await readOptional(statePath);
  if (text === undefined || text.trim() === "") return "nothing";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "unknown";
  }
  const envelope = StateFileSchema.safeParse(raw);
  const encrypted =
    envelope.success &&
    (envelope.data.encrypted_data !== undefined || envelope.data.encryption_version !== undefined);
  let reader: IacEngine;
  try {
    reader = await engine();
  } catch {
    return "unknown"; // no usable engine here: the command's own engine setup says so plainly
  }
  if (!readsStateResources(reader)) return encrypted ? "unknown" : plainContents(raw);
  const env: Record<string, string | undefined> = { ...deps.env };
  if (encrypted) {
    if (reader.info.name !== "tofu") return "unknown";
    const passphrase = (await readOptional(deps.paths.files.statePassphrase))?.trim();
    if (!passphrase) return "unknown";
    deps.redactor.addLiteral(passphrase, "state-passphrase");
    try {
      env.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
    } catch {
      return "unknown"; // a passphrase too short for OpenTofu cannot have encrypted it
    }
  }
  try {
    return (await reader.stateResources(statePath, { env })).length > 0 ? "resources" : "nothing";
  } catch {
    return "unknown";
  }
}

/**
 * The engine for reading a state file: the services' fake, or `selectEngine` for `preference`.
 * Prints nothing (the command's own engine setup says which engine it uses).
 */
export async function stateEngine(
  deps: Pick<PhaseDeps, "runner" | "env" | "redactor" | "clock">,
  preference: EnginePreference,
  services: Pick<ProvisionServices, "engine"> = {},
): Promise<IacEngine> {
  return services.engine
    ? services.engine(preference)
    : selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
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

/** The engine `opscrew drift` plans with: the services' fake, or `selectEngine`. */
export async function driftEngine(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: DriftOptions,
): Promise<IacEngine> {
  const preference = options.engine ?? plan.infra.engine;
  const engine = options.services?.engine
    ? await options.services.engine(preference)
    : await selectEngine(preference, {
        runner: deps.runner,
        env: deps.env,
        redactor: deps.redactor,
        now: () => deps.clock.now(),
      });
  deps.reporter.info(`Using ${engineLabel(engine.info.name)} ${engine.info.version}.`);
  return engine;
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
 * The read-only part of `opscrew drift` on the infrastructure code: state encryption, `init`, a
 * refresh-only plan (changes made outside OpsCrew, without values the cloud maintains itself) and
 * a normal plan (changes not applied yet). Both plan files are written under
 * `.opscrew/plans/drift-*.tfplan` without a sidecar, so they can never be approved, and deleted
 * afterwards, even on errors. `prepare` runs after `init`, before the plans (it may set
 * `TF_VAR_*` in `engineEnv`); `changedFiles` are named when a plan fails.
 */
export async function compareInfrastructure(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    engine: IacEngine;
    engineEnv: Record<string, string | undefined>;
    statePath: string;
    stateKind: StateKind;
    mirrored: AttributesByType;
    changedFiles: readonly string[];
    prepare?: (outputs: () => Promise<Record<string, unknown> | undefined>) => Promise<void>;
  },
): Promise<InfrastructureComparison> {
  const { plan, engine, engineEnv, statePath } = input;
  const notes: string[] = [];
  const encryption = await encryptionEnv(deps, engine, input.stateKind, plan.infra.stateEncryption);
  if (encryption !== undefined) engineEnv.TF_ENCRYPTION = encryption;
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
    const drift = withoutIgnored(
      refreshedDrift,
      mergeAttributes(input.mirrored, readOnly ?? {}),
    ).sort(byAddress);
    if (readOnly === undefined && drift.some((entry) => entry.action === "update")) {
      notes.push(SCHEMA_UNREADABLE_NOTE);
    }
    deps.reporter.step("Comparing the state with the infrastructure code (nothing is applied)");
    const planned = await engine.plan(dir, pendingFile, { env: engineEnv });
    const pending = [...planned.changes].sort(byAddress);
    return { drift, pending, notes, outputs: readOutputs };
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
