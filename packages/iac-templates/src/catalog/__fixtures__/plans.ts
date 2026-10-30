import { createHash } from "node:crypto";
import {
  type DeployPlan,
  DeployPlanSchema,
  REDIS_PROTOCOL_KINDS,
  type SelfHostedServiceKind,
} from "@opscrew/plan-schema";
import { testPlan, type TestPlanOptions } from "../../__fixtures__/plans";
import { serviceSpec } from "../index";


/** A service entry for {@link withServices}: its kind and any plan fields to set. */
export type ServiceEntry = { kind: SelfHostedServiceKind } & Record<string, unknown>;

/**
 * `testPlan(options)` (Hetzner, `shop` on port 3000) with exactly `services`, each at the
 * catalog's version and default memory unless the entry says otherwise, and `fields` on top.
 */
export function withServices(
  services: ServiceEntry[],
  fields: Record<string, unknown> = {},
  options: TestPlanOptions = {},
): DeployPlan {
  const base = testPlan({ ...options, postgres: false });
  return DeployPlanSchema.parse({
    ...base,
    externalServices: [],
    ...fields,
    services: services.map((service) => {
      const spec = serviceSpec(service.kind);
      return {
        version: spec.defaultVersion,
        memoryMb: spec.memory.defaultMb,
        options: (REDIS_PROTOCOL_KINDS as readonly string[]).includes(service.kind) ? { mode: "cache" } : {},
        reason: "The app uses it.",
        licence: spec.licence.id,
        ...service,
      };
    }),
  });
}

/** A WireGuard public key made at runtime from `seed` (the base64 of its SHA-256), never a literal. */
function wireGuardKey(seed: string): string {
  return createHash("sha256").update(seed).digest("base64");
}

/** Where {@link withPlacement} puts the app's services, its devices and their grants. */
export interface Placement {
  /** Extra servers by name: Hetzner in the app's location, or `own`. */
  servers?: Record<string, "hetzner" | "own">;
  /** Service name → the extra server it runs on. */
  placed?: Record<string, string>;
  /** Devices on the network, from `.100`. */
  devices?: string[];
  grants?: { device: string; service: string; access: "read-only" | "full" }[];
}

/**
 * `plan` with extra servers, its services placed on them, and the private network `10.200.4.0/24`:
 * the app's server `.1`, each extra server from `.2` in order, each device from `.100`.
 */
export function withPlacement(plan: DeployPlan, o: Placement): DeployPlan {
  const servers = Object.entries(o.servers ?? {});
  const members = ["app", ...servers.map(([name]) => name)];
  return DeployPlanSchema.parse({
    ...plan,
    ...(servers.length > 0
      ? {
          servers: servers.map(([name, provider]) => ({
            name,
            target:
              provider === "own"
                ? { provider, mode: "vps-compose", arch: "amd64" }
                : {
                    provider,
                    mode: "vps-compose",
                    location: "nbg1",
                    serverType: "cx33",
                    backups: true,
                  },
          })),
        }
      : {}),
    services: plan.services.map((service) => {
      const server = o.placed?.[service.name];
      return server === undefined ? service : { ...service, server };
    }),
    network: {
      range: "10.200.4.0/24",
      members: members.map((name, i) => ({
        name,
        address: `10.200.4.${i + 1}`,
        port: 51820,
        publicKey: wireGuardKey(name),
      })),
      devices: (o.devices ?? []).map((name, i) => ({
        name,
        address: `10.200.4.${100 + i}`,
        publicKey: wireGuardKey(`device ${name}`),
        addedAt: "2026-10-30T12:00:00.000Z",
      })),
      grants: o.grants ?? [],
    },
  });
}

/** `storage.objectStorage` for a Garage bucket `shop-uploads`. */
export const GARAGE_STORAGE = {
  objectStorage: {
    provider: "garage",
    bucket: "shop-uploads",
    region: "garage",
    expected: { storageGb: 10, egressGbPerMonth: 50 },
    price: { monthly: 0, currency: "USD", source: "the server's own disk", checkedOn: "2026-10-19" },
  },
} as const;
