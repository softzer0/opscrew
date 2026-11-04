import type { DeployPlan } from "@opscrew/plan-schema";
import { DEPLOYED_AT, MemoryCatalog, offer } from "../../testing";

/** Hetzner's types in nbg1, from 1 GB up: the stack, Alloy and the system (1,760 MB) fit the 2 GB one. */
export function catalog(): MemoryCatalog {
  return new MemoryCatalog([
    offer({ id: "cx11", vcpus: 1, memoryGb: 1, diskGb: 20, price: 2.49 }),
    offer({ id: "cx21", vcpus: 1, memoryGb: 2, diskGb: 30, price: 3.29 }),
    offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.49 }),
    offer({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49 }),
  ]);
}

/** `plan` deployed (its last apply at {@link DEPLOYED_AT}). */
export const deployed = <P extends Pick<DeployPlan, "deployment">>(plan: P): P => ({
  ...plan,
  deployment: { ...plan.deployment, lastApplyAt: DEPLOYED_AT },
});
