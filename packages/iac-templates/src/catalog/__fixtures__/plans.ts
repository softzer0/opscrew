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
