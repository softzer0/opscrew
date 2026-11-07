// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, Compose and GitHub Actions syntax, not JavaScript templates.

import { OpsCrewError } from "@opscrew/core";
import {
  APP_SERVER,
  type DeployPlan,
  type ExtraServer,
  isServerlessTarget,
  monitoringOf,
  type PlanService,
  servicesOn,
} from "@opscrew/plan-schema";
import { enabledServices, initStepsFor } from "../catalog";
import { additionsPath, appDir, EDGE_DIR, type LocalhostSite } from "../edge";
import { httpsPortSuffix, localhostSite } from "../edge/localhost";
import { ACTIONS, type PinArch, TOOLS, toolDownloadUrl } from "../pins";
import {
  certbotHosts,
  type RuntimeContext,
  renderRuntimeFiles,
  serverComposePath,
} from "../runtime";
import { servicesRunningOn } from "../runtime/move";
import { privateAddress } from "../runtime/network";
import { runtimeDir } from "../runtime-dir";
import { siteEnvSecret } from "../serverless/site";
import { sshHostname, tunnelMode } from "../tunnel";
import type { RenderedFile } from "../types";
import { buildReads } from "./build";
import { CLOUDFLARE_DEPLOY_SECRETS, renderCloudflareWorkersWorkflow } from "./cloudflare-workers";
import { edgeCheckStep } from "./edge-check";
import { renderGithubPagesWorkflow } from "./github-pages";
import { afterDeployJobs, deployJob, jobsBeforeDeploy } from "./jobs";
import { inFolder, pushPaths } from "./paths";
import { PORTAINER_DEPLOY_SECRETS, renderPortainerWorkflow } from "./portainer";
import { publicSshClosed, serverDeploySecrets } from "./servers";
import {
  block,
  CHECK_IMAGE,
  DEPLOY_SECRETS,
  DIGEST_REF_PATTERN,
  DOCKER_CONTEXT_HOST,
  deploySecretName,
  deploysInPlace,
  healthPath,
  imageOutput,
  MODE_ENV,
  onRunnerMachine,
  planFilePath,
  promoted,
  promotedAbout,
  provisionCommand,
  ROLLING_BACK,
  run,
  runnerStartCommand,
  secret,
  selfHosted,
  serviceEnvSecret,
  workflowStart,
} from "./shared";
import { snapshotScript } from "./snapshot-script";
import { releaseSnapshotServers, SNAPSHOT_SCRIPT } from "./snapshots";
import {
  appHoldCommands,
  DATABASE_CHANGED,
  dockerConfig,
  type EdgeFiles,
  rollbackCommands,
  runningCommands,
  serverCommands,
  serverRollbackCommands,
  switchCommands,
} from "./switch";

export { CLOUDFLARE_DEPLOY_SECRETS, renderCloudflareWorkersWorkflow } from "./cloudflare-workers";
export { PAGES_PUBLISH_JOB, renderGithubPagesWorkflow } from "./github-pages";
export { DEPLOY_PAUSED_VARIABLE } from "./pause";
export { PORTAINER_DEPLOY_SECRETS, portainerHealthUrl } from "./portainer";
export { serverDeploySecrets } from "./servers";
export {
  buildRunner,
  DEPLOY_SECRETS,
  deploySecretName,
  environmentTag,
  githubEnvironment,
  ROLLBACK_INPUTS,
  runnerLabel,
  serviceEnvSecret,
  sqliteFolder,
  supercronicArch,
} from "./shared";
export {
  RESTORE_APPROVAL_FILE,
  restoreApprovalLine,
  SCHEDULED_LOG,
} from "./snapshot-script";
export {
  releaseSnapshotServers,
  SNAPSHOT_SCRIPT,
  type SnapshotPart,
  snapshotAboutPath,
  snapshotParts,
} from "./snapshots";
export { type EdgeFiles, processServices, rollbackCommands, switchCommands } from "./switch";

/**
 * The Cloudflare Access service token the deploy workflow reaches SSH through the tunnel with
 * (tunnel mode only; terraform outputs `deploy_service_token_client_id` and
 * `deploy_service_token_client_secret`). `opscrew provision` sets them next to
 * {@link DEPLOY_SECRETS}.
 */
export const TUNNEL_DEPLOY_SECRETS = {
  serviceTokenId: "OPSCREW_TUNNEL_SERVICE_TOKEN_ID",
  serviceTokenSecret: "OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET",
} as const;

const SSH_OPTS_BASE =
  "-o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o BatchMode=yes -o ConnectTimeout=20";

/**
 * Where the deploy keeps its SSH key (`opscrew`), known hosts and, in tunnel mode, SSH config: the
 * runner's `~/.ssh` on GitHub's machines, which no other job uses; on a runner machine
 * ({@link onRunnerMachine}) the job's own `$RUNNER_TEMP/opscrew-ssh`, which the runner empties
 * after the job.
 */
function sshFile(machine: boolean, name: string): string {
  return machine ? `"$RUNNER_TEMP/opscrew-ssh/${name}"` : `~/.ssh/${name}`;
}

/** ` -o Port=<port>` for an SSH port other than 22; nothing for 22 or none. */
function portOption(port: number | undefined): string {
  return port === undefined || port === 22 ? "" : ` -o Port=${port}`;
}

/**
 * The bash `ssh_opts` array shared by every `ssh` and `scp` call. A server whose sshd listens on a
 * port other than 22 (public mode) gets `-o Port=<port>`, which both `ssh` and `scp` honour (and
 * which makes ssh look up `[host]:port` in known_hosts, as provision writes it). Tunnel mode never
 * gets it: cloudflared's ProxyCommand ignores the client-side port, the tunnel itself routes to the
 * server's sshd port, and known_hosts holds the bare SSH hostname. On a runner machine the options
 * name the job's own known hosts and SSH config ({@link sshFile}) too.
 */
export function sshOptsLine(port: number | undefined, tunnel: boolean, machine: boolean): string {
  const portOpt = tunnel ? "" : portOption(port);
  const known = machine ? ` -o UserKnownHostsFile=${sshFile(machine, "known_hosts")}` : "";
  const config = machine ? ` -F ${sshFile(machine, "config")}` : "";
  return `ssh_opts=(-i ${sshFile(machine, "opscrew")}${known}${config} ${SSH_OPTS_BASE}${portOpt})`;
}

/**
 * Checks the SSH port a workflow connects to.
 * @throws Error when it is not a whole number from 1 to 65535.
 */
export function checkSshPort(port: number | undefined): void {
  if (port === undefined) return;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `The server's SSH port "${port}" is not a whole number between 1 and 65535. Check the port sshd listens on (sshd -T) and run the command again.`,
    );
  }
}

/**
 * URL the deploy job polls after starting the new version: the health path on the app's domain;
 * without one, on the server's address from GitHub's machines or a runner machine, or on the
 * machine's own edge (`http://127.0.0.1`) from the server's runner. On this computer (the localhost
 * target, `local`), HTTPS at the app's hostname there and the target's HTTPS port, which the
 * health check resolves to 127.0.0.1 ({@link healthScript}): the plain HTTP port only redirects.
 */
export function healthUrl(plan: DeployPlan, local?: LocalEdge): string {
  const path = healthPath(plan);
  if (local !== undefined) return `https://${local.hostname}${httpsPortSuffix(local.port)}${path}`;
  if (plan.dns.domain) return `https://${plan.dns.domain}${path}`;
  if (!deploysInPlace(plan)) return `http://${secret(plan, DEPLOY_SECRETS.host)}${path}`;
  return `http://127.0.0.1${path}`;
}

/**
 * Let's Encrypt's limit on new certificates for the exact same set of names: 5 per 7 days, one
 * more about every 34 hours (https://letsencrypt.org/docs/rate-limits/, checked 2026-10-15).
 */
const LETS_ENCRYPT_SAME_NAMES_PER_WEEK = 5;

/**
 * Whether the health check reaches the proxy's own certificate from Let's Encrypt: the plan has a
 * domain, no tunnel, and is not on this computer (whose leaf comes from OpsCrew's local CA). Then
 * a failed TLS handshake means that the proxy has no certificate yet (Let's Encrypt's limit is
 * the usual cause on a server rebuilt many times): curl's own (exit 35 or 60) or, behind
 * Cloudflare's proxy, Cloudflare's with the server (HTTP 525 or 526).
 */
function edgeServesTls(plan: DeployPlan, tunnelHost: string | undefined): boolean {
  return (
    plan.target.provider !== "localhost" &&
    plan.dns.domain !== undefined &&
    tunnelHost === undefined
  );
}

/** On this computer: the app's hostname there and the target's HTTPS port. */
export interface LocalEdge {
  hostname: string;
  port: number;
}

/**
 * The health check's script. With `tlsHint`, curl's exit codes and HTTP statuses are recorded
 * and, when every attempt failed a TLS handshake, the error says that the server has no
 * certificate yet; otherwise, and without `tlsHint`, it says only that the new version did not
 * answer. On this computer (`local`), curl connects to 127.0.0.1 and trusts only OpsCrew's local
 * CA, whose certificate the local runner names in `OPSCREW_LOCAL_CA_FILE`. That CA publishes no
 * revocation list, so `--ssl-no-revoke` keeps Windows' curl (Schannel, as in Git for Windows) from
 * refusing its certificate as of unknown revocation status; other TLS libraries ignore it.
 */
function healthScript(plan: DeployPlan, tlsHint: boolean, local?: LocalEdge): string[] {
  const failed = 'echo "::error::The new version did not answer at $URL."';
  const curl =
    local === undefined
      ? "curl -fsS --max-time 10"
      : `curl -fsS --max-time 10 --resolve ${local.hostname}:${local.port}:127.0.0.1 --cacert "$OPSCREW_LOCAL_CA_FILE" --ssl-no-revoke`;
  return [
    "    set -euo pipefail",
    ...(local === undefined
      ? []
      : [
          '    if [[ -z "${OPSCREW_LOCAL_CA_FILE:-}" ]]; then',
          `      echo "::error::This runner does not set OPSCREW_LOCAL_CA_FILE, the certificate of OpsCrew's local CA that the app's HTTPS is checked with. Start it with \\\`${runnerStartCommand(plan)}\\\`, which sets it."`,
          "      exit 1",
          "    fi",
        ]),
    ...(tlsHint ? ["    tls_only=1"] : []),
    "    for attempt in $(seq 1 30); do",
    ...(tlsHint
      ? [
          "      code=0",
          '      status="$(curl -fsS --max-time 10 -o /dev/null -w \'%{http_code}\' "$URL")" || code=$?',
          '      if [ "$code" -eq 0 ]; then',
        ]
      : // bash discards the body: Windows' curl gets `/dev/null` unchanged on the local runner
        // (MSYS_NO_PATHCONV), where there is no such file.
        [`      if ${curl} "$URL" > /dev/null; then`]),
    '        echo "Healthy after $attempt attempt(s)."',
    "        exit 0",
    "      fi",
    ...(tlsHint
      ? ['      case "$code:$status" in 35:* | 60:* | 22:525 | 22:526) ;; *) tls_only=0 ;; esac']
      : []),
    "      sleep 6",
    "    done",
    ...(tlsHint
      ? [
          '    if [ "$tls_only" -eq 1 ]; then',
          `      echo "::error::The new version did not answer at $URL: every attempt failed the TLS handshake, so the server has no certificate for this domain yet. Let's Encrypt issues at most ${LETS_ENCRYPT_SAME_NAMES_PER_WEEK} certificates per week for the same set of names, so a server rebuilt many times can reach that limit. Wait (one more becomes available about every 34 hours) or use another hostname, then deploy again."`,
          "    else",
          `      ${failed}`,
          "    fi",
        ]
      : [`    ${failed}`]),
    "    exit 1",
  ];
}

/**
 * Where the deploy's cloudflared is: /usr/local/bin on GitHub's machines; on a runner machine,
 * whose user has no sudo, the downloaded file in the job's temp folder.
 */
function cloudflaredPath(machine: boolean): string {
  return machine ? "$RUNNER_TEMP/cloudflared" : "/usr/local/bin/cloudflared";
}

/**
 * Tunnel mode: installs the pinned cloudflared on the runner after checking its SHA-256, so SSH can
 * go through Cloudflare Access (`ProxyCommand cloudflared access ssh`), at {@link cloudflaredPath}.
 */
function installCloudflaredStep(machine: boolean): string[] {
  const path = cloudflaredPath(machine);
  const arch = (uname: string, name: PinArch) =>
    `      ${uname}) url='${toolDownloadUrl("cloudflared", name)}'; sum='${TOOLS.cloudflared.sha256[name]}' ;;`;
  return [
    `- name: Install cloudflared ${TOOLS.cloudflared.version}`,
    "  run: |",
    "    set -euo pipefail",
    '    case "$(uname -m)" in',
    arch("x86_64", "amd64"),
    arch("aarch64", "arm64"),
    '      *) echo "::error::OpsCrew has no cloudflared build for this runner ($(uname -m))."; exit 1 ;;',
    "    esac",
    '    curl -fsSL --retry 3 -o "$RUNNER_TEMP/cloudflared" "$url"',
    '    echo "$sum  $RUNNER_TEMP/cloudflared" | sha256sum -c -',
    ...(machine
      ? [`    chmod 0755 "${path}"`, `    "${path}" --version`]
      : [
          `    sudo install -m 0755 "$RUNNER_TEMP/cloudflared" ${path}`,
          "    cloudflared --version",
        ]),
  ];
}

/**
 * Each of `services`' env file, `<name>.env`, which it reads on its server (every catalog service
 * has secrets), with its deploy secret.
 */
function serviceEnvFiles(services: readonly PlanService[]): EnvFile[] {
  return services.map(({ name }) => ({ file: `${name}.env`, secret: serviceEnvSecret(name) }));
}

/** The `env:` lines that give a step each env file's secret under its own name. */
function envFileEnv(plan: DeployPlan, envFiles: readonly EnvFile[]): string[] {
  return envFiles.map((env) => `    ${env.secret}: ${secret(plan, env.secret)}`);
}

/**
 * What the upload copies next to compose.yaml, from the environment's {@link runtimeDir}: the
 * `services` folder and the crontab when {@link renderRuntimeFiles} renders them, and the `edge`
 * folder (the edge's Compose file, the app's site and, with origin TLS, `tls/pull.pem`), which the
 * start step puts in place.
 */
function runtimeUploads(plan: DeployPlan): string[] {
  const dir = runtimeDir(plan);
  const top = renderRuntimeFiles(plan).map(
    (file) => `${dir}/${file.path.slice(dir.length + 1).split("/")[0]}`,
  );
  return [...new Set(top)];
}

/**
 * The push filter's patterns of the repository paths the upload copies (`files`): every file of a
 * folder {@link renderRuntimeFiles} renders into (`services`, and `edge`, which the edge check reads
 * too), or the file itself (`compose.yaml`, the crontab, the additions).
 */
function uploadReads(plan: DeployPlan, files: readonly string[]): string[] {
  const rendered = renderRuntimeFiles(plan).map((file) => file.path);
  return files.map((path) =>
    rendered.some((file) => file.startsWith(`${path}/`)) ? inFolder(path) : path,
  );
}

/** The lines of a server script for a `run: |` block, ended by the heredoc's `REMOTE`. */
function remote(script: readonly string[]): string[] {
  return [...script.map((line) => (line.length > 0 ? `    ${line}` : "")), "    REMOTE"];
}

/** A shell command, wrapped to run on the machine the app runs on. */
type On = (command: string) => string;

/** Over SSH as `deploy`, from GitHub's machines (after `ssh_opts`). */
const OVER_SSH: On = (command) => `ssh "\${ssh_opts[@]}" "deploy@\${HOST}" '${command}'`;

/** In a subshell on the machine of the self-hosted runner itself. */
const HERE: On = (command) => `(${command})`;

/** Shown when the origin certificate's deploy secret holds no certificate and key. */
function originTlsMissing(plan: DeployPlan): string {
  return `::error::The deploy secret ${deploySecretName(plan, DEPLOY_SECRETS.originTls)} must hold the app's Cloudflare origin certificate, then its private key. Run \\\`${provisionCommand(plan)}\\\` again to set it, then deploy again.`;
}

/**
 * The upload's lines for origin TLS: the certificate and the key from {@link DEPLOY_SECRETS}'
 * `originTls`, each on the stdin of a command `on` the machine (never in a command line or the
 * log), into `dir`, the app's origin TLS folder (`/srv/edge/tls/<app>`, 0700, files 0600), as
 * `origin.pem.new` and `origin.key.new`, which the start step puts in place under the edge's lock,
 * with `pull.pem` from the uploaded edge files.
 */
function originTlsUpload(plan: DeployPlan, dir: string, on: On): string[] {
  const value = `"$${DEPLOY_SECRETS.originTls}"`;
  return [
    `    case "\${${DEPLOY_SECRETS.originTls}:-}" in`,
    '      *"-----BEGIN CERTIFICATE-----"*"PRIVATE KEY-----"*) ;;',
    `      *) echo "${originTlsMissing(plan)}"; exit 1 ;;`,
    "    esac",
    `    printf '%s\\n' ${value} | sed '/-BEGIN [A-Z ]*PRIVATE KEY-/,$d' | ${on(`umask 077 && mkdir -p ${dir} && chmod 700 ${dir} && cat > ${dir}/origin.pem.new`)}`,
    `    printf '%s\\n' ${value} | sed -n '/-BEGIN [A-Z ]*PRIVATE KEY-/,$p' | ${on(`umask 077 && cat > ${dir}/origin.key.new`)}`,
  ];
}

/** The env files the upload writes next to compose.yaml, each from its deploy secret. */
interface EnvFile {
  file: string;
  secret: string;
}

/**
 * Each env file onto the machine on the stdin of a command `on` it, from its secret (the step's
 * variable of the same name), never in a command line or the log; `dir` is the app's folder.
 */
function envFileWrites(envFiles: readonly EnvFile[], dir: string, on: On): string[] {
  return envFiles.map(
    (env) =>
      `    printf '%s\\n' "\${${env.secret}:-}" | ${on(`umask 077 && cat > ${dir}/${env.file}`)}`,
  );
}

/**
 * The host lists' names as a shell `case` pattern, as plan-schema's `hostListKind` reads them
 * (`ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, each with or without a prefix): they hold the app's
 * own hostnames, which the masking file leaves alone.
 */
const HOST_LIST_NAMES =
  "ALLOWED_HOSTS|?*_ALLOWED_HOSTS|CSRF_TRUSTED_ORIGINS|?*_CSRF_TRUSTED_ORIGINS";

/** The app's env file on the app's server, from its deploy secret. */
const APP_ENV_FILE: EnvFile = { file: "app.env", secret: DEPLOY_SECRETS.appEnv };

/**
 * The masking file Grafana Alloy reads on `server`: on the app's server with Grafana Cloud on
 * (`observability.grafanaCloud.enabled`) or monitoring on, from `app.env`; on an extra server with
 * monitoring on, from the env files it receives (`envFiles`). It is `mask.re` in the app's folder
 * `dir`, written in place (Alloy follows the file, not a rename) on the stdin of a command `on` the
 * machine, owner-only as the env files, right after them. It holds every value of those env files
 * of 8 characters or more (each line of a multi-line value, as the redactor's literals) except the
 * host lists ({@link HOST_LIST_NAMES}), longest first (RE2's alternation takes the first that
 * matches, so a value that begins another can't leave the rest of it unmasked), escaped and joined
 * as one RE2 alternation in a capture group (Alloy's `stage.replace` masks only groups), or
 * `[^\s\S]`, which never matches, when there is none. Nothing on a server Alloy doesn't run on.
 */
function maskFileWrite(
  plan: DeployPlan,
  server: string,
  envFiles: readonly EnvFile[],
  dir: string,
  on: On,
): string[] {
  const monitored = monitoringOf(plan) !== undefined;
  const grafanaCloud = server === APP_SERVER && plan.observability?.grafanaCloud?.enabled === true;
  if (!monitored && !grafanaCloud) return [];
  const secrets = envFiles.map((env) => `"\${${env.secret}:-}"`);
  // One env file is read as it is; several are joined, one after the other.
  const values =
    secrets.length === 1 ? secrets.join("") : `"$(printf '%s\\n' ${secrets.join(" ")})"`;
  const names = envFiles.map((env) => env.file);
  const files = names.length === 1 ? `${names[0]}'s values` : `the values of ${names.join(", ")}`;
  return [
    `# Grafana Alloy's masking file: ${files} as one RE2 alternation, longest first.`,
    "parts=",
    "while IFS= read -r line; do",
    '  [[ "$line" == [A-Za-z_]*=* ]] || continue',
    `  case "\${line%%=*}" in ${HOST_LIST_NAMES}) continue ;; esac`,
    '  value="${line#*=}"',
    '  case "$value" in',
    "    \\'*\\') value=\"${value:1:-1}\" ;;",
    '    \\"*\\")',
    // Undoes the env file's double quotes: \\ (kept apart first), \", \n and $$.
    '      value="${value:1:-1}"',
    "      value=\"${value//\\\\\\\\/$'\\x01'}\"",
    '      value="${value//\\\\\\"/\\"}"',
    "      value=\"${value//\\\\n/$'\\n'}\"",
    '      value="${value//\\$\\$/\\$}"',
    "      value=\"${value//$'\\x01'/\\\\}\"",
    "      ;;",
    "  esac",
    "  while IFS= read -r part; do",
    "    if (( ${#part} >= 8 )); then parts+=\"${#part}\"$'\\t'\"$part\"$'\\n'; fi",
    '  done <<< "$value"',
    `done <<< ${values}`,
    "mask=\"$(printf '%s' \"$parts\" | sort -rn | cut -f2- | sed 's/[][\\.*+?(){}|^$]/\\\\&/g' | paste -sd '|' -)\"",
    'if [[ -n "$mask" ]]; then mask="($mask)"; else mask=\'[^\\s\\S]\'; fi',
    `printf '%s' "$mask" | ${on(`umask 077 && cat > ${dir}/mask.re`)}`,
  ];
}

/**
 * The deploy's masking script ({@link maskFileWrite}) as a bash script that runs on the app's
 * server, in its folder, from the `app.env` there: for a change of the app's settings outside the
 * deploy (a service's move between the app's servers). Empty without Grafana Cloud or monitoring.
 */
export function maskFileScript(plan: DeployPlan): string {
  const dir = appDir(plan);
  const lines = maskFileWrite(plan, APP_SERVER, [APP_ENV_FILE], dir, HERE);
  if (lines.length === 0) return "";
  const script = [
    "set -euo pipefail",
    `${DEPLOY_SECRETS.appEnv}="$(cat ${dir}/app.env)"`,
    ...lines,
  ];
  return `${script.join("\n")}\n`;
}

/**
 * The upload of `server`'s {@link snapshotScript} into the app's folder `dir` there, on the stdin
 * of a command `on` the machine: written as `snapshot.sh.new` and renamed in place, so a snapshot
 * that runs meanwhile keeps reading its own copy. None without data on the server.
 */
function snapshotUpload(plan: DeployPlan, server: string, dir: string, on: On): string[] {
  const script = snapshotScript(plan, server);
  if (script.length === 0) return [];
  const path = `${dir}/${SNAPSHOT_SCRIPT}`;
  return [
    `    ${on(`umask 077 && cat > ${path}.new && mv -f ${path}.new ${path}`)} <<'SNAPSHOT'`,
    ...script.map((line) => (line.length > 0 ? `    ${line}` : "")),
    "    SNAPSHOT",
  ];
}

/**
 * Saves the running version as `.env.previous` and prints its image, in the app's folder; an
 * earlier run's database marker ({@link DATABASE_CHANGED}) goes, so this run's rollback step never
 * acts on it.
 */
const SAVE_PREVIOUS = `rm -f .env.previous ${DATABASE_CHANGED} && if [ -f .env ]; then cp .env .env.previous && sed -n "s/^APP_IMAGE=//p" .env; fi`;

/** Prints the image `.env` names in the app's folder, if any; changes nothing. */
const READ_RUNNING = 'if [ -f .env ]; then sed -n "s/^APP_IMAGE=//p" .env; fi';

/** How the start and rollback steps reach the app's machine: over SSH, or on the runner's own. */
interface Reach {
  /** The steps' `env:` lines for it. */
  env: readonly string[];
  /** The scripts' first lines after their checks (`ssh_opts`, or the app's folder `dir`). */
  prelude: readonly string[];
  /** The command that runs {@link SAVE_PREVIOUS} in the app's folder. */
  savePrevious: string;
  /** The command that runs {@link READ_RUNNING} in the app's folder. */
  readRunning: string;
  /** Logs in to GHCR with `$REGISTRY_TOKEN` in the app's own Docker settings (script lines). */
  login: readonly string[];
  /** The shell there, which reads a script on its stdin (`-s`). */
  sh: string;
  /** What to do when the rollback failed. */
  stuck: string;
}

/**
 * The start step. Saving the running version is the first thing done on the machine (its image is
 * the job's `previous` output), and the rollback only switches back when `.env` already names this
 * run's image, so a failure before the switch never restores an older version. The registry login
 * goes into the app's own Docker settings: another app's deploy logs out of the same registry.
 * `MODE` is the switch script's `$2`: a rollback dispatch's `rollback` runs no release command.
 * With extra servers whose data each release snapshots (`others`), `$3` names those whose
 * snapshot the rollback restored ({@link othersStep}).
 */
function startStep(
  plan: DeployPlan,
  edgeFiles: EdgeFiles,
  reach: Reach,
  others: readonly string[],
): string[] {
  const restored = others.length > 0;
  return [
    "- id: start",
    "  name: Start the new version",
    "  env:",
    ...reach.env,
    `    IMAGE: ${imageOutput(plan, "image")}`,
    `    TAG: ${imageOutput(plan, "tag")}`,
    MODE_ENV,
    ...(restored ? [RESTORED_ENV] : []),
    "    REGISTRY_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
    "  run: |",
    "    set -euo pipefail",
    ...block(CHECK_IMAGE, 4),
    '    echo "Deploying ${TAG:-the new image} as $IMAGE"',
    ...reach.prelude,
    `    previous="$(${reach.savePrevious})"`,
    // An image built on this computer (provision's first start of an environment on the local
    // runner) is no previous GHCR image: the prune job keeps none for it.
    '    if [[ "$previous" == opscrew-local/* ]]; then previous=; fi',
    `    if [[ -n "$previous" && ! "$previous" =~ ${DIGEST_REF_PATTERN} ]]; then previous=unknown; fi`,
    '    echo "previous=$previous" >> "$GITHUB_OUTPUT"',
    ...reach.login,
    `    ${reach.sh} -s -- "$IMAGE" "$MODE"${restored ? ' "$RESTORED"' : ""} <<'REMOTE'`,
    // The services' one-time setup steps come from the catalog; no entry has any yet.
    ...remote(switchCommands(plan, initStepsFor(plan), edgeFiles)),
  ];
}

/**
 * In a rollback dispatch, once the switch and the check from outside passed: the run's summary
 * says which image the environment went back to, and its commit. A failed rollback says nothing
 * here; the rollback step reports it.
 */
function rolledBackStep(plan: DeployPlan): string[] {
  return [
    "- name: Say what the rollback went back to",
    `  if: ${ROLLING_BACK}`,
    "  env:",
    `    IMAGE: ${imageOutput(plan, "image")}`,
    `    TAG: ${imageOutput(plan, "tag")}`,
    ...run([
      "set -euo pipefail",
      "# The commit tag is <commit>, or <commit>-<env> outside prod.",
      'commit="${TAG##*:}"',
      'echo "Rolled back to \\`$IMAGE\\` (built from \\`${commit%%-*}\\`): no build, no release command." >> "$GITHUB_STEP_SUMMARY"',
    ]),
  ];
}

/**
 * The rollback step: runs only when starting or checking the new version failed (not for upload
 * or setup errors), or the run was cancelled while it started, so a cancelled database step still
 * gets its database back and the app started; it always fails the job. `localhost` is the app's
 * hostname on the localhost target, as the start script has it. In a rollback dispatch (`MODE`
 * `rollback`) its messages say that the rollback failed, and that the version restored is the one
 * that ran before it.
 *
 * When the rollback restored the snapshot on extra servers (`others`, {@link othersStep}'s
 * `restored`), it first stops the app and puts each one's data back as it was before the rollback,
 * then runs the app's rollback script, and starts the app again once that script answered. When
 * stopping or a put-back failed, the app stays stopped, its requests let through, and nothing else
 * runs: no version starts on data it doesn't match.
 */
function rollbackStep(
  plan: DeployPlan,
  ctx: RuntimeContext,
  reach: Reach,
  localhost: LocalhostSite | undefined,
  others: readonly string[],
): string[] {
  const putBack =
    others.length === 0
      ? []
      : [
          '    restored="${RESTORED:-}"',
          '    if [[ -n "$restored" ]]; then',
          // At the block's indentation: each here-document ends at the line's start.
          ...otherServerScripts(plan, ctx, others),
          "      stuck=0",
          `      ${reach.sh} -s -- stop < "$RUNNER_TEMP/opscrew-hold.sh" || stuck=1`,
          "      if (( ! stuck )); then",
          "        for server in $restored; do",
          '          server_sh "$server" back "$RUNNING" < "$RUNNER_TEMP/opscrew-rollback-$server.sh" || stuck=1',
          "        done",
          "      fi",
          "      if (( stuck )); then",
          `        ${reach.sh} -s -- requests < "$RUNNER_TEMP/opscrew-hold.sh" || true`,
          `        echo "::error::The rollback failed, and OpsCrew could not stop the app or put the data on its other servers back as it was before the rollback (the messages above say which), so the app stays stopped and no version runs on that data. Restore each server's copy from before the rollback, then start the app. ${reach.stuck}"`,
          "        exit 1",
          "      fi",
          "    fi",
        ];
  const resume =
    others.length === 0
      ? []
      : [
          '    if [[ -n "$restored" ]]; then',
          '      case "$outcome" in',
          `        restored | unchanged | no-previous) ${reach.sh} -s -- resume < "$RUNNER_TEMP/opscrew-hold.sh" || true ;;`,
          "      esac",
          "    fi",
        ];
  return [
    "- name: Roll back to the previous version",
    "  if: (failure() || cancelled()) && (steps.start.outcome == 'failure' || steps.start.outcome == 'cancelled' || steps.health.outcome == 'failure')",
    "  env:",
    ...reach.env,
    ...(others.length === 0 ? [] : otherServersEnv(plan, others)),
    `    IMAGE: ${imageOutput(plan, "image")}`,
    MODE_ENV,
    ...(others.length === 0 ? [] : [RESTORED_ENV, RUNNING_ENV]),
    "  run: |",
    "    set -uo pipefail",
    ...reach.prelude,
    ...putBack,
    "    cat > \"$RUNNER_TEMP/rollback.sh\" <<'REMOTE'",
    ...remote(rollbackCommands(plan, localhost)),
    "    outcome=unchanged",
    `    if [[ "\${IMAGE:-}" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    `      outcome="$(${reach.sh} -s -- "$IMAGE" < "$RUNNER_TEMP/rollback.sh")"`,
    "    fi",
    ...resume,
    '    case "$MODE:$outcome" in',
    "      rollback:restored)",
    '        echo "::error::The rollback failed: the earlier version did not pass its checks, so OpsCrew put back the version that ran before the rollback." ;;',
    "      rollback:unchanged)",
    '        echo "::error::The rollback failed before the earlier version took traffic; the server still runs the version it had." ;;',
    "      rollback:*)",
    `        echo "::error::The rollback failed and OpsCrew could not put back the version that ran before it. ${reach.stuck}" ;;`,
    "      *:restored)",
    '        echo "::error::The deploy failed; OpsCrew restored the previous version." ;;',
    "      *:unchanged)",
    '        echo "::error::The deploy failed before the new version took traffic; the server still runs the version it had." ;;',
    "      *:no-previous)",
    '        echo "::error::The deploy failed and there is no earlier version to restore (first deploy, or the same image was already running). Fix the problem and push again." ;;',
    "      *)",
    `        echo "::error::The deploy failed and OpsCrew could not restore the previous version. ${reach.stuck}" ;;`,
    "    esac",
    "    exit 1",
  ];
}

/**
 * The step that writes the environment's SSH key and the server's pinned known hosts (its deploy
 * secrets) where {@link sshOptsLine} reads them ({@link sshFile}); its `run:` script ends with
 * these lines, so a caller may append more.
 */
export function sshKeySetup(plan: DeployPlan, machine: boolean): string[] {
  const file = (name: string) => sshFile(machine, name);
  return [
    "- name: Configure SSH with the pinned host key",
    "  env:",
    `    SSH_KEY: ${secret(plan, DEPLOY_SECRETS.sshKey)}`,
    `    KNOWN_HOSTS: ${secret(plan, DEPLOY_SECRETS.knownHosts)}`,
    "  run: |",
    "    set -euo pipefail",
    `    install -m 700 -d ${machine ? '"$RUNNER_TEMP/opscrew-ssh"' : "~/.ssh"}`,
    `    printf '%s\\n' "$SSH_KEY" > ${file("opscrew")}`,
    `    chmod 600 ${file("opscrew")}`,
    `    printf '%s\\n' "$KNOWN_HOSTS" > ${file("known_hosts")}`,
  ];
}

/** How the deploy reaches the app's machine: the steps that set up its access, then the upload. */
interface Deploy {
  /** The steps that let the later ones reach the machine (SSH's key and config, cloudflared). */
  connect: string[];
  /** The upload's steps. */
  setup: string[];
  reach: Reach;
}

/** What the upload brings: the env files, the runtime files and the edge's files. */
interface Upload {
  /** The `env:` lines of the env files' and the origin certificate's secrets. */
  env: readonly string[];
  envFiles: readonly EnvFile[];
  /** The repository paths copied into the app's folder. */
  files: readonly string[];
  edgeFiles: EdgeFiles;
}

/**
 * The deploy from GitHub's machines or a runner machine over SSH (as `deploy`, with the pinned host
 * key; in tunnel mode through Cloudflare Access to the SSH hostname, with the service token from
 * {@link TUNNEL_DEPLOY_SECRETS}): the upload (with the app's server's `snapshot.sh`, {@link
 * snapshotUpload}), then the start and rollback steps over SSH. A runner
 * machine runs the same steps with the job's own SSH files ({@link sshFile}) and cloudflared
 * ({@link cloudflaredPath}).
 */
function sshDeploy(plan: DeployPlan, ctx: RuntimeContext, upload: Upload): Deploy {
  // Tunnel mode: SSH goes through Cloudflare Access to the SSH hostname (it is in the committed
  // HCL anyway); the service token reaches cloudflared only through the environment.
  const tunnelHost = sshHostname(plan);
  const machine = onRunnerMachine(plan);
  const file = (name: string) => sshFile(machine, name);
  const sshOpts = `    ${sshOptsLine(ctx.sshPort, tunnelHost !== undefined, machine)}`;
  // On GitHub's machines the path is fixed; a runner machine's folder is expanded when written.
  const proxyCommand = `  ProxyCommand ${cloudflaredPath(machine)} access ssh --hostname %h`;
  // The tunnel's SSH config; on a runner machine always the job's own (empty in public mode), so
  // that the machine user's own ssh config cannot change the deploy's connection.
  const sshConfig =
    tunnelHost !== undefined
      ? [
          "    {",
          `      echo 'Host ${tunnelHost}'`,
          `      echo ${machine ? `"${proxyCommand}"` : `'${proxyCommand}'`}`,
          `    } > ${file("config")}`,
          `    chmod 600 ${file("config")}`,
        ]
      : machine
        ? [`    : > ${file("config")}`]
        : [];
  const hostEnv = [
    tunnelHost === undefined
      ? `    HOST: ${secret(plan, DEPLOY_SECRETS.host)}`
      : `    HOST: ${tunnelHost}`,
    ...(tunnelHost === undefined
      ? []
      : [
          `    TUNNEL_SERVICE_TOKEN_ID: ${secret(plan, TUNNEL_DEPLOY_SECRETS.serviceTokenId)}`,
          `    TUNNEL_SERVICE_TOKEN_SECRET: ${secret(plan, TUNNEL_DEPLOY_SECRETS.serviceTokenSecret)}`,
        ]),
  ];
  // The app's folder: OpsCrew's own servers (cloud-init) have only /srv/apps before the first deploy.
  const dir = appDir(plan);
  const connect = [
    ...(tunnelHost === undefined ? [] : installCloudflaredStep(machine)),
    ...sshKeySetup(plan, machine),
    ...sshConfig,
  ];
  const setup = [
    "- name: Upload runtime files and environment",
    "  env:",
    ...hostEnv,
    ...upload.env,
    "  run: |",
    "    set -euo pipefail",
    sshOpts,
    `    ${OVER_SSH(`mkdir -p ${dir}`)}`,
    `    scp -r "\${ssh_opts[@]}" ${upload.files.join(" ")} "deploy@\${HOST}:${dir}/"`,
    ...envFileWrites(upload.envFiles, dir, OVER_SSH),
    ...maskFileWrite(plan, APP_SERVER, [APP_ENV_FILE], dir, OVER_SSH).map((line) => `    ${line}`),
    ...(upload.edgeFiles.originTls
      ? originTlsUpload(plan, `${EDGE_DIR}/tls/${plan.app.name}`, OVER_SSH)
      : []),
    ...snapshotUpload(plan, APP_SERVER, dir, OVER_SSH),
  ];
  return {
    connect,
    setup,
    reach: {
      env: hostEnv,
      prelude: [sshOpts],
      savePrevious: OVER_SSH(`cd ${dir} && ${SAVE_PREVIOUS}`),
      readRunning: OVER_SSH(`cd ${dir} && ${READ_RUNNING}`),
      login: [
        `    printf '%s\\n' "$REGISTRY_TOKEN" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" "DOCKER_CONFIG=${dockerConfig(plan)} docker login ghcr.io -u '\${GITHUB_ACTOR}' --password-stdin"`,
      ],
      sh: 'ssh "${ssh_opts[@]}" "deploy@${HOST}" sh',
      stuck: `Connect to the server and run \\\`docker compose ps\\\` in ${dir}.`,
    },
  };
}

/** The job's SSH files for the app's extra servers, in its temp folder (the key and known hosts). */
function serversFile(name: string): string {
  return `"$RUNNER_TEMP/opscrew-servers/${name}"`;
}

/**
 * Where the deploy reaches the extra server `server`: its public address from its deploy secret
 * ({@link serverDeploySecrets}), or with public SSH closed its private address, which the job's
 * runner, inside the private network, reaches.
 */
function extraServerHost(plan: DeployPlan, server: ExtraServer): string {
  return publicSshClosed(plan)
    ? privateAddress(plan, server.name)
    : secret(plan, serverDeploySecrets(server.name).host);
}

/** The step's `$RUNNING`: the image the app's server ran when the job began ({@link outgoingStep}). */
const RUNNING_ENV = "    RUNNING: ${{ steps.outgoing.outputs.image }}";

/** The step's `$RESTORED`: the extra servers whose snapshot the rollback restored ({@link othersStep}). */
const RESTORED_ENV = "    RESTORED: ${{ steps.others.outputs.restored }}";

/** The variable that holds the address of the extra server `name` in a step reaching several. */
function serverHostVariable(name: string): string {
  return `SERVER_HOST_${name.toUpperCase().replaceAll("-", "_")}`;
}

/** The `env:` lines with each of the extra servers `names`' address ({@link extraServerHost}). */
function otherServersEnv(plan: DeployPlan, names: readonly string[]): string[] {
  return (plan.servers ?? [])
    .filter((server) => names.includes(server.name))
    .map((server) => `    ${serverHostVariable(server.name)}: ${extraServerHost(plan, server)}`);
}

/**
 * The script lines that reach the extra servers `names` from a step after their own (whose files
 * in {@link serversFile} stay): `server_sh <server> <args>…` runs `sh -s` there as `deploy` with
 * the step's stdin; then the scripts it sends, in the job's temp folder: the app's hold script
 * ({@link appHoldCommands}) as `opscrew-hold.sh` and each server's rollback script
 * ({@link serverRollbackCommands}) as `opscrew-rollback-<server>.sh`.
 */
function otherServerScripts(
  plan: DeployPlan,
  ctx: RuntimeContext,
  names: readonly string[],
): string[] {
  const file = (name: string) => `"$RUNNER_TEMP/opscrew-${name}.sh"`;
  return [
    ...otherServerShell(ctx, names),
    `    cat > ${file("hold")} <<'REMOTE'`,
    ...remote(appHoldCommands(plan)),
    ...names.flatMap((name) => [
      `    cat > ${file(`rollback-${name}`)} <<'REMOTE'`,
      ...remote(serverRollbackCommands(plan, name)),
    ]),
  ];
}

/** The `server_sh <server> <args>…` function of {@link otherServerScripts}; another name fails. */
function otherServerShell(ctx: RuntimeContext, names: readonly string[]): string[] {
  return [
    "    server_sh() {",
    '      case "$1" in',
    ...names.map((name) => {
      const options = `-i ${serversFile("key")} -o UserKnownHostsFile=${serversFile("known_hosts")} -F ${serversFile("config")} ${SSH_OPTS_BASE}${portOption(ctx.serverSshPorts?.[name])}`;
      return `        ${name}) ssh ${options} "deploy@\${${serverHostVariable(name)}}" sh -s -- "\${@:2}" ;;`;
    }),
    "        *) return 1 ;;",
    "      esac",
    "    }",
  ];
}

/**
 * Before the extra servers' steps when they hold part of the release snapshot (`others`): reads
 * the image the app's server runs (`.env`, through `reach`), as the step's output `image`, empty
 * when it names none by digest. Their steps snapshot their data under it, and a rollback saves
 * their data under it before restoring (plan.md D7).
 */
function outgoingStep(reach: Reach): string[] {
  return [
    "- id: outgoing",
    "  name: Read the version that runs on the app's server",
    ...(reach.env.length === 0 ? [] : ["  env:", ...reach.env]),
    "  run: |",
    "    set -euo pipefail",
    ...reach.prelude,
    `    running="$(${reach.readRunning})"`,
    `    if [[ ! "$running" =~ ${DIGEST_REF_PATTERN} ]]; then running=; fi`,
    '    echo "image=$running" >> "$GITHUB_OUTPUT"',
  ];
}

/**
 * In a rollback dispatch, before the start step, when extra servers hold part of the release
 * snapshot (`others`, plan.md D7):
 * 1. each one's one-time approval is checked and removed there (`check`); without one approving
 *    the snapshot anywhere, nothing more happens;
 * 2. the app's server holds the requests and stops the app (`hold`);
 * 3. each approved server copies its data under the running version and restores the snapshot
 *    (`restore`); the step's output `restored` names them, for the start step's database step and
 *    the rollback step.
 * When step 2 or 3 fails, the servers already restored get their data back (`back`) and the app
 * starts again (`resume`); when a put-back failed, or a server's state is unknown, the app stays
 * stopped with its requests let through. The step then fails, before the start step.
 */
function othersStep(
  plan: DeployPlan,
  ctx: RuntimeContext,
  reach: Reach,
  others: readonly string[],
): string[] {
  const hold = (command: string) => `${reach.sh} -s -- ${command} < "$RUNNER_TEMP/opscrew-hold.sh"`;
  const script = '"$RUNNER_TEMP/opscrew-rollback-$server.sh"';
  return [
    "- id: others",
    "  name: Restore the snapshot on the app's other servers",
    `  if: ${ROLLING_BACK}`,
    "  env:",
    ...reach.env,
    ...otherServersEnv(plan, others),
    `    IMAGE: ${imageOutput(plan, "image")}`,
    RUNNING_ENV,
    "  run: |",
    "    set -euo pipefail",
    ...block(CHECK_IMAGE, 4),
    ...reach.prelude,
    ...otherServerScripts(plan, ctx, others),
    "    approved=()",
    `    for server in ${others.join(" ")}; do`,
    `      answer="$(server_sh "$server" check "$IMAGE" < ${script})"`,
    '      if [[ "$answer" == snapshot ]]; then approved+=("$server"); fi',
    "    done",
    "    if (( ${#approved[@]} == 0 )); then exit 0; fi",
    `    if [[ ! "$RUNNING" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    `      echo "::error::The app's server names no version by its image digest, so OpsCrew can't save the data on its other servers before restoring it, and the rollback changed nothing. Run opscrew rollback again and keep the database as it is."`,
    "      exit 1",
    "    fi",
    '    restored=""',
    "    stuck=0",
    "    put_back() {",
    "      local server",
    "      for server in $restored; do",
    `        server_sh "$server" back "$RUNNING" < ${script} || stuck=1`,
    "      done",
    "      if (( stuck )); then",
    `        ${hold("requests")} || true`,
    `        echo "::error::OpsCrew could not put the data on the app's other servers back as it was before the rollback (the messages above say which), so the app stays stopped and no version runs on that data. Restore each server's copy from before the rollback, then start the app. ${reach.stuck}"`,
    "      else",
    `        ${hold("resume")} || true`,
    "      fi",
    "    }",
    "    trap 'status=$?; if (( status != 0 )); then put_back; fi; exit $status' EXIT",
    `    ${hold("hold")}`,
    '    for server in "${approved[@]}"; do',
    "      code=0",
    `      server_sh "$server" restore "$IMAGE" "$RUNNING" < ${script} || code=$?`,
    // 1: the server put its own data back; anything else leaves it unknown.
    "      if (( code != 0 )); then",
    "        if (( code != 1 )); then stuck=1; fi",
    "        exit 1",
    "      fi",
    '      restored="$restored $server"',
    "    done",
    '    echo "restored=${restored# }" >> "$GITHUB_OUTPUT"',
  ];
}

/**
 * At the end of the job, once the start step ran (`others`, plan.md D7): the image the app's server
 * runs (`.env`, after the deploy, a rollback dispatch or the rollback step) goes to
 * {@link RUNNING_FILE} on each extra server that holds part of the snapshot
 * ({@link runningCommands}), so its scheduled and manual snapshots record the version. A failure
 * warns: the deploy itself is done.
 */
function runningStep(
  plan: DeployPlan,
  ctx: RuntimeContext,
  reach: Reach,
  others: readonly string[],
): string[] {
  const warn = (what: string) =>
    `echo "::warning::OpsCrew could not ${what}, so the snapshots taken there by hand or on a schedule may record another version than the one that runs, until the next deploy."`;
  return [
    "- name: Record the running version on the app's other servers",
    "  if: always() && steps.start.outcome != 'skipped'",
    "  env:",
    ...reach.env,
    ...otherServersEnv(plan, others),
    "  run: |",
    "    set -uo pipefail",
    ...reach.prelude,
    ...otherServerShell(ctx, others),
    "    cat > \"$RUNNER_TEMP/opscrew-running.sh\" <<'REMOTE'",
    ...remote(runningCommands(plan)),
    `    if ! running="$(${reach.readRunning})"; then`,
    `      ${warn("read the version that runs on the app's server")}`,
    "      exit 0",
    "    fi",
    `    if [[ ! "$running" =~ ${DIGEST_REF_PATTERN} ]]; then running=; fi`,
    `    for server in ${others.join(" ")}; do`,
    `      server_sh "$server" "$running" < "$RUNNER_TEMP/opscrew-running.sh" || ${warn("record the version that runs on the server $server")}`,
    "    done",
  ];
}

/**
 * The deploy's steps for the app's extra servers (`plan.servers`) that have something to run (a
 * service placed there, or a moving service's old copy until its switch), in plan order, before
 * the app's own upload and switch, so a failure ends the job before the app changes; none without
 * them. A server left with nothing to run is skipped: its stopped old copy goes with
 * `opscrew provision --finish-move`.
 * 1. the app's deploy key and those servers' known hosts into the job's temp folder
 *    ({@link serversFile}), with an SSH config of its own, which leaves the machine user's alone;
 * 2. per server, over SSH as `deploy` ({@link extraServerHost}, on its port from
 *    `ctx.serverSshPorts`): its Compose file ({@link renderServerCompose}'s) as `compose.yaml` in the
 *    app's folder, its services' settings folders and env files, with monitoring on the masking
 *    file ({@link maskFileWrite}) from the env values of every service running there (a moving
 *    service's old copy's too, until its switch), its own `snapshot.sh` ({@link snapshotUpload}),
 *    then {@link serverCommands} (pull, the server's part of the release snapshot, start and wait,
 *    the published-port repair, the services' one-time setup, the scheduled snapshots' crontab
 *    line). A server among `others`, which holds part of the release snapshot, gets the new image,
 *    the one the app's server runs ({@link outgoingStep}) and the mode as its arguments.
 */
function extraServerSteps(
  plan: DeployPlan,
  ctx: RuntimeContext,
  others: readonly string[],
): string[] {
  const servers = (plan.servers ?? []).filter(
    (server) => servicesRunningOn(plan, server.name).length > 0,
  );
  if (servers.length === 0) return [];
  const knownHosts = servers.map((server) => serverDeploySecrets(server.name).knownHosts);
  const dir = appDir(plan);
  const rendered = renderRuntimeFiles(plan).map((file) => file.path);
  return [
    "- name: Configure SSH for the app's other servers",
    "  env:",
    `    SSH_KEY: ${secret(plan, DEPLOY_SECRETS.sshKey)}`,
    ...knownHosts.map((name) => `    ${name}: ${secret(plan, name)}`),
    "  run: |",
    "    set -euo pipefail",
    '    install -m 700 -d "$RUNNER_TEMP/opscrew-servers"',
    `    printf '%s\\n' "$SSH_KEY" > ${serversFile("key")}`,
    `    chmod 600 ${serversFile("key")}`,
    `    printf '%s\\n' ${knownHosts.map((name) => `"$${name}"`).join(" ")} > ${serversFile("known_hosts")}`,
    `    : > ${serversFile("config")}`,
    ...servers.flatMap((server) => {
      const port = ctx.serverSshPorts?.[server.name];
      checkSshPort(port);
      const services = servicesOn(plan, server.name);
      const envFiles = serviceEnvFiles(services);
      // The mask also holds a moving service's old copy's values while it still runs there.
      const maskFiles = serviceEnvFiles(servicesRunningOn(plan, server.name));
      const mask = maskFileWrite(plan, server.name, maskFiles, dir, OVER_SSH);
      const folders = services
        .map((service) => `${runtimeDir(plan)}/services/${service.name}`)
        .filter((folder) => rendered.some((path) => path.startsWith(`${folder}/`)));
      const release = others.includes(server.name);
      return [
        `- name: Update the services on the server ${server.name}`,
        "  env:",
        `    HOST: ${extraServerHost(plan, server)}`,
        ...envFileEnv(plan, mask.length > 0 ? maskFiles : envFiles),
        ...(release ? [`    IMAGE: ${imageOutput(plan, "image")}`, RUNNING_ENV, MODE_ENV] : []),
        "  run: |",
        "    set -euo pipefail",
        `    ssh_opts=(-i ${serversFile("key")} -o UserKnownHostsFile=${serversFile("known_hosts")} -F ${serversFile("config")} ${SSH_OPTS_BASE}${portOption(port)})`,
        `    ${OVER_SSH(`mkdir -p ${folders.length === 0 ? dir : `${dir}/services`}`)}`,
        `    scp "\${ssh_opts[@]}" ${serverComposePath(plan, server.name)} "deploy@\${HOST}:${dir}/compose.yaml"`,
        ...(folders.length === 0
          ? []
          : [
              `    scp -r "\${ssh_opts[@]}" ${folders.join(" ")} "deploy@\${HOST}:${dir}/services/"`,
            ]),
        ...envFileWrites(envFiles, dir, OVER_SSH),
        ...mask.map((line) => `    ${line}`),
        ...snapshotUpload(plan, server.name, dir, OVER_SSH),
        release
          ? `    ssh "\${ssh_opts[@]}" "deploy@\${HOST}" sh -s -- "$IMAGE" "$RUNNING" "$MODE" <<'REMOTE'`
          : `    ssh "\${ssh_opts[@]}" "deploy@\${HOST}" sh -s <<'REMOTE'`,
        ...remote(serverCommands(plan, server.name, initStepsFor(plan, server.name))),
      ];
    }),
  ];
}

/**
 * Refuses a deploy from outside the private network once public SSH is closed
 * (`network.publicSsh: false`): only the server's runner (or the local runner) reaches the
 * servers then.
 * @throws OpsCrewError `INVALID_INPUT` for any other runner, with what to change.
 */
function checkRunnerReachesServers(plan: DeployPlan): void {
  if (!publicSshClosed(plan) || deploysInPlace(plan)) return;
  const from = onRunnerMachine(plan) ? "a runner machine" : "GitHub's machines";
  throw new OpsCrewError(
    "INVALID_INPUT",
    `Public SSH is closed on the app's servers (network.publicSsh: false in ${planFilePath(plan)}), so only a runner inside the private network reaches them, but this environment deploys from ${from}.`,
    {
      hint: `Deploy with the server's own runner (environment.runner: server in ${planFilePath(plan)}), or open public SSH again with \`opscrew secure --open-public-ssh\`, then run \`${provisionCommand(plan)}\` again.`,
    },
  );
}

/** The tries, 2 seconds apart, the local runner's deploy waits for the local deploy lock. */
const LOCAL_LOCK_TRIES = 300;

/**
 * The local runner's start and rollback steps take OpsCrew's local deploy lock, the file
 * `OPSCREW_LOCAL_LOCK` that `opscrew runner start` sets and `opscrew provision` on this computer
 * takes too, so the two never change the shared edge at once (`flock` is missing on Git for
 * Windows and macOS). The file is created only when absent (`noclobber`) and holds the step
 * shell's process id as Windows knows it under Git for Windows, so OpsCrew can tell a lock left by
 * a killed job; the step removes it when it ends. It waits up to 10 minutes.
 */
function localDeployLock(plan: DeployPlan): string[] {
  return [
    '    if [[ -z "${OPSCREW_LOCAL_LOCK:-}" ]]; then',
    `      echo "::error::This runner does not set OPSCREW_LOCAL_LOCK, OpsCrew's deploy lock on this computer. Start it with \\\`${runnerStartCommand(plan)}\\\`, which sets it."`,
    "      exit 1",
    "    fi",
    '    mkdir -p "$(dirname "$OPSCREW_LOCAL_LOCK")"',
    "    holder=$$",
    '    if [[ -r /proc/$$/winpid ]]; then holder="$(cat /proc/$$/winpid)"; fi',
    `    for attempt in $(seq 1 ${LOCAL_LOCK_TRIES}); do`,
    '      if (set -o noclobber; echo "$holder" > "$OPSCREW_LOCAL_LOCK") 2> /dev/null; then break; fi',
    `      if [[ "$attempt" -eq ${LOCAL_LOCK_TRIES} ]]; then`,
    '        echo "::error::Another OpsCrew deploy on this computer has held the local stack for over 10 minutes, so this one did not start. If no other OpsCrew command runs, delete $OPSCREW_LOCAL_LOCK, then run the deploy again."',
    "        exit 1",
    "      fi",
    "      sleep 2",
    "    done",
    "    trap 'rm -f \"$OPSCREW_LOCAL_LOCK\"' EXIT",
  ];
}

/**
 * The deploy on the server's or the local runner's own machine, with no SSH and no host, key or
 * known-hosts secret: the runtime files, env files and `snapshot.sh` are copied into the app's
 * folder, and the
 * same switch and rollback scripts run with the local `sh`, with the same arguments and stdin. The
 * server's runner runs as `deploy`, with the server's folders; the local runner takes this
 * computer's folders from its environment (`OPSCREW_APPS_DIR`, `OPSCREW_EDGE_DIR`, set by
 * `opscrew runner start`), which the scripts read too.
 */
function localDeploy(plan: DeployPlan, upload: Upload): Deploy {
  const app = plan.app.name;
  const local = plan.environment?.runner === "local";
  const dir = local ? `    dir="$OPSCREW_APPS_DIR/${app}"` : `    dir=${appDir(plan)}`;
  const tls = local ? `    tls="$OPSCREW_EDGE_DIR/tls/${app}"` : `    tls=${EDGE_DIR}/tls/${app}`;
  const setup = [
    "- name: Copy the runtime files and environment into the app's folder",
    "  env:",
    ...upload.env,
    "  run: |",
    "    set -euo pipefail",
    ...(local
      ? [
          '    if [[ -z "${OPSCREW_APPS_DIR:-}" || -z "${OPSCREW_EDGE_DIR:-}" ]]; then',
          `      echo "::error::This runner does not set OPSCREW_APPS_DIR and OPSCREW_EDGE_DIR, the folders of this computer's stack. Start it with \\\`${runnerStartCommand(plan)}\\\`, which sets them."`,
          "      exit 1",
          "    fi",
        ]
      : []),
    dir,
    '    mkdir -p "$dir"',
    `    cp -r ${upload.files.join(" ")} "$dir"/`,
    ...envFileWrites(upload.envFiles, '"$dir"', HERE),
    ...maskFileWrite(plan, APP_SERVER, [APP_ENV_FILE], '"$dir"', HERE).map((line) => `    ${line}`),
    ...(upload.edgeFiles.originTls ? [tls, ...originTlsUpload(plan, '"$tls"', HERE)] : []),
    ...snapshotUpload(plan, APP_SERVER, '"$dir"', HERE),
  ];
  return {
    connect: [],
    setup,
    reach: {
      env: [],
      prelude: local ? [...localDeployLock(plan), dir] : [dir],
      savePrevious: `cd "$dir" && ${SAVE_PREVIOUS}`,
      readRunning: `(cd "$dir" && ${READ_RUNNING})`,
      // The scripts run here, so they must not inherit the job's token. On this computer the app's
      // Docker settings start with a ghcr.io entry: settings without any make docker log in to the
      // computer's credential store, where the user's own login lives.
      login: [
        ...(local
          ? [
              '    if [[ ! -f "$dir"/.docker/config.json ]]; then',
              '      mkdir -p "$dir"/.docker',
              '      printf \'{"auths":{"ghcr.io":{}}}\\n\' > "$dir"/.docker/config.json',
              "    fi",
            ]
          : []),
        '    printf \'%s\\n\' "$REGISTRY_TOKEN" | DOCKER_CONFIG="$dir"/.docker docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin',
        "    unset REGISTRY_TOKEN",
      ],
      sh: "sh",
      stuck: "Run \\`docker compose ps\\` in $dir, on the machine this runner runs on.",
    },
  };
}

/**
 * Today's names (before {@link deploySecretName}) of every GitHub Actions secret the plan's deploy
 * workflow can read, which `opscrew provision` sets: the build values (none for a promoted
 * environment, which builds nothing); for a Portainer target, in redeploy mode `cloudflare`, the
 * webhook's; for a server, the app's env file, one per service with secrets and the origin
 * certificate (not behind a tunnel), plus, when the deploy runs over SSH (on GitHub's machines or
 * a runner machine), the connection: the host, the SSH key, the known hosts and in tunnel mode the
 * Access service token. The server's and the local runner deploy on their own machine, so they
 * need no connection secret. With extra servers, each one's {@link serverDeploySecrets} (only its
 * known hosts once public SSH is closed), and the SSH key also for a deploy in place.
 *
 * For a server-less target, the app's variables one by one ({@link siteEnvSecret}), which the
 * build reads (also for GitHub Pages) and, with `render: ssr` on Cloudflare, the deploy job gives
 * to the new version (also in a promoted environment, which builds nothing); on Cloudflare also
 * the deploy token and the account id ({@link CLOUDFLARE_DEPLOY_SECRETS}).
 */
export function deploySecretNamesFor(plan: DeployPlan): string[] {
  if (isServerlessTarget(plan.target)) {
    const values = plan.app.env.map((variable) => siteEnvSecret(variable.name));
    if (plan.target.provider === "github-pages") return values;
    const read = !promoted(plan) || plan.target.render === "ssr";
    return [...Object.values(CLOUDFLARE_DEPLOY_SECRETS), ...(read ? values : [])];
  }
  const build: string[] = promoted(plan)
    ? []
    : [DEPLOY_SECRETS.buildEnv, DEPLOY_SECRETS.buildSecrets];
  if (plan.target.provider === "portainer") {
    const cloudflare = plan.target.redeploy === "cloudflare";
    return [...build, ...(cloudflare ? Object.values(PORTAINER_DEPLOY_SECRETS) : [])];
  }
  const tunnel = tunnelMode(plan);
  const connection = deploysInPlace(plan)
    ? []
    : [
        DEPLOY_SECRETS.host,
        DEPLOY_SECRETS.sshKey,
        DEPLOY_SECRETS.knownHosts,
        ...(tunnel ? Object.values(TUNNEL_DEPLOY_SECRETS) : []),
      ];
  const servers = plan.servers ?? [];
  // The extra servers' known hosts, and their addresses unless public SSH is closed (then the
  // deploy reaches their private addresses); the deploy key, which a deploy in place has no other
  // use for.
  const extra = servers.flatMap((server) => {
    const names = serverDeploySecrets(server.name);
    return publicSshClosed(plan) ? [names.knownHosts] : [names.host, names.knownHosts];
  });
  if (extra.length > 0 && deploysInPlace(plan)) extra.unshift(DEPLOY_SECRETS.sshKey);
  return [
    ...connection,
    ...extra,
    DEPLOY_SECRETS.appEnv,
    ...enabledServices(plan).map(({ name }) => serviceEnvSecret(name)),
    ...(tunnel ? [] : [DEPLOY_SECRETS.originTls]),
    ...build,
  ];
}

/**
 * `cicd.workflowPath` (prod's `.github/workflows/opscrew-deploy.yml`, any other environment's
 * `opscrew-deploy-<env>.yml`): build → push to GHCR → deploy over SSH with rollback,
 * then the optional signing, deploy tag and image retention jobs, and the environment's image
 * labels. A promoted environment instead starts from the digest `opscrew promote` gives it, which
 * its verify job checks, and builds nothing. `opscrew rollback` dispatches either with an earlier
 * image's digest and `rollback` set: the verify job checks it, nothing is built, and the start
 * step runs no release command. While the environment's deploys are paused, only such a dispatch
 * deploys ({@link jobsBeforeDeploy}, {@link deployJob}). The deploy job's secrets, GitHub
 * environment, runner and concurrency group are the environment's own; on the server's or the
 * local runner it deploys
 * on the runner's own machine, with no SSH ({@link localDeploy}), and on a runner machine over SSH
 * as from GitHub's machines. The image is built on an arm64 runner for arm64 servers, or with
 * `environment.build` `runner` on the environment's own runner; in tunnel mode SSH goes through
 * Cloudflare Access to the SSH hostname
 * with the service token from {@link TUNNEL_DEPLOY_SECRETS}. The deploy job first checks the edge
 * with the proxy's own checker ({@link edgeCheckStep}). With `ctx.originTls` (not behind a tunnel)
 * the upload writes the origin certificate and its key from {@link DEPLOY_SECRETS}' `originTls`,
 * and with `ctx.additions` it brings the user's additions for the plan's proxy; the start step puts
 * both in place with the app's site, and on nginx gets certbot's certificate.
 *
 * For a Portainer target the deploy job instead writes the stack file with the new image to the
 * environment's deploy branch (`portainerDeployBranch`, its only `contents: write`), lets
 * Portainer redeploy (the updater stack, or a webhook call through Cloudflare Access with
 * {@link PORTAINER_DEPLOY_SECRETS}), waits for the new version on the site and, when it does not
 * come up, writes the previous version back.
 *
 * The server-less targets have workflows of their own: {@link renderCloudflareWorkersWorkflow}
 * and {@link renderGithubPagesWorkflow}.
 *
 * Every target's push trigger has the path filter {@link pushPaths} makes from what the run reads
 * (here the build's Dockerfile and the uploaded runtime files), with `ctx.otherAppDirs` for an app
 * at the repository root.
 */
export function renderWorkflow(plan: DeployPlan, ctx: RuntimeContext): RenderedFile {
  if (plan.target.provider === "cloudflare-workers") {
    return renderCloudflareWorkersWorkflow(plan, ctx);
  }
  if (plan.target.provider === "github-pages") return renderGithubPagesWorkflow(plan, ctx);
  if (plan.target.provider === "portainer") return renderPortainerWorkflow(plan, ctx);
  checkSshPort(ctx.sshPort);
  // Behind a tunnel the server has no public origin, so no origin certificate (FR-1409).
  const hosts = certbotHosts(plan, ctx);
  const edgeFiles: EdgeFiles = {
    originTls: ctx.originTls !== undefined && !tunnelMode(plan),
    additions: ctx.additions === true,
    certbot: hosts.length > 0 ? { hosts, email: ctx.acmeEmail } : undefined,
    localhost: ctx.localhost,
  };

  checkRunnerReachesServers(plan);

  // The services on the app's server; each extra server's get their env files in its own step.
  const envFiles = [APP_ENV_FILE, ...serviceEnvFiles(servicesOn(plan, APP_SERVER))];
  const upload: Upload = {
    env: [
      ...envFileEnv(plan, envFiles),
      ...(edgeFiles.originTls
        ? [`    ${DEPLOY_SECRETS.originTls}: ${secret(plan, DEPLOY_SECRETS.originTls)}`]
        : []),
    ],
    envFiles,
    files: [
      `${runtimeDir(plan)}/compose.yaml`,
      ...runtimeUploads(plan),
      ...(edgeFiles.additions ? [additionsPath(plan)] : []),
    ],
    edgeFiles,
  };
  const own = deploysInPlace(plan);
  const { connect, setup, reach } = own ? localDeploy(plan, upload) : sshDeploy(plan, ctx, upload);
  // The extra servers that hold part of the release snapshot need the app's server's version first.
  const others = releaseSnapshotServers(plan);
  const local: LocalEdge | undefined =
    plan.target.provider === "localhost"
      ? { hostname: localhostSite(ctx.localhost).hostname, port: plan.target.ports.https }
      : undefined;

  const deploySteps = [
    // The app's own Docker settings (its login) hold no context: keep Docker Desktop's daemon.
    ...(plan.environment?.runner === "local"
      ? [
          "- name: Use this computer's Docker daemon",
          ...run(["set -euo pipefail", ...DOCKER_CONTEXT_HOST]),
        ]
      : []),
    `- uses: ${ACTIONS.checkout}`,
    // A self-hosted runner keeps its workspace: the job's token stays out of its git settings.
    ...(selfHosted(plan) ? ["  with:", "    persist-credentials: false"] : []),
    ...edgeCheckStep(plan, edgeFiles),
    ...(others.length > 0 ? [...connect, ...outgoingStep(reach)] : []),
    ...extraServerSteps(plan, ctx, others),
    ...(others.length > 0 ? [] : connect),
    ...setup,
    ...(others.length > 0 ? othersStep(plan, ctx, reach, others) : []),
    ...startStep(plan, edgeFiles, reach, others),
    "- id: health",
    "  name: Check that the app is healthy",
    "  env:",
    `    URL: ${healthUrl(plan, local)}`,
    "  run: |",
    // With the origin certificate a failed handshake has nothing to do with Let's Encrypt.
    ...healthScript(plan, edgeServesTls(plan, sshHostname(plan)) && !edgeFiles.originTls, local),
    ...rolledBackStep(plan),
    ...rollbackStep(plan, ctx, reach, edgeFiles.localhost, others),
    ...(others.length > 0 ? runningStep(plan, ctx, reach, others) : []),
  ];

  const lines = [
    ...workflowStart(
      plan,
      promoted(plan)
        ? [
            ...promotedAbout(plan, ctx),
            own
              ? "# deploys it with this environment's runner, on its own machine, without building. Secrets"
              : "# deploys it to your server over SSH, without building. Secrets are set by `opscrew provision`;",
            own
              ? "# are set by `opscrew provision`; their values never appear in this file."
              : "# their values never appear in this file.",
          ]
        : own
          ? [
              "# Builds the app image, pushes it to GitHub Container Registry and deploys it with this",
              "# environment's runner, on its own machine. Secrets are set by `opscrew provision`; their",
              "# values never appear in this file.",
            ]
          : [
              "# Builds the app image, pushes it to GitHub Container Registry and deploys it to your server",
              "# over SSH. Secrets are set by `opscrew provision`; their values never appear in this file.",
            ],
      pushPaths(
        plan,
        [
          ...buildReads(plan),
          ...uploadReads(plan, upload.files),
          ...(plan.servers ?? []).map((server) => serverComposePath(plan, server.name)),
        ],
        ctx,
      ),
    ),
    ...jobsBeforeDeploy(plan, ctx),
    "",
    ...deployJob(
      plan,
      "Deploy to the server",
      ["contents: read", "packages: read"],
      "${{ steps.start.outputs.previous }}",
      deploySteps,
    ),
    ...afterDeployJobs(plan),
    "",
  ];
  return { path: plan.cicd.workflowPath, content: lines.join("\n"), kind: "workflow" };
}
