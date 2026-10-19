// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are Compose syntax, not JavaScript templates.
/**
 * The app's components in Compose, for a server's project and for a Portainer stack: the
 * catalog's services, the workers and the `cron` service with its crontab (contracts/components.md).
 */
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import { checkServiceVersion, enabledServices, renderContext, serviceSpec } from "../catalog";
import type { ServiceSpec } from "../catalog/types";
import { IMAGES } from "../pins";
import type { RenderedFile } from "../types";
import { hasCronJobs } from "../workflow/shared";
import { composeLiteral, hardened } from "./services";

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
  /** Named volumes to declare. */
  volumes: string[];
  /** Portainer: the settings files, inline (`configs.<name>.content`). */
  configs: Record<string, { content: string }>;
  /** Server: the settings files next to compose.yaml, in `opscrew/runtime/services/<name>/`. */
  files: RenderedFile[];
}

/**
 * The service's data mounts: on a server the folder `/srv/data/<app>/<service>`, with a subfolder
 * per data folder when there are several; in Portainer, and on a server for an image that runs as
 * its own user, the volume `<service>_data` (`<service>_<name>` when there are several).
 */
function dataMounts(
  plan: DeployPlan,
  service: PlanService,
  spec: ServiceSpec,
  target: ComponentTarget,
): { mounts: string[]; volumes: string[] } {
  const single = typeof spec.dataDir === "string";
  const dirs = Object.entries(
    typeof spec.dataDir === "string" ? { data: spec.dataDir } : spec.dataDir,
  );
  if (target.kind === "portainer" || spec.namedVolume) {
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
      if (target.kind === "portainer") {
        const source = `${service.name}-${file.name}`;
        rendered.configs[source] = { content: composeLiteral(file.content) };
        configs.push({ source, target: file.target });
      } else {
        const path = `services/${service.name}/${file.name}`;
        rendered.files.push({
          path: `opscrew/runtime/${path}`,
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
      ...hardened({ internal: true }),
    };
    rendered.dependsOn[service.name] = { condition: "service_healthy" };
  }
  return rendered;
}

/** Where supercronic finds the crontab in the cron container. */
const CRONTAB = "/etc/opscrew/crontab";

/** A double-quoted shell word: `\`, `"`, `` ` `` and `$` escaped. */
function doubleQuoted(text: string): string {
  return `"${text.replace(/[\\"`$]/g, "\\$&")}"`;
}

/** A single-quoted shell word. */
function singleQuoted(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** A string literal in single quotes, read the same by JavaScript, Python, Ruby and PHP. */
function literal(text: string): string {
  return `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
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
    `node -e ${doubleQuoted(`fetch(${literal(`http://app:${port}${route}`)},{headers:{Authorization:'Bearer '+process.env.CRON_SECRET}}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`)}`,
  python: (port, route) =>
    `python -c ${doubleQuoted(`import os,urllib.request as u;u.urlopen(u.Request(${literal(`http://app:${port}${route}`)},headers={'Authorization':'Bearer '+os.environ['CRON_SECRET']}))`)}`,
  ruby: (port, route) =>
    `ruby -rnet/http -e ${doubleQuoted(`exit Net::HTTP.get_response(URI(${literal(`http://app:${port}${route}`)}),{'Authorization'=>'Bearer '+ENV['CRON_SECRET']}).is_a?(Net::HTTPSuccess)`)}`,
  php: (port, route) =>
    `php -r ${doubleQuoted(`exit(@file_get_contents(${literal(`http://app:${port}${route}`)},false,stream_context_create(['http'=>['header'=>'Authorization: Bearer '.getenv('CRON_SECRET')]]))===false?1:0);`)}`,
  bash: (port, route) =>
    `bash -c ${singleQuoted(
      `exec 3<>/dev/tcp/app/${port} && printf 'GET %s HTTP/1.1\\r\\nHost: app\\r\\nAuthorization: Bearer %s\\r\\nConnection: close\\r\\n\\r\\n' ${singleQuoted(route)} "$CRON_SECRET" >&3 && read -r _ code _ <&3 && [ "\${code#2}" != "$code" ]`,
    )}`,
};

/**
 * `opscrew/runtime/crontab`, the cron service's jobs for supercronic: every enabled job of
 * `processes.cron`, in UTC (`CRON_TZ` covers the whole file, and Alpine images have no other time
 * zone); a run is skipped while the job's last one still runs.
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

/** What the workers and cron share with the app's service. */
export interface ProcessBase {
  image: string;
  /** The app's `env_file` and `environment`, a new object each time (no YAML aliases). */
  environment: () => object;
  dependsOn: Record<string, { condition: string }>;
  /** How the crontab reaches the cron service: a mounted file, or a config. */
  crontab: { volumes: string[] } | { configs: { source: string; target: string }[] };
}

/**
 * The enabled workers, each its own service of the app's image, and the `cron` service when a
 * cron job is enabled: no published port, no health check (an image's own would only mark them
 * unhealthy), a memory limit (cron's is the app's: its jobs run the app's code), a stop grace
 * period, and `deploy.replicas` for a worker's count.
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
      restart: "unless-stopped",
      ...base.environment(),
      ...workerStart(plan, worker),
      stop_grace_period: `${worker.stopGraceSeconds}s`,
      deploy: { replicas: worker.count },
      ...end(worker.memoryMb),
    };
  }
  if (hasCronJobs(plan)) {
    services.cron = {
      image: base.image,
      restart: "unless-stopped",
      ...base.environment(),
      ...cronStart(plan),
      ...base.crontab,
      // supercronic reads its crontab once, when it starts.
      ...configLabel(crontab(plan)),
      stop_grace_period: "10s",
      ...end(plan.app.memoryMb),
    };
  }
  return services;
}

/** The path and mount of the crontab on a server. */
export const SERVER_CRONTAB = { path: "opscrew/runtime/crontab", mount: `./crontab:${CRONTAB}:ro` };

/** The crontab's config in a Portainer stack. */
export const STACK_CRONTAB = { source: "crontab", target: CRONTAB };
