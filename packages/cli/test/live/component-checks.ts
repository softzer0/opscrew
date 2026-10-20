/**
 * The component checks (feature 013, docs/e2e.md "Components"): on the server, every container of
 * the app and the edge has its memory limit, only the edge's Caddy publishes a port, the app sits
 * on the edge's network, nothing restarted, each data folder holds data and belongs to its
 * service's user, each settings file has a mode and owner its service reads and is honoured, and
 * the kernel settings are in place; from this computer, no service port answers, a queued job is
 * consumed and the cron job runs; a value written through the app survives a deploy and a reboot
 * (the Hetzner pass); and the bucket's preflight and cleanup at R2 or Hetzner Object Storage.
 * Messages name services, files and labels, never a secret or an address.
 */
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ProviderBucket, readServerAddresses, storageS3Client } from "@opscrew/agents";
import { resolveProjectPaths } from "@opscrew/core";
import { appDir, EDGE_PROJECT, hostSysctl, serviceSpec } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { expect } from "vitest";
import { type BuilderRun, knownSecrets } from "./builder-checks";
import {
  Cloudflare,
  canConnect,
  hasIpv6Route,
  minutes,
  retryDelete,
  sleep,
  waitFor,
} from "./cloud";
import {
  appProcesses,
  type ComponentSettings,
  componentServices,
  containersOf,
  dataFolderProblems,
  dataFoldersCommand,
  dataMounts,
  EDGE_SERVICES,
  fieldsByKey,
  firstCronRun,
  HONOURED_SETTINGS,
  INSPECT_ALL,
  limitProblems,
  parseContainers,
  portProblems,
  processOwnersCommand,
  r2KeyOfToken,
  restartProblems,
  type ServerContainer,
  SYSCTL_FILE,
  settingsFileProblems,
  settingsMounts,
  statusProblems,
  storageKeyEnv,
  sysctlProblems,
  type WantedServices,
} from "./components-support";
import { CHANGE_FILE, leakSourcesOf } from "./harness";
import { leakedLabels } from "./support";

/** Runs a command on the server and returns its output (as `deploy` on Hetzner, as root on a server the test made). */
export type ServerExec = (command: string) => Promise<string>;

/** Every container on the server. */
export async function serverContainers(exec: ServerExec): Promise<ServerContainer[]> {
  return parseContainers(await exec(INSPECT_ALL));
}

/**
 * The container checks for the Compose projects `projects` (an app's, the edge's, a Portainer
 * app's stacks): each has its memory limit, none but the edge's Caddy publishes a port, and each
 * service of `wanted` runs without having restarted.
 */
export function containerProblems(
  containers: readonly ServerContainer[],
  projects: readonly string[],
  wanted: readonly WantedServices[],
): string[] {
  const ours = containersOf(containers, projects);
  return [...limitProblems(ours), ...portProblems(ours), ...restartProblems(ours, wanted)];
}

/**
 * Everything the local Docker pass could not show, on a server OpsCrew deployed the app to (its
 * own Hetzner server, or the user's): the container checks for the app and the edge, the app on
 * the edge's network; each data folder `/srv/data/<app>/…` non-empty and its service's user's;
 * each mounted settings file readable by its service and writable only by its owner, and the
 * settings MySQL and ClickHouse report matching the file; the kernel settings in OpsCrew's file
 * and in use. `repo` holds the rendered files the deploy copied to the server.
 */
export async function serverProblems(
  exec: ServerExec,
  plan: DeployPlan,
  repo: string,
  afterReboot = false,
): Promise<string[]> {
  const app = plan.app.name;
  const containers = await serverContainers(exec);
  const problems = containerProblems(
    containers,
    [app, EDGE_PROJECT],
    [
      {
        project: app,
        services: componentServices(plan),
        mayRestart: afterReboot ? appProcesses(plan) : [],
      },
      { project: EDGE_PROJECT, services: EDGE_SERVICES },
    ],
  );
  const running = (service: string) =>
    containers.find((c) => c.project === app && c.service === service && c.running);
  problems.push(
    ...containers
      .filter((c) => c.project === app && c.service === "app" && !c.networks.includes(EDGE_PROJECT))
      .map((c) => `${c.name} is not on the edge's network ${EDGE_PROJECT}`),
  );

  const runtime = (file: string) => readFile(join(repo, "opscrew/runtime", file), "utf8");
  const compose = await runtime("compose.yaml");
  const data = dataMounts(compose, app);
  const settings = settingsMounts(compose);
  const readers = [...new Set([...data, ...settings].map((mount) => mount.service))].flatMap(
    (service) => {
      const container = running(service);
      return container === undefined ? [] : [{ service, pid: container.pid }];
    },
  );
  const byPid =
    readers.length === 0
      ? new Map<string, string[]>()
      : fieldsByKey(await exec(processOwnersCommand(readers.map((r) => r.pid))));
  const owners = new Map(
    readers.flatMap(({ service, pid }) => {
      const owner = byPid.get(String(pid))?.[0];
      return owner === undefined ? [] : [[service, owner] as const];
    }),
  );
  if (data.length > 0) {
    const folders = fieldsByKey(
      await exec(
        dataFoldersCommand(
          app,
          data.map((m) => m.path),
        ),
      ),
    );
    problems.push(...dataFolderProblems(data, folders, owners));
  }
  if (settings.length > 0) {
    const stats = fieldsByKey(
      await exec(
        `cd ${appDir(plan)} && stat -c '%n %a %u %g' -- ${settings.map((m) => m.file).join(" ")}`,
      ),
    );
    for (const { service, file } of settings) {
      const [mode, uid, gid] = stats.get(file) ?? [];
      const owner = owners.get(service);
      if (mode === undefined || uid === undefined || gid === undefined || owner === undefined) {
        problems.push(`${file} of ${service} is missing on the server, or ${service} does not run`);
        continue;
      }
      problems.push(...settingsFileProblems(file, { mode, uid, gid }, owner));
    }
  }
  for (const service of plan.services.filter((s) => s.enabled)) {
    const probe = HONOURED_SETTINGS[service.kind];
    const container = running(service.name);
    if (probe === undefined || container === undefined) continue;
    const expected = probe.expected(await runtime(`services/${service.name}/${probe.file}`));
    const actual = (await exec(`docker exec ${container.name} sh -c '${probe.query}'`)).trim();
    if (expected === undefined || actual !== expected) {
      problems.push(
        `${service.name} reports ${probe.what} = ${actual}, not the ${expected ?? "?"} of its ${probe.file}`,
      );
    }
  }
  const wanted = hostSysctl(plan);
  if (Object.keys(wanted).length > 0) {
    const file = await exec(`cat ${SYSCTL_FILE}`).catch(() => "");
    const live: Record<string, string> = {};
    for (const key of Object.keys(wanted)) live[key] = (await exec(`sysctl -n ${key}`)).trim();
    problems.push(...sysctlProblems(file, live, wanted));
  }
  return problems;
}

/** The app's port and each service's port on the server's address that answer from this computer. */
export async function openPorts(
  addresses: readonly { family: "IPv4" | "IPv6"; address: string }[],
  plan: DeployPlan,
): Promise<string[]> {
  const ports = [
    { what: "the app", port: plan.app.port },
    ...plan.services
      .filter((service) => service.enabled)
      .map((service) => ({ what: service.name, port: serviceSpec(service.kind).port })),
  ];
  const open: string[] = [];
  for (const { family, address } of addresses) {
    for (const { what, port } of ports) {
      if (await canConnect(address, port, 3_000)) open.push(`${what} on ${family} port ${port}`);
    }
  }
  return open;
}

// ---------------------------------------------------------------------------------------------
// The examples' routes (examples/README.md): PUT and GET /data, POST and GET /jobs/<id>, GET /cron.

/** One answer of the app: its status and body. */
interface Answer {
  status: number;
  text: string;
}

async function ask(base: string, method: string, path: string, body?: string): Promise<Answer> {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      "User-Agent": "opscrew-e2e",
      ...(body === undefined ? {} : { "Content-Type": "text/plain" }),
    },
    ...(body === undefined ? {} : { body }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, text: await response.text() };
}

/** Asks the app until `done` accepts the answer (an error only means "not yet"); throws after `ms`. */
function untilAnswer(
  base: string,
  request: { method?: string; path: string; body?: string },
  ms: number,
  done: (answer: Answer) => boolean,
): Promise<Answer> {
  const what = `${request.method ?? "GET"} ${request.path} answering as expected`;
  return waitFor(
    what,
    ms,
    async () => {
      const answer = await ask(base, request.method ?? "GET", request.path, request.body);
      if (done(answer)) return answer;
      throw new Error(`HTTP ${answer.status}`);
    },
    2_000,
  );
}

/** Writes `value` through the app (`PUT /data`), into its database, storage or broker. */
export async function writeValue(base: string, value: string): Promise<void> {
  await untilAnswer(
    base,
    { method: "PUT", path: "/data", body: value },
    minutes(1),
    (a) => a.status < 300,
  );
}

/** Reads `value` back through the app (`GET /data`) within two minutes. */
export async function readValue(base: string, value: string): Promise<void> {
  await untilAnswer(
    base,
    { path: "/data" },
    minutes(2),
    (a) => a.status === 200 && a.text === value,
  );
}

/** The server's clock, in ms. */
export async function serverNow(exec: ServerExec): Promise<number> {
  return Number(await exec("date +%s%3N"));
}

/**
 * SC-1302 from this computer: with workers, a job queued through the app is consumed within 30
 * seconds; with a cron job (each one every minute), supercronic's first run succeeds within a
 * minute of its due time, the first full minute after both the cron container's start and
 * `appReadyAt` (when the app answered its health route; both in the server's time), and the app
 * counted it (`GET /cron`).
 */
export async function expectProcesses(
  exec: ServerExec,
  base: string,
  plan: DeployPlan,
  log: (message: string) => void,
  appReadyAt: number,
): Promise<void> {
  if (plan.processes.workers.some((worker) => worker.enabled)) {
    const id = `job-${randomBytes(4).toString("hex")}`;
    await untilAnswer(base, { method: "POST", path: `/jobs/${id}` }, 30_000, (a) => a.status < 300);
    const queued = Date.now();
    await untilAnswer(base, { path: `/jobs/${id}` }, 30_000, (a) => a.status === 200);
    const took = Date.now() - queued;
    expect(took, "milliseconds until the queued job was consumed (SC-1302)").toBeLessThanOrEqual(
      30_000,
    );
    log(`the job was consumed ${(took / 1000).toFixed(1)} s after it was queued`);
  }
  const jobs = plan.processes.cron.filter((job) => job.enabled);
  if (jobs.length > 0) {
    expect(
      jobs.map((job) => job.schedule),
      "every cron job runs each minute (the check's due time)",
    ).toEqual(jobs.map(() => "* * * * *"));
    const cron = (await serverContainers(exec)).find(
      (c) => c.project === plan.app.name && c.service === "cron" && c.running,
    );
    if (cron === undefined) throw new Error("No cron container is running.");
    // Only this start's log: after a reboot the same container keeps the lines of the one before.
    const logs = `docker logs --since ${cron.startedAt} ${cron.name} 2>&1`;
    let run = firstCronRun("", cron.startedAt, appReadyAt);
    const deadline = Date.now() + (run.due + 75_000 - (await serverNow(exec)));
    while (run.ran === undefined && Date.now() <= deadline) {
      run = firstCronRun(await exec(logs), cron.startedAt, appReadyAt);
      if (run.ran === undefined) await sleep(5_000);
    }
    expect(run.ran, "a cron run that succeeded within a minute of its due time").toBeDefined();
    expect(
      (run.ran as number) - run.due,
      "ms between the cron job's due time and its run (SC-1302)",
    ).toBeLessThanOrEqual(60_000);
    await untilAnswer(base, { path: "/cron" }, 30_000, (a) => a.status === 200);
    log(
      `the cron job ran ${(((run.ran as number) - run.due) / 1000).toFixed(1)} s after it was due, and the app counted it`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// The bucket (s3-uploads on Hetzner): its key, and its cleanup at R2 or Hetzner Object Storage.

/** The one object the s3-uploads example writes. */
const APP_OBJECT = "data";

/** What a pass with a bucket gives OpsCrew, and how its cleanup reaches the bucket. */
export interface BucketPass {
  /** `OPSCREW_STORAGE_*` with the bucket's key, for every CLI run. */
  env: Record<string, string>;
  /** Before `destroy --delete-data`: R2 deletes only an empty bucket. */
  empty(bucket: ProviderBucket): Promise<void>;
  /** Throws, saying why, when it cannot tell (another provider's bucket, an unknown answer). */
  exists(bucket: ProviderBucket): Promise<boolean>;
  /** The last resort after a failed teardown: R2's API, or Hetzner's S3 with the user's key. */
  deleteThroughApi?(bucket: ProviderBucket): Promise<void>;
}

/**
 * `exists` for buckets at `provider` only: a bucket at another provider, or a request that fails,
 * is an error that names the bucket and what went wrong.
 */
function existsAt(
  provider: ProviderBucket["provider"],
  exists: (bucket: ProviderBucket) => Promise<boolean>,
): (bucket: ProviderBucket) => Promise<boolean> {
  return async (bucket) => {
    if (bucket.provider !== provider) {
      throw new Error(`the bucket ${bucket.bucket} is on ${bucket.provider}, not on ${provider}`);
    }
    try {
      return await exists(bucket);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new Error(`could not check the bucket ${bucket.bucket} on ${provider}: ${why}`);
    }
  };
}

/**
 * The bucket of `settings` (s3-uploads), before any GitHub or cloud change: for Hetzner Object
 * Storage the user's key; for R2 the key of `OPSCREW_E2E_CLOUDFLARE_TOKEN` itself (Cloudflare's S3
 * credentials of an API token), once that token lists the account's R2 buckets. `{ skip }` says
 * why the pass cannot run. `undefined` for a pass without a bucket.
 */
export async function bucketPass(
  settings: ComponentSettings,
  cloudflareToken: string,
  domain: string,
): Promise<BucketPass | { skip: string } | undefined> {
  const storage = settings.storage;
  if (storage === undefined) return undefined;
  if (storage.provider === "hetzner") {
    const env = storageKeyEnv(storage.key);
    return {
      env,
      empty: async () => undefined,
      exists: existsAt("hetzner", async (bucket) => {
        // Without a signature: a private bucket answers 403, a missing one 404.
        const answer = await fetch(
          `https://${bucket.region}.your-objectstorage.com/${bucket.bucket}`,
          {
            method: "HEAD",
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (answer.status === 404) return false;
        if ([200, 403].includes(answer.status)) return true;
        throw new Error(`Hetzner Object Storage answered HTTP ${answer.status}.`);
      }),
      // A bucket the storage state never held (a create that failed reading it back) survives the
      // engine's destroy: delete it with the user's key.
      deleteThroughApi: async (bucket) => {
        await storageS3Client(bucket, storage.key, { fetch, now: () => new Date() }).deleteBucket();
      },
    };
  }
  const cloudflare = new Cloudflare(cloudflareToken);
  const { accountId } = await cloudflare.zoneOf(domain);
  const buckets = await cloudflare.call("GET", `/accounts/${accountId}/r2/buckets`);
  if (
    buckets.status !== 200 ||
    (buckets.json as { success?: boolean } | undefined)?.success !== true
  ) {
    return {
      skip: `OPSCREW_E2E_R2=1, but Cloudflare did not list the account's R2 buckets with OPSCREW_E2E_CLOUDFLARE_TOKEN (HTTP ${buckets.status}): turn R2 on for the account and give the token Account → Workers R2 Storage → Edit (docs/e2e.md)`,
    };
  }
  const id = await tokenId(cloudflare, accountId);
  const env = storageKeyEnv(r2KeyOfToken(id, cloudflareToken));
  const path = (bucket: ProviderBucket) => `/accounts/${accountId}/r2/buckets/${bucket.bucket}`;
  return {
    env,
    empty: async (bucket) => {
      const deleted = await retryDelete(() =>
        cloudflare.call("DELETE", `${path(bucket)}/objects/${APP_OBJECT}`),
      );
      if (!deleted)
        throw new Error(`Cloudflare did not delete the app's object in ${bucket.bucket}.`);
    },
    exists: existsAt("r2", async (bucket) => {
      const got = await cloudflare.call("GET", path(bucket));
      if (got.status === 404) return false;
      if (got.status === 200) return true;
      throw new Error(`Cloudflare answered HTTP ${got.status}.`);
    }),
    deleteThroughApi: async (bucket) => {
      await retryDelete(() => cloudflare.call("DELETE", path(bucket)));
    },
  };
}

/** The id of the Cloudflare token (a user's token, or the account's own). */
async function tokenId(cloudflare: Cloudflare, accountId: string): Promise<string> {
  for (const path of ["/user/tokens/verify", `/accounts/${accountId}/tokens/verify`]) {
    const verified = await cloudflare.call("GET", path);
    const id = (verified.json as { result?: { id?: string } } | undefined)?.result?.id;
    if (verified.status === 200 && id !== undefined) return id;
  }
  throw new Error("Cloudflare did not say the id of OPSCREW_E2E_CLOUDFLARE_TOKEN (tokens/verify).");
}

// ---------------------------------------------------------------------------------------------
// The Hetzner pass.

/** What the checks need from the deployed run of `live.test.ts`. */
export interface DeployedRun extends BuilderRun {
  appName: string;
  opscrew: (...args: string[]) => Promise<{ exitCode: number; output: string }>;
  git: (...args: string[]) => Promise<string>;
  /** Every CLI output of the run so far (never printed). */
  outputs: readonly string[];
  startedAt: Date;
  /** Reboots the server through Hetzner's API (the deploy user cannot). */
  reboot: () => Promise<void>;
}

/**
 * The checks of a Hetzner component pass after the first deploy (docs/e2e.md "Components"), in
 * order: the plan holds what the pass chose, then {@link onServer} (status, the server, the ports,
 * the worker and cron); a value written through the app, read back after a merged change's deploy
 * and after a reboot; {@link onServer} and drift again; and the leak search over every CLI output,
 * commit, pull request and audit log of the run, with `secrets` (the tokens, the bucket's key)
 * among the known values.
 */
export async function componentChecks(
  run: DeployedRun,
  settings: ComponentSettings,
  secrets: readonly { label: string; value: string | undefined }[],
): Promise<void> {
  const log = (message: string) => console.log(`OpsCrew E2E (${settings.app}): ${message}`);
  const plan = await readArtifact("plan", join(run.repo, "opscrew/plan.yaml"));
  const paths = resolveProjectPaths(run.repo, { env: run.env });
  const address = (await readServerAddresses(paths)).deployment;
  const ipv4 = address?.ipv4 as string;
  const exec: ServerExec = (command) => run.ssh(ipv4, command);
  const probed: { family: "IPv4" | "IPv6"; address: string }[] = [
    { family: "IPv4", address: ipv4 },
  ];
  if (address?.ipv6 !== undefined && (await hasIpv6Route())) {
    probed.push({ family: "IPv6", address: address.ipv6 });
  } else {
    log("IPv6 not probed: no route from this computer");
  }
  const base = plan.deployment.url ?? `http://${ipv4}`;
  if (settings.storage !== undefined) {
    expect(plan.storage?.objectStorage?.provider, "the bucket's provider").toBe(
      settings.storage.provider,
    );
  }
  if (settings.searchEngine) {
    expect(
      Object.keys(hostSysctl(plan)),
      "the kernel settings of the added OpenSearch",
    ).not.toEqual([]);
  }

  const onServer = async (when: string, appReadyAt: number) => {
    expect(
      statusProblems((await run.opscrew("status")).output, plan),
      `the components opscrew status shows ${when}`,
    ).toEqual([]);
    expect(
      await serverProblems(exec, plan, run.repo, when === "after the reboot"),
      `the components on the server ${when}`,
    ).toEqual([]);
    expect(
      await openPorts(probed, plan),
      `ports of the server that answer from this computer ${when}`,
    ).toEqual([]);
    await expectProcesses(exec, base, plan, log, appReadyAt);
    log(
      `${when}: every component runs within its limit, behind the edge, with its data and settings in place`,
    );
  };
  // The deploy starts cron only after the web is up, so its first run is due from its own start
  // (0: no later readiness to wait for). After the reboot, Docker starts everything at once.
  await onServer("after the first deploy", 0);

  const value = `value-${randomBytes(6).toString("hex")}`;
  await writeValue(base, value);
  await readValue(base, value);
  await writeFile(
    join(run.repo, CHANGE_FILE),
    `Deployed with data in place (${new Date().toISOString()}).\n`,
  );
  const changed = await run.github.waitForDeploy({
    headSha: await run.mergeFiles("e2e/change", "e2e: a change deployed with data in place", [
      CHANGE_FILE,
    ]),
  });
  expect(changed.conclusion, "the deploy run of the change").toBe("success");
  await readValue(base, value);
  log("the value written through the app is read back after a deploy");

  const bootId = "cat /proc/sys/kernel/random/boot_id";
  const boot = await exec(bootId);
  log("rebooting the server through Hetzner's API (up to 10 minutes until it is back)");
  await run.reboot();
  await waitFor("the server back with a new boot id", minutes(10), async () =>
    (await exec(bootId)) !== boot ? true : undefined,
  );
  await untilAnswer(base, { path: plan.app.healthPath }, minutes(10), (a) => a.status === 200);
  const readyAt = await serverNow(exec);
  await readValue(base, value);
  log("the value written through the app is read back after a reboot");
  await onServer("after the reboot", readyAt);
  const drift = await run.opscrew("drift");
  expect(drift.exitCode, "opscrew drift after the reboot").toBe(0);

  const known = await knownSecrets(run, plan, secrets);
  const problems: string[] = [];
  for (const [index, output] of run.outputs.entries()) {
    const found = leakedLabels(output, known);
    if (found.length > 0) problems.push(`CLI run #${index + 1} printed: ${found.join(", ")}`);
  }
  const sources = await leakSourcesOf({
    git: run.git,
    github: run.github,
    startedAt: run.startedAt,
    auditDir: paths.auditDir,
  });
  for (const { where, text } of sources) {
    const found = leakedLabels(text, known);
    if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
  }
  // The server's logs: every container of the app and the edge (read, never printed).
  for (const container of containersOf(await serverContainers(exec), [
    plan.app.name,
    EDGE_PROJECT,
  ])) {
    const found = leakedLabels(await exec(`docker logs ${container.name} 2>&1`), known);
    if (found.length > 0) {
      problems.push(`the log of ${container.name} holds ${found.length} known value(s)`);
    }
  }
  for (const problem of problems) log(`leak: ${problem}`);
  expect(problems, "nothing leaked").toEqual([]);
  log(
    `none of the ${known.length} known secret values is in the CLI output, the commits, the pull requests, the audit log or the containers' logs`,
  );
}
