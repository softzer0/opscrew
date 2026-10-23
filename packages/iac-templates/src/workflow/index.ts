// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are bash, Compose and GitHub Actions syntax, not JavaScript templates.

import type { DeployPlan } from "@opscrew/plan-schema";
import { enabledServices, initStepsFor, serviceSpec } from "../catalog";
import { appDir, EDGE_DIR, EDGE_PROXIES, edgeProxy, type LocalhostSite } from "../edge";
import { httpsPortSuffix, localhostSite } from "../edge/localhost";
import { ACTIONS, type PinArch, TOOLS, toolDownloadUrl } from "../pins";
import { assertServerTarget } from "../providers";
import { certbotHosts, type RuntimeContext, renderRuntimeFiles } from "../runtime";
import { runtimeDir } from "../runtime-dir";
import { sshHostname, tunnelMode } from "../tunnel";
import type { RenderedFile } from "../types";
import { edgeCheckStep } from "./edge-check";
import { afterDeployJobs, imageSourceJob } from "./jobs";
import { PORTAINER_DEPLOY_SECRETS, renderPortainerWorkflow } from "./portainer";
import {
  block,
  CHECK_IMAGE,
  DEPLOY_SECRETS,
  DIGEST_REF_PATTERN,
  DOCKER_CONTEXT_HOST,
  deployJob,
  deploySecretName,
  deploysInPlace,
  environmentName,
  healthPath,
  imageOutput,
  onRunnerMachine,
  promoted,
  promotedAbout,
  provisionCommand,
  run,
  secret,
  selfHosted,
  serviceEnvSecret,
  workflowStart,
} from "./shared";
import { dockerConfig, type EdgeFiles, rollbackCommands, switchCommands } from "./switch";

export { PORTAINER_DEPLOY_SECRETS, portainerHealthUrl } from "./portainer";
export {
  buildRunner,
  DEPLOY_SECRETS,
  deploySecretName,
  environmentTag,
  githubEnvironment,
  runnerLabel,
  serviceEnvSecret,
  sqliteFolder,
  supercronicArch,
} from "./shared";
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

/**
 * The bash `ssh_opts` array shared by every `ssh` and `scp` call. A server whose sshd listens on a
 * port other than 22 (public mode) gets `-o Port=<port>`, which both `ssh` and `scp` honour (and
 * which makes ssh look up `[host]:port` in known_hosts, as provision writes it). Tunnel mode never
 * gets it: cloudflared's ProxyCommand ignores the client-side port, the tunnel itself routes to the
 * server's sshd port, and known_hosts holds the bare SSH hostname. On a runner machine the options
 * name the job's own known hosts and SSH config ({@link sshFile}) too.
 */
function sshOptsLine(port: number | undefined, tunnel: boolean, machine: boolean): string {
  const portOpt = port === undefined || port === 22 || tunnel ? "" : ` -o Port=${port}`;
  const known = machine ? ` -o UserKnownHostsFile=${sshFile(machine, "known_hosts")}` : "";
  const config = machine ? ` -F ${sshFile(machine, "config")}` : "";
  return `ssh_opts=(-i ${sshFile(machine, "opscrew")}${known}${config} ${SSH_OPTS_BASE}${portOpt})`;
}

function checkSshPort(port: number | undefined): void {
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
          `      echo "::error::This runner does not set OPSCREW_LOCAL_CA_FILE, the certificate of OpsCrew's local CA that the app's HTTPS is checked with. Start it with \\\`opscrew runner start --env ${environmentName(plan)}\\\`, which sets it."`,
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

/** The plan's services that read `<name>.env` on the server: those with secrets. */
function envFileServices(plan: DeployPlan): string[] {
  return enabledServices(plan)
    .filter((service) => serviceSpec(service.kind).secrets.length > 0)
    .map((service) => service.name);
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

/** Saves the running version as `.env.previous` and prints its image, in the app's folder. */
const SAVE_PREVIOUS =
  'rm -f .env.previous && if [ -f .env ]; then cp .env .env.previous && sed -n "s/^APP_IMAGE=//p" .env; fi';

/** How the start and rollback steps reach the app's machine: over SSH, or on the runner's own. */
interface Reach {
  /** The steps' `env:` lines for it. */
  env: readonly string[];
  /** The scripts' first lines after their checks (`ssh_opts`, or the app's folder `dir`). */
  prelude: readonly string[];
  /** The command that runs {@link SAVE_PREVIOUS} in the app's folder. */
  savePrevious: string;
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
 */
function startStep(plan: DeployPlan, edgeFiles: EdgeFiles, reach: Reach): string[] {
  return [
    "- id: start",
    "  name: Start the new version",
    "  env:",
    ...reach.env,
    `    IMAGE: ${imageOutput(plan, "image")}`,
    `    TAG: ${imageOutput(plan, "tag")}`,
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
    `    ${reach.sh} -s -- "$IMAGE" <<'REMOTE'`,
    // The services' one-time setup steps come from the catalog; no entry has any yet.
    ...remote(switchCommands(plan, initStepsFor(plan), edgeFiles)),
  ];
}

/**
 * The rollback step: runs only when starting or checking the new version failed (not for upload
 * or setup errors), and always fails the job. `localhost` is the app's hostname on the localhost
 * target, as the start script has it.
 */
function rollbackStep(
  plan: DeployPlan,
  reach: Reach,
  localhost: LocalhostSite | undefined,
): string[] {
  return [
    "- name: Roll back to the previous version",
    "  if: failure() && (steps.start.outcome == 'failure' || steps.health.outcome == 'failure')",
    "  env:",
    ...reach.env,
    `    IMAGE: ${imageOutput(plan, "image")}`,
    "  run: |",
    "    set -uo pipefail",
    ...reach.prelude,
    "    cat > \"$RUNNER_TEMP/rollback.sh\" <<'REMOTE'",
    ...remote(rollbackCommands(plan, localhost)),
    "    outcome=unchanged",
    `    if [[ "\${IMAGE:-}" =~ ${DIGEST_REF_PATTERN} ]]; then`,
    `      outcome="$(${reach.sh} -s -- "$IMAGE" < "$RUNNER_TEMP/rollback.sh")"`,
    "    fi",
    '    case "$outcome" in',
    "      restored)",
    '        echo "::error::The deploy failed; OpsCrew restored the previous version." ;;',
    "      unchanged)",
    '        echo "::error::The deploy failed before the new version took traffic; the server still runs the version it had." ;;',
    "      no-previous)",
    '        echo "::error::The deploy failed and there is no earlier version to restore (first deploy, or the same image was already running). Fix the problem and push again." ;;',
    "      *)",
    `        echo "::error::The deploy failed and OpsCrew could not restore the previous version. ${reach.stuck}" ;;`,
    "    esac",
    "    exit 1",
  ];
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
 * {@link TUNNEL_DEPLOY_SECRETS}): the upload, then the start and rollback steps over SSH. A runner
 * machine runs the same steps with the job's own SSH files ({@link sshFile}) and cloudflared
 * ({@link cloudflaredPath}).
 */
function sshDeploy(
  plan: DeployPlan,
  ctx: RuntimeContext,
  upload: Upload,
): { setup: string[]; reach: Reach } {
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
  const setup = [
    ...(tunnelHost === undefined ? [] : installCloudflaredStep(machine)),
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
    ...sshConfig,
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
    ...(upload.edgeFiles.originTls
      ? originTlsUpload(plan, `${EDGE_DIR}/tls/${plan.app.name}`, OVER_SSH)
      : []),
  ];
  return {
    setup,
    reach: {
      env: hostEnv,
      prelude: [sshOpts],
      savePrevious: OVER_SSH(`cd ${dir} && ${SAVE_PREVIOUS}`),
      login: [
        `    printf '%s\\n' "$REGISTRY_TOKEN" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" "DOCKER_CONFIG=${dockerConfig(plan)} docker login ghcr.io -u '\${GITHUB_ACTOR}' --password-stdin"`,
      ],
      sh: 'ssh "${ssh_opts[@]}" "deploy@${HOST}" sh',
      stuck: `Connect to the server and run \\\`docker compose ps\\\` in ${dir}.`,
    },
  };
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
    `      echo "::error::This runner does not set OPSCREW_LOCAL_LOCK, OpsCrew's deploy lock on this computer. Start it with \\\`opscrew runner start --env ${environmentName(plan)}\\\`, which sets it."`,
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
 * known-hosts secret: the runtime files and env files are copied into the app's folder, and the
 * same switch and rollback scripts run with the local `sh`, with the same arguments and stdin. The
 * server's runner runs as `deploy`, with the server's folders; the local runner takes this
 * computer's folders from its environment (`OPSCREW_APPS_DIR`, `OPSCREW_EDGE_DIR`, set by
 * `opscrew runner start`), which the scripts read too.
 */
function localDeploy(plan: DeployPlan, upload: Upload): { setup: string[]; reach: Reach } {
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
          `      echo "::error::This runner does not set OPSCREW_APPS_DIR and OPSCREW_EDGE_DIR, the folders of this computer's stack. Start it with \\\`opscrew runner start --env ${environmentName(plan)}\\\`, which sets them."`,
          "      exit 1",
          "    fi",
        ]
      : []),
    dir,
    '    mkdir -p "$dir"',
    `    cp -r ${upload.files.join(" ")} "$dir"/`,
    ...envFileWrites(upload.envFiles, '"$dir"', HERE),
    ...(upload.edgeFiles.originTls ? [tls, ...originTlsUpload(plan, '"$tls"', HERE)] : []),
  ];
  return {
    setup,
    reach: {
      env: [],
      prelude: local ? [...localDeployLock(plan), dir] : [dir],
      savePrevious: `cd "$dir" && ${SAVE_PREVIOUS}`,
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
 * need no connection secret.
 */
export function deploySecretNamesFor(plan: DeployPlan): string[] {
  assertServerTarget(plan.target, "server deploy secrets");
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
  return [
    ...connection,
    DEPLOY_SECRETS.appEnv,
    ...envFileServices(plan).map(serviceEnvSecret),
    ...(tunnel ? [] : [DEPLOY_SECRETS.originTls]),
    ...build,
  ];
}

/**
 * `cicd.workflowPath` (prod's `.github/workflows/opscrew-deploy.yml`, any other environment's
 * `opscrew-deploy-<env>.yml`): build → push to GHCR → deploy over SSH with rollback,
 * then the optional signing, deploy tag and image retention jobs, and the environment's image
 * labels. A promoted environment instead starts from the digest `opscrew promote` gives it, which
 * its verify job checks, and builds nothing. The deploy job's secrets, GitHub environment, runner
 * and concurrency group are the environment's own; on the server's or the local runner it deploys
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
 */
export function renderWorkflow(plan: DeployPlan, ctx: RuntimeContext): RenderedFile {
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

  const envFiles = [
    { file: "app.env", secret: DEPLOY_SECRETS.appEnv },
    ...envFileServices(plan).map((name) => ({
      file: `${name}.env`,
      secret: serviceEnvSecret(name),
    })),
  ];
  const upload: Upload = {
    env: [
      ...envFiles.map((env) => `    ${env.secret}: ${secret(plan, env.secret)}`),
      ...(edgeFiles.originTls
        ? [`    ${DEPLOY_SECRETS.originTls}: ${secret(plan, DEPLOY_SECRETS.originTls)}`]
        : []),
    ],
    envFiles,
    files: [
      `${runtimeDir(plan)}/compose.yaml`,
      ...runtimeUploads(plan),
      ...(edgeFiles.additions ? [EDGE_PROXIES[edgeProxy(plan)].additions] : []),
    ],
    edgeFiles,
  };
  const own = deploysInPlace(plan);
  const { setup, reach } = own ? localDeploy(plan, upload) : sshDeploy(plan, ctx, upload);
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
    ...setup,
    ...startStep(plan, edgeFiles, reach),
    "- id: health",
    "  name: Check that the app is healthy",
    "  env:",
    `    URL: ${healthUrl(plan, local)}`,
    "  run: |",
    // With the origin certificate a failed handshake has nothing to do with Let's Encrypt.
    ...healthScript(plan, edgeServesTls(plan, sshHostname(plan)) && !edgeFiles.originTls, local),
    ...rollbackStep(plan, reach, edgeFiles.localhost),
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
    ),
    ...imageSourceJob(plan, ctx),
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
