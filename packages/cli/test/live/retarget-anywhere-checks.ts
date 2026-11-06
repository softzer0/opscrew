/**
 * What feature 023's live pass (`retarget-anywhere.test.ts`) needs on top of the harness that
 * reaches servers, providers or GitHub:
 * - `opscrew retarget` run until it is done, as a script does: each plan approved by the hash of
 *   the command it printed, with the names that command types, the move's workflow pull request
 *   merged, and optionally a stop at the maintenance window;
 * - the example's data seeded and read in the containers of a side;
 * - a Portainer set up as the user's on a throwaway server;
 * - DigitalOcean: a throwaway Spaces key, and what OpsCrew created there for the app;
 * - the end of a move a failed step left, and the leak search over every output, commit, pull
 *   request, audit entry and saved plan.
 * Nothing here prints a secret or an address: everything logged goes through the run's scrubber.
 */
import { randomBytes } from "node:crypto";
import { copyFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEPLOY_SETUP_BRANCH, readServerAddresses } from "@opscrew/agents";
import { inspectCertificate } from "@opscrew/connector-portainer";
import { writeArtifact } from "@opscrew/plan-schema";
import { expect } from "vitest";
import { api, minutes, RootShell, retryDelete, waitFor } from "./cloud";
import { type ServerExec, writeValue } from "./component-checks";
import { type AppEnvironments, designProd, TESTER_LABEL } from "./environment-checks";
import type { LiveRun } from "./harness";
import { PortainerApi, publicIpv4 } from "./portainer-cloud";
import {
  ENVIRONMENT_NAME,
  firewallRules,
  isEncryptedPlan,
  multipartForm,
  PORTAINER_IMAGE,
  PORTAINER_PORT,
  setupTokenFromLogs,
} from "./portainer-support";
import {
  composeProjectOf,
  confirmNames,
  type DataSnapshot,
  dataProblems,
  flagValue,
  inContainer,
  jobsDigest,
  MOVE_SERVICES,
  printedApproval,
  READ_SCRIPTS,
  recordAddresses,
  SQLITE_SCRIPT,
  seedProblems,
  seedScripts,
  spacesKeyOf,
  windowRefused,
  withFlags,
  withMoveServices,
} from "./retarget-anywhere-support";
import { addressLinesOutsidePurpose, leakedLabels } from "./support";

// ---------------------------------------------------------------------------------------------
// `opscrew retarget` until it is done.

/** One move (or its `--finish` or `--abort`) run as a script runs it. */
export interface MoveRuns {
  /** In the log and in errors. */
  label: string;
  /** The first run's flags (`--to …` and the new side's answers). */
  start?: readonly string[];
  /** The flag groups every run passes besides what the printed command has. */
  always: readonly (readonly string[])[];
  /** The names a printed command may type with `--confirm`; any other stops the run, unapproved. */
  names: readonly string[];
  /** `false`: stop at the maintenance window's approval and return the command that allows it. */
  downtime?: boolean;
}

/** How {@link retargetUntilDone} ended. */
export type MoveOutcome =
  | { kind: "done"; runs: number; confirmed: string[] }
  | { kind: "window"; args: string[] };

/** A move's runs: `--yes` and the maintenance window allowed (`--allow-downtime`). */
export const MOVE_FLAGS: readonly (readonly string[])[] = [["--yes"], ["--allow-downtime"]];

/** `--finish` (or `--abort`) of the move of `app`, typing the app's name; no snapshot of a server. */
export function endFlags(mode: "finish" | "abort", app: string): (readonly string[])[] {
  return [
    [`--${mode}`],
    ["--confirm", app],
    ["--yes"],
    ...(mode === "finish" ? [["--no-snapshot"]] : []),
  ];
}

/**
 * Runs `opscrew retarget` until it exits 0, as a script does after reviewing each stop: a plan's
 * stop is answered with the command it printed (`--approve <hash>` and the names it types, which
 * must be among `names`) plus `always`; a stop at the move's deploy workflow (its pull request
 * open on `opscrew/deploy-setup`) by merging that pull request and running again. Once done, the
 * files the move published are merged too. With `downtime` false, the maintenance window's
 * refusal (any other stop that names `--allow-downtime` and no new plan) ends the runs, returning
 * the command that allows it. Returns how many runs it took and every name typed.
 */
export async function retargetUntilDone(run: LiveRun, options: MoveRuns): Promise<MoveOutcome> {
  const { label, always, names } = options;
  const downtime = options.downtime ?? true;
  let args = withFlags(options.start ?? [], always, downtime);
  let approved = flagValue(args, "--approve");
  const confirmed = new Set<string>();
  let merges = 0;
  for (let runs = 1; runs <= 16; runs++) {
    for (const name of confirmNames(args)) confirmed.add(name);
    const result = await run.opscrew("retarget", ...args);
    if (result.exitCode === 0) {
      await run.mergeDeploySetup(`${label}: the files the move published`);
      return { kind: "done", runs, confirmed: [...confirmed] };
    }
    const printed = printedApproval(result.output);
    const hash = printed === undefined ? undefined : flagValue(printed, "--approve");
    if (printed !== undefined && hash !== approved) {
      const unexpected = confirmNames(printed).filter((name) => !names.includes(name));
      if (unexpected.length > 0) {
        throw new Error(
          `${label}: the printed command types ${unexpected.join(", ")}, none of the names this leg may delete (${names.join(", ")}); nothing was approved.`,
        );
      }
      run.log(`${label}: approving the plan the move stopped at`);
      approved = hash;
      args = withFlags(printed, always, downtime);
      continue;
    }
    const head = await run.git("rev-parse", "--abbrev-ref", "HEAD");
    if (head.startsWith(DEPLOY_SETUP_BRANCH) && merges < 3) {
      merges++;
      await run.mergeDeploySetup(`${label}: the move's deploy workflow`);
      approved = undefined;
      args = withFlags([], always, downtime);
      continue;
    }
    if (!downtime && windowRefused(result.output, approved)) {
      run.log(`${label}: the move stopped at the maintenance window's approval`);
      return { kind: "window", args: withFlags(args, [["--allow-downtime"]], true) };
    }
    throw new Error(
      `${label}: opscrew retarget ${args.join(" ")} exited with ${result.exitCode}:\n${run.tail(result.output)}`,
    );
  }
  throw new Error(`${label}: opscrew retarget did not finish after 16 runs.`);
}

/**
 * The end of a move a failed step left half-way, so that `opscrew destroy` (the cleanup's) can
 * run: `--finish` after the switch, else `--abort`, each typing only `names`. Nothing when no
 * move is recorded.
 */
export async function endMove(run: LiveRun, names: readonly string[]): Promise<void> {
  if (!run.repoReady || run.appName === undefined) return;
  const plan = await run.readPlan().catch(() => undefined);
  const move = plan?.retarget;
  if (plan === undefined || move === undefined) return;
  const mode = move.step === "switched" && move.abort === undefined ? "finish" : "abort";
  run.log(`a move was left at its step ${move.step}: running --${mode} so destroy can run`);
  await retargetUntilDone(run, {
    label: `the --${mode} of the move a failed step left`,
    always: endFlags(mode, plan.app.name),
    names,
  });
}

// ---------------------------------------------------------------------------------------------
// The servers and the example's data.

/** `command` as the shell's user, with up to 10 minutes for it. */
export function execOn(shell: RootShell): ServerExec {
  return (command) => shell.ok(command, minutes(10));
}

/**
 * `deploy`'s login to the server OpsCrew recorded for the app now, with copies of its deploy key
 * and known hosts (named `name`), so it keeps reaching that server after a move changed them.
 */
export async function keptShell(
  run: LiveRun,
  envs: AppEnvironments,
  name: string,
): Promise<RootShell> {
  const paths = envs.paths();
  const host = (await readServerAddresses(paths)).deployment?.ipv4;
  if (host === undefined) throw new Error("OpsCrew recorded no server for the app.");
  const keyFile = join(run.work, "keys", `${name}-deploy`);
  const knownHostsFile = join(run.work, "keys", `${name}-known_hosts`);
  await copyFile(paths.files.deployKey, keyFile);
  await copyFile(paths.files.knownHosts, knownHostsFile);
  return new RootShell(run.runner, { host, keyFile, knownHostsFile, env: run.env, user: "deploy" });
}

/** What {@link deployDataApp} leaves: the seeded data, the value in SQLite, the server's login. */
export interface DataApp {
  seeded: DataSnapshot;
  value: string;
  /** `deploy` on the first Hetzner server (kept: the move changes OpsCrew's record). */
  hetzner: RootShell;
}

/**
 * The server legs' app, as a user starts it at Hetzner: examples/flask-sqlite designed for prod
 * (behind Cloudflare on the run's hostname), Postgres, MySQL and a Valkey queue added in
 * plan.yaml and designed again, adapt, provision and the first deploy on an x86 server. Then the
 * data: rows in both databases, jobs in Valkey, and a value written through the app into its
 * SQLite file.
 */
export async function deployDataApp(
  run: LiveRun,
  envs: AppEnvironments,
  region: string,
): Promise<DataApp> {
  await designProd(run, envs, region);
  await writeArtifact("plan", run.paths().files.plan, withMoveServices(await run.readPlan()));
  await run.opscrewOk("design");
  const plan = await envs.designed("prod");
  expect(
    plan.services.filter((service) => service.enabled).map((service) => service.name),
    "the services design kept",
  ).toEqual(expect.arrayContaining(Object.values(MOVE_SERVICES)));
  await run.adaptAndMerge();
  await envs.provision("prod", "the app at Hetzner");
  await run.deployAny("the first deploy at Hetzner");
  await run.waitForHealth();
  const hetzner = await keptShell(run, envs, "hetzner-first");
  expect(await hetzner.ok("uname -m"), "the first Hetzner server's architecture").toBe("x86_64");
  const exec = execOn(hetzner);
  await seedData(run, exec, composeProjectOf(plan));
  const value = `value-${run.runId}`;
  await writeValue(`https://${run.appHost}`, value);
  const seeded = await readData(exec, composeProjectOf(plan));
  expect(seedProblems(seeded), "services whose data the seed did not write").toEqual([]);
  run.log("seeded: rows in Postgres and MySQL, jobs in Valkey, a value in the app's SQLite file");
  return { seeded, value, hetzner };
}

/** Seeds every added service in `project`, each tried again for up to 5 minutes while it starts. */
async function seedData(run: LiveRun, exec: ServerExec, project: string): Promise<void> {
  const scripts = seedScripts(run.runId);
  for (const kind of Object.keys(MOVE_SERVICES) as (keyof typeof MOVE_SERVICES)[]) {
    await waitFor(
      `seeding ${kind}`,
      minutes(5),
      async () => {
        await exec(inContainer(project, MOVE_SERVICES[kind], scripts[kind]));
        return true;
      },
      10_000,
    );
  }
}

/**
 * The data in `project` on a side, read through `exec`: each read tried again for up to 5
 * minutes while the services start.
 */
export function readData(exec: ServerExec, project: string): Promise<DataSnapshot> {
  return waitFor(
    `reading the data in ${project}`,
    minutes(5),
    async () => ({
      postgres: await exec(inContainer(project, MOVE_SERVICES.postgres, READ_SCRIPTS.postgres)),
      mysql: await exec(inContainer(project, MOVE_SERVICES.mysql, READ_SCRIPTS.mysql)),
      jobs: jobsDigest(await exec(inContainer(project, MOVE_SERVICES.valkey, READ_SCRIPTS.valkey))),
      sqlite: await exec(inContainer(project, "app", SQLITE_SCRIPT)),
    }),
    10_000,
  );
}

/** Every row, job and file seeded is in `project` on the side `where`. */
export async function expectData(
  exec: ServerExec,
  project: string,
  seeded: DataSnapshot,
  where: string,
): Promise<void> {
  expect(dataProblems(seeded, await readData(exec, project)), `the data on ${where}`).toEqual([]);
}

/** The architecture of the image the app's container in `project` runs (`amd64`, `arm64`). */
export function appArchitecture(exec: ServerExec, project: string): Promise<string> {
  return exec(
    `c=$(docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=app); docker image inspect -f '{{.Architecture}}' "$(docker inspect -f '{{.Image}}' "$c")"`,
  );
}

/**
 * The folder on the host that holds `service`'s data in `project` (its container running or not):
 * the mount at `destination` in the container, a named volume's folder or a bound folder alike.
 * On a server OpsCrew deploys to over SSH the data is a folder bound from /srv/data/<app>/; in
 * Portainer it is a named volume (found in T2317 own run 3).
 */
export async function volumeFolder(
  exec: ServerExec,
  project: string,
  service: string,
  destination = "/var/lib/mysql",
): Promise<string> {
  const folder = (
    await exec(
      `c=$(docker ps -aq --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=${service}); docker inspect -f '{{range .Mounts}}{{if eq .Destination "${destination}"}}{{.Source}}{{end}}{{end}}' "$c"`,
    )
  ).trim();
  if (folder === "") throw new Error(`${service} in ${project} has no mount at ${destination}.`);
  return folder;
}

/** Nothing of `project` is left on the host: no container and no volume. */
export async function expectProjectGone(exec: ServerExec, project: string): Promise<void> {
  const label = `label=com.docker.compose.project=${project}`;
  expect(await exec(`docker ps -aq --filter ${label}`), `containers of ${project}`).toBe("");
  expect(await exec(`docker volume ls -q --filter ${label}`), `volumes of ${project}`).toBe("");
}

// ---------------------------------------------------------------------------------------------
// The user's Portainer on a throwaway server.

/** The Portainer the leg set up as the user's. */
export interface PortainerHost {
  url: string;
  fingerprint: string;
  environmentId: number;
  /** The admin's API key, which OpsCrew gets as `PORTAINER_API_KEY`. */
  token: string;
  api: PortainerApi;
}

/**
 * As a user runs Portainer: the throwaway server (its firewall lets Portainer's port in from this
 * computer only), Docker from get.docker.com, Portainer CE in a container, its admin (with the
 * setup token it prints once), the local Docker host as its environment, and the admin's API key.
 * Every secret and address is masked from then on.
 */
export async function setUpPortainer(run: LiveRun): Promise<PortainerHost> {
  const tester = await publicIpv4();
  run.scrubber.add(tester, TESTER_LABEL);
  await run.createServer(firewallRules(tester));
  const shell = run.shell();
  run.log("installing Docker with get.docker.com (up to 10 minutes)");
  await shell.ok(
    "curl -fsSL https://get.docker.com -o /root/get-docker.sh && sh /root/get-docker.sh > /root/get-docker.log 2>&1",
    minutes(10),
  );
  run.log(`starting ${PORTAINER_IMAGE}`);
  await shell.ok(
    `docker volume create portainer_data >/dev/null && docker run -d --name portainer --restart=always -p ${PORTAINER_PORT}:${PORTAINER_PORT} -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data ${PORTAINER_IMAGE} >/dev/null`,
    minutes(5),
  );
  const url = `https://${run.ipv4()}:${PORTAINER_PORT}`;
  const { fingerprint } = await waitFor(
    "Portainer's certificate from this computer",
    minutes(3),
    () => inspectCertificate(url),
    5_000,
  );
  const anonymous = new PortainerApi(url, fingerprint);
  const setupToken = await waitFor(
    "Portainer's setup_token= line in `docker logs portainer`",
    minutes(1),
    async () => setupTokenFromLogs(await shell.ok("docker logs portainer 2>&1")),
    3_000,
  );
  run.scrubber.add(setupToken, "portainer-setup-token");
  const password = randomBytes(24).toString("base64url");
  run.scrubber.add(password, "portainer-admin-password");
  const init = await anonymous.call("POST", "/api/users/admin/init", {
    json: { Username: "admin", Password: password },
    headers: { "X-Setup-Token": setupToken },
  });
  if (init.status !== 200) {
    throw new Error(`Portainer refused the admin initialisation (HTTP ${init.status}).`);
  }
  const auth = await anonymous.ok<{ jwt?: string }>("POST", "/api/auth", "log in", {
    json: { Username: "admin", Password: password },
  });
  if (!auth.jwt) throw new Error("Portainer's login answered without a session.");
  run.scrubber.add(auth.jwt, "portainer-session");
  const session = anonymous.withSession(auth.jwt);
  const environment = await session.ok<{ Id: number }>(
    "POST",
    "/api/endpoints",
    "add the local environment",
    { form: multipartForm({ Name: ENVIRONMENT_NAME, EndpointCreationType: "1" }) },
  );
  await waitFor(
    "the local environment's first snapshot",
    minutes(2),
    async () => {
      const got = await session.ok<{ Snapshots?: unknown[] }>(
        "GET",
        `/api/endpoints/${environment.Id}`,
        "read the environment",
      );
      return (got.Snapshots ?? []).length > 0 ? true : undefined;
    },
    5_000,
  );
  const me = await session.ok<{ Id: number }>("GET", "/api/users/me", "read the admin");
  const key = await session.ok<{ rawAPIKey?: string }>(
    "POST",
    `/api/users/${me.Id}/tokens`,
    "create the admin's API key",
    { json: { description: "opscrew-e2e retarget", password } },
  );
  if (!key.rawAPIKey) throw new Error("Portainer created the API key without returning it.");
  run.scrubber.add(key.rawAPIKey, "PORTAINER_API_KEY");
  run.log("Portainer is set up as the user's: an admin, the local environment and its API key");
  return {
    url,
    fingerprint,
    environmentId: environment.Id,
    token: key.rawAPIKey,
    api: anonymous.withToken(key.rawAPIKey),
  };
}

// ---------------------------------------------------------------------------------------------
// DigitalOcean.

const DIGITALOCEAN_API = "https://api.digitalocean.com/v2";

/** DigitalOcean's resources carry the app's tag and names, not labels. */
const appTag = (app: string) => encodeURIComponent(`opscrew-app:${app}`);

/** The leg's calls to DigitalOcean: its Spaces key, and what OpsCrew created for the app. */
export class DigitalOcean {
  constructor(private readonly token: string) {}

  private call(method: string, path: string, body?: unknown) {
    return api(DIGITALOCEAN_API, this.token, method, path, body);
  }

  /** A Spaces key with full access (a key of one bucket cannot create a bucket), named `name`. */
  async createSpacesKey(
    name: string,
  ): Promise<{ name: string; accessKeyId: string; secretAccessKey: string }> {
    const created = await this.call("POST", "/spaces/keys", {
      name,
      grants: [{ bucket: "", permission: "fullaccess" }],
    });
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(
        `DigitalOcean refused the throwaway Spaces key (HTTP ${created.status}); the token needs the spaces_key create and delete scopes.`,
      );
    }
    return spacesKeyOf(created.json);
  }

  /** Deletes the Spaces key `accessKeyId`; returns problems. */
  async deleteSpacesKey(accessKeyId: string): Promise<string[]> {
    const deleted = await retryDelete(() =>
      this.call("DELETE", `/spaces/keys/${encodeURIComponent(accessKeyId)}`),
    );
    return deleted ? [] : ["DigitalOcean did not delete the throwaway Spaces key"];
  }

  /** What OpsCrew created for `app` that DigitalOcean still lists, by kind and id. */
  async appLeft(app: string): Promise<string[]> {
    const left = await this.leftovers(app);
    return [
      ...left.droplets.map((id) => `Droplet ${id}`),
      ...left.firewalls.map((id) => `firewall ${id}`),
      ...left.sshKeys.map((id) => `SSH key ${id}`),
      ...(left.tag ? [`tag opscrew-app:${app}`] : []),
    ];
  }

  /** Deletes what {@link appLeft} lists; never the shared `managed-by:opscrew` tag. */
  async deleteApp(app: string): Promise<void> {
    const left = await this.leftovers(app);
    for (const id of left.droplets) await retryDelete(() => this.call("DELETE", `/droplets/${id}`));
    for (const id of left.firewalls) {
      await retryDelete(() => this.call("DELETE", `/firewalls/${id}`));
    }
    for (const id of left.sshKeys) {
      await retryDelete(() => this.call("DELETE", `/account/keys/${id}`));
    }
    if (left.tag) await retryDelete(() => this.call("DELETE", `/tags/${appTag(app)}`));
  }

  private async leftovers(app: string) {
    const droplets = await this.call("GET", `/droplets?tag_name=${appTag(app)}&per_page=200`);
    const firewalls = await this.call("GET", "/firewalls?per_page=200");
    const keys = await this.call("GET", "/account/keys?per_page=200");
    const tag = await this.call("GET", `/tags/${appTag(app)}`);
    for (const listed of [droplets, firewalls, keys]) {
      if (listed.status !== 200) throw new Error(`DigitalOcean answered HTTP ${listed.status}.`);
    }
    return {
      droplets: ((droplets.json as { droplets?: { id: number }[] }).droplets ?? []).map(
        (d) => d.id,
      ),
      firewalls: (
        (firewalls.json as { firewalls?: { id: string; name: string }[] }).firewalls ?? []
      )
        .filter((f) => f.name === `${app}-firewall`)
        .map((f) => f.id),
      sshKeys: ((keys.json as { ssh_keys?: { id: number; name: string }[] }).ssh_keys ?? [])
        .filter((k) => k.name === `${app}-deploy`)
        .map((k) => k.id),
      tag: tag.status === 200,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// What the leak search reads besides the harness's sources.

/**
 * After every CLI run (the harness's `afterCli`): every address in OpsCrew's server record (the
 * old and new sides' too) is masked from then on, and the latest copy of every saved plan is kept,
 * since an applied or finished move deletes its plans.
 */
export class MoveRecords {
  /** The latest content of every file seen in `.opscrew/plans/`, by name. */
  readonly plans = new Map<string, string>();

  constructor(private readonly run: LiveRun) {}

  readonly afterCli = async (): Promise<void> => {
    const { run } = this;
    if (run.repo === "") return;
    const paths = run.paths();
    const record = await readServerAddresses(paths).catch(() => undefined);
    const addresses = recordAddresses(record);
    for (const ipv4 of addresses.ipv4) run.scrubber.add(ipv4, "server-ipv4");
    for (const ipv6 of addresses.ipv6) run.scrubber.add(ipv6, "server-ipv6");
    const dir = paths.files.plansDir;
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      this.plans.set(file, await readFile(join(dir, file), "utf8").catch(() => ""));
    }
  };
}

/**
 * The leak search (SC-2303): the environments' search (every known secret in each output, commit
 * of every branch, pull request of the run, audit entry, plan and state file; the servers'
 * addresses in commits and pull requests), plus every saved plan the run kept (secrets), and the
 * servers' addresses in the CLI's outputs outside the mentions that show them on purpose. Returns
 * the problems, by label and place only.
 */
export async function moveLeaks(
  run: LiveRun,
  envs: AppEnvironments,
  records: MoveRecords,
  cloudflare: boolean,
): Promise<string[]> {
  if (!run.repoReady) return [];
  const problems = await envs.leaks({ cloudflare });
  const known = run.scrubber.entries().filter(({ label }) => label !== TESTER_LABEL);
  const secrets = known.filter(({ label }) => !label.startsWith("server-"));
  for (const [file, text] of records.plans) {
    if (isEncryptedPlan(text)) continue;
    const found = leakedLabels(text, secrets);
    if (found.length > 0) problems.push(`the saved plan ${file} contains: ${found.join(", ")}`);
  }
  const addresses = known
    .filter(({ label }) => label.startsWith("server-"))
    .map(({ value }) => value);
  for (const [label, output] of run.outputs) {
    const lines = addressLinesOutsidePurpose(output, addresses);
    if (lines > 0) problems.push(`${label} printed a server's address on ${lines} line(s)`);
  }
  return problems;
}
