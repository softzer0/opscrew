import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
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

/** What a fake `state list` was asked and saw. */
export interface StateListCall {
  file: string;
  encryption: string | undefined;
}

/**
 * Gives a test engine the optional `stateResources` capability: a plain state lists its managed
 * resources; an encrypted one lists `inside(file)` (`undefined` = the engine cannot read it),
 * and only when `TF_ENCRYPTION` is set, as OpenTofu needs it. Calls are recorded in `calls`.
 */
export function withStateList<T extends IacEngine>(
  engine: T,
  inside: (file: string) => string[] | undefined,
): T & { stateCalls: StateListCall[] } {
  const stateCalls: StateListCall[] = [];
  const stateResources = async (file: string, options: IacRunOptions = {}) => {
    const encryption = options.env?.TF_ENCRYPTION;
    stateCalls.push({ file, encryption });
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      encrypted_data?: string;
      resources?: { mode?: string; type: string; name: string; instances?: unknown[] }[];
    };
    if (parsed.encrypted_data !== undefined) {
      const listed = encryption ? inside(file) : undefined;
      if (listed === undefined) throw new Error("Failed to load state: encrypted");
      return listed;
    }
    return (parsed.resources ?? [])
      .filter((r) => r.mode !== "data" && (r.instances?.length ?? 1) > 0)
      .map((r) => `${r.type}.${r.name}`);
  };
  return Object.assign(engine, { stateResources, stateCalls });
}
