import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { IacEngine, IacRunOptions } from "@opscrew/contracts";

/** A plain state file (format 4) with these resources and an output that depends on none. */
export function plainState(resources: unknown[]): string {
  return JSON.stringify({
    version: 4,
    terraform_version: "1.13.1",
    serial: 3,
    lineage: "00000000-0000-0000-0000-000000000000",
    outputs: { url: { value: "https://shop.example.com", type: "string" } },
    resources,
  });
}

/** A managed resource with one instance, as an earlier Cloudflare setup leaves it. */
export const MANAGED_TUNNEL = {
  mode: "managed",
  type: "cloudflare_zero_trust_tunnel_cloudflared",
  name: "this",
  module: "module.tunnel",
  instances: [{ schema_version: 0, attributes: { name: "opscrew-shop" } }],
};

/** A data source: read only, no infrastructure. */
export const DATA_ZONE = { ...MANAGED_TUNNEL, mode: "data", type: "cloudflare_zone", name: "zone" };

/**
 * The outside of an OpenTofu-encrypted state file. Its random `encrypted_data` stands in for the
 * ciphertext; `withStateList` decides what the engine finds inside.
 */
export function encryptedState(): string {
  return JSON.stringify({
    serial: 3,
    lineage: "00000000-0000-0000-0000-000000000000",
    meta: { "key_provider.pbkdf2.opscrew": randomBytes(16).toString("base64") },
    encrypted_data: randomBytes(48).toString("base64"),
    encryption_version: "v0",
  });
}

/** `providers schema -json` as the fake engines answer it: no provider is installed. */
export async function noProviderSchemas(): Promise<unknown> {
  return {};
}

/**
 * `state list` as the fake engines answer it: the managed resources of a plain state file (data
 * sources and resources without instances left out). An encrypted state, a file that is no state
 * and a missing file throw, as a real engine without the encryption settings does.
 */
export async function plainStateResources(file: string): Promise<string[]> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as {
    encrypted_data?: string;
    resources?: { mode?: string; type: string; name: string; instances?: unknown[] }[];
  };
  if (parsed.encrypted_data !== undefined || !Array.isArray(parsed.resources)) {
    throw new Error("Failed to load state");
  }
  return parsed.resources
    .filter((r) => r.mode !== "data" && (r.instances?.length ?? 1) > 0)
    .map((r) => `${r.type}.${r.name}`);
}

/** What a fake `state list` was asked and saw. */
export interface StateListCall {
  file: string;
  encryption: string | undefined;
}

/**
 * A test engine whose `state list` also opens an encrypted state: it lists `inside(file)`
 * (`undefined` = the engine cannot read it), and only when `TF_ENCRYPTION` is set, as OpenTofu
 * needs it; a plain state lists its managed resources. Calls are recorded in `stateCalls`.
 */
export function withStateList<T extends IacEngine>(
  engine: T,
  inside: (file: string) => string[] | undefined,
): T & { stateCalls: StateListCall[] } {
  const stateCalls: StateListCall[] = [];
  const stateResources = async (file: string, options: IacRunOptions = {}) => {
    const encryption = options.env?.TF_ENCRYPTION;
    stateCalls.push({ file, encryption });
    const parsed = JSON.parse(await readFile(file, "utf8")) as { encrypted_data?: string };
    if (parsed.encrypted_data === undefined) return plainStateResources(file);
    const listed = encryption ? inside(file) : undefined;
    if (listed === undefined) throw new Error("Failed to load state: encrypted");
    return listed;
  };
  return Object.assign(engine, { stateResources, stateCalls });
}

/** The root's `terraform.tfvars.json` in `dir`, or nothing without one. */
async function tfvarsIn(dir: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(dir, "terraform.tfvars.json"), "utf8").catch(() => undefined);
  return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/**
 * The input variables each saved plan was made with, as OpenTofu (1.8 and later) checks them when
 * it applies one: the root's `terraform.tfvars.json` at the plan, with `-var` values over it. An
 * apply whose root's file now holds another value for one of them is refused, with its message.
 */
export class PlanVariables {
  readonly #saved = new Map<string, Record<string, unknown>>();

  /** Records the variables of the plan `planHash` made in `dir` with `vars` (`-var`). */
  async record(dir: string, planHash: string, vars: Record<string, string> = {}): Promise<void> {
    this.#saved.set(planHash, { ...(await tfvarsIn(dir)), ...vars });
  }

  /** OpenTofu's refusal of the apply of `planHash` in `dir`, when the file differs from the plan. */
  async mismatch(dir: string, planHash: string): Promise<string | undefined> {
    const saved = this.#saved.get(planHash);
    if (saved === undefined) return undefined;
    const current = await tfvarsIn(dir);
    const name = Object.keys(current).find(
      (key) => key in saved && JSON.stringify(current[key]) !== JSON.stringify(saved[key]),
    );
    return name === undefined
      ? undefined
      : `Error: Mismatch between input and plan variable value\n\nValue saved in the plan file for variable "${name}" is different from the one\ngiven to the current command.`;
  }
}
