/**
 * The service catalog's types: one {@link ServiceSpec} per kind of backing service OpsCrew runs
 * next to the app, read by one renderer for Compose and one for Portainer stacks.
 */
import type { DeployPlan, PlanService, SelfHostedServiceKind } from "@opscrew/plan-schema";
import type { IMAGES } from "../pins";
import type { RenderedFile } from "../types";

/** A key of `IMAGES` in pins.ts: an image pinned as `repo:tag@sha256:…`. */
export type ImagePinKey = keyof typeof IMAGES;

/** A secret OpsCrew generates once per service and keeps with the project's generated values. */
export interface GeneratedSecret {
  /** The secret's name within the service, for example `password`. */
  name: string;
  /** `hex32`: 32 random bytes as hex. */
  format: "hex32";
}

/**
 * What a catalog entry's functions are given. Secret-free: a secret appears only as the reference
 * `secretRef` returns, which the caller resolves where values belong (an env file, never a file in
 * the repository).
 */
export interface ServiceContext {
  plan: DeployPlan;
  /** The plan's entry: its name (the host on the app's network), version, memory and options. */
  service: PlanService;
  /** The reference to one of the entry's {@link ServiceSpec.secrets}, by its name. */
  secretRef: (name: string) => string;
}

/** One kind of backing service: everything the renderers and design need to run it. */
export interface ServiceSpec {
  /** The kind in `plan.services[].kind`. */
  kind: SelfHostedServiceKind;
  image: ImagePinKey;
  /** Conservative: the LTS line or the one before the newest. */
  defaultVersion: string;
  /** True when Dependabot proposes no major update. */
  majorLocked: boolean;
  /** `note`: the plain sentence design shows when the licence is not permissive. */
  licence: { id: string; permissive: boolean; note?: string };
  memory: { defaultMb: number; minimumMb: number; smallestServerMb: number };
  /** Internal only, never published. */
  port: number;
  /** In the container; mounted from `/srv/data/<app>/<service>`. */
  dataDir: string;
  /** Mounted settings files, for example `my.cnf` or `rabbitmq.conf`. */
  configFiles?: (ctx: ServiceContext) => RenderedFile[];
  /** The container's command, for example `mongod --wiredTigerCacheSizeGB <n>`. */
  command?: (ctx: ServiceContext) => string[];
  /** The service's own settings, secrets by reference. */
  environment: (ctx: ServiceContext) => Record<string, string>;
  /** A Compose `CMD` health check that works with the image's own tools. */
  healthcheck: string[];
  /** A one-shot container after the first start: MongoDB's replica set, Garage's layout. */
  init?: (ctx: ServiceContext) => { command: string[] };
  secrets: GeneratedSecret[];
  /**
   * How the app logs in. `internal-only`: no login, reachable only from the app's own containers
   * (Valkey, Kafka, Redpanda, OpenSearch).
   */
  auth: "password" | "token" | "key" | "internal-only";
  /** What the app receives, by its detected names. */
  appVariables: (ctx: ServiceContext) => Record<string, string>;
  /** Kernel settings the host needs, for example `vm.max_map_count` for the search engines. */
  hostSettings?: { sysctl: Record<string, string> };
  /** Where it can run: `portainer` is left out when a host setting is needed. */
  targets: ("server" | "portainer")[];
}
