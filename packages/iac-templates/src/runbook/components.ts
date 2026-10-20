import { formatMoney, listText } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { enabledServices, serviceSpec } from "../catalog";
import { appDir } from "../edge";
import { storageRootDir } from "../infra/storage";
import { portainerStackName } from "../portainer-target/stack";
import { STORAGE_NAMES } from "../prices";
import { cronMemoryMb } from "../runtime/components";
import { cell } from "./shared";

/** True for an app in the user's Portainer, whose components are the app's stack. */
function inPortainer(plan: DeployPlan): boolean {
  return plan.target.provider === "portainer";
}

/** The app's Compose project: its name on a server, its stack's name in Portainer. */
function projectOf(plan: DeployPlan): string {
  return inPortainer(plan) ? portainerStackName(plan) : plan.app.name;
}

/**
 * Where a service keeps its data: on a server the folder `/srv/data/<app>/<service>`, or the
 * Docker volume of an image that runs as its own user; in Portainer, the stack's named volume.
 */
function dataPlace(plan: DeployPlan, service: DeployPlan["services"][number]): string {
  const spec = serviceSpec(service.kind);
  if (spec.namedVolume === true || inPortainer(plan)) {
    const dirs = typeof spec.dataDir === "string" ? ["data"] : Object.keys(spec.dataDir);
    return `the Docker volume${dirs.length > 1 ? "s" : ""} ${listText(dirs.map((dir) => `\`${projectOf(plan)}_${service.name}_${dir}\``))}`;
  }
  return `\`/srv/data/${plan.app.name}/${service.name}\``;
}

/**
 * The "Database" cell on a server: what keeps the app's data there (each service, SQLite), or the
 * external services; `backups` says how the server is backed up.
 */
export function dataCell(plan: DeployPlan, backups: string, external: string): string {
  const services = enabledServices(plan);
  const sqlite = plan.storage?.sqlite !== undefined;
  const stores = [
    ...services.map((s) => `${serviceSpec(s.kind).title} ${s.version}`),
    ...(sqlite ? ["SQLite"] : []),
  ];
  if (stores.length === 0) return external;
  const folder = services.some((s) => serviceSpec(s.kind).namedVolume !== true);
  const volumes = sqlite || services.some((s) => serviceSpec(s.kind).namedVolume === true);
  const places = [
    ...(folder ? [`\`/srv/data/${plan.app.name}\``] : []),
    ...(volumes ? ["Docker volumes"] : []),
  ];
  return `${listText(stores)} on the server, data in ${listText(places)} (see Components); ${backups}`;
}

/**
 * "Components": each container of the app's Compose project (on a server) or stack (in the
 * user's Portainer) with what it runs, its memory limit and where it keeps its data
 * (`/srv/data/<app>/<name>` or a Docker volume), the cron jobs (UTC) and the SQLite volume, and
 * how to change them.
 */
export function componentsSection(plan: DeployPlan): string[] {
  const portainer = inPortainer(plan);
  const project = projectOf(plan);
  const { workers, cron } = plan.processes;
  const jobs = cron.filter((job) => job.enabled);
  const cronMb = cronMemoryMb(plan);
  const rows = [
    `| \`app\` | the web process | ${plan.app.memoryMb} MB | |`,
    ...workers
      .filter((worker) => worker.enabled)
      .map(
        (worker) =>
          `| \`${worker.name}\` | ${cell(`\`${worker.command}\``)}${worker.count > 1 ? `, ${worker.count} copies` : ""}${worker.single ? ", one copy only" : ""} | ${worker.memoryMb} MB${worker.count > 1 ? " each" : ""} | |`,
      ),
    ...(cronMb === undefined
      ? []
      : [`| \`cron\` | the cron jobs below, with supercronic | ${cronMb} MB | |`]),
    ...enabledServices(plan).map((service) => {
      const spec = serviceSpec(service.kind);
      return `| \`${service.name}\` | ${spec.title} ${service.version} (${spec.licence.id}) | ${service.memoryMb} MB | ${dataPlace(plan, service)} |`;
    }),
  ];
  const lines = [
    "## Components",
    "",
    ...(portainer
      ? [
          `The app runs as the stack \`${project}\` in your Portainer. Each component is a container with its own memory`,
          "limit, and none publishes a port.",
        ]
      : [
          `The app runs as the Docker Compose project \`${project}\` in \`${appDir(plan)}\` on the server. Each component is a`,
          "container with its own memory limit, and none publishes a port: only the edge (below) takes web traffic.",
        ]),
    "",
    "| Component | Runs | Memory limit | Data |",
    "|---|---|---|---|",
    ...rows,
    "",
  ];
  if (jobs.length > 0) {
    lines.push(
      `Cron jobs${portainer ? "" : ", in `opscrew/runtime/crontab`"} (times in UTC; a run is skipped while the last one still runs):`,
      "",
      ...jobs.map((job) =>
        job.route === undefined
          ? `- \`${job.name}\`: \`${job.schedule}\`, \`${job.command}\``
          : `- \`${job.name}\`: \`${job.schedule}\`, a GET of \`${job.route}\` with the generated \`CRON_SECRET\` as its bearer token`,
      ),
      "",
    );
  }
  const sqlite = plan.storage?.sqlite;
  if (sqlite !== undefined) {
    lines.push(
      `The app's SQLite database is in \`${sqlite.dir}/\`, on the Docker volume \`${project}_sqlite\`, which every deploy`,
      "keeps. Each deploy stops the old version before the new one starts, so two copies never write to it at once.",
      "",
    );
  }
  lines.push(
    portainer
      ? "`opscrew status` shows whether each component runs, and Portainer shows each container's log. Change a"
      : "`opscrew status` shows whether each component runs, and `docker compose logs <component>` in the app's folder shows",
    portainer
      ? "component's count, memory or version, or turn one off, in `opscrew/plan.yaml`, then run `opscrew design` and"
      : "its log. Change a component's count, memory or version, or turn one off, in `opscrew/plan.yaml`, then run",
    portainer
      ? "`opscrew provision`."
      : "`opscrew design` (it checks that everything fits the server and keeps your changes) and `opscrew provision`.",
    "",
  );
  return lines;
}

/**
 * "The shared edge": Caddy and kamal-proxy in `/srv/edge`, the app's site file, and how deploys
 * keep the newest edge. `shared`: a server several OpsCrew apps may share (the user's own).
 */
export function edgeSection(plan: DeployPlan, shared: boolean): string[] {
  const name = plan.app.name;
  return [
    shared ? "## The shared edge" : "## The edge",
    "",
    "Web traffic reaches the app through OpsCrew's edge in `/srv/edge`, the Compose project `opscrew-edge`: Caddy",
    "serves HTTPS and passes each request to kamal-proxy, which switches deploys without downtime. The app's site is",
    `\`/srv/edge/sites/${name}.caddy\` (from \`opscrew/runtime/edge/sites/${name}.caddy\`). Each deploy copies the edge's files`,
    "from `opscrew/runtime/edge/` and replaces the edge only with a newer version, so an older app never downgrades it.",
    ...(shared
      ? [
          "Every OpsCrew app on this server sits behind the same edge, each with its own folders in `/srv/apps` and",
          "`/srv/data` and its own site file. `opscrew destroy` removes the edge only with the last app.",
        ]
      : []),
    "",
  ];
}

/**
 * "Object storage": the app's bucket, its estimated price with its source and date, and the
 * storage key: the user's own, created in the provider's console, kept on the machine that ran
 * provision and never in the repository or in infrastructure state (Garage's is generated).
 */
export function objectStorageSection(plan: DeployPlan, projectDir: string): string[] {
  const storage = plan.storage?.objectStorage;
  if (storage === undefined) return [];
  const { price } = storage;
  const priced = `${formatMoney({ amount: price.monthly, currency: price.currency })} a month for ${storage.expected.storageGb} GB stored and ${storage.expected.egressGbPerMonth} GB sent a month (from ${price.source}, checked on ${price.checkedOn})`;
  const garage = enabledServices(plan).find((service) => service.kind === "garage");
  if (storage.provider === "garage" && garage !== undefined) {
    return [
      "## Object storage",
      "",
      `The app's files are in the bucket \`${storage.bucket}\` of Garage, the component \`${garage.name}\`, which keeps them in`,
      `${dataPlace(plan, garage)} on the server's own disk, at no extra cost. Its key is generated by OpsCrew and`,
      "reaches the app as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`; it is never written to this repository.",
      "",
    ];
  }
  return [
    "## Object storage",
    "",
    `The app's files are in the private bucket \`${storage.bucket}\` on ${STORAGE_NAMES[storage.provider]} (${storage.region}), about`,
    `${priced}. OpsCrew creates the bucket in its own root, \`${storageRootDir(plan)}/\`, so \`opscrew destroy\` keeps it`,
    "with its files unless you add `--delete-data`.",
    "",
    "- **The storage key is yours.** OpsCrew never creates one: you created it in the provider's console with the steps",
    "  `opscrew provision` showed. OpsCrew keeps it on the machine that ran `opscrew provision`",
    `  (\`${projectDir}/storage_key.json\`), never in this repository or in infrastructure state, and the app gets it`,
    "  as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_REGION` and `AWS_ENDPOINT_URL_S3`.",
    "- **To replace it:** create a new key, delete the stored copy (or set `OPSCREW_STORAGE_ACCESS_KEY_ID` and",
    "  `OPSCREW_STORAGE_SECRET_ACCESS_KEY` to it in scripts), run `opscrew provision` to give it to the app, re-run the",
    "  deploy workflow, then revoke the old key in the provider's console.",
    "",
  ];
}
