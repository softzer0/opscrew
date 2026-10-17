import type { CommandRunner, IacEngine, IacEngineInfo, IacEngineName } from "@opscrew/contracts";
import {
  findExecutable as defaultFindExecutable,
  errorMessage,
  NodeCommandRunner,
  OpsCrewError,
} from "@opscrew/core";
import { createEngine, type EngineOptions, engineLabel } from "./engine";

/** Oldest supported engine version (both OpenTofu and Terraform). */
export const MIN_ENGINE_VERSION = "1.6.0";

/** Which engine to use: a specific one, or `auto` (OpenTofu when available, else Terraform). */
export type EnginePreference = IacEngineName | "auto";

export interface DetectOptions {
  /** Environment used for `OPSCREW_*_BIN` and `PATH` lookups and for `version -json`. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Runs `<bin> version -json`. Default `NodeCommandRunner`. */
  runner?: CommandRunner;
  /** PATH lookup; default `findExecutable` from `@opscrew/core`. */
  findExecutable?: (name: string, env: Record<string, string | undefined>) => string | undefined;
}

/** A binary that was found, with its version and whether OpsCrew can use it. */
export interface DetectedEngine extends IacEngineInfo {
  /** Where the binary came from. */
  source: "env" | "path";
  /** True when the version was read and is at least `MIN_ENGINE_VERSION`. */
  supported: boolean;
  /** Plain-English reason when `supported` is false. */
  problem?: string;
}

const ENGINES: ReadonlyArray<{
  name: IacEngineName;
  envVar: string;
  label: string;
  install: string;
}> = [
  {
    name: "tofu",
    envVar: "OPSCREW_TOFU_BIN",
    label: "OpenTofu",
    install: "https://opentofu.org/docs/intro/install/",
  },
  {
    name: "terraform",
    envVar: "OPSCREW_TERRAFORM_BIN",
    label: "Terraform",
    install: "https://developer.hashicorp.com/terraform/install",
  },
];

const VERSION_TIMEOUT_MS = 60_000;

function parseVersion(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `version` (for example `1.13.1`) is at least `minimum`. */
export function versionAtLeast(version: string, minimum: string = MIN_ENGINE_VERSION): boolean {
  const a = parseVersion(version);
  const b = parseVersion(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

async function readVersion(
  runner: CommandRunner,
  binary: string,
  env: Record<string, string | undefined>,
): Promise<{ version?: string; problem?: string }> {
  try {
    const result = await runner.run(binary, ["version", "-json"], {
      env: { ...env, CHECKPOINT_DISABLE: "1" },
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      return { problem: `\`${binary} version -json\` failed (exit code ${result.exitCode}).` };
    const parsed: unknown = JSON.parse(result.stdout);
    const version = (parsed as { terraform_version?: unknown } | null)?.terraform_version;
    if (typeof version !== "string" || !parseVersion(version)) {
      return { problem: `\`${binary} version -json\` did not report a version.` };
    }
    return { version };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        problem: `\`${binary} version -json\` printed something that is not JSON (the version is probably older than ${MIN_ENGINE_VERSION}).`,
      };
    }
    return { problem: `Could not run ${binary}: ${errorMessage(error)}` };
  }
}

/**
 * Finds OpenTofu and Terraform binaries (`OPSCREW_TOFU_BIN` / `OPSCREW_TERRAFORM_BIN` first, then
 * `PATH`) and reads their versions with `version -json`. Returns at most one entry per engine,
 * OpenTofu first. An `OPSCREW_*_BIN` that does not point to an executable is reported as an
 * unsupported entry rather than silently replaced by a `PATH` match.
 */
export async function detectEngines(opts: DetectOptions = {}): Promise<DetectedEngine[]> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? new NodeCommandRunner();
  const find = opts.findExecutable ?? defaultFindExecutable;

  const found = await Promise.all(
    ENGINES.map(async ({ name, envVar, label }): Promise<DetectedEngine | undefined> => {
      const configured = env[envVar]?.trim();
      if (configured) {
        const binary = find(configured, env);
        if (binary === undefined) {
          return {
            name,
            version: "",
            binary: configured,
            source: "env",
            supported: false,
            problem: `${envVar} is set to "${configured}", but no ${label} program was found there.`,
          };
        }
        return describe(name, binary, "env");
      }
      const binary = find(name, env);
      return binary === undefined ? undefined : describe(name, binary, "path");
    }),
  );
  return found.filter((entry): entry is DetectedEngine => entry !== undefined);

  async function describe(
    name: IacEngineName,
    binary: string,
    source: "env" | "path",
  ): Promise<DetectedEngine> {
    const { version, problem } = await readVersion(runner, binary, env);
    if (version === undefined)
      return {
        name,
        version: "",
        binary,
        source,
        supported: false,
        ...(problem ? { problem } : {}),
      };
    if (!versionAtLeast(version)) {
      return {
        name,
        version,
        binary,
        source,
        supported: false,
        problem: `${engineLabel(name)} ${version} at ${binary} is older than the minimum ${MIN_ENGINE_VERSION}.`,
      };
    }
    return { name, version, binary, source, supported: true };
  }
}

export interface SelectEngineOptions extends DetectOptions, Omit<EngineOptions, "runner"> {}

/**
 * Detects the installed engines and returns an `IacEngine` for the preferred one. `auto` picks
 * OpenTofu when it is usable, otherwise Terraform. Throws `OpsCrewError` `ENGINE_NOT_FOUND` with
 * install or upgrade instructions when nothing usable is found.
 */
export async function selectEngine(
  preference: EnginePreference,
  opts: SelectEngineOptions = {},
): Promise<IacEngine> {
  const runner = opts.runner ?? new NodeCommandRunner();
  const detected = await detectEngines({ ...opts, runner });
  const wanted = preference === "auto" ? ENGINES : ENGINES.filter((e) => e.name === preference);
  for (const { name } of wanted) {
    const entry = detected.find((d) => d.name === name && d.supported);
    if (entry) {
      const { name: engineName, version, binary } = entry;
      return createEngine({ name: engineName, version, binary }, { ...opts, runner });
    }
  }

  const problems = detected
    .filter((d) => wanted.some((w) => w.name === d.name))
    .flatMap((d) => (d.problem ? [d.problem] : []));
  const labels = wanted.map((w) => w.label).join(" or ");
  const install = wanted.map((w) => `${w.label}: ${w.install}`).join("; ");
  const envVars = wanted.map((w) => w.envVar).join(" / ");
  const message =
    problems.length > 0
      ? `No usable ${labels} was found. ${problems.join(" ")}`
      : wanted.length > 1
        ? `Neither OpenTofu nor Terraform is installed (looked in ${envVars} and PATH).`
        : `${labels} is not installed (looked in ${envVars} and PATH).`;
  throw new OpsCrewError("ENGINE_NOT_FOUND", message, {
    hint: `Install or upgrade to version ${MIN_ENGINE_VERSION} or newer (${install}), or point ${envVars} at the program, then try again.`,
  });
}
