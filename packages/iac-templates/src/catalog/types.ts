/**
 * The service catalog's types: one {@link ServiceSpec} per kind of backing service OpsCrew runs
 * next to the app, read by one renderer for Compose and one for Portainer stacks.
 */
import type { DeployPlan, PlanService, SelfHostedServiceKind } from "@opscrew/plan-schema";
import type { IMAGES } from "../pins";
import type { ServiceInitStep } from "../workflow/switch";

/** A key of `IMAGES` in pins.ts: an image pinned as `repo:tag@sha256:…`. */
export type ImagePinKey = keyof typeof IMAGES;

/** A secret OpsCrew generates once per service and keeps with the project's generated values. */
export interface GeneratedSecret {
  /** The secret's name within the service, for example `password`. */
  name: string;
  /**
   * `hex32`: 32 random bytes as hex. `garage-key-id`: `GK` and 12 random bytes as hex, the form of
   * the key IDs Garage makes itself.
   */
  format: "hex32" | "garage-key-id";
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
  /**
   * The app's own variable for the service's address, when detection found one
   * (`facts.services[].variable`): the catalog's `appVariables` gives it the address too.
   */
  variable?: string;
}

/** A settings file OpsCrew writes for a service and mounts read-only. */
export interface ServiceConfigFile {
  /** Its name in `<runtimeDir>/services/<service>/`, for example `my.cnf`. */
  name: string;
  /** Where it is mounted in the container. */
  target: string;
  content: string;
}

/** One kind of backing service: everything the renderers and design need to run it. */
export interface ServiceSpec {
  /** The kind in `plan.services[].kind`. */
  kind: SelfHostedServiceKind;
  /** Its name in plain text, for example `MySQL`. */
  title: string;
  image: ImagePinKey;
  /** Conservative: the LTS line or the one before the newest; the version of the pin's tag. */
  defaultVersion: string;
  /** True when Dependabot proposes no major update. */
  majorLocked: boolean;
  /** `note`: the plain sentence design shows when the licence is not permissive. */
  licence: { id: string; permissive: boolean; note?: string };
  memory: { defaultMb: number; minimumMb: number; smallestServerMb: number };
  /** Internal only, never published. */
  port: number;
  /**
   * Where the data is in the container: one folder, mounted from `/srv/data/<app>/<service>`
   * (Portainer: the volume `<service>_data`), or several by name, each mounted from
   * `/srv/data/<app>/<service>/<name>` (Portainer: `<service>_<name>`), for images that declare
   * several volumes (MongoDB's `db` and `configdb`).
   */
  dataDir: string | Record<string, string>;
  /**
   * True for an image that starts as its own user (Kafka, Redpanda): it cannot write to a folder
   * Docker creates for it as root, so on a server too it keeps its data in the volume
   * `<service>_data`, which Docker creates with the image's owner.
   */
  namedVolume?: boolean;
  /** Mounted settings files, for example `my.cnf` or `rabbitmq.conf`. */
  configFiles?: (ctx: ServiceContext) => ServiceConfigFile[];
  /** The container's command, for example `mongod --wiredTigerCacheSizeGB <n>`. */
  command?: (ctx: ServiceContext) => string[];
  /** The container's hostname, for a service whose data is named after it (RabbitMQ). */
  hostname?: boolean;
  /** The service's own settings, secrets by reference. */
  environment: (ctx: ServiceContext) => Record<string, string>;
  /**
   * A Compose health check that works with the image's own tools (`test` with `CMD` or
   * `CMD-SHELL` first), checked every 10 seconds and unhealthy after 6 failures; `startSeconds`
   * for a service whose first start takes longer (failures then do not count).
   */
  healthcheck: { test: string[]; timeoutSeconds?: number; startSeconds?: number };
  /**
   * The one-time setup the deploy runs in the healthy service on a server, each step only when its
   * check fails: MongoDB's replica set.
   */
  init?: (ctx: ServiceContext) => ServiceInitStep[];
  secrets: GeneratedSecret[];
  /**
   * How the app logs in. `internal-only`: no login, reachable only from the app's own containers
   * (Valkey, Kafka, Redpanda, OpenSearch).
   */
  auth: "password" | "token" | "key" | "internal-only";
  /**
   * Where the app reaches the service, as its own detected variable holds it (see
   * {@link ServiceContext.variable}): a URL with the login, or Kafka's `host:port`.
   */
  address: (ctx: ServiceContext) => string;
  /**
   * What the app receives by the conventional names, given the service's {@link address}; the
   * catalog's `appVariables` adds the app's own detected name.
   */
  conventionalVariables: (ctx: ServiceContext, address: string) => Record<string, string>;
  /**
   * The container's open-file limit, soft and hard alike, for an engine that needs more than
   * Docker's default (OpenSearch and Elasticsearch: 65536).
   */
  ulimits?: { nofile: number };
  /** Kernel settings the host needs, for example `vm.max_map_count` for the search engines. */
  hostSettings?: { sysctl: Record<string, string> };
  /** Where it can run: `portainer` is left out when a host setting is needed. */
  targets: ("server" | "portainer")[];
}
