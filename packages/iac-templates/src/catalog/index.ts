import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan, PlanService, SelfHostedServiceKind } from "@opscrew/plan-schema";
import { IMAGES } from "../pins";
import type { ServiceInitStep } from "../workflow/switch";
import { SERVICE_SPECS } from "./entries";
import type { ServiceContext, ServiceSpec } from "./types";

export { SERVICE_SPECS };

/** {@link SERVICE_SPECS} by kind: one entry for every kind (a test checks each is there). */
export const CATALOG = Object.fromEntries(
  SERVICE_SPECS.map((spec) => [spec.kind, spec]),
) as Readonly<Record<SelfHostedServiceKind, ServiceSpec>>;

/** The catalog's entry for `kind`. */
export function serviceSpec(kind: SelfHostedServiceKind): ServiceSpec {
  return CATALOG[kind];
}

/**
 * The kernel settings the plan's enabled services need from the host, each a minimum
 * (`vm.max_map_count` for OpenSearch and Elasticsearch); empty when none does.
 */
export function hostSysctl(plan: DeployPlan): Record<string, string> {
  return Object.assign(
    {},
    ...enabledServices(plan).map((service) => serviceSpec(service.kind).hostSettings?.sysctl),
  );
}

/** The image of `spec` without its tag and digest, as Dependabot names it: `mysql`, `apache/kafka`. */
export function imageName(spec: ServiceSpec): string {
  const ref = IMAGES[spec.image].ref;
  return ref.slice(0, ref.lastIndexOf(":", ref.indexOf("@")));
}

/** The version in the tag of the image OpsCrew pins: `8.4` for `mysql:8.4@…`, `26.2.5` for `v26.2.5`. */
export function pinnedVersion(spec: ServiceSpec): string {
  const ref = IMAGES[spec.image].ref;
  const tag = ref.slice(ref.lastIndexOf(":", ref.indexOf("@")) + 1, ref.indexOf("@"));
  return /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1] ?? tag;
}

/**
 * Refuses a service whose version is not the one OpsCrew pins, at the plan's precision (`8.4`
 * matches `8.4`, `4.3` matches `4.3.1`): the version would otherwise change in the plan only.
 * @throws OpsCrewError `INVALID_INPUT` naming both versions.
 */
export function checkServiceVersion(service: PlanService, spec: ServiceSpec): void {
  const wanted = service.version.split(".");
  const pinned = pinnedVersion(spec).split(".");
  if (wanted.length <= pinned.length && wanted.every((part, i) => part === pinned[i])) return;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `opscrew/plan.yaml asks for ${spec.title} ${service.version} (the service ${service.name}), but this version of OpsCrew runs ${spec.title} ${pinnedVersion(spec)}.`,
    {
      hint: `Set the service's version to ${spec.defaultVersion} in opscrew/plan.yaml (services), then run the command again.`,
    },
  );
}

/** The plan's services that run, in its order. */
export function enabledServices(plan: DeployPlan): PlanService[] {
  return plan.services.filter((service) => service.enabled);
}

/** A {@link ServiceContext} for rendering: no secret value ever reaches a rendered file. */
export function renderContext(
  plan: DeployPlan,
  service: PlanService,
  secretRef: (name: string) => string = (name) => {
    throw new Error(`${service.name}'s secret ${name} cannot appear in a rendered file`);
  },
): ServiceContext {
  return { plan, service, secretRef };
}

/**
 * The one-time setup steps of the plan's services, in the plan's order, for the deploy on a
 * server (MongoDB's replica set, Garage's key and bucket).
 */
export function initStepsFor(plan: DeployPlan): ServiceInitStep[] {
  return enabledServices(plan).flatMap(
    (service) => serviceSpec(service.kind).init?.(renderContext(plan, service)) ?? [],
  );
}
