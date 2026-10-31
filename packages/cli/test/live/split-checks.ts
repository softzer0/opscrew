/**
 * What feature 018's live test (`split.test.ts`) needs on top of the harness that reaches the
 * servers, the providers, GitHub or Docker:
 * - the second server's provider (Hetzner, or DigitalOcean with its token): reboots, firewalls,
 *   leftovers and their deletion through its API;
 * - `deploy`'s logins to both servers, the seeded rows and their checksum, the page that reads the
 *   database, and the outage while a maintenance window runs;
 * - the device: a privileged Linux container on this computer (Docker Desktop's kernel has
 *   WireGuard) that imports the configuration `opscrew vpn add` wrote, reaches the servers' SSH over
 *   its tunnel, and runs the built CLI as "this computer" once public SSH is closed;
 * - the experiment on the deploy pause variable, and the deploy-setup branch a device run left.
 * Nothing here prints a secret or an address: what is logged goes through the run's scrubber.
 */
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { deviceConfigFile, readServerAddresses } from "@opscrew/agents";
import type { CommandResult } from "@opscrew/contracts";
import { selectEngine } from "@opscrew/iac-engine";
import { appDir, checkEnvironmentKey, DEPLOY_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  api,
  deleteHetznerApp,
  type GitHubRepo,
  HETZNER_API,
  hetznerAppLeft,
  httpRequest,
  minutes,
  RootShell,
  retryDelete,
  sleep,
  waitFor,
} from "./cloud";
import type { AppEnvironments } from "./environment-checks";
import { type CliRun, type LiveRun, REPO_ROOT } from "./harness";
import {
  containerProjectId,
  DATABASE,
  devicePrivateKey,
  EXTRA_SERVER,
  type FirewallRuleLike,
  firewallKeys,
  longestOutage,
  pauseReadAt,
  pauseVariableWith,
  pauseVariableWithout,
} from "./split-support";

// ---------------------------------------------------------------------------------------------
// The second server's provider.

const DIGITALOCEAN_API = "https://api.digitalocean.com/v2";

/** The extra server's provider: Hetzner, or DigitalOcean with `OPSCREW_E2E_DIGITALOCEAN_TOKEN`. */
export interface SecondServer {
  provider: "hetzner" | "digitalocean";
  /** The provider in words. */
  name: string;
  /** The server's entry in `servers` as the user adds it: design fills in the rest. */
  entry: { name: string; target?: Record<string, unknown> };
  /** The CLI's environment for it (its token), beside Hetzner's. */
  env: Record<string, string>;
  /** Reboots the extra server of `app` at `ipv4` (OpsCrew's record of it). */
  reboot(app: string, ipv4: string): Promise<void>;
  /** The extra server's cloud firewall's inbound rules (`firewallKeys`). */
  firewall(app: string): Promise<string[]>;
  /** What OpsCrew created for `app` at this provider that it still lists, by kind and id. */
  left(app: string): Promise<string[]>;
  /** Deletes what {@link left} lists, through the provider's API. */
  deleteLeft(app: string): Promise<void>;
}

/** Hetzner's call with `token`. */
function hetzner(token: string) {
  return (method: string, path: string, body?: unknown) =>
    api(HETZNER_API, token, method, path, body);
}

/** Reboots the Hetzner server of `app` at `ipv4` (found by the app's labels and its address). */
export async function rebootHetzner(token: string, app: string, ipv4: string): Promise<void> {
  const call = hetzner(token);
  const selector = encodeURIComponent(`managed-by=opscrew,app=${app}`);
  const listed = await call("GET", `/servers?label_selector=${selector}`);
  const servers =
    (listed.json as { servers?: { id: number; public_net: { ipv4?: { ip: string } | null } }[] })
      .servers ?? [];
  const server = servers.find((item) => item.public_net.ipv4?.ip === ipv4);
  if (server === undefined) {
    throw new Error("Hetzner lists no server of the app at the address OpsCrew recorded.");
  }
  const rebooted = await call("POST", `/servers/${server.id}/actions/reboot`);
  if (rebooted.status !== 201) {
    throw new Error(`Hetzner did not reboot the server (HTTP ${rebooted.status}).`);
  }
}

/** The inbound rules of the Hetzner firewall `name` (`<server>-firewall`). */
export async function hetznerFirewall(token: string, name: string): Promise<string[]> {
  const listed = await hetzner(token)("GET", `/firewalls?name=${encodeURIComponent(name)}`);
  const firewalls =
    (listed.json as { firewalls?: { rules?: FirewallRuleLike[] }[] } | undefined)?.firewalls ?? [];
  if (listed.status !== 200 || firewalls.length !== 1) {
    throw new Error(
      `Hetzner lists ${firewalls.length} firewalls named ${name} (HTTP ${listed.status}).`,
    );
  }
  return firewallKeys(firewalls[0]?.rules ?? []);
}

/** Whether Hetzner still lists a server named `name`. */
export async function hetznerServerExists(token: string, name: string): Promise<boolean> {
  const listed = await hetzner(token)("GET", `/servers?name=${encodeURIComponent(name)}`);
  if (listed.status !== 200)
    throw new Error(`Could not list the Hetzner servers (HTTP ${listed.status}).`);
  return ((listed.json as { servers?: unknown[] }).servers ?? []).length > 0;
}

function hetznerSecond(token: string): SecondServer {
  return {
    provider: "hetzner",
    name: "Hetzner Cloud",
    entry: { name: EXTRA_SERVER },
    env: {},
    reboot: (app, ipv4) => rebootHetzner(token, app, ipv4),
    firewall: (app) => hetznerFirewall(token, `${app}-${EXTRA_SERVER}-firewall`),
    left: (app) => hetznerAppLeft(token, app),
    deleteLeft: (app) => deleteHetznerApp(token, app),
  };
}

/** DigitalOcean's resources carry the app's tag and names, not labels. */
const appTag = (app: string) => `opscrew-app:${app}`;

function digitaloceanSecond(token: string): SecondServer {
  const call = (method: string, path: string, body?: unknown) =>
    api(DIGITALOCEAN_API, token, method, path, body);
  const firewallName = (app: string) => `${app}-${EXTRA_SERVER}-firewall`;
  const leftovers = async (app: string) => {
    const tag = encodeURIComponent(appTag(app));
    const droplets = await call("GET", `/droplets?tag_name=${tag}&per_page=200`);
    const firewalls = await call("GET", "/firewalls?per_page=200");
    const keys = await call("GET", "/account/keys?per_page=200");
    const tagged = await call("GET", `/tags/${tag}`);
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
        .filter((f) => f.name === firewallName(app))
        .map((f) => f.id),
      sshKeys: ((keys.json as { ssh_keys?: { id: number; name: string }[] }).ssh_keys ?? [])
        .filter((k) => k.name === `${app}-deploy`)
        .map((k) => k.id),
      tag: tagged.status === 200,
    };
  };
  return {
    provider: "digitalocean",
    name: "DigitalOcean",
    // Frankfurt, the region nearest Hetzner's German locations.
    entry: { name: EXTRA_SERVER, target: { provider: "digitalocean", location: "fra1" } },
    env: { DIGITALOCEAN_TOKEN: token },
    async reboot(app, ipv4) {
      const listed = await call("GET", `/droplets?tag_name=${encodeURIComponent(appTag(app))}`);
      const droplets =
        (
          listed.json as {
            droplets?: { id: number; networks: { v4: { ip_address: string; type: string }[] } }[];
          }
        ).droplets ?? [];
      const droplet = droplets.find((d) =>
        d.networks.v4.some((n) => n.type === "public" && n.ip_address === ipv4),
      );
      if (droplet === undefined) {
        throw new Error(
          "DigitalOcean lists no Droplet of the app at the address OpsCrew recorded.",
        );
      }
      const rebooted = await call("POST", `/droplets/${droplet.id}/actions`, { type: "reboot" });
      if (rebooted.status !== 201) {
        throw new Error(`DigitalOcean did not reboot the Droplet (HTTP ${rebooted.status}).`);
      }
    },
    async firewall(app) {
      const listed = await call("GET", "/firewalls?per_page=200");
      const firewall = (
        (listed.json as { firewalls?: { name: string; inbound_rules?: FirewallRuleLike[] }[] })
          .firewalls ?? []
      ).find((f) => f.name === firewallName(app));
      if (firewall === undefined)
        throw new Error(`DigitalOcean lists no firewall ${firewallName(app)}.`);
      return firewallKeys(firewall.inbound_rules ?? []);
    },
    async left(app) {
      const left = await leftovers(app);
      return [
        ...left.droplets.map((id) => `Droplet ${id}`),
        ...left.firewalls.map((id) => `firewall ${id}`),
        ...left.sshKeys.map((id) => `SSH key ${id}`),
        ...(left.tag ? [`tag ${appTag(app)}`] : []),
      ];
    },
    async deleteLeft(app) {
      const left = await leftovers(app);
      for (const id of left.droplets) await retryDelete(() => call("DELETE", `/droplets/${id}`));
      for (const id of left.firewalls) await retryDelete(() => call("DELETE", `/firewalls/${id}`));
      for (const id of left.sshKeys) await retryDelete(() => call("DELETE", `/account/keys/${id}`));
      // Only the app's own tag; `managed-by:opscrew` is shared with other apps and never deleted.
      if (left.tag) {
        await retryDelete(() => call("DELETE", `/tags/${encodeURIComponent(appTag(app))}`));
      }
    },
  };
}

/** The second server's provider: DigitalOcean with its token, else Hetzner. */
export function secondServer(hcloudToken: string, digitaloceanToken: string): SecondServer {
  return digitaloceanToken === ""
    ? hetznerSecond(hcloudToken)
    : digitaloceanSecond(digitaloceanToken);
}

// ---------------------------------------------------------------------------------------------
// The servers, the rows and the page.

/** The public IPv4 address of the server `name` (`app` or the extra server) OpsCrew recorded. */
export async function serverIpv4(envs: AppEnvironments, name: string): Promise<string> {
  const record = await readServerAddresses(envs.paths());
  const ipv4 = name === "app" ? record.deployment?.ipv4 : record.servers?.[name]?.ipv4;
  if (ipv4 === undefined) throw new Error(`OpsCrew recorded no address for server ${name}.`);
  return ipv4;
}

/** The extra server's addresses, masked from now on, as soon as OpsCrew recorded them. */
export async function rememberExtraServer(run: LiveRun, envs: AppEnvironments): Promise<void> {
  if (run.repo === "") return;
  const record = await readServerAddresses(envs.paths()).catch(() => undefined);
  const server = record?.servers?.[EXTRA_SERVER];
  run.scrubber.add(server?.ipv4, "server-ipv4");
  run.scrubber.add(server?.ipv6, "server-ipv6");
}

/** `deploy`'s login to the server `name` at its public address, with OpsCrew's key and known hosts. */
export async function serverShell(
  run: LiveRun,
  envs: AppEnvironments,
  name: string,
): Promise<RootShell> {
  const paths = envs.paths();
  return new RootShell(run.runner, {
    host: await serverIpv4(envs, name),
    keyFile: paths.files.deployKey,
    knownHostsFile: paths.files.knownHosts,
    env: run.env,
    user: "deploy",
  });
}

/** Runs `sql` (no `"`, `$` or backquote) as the app's login in the Postgres that `shell` runs. */
export function psql(shell: RootShell, plan: DeployPlan, sql: string): Promise<string> {
  return shell.ok(
    `cd ${appDir(plan)} && docker compose exec -T ${DATABASE} psql -U app -d app -v ON_ERROR_STOP=1 -tAc "${sql}"`,
  );
}

/** The test's table. */
const ROWS = "opscrew_e2e_rows";

/** The rows' count and checksum: `<count>:<md5 of every row in id order>`. */
export const DIGEST_SQL = `select count(*) || ':' || md5(string_agg(id || '=' || v, ',' order by id)) from ${ROWS}`;

/** Seeds 5,000 rows into the Postgres that `shell` runs and returns their digest. */
export async function seedRows(shell: RootShell, plan: DeployPlan): Promise<string> {
  await psql(
    shell,
    plan,
    `create table ${ROWS} (id integer primary key, v text not null); insert into ${ROWS} select g, md5(g::text) from generate_series(1, 5000) g`,
  );
  return psql(shell, plan, DIGEST_SQL);
}

/** How many rows the device reads through a grant (the table's count). */
export const COUNT_SQL = `select count(*) from ${ROWS}`;

/** A write the device's read-only login must be refused. */
export const WRITE_SQL = `insert into ${ROWS} values (999999, 'written by a device')`;

/**
 * Waits up to `timeoutMs` until the example's page `https://<appHost>/` answers 200 with the
 * database's time, which it reads from Postgres on every request (else it says the database is
 * not reachable).
 */
export async function waitForDatabasePage(run: LiveRun, timeoutMs = minutes(10)): Promise<void> {
  const url = `https://${run.appHost}/`;
  await waitFor(
    `${url} answering with the database's time`,
    timeoutMs,
    async () => ((await pageReadsDatabase(url)) ? true : undefined),
    5_000,
  );
}

/** Whether the example's page at `url` answers 200 with the database's time. */
async function pageReadsDatabase(url: string): Promise<boolean> {
  const answer = await httpRequest(url, { timeoutMs: 10_000 }).catch(() => undefined);
  return (
    answer?.status === 200 &&
    answer.body.includes("Database time:") &&
    !answer.body.includes("database not reachable")
  );
}

/**
 * Asks the example's page every 3 seconds until {@link stop}, which returns the longest time it
 * did not answer with the database's time (`longestOutage`).
 */
export function watchOutage(run: LiveRun): { stop: () => Promise<number> } {
  const url = `https://${run.appHost}/`;
  const samples: { at: number; ok: boolean }[] = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const at = Date.now();
      samples.push({ at, ok: await pageReadsDatabase(url) });
      await sleep(Math.max(0, 3_000 - (Date.now() - at)));
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await loop;
      return longestOutage(samples);
    },
  };
}

/**
 * Reboots the server `name` through `reboot` and waits until it booted again (its boot id
 * changed, read as `deploy`); returns when the reboot was asked for.
 */
export async function rebootServer(
  run: LiveRun,
  envs: AppEnvironments,
  name: string,
  reboot: (ipv4: string) => Promise<void>,
): Promise<number> {
  const shell = await serverShell(run, envs, name);
  const bootId = "cat /proc/sys/kernel/random/boot_id";
  const before = await shell.ok(bootId);
  const asked = Date.now();
  await reboot(await serverIpv4(envs, name));
  await waitFor(`server ${name} booted again`, minutes(5), async () => {
    const now = await shell.run(bootId, 30_000);
    return now.exitCode === 0 && now.stdout.trim() !== before ? true : undefined;
  });
  return asked;
}

// ---------------------------------------------------------------------------------------------
// The device: a privileged Linux container on this computer.

/** The device container's base image (Debian 12 with Node.js 22, the CLI's runtime). */
const NODE_IMAGE = "node:22-bookworm-slim";

/** Where the device container keeps the repository, the OpsCrew folder and the app's values. */
const WORK = "/work";
const CONTAINER_REPO = `${WORK}/repo`;

/**
 * `rename`, tried again for a few seconds while Windows holds a file in the folder (a virus scanner
 * or the search indexer: EPERM, EBUSY or EACCES).
 */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 5 || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
      await sleep(1_000 * attempt);
    }
  }
}

/** The CLI's runtime packages (its `dependencies`), installed in the device image. */
async function cliDependencies(): Promise<Record<string, string>> {
  const manifest = JSON.parse(
    await readFile(join(REPO_ROOT, "packages/cli/package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  return manifest.dependencies ?? {};
}

/**
 * The device: a privileged Linux container with WireGuard's tools, ssh, git, psql, Node.js 22, the
 * built CLI with its packages, and the same OpenTofu or Terraform as this computer. Its tunnel
 * imports the configuration `opscrew vpn add` wrote, as the WireGuard app does. As "this computer"
 * it runs the CLI on a copy of the run's repository and OpsCrew folder, which it copies back after
 * each run, so the next command on this computer sees what it changed.
 */
export class DeviceComputer {
  readonly container: string;
  readonly image: string;
  /** The image's build was started: {@link remove} has something to remove. */
  private built = false;
  private started = false;

  constructor(
    private readonly run: LiveRun,
    private readonly envs: AppEnvironments,
    /** Runs after each CLI run (the scrubber's addresses), as the run's own `afterCli`. */
    private readonly afterCli: () => Promise<void>,
  ) {
    this.container = `opscrew-e2e-device-${run.runId}`;
    this.image = `opscrew-e2e-device:${run.runId}`;
  }

  /** `docker <args>` with the run's environment (its tokens, for `-e NAME` passed by name only). */
  private docker(
    args: readonly string[],
    timeoutMs = minutes(2),
    env: Record<string, string> = {},
  ) {
    return this.run.runner.run("docker", args, {
      env: { ...this.run.env, ...env },
      timeoutMs,
    });
  }

  private async dockerOk(args: readonly string[], what: string, timeoutMs = minutes(2)) {
    const result = await this.docker(args, timeoutMs);
    if (result.exitCode !== 0 || result.timedOut === true) {
      throw new Error(`${what} failed: ${this.run.tail(`${result.stdout}\n${result.stderr}`, 20)}`);
    }
    return result.stdout.trim();
  }

  /**
   * Builds the device image, before any server exists: Docker must run here, and its kernel must
   * make a WireGuard interface in a privileged container.
   */
  async build(): Promise<void> {
    if ((await this.docker(["info", "--format", "{{.ServerVersion}}"], 30_000)).exitCode !== 0) {
      throw new Error(
        "The split placement pass needs Docker on this computer for its device (a privileged Linux container with WireGuard). Start Docker Desktop (or the Docker daemon), then run the test again.",
      );
    }
    const engine = await selectEngine("auto", { env: this.run.env, runner: this.run.runner });
    const engineImage =
      engine.info.name === "tofu"
        ? `ghcr.io/opentofu/opentofu:${engine.info.version}-minimal`
        : `hashicorp/terraform:${engine.info.version}`;
    const engineCopy =
      engine.info.name === "tofu"
        ? `COPY --from=${engineImage} /usr/local/bin/tofu /usr/local/bin/tofu`
        : `COPY --from=${engineImage} /bin/terraform /usr/local/bin/terraform`;
    const context = await mkdtemp(join(tmpdir(), "opscrew-e2e-device-"));
    try {
      await writeFile(
        join(context, "package.json"),
        JSON.stringify({ private: true, type: "module", dependencies: await cliDependencies() }),
      );
      await cp(join(REPO_ROOT, "packages/cli/dist"), join(context, "dist"), { recursive: true });
      await writeFile(
        join(context, "Dockerfile"),
        [
          `FROM ${NODE_IMAGE}`,
          "RUN apt-get update -qq \\",
          " && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends wireguard-tools iproute2 iputils-ping openssh-client git postgresql-client ca-certificates \\",
          " && rm -rf /var/lib/apt/lists/* \\",
          " && git config --system safe.directory '*' \\",
          " && git config --system core.autocrlf input \\",
          " && mkdir -p /root/.terraform.d/plugin-cache",
          engineCopy,
          "WORKDIR /cli",
          "COPY package.json ./",
          "RUN npm install --omit=dev --no-audit --no-fund --loglevel=error",
          "COPY dist ./dist",
          'CMD ["sleep", "infinity"]',
          "",
        ].join("\n"),
      );
      this.run.log("building the device's image (Node.js 22, WireGuard's tools, the built CLI)");
      this.built = true;
      await this.dockerOk(
        ["build", "-q", "--label", `opscrew.e2e.run=${this.run.runId}`, "-t", this.image, context],
        "Building the device's image",
        minutes(15),
      );
    } finally {
      await rm(context, { recursive: true, force: true });
    }
    const check = await this.docker([
      ...["run", "--rm", "--privileged", this.image],
      ...["sh", "-c", "ip link add wg-check type wireguard && ip link del wg-check"],
    ]);
    if (check.exitCode !== 0) {
      throw new Error(
        `Docker's kernel here can't make a WireGuard interface, so the device can't join the network (${this.run.tail(check.stderr, 3)}). Docker Desktop's WSL 2 kernel has WireGuard; use it, or a Linux computer.`,
      );
    }
  }

  /** Starts the device's container (once). */
  async start(): Promise<void> {
    if (this.started) return;
    await this.dockerOk(
      [
        ...["run", "-d", "--name", this.container, "--hostname", "opscrew-e2e-device"],
        ...["--label", `opscrew.e2e.run=${this.run.runId}`, "--privileged", this.image],
      ],
      "Starting the device",
    );
    this.started = true;
  }

  /**
   * Runs `script` in the device as root; `env` reaches it by name only (`-e NAME`), so no value is
   * on a command line.
   */
  exec(
    script: string,
    env: Record<string, string> = {},
    timeoutMs = minutes(2),
  ): Promise<CommandResult> {
    const names = Object.keys(env).flatMap((name) => ["-e", name]);
    return this.docker(["exec", ...names, this.container, "sh", "-c", script], timeoutMs, env);
  }

  private async execOk(script: string, what: string, env: Record<string, string> = {}) {
    const result = await this.exec(script, env);
    if (result.exitCode !== 0) {
      throw new Error(
        `${what} failed in the device: ${this.run.tail(`${result.stdout}\n${result.stderr}`, 20)}`,
      );
    }
    return result.stdout.trim();
  }

  /** The interface of `device`'s tunnel: its configuration's name for `wg-quick`. */
  private iface(device: string): string {
    return `wg-${device}`;
  }

  /**
   * Imports `device`'s configuration (written by `opscrew vpn add` into the project's OpsCrew
   * folder) and turns its tunnel on with `wg-quick`; the device's private key is masked from now
   * on. Also gives the device OpsCrew's deploy key and known hosts, for its own SSH checks.
   */
  async tunnelUp(device: string): Promise<void> {
    await this.start();
    const paths = this.envs.paths();
    const conf = deviceConfigFile(paths, device);
    const key = devicePrivateKey(await readFile(conf, "utf8"));
    if (key === undefined)
      throw new Error(`The configuration of device ${device} has no private key.`);
    this.run.scrubber.add(key, "device-private-key");
    const file = `/etc/wireguard/${this.iface(device)}.conf`;
    await this.execOk("mkdir -p /etc/wireguard /root/e2e", "Making the device's folders");
    await this.dockerOk(["cp", conf, `${this.container}:${file}`], "Copying the configuration");
    await this.dockerOk(
      ["cp", paths.files.deployKey, `${this.container}:/root/e2e/deploy_key`],
      "Copying the deploy key",
    );
    await this.dockerOk(
      ["cp", paths.files.knownHosts, `${this.container}:/root/e2e/known_hosts`],
      "Copying the known hosts",
    );
    await this.execOk(
      `chmod 600 ${file} /root/e2e/deploy_key && wg-quick up ${this.iface(device)}`,
      `Turning on device ${device}'s tunnel`,
    );
    this.run.log(`device ${device}'s tunnel is on`);
  }

  /** Turns `device`'s tunnel off, when it is on. */
  async tunnelDown(device: string): Promise<void> {
    await this.exec(`wg-quick down ${this.iface(device)} 2>/dev/null || true`);
  }

  /**
   * Whether `deploy` logs in to the server at the private address `host` over the tunnel, its host
   * key checked against the one OpsCrew pinned for the server's public address `alias`.
   */
  async reachesSsh(host: string, alias: string): Promise<boolean> {
    const result = await this.exec(
      'ssh -i /root/e2e/deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/root/e2e/known_hosts -o HostKeyAlias="$ALIAS" -o ConnectTimeout=8 "deploy@$HOST" true',
      { HOST: host, ALIAS: alias },
      30_000,
    );
    return result.exitCode === 0;
  }

  /** Runs `sql` in the device's psql with `url` (a grant's, with its password). */
  psql(url: string, sql: string): Promise<CommandResult> {
    return this.exec(`psql "$PGURL" -v ON_ERROR_STOP=1 -tAc "${sql}"`, {
      PGURL: url,
      PGCONNECT_TIMEOUT: "10",
    });
  }

  /**
   * The built CLI on the device, as "this computer": the run's repository, OpsCrew folder and app
   * values copied in (the project's folder renamed to the id of the container's path), the CLI run
   * with the run's tokens, then everything copied back. The engine's provider folders (`.terraform`)
   * stay on each side. The output is kept for the leak search, as every run's is.
   */
  readonly opscrew = async (...args: string[]): Promise<CliRun> => {
    const { run } = this;
    await this.start();
    run.log(`running opscrew ${args.join(" ")} on the device`);
    const aside = await this.terraformAside();
    let result: CommandResult;
    try {
      await this.copyIn();
      const names = ["GITHUB_TOKEN", "HCLOUD_TOKEN", "CLOUDFLARE_API_TOKEN", "DIGITALOCEAN_TOKEN"]
        .filter((name) => (run.env[name] ?? "") !== "")
        .flatMap((name) => ["-e", name]);
      result = await this.docker(
        [
          ...["exec", "-w", CONTAINER_REPO, "-e", "CI=1", "-e", `OPSCREW_HOME=${WORK}/home`],
          ...["-e", `OPSCREW_APP_ENV_FILE=${WORK}/production.env`],
          ...["-e", "TF_PLUGIN_CACHE_DIR=/root/.terraform.d/plugin-cache"],
          ...names,
          ...[this.container, "node", "/cli/dist/opscrew.js", ...args],
        ],
        minutes(30),
      );
      await this.copyOut();
    } finally {
      await this.terraformBack(aside);
    }
    const output = `${result.stdout}\n${result.stderr}`;
    run.outputs.set(
      run.scrub(`#${run.outputs.size + 1} (device) opscrew ${args.join(" ")}`),
      output,
    );
    const record = await readFile(run.paths().files.cloudflareRecord, "utf8").catch(() => "");
    if (record !== "") run.cloudflareRecords.add(record);
    await this.afterCli();
    if (result.timedOut === true) {
      throw new Error(
        `opscrew ${args.join(" ")} did not finish on the device:\n${run.tail(output)}`,
      );
    }
    return { exitCode: result.exitCode, stdout: result.stdout, output };
  };

  /** The project's folder under the OpsCrew home on this computer, and in the container. */
  private projectFolders(): { host: string; container: string } {
    return {
      host: this.run.paths().projectId,
      container: containerProjectId(CONTAINER_REPO),
    };
  }

  private async copyIn(): Promise<void> {
    const { run } = this;
    const { host, container } = this.projectFolders();
    await this.execOk(`rm -rf ${WORK} && mkdir -p ${WORK}`, "Emptying the device's folder");
    await this.dockerOk(
      ["cp", run.repo, `${this.container}:${CONTAINER_REPO}`],
      "Copying the repository in",
      minutes(5),
    );
    await this.dockerOk(
      ["cp", join(run.work, "home"), `${this.container}:${WORK}/home`],
      "Copying the OpsCrew folder in",
      minutes(5),
    );
    await this.dockerOk(
      ["cp", join(run.work, "production.env"), `${this.container}:${WORK}/production.env`],
      "Copying the app's values in",
    );
    // ssh refuses a key others may read; the copy arrives with this computer's modes.
    await this.execOk(
      `mv ${WORK}/home/projects/${host} ${WORK}/home/projects/${container} && chmod -R u+rwX,go-rwx ${WORK}/home`,
      "Preparing the OpsCrew folder",
    );
  }

  /** Copies the repository and the OpsCrew folder back, replacing this computer's only once whole. */
  private async copyOut(): Promise<void> {
    const { run } = this;
    const { host, container } = this.projectFolders();
    await this.execOk(
      `mv ${WORK}/home/projects/${container} ${WORK}/home/projects/${host} && find ${CONTAINER_REPO} -name .terraform -type d -prune -exec rm -rf {} +`,
      "Preparing the copy back",
    );
    const back = join(run.work, "device-copy");
    await rm(back, { recursive: true, force: true });
    await mkdir(back);
    await this.dockerOk(
      ["cp", `${this.container}:${CONTAINER_REPO}`, join(back, "repo")],
      "Copying the repository back",
      minutes(5),
    );
    await this.dockerOk(
      ["cp", `${this.container}:${WORK}/home`, join(back, "home")],
      "Copying the OpsCrew folder back",
      minutes(5),
    );
    // Both copies are whole: both go into place, or neither does.
    const folders = ["repo", "home"];
    const aside: string[] = [];
    const placed: string[] = [];
    try {
      for (const folder of folders) {
        await renameRetrying(join(run.work, folder), join(run.work, `${folder}.old`));
        aside.push(folder);
      }
      for (const folder of folders) {
        await renameRetrying(join(back, folder), join(run.work, folder));
        placed.push(folder);
      }
    } catch (error) {
      // This computer's copies go back as they were, so the run goes on from them.
      for (const folder of placed) await renameRetrying(join(run.work, folder), join(back, folder));
      for (const folder of aside) {
        await renameRetrying(join(run.work, `${folder}.old`), join(run.work, folder));
      }
      throw error;
    }
    for (const folder of folders) {
      await rm(join(run.work, `${folder}.old`), { recursive: true, force: true, maxRetries: 5 });
    }
    await rm(back, { recursive: true, force: true, maxRetries: 5 });
  }

  /** Moves the engine's provider folders (`opscrew/infra/*\/.terraform`) out of the repository. */
  private async terraformAside(): Promise<{ from: string; to: string }[]> {
    const infra = join(this.run.repo, "opscrew", "infra");
    if (!existsSync(infra)) return [];
    const moved: { from: string; to: string }[] = [];
    for (const entry of await readdir(infra)) {
      const from = join(infra, entry, ".terraform");
      if (!existsSync(from)) continue;
      const to = join(this.run.work, "terraform-aside", entry);
      await mkdir(join(this.run.work, "terraform-aside"), { recursive: true });
      await rename(from, to);
      moved.push({ from, to });
    }
    return moved;
  }

  private async terraformBack(moved: readonly { from: string; to: string }[]): Promise<void> {
    for (const { from, to } of moved) {
      if (existsSync(join(from, ".."))) await rename(to, from);
    }
  }

  /** Removes the container and its image; returns any problem. */
  async remove(): Promise<string[]> {
    const problems: string[] = [];
    if (!this.built) return problems;
    const removed = await this.docker(["rm", "-f", this.container]);
    if (removed.exitCode !== 0 && !/No such container/i.test(removed.stderr)) {
      problems.push(`Docker kept the device container ${this.container}`);
    }
    const gone = await this.docker(["image", "rm", this.image]);
    if (gone.exitCode !== 0 && !/No such image/i.test(gone.stderr)) {
      problems.push(`Docker kept the image ${this.image}`);
    }
    return problems;
  }
}

// ---------------------------------------------------------------------------------------------
// GitHub: the deploy pause and the deploy-setup branch.

/** The deploy job's name in OpsCrew's deploy workflow (the job the pause skips). */
const DEPLOY_JOB = "Deploy to the server";

/** The repository variable `OPSCREW_DEPLOY_PAUSED`, or `undefined` when it is not set. */
async function readPause(github: GitHubRepo): Promise<string | undefined> {
  return github.variable(DEPLOY_PAUSED_VARIABLE);
}

/** Sets the repository variable to `value`, creating it when missing. */
async function writePause(github: GitHubRepo, value: string): Promise<void> {
  const path = `/repos/${github.name}/actions/variables`;
  const created = await github.call("POST", path, { name: DEPLOY_PAUSED_VARIABLE, value });
  if (created.status === 201) return;
  const updated = await github.call("PATCH", `${path}/${DEPLOY_PAUSED_VARIABLE}`, {
    name: DEPLOY_PAUSED_VARIABLE,
    value,
  });
  if (updated.status !== 204) {
    throw new Error(
      `GitHub did not set ${DEPLOY_PAUSED_VARIABLE} (HTTP ${created.status}, ${updated.status}).`,
    );
  }
}

/**
 * Removes the entry `key` from the repository variable, deleting the variable when nothing else
 * is left; returns a problem when GitHub kept it.
 */
export async function clearDeployPause(github: GitHubRepo, key: string): Promise<string[]> {
  const current = await readPause(github);
  if (current === undefined) return [];
  const rest = pauseVariableWithout(current, key);
  if (rest === current) return [];
  if (rest !== undefined) {
    await writePause(github, rest);
    return [];
  }
  const deleted = await github.call(
    "DELETE",
    `/repos/${github.name}/actions/variables/${DEPLOY_PAUSED_VARIABLE}`,
  );
  return deleted.status === 204 || deleted.status === 404
    ? []
    : [`GitHub kept the variable ${DEPLOY_PAUSED_VARIABLE} (HTTP ${deleted.status})`];
}

/**
 * The deploy pause's experiment (T1820): while a move is in progress the deploy job's `if:` reads
 * `vars.OPSCREW_DEPLOY_PAUSED`. A deploy run is dispatched, the variable is set to pause the app
 * while the run's build job still runs (its deploy job not started), and the deploy job's
 * conclusion says when GitHub read the variable: skipped, when the job started; run, when the run
 * was created. The variable is cleared afterwards, however the run ends. Returns the observation.
 */
export async function deployPauseExperiment(run: LiveRun, plan: DeployPlan): Promise<string> {
  const { github } = run;
  const key = checkEnvironmentKey(plan);
  const workflow = posix.basename(plan.cicd.workflowPath);
  const text = await readFile(join(run.repo, plan.cicd.workflowPath), "utf8");
  if (!text.includes(`vars.${DEPLOY_PAUSED_VARIABLE}`)) {
    throw new Error(
      `The deploy workflow on main has no condition on ${DEPLOY_PAUSED_VARIABLE}, though a move is in progress.`,
    );
  }
  const since = new Date();
  await github.dispatchDeploy(workflow);
  const created = await waitFor(
    "the dispatched deploy run",
    minutes(2),
    async () => {
      const listed = await github.call(
        "GET",
        `/repos/${github.name}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=10`,
      );
      return (
        listed.json as { workflow_runs?: { id: number; head_sha: string; created_at: string }[] }
      ).workflow_runs?.find((item) => Date.parse(item.created_at) >= since.getTime() - 5_000);
    },
    2_000,
  );
  let kept: string[] = [];
  let observation: string;
  try {
    observation = await observePause(run, { ...created, since, key, workflow });
  } finally {
    kept = await clearDeployPause(github, key);
  }
  if (kept.length > 0) throw new Error(kept.join("; "));
  return observation;
}

/**
 * The experiment once its run `created` (dispatched at `since`) is listed: the pause set for `key`,
 * then the outcome of the run's deploy job in `workflow`.
 */
async function observePause(
  run: LiveRun,
  created: { id: number; head_sha: string; since: Date; key: string; workflow: string },
): Promise<string> {
  const { github } = run;
  const { since, key, workflow } = created;
  await writePause(github, pauseVariableWith(await readPause(github), key, new Date()));
  const jobs = await github.call(
    "GET",
    `/repos/${github.name}/actions/runs/${created.id}/jobs?per_page=100`,
  );
  const before = (jobs.json as { jobs?: { name: string; status: string }[] }).jobs?.find(
    (job) => job.name === DEPLOY_JOB,
  );
  const waiting = before === undefined || ["queued", "waiting", "pending"].includes(before.status);
  const done = await github.waitForDeploy({
    headSha: created.head_sha,
    event: "workflow_dispatch",
    since,
    workflow,
  });
  const job = done.jobs.find((item) => item.name === DEPLOY_JOB);
  const readAt = pauseReadAt(job?.conclusion ?? null);
  if (!waiting) {
    return `inconclusive: the deploy job of run ${created.id} had started (${before?.status}) before ${DEPLOY_PAUSED_VARIABLE} was set; it ended ${job?.conclusion ?? "unlisted"}`;
  }
  if (readAt === undefined) {
    return `inconclusive: the deploy job of run ${created.id}, created before ${DEPLOY_PAUSED_VARIABLE} was set, ended ${job?.conclusion ?? "unlisted"} (run ${done.conclusion})`;
  }
  return `GitHub reads vars in the deploy job's if: ${readAt} (run ${created.id} was created before ${DEPLOY_PAUSED_VARIABLE} named ${key}, and its deploy job ${job?.conclusion === "skipped" ? "was skipped" : "ran"})`;
}

/**
 * Checks out the deploy-setup branch with an open pull request that a run on the device pushed,
 * when the copy it left has another branch checked out, so `LiveRun.deploy` merges it.
 */
export async function checkoutOpenDeploySetup(run: LiveRun): Promise<void> {
  const head = await run.git("rev-parse", "--abbrev-ref", "HEAD");
  if (head.startsWith("opscrew/deploy-setup")) return;
  const branches = (
    await run.git("for-each-ref", "--format=%(refname:short)", "refs/heads/opscrew/deploy-setup*")
  )
    .split(/\r?\n/)
    .filter((branch) => branch !== "");
  for (const branch of branches) {
    if ((await run.github.openPullRequest(branch)) !== undefined) {
      await run.git("checkout", "-q", branch);
      return;
    }
  }
}
