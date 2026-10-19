import { serviceSpec } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { ServiceCheckInput } from "@opscrew/secops";

/** Stands in for a secret while the variables that hold one are found. */
const SECRET = "\u0000secret\u0000";

/**
 * The app's running services for the secops checks on the server (FR-1328), from the catalog:
 * each with the variables of its environment that hold its login (a generated secret), none for
 * an `internal-only` service (Valkey, Kafka, Redpanda), which only the app's containers reach.
 */
export function serviceCheckInputs(plan: DeployPlan): ServiceCheckInput[] {
  return plan.services
    .filter((service) => service.enabled)
    .map((service) => {
      const spec = serviceSpec(service.kind);
      const environment = spec.environment({ plan, service, secretRef: () => SECRET });
      return {
        name: service.name,
        title: spec.title,
        login:
          spec.auth === "internal-only"
            ? []
            : Object.keys(environment).filter((name) => environment[name]?.includes(SECRET)),
      };
    });
}

/** The ports of the app's running services with their kind's name, for the outside probes. */
export function servicePorts(plan: DeployPlan): Record<number, string> {
  return Object.fromEntries(
    plan.services
      .filter((service) => service.enabled)
      .map((service) => {
        const spec = serviceSpec(service.kind);
        return [spec.port, spec.title];
      }),
  );
}
