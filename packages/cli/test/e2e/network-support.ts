/**
 * Servers in containers for the private network's Docker pass (`network.test.ts`, research R5a):
 * privileged Ubuntu 24.04 containers on one user network, each booting systemd with its own Docker
 * (`docker.io` and Compose), ufw on iptables and a `deploy` user in the `docker` group without
 * sudo, as on a server OpsCrew creates. OpsCrew reaches each one as `deploy` through
 * `docker exec` ({@link ContainerLogin}); the pinned images are pulled once on this computer and
 * copied into each server's Docker ({@link copyImages}).
 */
import { spawn } from "node:child_process";
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { DOCKER, docker, LABEL, TEN_MINUTES, TWO_MINUTES, tail, UBUNTU } from "./docker-support";
import { dockerOk, until } from "./edge-support";

/**
 * The servers' image: systemd as its init, Docker and Compose from Ubuntu, ufw, iptables (Ubuntu's
 * nf_tables backend, as R5b found on Hetzner) and ping, and `deploy` in the docker group. No sudo:
 * the deploy user becomes root only through Docker. No WireGuard tools, as after cloud-init: the
 * `network` step installs them.
 */
export const SERVER_DOCKERFILE = `FROM ${UBUNTU}
RUN apt-get update -qq \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends systemd systemd-sysv dbus docker.io docker-compose-v2 iptables ufw iproute2 iputils-ping ca-certificates \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash --groups docker deploy \\
 && systemctl mask getty.target console-getty.service systemd-logind.service
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`;

/**
 * Its first boot as cloud-init leaves a server OpsCrew creates: ufw denies what comes in except
 * SSH, and the app's folders belong to `deploy`.
 */
const FIRST_BOOT = `set -e
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw --force enable >/dev/null
install -d -m 0755 -o deploy -g deploy /srv/apps /srv/data`;

const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });

/** `docker <args>` with `input` on its standard input. */
export function dockerWith(args: string[], input: string | undefined, timeoutMs = TWO_MINUTES) {
  return runner.run(DOCKER ?? "docker", args, {
    timeoutMs,
    ...(input === undefined ? {} : { input }),
  });
}

/** Runs OpsCrew's commands on a server in a container as `deploy`, the way SSH runs them. */
export class ContainerLogin implements RemoteExec {
  constructor(readonly host: string) {}

  run(command: string, options: RemoteRunOptions = {}): Promise<CommandResult> {
    const args = ["exec", "-i", "-u", "deploy", "-w", "/home/deploy", this.host, "bash", "-c"];
    return dockerWith([...args, command], options.input, options.timeoutMs ?? TEN_MINUTES);
  }
}

/** A server in a container: its container's name, its address on the test network, its login. */
export interface ContainerServer {
  name: string;
  /** Its "public" address: the container's on the test network. */
  address: string;
  login: ContainerLogin;
}

/**
 * Starts the server `name` from `image` on `network`, its Docker's data on the named volumes
 * `<name>-docker` and `<name>-containerd` (Docker's overlay mounts need a real file system there),
 * and waits until systemd and Docker run and its first boot is done.
 */
export async function startServer(
  name: string,
  image: string,
  network: string,
): Promise<ContainerServer> {
  for (const volume of [`${name}-docker`, `${name}-containerd`]) {
    await dockerOk(["volume", "create", "--label", LABEL, volume], `creating ${volume}`);
  }
  await dockerOk(
    [
      ...["run", "-d", "--name", name, "--hostname", name, "--label", LABEL, "--privileged"],
      ...["--network", network, "--tmpfs", "/run", "--tmpfs", "/run/lock"],
      ...["-v", `${name}-docker:/var/lib/docker`, "-v", `${name}-containerd:/var/lib/containerd`],
      image,
    ],
    `starting the server ${name}`,
  );
  await until(
    `${name}'s systemd and Docker`,
    async () => {
      const state = await docker(["exec", name, "systemctl", "is-system-running"]);
      if (!["running", "degraded"].includes(state.stdout.trim())) return undefined;
      return (await docker(["exec", name, "docker", "info"])).exitCode === 0 ? true : undefined;
    },
    TWO_MINUTES,
    1_000,
  );
  await asRoot(name, FIRST_BOOT, `${name}'s first boot`);
  const address = await dockerOk(
    ["inspect", "-f", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name],
    `${name}'s address`,
  );
  return { name, address, login: new ContainerLogin(name) };
}

/** Runs `script` as root on the server (the test's own setup, never OpsCrew's changes). */
export function asRoot(server: string, script: string, what: string, input?: string) {
  return checked(
    dockerWith(["exec", "-i", server, "sh", "-c", script], input),
    `${what} (as root on ${server})`,
  );
}

/** Runs `args` on the server as `deploy` in `dir`. */
export function asDeploy(
  server: string,
  dir: string,
  args: string[],
  o: { input?: string; timeoutMs?: number } = {},
) {
  return dockerWith(
    ["exec", "-i", "-u", "deploy", "-w", dir, server, ...args],
    o.input,
    o.timeoutMs,
  );
}

/** `result`'s stdout; fails with the end of its output when it exited non-zero or timed out. */
export async function checked(result: Promise<CommandResult>, what: string): Promise<string> {
  const done = await result;
  if (done.exitCode !== 0 || done.timedOut) {
    const failure = done.timedOut ? "timed out" : `failed (exit ${done.exitCode})`;
    throw new Error(`${what} ${failure}:\n${tail(`${done.stdout}\n${done.stderr}`)}`);
  }
  return done.stdout;
}

/**
 * Copies the images `refs` (each `name:tag@sha256:…`, as OpsCrew pins them, already on this
 * computer) into the server's Docker in one `docker save | docker load`, and names each there by
 * its tag, so the pinned reference resolves without a pull.
 */
export async function copyImages(server: string, refs: readonly string[]): Promise<void> {
  const command = DOCKER ?? "docker";
  const save = spawn(command, ["save", ...refs], { stdio: ["ignore", "pipe", "pipe"] });
  const load = spawn(command, ["exec", "-i", server, "docker", "load", "-q"], {
    stdio: ["pipe", "ignore", "pipe"],
  });
  let errors = "";
  for (const child of [save, load]) {
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
  }
  save.stdout.pipe(load.stdin);
  const exit = (child: ReturnType<typeof spawn>) =>
    new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  const codes = await Promise.all([exit(save), exit(load)]);
  if (codes.some((code) => code !== 0)) {
    throw new Error(`Copying the images into ${server} failed:\n${tail(errors)}`);
  }
  for (const ref of refs) {
    const [name = "", digest = ""] = ref.split("@");
    await dockerOk(["exec", server, "docker", "tag", digest, name], `naming ${name} on ${server}`);
    await dockerOk(["exec", server, "docker", "image", "inspect", ref], `${ref} on ${server}`);
  }
}
