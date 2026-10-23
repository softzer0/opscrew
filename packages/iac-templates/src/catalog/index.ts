import { OpsCrewError } from "@opscrew/core";
import type { DeployPlan, PlanService, SelfHostedServiceKind } from "@opscrew/plan-schema";
import { IMAGES } from "../pins";
import { planFilePath } from "../workflow/shared";
import type { ServiceInitStep } from "../workflow/switch";
import { DRAGONFLY_MIN_VCPUS, SERVICE_SPECS } from "./entries";
import type { ServiceContext, ServiceSpec } from "./types";

export { DRAGONFLY_MIN_VCPUS, SERVICE_SPECS };

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

/**
 * The image of `spec` without its registry, tag and digest, as Dependabot names it: `mysql`,
 * `apache/kafka`, `dragonflydb/dragonfly` (from `docker.dragonflydb.io/dragonflydb/dragonfly`;
 * Dependabot keeps the registry apart).
 */
export function imageName(spec: ServiceSpec): string {
  const ref = IMAGES[spec.image].ref;
  const name = ref.slice(0, ref.lastIndexOf(":", ref.indexOf("@")));
  // A first part with a dot or a port is a registry's host.
  return name.replace(/^[^/]*[.:][^/]*\//, "");
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
export function checkServiceVersion(
  plan: DeployPlan,
  service: PlanService,
  spec: ServiceSpec,
): void {
  const wanted = service.version.split(".");
  const pinned = pinnedVersion(spec).split(".");
  if (wanted.length <= pinned.length && wanted.every((part, i) => part === pinned[i])) return;
  const file = planFilePath(plan);
  throw new OpsCrewError(
    "INVALID_INPUT",
    `${file} asks for ${spec.title} ${service.version} (the service ${service.name}), but this version of OpsCrew runs ${spec.title} ${pinnedVersion(spec)}.`,
    {
      hint: `Set the service's version to ${spec.defaultVersion} in ${file} (services), then run the command again.`,
    },
  );
}

/** A service's data folders in its container by name: `data` for an entry with one folder. */
export function dataDirs(spec: ServiceSpec): [name: string, dir: string][] {
  return Object.entries(typeof spec.dataDir === "string" ? { data: spec.dataDir } : spec.dataDir);
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
 * What the app receives from the service of `ctx`: its catalog entry's conventional names, and
 * the app's own detected variable (`ctx.variable`) with the service's address.
 */
export function appVariables(ctx: ServiceContext): Record<string, string> {
  const spec = serviceSpec(ctx.service.kind);
  const address = spec.address(ctx);
  const variables = spec.conventionalVariables(ctx, address);
  return ctx.variable === undefined ? variables : { ...variables, [ctx.variable]: address };
}

/**
 * The one-time setup steps of the plan's services, in the plan's order, for the deploy on a
 * server (MongoDB's replica set).
 */
export function initStepsFor(plan: DeployPlan): ServiceInitStep[] {
  return enabledServices(plan).flatMap(
    (service) => serviceSpec(service.kind).init?.(renderContext(plan, service)) ?? [],
  );
}
