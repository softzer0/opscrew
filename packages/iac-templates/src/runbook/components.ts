import { formatMoney, listText } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { dataDirs, enabledServices, serviceSpec } from "../catalog";
import { appDir, EDGE_PROXIES, type EdgeProxy, edgeProxy } from "../edge";
import { CAA_ISSUERS } from "../infra/cloudflare";
import { storageRootDir } from "../infra/storage";
import { portainerStackName } from "../portainer-target/stack";
import { usesCloudflare } from "../predicates";
import { STORAGE_NAMES } from "../prices";
import { cronMemoryMb } from "../runtime/components";
import { runtimeDir } from "../runtime-dir";
import { tunnelMode } from "../tunnel";
import { planFilePath } from "../workflow/shared";
import { cell, opscrew, runbookFolders } from "./shared";

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
    const dirs = dataDirs(spec);
    return `the Docker volume${dirs.length > 1 ? "s" : ""} ${listText(dirs.map(([name]) => `\`${projectOf(plan)}_${service.name}_${name}\``))}`;
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
export function componentsSection(plan: DeployPlan, environments?: readonly string[]): string[] {
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
      `Cron jobs${portainer ? "" : `, in \`${runtimeDir(plan)}/crontab\``} (times in UTC; a run is skipped while the last one still runs):`,
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
  const status = `\`${opscrew(plan, "status", environments)}\``;
  const design = `\`${opscrew(plan, "design", environments)}\``;
  const provision = `\`${opscrew(plan, "provision", environments)}\``;
  // The components follow the image (FR-1539): a promoted environment's design copies them from
  // its source's plan, so they change there; any other environment's are its own plan's.
  const from = plan.environment?.deploySource;
  const where =
    from?.from === "promote"
      ? `\`${from.source}\`'s plan (\`${planFilePath(from.source)}\`): ${plan.environment?.name ?? "prod"} copies its components from it at its next design`
      : `\`${runbookFolders(plan, undefined).artefacts}/plan.yaml\``;
  lines.push(
    portainer
      ? `${status} shows whether each component runs, and Portainer shows each container's log. Change a`
      : `${status} shows whether each component runs, and \`docker compose logs <component>\` in the app's folder shows`,
    portainer
      ? `component's count, memory or version, or turn one off, in ${where}, then run ${design} and`
      : `its log. Change a component's count, memory or version, or turn one off, in ${where}, then run`,
    portainer
      ? `${provision}.`
      : `${design} (it checks that everything fits the server and keeps your changes) and ${provision}.`,
    "",
  );
  return lines;
}

/**
 * "The shared edge": the server's proxy (Caddy, or nginx with certbot) and kamal-proxy in
 * `/srv/edge`, the app's site file and the user's additions, how deploys keep the newest edge, and
 * the app's certificates with their renewal. `shared`: a server several OpsCrew apps may share
 * (the user's own).
 */
export function edgeSection(
  plan: DeployPlan,
  shared: boolean,
  environments: readonly string[] | undefined,
): string[] {
  const name = plan.app.name;
  const proxy = edgeProxy(plan);
  const { label, site, additions } = EDGE_PROXIES[proxy];
  return [
    shared ? "## The shared edge" : "## The edge",
    "",
    `Web traffic reaches the app through OpsCrew's edge in \`/srv/edge\`, the Compose project \`opscrew-edge\`: ${label}`,
    "serves HTTPS and passes each request to kamal-proxy, which switches deploys without downtime. The app's site is",
    `\`/srv/edge/sites/${name}.${site}\` (from \`${runtimeDir(plan)}/edge/sites/${name}.${site}\`). Each deploy copies the edge's files`,
    `from \`${runtimeDir(plan)}/edge/\` and replaces the edge only with a newer version, so an older app never downgrades it.`,
    ...(shared
      ? [
          "Every OpsCrew app on this server sits behind the same edge, each with its own folders in `/srv/apps` and",
          `\`/srv/data\` and its own site file. \`${opscrew(plan, "destroy", environments)}\` removes the edge only with the last app.`,
        ]
      : []),
    "",
    `- **Your own rules:** \`${additions}\` holds this app's own ${label} rules (headers, redirects, rate limits, basic`,
    "  authentication). OpsCrew checks them with its rules and with the proxy's own checker before they go live.",
    `- **The proxy:** \`target.edge\` in \`${runbookFolders(plan, undefined).artefacts}/plan.yaml\` (\`caddy\` or \`nginx\`). Every app on a server uses the same one;`,
    "  it can be switched while the server holds only one OpsCrew app, with a short interruption the plan states.",
    ...certificateLines(plan, proxy, environments),
    "",
  ];
}

/** The app's certificates and who renews them, for "The edge". */
function certificateLines(
  plan: DeployPlan,
  proxy: EdgeProxy,
  environments: readonly string[] | undefined,
): string[] {
  if (tunnelMode(plan)) {
    return [
      "- **Certificates:** Cloudflare's edge serves HTTPS; the tunnel needs no certificate on the server.",
    ];
  }
  if (!usesCloudflare(plan) || plan.dns.domain === undefined) return [];
  const [status, verify, secure] = ["status", "verify", "secure"].map(
    (command) => `\`${opscrew(plan, command, environments)}\``,
  );
  if (plan.dns.proxied) {
    return [
      "- **Certificates:** the server serves a Cloudflare origin certificate for this app's hostnames (valid for 15 years)",
      "  and refuses any connection without this app's own client certificate, which only Cloudflare sends for your",
      `  zone. ${status} shows both and when they expire; \`${opscrew(plan, "provision", environments)}\` replaces the origin certificate`,
      "  when fewer than 30 days remain. Without the Cloudflare token's SSL and Certificates permission the site keeps",
      `  public certificates, and ${secure} lists the gap.`,
    ];
  }
  const caa = `OpsCrew's CAA records name only ${listText(CAA_ISSUERS[proxy].map((issuer) => `\`${issuer}\``))} (none at the zone's apex).`;
  return proxy === "nginx"
    ? [
        "- **Certificates:** certbot gets the first certificate from Let's Encrypt during the first deploy and renews it",
        `  twice a day when it is due; nginx reloads without dropping connections. ${status}, ${verify}`,
        `  and ${secure} warn 30 days before a certificate expires, with certbot's reason when a renewal failed.`,
        `  ${caa}`,
      ]
    : [
        "- **Certificates:** Caddy gets and renews the certificates itself (Let's Encrypt, with ZeroSSL as its fallback).",
        `  ${status}, ${verify} and ${secure} warn 30 days before a certificate expires.`,
        `  ${caa}`,
      ];
}

/**
 * "The secrets recovery copy": what the environment's `secrets.sops.json` holds, how it stays
 * current, how to restore it on another computer (with OpsCrew, or with sops alone) and how to
 * change the key.
 */
export function recoverySection(plan: DeployPlan, environments?: readonly string[]): string[] {
  const copy = `${runbookFolders(plan, undefined).artefacts}/secrets.sops.json`;
  const provision = opscrew(plan, "provision", environments);
  const restore = `${opscrew(plan, "secrets restore", environments)} --key-file <your age key file>`;
  const column = Math.max(restore.length, provision.length) + 3;
  return [
    "## The secrets recovery copy",
    "",
    `\`${copy}\` is an encrypted copy of what OpsCrew keeps for this app on the machine that ran`,
    `\`${provision}\`: the generated passwords and keys, the deploy key, the infrastructure state and its passphrase,`,
    "and OpsCrew's records. Only your age key (or your backup key) opens it, and OpsCrew keeps no copy of the key.",
    `\`${provision}\` updates it in its pull request whenever one of those files changes; \`${opscrew(plan, "secrets status", environments)}\``,
    "shows when it was last updated and whether it is behind.",
    "",
    "To manage the deployment from another computer:",
    "",
    "```bash",
    "git clone <this repository> && cd <it>",
    `${restore.padEnd(column)}# or without --key-file, to paste the key unseen`,
    `${provision.padEnd(column)}# reuses the restored files: nothing is generated again`,
    "```",
    "",
    `- **Without OpsCrew:** \`SOPS_AGE_KEY_FILE=<your age key file> sops decrypt ${copy}\` prints the files.`,
    `- **A new key:** \`${opscrew(plan, "secrets rotate", environments)} --key-out <file>\` writes a new key to that file and proposes the copy,`,
    "  encrypted to it, in a pull request. Older commits still open with the old key: if it leaked, change the secrets",
    "  themselves too.",
    "",
  ];
}

/**
 * "Object storage": the app's bucket, its estimated price with its source and date, and the
 * storage key: the user's own, created in the provider's console, kept on the machine that ran
 * provision and never in the repository or in infrastructure state (Garage's is generated).
 */
export function objectStorageSection(
  plan: DeployPlan,
  projectDir: string,
  environments?: readonly string[],
): string[] {
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
  const provision = `\`${opscrew(plan, "provision", environments)}\``;
  return [
    "## Object storage",
    "",
    `The app's files are in the private bucket \`${storage.bucket}\` on ${STORAGE_NAMES[storage.provider]} (${storage.region}), about`,
    `${priced}. OpsCrew creates the bucket in its own root, \`${storageRootDir(plan)}/\`, so \`${opscrew(plan, "destroy", environments)}\` keeps it`,
    "with its files unless you add `--delete-data`.",
    "",
    "- **The storage key is yours.** OpsCrew never creates one: you created it in the provider's console with the steps",
    `  ${provision} showed. OpsCrew keeps it on the machine that ran ${provision}`,
    `  (\`${projectDir}/storage_key.json\`), never in this repository or in infrastructure state, and the app gets it`,
    "  as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_REGION` and `AWS_ENDPOINT_URL_S3`.",
    "- **To replace it:** create a new key, delete the stored copy (or set `OPSCREW_STORAGE_ACCESS_KEY_ID` and",
    `  \`OPSCREW_STORAGE_SECRET_ACCESS_KEY\` to it in scripts), run ${provision} to give it to the app, re-run the`,
    "  deploy workflow, then revoke the old key in the provider's console.",
    "",
  ];
}
