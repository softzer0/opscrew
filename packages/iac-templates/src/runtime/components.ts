// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose syntax, not JavaScript templates.
/**
 * The app's components in Compose, for a server's project and for a Portainer stack: the
 * catalog's services, the workers and the `cron` service with its crontab (contracts/components.md).
 */
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import {
  checkServiceVersion,
  dataDirs,
  enabledServices,
  hostSysctl,
  renderContext,
  serviceSpec,
} from "../catalog";
import type { ServiceSpec } from "../catalog/types";
import { GENERATED_USERS } from "../docker/stacks";
import { IMAGES } from "../pins";
import { runtimeDir } from "../runtime-dir";
import type { RenderedFile } from "../types";
import { BUILDPACKS_RUN_USER, RAILPACK_USER } from "../workflow/build";
import { sqliteFolder } from "../workflow/shared";
import { RUBY_WITHOUT_RUBYOPT } from "./healthcheck";
import { composeLiteral, hardened, scriptLiteral, shellQuote } from "./services";

/** `mem_limit` and an equal `memswap_limit`: Docker's default lets a container swap as much again. */
export function memoryLimit(mb: number): { mem_limit: string; memswap_limit: string } {
  return { mem_limit: `${mb}m`, memswap_limit: `${mb}m` };
}

/**
 * Where the services run. `portainer`: a stack, with named volumes, settings files inline, and
 * `environment` giving each service its environment with secrets as the stack's variables.
 */
export type ComponentTarget =
  | { kind: "server" }
  | {
      kind: "portainer";
      environment: (service: PlanService, spec: ServiceSpec) => Record<string, string>;
    };

/** The catalog's services in Compose, with what the stack around them needs. */
export interface RenderedServices {
  /** By name, in the plan's order. */
  services: Record<string, object>;
  /** What the app, its workers and cron wait for. */
  dependsOn: Record<string, { condition: string }>;
  /** Named volumes to declare: the services', then the SQLite volume (see {@link appVolumes}). */
  volumes: string[];
  /** Portainer and this computer: the settings files, inline (`configs.<name>.content`). */
  configs: Record<string, { content: string }>;
  /** Server: the settings files next to compose.yaml, in `<runtimeDir>/services/<name>/`. */
  files: RenderedFile[];
}

/**
 * The service's data mounts: on a server the folder `/srv/data/<app>/<service>`, with a subfolder
 * per data folder when there are several; in Portainer, on this computer (the localhost target),
 * and on a server for an image that runs as its own user, the volume `<service>_data`
 * (`<service>_<name>` when there are several).
 */
function dataMounts(
  plan: DeployPlan,
  service: PlanService,
  spec: ServiceSpec,
  target: ComponentTarget,
): { mounts: string[]; volumes: string[] } {
  const single = typeof spec.dataDir === "string";
  const dirs = dataDirs(spec);
  if (target.kind === "portainer" || spec.namedVolume || plan.target.provider === "localhost") {
    const volumes = dirs.map(([name]) => `${service.name}_${name}`);
    return { mounts: dirs.map(([, dir], i) => `${volumes[i]}:${dir}`), volumes };
  }
  const base = `/srv/data/${plan.app.name}/${service.name}`;
  return {
    mounts: dirs.map(([name, dir]) => `${single ? base : `${base}/${name}`}:${dir}`),
    volumes: [],
  };
}

/**
 * A service's environment: on a server, a service with secrets reads all of it from `<name>.env`
 * next to compose.yaml (the deploy writes it; OpsCrew keeps the values), the others have it
 * inline; in Portainer, as the target gives it.
 */
function serviceEnvironment(
  plan: DeployPlan,
  service: PlanService,
  spec: ServiceSpec,
  target: ComponentTarget,
): object {
  if (target.kind === "server" && spec.secrets.length > 0) {
    return { env_file: [`${service.name}.env`] };
  }
  const environment =
    target.kind === "portainer"
      ? target.environment(service, spec)
      : spec.environment(renderContext(plan, service));
  return Object.keys(environment).length > 0 ? { environment } : {};
}

/**
 * The label of a service's settings: a changed file changes it, so Compose recreates the service
 * (a mounted file alone would not, and the service would keep its old settings).
 */
function configLabel(settings: string): { labels: Record<string, string> } {
  return { labels: { "dev.opscrew.config-sha256": sha256Hex(settings) } };
}

/** A catalog health check: every 10 seconds, unhealthy after 6 failures. */
function healthcheck(spec: ServiceSpec): object {
  const { test, timeoutSeconds, startSeconds } = spec.healthcheck;
  return {
    test: test.map(composeLiteral),
    interval: "10s",
    timeout: `${timeoutSeconds ?? 5}s`,
    retries: 6,
    ...(startSeconds === undefined ? {} : { start_period: `${startSeconds}s` }),
  };
}

/** The app's one-shot container that sets the host kernel settings its services need. */
const SYSCTL_SERVICE = "sysctl";

/** OpsCrew's file of kernel settings, the same as the own-server host plan's. */
const HOST_SYSCTL_FILE = "/etc/sysctl.d/90-opscrew.conf";

const SYSCTL_MEMORY_MB = 16;

/**
 * `["sysctl"]` when the plan's services need host kernel settings on a server OpsCrew created
 * ({@link sysctlService}), which the deploy starts with the services; else none. On a server the
 * user owns the host plan sets them (in `/etc/sysctl.d`, approved by its hash).
 */
export function hostSettingsServices(plan: DeployPlan): string[] {
  return Object.keys(hostSysctl(plan)).length > 0 && plan.target.provider !== "own"
    ? [SYSCTL_SERVICE]
    : [];
}

/**
 * The container that raises the host kernel settings of all the plan's services
 * ({@link hostSysctl}: `vm.max_map_count` for the search engines) once before they start on each
 * deploy; a value already at least as high stays. Privileged because these settings belong to the
 * host kernel, not the container: Docker's `sysctls` takes only the per-container ones. It runs
 * the edge's Caddy image, which is on every server, with no network, sets only these settings and
 * exits.
 *
 * It also writes them to the host's {@link HOST_SYSCTL_FILE} (through a mount of
 * `/etc/sysctl.d`), so a restart of the server keeps them: cloud-init runs only when a server is
 * created, so it would not cover an engine added later. Each value is the higher of the wanted one
 * and the kernel's, as on a server the user owns.
 */
function sysctlService(plan: DeployPlan): object {
  const file = HOST_SYSCTL_FILE;
  const raise = Object.entries(hostSysctl(plan)).map(
    ([key, value]) =>
      `v=$(sysctl -n ${key}); if [ "$v" -lt ${value} ]; then v=${value}; sysctl -w ${key}=$v; fi; echo "${key} = $v" >> ${file}.tmp`,
  );
  const script = [
    "set -e",
    `echo '# Managed by OpsCrew: kernel settings the services of its apps need.' > ${file}.tmp`,
    ...raise,
    `mv ${file}.tmp ${file}`,
  ];
  return {
    // No restart policy: it runs once and exits.
    image: IMAGES.caddy.ref,
    privileged: true,
    network_mode: "none",
    command: ["sh", "-c", composeLiteral(script.join("; "))],
    volumes: ["/etc/sysctl.d:/etc/sysctl.d"],
    read_only: true,
    ...memoryLimit(SYSCTL_MEMORY_MB),
    ...hardened(),
  };
}

/**
 * The plan's services in Compose: each with its pinned image, its environment, its data and
 * settings files, health check, memory limit, `restart: unless-stopped`, the app's internal
 * network and no published port. A changed settings file changes the service's label, so Compose
 * recreates only that service.
 * @throws OpsCrewError `INVALID_INPUT` for a version OpsCrew does not pin or a kind it cannot run.
 */
export function renderServices(plan: DeployPlan, target: ComponentTarget): RenderedServices {
  const rendered: RenderedServices = {
    services: {},
    dependsOn: {},
    volumes: [],
    configs: {},
    files: [],
  };
  const sysctl = target.kind === "server" && hostSettingsServices(plan).length > 0;
  if (sysctl) rendered.services[SYSCTL_SERVICE] = sysctlService(plan);
  for (const service of enabledServices(plan)) {
    const spec = serviceSpec(service.kind);
    checkServiceVersion(service, spec);
    const ctx = renderContext(plan, service);
    const data = dataMounts(plan, service, spec, target);
    rendered.volumes.push(...data.volumes);
    const files = spec.configFiles?.(ctx) ?? [];
    const mounts: string[] = [];
    const configs: { source: string; target: string }[] = [];
    for (const file of files) {
      // Inline in a Portainer stack, which has no folder, and on this computer, where Docker
      // Desktop shows a file mounted from Windows as writable by everyone (MySQL ignores it).
      if (target.kind === "portainer" || plan.target.provider === "localhost") {
        const source = `${service.name}-${file.name}`;
        rendered.configs[source] = { content: composeLiteral(file.content) };
        configs.push({ source, target: file.target });
      } else {
        const path = `services/${service.name}/${file.name}`;
        rendered.files.push({
          path: `${runtimeDir(plan)}/${path}`,
          content: file.content,
          kind: "runtime",
        });
        mounts.push(`./${path}:${file.target}:ro`);
      }
    }
    const command = spec.command?.(ctx);
    rendered.services[service.name] = {
      image: IMAGES[spec.image].ref,
      restart: "unless-stopped",
      ...(spec.hostname ? { hostname: service.name } : {}),
      ...(command === undefined ? {} : { command: command.map(composeLiteral) }),
      ...serviceEnvironment(plan, service, spec, target),
      volumes: [...data.mounts, ...mounts],
      ...(configs.length > 0 ? { configs } : {}),
      ...(files.length > 0
        ? configLabel(files.map((file) => `${file.name}\n${file.content}`).join("\n"))
        : {}),
      healthcheck: healthcheck(spec),
      ...memoryLimit(service.memoryMb),
      ...(spec.ulimits === undefined
        ? {}
        : {
            ulimits: {
              nofile: { soft: spec.ulimits.nofile, hard: spec.ulimits.nofile },
            },
          }),
      ...hardened({ internal: true }),
      ...(sysctl && spec.hostSettings !== undefined
        ? { depends_on: { [SYSCTL_SERVICE]: { condition: "service_completed_successfully" } } }
        : {}),
    };
    rendered.dependsOn[service.name] = { condition: "service_healthy" };
  }
  // Named from the plan alone, so destroy can list it even when the plan cannot be rendered.
  if (plan.storage?.sqlite !== undefined) rendered.volumes.push(SQLITE_VOLUME);
  return rendered;
}

/** The volume of the app's Compose project that keeps a SQLite database's folder. */
export const SQLITE_VOLUME = "sqlite";

/**
 * The owner (`uid:gid`) Docker gives the SQLite volume when it creates it: the user the app's
 * image runs as, for the plan's builder. Undefined for the user's own Dockerfile, whose user
 * OpsCrew does not read.
 */
export function sqliteVolumeOwner(plan: DeployPlan): string | undefined {
  const build = plan.app.build;
  switch (build?.builder) {
    case "buildpacks":
      return BUILDPACKS_RUN_USER;
    case "railpack":
      return RAILPACK_USER;
    case "generated-dockerfile":
      return GENERATED_USERS[build.runtime.language === "python" ? "python" : "node"].owner;
    default:
      return undefined;
  }
}

/**
 * The `volumes` of a container of the app's image (the app, the release command, the workers and
 * cron): its `own` mounts, then for an app on SQLite the volume `sqlite` on the database's folder
 * ({@link sqliteFolder}); `{}` when there are none. Docker gives a new volume the owner of that
 * folder in the image, which the image makes the app's user's (the generated Dockerfile, or the
 * seal of the other builders).
 * @throws OpsCrewError `INVALID_INPUT` for a SQLite folder OpsCrew cannot mount.
 */
export function appVolumes(plan: DeployPlan, own: readonly string[] = []): { volumes?: string[] } {
  const folder = sqliteFolder(plan);
  const all = [...own, ...(folder === undefined ? [] : [`${SQLITE_VOLUME}:${folder}`])];
  return all.length > 0 ? { volumes: all } : {};
}

/** Where supercronic finds the crontab in the cron container. */
const CRONTAB = "/etc/opscrew/crontab";

/** A double-quoted shell word: `\`, `"`, `` ` `` and `$` escaped. */
function doubleQuoted(text: string): string {
  return `"${text.replace(/[\\"`$]/g, "\\$&")}"`;
}

/**
 * The crontab command of a `route` job for each probe tool: a GET of `http://app:<port><route>`
 * with `Authorization: Bearer $CRON_SECRET` (as Vercel sends it), failing on a status other than
 * 2xx. The tools are the image's own (research "Spike results" 6).
 */
const ROUTE_CALLS: Record<
  "node" | "python" | "ruby" | "php" | "bash",
  (port: number, route: string) => string
> = {
  node: (port, route) =>
    `node -e ${doubleQuoted(`fetch(${scriptLiteral(`http://app:${port}${route}`)},{headers:{Authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`)}`,
  python: (port, route) =>
    `python -c ${doubleQuoted(`import os,urllib.request as u;u.urlopen(u.Request(${scriptLiteral(`http://app:${port}${route}`)},headers={'Authorization':'Bearer '+os.environ['CRON_SECRET']}))`)}`,
  ruby: (port, route) =>
    `${RUBY_WITHOUT_RUBYOPT.join(" ")} ruby -rnet/http -e ${doubleQuoted(`exit Net::HTTP.get_response(URI(${scriptLiteral(`http://app:${port}${route}`)}),{'Authorization'=>'Bearer '+ENV['CRON_SECRET']}).is_a?(Net::HTTPSuccess)`)}`,
  php: (port, route) =>
    `php -r ${doubleQuoted(`exit(@file_get_contents(${scriptLiteral(`http://app:${port}${route}`)},false,stream_context_create(['http'=>['header'=>'Authorization: Bearer '.getenv('CRON_SECRET')]]))===false?1:0);`)}`,
  bash: (port, route) =>
    `bash -c ${shellQuote(
      `exec 3<>/dev/tcp/app/${port} && printf 'GET %s HTTP/1.1\\r\\nHost: app\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n' ${shellQuote(route)} "$CRON_SECRET" >&3 && read -r _ code _ <&3 && [ "\${code#2}" != "$code" ]`,
    )}`,
};

/**
 * The crontab (`<runtimeDir>/crontab` on a server), the cron service's jobs for supercronic:
 * every enabled job of `processes.cron`, in UTC (`CRON_TZ` covers the whole file, and Alpine
 * images have no other time zone); a run is skipped while the job's last one still runs.
 * @throws OpsCrewError `INVALID_INPUT` for a `route` job when the image has no probe tool that can
 * send the Authorization header (`app.build.probe` `none` or `wget`).
 */
export function crontab(plan: DeployPlan): string {
  const lines = [
    "# Generated by OpsCrew from opscrew/plan.yaml (processes.cron); `opscrew provision` regenerates it.",
    "# supercronic runs each job in the app's image and skips a run while the job's last one runs.",
    "CRON_TZ=UTC",
  ];
  const probe = plan.app.build?.probe ?? "none";
  for (const job of plan.processes.cron.filter((job) => job.enabled)) {
    const { route } = job;
    if (route === undefined) {
      lines.push("", `# ${job.name}`, `${job.schedule} ${job.command}`);
      continue;
    }
    if (probe === "none" || probe === "wget") {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The cron job ${job.name} calls the app's route ${route}, but the app's image has no tool OpsCrew can send the job's Authorization header with (app.build.probe is ${probe} in opscrew/plan.yaml).`,
        {
          hint: "Give the job a command instead of a route in opscrew/plan.yaml (processes.cron), one that runs the job's code in the app's image, then run the command again.",
        },
      );
    }
    lines.push(
      "",
      `# ${job.name}: GET ${route} with the CRON_SECRET bearer token`,
      `${job.schedule} ${ROUTE_CALLS[probe](plan.app.port, route)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * How a worker's command starts per builder, as PID 1 so it gets SIGTERM (contracts/components.md
 * "Process start forms"): the command starts with `exec`. Under Buildpacks it runs through the
 * launcher, also for a Procfile worker, whose name need not be its Procfile type.
 */
function workerStart(plan: DeployPlan, worker: DeployPlan["processes"]["workers"][number]): object {
  const command = composeLiteral(`exec ${worker.command}`);
  switch (plan.app.build?.builder) {
    case "buildpacks":
      // One string, which the launcher runs with bash.
      return { entrypoint: ["/cnb/lifecycle/launcher"], command: [command] };
    case "railpack":
      // The image runs `bash -c` with one string.
      return { command: [command] };
    default:
      return { command: ["sh", "-c", command] };
  }
}

/** How the cron service starts supercronic per builder. */
function cronStart(plan: DeployPlan): object {
  const supercronic = ["supercronic", CRONTAB];
  switch (plan.app.build?.builder) {
    case "buildpacks":
      return { entrypoint: ["/cnb/lifecycle/launcher", "--"], command: supercronic };
    case "railpack":
      return { command: [`exec ${supercronic.join(" ")}`] };
    default:
      return { command: supercronic };
  }
}

/**
 * Cron's memory limit when every enabled job calls one of the app's routes: supercronic and one
 * probe at a time. Measured in Docker with supercronic 0.2.50 calling a route every 2 seconds
 * (T1318, 2026-10-20), peaks with page cache: Node's probe 46 MiB, Python's 50 MiB, Ruby's
 * 35 MiB (34 MiB with `RUBYOPT=-rbundler/setup` and a Rails 8 bundle), PHP's 26 MiB; at 32 MB
 * the kernel kills Node's.
 */
export const CRON_ROUTE_MEMORY_MB = 64;

/**
 * The `cron` container's memory limit: the app's when an enabled job runs a command (the app's code
 * runs there), else {@link CRON_ROUTE_MEMORY_MB}; undefined without an enabled job.
 */
export function cronMemoryMb(plan: {
  app: Pick<DeployPlan["app"], "memoryMb">;
  processes: Pick<DeployPlan["processes"], "cron">;
}): number | undefined {
  const jobs = plan.processes.cron.filter((job) => job.enabled);
  if (jobs.length === 0) return undefined;
  return jobs.some((job) => job.route === undefined) ? plan.app.memoryMb : CRON_ROUTE_MEMORY_MB;
}

/** What the workers and cron share with the app's service. */
export interface ProcessBase {
  image: string;
  /** The app service's `pull_policy`, when it has one (an image built on this computer). */
  pull?: { pull_policy?: string };
  /** The app's `env_file` and `environment`, a new object each time (no YAML aliases). */
  environment: () => object;
  dependsOn: Record<string, { condition: string }>;
  /** How the crontab reaches the cron service: a mounted file, or a config. */
  crontab: { volumes: string[] } | { configs: { source: string; target: string }[] };
}

/**
 * The enabled workers, each its own service of the app's image, and the `cron` service when a
 * cron job is enabled: no published port, no health check (an image's own would only mark them
 * unhealthy), a memory limit (cron's from {@link cronMemoryMb}), a stop grace
 * period, `deploy.replicas` for a worker's count, and the SQLite volume ({@link appVolumes}).
 */
export function renderProcesses(plan: DeployPlan, base: ProcessBase): Record<string, object> {
  const end = (memoryMb: number) => ({
    healthcheck: { disable: true },
    ...memoryLimit(memoryMb),
    ...hardened({ noCapabilities: true, internal: true }),
    ...(Object.keys(base.dependsOn).length > 0
      ? { depends_on: structuredClone(base.dependsOn) }
      : {}),
  });
  const services: Record<string, object> = {};
  for (const worker of plan.processes.workers.filter((worker) => worker.enabled)) {
    services[worker.name] = {
      image: base.image,
      ...base.pull,
      restart: "unless-stopped",
      ...base.environment(),
      ...workerStart(plan, worker),
      ...appVolumes(plan),
      stop_grace_period: `${worker.stopGraceSeconds}s`,
      deploy: { replicas: worker.count },
      ...end(worker.memoryMb),
    };
  }
  const cronMb = cronMemoryMb(plan);
  if (cronMb !== undefined) {
    services.cron = {
      image: base.image,
      ...base.pull,
      restart: "unless-stopped",
      ...base.environment(),
      ...cronStart(plan),
      ...base.crontab,
      ...appVolumes(plan, "volumes" in base.crontab ? base.crontab.volumes : []),
      // supercronic reads its crontab once, when it starts.
      ...configLabel(crontab(plan)),
      stop_grace_period: "10s",
      ...end(cronMb),
    };
  }
  return services;
}

/** The crontab's file name next to compose.yaml on a server, and its mount. */
export const SERVER_CRONTAB = { file: "crontab", mount: `./crontab:${CRONTAB}:ro` };

/** The crontab's config in a Portainer stack and on this computer. */
export const STACK_CRONTAB = { source: "crontab", target: CRONTAB };
