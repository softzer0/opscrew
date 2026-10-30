import { publishedOnNetwork, serviceSpec } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, servicesOn } from "@opscrew/plan-schema";
import { type HostCheck, type ServiceCheckInput, serviceHostChecks } from "@opscrew/secops";

/** Stands in for a secret while the variables that hold one are found. */
const SECRET = "\u0000secret\u0000";

/**
 * The app's running services on `server` (default the app's) for the secops checks there
 * (FR-1328), from the catalog: each with the variables of its environment that hold its login (a
 * generated secret), none for an `internal-only` service (Kafka, Redpanda), which only the app's
 * containers reach, and for Valkey the ping it must refuse without its password.
 */
export function serviceCheckInputs(plan: DeployPlan, server = APP_SERVER): ServiceCheckInput[] {
  return servicesOn(plan, server).map((service) => {
    const spec = serviceSpec(service.kind);
    const environment = spec.environment({ plan, service, secretRef: () => SECRET });
    return {
      name: service.name,
      title: spec.title,
      login:
        spec.auth === "internal-only"
          ? []
          : Object.keys(environment).filter((name) => environment[name]?.includes(SECRET)),
      // Valkey must refuse a request without its password (FR-1450).
      ...(service.kind === "valkey" ? { ping: "valkey-cli PING" } : {}),
    };
  });
}

/**
 * The ports of the app's running services with their kind's name, for the outside probes; on
 * `server` only when given.
 */
export function servicePorts(plan: DeployPlan, server?: string): Record<number, string> {
  return Object.fromEntries(
    (server === undefined ? plan.services.filter((s) => s.enabled) : servicesOn(plan, server)).map(
      (service) => {
        const spec = serviceSpec(service.kind);
        return [spec.port, spec.title];
      },
    ),
  );
}

/**
 * The checks of the app's services on `server` (`serviceHostChecks`), without the "no published
 * port" check of a service published on the server's private address (feature 018): its own check
 * (`privateAddressChecks`) holds it to that address and the network's filter instead.
 */
export function serverServiceChecks(plan: DeployPlan, server = APP_SERVER): HostCheck[] {
  const onNetwork = new Set(
    publishedOnNetwork(plan, server).map((entry) => `service-${entry.service}-port`),
  );
  return serviceHostChecks(plan.app.name, serviceCheckInputs(plan, server)).filter(
    (check) => !onNetwork.has(check.id),
  );
}
