/**
 * An SFTP-only host (027 plan 10, ADR 0030 D6), and SFTP for a panel whose API has no file calls
 * (Plesk): how OpsCrew reaches it from this computer. The login comes from `OPSCREW_SFTP_HOST`,
 * `OPSCREW_SFTP_USER` and `OPSCREW_SFTP_KEY` (a key file's path), and the host key is the one the
 * user confirmed at the interview, pinned in OpsCrew's known_hosts file.
 */
import { posix } from "node:path";
import { SftpFiles } from "@opscrew/connector-sftp";
import { listText, OpsCrewError, readTextIfExists } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { HostSchema } from "../interview/own-server";
import { hostKeyFingerprint, keysFor, knownHostsName } from "../shared";
import { HOSTING_VARS_HINT, SFTP_HOST_VAR, SFTP_KEY_VAR, SFTP_USER_VAR } from "./panels";
import { hostingFolder, hostingTarget, hostnameOf } from "./provision-plans";
import { type HostingRecord, readHostingRecord, type SftpRecord } from "./record";

type SftpDeps = Pick<PhaseDeps, "env" | "runner" | "paths" | "redactor">;

const VARS = [SFTP_HOST_VAR, SFTP_USER_VAR, SFTP_KEY_VAR] as const;

/** An SFTP user: no blanks, never starting with `-`. */
const SFTP_USER = /^[^\s-]\S*$/;

/** How OpsCrew logs in over SFTP: the host, the user, and the path of the user's key file. */
export interface SftpEnvLogin {
  host: string;
  user: string;
  keyFile: string;
}

/**
 * The SFTP login `OPSCREW_SFTP_HOST`, `OPSCREW_SFTP_USER` and `OPSCREW_SFTP_KEY` name, checked;
 * undefined when one of them isn't set. The key is only ever named by its file's path.
 * @throws OpsCrewError `INVALID_INPUT` for a host, user or key path OpsCrew can't use.
 */
export function sftpLogin(env: PhaseDeps["env"]): SftpEnvLogin | undefined {
  const [host = "", user = "", keyFile = ""] = VARS.map((name) => (env[name] ?? "").trim());
  if (host === "" || user === "" || keyFile === "") return undefined;
  if (!HostSchema.safeParse(host).success) {
    throw new OpsCrewError("INVALID_INPUT", `${SFTP_HOST_VAR} isn't a host's address.`, {
      hint: `Set ${SFTP_HOST_VAR} to your SFTP host's name or IP address, such as sftp.example.com.`,
    });
  }
  if (!SFTP_USER.test(user)) {
    throw new OpsCrewError("INVALID_INPUT", `${SFTP_USER_VAR} isn't a user name.`, {
      hint: `Set ${SFTP_USER_VAR} to the user your host gave you for SFTP.`,
    });
  }
  if (keyFile.includes("-----BEGIN") || keyFile.includes("PRIVATE KEY")) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${SFTP_KEY_VAR} must be the path of your SSH key file, never the key itself.`,
      { hint: `Set ${SFTP_KEY_VAR} to the key file's path, for example ~/.ssh/id_ed25519.` },
    );
  }
  return { host, user, keyFile };
}

/**
 * {@link sftpLogin}, or the stop naming the variables that aren't set.
 * @throws OpsCrewError `CREDENTIALS_MISSING`, or `INVALID_INPUT` as {@link sftpLogin}.
 */
export function requireSftpLogin(env: PhaseDeps["env"]): SftpEnvLogin {
  const login = sftpLogin(env);
  if (login !== undefined) return login;
  const missing = VARS.filter((name) => (env[name] ?? "").trim() === "");
  throw new OpsCrewError(
    "CREDENTIALS_MISSING",
    `${listText(missing)} ${missing.length === 1 ? "isn't" : "aren't"} set, so OpsCrew can't reach your SFTP host.`,
    { hint: HOSTING_VARS_HINT },
  );
}

/** The SFTP connector for `login`, with the host key pinned in OpsCrew's known_hosts file. */
function connector(deps: SftpDeps, login: SftpEnvLogin, port: number) {
  return new SftpFiles(
    { ...login, port, knownHostsFile: deps.paths.files.knownHosts },
    { runner: deps.runner, redactor: deps.redactor },
  );
}

/**
 * The account's files over SFTP on `port`, for a panel whose API has none (Plesk) or an SFTP-only
 * host's checks, when `OPSCREW_SFTP_*` are set; undefined otherwise. The host's key must be pinned
 * in OpsCrew's known_hosts file: sftp refuses any other.
 */
export function sftpFilesFromEnv(deps: SftpDeps, port = 22): SftpFiles | undefined {
  const login = sftpLogin(deps.env);
  return login === undefined ? undefined : connector(deps, login, port);
}

/** An SFTP-only host as the commands reach it. */
export interface SftpReach {
  record: HostingRecord;
  sftp: SftpRecord;
  files: SftpFiles;
  /** `<user> at <host>`. */
  account: string;
  /** The app's folder as SFTP shows it, the one the interview asked for. */
  folder: string;
  /** The same folder as the host's PHP sees it. */
  phpFolder: string;
  /** `<app>-<env>`, which names the key GitHub Actions logs in with. */
  name: string;
  /** The hostname's document root as the host sees it: `<phpFolder>/current/<web root>`. */
  documentRoot: string;
  hostname: string;
  /** The known_hosts lines of the host key the user confirmed. */
  knownHosts: string;
}

/**
 * The SFTP-only host the interview recorded, through the SFTP connector. Stops before anything is
 * sent when there is no record, when `OPSCREW_SFTP_*` aren't set or name another host or user, or
 * when OpsCrew's known_hosts file doesn't hold the key the user confirmed.
 * @throws OpsCrewError `PHASE_PRECONDITION` or `CREDENTIALS_MISSING`.
 */
export async function reachSftpHost(deps: SftpDeps, plan: DeployPlan): Promise<SftpReach> {
  const record = await readHostingRecord(deps.paths);
  const sftp = record?.sftp;
  if (record === undefined || sftp === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "opscrew/plan.yaml deploys the app to an SFTP host, but OpsCrew has no record of it on this computer (.opscrew/hosting.json). Nothing was changed.",
      {
        hint: "Run `opscrew interview` with OPSCREW_SFTP_HOST, OPSCREW_SFTP_USER and OPSCREW_SFTP_KEY set: it confirms the host's key and records the host. Or run the command on the computer that did.",
      },
    );
  }
  const login = requireSftpLogin(deps.env);
  if (login.host !== sftp.host || login.user !== sftp.user) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${SFTP_HOST_VAR} and ${SFTP_USER_VAR} name another login than the one OpsCrew recorded for this app (${sftp.user} at ${sftp.host}). Nothing was changed.`,
      { hint: "Set them back to that login, or run `opscrew interview` to choose the new one." },
    );
  }
  const name = knownHostsName(sftp.host, sftp.port);
  const pinned = keysFor((await readTextIfExists(deps.paths.files.knownHosts)) ?? "", name).find(
    (key) => hostKeyFingerprint(key.split(" ")[1] ?? "") === sftp.hostKey,
  );
  if (pinned === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew's known_hosts file on this computer doesn't hold the key you confirmed for ${sftp.host} (${sftp.hostKey}), so it won't connect. Nothing was changed.`,
      { hint: "Run `opscrew interview` to confirm the host's key again." },
    );
  }
  const trimmed = (path: string) => path.replace(/(.)\/+$/, "$1");
  const phpFolder = trimmed(sftp.phpPath);
  const { webRoot } = hostingTarget(plan);
  return {
    record,
    sftp,
    files: connector(deps, login, sftp.port),
    account: `${sftp.user} at ${sftp.host}`,
    folder: trimmed(sftp.folder),
    phpFolder,
    name: posix.basename(hostingFolder(plan)),
    documentRoot: `${phpFolder}/current${webRoot === "." ? "" : `/${webRoot}`}`,
    hostname: hostnameOf(plan),
    knownHosts: `${name} ${pinned}\n`,
  };
}
