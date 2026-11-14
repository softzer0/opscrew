/**
 * Provision's write check of the off-server copies on the user's own storage (T2756): before the
 * deploy secrets or the stack's values are stored, the pinned rclone, run as the copies run it (its
 * settings and the login, the same variables), writes a test file where the copies go and deletes
 * it. A refusal names what to fix: the key, the folder's permissions, the bucket's name. The login
 * reaches the one-off only in the Docker API's request, never a command line or a file.
 */
import {
  type DockerClient,
  dialStdioTransport,
  dockerClient,
  type OneOffResult,
  runOneOff,
} from "@opscrew/connector-docker";
import type { DockerTransport } from "@opscrew/contracts";
import { lowerFirst, NodeStreamRunner, OpsCrewError, upperFirst } from "@opscrew/core";
import {
  IMAGES,
  offsiteFolder,
  offsiteLogin,
  offsitePlace,
  offsiteRoot,
  rcloneSettings,
  snapshotParts,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type SnapshotOffsite,
  snapshotOffsiteOf,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { privateReach, sshArgs } from "../shared";
import { serverWords } from "../shared/server-address";
import { serverShell } from "../status/servers";
import { OFFSITE_KEY_VARS, OFFSITE_SFTP_KEY_VAR, storageKeyFile } from "./storage";
import type { ProvisionServices } from "./types";

/** The copies on the user's own bucket or SFTP machine, which provision checks. */
export type OwnStorage = Extract<SnapshotOffsite, { provider: "s3" | "sftp" }>;

/**
 * `plan`'s copy off the server when it goes to the user's own bucket or SFTP machine, which
 * provision checks; undefined otherwise (a bucket OpsCrew plans is checked by its plan's apply).
 */
export function ownOffsiteOf(plan: Pick<DeployPlan, "snapshots">): OwnStorage | undefined {
  const copy = snapshotOffsiteOf(plan);
  return copy?.provider === "s3" || copy?.provider === "sftp" ? copy : undefined;
}

/** The test file the check writes and deletes, under the copies' root (never a copy's id). */
export const OFFSITE_CHECK_FILE = ".opscrew-write-check";

/**
 * The Docker API of the server `server` of `plan`: `services.docker`'s, else `docker system
 * dial-stdio` over the login `opscrew logs` uses (through `sudo -n` where that login reaches Docker
 * only so), at the address that login reaches, registered with the redactor.
 */
export async function serverDocker(
  deps: PhaseDeps,
  plan: DeployPlan,
  server: string,
  services: Pick<ProvisionServices, "remote" | "docker">,
): Promise<{ client: DockerClient; close(): Promise<void> }> {
  const injected = services.docker?.(server);
  const transport: DockerTransport =
    injected ??
    (await (async () => {
      const { login, sudo } = await serverShell(deps, plan, server, services);
      const reach = (await privateReach(deps, plan, server, login)) ?? login;
      deps.redactor.addName(reach.host, "server-address");
      const streams = deps.streams ?? new NodeStreamRunner();
      const args = [
        ...sshArgs({
          host: reach.host,
          port: reach.port,
          user: login.user,
          ...(login.keyFile === undefined ? {} : { keyFile: login.keyFile }),
          knownHostsFile: deps.paths.files.knownHosts,
          fresh: true,
          // A copy's stream can stay quiet while the next object starts downloading.
          keepAliveSeconds: 15,
        }),
        sudo ? "sudo -n docker system dial-stdio" : "docker system dial-stdio",
      ];
      return dialStdioTransport(() => streams.open("ssh", args));
    })());
  return {
    client: dockerClient(transport),
    close: async () => {
      await transport.close?.();
    },
  };
}

/** What a failed check is said with. */
interface CheckWords {
  /** Who ran it, at a sentence's start: `The app's server`, `Your Portainer`. */
  who: string;
  /** What is done already, said when it stops. */
  already: string;
  /** The command to run again. */
  command: string;
}

/** rclone's last error line in a one-off's output, redacted. */
function lastError(deps: Pick<PhaseDeps, "redactor">, result: OneOffResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(ERROR|CRITICAL) *: |Failed to /.test(line));
  return deps.redactor.redact(lines.at(-1) ?? "").slice(0, 400);
}

/** The network errors rclone reports when the server can't reach the storage. */
const UNREACHABLE =
  /connection refused|no route to host|i\/o timeout|no such host|network is unreachable|connection timed out|x509:|certificate/i;

/**
 * What to fix for the refusal rclone `said` at the user's own bucket or SFTP machine, by what it
 * says, and whether the storage refused the key; undefined when it says nothing known.
 */
function whatToFix(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  copy: OwnStorage,
  said: string,
): { fix: string; key?: true } | undefined {
  if (copy.provider === "sftp") {
    const again = `opscrew snapshot offsite on --to sftp --host ${copy.host}${copy.port === 22 ? "" : ` --port ${copy.port}`} --user ${copy.user}`;
    if (/host key mismatch/i.test(said)) {
      return {
        fix: `The machine presented another host key than the one the plan pins (snapshots.offsite.hostKey). If its key really changed, run \`${again} --path ${copy.path} --host-key <the new fingerprint>\` again to confirm the new one; otherwise someone may be intercepting the connection.`,
      };
    }
    if (/unable to authenticate|no supported methods remain/i.test(said)) {
      return {
        fix: `The machine refused the key ${OFFSITE_SFTP_KEY_VAR} names: add its public half (\`ssh-keygen -y -f <key file>\` prints it) to ~/.ssh/authorized_keys of ${copy.user} on ${copy.host}.`,
        key: true,
      };
    }
    if (/permission denied/i.test(said)) {
      return {
        fix: `The account ${copy.user} can't write in ${offsiteFolder(plan, copy)}: give it write permission on ${copy.path}, or choose a folder it can write in with \`${again} --path <folder>\`.`,
      };
    }
    if (UNREACHABLE.test(said)) {
      return {
        fix: `The server could not reach ${copy.host} on port ${copy.port}: check the address, and that the machine accepts SSH from the server's address.`,
      };
    }
    return undefined;
  }
  const again = `opscrew snapshot offsite on --to s3 --endpoint ${copy.endpoint}`;
  if (/NoSuchBucket/.test(said)) {
    return {
      fix: `There is no bucket ${copy.bucket} at ${copy.endpoint}: check its name at your provider, and correct it with \`${again} --bucket <name>\`.`,
    };
  }
  if (
    /AuthorizationHeaderMalformed|IllegalLocationConstraint|region '[^']*' is wrong/i.test(said)
  ) {
    return {
      fix: `The bucket is in another region than ${copy.region}: correct it with \`${again} --bucket ${copy.bucket} --region <region>\`.`,
    };
  }
  if (
    /InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|Forbidden|InvalidToken|\b403\b/.test(
      said,
    )
  ) {
    return {
      fix: `The bucket refused the key: give the key permission to list, read, write and delete objects in ${copy.bucket}, then set ${OFFSITE_KEY_VARS.accessKeyId} and ${OFFSITE_KEY_VARS.secretAccessKey} to it, or delete OpsCrew's copy of the old one (its line in ${storageKeyFile(deps.paths)}) and paste the new one in a terminal.`,
      key: true,
    };
  }
  if (UNREACHABLE.test(said)) {
    return {
      fix: `The server could not reach ${copy.endpoint}: check the address, and that it answers over https from the server.`,
    };
  }
  return undefined;
}

/**
 * Writes a test file ({@link OFFSITE_CHECK_FILE}) where `plan`'s copies go (`copy`, the user's own
 * bucket or SFTP machine: {@link ownOffsiteOf}) and deletes it, with the pinned rclone in one-offs
 * of `docker`, its settings the copies' ({@link rcloneSettings})
 * and its login from `values` (the copies' variables, `offsiteValues`), as the uploads run it.
 * @throws OpsCrewError `CREDENTIALS_INVALID` when the storage refused the key, `PHASE_PRECONDITION`
 * for any other refusal, naming what to fix and what is done (`words.already`).
 */
export async function checkOffsiteWrite(
  deps: PhaseDeps,
  plan: DeployPlan,
  copy: OwnStorage,
  docker: DockerClient,
  values: Record<string, string>,
  words: CheckWords,
): Promise<void> {
  const file = `${offsiteRoot(plan, copy)}/${OFFSITE_CHECK_FILE}`;
  const env = {
    ...rcloneSettings(copy),
    ...Object.fromEntries(
      Object.entries(offsiteLogin(copy)).map(([name, variable]) => [name, values[variable] ?? ""]),
    ),
  };
  const place = offsitePlace(plan, copy);
  deps.reporter.step(`Checking that ${lowerFirst(words.who)} can write to ${place}`);
  for (const [command, what] of [
    ["touch", "write"],
    ["deletefile", "delete"],
  ] as const) {
    const result = await runOneOff(docker, { image: IMAGES.rclone.ref, cmd: [command, file], env });
    if (result.exitCode === 0) continue;
    const said = lastError(deps, result);
    const known = whatToFix(deps, plan, copy, said);
    throw new OpsCrewError(
      known?.key ? "CREDENTIALS_INVALID" : "PHASE_PRECONDITION",
      `${words.who} could not ${what} a test file in ${place}${said === "" ? ` (rclone's exit code ${result.exitCode})` : `: ${said}`}. ${words.already}`,
      { hint: `${known?.fix ?? "Fix what it names."} Then run \`${words.command}\` again.` },
    );
  }
  deps.reporter.success(`${words.who} can write to ${place}.`);
}

/**
 * {@link checkOffsiteWrite} on each server whose snapshots the copies upload (the servers with
 * data, which get `offsite.env`), through its Docker API ({@link serverDocker}), the app's first.
 * Only for the user's own bucket or SFTP machine ({@link ownOffsiteOf}).
 */
export async function checkOffsiteWriteOnServers(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "remote" | "docker">,
  values: Record<string, string>,
  words: Omit<CheckWords, "who">,
): Promise<void> {
  const copy = ownOffsiteOf(plan);
  if (copy === undefined) return;
  const servers = [APP_SERVER, ...(plan.servers ?? []).map((server) => server.name)].filter(
    (server) => snapshotParts(plan, server).length > 0,
  );
  for (const server of servers) {
    const docker = await serverDocker(deps, plan, server, services);
    try {
      await checkOffsiteWrite(deps, plan, copy, docker.client, values, {
        ...words,
        who: upperFirst(serverWords(server)),
      });
    } finally {
      await docker.close();
    }
  }
}
