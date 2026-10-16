import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, ResourceAction, ResourceChange } from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths } from "@opscrew/core";
import {
  type EnginePreference,
  engineLabel,
  selectEngine,
  tofuEncryptionEnv,
} from "@opscrew/iac-engine";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readIfExists } from "./files";
import { ensureStatePassphrase, readSecretFile, statePassphraseFile } from "./secret-files";

/** `.opscrew/tfstate/prod.tfstate`: the state file provision, destroy, drift and retarget use. */
export function stateFile(paths: Pick<ProjectPaths, "files">): string {
  return join(paths.files.tfstateDir, "prod.tfstate");
}

/** True when the project's state file exists and is not empty. */
export async function hasState(paths: Pick<ProjectPaths, "files">): Promise<boolean> {
  try {
    return (await stat(stateFile(paths))).size > 0;
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

/** Just enough of a state file to tell an OpenTofu-encrypted one apart. */
const StateEnvelopeSchema = z.looseObject({
  encrypted_data: z.string().optional(),
  encryption_version: z.string().optional(),
});

/**
 * Whether the state file at `statePath` holds managed resources ({@link StateContents}). The engine
 * `engine()` returns (asked for only when the file has content) lists them with `state list` from
 * no root module, so neither the infrastructure code nor a credential is needed; an
 * OpenTofu-encrypted state opens with `TF_ENCRYPTION` from the passphrase on this computer (read,
 * never created), exactly as for every other engine command. A destroy empties the state, encrypted
 * or not, so after a removal it holds `nothing`. `unknown` when the engine cannot read it (no
 * passphrase, Terraform on encrypted state, a damaged file) or no engine is available.
 */
export async function stateContents(
  deps: Pick<PhaseDeps, "env" | "paths" | "redactor">,
  statePath: string,
  engine: () => Promise<IacEngine>,
): Promise<StateContents> {
  const text = await readIfExists(statePath);
  if (text === undefined || text.trim() === "") return "nothing";
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "unknown";
  }
  const envelope = StateEnvelopeSchema.safeParse(raw);
  const encrypted =
    envelope.success &&
    (envelope.data.encrypted_data !== undefined || envelope.data.encryption_version !== undefined);
  let reader: IacEngine;
  try {
    reader = await engine();
  } catch {
    return "unknown"; // no usable engine here: the command's own engine setup says so plainly
  }
  const env: Record<string, string | undefined> = { ...deps.env };
  if (encrypted) {
    if (reader.info.name !== "tofu") return "unknown";
    const passphrase = (await readIfExists(deps.paths.files.statePassphrase))?.trim();
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

/** A string root-module output, when it is set and not empty. */
export function stringOutput(outputs: Record<string, unknown>, name: string): string | undefined {
  const value = outputs[name];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** What engine setup needs from the phase. */
export type EngineDeps = Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor" | "clock">;

/** Picks the IaC engine (default: `selectEngine`; tests pass a fake). */
export type EngineFactory = (preference: EnginePreference) => Promise<IacEngine>;

/** The engine for `preference`: the factory's (a fake in tests), else `selectEngine`'s. */
export function chooseEngine(
  deps: EngineDeps,
  preference: EnginePreference,
  factory?: EngineFactory,
): Promise<IacEngine> {
  if (factory !== undefined) return factory(preference);
  return selectEngine(preference, {
    runner: deps.runner,
    env: deps.env,
    redactor: deps.redactor,
    now: () => deps.clock.now(),
  });
}

/** The project's IaC engine and the environment it runs with. */
export interface ProjectEngine {
  engine: IacEngine;
  /** The phase's environment, with `TF_ENCRYPTION` when OpenTofu encrypts the project's state. */
  env: Record<string, string | undefined>;
}

/** Options of {@link projectEngine}. */
export interface ProjectEngineOptions {
  /** `--engine`; default `plan.infra.engine`. */
  preference?: EnginePreference;
  /** The phase's services; their `engine` picks the engine (a fake in tests). */
  services?: { engine?: EngineFactory };
  /**
   * The state passphrase: made once when missing (`create`, the default: provision); only read,
   * a missing one stopping plainly with the hint to copy it here and run `requiredBy` again
   * (`{ requiredBy: "opscrew destroy" }`: commands that work on an existing state, since a new
   * passphrase could not decrypt it); or used only when it is there (`if-present`: a read that may
   * fail quietly, such as the outputs).
   */
  passphrase?: "create" | "if-present" | { requiredBy: string };
}

/**
 * The project's IaC engine and its environment: the phase's, plus `TF_ENCRYPTION` from the
 * project's state passphrase when the plan encrypts its state and the engine is OpenTofu
 * (Terraform cannot; callers say so where it matters). The passphrase is handled as
 * {@link ProjectEngineOptions.passphrase} says; it is registered with the redactor, and a
 * damaged one stops. Says nothing.
 */
export async function projectEngine(
  deps: EngineDeps,
  plan: Pick<DeployPlan, "infra">,
  options: ProjectEngineOptions = {},
): Promise<ProjectEngine> {
  const engine = await chooseEngine(
    deps,
    options.preference ?? plan.infra.engine,
    options.services?.engine,
  );
  const env: Record<string, string | undefined> = { ...deps.env };
  if (!plan.infra.stateEncryption || engine.info.name !== "tofu") return { engine, env };
  const mode = options.passphrase ?? "create";
  let passphrase: string | undefined;
  if (mode === "create") {
    passphrase = await ensureStatePassphrase(deps.paths);
  } else {
    passphrase = await readSecretFile(statePassphraseFile(deps.paths));
    if (passphrase === undefined) {
      if (mode === "if-present") return { engine, env };
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "The OpenTofu state is encrypted, but this computer does not have its passphrase. Nothing was changed.",
        {
          hint: `Copy the state passphrase file from the computer that ran \`opscrew provision\` to ${deps.paths.files.statePassphrase}, then run \`${mode.requiredBy}\` again.`,
        },
      );
    }
  }
  deps.redactor.addLiteral(passphrase, "state-passphrase");
  env.TF_ENCRYPTION = tofuEncryptionEnv(passphrase);
  return { engine, env };
}

/**
 * The project's engine for the state that is already there ({@link projectEngine}: its passphrase
 * is only read, since a new one could not decrypt that state), saying which engine is used and,
 * with Terraform, that it cannot read a state OpenTofu encrypted (`command --engine tofu` can).
 * `.opscrew/plans` is created for the plans to come.
 */
export async function existingStateEngine(
  deps: EngineDeps & Pick<PhaseDeps, "reporter">,
  plan: Pick<DeployPlan, "infra">,
  options: { engine?: EnginePreference; services?: { engine?: EngineFactory }; command: string },
): Promise<ProjectEngine> {
  const setup = await projectEngine(deps, plan, {
    preference: options.engine,
    services: options.services,
    passphrase: { requiredBy: options.command },
  });
  deps.reporter.info(`Using ${engineLabel(setup.engine.info.name)} ${setup.engine.info.version}.`);
  if (plan.infra.stateEncryption && setup.engine.info.name !== "tofu") {
    deps.reporter.warn(
      `Terraform cannot read state that OpenTofu encrypted. If OpenTofu provisioned this deployment, run \`${options.command} --engine tofu\` instead.`,
    );
  }
  await mkdir(deps.paths.files.plansDir, { recursive: true });
  return setup;
}

/** The sign each planned action is shown with: `+` create, `~` update, `-` delete, `±` replace. */
export const CHANGE_SYMBOL: Readonly<Record<ResourceAction, string>> = {
  create: "+",
  update: "~",
  delete: "-",
  replace: "±",
  read: "?",
  "no-op": " ",
};

/** One line per change, for example `  - delete  module.server.hcloud_server.this`. */
export function describeChanges(
  changes: readonly Pick<ResourceChange, "action" | "address">[],
): string[] {
  return changes.map(
    (change) => `  ${CHANGE_SYMBOL[change.action]} ${change.action.padEnd(7)} ${change.address}`,
  );
}

/** How {@link infrastructureOutputs} reads the outputs. */
export interface OutputsOptions {
  /** Picks the engine (default: `selectEngine` with {@link OutputsOptions.preference}). */
  engine?: EngineFactory;
  /** Engine preference (default: `plan.infra.engine`), for example from `--engine`. */
  preference?: EnginePreference;
  /** Engine environment when the caller already built it (provider tokens, `TF_ENCRYPTION`). */
  engineEnv?: Record<string, string | undefined>;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The root-module outputs in `dir`, read from the local state file `statePath`. An engine reads
 * outputs only once the root module is initialised with that backend path, which a computer with
 * a copy of `.opscrew/tfstate` but no `.terraform/` under the root module has not done: then
 * `init` (with `-backend-config=path=…`, as provision and drift run it) comes first, and it is run
 * once more and the read retried when the first read fails (an old or different initialisation).
 * The `init` is best effort; the read's own failure is what is thrown.
 */
export async function readOutputsAfterInit(
  engine: IacEngine,
  dir: string,
  statePath: string,
  env: Record<string, string | undefined>,
): Promise<Record<string, unknown>> {
  const init = () => engine.init(dir, { env, backendConfig: { path: statePath } }).catch(() => {});
  let initialised = false;
  if (!(await isDirectory(join(dir, ".terraform")))) {
    await init();
    initialised = true;
  }
  try {
    return await engine.output(dir, { env });
  } catch (error) {
    if (initialised) throw error;
    await init();
    return engine.output(dir, { env });
  }
}

/**
 * The root-module outputs from the infrastructure state on this computer
 * (`.opscrew/tfstate/prod.tfstate`, decrypted with the state passphrase when there is one), read
 * with the project's engine; `undefined` without a state file or when the engine cannot read them.
 * Needs no provider credentials.
 */
export async function infrastructureOutputs(
  deps: EngineDeps,
  plan: DeployPlan,
  options: OutputsOptions = {},
): Promise<Record<string, unknown> | undefined> {
  if (!(await hasState(deps.paths))) return undefined;
  try {
    const preference = options.preference ?? plan.infra.engine;
    const { engine, env } =
      options.engineEnv === undefined
        ? await projectEngine(deps, plan, {
            preference,
            services: { engine: options.engine },
            passphrase: "if-present",
          })
        : {
            engine: await chooseEngine(deps, preference, options.engine),
            env: options.engineEnv,
          };
    return await readOutputsAfterInit(
      engine,
      join(deps.paths.root, plan.infra.dir),
      stateFile(deps.paths),
      env,
    );
  } catch {
    return undefined;
  }
}
