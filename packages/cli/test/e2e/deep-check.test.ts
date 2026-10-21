/**
 * The deeper check (`opscrew secure --deep`'s tools, quickstart.md "Local Docker pass" 4) against a
 * server in a container: Ubuntu 24.04 without systemd, with OpenSSH and Docker (Ubuntu's
 * `docker.io`, its daemon running inside, as on a server), the `deploy` user in the docker group
 * with a key made now, and a TLS site on 443 (the pinned Caddy with its internal CA, in the
 * server's Docker). With the pins `secure` uses:
 * - `runLynis` logs in over real SSH as `deploy` (`SshRemoteExec`), runs Lynis through the
 *   server's Docker read-only, and gives a report with a hardening index;
 * - `runSshAudit` and `runTestssl` run from this computer's Docker and give results;
 * - a listing of the server's files (path, size, time, mode) taken before and after is the same,
 *   apart from the paths research.md "Spike results" 7 lists as the host's own background writes
 *   (`/run`, `/tmp`, `/var/tmp`, `/var/lib/docker`, `/var/lib/containerd`, `/var/lib/landscape`,
 *   `/var/lib/ubuntu-advantage`) and logs (`/var/log`).
 *
 * The parsers and the results' severity mapping are tested on the spike's real outputs in
 * `secops` (`deep.test.ts`); this pass checks that the tools run end to end.
 *
 * Gated like the Docker pass: OPSCREW_DOCKER_TESTS=1 with a running Docker daemon that may run a
 * privileged container, `ssh` on this computer, and the network (packages, Lynis's tarball, the
 * images the server pulls). The server, its image, its Docker volume and the network are removed
 * afterwards.
 */
import { chmod, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateEd25519KeyPair, SshRemoteExec } from "@opscrew/agents";
import { findExecutable, NodeCommandRunner } from "@opscrew/core";
import { IMAGES, TOOLS } from "@opscrew/iac-templates";
import {
  type DeepPins,
  type LocalDocker,
  runLynis,
  runSshAudit,
  runTestssl,
} from "@opscrew/secops";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, dockerSkipReason, LABEL, TEN_MINUTES, TWO_MINUTES } from "./docker-support";
import { dockerOk, freePort, hasImage, tempDir, unique, until } from "./edge-support";

const SSH = findExecutable("ssh");
const SKIP = dockerSkipReason() ?? (SSH === undefined ? "ssh is not installed" : undefined);
if (SKIP !== undefined) console.warn(`Skipping the deeper check on a container server: ${SKIP}.`);

/** The pins `opscrew secure --deep` runs the tools from (agents `secure/run.ts`). */
const PINS: DeepPins = {
  lynisImage: IMAGES.curl.ref,
  lynis: TOOLS.lynis,
  sshAudit: IMAGES.sshAudit.ref,
  testssl: IMAGES.testssl.ref,
};

/** Ubuntu 24.04 (noble), the server's release; pinned for this test only. */
const UBUNTU =
  "ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac";

const DOCKERFILE = `FROM ${UBUNTU}
RUN apt-get update -qq \\
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server docker.io iptables ca-certificates \\
 && rm -rf /var/lib/apt/lists/* \\
 && useradd --create-home --shell /bin/bash --groups docker deploy \\
 && install -d -m 0755 /run/sshd
`;

/** The server's hostname on the test network, which testssl.sh tests. */
const HOSTNAME = "server.example.com";

/**
 * Every file on the server's root file system with its size, modification time and mode, except
 * below the paths that change on their own while a host runs, and the logs.
 */
const LISTING = [
  "find / -xdev",
  ...[
    "/run",
    "/tmp",
    "/var/tmp",
    "/var/log",
    "/var/lib/docker",
    "/var/lib/containerd",
    "/var/lib/landscape",
    "/var/lib/ubuntu-advantage",
  ].map((dir) => `-path ${dir} -prune -o`),
  "-printf '%p %s %T@ %m\\n'",
  "| sort",
].join(" ");

describe.skipIf(SKIP !== undefined)("the deeper check against a container server (014)", () => {
  const image = `${unique("deep-server")}:1`;
  const server = unique("deep-server");
  const volume = unique("deep-docker");
  const network = unique("deep-net");
  let work = "";
  let remote: SshRemoteExec;
  /** This computer's Docker, with each tool's container on the server's network. */
  const local: LocalDocker = {
    run: (args, options) =>
      docker(
        args[0] === "run" ? ["run", "--network", network, ...args.slice(1)] : [...args],
        options.timeoutMs,
      ),
  };
  /** The server's files before the tools ran. */
  let before = "";
  /** Whether Ubuntu's image was here before this test pulled it. */
  let hadUbuntu = true;

  const exec = (script: string, timeoutMs = TWO_MINUTES) =>
    dockerOk(
      ["exec", server, "sh", "-c", script],
      `on the server: ${script.slice(0, 60)}`,
      timeoutMs,
    );

  beforeAll(async () => {
    work = await tempDir("opscrew-deep-");
    hadUbuntu = await hasImage(UBUNTU);
    const runner = new NodeCommandRunner({ defaultTimeoutMs: TEN_MINUTES });
    const built = await runner.run("docker", ["build", "-q", "--label", LABEL, "-t", image, "-"], {
      input: DOCKERFILE,
      timeoutMs: TEN_MINUTES,
    });
    expect(built.exitCode, built.stderr).toBe(0);
    await dockerOk(["network", "create", "--label", LABEL, network], "creating the network");
    await dockerOk(
      ["volume", "create", "--label", LABEL, volume],
      "creating the server's Docker volume",
    );
    const port = await freePort();
    await dockerOk(
      [
        "run",
        "-d",
        "--name",
        server,
        "--label",
        LABEL,
        "--privileged",
        "--network",
        network,
        "--network-alias",
        HOSTNAME,
        "-p",
        `127.0.0.1:${port}:22`,
        "-v",
        `${volume}:/var/lib/docker`,
        image,
        "sh",
        "-c",
        "dockerd > /var/log/dockerd.log 2>&1 & ssh-keygen -A > /dev/null && exec /usr/sbin/sshd -D -e",
      ],
      "starting the server",
    );
    const key = generateEd25519KeyPair("opscrew-deploy@deep-check");
    const keyFile = path.join(work, "deploy_key");
    await writeFile(keyFile, key.privateKeyOpenSsh, { mode: 0o600 });
    await chmod(keyFile, 0o600);
    await exec(
      `install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh && printf '%s\\n' '${key.publicKeyOpenSsh}' > /home/deploy/.ssh/authorized_keys && chown deploy:deploy /home/deploy/.ssh/authorized_keys && chmod 0600 /home/deploy/.ssh/authorized_keys`,
    );
    const hostKey = await until(
      "the server's host key",
      async () => (await exec("cat /etc/ssh/ssh_host_ed25519_key.pub")).trim() || undefined,
    );
    const knownHosts = path.join(work, "known_hosts");
    await writeFile(
      knownHosts,
      `[127.0.0.1]:${port} ${hostKey.split(" ").slice(0, 2).join(" ")}\n`,
    );
    remote = new SshRemoteExec({
      host: "127.0.0.1",
      port,
      keyFile,
      knownHostsFile: knownHosts,
      runner,
    });
    await until("the server's Docker", async () =>
      (await docker(["exec", server, "docker", "info"])).exitCode === 0 ? true : undefined,
    );
    // The server's TLS site: Caddy with its internal CA on 443.
    await exec(
      `docker run -d --name tls --network host --entrypoint sh ${IMAGES.caddy.ref} -c "printf '${HOSTNAME} {\\n\\ttls internal\\n\\trespond ok 200\\n}\\n' > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile --adapter caddyfile"`,
      TEN_MINUTES,
    );
    await until(
      "the server's TLS site",
      async () =>
        (
          await docker([
            "run",
            "--rm",
            "--network",
            network,
            IMAGES.curl.ref,
            "-sk",
            "-o",
            "/dev/null",
            `https://${HOSTNAME}/`,
          ])
        ).exitCode === 0
          ? true
          : undefined,
      120_000,
      2_000,
    );
    const login = await remote.run("id -nG");
    expect(login.exitCode, login.stderr).toBe(0);
    expect(login.stdout).toContain("docker");
    before = await exec(LISTING);
  }, TEN_MINUTES);

  afterAll(async () => {
    await docker(["rm", "-f", "-v", server]);
    await docker(["volume", "rm", volume]);
    await docker(["network", "rm", network]);
    await docker(["image", "rm", image]);
    if (!hadUbuntu) await docker(["image", "rm", UBUNTU]);
    if (work !== "") await rm(work, { recursive: true, force: true });
  }, TWO_MINUTES);

  it(
    "runs Lynis over SSH through the server's Docker, read-only, and gives a report",
    async () => {
      const lynis = await runLynis(remote, PINS, fetch);
      const skipped = lynis.results.filter((result) => result.status === "skip");
      expect(skipped, JSON.stringify(skipped)).toEqual([]);
      expect(lynis.version).toBe(TOOLS.lynis.version);
      expect(lynis.hardeningIndex).toBeGreaterThan(0);
      expect(lynis.results.length).toBeGreaterThan(5);
      expect(lynis.results.every((result) => result.source === "lynis")).toBe(true);
      console.info(
        `Lynis: hardening index ${lynis.hardeningIndex}, ${lynis.results.length} results.`,
      );
      // runLynis removes the image it pulled.
      expect(
        (await docker(["exec", server, "docker", "image", "inspect", PINS.lynisImage])).exitCode,
      ).not.toBe(0);
    },
    TEN_MINUTES,
  );

  it(
    "runs ssh-audit and testssl.sh from this computer's Docker",
    async () => {
      const sshAudit = await runSshAudit(local, HOSTNAME, 22, PINS);
      expect(
        sshAudit.results.filter((r) => r.status === "skip"),
        JSON.stringify(sshAudit.results),
      ).toEqual([]);
      expect(sshAudit.results.length).toBeGreaterThan(0);
      const testssl = await runTestssl(local, HOSTNAME, PINS, { edge: false });
      expect(
        testssl.results.filter((r) => r.status === "skip"),
        JSON.stringify(testssl.results),
      ).toEqual([]);
      expect(testssl.results.length).toBeGreaterThan(0);
      console.info(
        `ssh-audit ${sshAudit.version}: ${sshAudit.results.length} results; testssl.sh ${testssl.version}: ${testssl.results.length} results.`,
      );
    },
    TEN_MINUTES,
  );

  it(
    "leaves the server's files as they were, apart from its own background paths and logs",
    async () => {
      const after = await exec(LISTING);
      const was = new Set(before.split("\n"));
      const is = new Set(after.split("\n"));
      const changed = [
        ...[...was].filter((line) => !is.has(line)).map((line) => `- ${line}`),
        ...[...is].filter((line) => !was.has(line)).map((line) => `+ ${line}`),
      ];
      expect(changed).toEqual([]);
      expect(was.size).toBeGreaterThan(1000);
    },
    TWO_MINUTES,
  );
});
