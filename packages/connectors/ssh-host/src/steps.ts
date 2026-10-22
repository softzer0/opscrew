// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell and Go templates, not JavaScript templates.
/**
 * Fixed shell templates for every host step. Each step has a read-only `check` (prints
 * `state=in-place|change` and the current values as `prev.<key>=<value>`), an `apply`, and a
 * `verify` that proves the change took effect. Parameters are validated here and shell-quoted by
 * `buildScript`; secrets never appear in a script, they arrive on stdin.
 */
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import { z } from "zod";
import {
  ADDONS_ROOT,
  APP_RECORDS_DIR,
  APT_LOG,
  AUTO_UPGRADES_FILE,
  appDirs,
  BACKUP_DIR,
  DEAD_MAN_DIR,
  DOCKER_DAEMON_JSON,
  DOCKER_DAEMON_JSON_PATH,
  DOCKER_PACKAGES,
  ECDSA_HOST_KEY_TYPES,
  EDGE_DIR,
  EDGE_PROJECT,
  FAIL2BAN_JAIL_PATH,
  fail2banJail,
  MIN_DOCKER_MAJOR,
  MODULI_FILTER,
  OPSCREW_DIR,
  PORTAINER_DIR,
  PORTAINER_PORT,
  PORTAINER_PROJECT,
  READY_FLAG,
  RECORD_PATH,
  RUNNERS_DIR,
  runnerDir,
  runtimeFilePath,
  SHARED_DIRS,
  SSHD_BACKUP,
  SSHD_DROP_IN,
  SSHD_HEADER,
  SSHD_MODULI,
  SSHD_MODULI_FILE,
  SYSCTL_FILE,
  sshdDropIn,
  TUNNELS_DIR,
  tunnelDir,
  tunnelProject,
  UFW_SSH_COMMENT,
  UFW_WEB_COMMENT,
  WEB_RULES,
} from "./constants";
import type { AppRecord } from "./facts";
import { canonicalIpv4Cidr } from "./parse";
import { APT_FUNCTIONS, buildScript, type ScriptParams } from "./shell";
import {
  type AccessMode,
  AccessModeSchema,
  AppNameSchema,
  ComposeTextSchema,
  DesiredRunnerSchema,
  HostnameSchema,
  type HostPlan,
  type HostStep,
  type HostStepId,
  PortainerVersionSchema,
  ProjectIdSchema,
  ServiceNameSchema,
  TunnelIdSchema,
} from "./types";
import {
  sortedNetworks,
  WEB_FILTER_BACKEND_CHECK,
  WEB_FILTER_CHAIN,
  WEB_FILTER_DROP_IN,
  WEB_FILTER_DROP_IN_TEXT,
  WEB_FILTER_FUNCTIONS,
  WEB_FILTER_SCRIPT,
  WEB_FILTER_SERVICE,
  WEB_FILTER_UNIT,
  WEB_FILTER_UNIT_TEXT,
  webFilterScript,
} from "./web-filter";

/** Steps whose change can cut SSH access; they run under the dead-man switch. */
export type GuardedStep = "sshd" | "ufw";

export interface StepScripts {
  /** Read-only: prints `state=in-place|change` and `prev.<key>=<value>` lines. */
  check: string;
  /** Changes that cannot cut access (package installs), run before the dead-man is armed. */
  preApply?: string;
  apply: string;
  /** Exits 0 when the step's end state holds. */
  verify: string;
  /** Runs after the dead-man is cancelled (package removals). */
  postApply?: string;
  /**
   * Shell lines that save the current state and write `<DEAD_MAN_DIR>/<step>.undo.sh`, with the
   * parameters they use.
   */
  deadMan?: { step: GuardedStep; capture: string; params: ScriptParams };
  /** Secret the apply script reads from stdin. */
  secret?: { name: "tunnelToken" | "portainerPassword"; required: boolean };
  /** The GitHub runner token the apply script reads from stdin, fetched when the step runs. */
  runnerToken?: "registration" | "remove";
  /** What the step does, for error messages ("installing Docker"). */
  doing: string;
  timeoutMs: number;
}

const MINUTE = 60_000;

function invalid(step: HostStep, detail: string): OpsCrewError {
  return new OpsCrewError(
    "INVALID_INPUT",
    `The host plan's "${step.id}" step has invalid parameters (${detail}).`,
    { hint: "Run opscrew provision again to make a fresh host plan." },
  );
}

function params<T extends z.ZodType>(step: HostStep, schema: T): z.infer<T> {
  const parsed = schema.safeParse(step.params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(step, `${issue?.path.join(".") || "params"}: ${issue?.message ?? "invalid"}`);
  }
  return parsed.data;
}

const PortsSchema = z.string().regex(/^\d{1,5}( \d{1,5})*$/);
const RulesSchema = z.string().regex(/^(\d{1,5}\/(tcp|udp)( \d{1,5}\/(tcp|udp))*)?$/);

/** What a step's check, apply and verify are made of, and the rest of its {@link StepScripts}. */
type StepSpec = Omit<StepScripts, "check" | "apply" | "verify"> & {
  /** The scripts' name after `# opscrew-host:` (`sshd`, `ufw.undo`, ...). */
  name: string;
  params: ScriptParams;
  /** Shell functions all three scripts use. */
  helpers?: string;
  /** Body of `verify_state`: succeeds when the step's end state holds. */
  verify: string;
  /** Check lines that print the current values as `prev.<key>=<value>`. */
  snapshot?: string;
  apply: string;
  /** What the verify script says when the end state does not hold. */
  failed: string;
};

/**
 * A step's scripts from one spec: the read-only check (the snapshot, then `state=in-place` when
 * `verify_state` holds), the apply and the verify, with the same parameters and helpers.
 */
function scripts({
  name,
  params,
  helpers = "",
  verify,
  snapshot = "",
  apply,
  failed,
  ...rest
}: StepSpec): StepScripts {
  return {
    check: buildScript(
      `${name}.check`,
      params,
      `${APT_FUNCTIONS}
${helpers}
verify_state() {
${verify}
}
${snapshot}
if verify_state >/dev/null 2>&1; then echo state=in-place; else echo state=change; fi`,
      { tolerant: true },
    ),
    apply: applyScript(name, params, helpers, apply),
    verify: buildScript(
      `${name}.verify`,
      { ...params, VERIFY_FAILED: failed },
      `${APT_FUNCTIONS}
${helpers}
verify_state() {
${verify}
}
verify_state || fail "$VERIFY_FAILED" 5`,
    ),
    ...rest,
  };
}

/**
 * A changing script. It ignores SIGHUP and SIGPIPE, so a dropped SSH session never stops it
 * half-way (apt and dpkg keep going; their output goes to a log file, not the session).
 */
function applyScript(name: string, p: ScriptParams, helpers: string, body: string) {
  return buildScript(`${name}.apply`, p, `trap '' HUP PIPE\n${APT_FUNCTIONS}\n${helpers}\n${body}`);
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

// ---------------------------------------------------------------------------------------------
// package-repair: finish an interrupted dpkg run before anything else uses apt

function packageRepairScripts(): StepScripts {
  return scripts({
    name: "package-repair",
    params: { UPDATES: "/var/lib/dpkg/updates" },
    verify: `  [ -z "$(ls -A "$UPDATES" 2>/dev/null)" ]`,
    snapshot: "echo prev.interrupted=true",
    apply: `install -d -m 0700 "$(dirname '${APT_LOG}')"
# Another apt run may still hold the lock (for example the one that was interrupted): wait for it.
i=0
# Never waits on a conffile question or reads the session's stdin.
until dpkg --force-confdef --force-confold --configure -a </dev/null >>'${APT_LOG}' 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    tail -n 5 '${APT_LOG}' >&2 || true
    fail 'dpkg --configure -a did not finish; look at ${APT_LOG} on the server.'
  fi
  sleep 5
done`,
    failed: "dpkg still reports an interrupted run.",
    doing: "finishing the interrupted package installation",
    timeoutMs: 10 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// docker

const DockerParams = z.object({
  distro: z.enum(["ubuntu", "debian"]),
  action: z.enum(["install", "upgrade", "plugins", "start"]),
});

/** Packages each Docker action installs: plugins and start never touch the running engine. */
const DOCKER_ACTION_PACKAGES = {
  install: DOCKER_PACKAGES,
  upgrade: DOCKER_PACKAGES,
  plugins: "docker-buildx-plugin docker-compose-plugin",
  start: "",
} as const;

function dockerScripts(step: HostStep): StepScripts {
  const p = params(step, DockerParams);
  return scripts({
    name: "docker",
    params: {
      DISTRO: p.distro,
      MIN_MAJOR: MIN_DOCKER_MAJOR,
      PACKAGES: DOCKER_ACTION_PACKAGES[p.action],
    },
    helpers: `docker_major() {
  v=$(dpkg-query -W -f='\${Version}' docker-ce 2>/dev/null) || return 1
  printf '%s' "$v" | sed -e 's/^[0-9]*://' -e 's/^\\([0-9]*\\).*/\\1/'
}`,
    verify: `  major=$(docker_major) || return 1
  [ -n "$major" ] && [ "$major" -ge "$MIN_MAJOR" ] || return 1
  is_installed docker-compose-plugin || return 1
  is_installed docker-buildx-plugin || return 1
  systemctl is-active --quiet docker || return 1
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || return 1`,
    snapshot: `v=$(dpkg-query -W -f='\${Version}' docker-ce 2>/dev/null) || v=''
echo "prev.engine=\${v:-absent}"
if grep -qs 'download.docker.com' /etc/apt/sources.list /etc/apt/sources.list.d/*; then echo prev.repository=present; else echo prev.repository=absent; fi`,
    apply: `. /etc/os-release
[ "\${ID:-}" = "$DISTRO" ] || fail "This server no longer runs $DISTRO; inspect it again."
codename="\${UBUNTU_CODENAME:-\${VERSION_CODENAME:-}}"
[ -n "$codename" ] || fail 'OpsCrew could not read the release codename from /etc/os-release.'
SOURCES=/etc/apt/sources.list.d/docker.sources
KEY=/etc/apt/keyrings/docker.asc
KEY_OLD=/etc/apt/keyrings/.docker.asc.opscrew-old
added_sources=no
added_key=no
# A failed install never leaves apt pointing at a repository OpsCrew just added, and a key that
# was there before comes back as it was.
undo_repo() {
  if [ "$added_sources" = yes ]; then rm -f "$SOURCES"; fi
  if [ "$added_key" = yes ]; then rm -f "$KEY"
  elif [ -e "$KEY_OLD" ]; then mv -f "$KEY_OLD" "$KEY"; fi
  if [ "$added_sources" = yes ]; then apt_get update >/dev/null 2>&1 || true; fi
}
if [ -n "$PACKAGES" ]; then
  if ! grep -qs 'download.docker.com' /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    # Docker's apt repository, as Docker documents it (never the convenience script).
    apt_get update || fail 'apt-get update failed before OpsCrew changed anything; see ${APT_LOG} on the server.'
    apt_get install ca-certificates curl || fail 'Installing ca-certificates and curl failed; see ${APT_LOG} on the server.'
    install -m 0755 -d /etc/apt/keyrings
    # Downloaded beside the key and renamed only once complete: an existing key is never cut short.
    tmpkey=$(mktemp /etc/apt/keyrings/.docker.XXXXXX)
    if ! curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" -o "$tmpkey"; then
      rm -f "$tmpkey"
      fail "OpsCrew could not download Docker's signing key from download.docker.com; nothing was installed."
    fi
    chmod a+r "$tmpkey"
    if [ -e "$KEY" ]; then cp -p "$KEY" "$KEY_OLD"; else added_key=yes; fi
    mv -f "$tmpkey" "$KEY"
    arch=$(dpkg --print-architecture)
    added_sources=yes
    printf '%s\\n' 'Types: deb' "URIs: https://download.docker.com/linux/$DISTRO" "Suites: $codename" 'Components: stable' "Architectures: $arch" "Signed-By: $KEY" > "$SOURCES"
    chmod 0644 "$SOURCES"
  fi
  if ! apt_get update; then
    undo_repo
    fail "apt-get update failed with Docker's repository, so OpsCrew removed what it added; see ${APT_LOG} on the server."
  fi
  # shellcheck disable=SC2086 # PACKAGES is a fixed, space-separated list.
  if ! apt_get install $PACKAGES; then
    undo_repo
    fail "Installing Docker failed, so OpsCrew removed the repository it added; see ${APT_LOG} on the server."
  fi
  rm -f "$KEY_OLD"
fi
systemctl enable --now docker
major=$(docker_major) || major=0
[ "\${major:-0}" -ge "$MIN_MAJOR" ] || fail "Docker's repository did not offer Docker Engine $MIN_MAJOR or newer for this release."`,
    failed: `Docker Engine ${MIN_DOCKER_MAJOR} or newer with the Compose plugin is not running after the install.`,
    doing: "installing Docker Engine",
    timeoutMs: 30 * MINUTE,
  });
}

/** Docker is never removed by OpsCrew: other software may use it. */
function dockerUndoScripts(): StepScripts {
  const noop = buildScript("docker.keep", {}, "exit 0");
  return {
    check: buildScript("docker.keep.check", {}, "echo state=in-place", { tolerant: true }),
    apply: noop,
    verify: noop,
    doing: "keeping Docker",
    timeoutMs: MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// deploy-user

/** One public key line (`type base64 [comment]`). */
const PublicKeySchema = z.string().regex(/^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}( [^\r\n\0]{0,200})?$/);

const DeployKeysParams = z.object({
  user: z.literal("deploy"),
  /** The deploy keys of the apps on the server, one per line: exactly what authorized_keys holds. */
  keys: z
    .string()
    .refine((keys) => keys.split("\n").every((key) => PublicKeySchema.safeParse(key).success), {
      message: "must be public key lines",
    }),
});

/**
 * `deploy-key` (setup and teardown): the deploy user's authorized_keys holds exactly the deploy
 * keys of the apps on the server, so a removed app's key or an old key stops working.
 */
function deployKeyScripts(step: HostStep): StepScripts {
  const p = params(step, DeployKeysParams);
  const keys = `${p.keys}\n`;
  return scripts({
    name: "deploy-key",
    params: { USER_NAME: p.user, KEYS_B64: base64(keys), KEYS_SHA256: sha256Hex(keys) },
    helpers: `user_home() { getent passwd "$USER_NAME" | cut -d: -f6; }`,
    verify: `  getent passwd "$USER_NAME" >/dev/null 2>&1 || return 1
  home=$(user_home)
  [ -f "$home/.ssh/authorized_keys" ] && [ ! -L "$home/.ssh/authorized_keys" ] || return 1
  [ "$(sha256sum "$home/.ssh/authorized_keys" | cut -d ' ' -f 1)" = "$KEYS_SHA256" ]`,
    apply: `getent passwd "$USER_NAME" >/dev/null 2>&1 || fail "The $USER_NAME user is missing; OpsCrew creates it first."
home=$(user_home)
if [ -z "$home" ] || [ "$home" = / ]; then fail "The $USER_NAME user has no home directory."; fi
if [ -L "$home/.ssh" ]; then fail "$home/.ssh is a symbolic link; OpsCrew does not follow it."; fi
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$home/.ssh"
keys="$home/.ssh/authorized_keys"
if [ -L "$keys" ]; then fail "$keys is a symbolic link; OpsCrew does not follow it."; fi
# OpsCrew created this user: its keys file holds exactly the deploy keys of the apps on the
# server, so an old deploy key, or the key of an app that was removed, stops working.
printf '%s' "$KEYS_B64" | base64 -d | write_file "$keys" 0600 "$USER_NAME:$USER_NAME"`,
    failed: "The deploy user does not have the planned deploy keys after the change.",
    doing: "writing the deploy user's keys",
    timeoutMs: 2 * MINUTE,
  });
}

function deployUserScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    return scripts({
      name: "deploy-user.undo",
      params: { USER_NAME: "deploy" },
      verify: `  ! getent passwd "$USER_NAME" >/dev/null 2>&1`,
      snapshot: `if getent passwd "$USER_NAME" >/dev/null 2>&1; then echo prev.existed=true; else echo prev.existed=false; fi`,
      apply: `if getent passwd "$USER_NAME" >/dev/null 2>&1; then
  pkill -u "$USER_NAME" >/dev/null 2>&1 || true
  sleep 1
  userdel -r "$USER_NAME" >/dev/null 2>&1 || userdel "$USER_NAME" >/dev/null 2>&1 || true
fi
if getent passwd "$USER_NAME" >/dev/null 2>&1; then fail "OpsCrew could not remove the $USER_NAME user; it may still be logged in."; fi
if getent group "$USER_NAME" >/dev/null 2>&1 && [ -z "$(getent group "$USER_NAME" | cut -d: -f4)" ]; then groupdel "$USER_NAME" >/dev/null 2>&1 || true; fi`,
      failed: "The deploy user still exists.",
      doing: "removing the deploy user",
      timeoutMs: 2 * MINUTE,
    });
  }
  const p = params(step, z.object({ user: z.literal("deploy") }));
  return scripts({
    name: "deploy-user",
    params: { USER_NAME: p.user },
    verify: `  getent passwd "$USER_NAME" >/dev/null 2>&1 || return 1
  id -nG "$USER_NAME" | tr ' ' '\\n' | grep -qx docker || return 1`,
    snapshot: `if getent passwd "$USER_NAME" >/dev/null 2>&1; then echo prev.existed=true; else echo prev.existed=false; fi
if id -nG "$USER_NAME" 2>/dev/null | tr ' ' '\\n' | grep -qx docker; then echo prev.dockerGroup=true; else echo prev.dockerGroup=false; fi`,
    apply: `getent group docker >/dev/null 2>&1 || fail 'The docker group is missing; Docker must be installed first.'
if ! getent passwd "$USER_NAME" >/dev/null 2>&1; then
  useradd --create-home --user-group --shell /bin/bash "$USER_NAME"
  # "*" means no password login at all, without marking the account locked for key logins.
  usermod -p '*' "$USER_NAME"
fi
usermod -aG docker "$USER_NAME"`,
    failed: "The deploy user does not have Docker access after the change.",
    doing: "creating the deploy user",
    timeoutMs: 2 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// sshd

const SshdParams = z.object({
  permitRootLogin: z.enum(["no", "prohibit-password"]),
  disablePasswords: z.boolean(),
  kbdInteractiveOff: z.boolean(),
  moduliFile: z.boolean(),
  ecdsaHostKey: z.enum(ECDSA_HOST_KEY_TYPES).optional(),
});

const SSHD_RELOAD =
  "systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service";

const SSHD_UNDO_TIMER = "! systemctl is-active --quiet opscrew-undo-sshd.timer";

/**
 * The first lines of every undo script the dead-man switch runs: it takes turns with a cancel
 * (whoever holds `<step>.lock` first decides), does nothing once cancelled, and marks itself as
 * fired before it changes anything (so a cancel racing it knows).
 */
function undoPreamble(step: GuardedStep, what: string): string {
  return `#!/bin/sh
# Written by OpsCrew: ${what}
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
# Takes turns with a cancel: whoever holds the lock first decides; a cancelled undo does nothing.
exec 9>${DEAD_MAN_DIR}/${step}.lock
flock 9
if [ -e ${DEAD_MAN_DIR}/${step}.cancelled ]; then exit 0; fi
touch ${DEAD_MAN_DIR}/${step}.fired`;
}

/**
 * Dead-man capture shared by sshd setup and undo: restore the drop-in and OpsCrew's moduli file
 * as they are right now, and bring a stopped or failed ssh unit back (reset-failed, then
 * reload-or-restart; Debian/Ubuntu call it ssh.service).
 */
const SSHD_CAPTURE = `if [ -f ${SSHD_DROP_IN} ]; then cp -p ${SSHD_DROP_IN} ${DEAD_MAN_DIR}/sshd.prev; else rm -f ${DEAD_MAN_DIR}/sshd.prev; fi
if [ -f ${SSHD_MODULI_FILE} ]; then cp -p ${SSHD_MODULI_FILE} ${DEAD_MAN_DIR}/moduli.prev; else rm -f ${DEAD_MAN_DIR}/moduli.prev; fi
cat > ${DEAD_MAN_DIR}/sshd.undo.sh <<'OPSCREW_UNDO'
${undoPreamble("sshd", "puts the previous SSH settings back.")}
if [ -f ${DEAD_MAN_DIR}/sshd.prev ]; then cp -p ${DEAD_MAN_DIR}/sshd.prev ${SSHD_DROP_IN}; else rm -f ${SSHD_DROP_IN}; fi
if [ -f ${DEAD_MAN_DIR}/moduli.prev ]; then cp -p ${DEAD_MAN_DIR}/moduli.prev ${SSHD_MODULI_FILE}; else rm -f ${SSHD_MODULI_FILE}; fi
systemctl reset-failed ssh.service sshd.service >/dev/null 2>&1 || true
systemctl reload-or-restart ssh.service >/dev/null 2>&1 || systemctl reload-or-restart sshd.service >/dev/null 2>&1 || true
OPSCREW_UNDO`;

function sshdScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    return scripts({
      name: "sshd.undo",
      params: {
        DROPIN: SSHD_DROP_IN,
        BACKUP: SSHD_BACKUP,
        HEADER: SSHD_HEADER,
        MODULI_FILE: SSHD_MODULI_FILE,
      },
      verify: `  if [ -f "$BACKUP" ]; then cmp -s "$BACKUP" "$DROPIN" || return 1
  elif [ -f "$DROPIN" ]; then return 1; fi
  [ ! -e "$MODULI_FILE" ] || return 1
  ${SSHD_UNDO_TIMER}`,
      snapshot: `if [ -f "$DROPIN" ]; then echo prev.dropIn=present; else echo prev.dropIn=absent; fi`,
      apply: `if [ -f "$BACKUP" ]; then cp -p "$BACKUP" "$DROPIN"; else rm -f "$DROPIN"; fi
[ -d /run/sshd ] || install -d -m 0755 /run/sshd
if ! sshd -t >/dev/null 2>&1; then
  sh ${DEAD_MAN_DIR}/sshd.undo.sh >/dev/null 2>&1 || true
  fail 'The previous SSH settings did not pass sshd -t, so OpsCrew kept its own.' 4
fi
rm -f "$MODULI_FILE"
${SSHD_RELOAD}`,
      failed: "The previous SSH settings are not back.",
      deadMan: { step: "sshd", capture: SSHD_CAPTURE, params: {} },
      doing: "restoring the previous SSH settings",
      timeoutMs: 2 * MINUTE,
    });
  }
  const p = params(step, SshdParams);
  const dropIn = sshdDropIn(p);
  return scripts({
    name: "sshd",
    params: {
      DROPIN: SSHD_DROP_IN,
      BACKUP: SSHD_BACKUP,
      HEADER: SSHD_HEADER,
      ROOT_LOGIN: p.permitRootLogin,
      PASSWORDS_OFF: p.disablePasswords,
      KBD_OFF: p.kbdInteractiveOff,
      DROPIN_B64: base64(dropIn),
      DROPIN_SHA256: sha256Hex(dropIn),
      MODULI: SSHD_MODULI,
      MODULI_FILE: SSHD_MODULI_FILE,
      MODULI_ON: p.moduliFile,
    },
    helpers: `config_ok() {
  eff=$(sshd -T 2>/dev/null) || return 1
  alt=$ROOT_LOGIN
  if [ "$ROOT_LOGIN" = prohibit-password ]; then alt=without-password; fi
  printf '%s\\n' "$eff" | grep -Eqx "permitrootlogin ($ROOT_LOGIN|$alt)" || return 1
  if [ "$PASSWORDS_OFF" = true ]; then printf '%s\\n' "$eff" | grep -qx 'passwordauthentication no' || return 1; fi
  if [ "$KBD_OFF" = true ]; then printf '%s\\n' "$eff" | grep -Eqx '(kbdinteractiveauthentication|challengeresponseauthentication) no' || return 1; fi
  return 0
}
dropin_ok() { [ -f "$DROPIN" ] && [ "$(sha256sum "$DROPIN" | cut -d ' ' -f 1)" = "$DROPIN_SHA256" ]; }
moduli_ok() {
  [ "$MODULI_ON" = true ] || return 0
  [ -f "$MODULI_FILE" ] && [ -z "$(awk '!(${MODULI_FILTER})' "$MODULI_FILE")" ]
}`,
    verify: `  config_ok || return 1
  dropin_ok || return 1
  moduli_ok || return 1
  ${SSHD_UNDO_TIMER}`,
    snapshot: `if [ -f "$DROPIN" ]; then echo prev.dropIn=present; else echo prev.dropIn=absent; fi
eff=$(sshd -T 2>/dev/null) || eff=''
echo "prev.permitRootLogin=$(printf '%s\\n' "$eff" | sed -n 's/^permitrootlogin //p' | head -n 1)"
echo "prev.passwordAuthentication=$(printf '%s\\n' "$eff" | sed -n 's/^passwordauthentication //p' | head -n 1)"`,
    apply: `install -d -m 0755 /etc/ssh/sshd_config.d
install -d -m 0700 ${OPSCREW_DIR} ${BACKUP_DIR}
# Keep the file that was there before OpsCrew, once, for undo.
if [ -f "$DROPIN" ] && [ ! -e "$BACKUP" ] && ! head -n 1 "$DROPIN" | grep -qxF -- "$HEADER"; then cp -p "$DROPIN" "$BACKUP"; fi
# The Diffie-Hellman groups of 3072 bits and more, in a copy that sshd reads through ModuliFile.
if [ "$MODULI_ON" = true ]; then
  moduli=$(awk '${MODULI_FILTER}' "$MODULI")
  printf '%s\\n' "$moduli" | write_file "$MODULI_FILE" 0644
fi
printf '%s' "$DROPIN_B64" | base64 -d | write_file "$DROPIN" 0644
[ -d /run/sshd ] || install -d -m 0755 /run/sshd
if ! sshd -t >/dev/null 2>&1; then
  sh ${DEAD_MAN_DIR}/sshd.undo.sh >/dev/null 2>&1 || true
  fail 'The new SSH settings did not pass sshd -t, so OpsCrew put the previous ones back.' 4
fi
if ! config_ok; then
  sh ${DEAD_MAN_DIR}/sshd.undo.sh >/dev/null 2>&1 || true
  fail 'Another SSH setting takes precedence over the file OpsCrew writes (a file in /etc/ssh/sshd_config.d that is read first, or a Match block), so OpsCrew put the previous settings back.' 4
fi
${SSHD_RELOAD}`,
    failed: "The SSH settings are not in effect.",
    deadMan: { step: "sshd", capture: SSHD_CAPTURE, params: {} },
    doing: "changing the SSH settings",
    timeoutMs: 2 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// ufw

const PortsOrEmptySchema = z.string().regex(/^(\d{1,5}( \d{1,5})*)?$/);
const PolicySchema = z.enum(["", "allow", "deny", "reject"]);

const UfwParams = z.object({
  /** Every port SSH answers on (for the plan's text). */
  sshPorts: PortsSchema,
  /** SSH ports no existing allow/limit rule covers yet: OpsCrew adds a rule for each. */
  sshRulePorts: PortsOrEmptySchema,
  /** Web rules (`80/tcp 443/tcp 443/udp`) no existing open rule covers yet. */
  webRules: RulesSchema,
  web: z.boolean(),
  enable: z.boolean(),
  install: z.boolean(),
  /** ufw is on with default incoming "allow": set it to deny (after the SSH rule). */
  denyIncoming: z.literal(true).optional(),
});

const UfwUndoParams = z.object({
  removeRules: RulesSchema,
  disable: z.boolean(),
  removePackage: z.boolean(),
  defaultIncoming: PolicySchema,
  defaultOutgoing: PolicySchema,
  defaultRouted: PolicySchema,
});

const UFW_HELPERS = `ufw_active() { ufw status 2>/dev/null | grep -q '^Status: active'; }
ufw_added() { ufw show added 2>/dev/null || true; }
has_rule() { printf '%s\\n' "$ADDED" | grep -Eq "^ufw allow $1( comment .*)?\\$"; }
has_own_rule() { printf '%s\\n' "$ADDED" | grep -qxF "ufw allow $1 comment '$2'"; }
# The default policy ufw keeps in /etc/default/ufw, as a ufw word (allow, deny, reject).
ufw_policy() {
  sed -n "s/^DEFAULT_$1_POLICY=\\"\\{0,1\\}\\([A-Z]*\\)\\"\\{0,1\\}\\$/\\1/p" /etc/default/ufw 2>/dev/null | head -n 1 |
    sed -e 's/^ACCEPT$/allow/' -e 's/^DROP$/deny/' -e 's/^REJECT$/reject/'
}
# Lines for an undo script that put today's default policies back.
policy_lines() {
  for pair in INPUT:incoming OUTPUT:outgoing FORWARD:routed; do
    policy=$(ufw_policy "\${pair%%:*}")
    case "$policy" in allow|deny|reject) echo "ufw default $policy \${pair#*:} >/dev/null 2>&1 || true" ;; esac
  done
}`;

const UFW_UNDO_TIMER = "! systemctl is-active --quiet opscrew-undo-ufw.timer";

function ufwScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    const p = params(step, UfwUndoParams);
    const sp = {
      REMOVE_RULES: p.removeRules,
      DISABLE: p.disable,
      REMOVE_PACKAGE: p.removePackage,
      DEFAULT_INCOMING: p.defaultIncoming,
      DEFAULT_OUTGOING: p.defaultOutgoing,
      DEFAULT_ROUTED: p.defaultRouted,
    };
    const capture = `ADDED=$(ufw_added)
was_active=no
if ufw_active; then was_active=yes; fi
{
  cat <<'OPSCREW_UNDO'
${undoPreamble("ufw", "puts back the firewall rules OpsCrew was removing.")}
OPSCREW_UNDO
  policy_lines
  for r in $REMOVE_RULES; do if has_rule "$r"; then echo "ufw allow $r >/dev/null 2>&1 || true"; fi; done
  if [ "$was_active" = yes ]; then echo 'ufw --force enable >/dev/null 2>&1 || true'; fi
} > ${DEAD_MAN_DIR}/ufw.undo.sh`;
    return scripts({
      name: "ufw.undo",
      params: sp,
      helpers: UFW_HELPERS,
      verify: `  if ! command -v ufw >/dev/null 2>&1; then return 0; fi
  ADDED=$(ufw_added)
  for r in $REMOVE_RULES; do if has_rule "$r"; then return 1; fi; done
  if [ "$DISABLE" = true ] && ufw_active; then return 1; fi
  if [ -n "$DEFAULT_INCOMING" ] && [ "$(ufw_policy INPUT)" != "$DEFAULT_INCOMING" ]; then return 1; fi
  if [ -n "$DEFAULT_OUTGOING" ] && [ "$(ufw_policy OUTPUT)" != "$DEFAULT_OUTGOING" ]; then return 1; fi
  if [ -n "$DEFAULT_ROUTED" ] && [ "$(ufw_policy FORWARD)" != "$DEFAULT_ROUTED" ]; then return 1; fi
  ${UFW_UNDO_TIMER}`,
      snapshot: "if ufw_active; then echo prev.active=true; else echo prev.active=false; fi",
      apply: `command -v ufw >/dev/null 2>&1 || exit 0
# The default policies OpsCrew set go back to what they were first, so a default of "allow" is
# back before OpsCrew's SSH rule goes (SSH is never closed in between); ufw goes off last.
if [ -n "$DEFAULT_INCOMING" ]; then ufw default "$DEFAULT_INCOMING" incoming >/dev/null; fi
if [ -n "$DEFAULT_OUTGOING" ]; then ufw default "$DEFAULT_OUTGOING" outgoing >/dev/null; fi
if [ -n "$DEFAULT_ROUTED" ]; then ufw default "$DEFAULT_ROUTED" routed >/dev/null; fi
for r in $REMOVE_RULES; do ufw --force delete allow "$r" >/dev/null 2>&1 || true; done
if [ "$DISABLE" = true ]; then ufw --force disable >/dev/null; fi`,
      failed: "OpsCrew's firewall rules are still there.",
      postApply: p.removePackage
        ? applyScript(
            "ufw.undo-package",
            {},
            "",
            "if is_installed ufw; then apt_get remove ufw; fi",
          )
        : undefined,
      deadMan: { step: "ufw", capture, params: sp },
      doing: "removing OpsCrew's firewall rules",
      timeoutMs: 5 * MINUTE,
    });
  }
  const p = params(step, UfwParams);
  const sp = {
    SSH_PORTS: p.sshRulePorts,
    WEB_ADD: p.webRules,
    WEB: p.web,
    ENABLE: p.enable,
    DENY_INCOMING: p.denyIncoming === true,
    WEB_RULES: WEB_RULES.join(" "),
    SSH_COMMENT: UFW_SSH_COMMENT,
    WEB_COMMENT: UFW_WEB_COMMENT,
  };
  // The undo the dead-man runs: delete the rules this change adds, put the default policies back
  // and turn ufw off if it was off.
  const capture = `ADDED=$(ufw_added)
was_active=no
if ufw_active; then was_active=yes; fi
{
  cat <<'OPSCREW_UNDO'
${undoPreamble("ufw", "puts the previous firewall state back.")}
OPSCREW_UNDO
  if [ "$was_active" = no ]; then echo 'ufw --force disable >/dev/null 2>&1 || true'; fi
  policy_lines
  for port in $SSH_PORTS; do if ! has_rule "$port/tcp"; then echo "ufw --force delete allow $port/tcp >/dev/null 2>&1 || true"; fi; done
  for r in $WEB_ADD; do if ! has_rule "$r"; then echo "ufw --force delete allow $r >/dev/null 2>&1 || true"; fi; done
  if [ "$WEB" != true ]; then
    for r in $WEB_RULES; do if has_own_rule "$r" "$WEB_COMMENT"; then echo "ufw allow $r comment '$WEB_COMMENT' >/dev/null 2>&1 || true"; fi; done
  fi
} > ${DEAD_MAN_DIR}/ufw.undo.sh`;
  return scripts({
    name: "ufw",
    params: sp,
    helpers: UFW_HELPERS,
    // SSH_PORTS and WEB_ADD hold only what no existing rule covers (the plan worked that out from
    // the rules on the server, including source-limited and "limit" rules).
    verify: `  command -v ufw >/dev/null 2>&1 || return 1
  ufw_active || return 1
  ADDED=$(ufw_added)
  for port in $SSH_PORTS; do has_rule "$port/tcp" || return 1; done
  for r in $WEB_ADD; do has_rule "$r" || return 1; done
  if [ "$WEB" != true ]; then
    for r in $WEB_RULES; do if has_own_rule "$r" "$WEB_COMMENT"; then return 1; fi; done
  fi
  if [ "$DENY_INCOMING" = true ]; then
    case "$(ufw_policy INPUT)" in deny|reject) ;; *) return 1 ;; esac
  fi
  ${UFW_UNDO_TIMER}`,
    snapshot: `if command -v ufw >/dev/null 2>&1; then echo prev.installed=true; else echo prev.installed=false; fi
if ufw_active; then echo prev.active=true; else echo prev.active=false; fi
echo "prev.rules=$(ufw_added | sed -n -e "s/^ufw //" -e "s/ comment '.*'\\$//" -e '/^[a-z]/p' | tr '\\n' ',' | sed 's/,$//')"
echo "prev.defaultIncoming=$(ufw_policy INPUT)"
echo "prev.defaultOutgoing=$(ufw_policy OUTPUT)"
echo "prev.defaultRouted=$(ufw_policy FORWARD)"`,
    preApply: p.install
      ? applyScript(
          "ufw.install",
          {},
          "",
          "if ! command -v ufw >/dev/null 2>&1; then apt_get update; apt_get install ufw; fi",
        )
      : undefined,
    apply: `command -v ufw >/dev/null 2>&1 || fail 'ufw is not installed.'
ADDED=$(ufw_added)
# The SSH rule for every port sshd listens on comes first, before anything else changes.
for port in $SSH_PORTS; do
  if ! has_rule "$port/tcp"; then ufw allow "$port/tcp" comment "$SSH_COMMENT" >/dev/null; fi
done
for r in $WEB_ADD; do
  if ! has_rule "$r"; then ufw allow "$r" comment "$WEB_COMMENT" >/dev/null; fi
done
if [ "$WEB" != true ]; then
  # Tunnel mode: remove web rules OpsCrew added earlier, never the server's own.
  for r in $WEB_RULES; do
    if has_own_rule "$r" "$WEB_COMMENT"; then ufw --force delete allow "$r" >/dev/null; fi
  done
fi
# ufw was on but let everything in: deny incoming by default, now that the SSH rule is there.
if [ "$DENY_INCOMING" = true ]; then
  case "$(ufw_policy INPUT)" in deny|reject) ;; *) ufw default deny incoming >/dev/null ;; esac
fi
if [ "$ENABLE" = true ] && ! ufw_active; then
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable >/dev/null
fi
ufw_active || fail 'ufw did not turn on.'`,
    failed: "The firewall rules are not in effect.",
    deadMan: { step: "ufw", capture, params: sp },
    doing: "setting up the ufw firewall",
    timeoutMs: 5 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// web-filter: only Cloudflare reaches the web ports Docker publishes (see web-filter.ts)

/** Space-separated IPv4 networks as {@link canonicalIpv4Cidr} gives them, sorted, without duplicates. */
const Ipv4NetworksSchema = z
  .string()
  .regex(/^[0-9./]{7,18}( [0-9./]{7,18})*$/)
  .refine(
    (value) => {
      const list = value.split(" ");
      return (
        list.every((net) => canonicalIpv4Cidr(net) === net) &&
        sortedNetworks(list).join(" ") === value
      );
    },
    { message: "must be sorted IPv4 networks without duplicates" },
  );

const WebFilterParams = z.union([
  z.strictObject({ remove: z.literal(true) }),
  z.strictObject({ ipv4: Ipv4NetworksSchema }),
]);

const WEB_FILTER_HELPERS = `${WEB_FILTER_FUNCTIONS}
file_is() { [ -f "$1" ] && [ "$(sha256sum "$1" | cut -d ' ' -f 1)" = "$2" ]; }
# Removes OpsCrew's jumps from DOCKER-USER and its chain.
remove_rules() {
  command -v iptables >/dev/null 2>&1 || return 0
  for spec in 'tcp 80' 'tcp 443' 'udp 443'; do
    proto=\${spec% *}
    port=\${spec#* }
    while iptables -w -C DOCKER-USER -p "$proto" -m conntrack --ctstate DNAT --ctorigdstport "$port" --ctdir ORIGINAL -j "$CHAIN" 2>/dev/null; do
      iptables -w -D DOCKER-USER -p "$proto" -m conntrack --ctstate DNAT --ctorigdstport "$port" --ctdir ORIGINAL -j "$CHAIN"
    done
  done
  if iptables -w -n -L "$CHAIN" >/dev/null 2>&1; then
    iptables -w -F "$CHAIN"
    iptables -w -X "$CHAIN" || fail "Another rule still jumps to OpsCrew's chain $CHAIN; remove that rule, then run the command again."
  fi
}`;

function webFilterScripts(step: HostStep): StepScripts {
  const p = params(step, WebFilterParams);
  const files = {
    SCRIPT: WEB_FILTER_SCRIPT,
    UNIT_FILE: WEB_FILTER_UNIT,
    DROP_IN: WEB_FILTER_DROP_IN,
    SERVICE: WEB_FILTER_SERVICE,
    CHAIN: WEB_FILTER_CHAIN,
  };
  if ("remove" in p) {
    return scripts({
      name: "web-filter.remove",
      params: files,
      helpers: WEB_FILTER_HELPERS,
      verify: `  [ ! -e "$SCRIPT" ] && [ ! -e "$UNIT_FILE" ] && [ ! -e "$DROP_IN" ] || return 1
  if command -v iptables >/dev/null 2>&1 && iptables -w -n -L "$CHAIN" >/dev/null 2>&1; then
    return 1
  fi`,
      // Docker first stops requiring the filter (it keeps running), then the rules and files go.
      apply: `rm -f "$DROP_IN"
systemctl daemon-reload
systemctl disable "$SERVICE" >/dev/null 2>&1 || true
systemctl stop "$SERVICE" >/dev/null 2>&1 || true
remove_rules
rm -f "$UNIT_FILE" "$SCRIPT"
systemctl daemon-reload`,
      failed: "OpsCrew's web filter is still on the server.",
      doing: "removing OpsCrew's web filter",
      timeoutMs: 2 * MINUTE,
    });
  }
  const script = webFilterScript({ ipv4: p.ipv4.split(" ") });
  return scripts({
    name: "web-filter",
    params: {
      ...files,
      SCRIPT_B64: base64(script),
      UNIT_B64: base64(WEB_FILTER_UNIT_TEXT),
      DROPIN_B64: base64(WEB_FILTER_DROP_IN_TEXT),
      SCRIPT_SHA256: sha256Hex(script),
      UNIT_SHA256: sha256Hex(WEB_FILTER_UNIT_TEXT),
      DROPIN_SHA256: sha256Hex(WEB_FILTER_DROP_IN_TEXT),
      IPV4: p.ipv4,
    },
    helpers: WEB_FILTER_HELPERS,
    verify: `  file_is "$SCRIPT" "$SCRIPT_SHA256" || return 1
  file_is "$UNIT_FILE" "$UNIT_SHA256" || return 1
  file_is "$DROP_IN" "$DROPIN_SHA256" || return 1
  [ "$(systemctl is-enabled "$SERVICE" 2>/dev/null)" = enabled ] || return 1
  systemctl is-active --quiet "$SERVICE" || return 1
  chain_ok "$IPV4" || return 1
  leading_ok || return 1`,
    snapshot: `if [ -e "$SCRIPT" ]; then echo prev.installed=true; else echo prev.installed=false; fi`,
    // The script installs the rules right away (an atomic change of OpsCrew's chain; Docker keeps
    // running). Only once it worked does Docker start to require the unit, so a failure here never
    // leaves a Docker that cannot start.
    apply: `${WEB_FILTER_BACKEND_CHECK}
if systemctl is-active --quiet docker && ! iptables -w -n -L DOCKER-USER >/dev/null 2>&1; then
  fail "Docker is running but has no DOCKER-USER chain in iptables, so OpsCrew's web filter cannot work. Nothing was changed."
fi
install -d -m 0755 "$(dirname "$SCRIPT")" "$(dirname "$UNIT_FILE")"
printf '%s' "$SCRIPT_B64" | base64 -d | write_file "$SCRIPT" 0755
printf '%s' "$UNIT_B64" | base64 -d | write_file "$UNIT_FILE" 0644
"$SCRIPT" || fail "OpsCrew could not install its web filter (see the message above); Docker was not changed."
install -d -m 0755 "$(dirname "$DROP_IN")"
printf '%s' "$DROPIN_B64" | base64 -d | write_file "$DROP_IN" 0644
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
# Starting the unit runs the script once more (no change); Docker is not restarted.
systemctl start "$SERVICE"`,
    failed: "OpsCrew's web filter is not in effect.",
    doing: "setting up the web filter for Cloudflare's addresses",
    timeoutMs: 2 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// unattended-upgrades

/** Undo of a package step: remove the package OpsCrew installed, or turn off the service it turned on. */
const PackageUndoParams = z.object({ removePackage: z.boolean(), disableService: z.boolean() });

function upgradesScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    const p = params(step, PackageUndoParams);
    return scripts({
      name: "unattended-upgrades.undo",
      params: {
        CONF: AUTO_UPGRADES_FILE,
        REMOVE_PACKAGE: p.removePackage,
        DISABLE_SERVICE: p.disableService,
      },
      verify: `  [ ! -e "$CONF" ] || return 1
  if [ "$REMOVE_PACKAGE" = true ]; then ! is_installed unattended-upgrades || return 1; fi
  if [ "$DISABLE_SERVICE" = true ]; then [ "$(systemctl is-enabled unattended-upgrades 2>/dev/null)" != enabled ] || return 1; fi`,
      apply: `rm -f "$CONF"
if [ "$DISABLE_SERVICE" = true ]; then systemctl disable --now unattended-upgrades.service >/dev/null 2>&1 || true; fi
if [ "$REMOVE_PACKAGE" = true ] && is_installed unattended-upgrades; then apt_get remove unattended-upgrades; fi`,
      failed: "OpsCrew's automatic-update settings are still there.",
      doing: "removing OpsCrew's automatic-update settings",
      timeoutMs: 10 * MINUTE,
    });
  }
  return scripts({
    name: "unattended-upgrades",
    params: { CONF: AUTO_UPGRADES_FILE },
    verify: `  is_installed unattended-upgrades || return 1
  dump=$(apt-config dump 2>/dev/null) || return 1
  printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Update-Package-Lists "1";' || return 1
  printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Unattended-Upgrade "1";' || return 1
  [ "$(systemctl is-enabled unattended-upgrades 2>/dev/null)" = enabled ] || return 1`,
    snapshot: `if is_installed unattended-upgrades; then echo prev.installed=true; else echo prev.installed=false; fi
if [ -e "$CONF" ]; then echo prev.file=present; else echo prev.file=absent; fi
if [ "$(systemctl is-enabled unattended-upgrades 2>/dev/null)" = enabled ]; then echo prev.serviceEnabled=true; else echo prev.serviceEnabled=false; fi`,
    apply: `if ! is_installed unattended-upgrades; then apt_get update; apt_get install unattended-upgrades; fi
dump=$(apt-config dump 2>/dev/null) || dump=''
if ! printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Unattended-Upgrade "1";' || ! printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Update-Package-Lists "1";'; then
  printf '%s\\n' '// Managed by OpsCrew: automatic security updates.' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' | write_file "$CONF" 0644
fi
systemctl enable --now unattended-upgrades.service >/dev/null`,
    failed:
      "Automatic security updates are not on after the change (another file in /etc/apt/apt.conf.d may turn them off).",
    doing: "turning on automatic security updates",
    timeoutMs: 10 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// sysctl: the kernel settings the apps' services need, each a minimum

/** `key=value` words, space-separated: `vm.max_map_count=262144`. */
const SettingsSchema = z.string().regex(/^([a-z0-9_.]+=\d{1,10}( [a-z0-9_.]+=\d{1,10})*)?$/);

const SysctlParams = z.object({ settings: SettingsSchema.refine((text) => text !== "") });
const SysctlUndoParams = z.object({ restore: SettingsSchema });

/** The value OpsCrew's file sets for `$k`, empty when it sets none. */
const SYSCTL_HELPERS = `file_value() { [ -f "$FILE" ] && awk -F ' = ' -v k="$1" '$1 == k { v = $2 } END { print v }' "$FILE"; }`;

function sysctlScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    const p = params(step, SysctlUndoParams);
    return scripts({
      name: "sysctl.undo",
      params: { FILE: SYSCTL_FILE, RESTORE: p.restore },
      verify: `  [ ! -e "$FILE" ]`,
      apply: `rm -f "$FILE"
for s in $RESTORE; do sysctl -w "$s" >/dev/null || true; done`,
      failed: `${SYSCTL_FILE} is still there.`,
      doing: "removing OpsCrew's kernel settings",
      timeoutMs: MINUTE,
    });
  }
  const p = params(step, SysctlParams);
  return scripts({
    name: "sysctl",
    params: { FILE: SYSCTL_FILE, SETTINGS: p.settings },
    helpers: SYSCTL_HELPERS,
    verify: `  for s in $SETTINGS; do
    k=\${s%%=*}; v=\${s#*=}
    live=$(sysctl -n "$k" 2>/dev/null) || return 1
    [ "$live" -ge "$v" ] || return 1
    kept=$(file_value "$k")
    [ -n "$kept" ] && [ "$kept" -ge "$v" ] || return 1
  done`,
    snapshot: `values=''
for s in $SETTINGS; do k=\${s%%=*}; values="$values\${values:+ }$k=$(sysctl -n "$k" 2>/dev/null)"; done
echo "prev.values=$values"`,
    apply: `lines=''
for s in $SETTINGS; do
  k=\${s%%=*}; v=\${s#*=}
  # A higher value the server already uses stays.
  live=$(sysctl -n "$k")
  if [ "$live" -gt "$v" ]; then v=$live; fi
  lines="$lines$k = $v
"
done
printf '# Managed by OpsCrew: kernel settings the services of its apps need.\\n%s' "$lines" | write_file "$FILE" 0644
sysctl -p "$FILE" >/dev/null`,
    failed: "The kernel settings are not in effect after the change.",
    doing: "raising the kernel settings the app's services need",
    timeoutMs: MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// docker-daemon: OpsCrew's /etc/docker/daemon.json, only where there is none

function dockerDaemonScripts(purpose: HostPlan["purpose"]): StepScripts {
  const sp = {
    DAEMON_JSON: DOCKER_DAEMON_JSON_PATH,
    CONTENT_B64: base64(DOCKER_DAEMON_JSON),
    CONTENT_SHA256: sha256Hex(DOCKER_DAEMON_JSON),
  };
  const helpers = `ours() { [ -f "$DAEMON_JSON" ] && [ "$(sha256sum "$DAEMON_JSON" | cut -d ' ' -f 1)" = "$CONTENT_SHA256" ]; }`;
  if (purpose === "undo") {
    return scripts({
      name: "docker-daemon.undo",
      params: sp,
      helpers,
      verify: "  ! ours",
      apply: `# Only the file exactly as OpsCrew wrote it goes; a file the user changed stays.
if ours; then
  rm -f "$DAEMON_JSON"
  systemctl reload docker >/dev/null 2>&1 || true
fi`,
      failed: "OpsCrew's daemon.json is still there.",
      doing: "removing OpsCrew's Docker daemon settings",
      timeoutMs: 2 * MINUTE,
    });
  }
  // The user's own settings count as in place and are never overwritten: their daemon.json,
  // the same options given as dockerd flags (Docker refuses to start when a flag and daemon.json
  // set the same option), or an active Swarm (which does not allow live-restore).
  return scripts({
    name: "docker-daemon",
    params: sp,
    helpers: `${helpers}
own_settings() {
  if systemctl show -p ExecStart docker 2>/dev/null | grep -Eq -- '--(log-driver|log-opt|live-restore|no-new-privileges)'; then return 0; fi
  if systemctl is-active --quiet docker && [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = active ]; then return 0; fi
  return 1
}
busy() { systemctl is-active --quiet docker && [ -n "$(docker ps -q 2>/dev/null)" ]; }`,
    verify: `  [ -f "$DAEMON_JSON" ] || own_settings`,
    snapshot: `if [ -e "$DAEMON_JSON" ]; then echo prev.file=present; else echo prev.file=absent; fi`,
    apply: `if [ -e "$DAEMON_JSON" ] || own_settings; then exit 0; fi
install -d -m 0755 /etc/docker
tmp=$(mktemp /etc/docker/.daemon.XXXXXX)
printf '%s' "$CONTENT_B64" | base64 -d > "$tmp"
chmod 0644 "$tmp"
if command -v dockerd >/dev/null 2>&1 && ! dockerd --validate --config-file "$tmp" >/dev/null 2>&1; then
  rm -f "$tmp"
  fail 'Docker rejected the daemon settings, so OpsCrew left Docker as it was.'
fi
# Docker really uses the file once live-restore (one of OpsCrew's settings) shows up in docker info.
applied() { [ "$(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)" = true ]; }
if busy; then
  # Running containers keep running: reload now; the rest applies at Docker's next restart.
  mv -f "$tmp" "$DAEMON_JSON"
  if ! systemctl reload docker || ! applied; then
    rm -f "$DAEMON_JSON"
    systemctl reload docker >/dev/null 2>&1 || true
    fail 'Docker did not take the new settings, so OpsCrew removed them again; Docker runs as before.'
  fi
else
  mv -f "$tmp" "$DAEMON_JSON"
  if ! systemctl restart docker || ! applied; then
    rm -f "$DAEMON_JSON"
    systemctl reset-failed docker >/dev/null 2>&1 || true
    systemctl restart docker >/dev/null 2>&1 || true
    fail 'Docker did not start with the new settings, so OpsCrew removed them again and restarted Docker as before.'
  fi
fi`,
    failed: "/etc/docker/daemon.json is missing.",
    doing: "writing Docker's daemon settings",
    timeoutMs: 5 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// fail2ban: a jail for SSH on every real sshd port

function fail2banScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    const p = params(step, PackageUndoParams);
    return scripts({
      name: "fail2ban.undo",
      params: {
        JAIL: FAIL2BAN_JAIL_PATH,
        REMOVE_PACKAGE: p.removePackage,
        DISABLE_SERVICE: p.disableService,
      },
      verify: `  [ ! -e "$JAIL" ] || return 1
  if [ "$REMOVE_PACKAGE" = true ]; then ! is_installed fail2ban || return 1; fi
  if [ "$DISABLE_SERVICE" = true ]; then ! systemctl is-active --quiet fail2ban || return 1; fi`,
      apply: `rm -f "$JAIL"
if [ "$REMOVE_PACKAGE" = true ]; then
  if is_installed fail2ban; then apt_get remove fail2ban; fi
elif [ "$DISABLE_SERVICE" = true ]; then
  systemctl disable --now fail2ban >/dev/null 2>&1 || true
else
  systemctl try-reload-or-restart fail2ban >/dev/null 2>&1 || true
fi`,
      failed: "OpsCrew's fail2ban jail is still there.",
      doing: "removing OpsCrew's fail2ban jail",
      timeoutMs: 10 * MINUTE,
    });
  }
  const p = params(step, z.object({ sshPorts: PortsSchema, install: z.boolean() }));
  const jail = fail2banJail(p.sshPorts.split(" ").map(Number));
  return scripts({
    name: "fail2ban",
    params: { JAIL: FAIL2BAN_JAIL_PATH, JAIL_B64: base64(jail), JAIL_SHA256: sha256Hex(jail) },
    verify: `  systemctl is-active --quiet fail2ban || return 1
  [ -f "$JAIL" ] && [ "$(sha256sum "$JAIL" | cut -d ' ' -f 1)" = "$JAIL_SHA256" ] || return 1
  fail2ban-client status sshd >/dev/null 2>&1 || return 1`,
    snapshot: `if is_installed fail2ban; then echo prev.installed=true; else echo prev.installed=false; fi
if systemctl is-active --quiet fail2ban; then echo prev.active=true; else echo prev.active=false; fi
if [ -e "$JAIL" ]; then echo prev.jail=present; else echo prev.jail=absent; fi`,
    apply: `if ! is_installed fail2ban || ! is_installed python3-systemd; then
  apt_get update
  apt_get install fail2ban python3-systemd
fi
install -d -m 0755 /etc/fail2ban/jail.d
printf '%s' "$JAIL_B64" | base64 -d | write_file "$JAIL" 0644
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
i=0
until fail2ban-client status sshd >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then fail 'fail2ban did not start its SSH jail; run "sudo fail2ban-client -t" on the server to see why.'; fi
  sleep 2
done`,
    failed: "fail2ban is not guarding SSH.",
    doing: "setting up fail2ban",
    timeoutMs: 10 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// Removing a Compose project (the app at teardown, the add-ons)

/**
 * `remove_project <project> <compose file> <project dir> <delete data true|false>`: through the
 * project's own compose file when it is there (never a compose file from the login's working
 * directory), then whatever still carries the project's label: containers, networks and, only
 * when deleting data, volumes. `project_gone <project> <volumes too>` checks the result.
 */
const PROJECT_HELPERS = `label_ids() {
  docker "$1" ls -q --filter "label=com.docker.compose.project=$2" 2>/dev/null || true
}
remove_project() {
  if ! command -v docker >/dev/null 2>&1; then return 0; fi
  if ! systemctl is-active --quiet docker; then
    systemctl start docker >/dev/null 2>&1 || fail 'Docker is not running, so OpsCrew cannot remove the containers. Start Docker, then try again.'
  fi
  if [ -f "$2" ]; then
    if [ "$4" = true ]; then
      docker compose -p "$1" --project-directory "$3" -f "$2" down --remove-orphans --volumes >/dev/null 2>&1 || true
    else
      docker compose -p "$1" --project-directory "$3" -f "$2" down --remove-orphans >/dev/null 2>&1 || true
    fi
  fi
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$1" 2>/dev/null) || ids=''
  # shellcheck disable=SC2086 # ids are one word each.
  if [ -n "$ids" ]; then docker rm -f $ids >/dev/null; fi
  nets=$(label_ids network "$1")
  # shellcheck disable=SC2086
  if [ -n "$nets" ]; then docker network rm $nets >/dev/null 2>&1 || true; fi
  if [ "$4" = true ]; then
    vols=$(label_ids volume "$1")
    # shellcheck disable=SC2086
    if [ -n "$vols" ]; then docker volume rm $vols >/dev/null; fi
  fi
  return 0
}
project_gone() {
  if ! command -v docker >/dev/null 2>&1; then return 0; fi
  systemctl is-active --quiet docker || return 1
  [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$1" 2>/dev/null)" ] || return 1
  if [ "$2" = true ]; then [ -z "$(label_ids volume "$1")" ] || return 1; fi
  return 0
}`;

// ---------------------------------------------------------------------------------------------
// runtime-dirs (the shared folders) and app-dirs (the app's own folders)

/** Creates `dirs` for the deploy user (0750). */
function dirsScripts(name: string, dirs: readonly string[], snapshot?: string): StepScripts {
  return scripts({
    name,
    params: { USER_NAME: "deploy", DIRS: dirs.join(" ") },
    verify: `  for d in $DIRS; do
    [ -d "$d" ] && [ ! -L "$d" ] || return 1
    [ "$(stat -c '%U:%G:%a' "$d")" = "$USER_NAME:$USER_NAME:750" ] || return 1
  done`,
    ...(snapshot !== undefined ? { snapshot } : {}),
    apply: `for d in $DIRS; do
  if [ -L "$d" ]; then fail "$d is a symbolic link; OpsCrew does not follow it."; fi
  install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$d"
  chown "$USER_NAME:$USER_NAME" "$d"
  chmod 0750 "$d"
done`,
    failed: `${dirs.join(" and ")} are not set up for deploy.`,
    doing: `creating ${dirs.join(" and ")}`,
    timeoutMs: 2 * MINUTE,
  });
}

function appDirsScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose === "setup") {
    const dirs = appDirs(params(step, z.object({ app: AppNameSchema })).app);
    return dirsScripts("app-dirs", [dirs.app, dirs.data]);
  }
  if (plan.purpose !== "teardown") throw invalid(step, "purpose");
  const p = params(step, z.object({ app: AppNameSchema, deleteData: z.boolean() }));
  const dirs = appDirs(p.app);
  return scripts({
    name: "app-dirs.teardown",
    params: {
      APP: p.app,
      DELETE_DATA: p.deleteData,
      APP_DIR: dirs.app,
      APP_COMPOSE: `${dirs.app}/compose.yaml`,
      DATA_DIR: dirs.data,
      SITE: runtimeFilePath(p.app, "site"),
      NGINX_SITE: `${EDGE_DIR}/sites/${p.app}.conf`,
      ADDITIONS: `${EDGE_DIR}/sites/${p.app}.additions`,
      TLS_DIR: `${EDGE_DIR}/tls/${p.app}`,
      EDGE_COMPOSE: `${EDGE_DIR}/compose.yaml`,
      EDGE_PROJECT,
    },
    helpers: `${PROJECT_HELPERS}
remove_dir() {
  if [ -d "$1" ]; then
    find "$1" -xdev -mindepth 1 -delete
    rmdir "$1" || fail "OpsCrew could not remove $1 completely."
  fi
}
edge() { docker compose -p "$EDGE_PROJECT" -f "$EDGE_COMPOSE" "$@"; }`,
    verify: `  project_gone "$APP" "$DELETE_DATA" || return 1
  [ ! -e "$APP_DIR" ] || return 1
  for f in "$SITE" "$NGINX_SITE" "$ADDITIONS" "$TLS_DIR"; do
    [ ! -e "$f" ] && [ ! -L "$f" ] || return 1
  done
  if [ "$DELETE_DATA" = true ] && [ -e "$DATA_DIR" ]; then return 1; fi
  return 0`,
    snapshot: `echo "prev.appFiles=$(ls -A "$APP_DIR" 2>/dev/null | wc -l)"
echo "prev.dataFiles=$(ls -A "$DATA_DIR" 2>/dev/null | wc -l)"`,
    apply: `for d in "$APP_DIR" "$DATA_DIR" "$TLS_DIR"; do
  if [ -L "$d" ]; then fail "$d is a symbolic link; OpsCrew does not follow it."; fi
done
remove_project "$APP" "$APP_COMPOSE" "$APP_DIR" "$DELETE_DATA"
# The app's site (Caddy's or nginx's), its additions, its origin certificate and its kamal-proxy
# service leave the shared edge, which stays for other apps (remove_project started Docker when it
# was stopped).
reload=''
if [ -e "$SITE" ] || [ -L "$SITE" ]; then rm -f "$SITE"; reload=caddy; fi
if [ -e "$NGINX_SITE" ] || [ -L "$NGINX_SITE" ]; then rm -f "$NGINX_SITE"; reload=nginx; fi
rm -f "$ADDITIONS"
remove_dir "$TLS_DIR"
if [ -f "$EDGE_COMPOSE" ] && command -v docker >/dev/null 2>&1; then
  # A stopped kamal-proxy keeps the app's route on its volume: it runs while the route goes.
  edge up -d kamal-proxy >/dev/null 2>&1 || fail "The shared edge's kamal-proxy did not start, so OpsCrew could not remove the app's route from it."
  # An app that was never deployed has no route there.
  if ! out=$(edge exec -T kamal-proxy kamal-proxy remove "$APP" </dev/null 2>&1); then
    case "$out" in
      *"service not found"*) ;;
      *) fail "kamal-proxy did not remove the app's route." ;;
    esac
  fi
  case "$reload" in
    caddy) edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile </dev/null >/dev/null 2>&1 || true ;;
    nginx) edge exec -T nginx sh -c 'nginx -t && nginx -s reload' </dev/null >/dev/null 2>&1 || true ;;
  esac
fi
remove_dir "$APP_DIR"
if [ "$DELETE_DATA" = true ]; then remove_dir "$DATA_DIR"; fi
if [ "$DELETE_DATA" = true ] && ! project_gone "$APP" true; then
  fail 'Some Docker volumes of the app could not be removed.'
fi`,
    failed: "Some of the app's containers, volumes or files are still on the server.",
    doing: "removing the app's containers and files",
    timeoutMs: 10 * MINUTE,
  });
}

function runtimeScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose === "undo") {
    const p = params(
      step,
      z.object({
        dirs: z.string().regex(/^\/srv\/(edge|apps|data)( \/srv\/(edge|apps|data)){0,2}$/),
      }),
    );
    const verify = `  for d in $DIRS; do
    if [ -d "$d" ] && [ ! -L "$d" ] && [ -z "$(ls -A "$d")" ]; then return 1; fi
  done
  return 0`;
    return scripts({
      name: "runtime-dirs.undo",
      params: { DIRS: p.dirs },
      verify,
      apply: `for d in $DIRS; do
  # Only empty directories go; anything with files in it (kept app data) stays.
  if [ -d "$d" ] && [ ! -L "$d" ] && [ -z "$(ls -A "$d")" ]; then rmdir "$d"; fi
done`,
      failed: "An empty runtime directory is still there.",
      doing: "removing the empty runtime directories",
      timeoutMs: 2 * MINUTE,
    });
  }
  return dirsScripts(
    "runtime-dirs",
    SHARED_DIRS,
    `for d in $DIRS; do
  key=$(basename "$d")
  if [ -e "$d" ]; then echo "prev.$key=present"; else echo "prev.$key=absent"; fi
done`,
  );
}

// ---------------------------------------------------------------------------------------------
// app-record: the app's record in /etc/opscrew/apps (the apply lists it in the host record)

/** The record of an app set up on the server, as the `app-record` step writes it. */
export function appRecord(input: {
  app: string;
  projectId: string;
  access: AccessMode;
  hostnames: readonly string[];
  services: readonly string[];
  memoryMb: number;
  deployKey: string;
}): AppRecord {
  return {
    schemaVersion: 1,
    app: input.app,
    projectId: input.projectId,
    state: "active",
    access: input.access,
    hostnames: [...new Set(input.hostnames)].sort(),
    folders: appDirs(input.app),
    composeProject: input.app,
    services: [...new Set(input.services)].sort(),
    memoryMb: input.memoryMb,
    deployKey: input.deployKey,
  };
}

/** The record of an app removed with its data kept: its name stays its project's. */
export function dataKeptRecord(app: string, projectId: string): AppRecord {
  return {
    schemaVersion: 1,
    app,
    projectId,
    state: "data-kept",
    access: null,
    hostnames: [],
    folders: appDirs(app),
    composeProject: app,
    services: [],
    memoryMb: 0,
    deployKey: "",
  };
}

/** Words of a space-separated parameter, each checked by `schema`. */
const words = <T extends z.ZodString>(schema: T) =>
  z
    .string()
    .transform((text) => text.split(" ").filter((word) => word !== ""))
    .pipe(z.array(schema));

const AppRecordParams = z.object({
  app: AppNameSchema.refine((app) => app !== EDGE_PROJECT, {
    message: "is OpsCrew's own",
  }),
  projectId: ProjectIdSchema,
  access: AccessModeSchema,
  hostnames: words(HostnameSchema),
  services: words(ServiceNameSchema),
  memoryMb: z.number().int().positive(),
  deployKey: PublicKeySchema,
  ownProject: z.boolean(),
});

/** Refuses to touch `$RECORD_FILE` when it names another project than `$PROJECT_ID`. */
const PROJECT_CHECK_LINES = `if [ -f "$RECORD_FILE" ] && ! grep -qF "\\"projectId\\":\\"$PROJECT_ID\\"" "$RECORD_FILE"; then
  fail "Another project's OpsCrew app named $APP is already on this server."
fi`;

/** Shell lines that write `$RECORD` to `$RECORD_FILE` (root only). */
function writeRecordLines(): string {
  return `install -d -m 0700 ${OPSCREW_DIR} ${APP_RECORDS_DIR}
printf '%s\\n' "$RECORD" | write_file "$RECORD_FILE" 0600`;
}

function appRecordScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose === "undo") {
    return scripts({
      name: "app-record.undo",
      params: { OPSCREW_DIR, APP_RECORDS_DIR, READY_FLAG },
      verify: `  [ ! -e "$OPSCREW_DIR" ] && [ ! -e "$READY_FLAG" ]`,
      apply: `if grep -qs '"state":"active"' "$APP_RECORDS_DIR"/*.json; then
  fail 'An OpsCrew app is still on this server; remove it first.'
fi
rm -f "$READY_FLAG"
rm -rf "$OPSCREW_DIR" "$(dirname '${APT_LOG}')"`,
      failed: `${OPSCREW_DIR} is still there.`,
      doing: "removing OpsCrew's records",
      timeoutMs: MINUTE,
    });
  }
  if (plan.purpose === "teardown") {
    const p = params(
      step,
      z.object({ app: AppNameSchema, keepData: z.boolean(), projectId: ProjectIdSchema }),
    );
    const own = {
      APP: p.app,
      PROJECT_ID: p.projectId,
      RECORD_FILE: `${APP_RECORDS_DIR}/${p.app}.json`,
    };
    if (p.keepData) {
      return scripts({
        name: "app-record.keep",
        params: { ...own, RECORD: JSON.stringify(dataKeptRecord(p.app, p.projectId)) },
        verify: `  [ -f "$RECORD_FILE" ] && [ "$(cat "$RECORD_FILE")" = "$RECORD" ]`,
        apply: `${PROJECT_CHECK_LINES}\n${writeRecordLines()}`,
        failed: "The record of the kept data was not written.",
        doing: "recording the app's kept data",
        timeoutMs: MINUTE,
      });
    }
    return scripts({
      name: "app-record.teardown",
      params: own,
      verify: `  [ ! -e "$RECORD_FILE" ]`,
      apply: `${PROJECT_CHECK_LINES}\nrm -f "$RECORD_FILE"`,
      failed: "The app's record is still there.",
      doing: "removing the app's record",
      timeoutMs: MINUTE,
    });
  }
  const p = params(step, AppRecordParams);
  const record = appRecord(p);
  return scripts({
    name: "app-record",
    params: {
      RECORD_FILE: `${APP_RECORDS_DIR}/${p.app}.json`,
      RECORD: JSON.stringify(record),
      PROJECT_ID: p.projectId,
      READY_FLAG,
      APP: p.app,
      OWN_PROJECT: p.ownProject,
    },
    verify: `  [ -f "$RECORD_FILE" ] && [ "$(cat "$RECORD_FILE")" = "$RECORD" ] && [ -f "$READY_FLAG" ]`,
    snapshot: `if [ -e "$RECORD_FILE" ]; then echo prev.record=present; else echo prev.record=absent; fi`,
    apply: `${PROJECT_CHECK_LINES}
# Before the app is recorded: no Compose project of that name that OpsCrew did not deploy (the
# plan checked; this checks again on the server itself).
if [ ! -f "$RECORD_FILE" ] && [ "$OWN_PROJECT" != true ] && command -v docker >/dev/null 2>&1; then
  if ! systemctl is-active --quiet docker; then
    fail 'Docker is installed but not running, so OpsCrew cannot see its containers. Start Docker (sudo systemctl start docker), then plan again.'
  fi
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=$APP") ||
    fail 'OpsCrew could not list the Docker containers on this server, so it does not record the app.'
  volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$APP") ||
    fail 'OpsCrew could not list the Docker volumes on this server, so it does not record the app.'
  if [ -n "$containers$volumes" ]; then
    fail "Docker already has containers or volumes of a Compose project named $APP that OpsCrew did not deploy, so OpsCrew does not record the app."
  fi
fi
${writeRecordLines()}
# The same "setup finished" flag cloud-init sets on servers OpsCrew creates.
install -d -m 0755 "$(dirname "$READY_FLAG")"
touch "$READY_FLAG"`,
    failed: "The app's record was not written.",
    doing: "recording the app on the server",
    timeoutMs: MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// edge: the shared edge goes with the last app (a teardown step only)

function edgeScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose !== "teardown") throw invalid(step, "purpose");
  // The folder goes only when OpsCrew created it (the plan says so). A folder of the user's own is
  // never read: the edge's containers, network and volumes go by their labels only.
  const p = params(step, z.object({ removeDir: z.boolean() }));
  return scripts({
    name: "edge.teardown",
    params: {
      DIR: EDGE_DIR,
      COMPOSE: p.removeDir ? `${EDGE_DIR}/compose.yaml` : "",
      PROJECT: EDGE_PROJECT,
      NETWORK: EDGE_PROJECT,
      REMOVE_DIR: p.removeDir,
    },
    helpers: `${PROJECT_HELPERS}
network_gone() {
  ! command -v docker >/dev/null 2>&1 || ! docker network inspect "$NETWORK" >/dev/null 2>&1
}`,
    verify: `  if [ "$REMOVE_DIR" = true ] && [ -e "$DIR" ]; then return 1; fi
  project_gone "$PROJECT" true || return 1
  network_gone`,
    apply: `if [ "$REMOVE_DIR" = true ] && [ -L "$DIR" ]; then fail "$DIR is a symbolic link; OpsCrew does not follow it."; fi
remove_project "$PROJECT" "$COMPOSE" "$DIR" true
# The apps' web services joined the edge's network; with the last app gone, so is the network.
if ! network_gone; then
  docker network rm "$NETWORK" >/dev/null || fail "The network $NETWORK is still in use, so OpsCrew could not remove it."
fi
if [ "$REMOVE_DIR" = true ]; then rm -rf "$DIR"; fi`,
    failed: "The shared edge is still on the server.",
    doing: "removing the shared edge",
    timeoutMs: 5 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// tunnel-connector and portainer: their own Compose projects, files rendered by the caller

const DirSchema = z
  .string()
  .regex(/^(\/[A-Za-z0-9._-]+){2,}$/)
  .refine((dir) => !dir.split("/").includes(".."), { message: "must not contain .." });

/** How a step runs: as root (servers the user owns) or as the SSH login (Hetzner, DigitalOcean). */
export type RunAs = "root" | "login";

const RunAsSchema = z.enum(["root", "login"]);

/** Root steps live in OpsCrew's root-owned directory (`rootDir`) only. */
function checkLocation(step: HostStep, dir: string, runAs: RunAs, rootDir: string): void {
  if (runAs === "root" && dir !== rootDir) throw invalid(step, "dir");
}

/** Shell helpers shared by the add-on scripts. */
const ADDON_HELPERS = `compose() { docker compose -p "$PROJECT" -f "$DIR/compose.yaml" "$@"; }
compose_is() { [ -f "$DIR/compose.yaml" ] && [ "$(sha256sum "$DIR/compose.yaml" | cut -d ' ' -f 1)" = "$1" ]; }
write_compose() { printf '%s' "$1" | base64 -d | write_file "$DIR/compose.yaml" 0600; }
running() { [ -n "$(compose ps --status running -q 2>/dev/null)" ]; }`;

const RemoveParams = z.object({
  remove: z.literal(true),
  deleteData: z.boolean().optional(),
  dir: DirSchema.optional(),
  runAs: RunAsSchema.optional(),
});

/** The scripts that remove an add-on's Compose project and its directory. */
function removeAddonScripts(
  plan: HostPlan,
  step: HostStep,
  addon: { name: "tunnel-connector" | "portainer"; dir: string; project: string; doing: string },
): StepScripts {
  const p = params(step, RemoveParams);
  const dir = p.dir ?? addon.dir;
  const runAs = p.runAs ?? "root";
  checkLocation(step, dir, runAs, addon.dir);
  // A teardown deletes the add-on's data with the app's; the tunnel connector keeps none.
  const deleteData =
    addon.name === "portainer" &&
    (plan.purpose === "teardown" ? plan.deleteData === true : p.deleteData === true);
  return scripts({
    name: `${addon.name}.remove`,
    params: {
      DIR: dir,
      PARENT: dir.slice(0, dir.lastIndexOf("/")),
      PROJECT: addon.project,
      DELETE_DATA: deleteData,
      ADDONS_ROOT,
      RUN_AS: runAs,
    },
    helpers: PROJECT_HELPERS,
    verify: `  [ ! -e "$DIR" ] || return 1
  project_gone "$PROJECT" "$DELETE_DATA" || return 1
  return 0`,
    apply: `remove_project "$PROJECT" "$DIR/compose.yaml" "$DIR" "$DELETE_DATA"
rm -rf "$DIR"
# OpsCrew's shared parents go too once they are empty.
if [ "$RUN_AS" = root ]; then
  for d in "$PARENT" "$ADDONS_ROOT"; do
    if [ -d "$d" ] && [ -z "$(ls -A "$d")" ]; then rmdir "$d"; fi
  done
fi`,
    failed: `OpsCrew's ${addon.name} is still on the server.`,
    doing: addon.doing,
    timeoutMs: 5 * MINUTE,
  });
}

/**
 * The app's own tunnel connector (`params.app`): a setup or teardown plan changes only its own
 * app's connector; an undo removes any app's that was left behind.
 */
function tunnelScripts(plan: HostPlan, step: HostStep): StepScripts {
  const { app } = params(step, z.object({ app: AppNameSchema }));
  if (plan.purpose !== "undo" && app !== plan.app) throw invalid(step, "app");
  if (plan.purpose !== "setup" || step.params.remove === true) {
    return removeAddonScripts(plan, step, {
      name: "tunnel-connector",
      dir: tunnelDir(app),
      project: tunnelProject(app),
      doing: "removing the tunnel connector",
    });
  }
  const p = params(
    step,
    z.object({
      compose: ComposeTextSchema,
      tunnelId: TunnelIdSchema,
      needsToken: z.boolean(),
      dir: DirSchema.optional(),
      runAs: RunAsSchema.optional(),
    }),
  );
  const dir = p.dir ?? tunnelDir(app);
  const runAs = p.runAs ?? "root";
  checkLocation(step, dir, runAs, tunnelDir(app));
  return scripts({
    name: "tunnel-connector",
    params: {
      DIR: dir,
      PROJECT: tunnelProject(app),
      ADDONS_ROOT,
      TUNNELS_DIR,
      RUN_AS: runAs,
      COMPOSE_B64: base64(p.compose),
      COMPOSE_SHA256: sha256Hex(p.compose),
      TUNNEL_ID: p.tunnelId,
      NEEDS_TOKEN: p.needsToken,
    },
    helpers: ADDON_HELPERS,
    verify: `  [ -s "$DIR/tunnel.env" ] || return 1
  [ "$(head -n 1 "$DIR/tunnel.id" 2>/dev/null)" = "$TUNNEL_ID" ] || return 1
  compose_is "$COMPOSE_SHA256" || return 1
  running || return 1`,
    snapshot: `if [ -e "$DIR/compose.yaml" ]; then echo prev.installed=true; else echo prev.installed=false; fi`,
    apply: `umask 077
if [ "$RUN_AS" = root ]; then install -d -m 0700 "$ADDONS_ROOT" "$TUNNELS_DIR"; fi
install -d -m 0700 "$DIR"
token=''
IFS= read -r token || true
recreate=''
if [ -n "$token" ]; then
  case "$token" in
    *[!A-Za-z0-9+/=_.-]*) token=''; fail 'The tunnel token has unexpected characters, so it was not written.' ;;
  esac
  printf 'TUNNEL_TOKEN=%s\\n' "$token" | write_file "$DIR/tunnel.env" 0600
  token=''
  # A new token means a new connector container, so it really uses it.
  recreate=--force-recreate
elif [ "$NEEDS_TOKEN" = true ] || [ ! -s "$DIR/tunnel.env" ]; then
  fail 'No tunnel token arrived on standard input, so the tunnel connector was not set up.'
fi
# The tunnel id is not secret: it tells a later plan whether the tunnel was replaced.
printf '%s\\n' "$TUNNEL_ID" > "$DIR/tunnel.id"
write_compose "$COMPOSE_B64"
# shellcheck disable=SC2086 # recreate is empty or one flag.
compose up -d --remove-orphans --quiet-pull $recreate >/dev/null 2>&1 || fail 'The tunnel connector did not start (docker compose up failed).'
i=0
until compose logs --no-color --tail 300 2>/dev/null | grep -q 'Registered tunnel connection'; do
  i=$((i + 1))
  if [ "$i" -ge 45 ]; then fail 'The tunnel connector did not connect to Cloudflare within 90 seconds. Check that the server can reach Cloudflare on port 7844 (outbound) and that the tunnel still exists.'; fi
  sleep 2
done`,
    failed: "The tunnel connector is not running.",
    secret: { name: "tunnelToken", required: p.needsToken },
    doing: "starting the Cloudflare Tunnel connector",
    timeoutMs: 10 * MINUTE,
  });
}

const PortainerParams = z.object({
  version: PortainerVersionSchema,
  dir: DirSchema,
  runAs: RunAsSchema,
  composeInitial: ComposeTextSchema,
  composeFinal: ComposeTextSchema,
  needsPassword: z.boolean(),
});

function portainerScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose !== "setup" || step.params.remove === true) {
    return removeAddonScripts(plan, step, {
      name: "portainer",
      dir: PORTAINER_DIR,
      project: PORTAINER_PROJECT,
      doing: "removing Portainer",
    });
  }
  const p = params(step, PortainerParams);
  checkLocation(step, p.dir, p.runAs, PORTAINER_DIR);
  return scripts({
    name: "portainer",
    params: {
      DIR: p.dir,
      RUN_AS: p.runAs,
      PROJECT: PORTAINER_PROJECT,
      PORT: PORTAINER_PORT,
      INITIAL_B64: base64(p.composeInitial),
      FINAL_B64: base64(p.composeFinal),
      FINAL_SHA256: sha256Hex(p.composeFinal),
      NEEDS_PASSWORD: p.needsPassword,
    },
    helpers: `${ADDON_HELPERS}
admin_check() { curl -ks -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT/api/users/admin/check" 2>/dev/null || true; }
wait_up() {
  i=0
  while [ "$i" -lt 60 ]; do
    code=$(admin_check)
    case "$code" in 204|404) echo "$code"; return 0 ;; esac
    i=$((i + 1))
    sleep 2
  done
  return 1
}`,
    verify: `  compose_is "$FINAL_SHA256" || return 1
  [ ! -e "$DIR/admin_password" ] || return 1
  running || return 1`,
    snapshot: `if [ -e "$DIR/compose.yaml" ]; then echo prev.installed=true; else echo prev.installed=false; fi`,
    apply: `umask 077
if [ "$RUN_AS" = root ]; then install -d -m 0700 "$(dirname "$DIR")"; fi
install -d -m 0700 "$DIR"
if ! command -v curl >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ]; then apt_get update; apt_get install curl
  else fail 'curl is missing on the server; install it, then turn Portainer on again.'; fi
fi
pw=''
sent=false
IFS= read -r pw || true
if [ -n "$pw" ]; then
  sent=true
  printf '%s' "$pw" | write_file "$DIR/admin_password" 0600
  pw=''
  write_compose "$INITIAL_B64"
elif [ "$NEEDS_PASSWORD" = true ]; then
  fail 'No Portainer admin password arrived on standard input, so Portainer was not set up.'
else
  write_compose "$FINAL_B64"
fi
if ! compose up -d --remove-orphans --quiet-pull >/dev/null 2>&1; then
  rm -f "$DIR/admin_password"
  fail 'Portainer did not start (docker compose up failed).'
fi
code=$(wait_up) || code=none
if [ "$code" != 204 ]; then
  compose stop >/dev/null 2>&1 || true
  rm -f "$DIR/admin_password"
  if [ "$code" = 404 ] && [ "$sent" = true ]; then fail 'Portainer started without an admin account, so OpsCrew stopped it. Turn Portainer on again so OpsCrew can set the admin password.'; fi
  if [ "$code" = 404 ]; then fail 'Portainer has data on this server but no admin account, and no admin password reached the server, so OpsCrew stopped it. Run opscrew portainer disable --delete-data and turn Portainer on again, or copy the password file from the computer that turned Portainer on and run the command again.'; fi
  fail 'Portainer did not answer on 127.0.0.1:9443 within two minutes, so OpsCrew stopped it.'
fi
# The admin account exists: run without the one-time password file, then delete it.
if ! compose_is "$FINAL_SHA256"; then
  write_compose "$FINAL_B64"
  rm -f "$DIR/admin_password"
  compose up -d --remove-orphans >/dev/null 2>&1 || fail 'Portainer did not restart without its one-time password file.'
fi
rm -f "$DIR/admin_password"`,
    failed: "Portainer is not running as planned.",
    secret: { name: "portainerPassword", required: p.needsPassword },
    doing: "setting up Portainer",
    timeoutMs: 10 * MINUTE,
  });
}

// ---------------------------------------------------------------------------------------------
// github-runner: the app's GitHub Actions runner, run as deploy

/**
 * Shell helpers of the runner's scripts. `as_deploy <command…>` runs a command as the deploy user
 * (the runner's owner); `quiet <command…>` runs one with its output kept back, and leaves its last
 * line in `$last` when it fails. `read_token` reads the token from stdin into `RUNNER_TOKEN` (a
 * shell variable, not exported), then gives every later command an empty stdin.
 * `uninstall_service` stops and removes the service of the runner in the current folder, and
 * `at_least <version> <pinned>` compares two `2.338.0` versions.
 */
const RUNNER_HELPERS = `as_deploy() { runuser -u "$USER_NAME" -- "$@"; }
uninstall_service() {
  if [ -f .service ] && [ -f svc.sh ]; then
    ./svc.sh stop >/dev/null 2>&1 || true
    quiet ./svc.sh uninstall || fail "The runner's service could not be removed (svc.sh uninstall: $last)."
  fi
}
at_least() {
  case "$1" in [0-9]*.[0-9]*.[0-9]*) ;; *) return 1 ;; esac
  [ "$(printf '%s\\n%s\\n' "$1" "$2" | sort -t . -k 1,1n -k 2,2n -k 3,3n | head -n 1)" = "$2" ]
}
quiet() {
  last=''
  if out=$("$@" 2>&1); then return 0; fi
  last=$(printf '%s\\n' "$out" | tail -n 1)
  return 1
}
read_token() {
  RUNNER_TOKEN=''
  IFS= read -r RUNNER_TOKEN || true
  exec </dev/null
  [ -n "$RUNNER_TOKEN" ] || fail "No $1 token arrived on standard input, so OpsCrew did not change the runner."
}
no_links() {
  for d in "$@"; do
    if [ -L "$d" ]; then fail "$d is a symbolic link; OpsCrew does not follow it."; fi
  done
}`;

/**
 * Shell comment: how the token reaches `config.sh` without being on any command line (which
 * `/proc/<pid>/cmdline` shows every user).
 */
const TOKEN_ENV_NOTE = `# The token is never on a command line: the runner reads each argument from
# ACTIONS_RUNNER_INPUT_<ARG> and removes the variable once read (CommandSettings.cs). The variable is
# set for runuser alone (not through as_deploy: POSIX does not say whether an assignment before a
# shell function's call reaches the commands it runs), and runuser -u (not a login shell) keeps the
# environment (to confirm in spike item 4); /proc/<pid>/environ is readable only by deploy and root.`;

const RunnerParams = DesiredRunnerSchema.extend({
  app: AppNameSchema,
  user: z.literal("deploy"),
});

/**
 * The app's runner (`params.app`, in `runnerDir(app)`): installed by a setup plan, removed by a
 * setup plan without one (`remove: true`), a teardown, or an undo (any app's left behind).
 * Setup follows plan.md "8.": the folder for deploy, the pinned archive checked by its SHA-256 and
 * extracted as deploy, `bin/installdependencies.sh` as root, `config.sh` as deploy with the
 * registration token from stdin, then `svc.sh install deploy` and `svc.sh start` as root. A
 * runner already there that is not the planned one (older, another label or repository, or its
 * service stopped) loses its service and its registration's local files first, and is installed
 * again over its folder. The label and repository go to OpsCrew's `.opscrew-runner` beside it.
 * Not yet run on a real server (spike item 4): the runner's own commands and files are as GitHub
 * documents them and as its scripts read.
 */
function runnerScripts(plan: HostPlan, step: HostStep): StepScripts {
  const { app } = params(step, z.object({ app: AppNameSchema }));
  if (plan.purpose !== "undo" && app !== plan.app) throw invalid(step, "app");
  const base = { APP: app, DIR: runnerDir(app), RUNNERS_DIR, USER_NAME: "deploy" };
  if (plan.purpose !== "setup" || step.params.remove === true) {
    params(step, z.object({ app: AppNameSchema, remove: z.literal(true) }));
    return scripts({
      name: "github-runner.remove",
      params: base,
      helpers: RUNNER_HELPERS,
      verify: `  [ ! -e "$DIR" ] && [ ! -L "$DIR" ]`,
      apply: `read_token remove
no_links "$RUNNERS_DIR" "$DIR"
if [ -d "$DIR" ]; then
  cd "$DIR"
  uninstall_service
  # A runner that never registered, or that GitHub does not unregister (it no longer knows it, or
  # it is another repository's), still goes from the server; the line below tells the caller,
  # which then deletes the registration through GitHub's API.
  unregistered=false
${TOKEN_ENV_NOTE.replace(/^/gm, "  ")}
  if [ -f .runner ] && ACTIONS_RUNNER_INPUT_TOKEN="$RUNNER_TOKEN" runuser -u "$USER_NAME" -- ./config.sh remove >/dev/null 2>&1; then
    unregistered=true
  fi
  echo "runner.unregistered=$unregistered"
  cd /
  rm -rf "$DIR"
fi
unset RUNNER_TOKEN
# The runners' parent goes too once it is empty.
if [ -d "$RUNNERS_DIR" ] && [ -z "$(ls -A "$RUNNERS_DIR")" ]; then rmdir "$RUNNERS_DIR"; fi`,
      failed: "The runner's folder is still on the server.",
      runnerToken: "remove",
      doing: "removing the GitHub Actions runner",
      timeoutMs: 5 * MINUTE,
    });
  }
  const p = params(step, RunnerParams);
  return scripts({
    name: "github-runner",
    params: {
      ...base,
      URL: p.repositoryUrl,
      NAME: p.name,
      LABEL: p.label,
      VERSION: p.version,
      SHA256: p.sha256,
      ARCHIVE_URL: p.url,
    },
    helpers: RUNNER_HELPERS,
    verify: `  [ -f "$DIR/.runner" ] || return 1
  [ "$(cat "$DIR/.opscrew-runner" 2>/dev/null)" = "$(printf 'label=%s\\nurl=%s' "$LABEL" "$URL")" ] || return 1
  unit=$(head -n 1 "$DIR/.service" 2>/dev/null) || return 1
  systemctl is-active --quiet "$unit" || return 1
  at_least "$(as_deploy timeout 30 "$DIR/bin/Runner.Listener" --version </dev/null 2>/dev/null | tail -n 1)" "$VERSION"`,
    snapshot: `if [ -e "$DIR/.runner" ]; then echo prev.installed=true; else echo prev.installed=false; fi`,
    apply: `read_token registration
no_links "$RUNNERS_DIR" "$DIR"
# 1. The runner's folder, for deploy only.
install -d -m 0755 "$RUNNERS_DIR"
install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$DIR"
# 2. The pinned archive, checked against its SHA-256 before anything in it runs.
if ! command -v curl >/dev/null 2>&1; then apt_get update; apt_get install curl; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/runner.tar.gz" "$ARCHIVE_URL" || fail 'The runner could not be downloaded from GitHub.'
printf '%s  %s\\n' "$SHA256" "$tmp/runner.tar.gz" | sha256sum -c - >/dev/null 2>&1 ||
  fail 'The downloaded runner does not match its pinned SHA-256, so OpsCrew did not install it.'
chmod 0755 "$tmp"
chmod 0644 "$tmp/runner.tar.gz"
# A runner already here is not the planned one: its service goes, and its registration's local
# files, so config.sh registers it again (--replace takes its place on GitHub).
cd "$DIR"
uninstall_service
rm -f .runner .credentials .credentials_rsaparams .opscrew-runner
# 3. Extracted as deploy, who owns everything in the folder.
quiet as_deploy tar -xzf "$tmp/runner.tar.gz" -C "$DIR" || fail "The runner could not be unpacked ($last)."
# 4. Its system packages, as root. deploy owns the script, and is in the docker group, which is
# already root-equivalent: running it as root gives deploy nothing it did not have.
install -d -m 0700 "$(dirname '${APT_LOG}')"
# Another apt run may hold the lock (a fresh server's daily apt jobs): wait for it, as
# package-repair does.
i=0
until "$DIR/bin/installdependencies.sh" >>'${APT_LOG}' 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    tail -n 5 '${APT_LOG}' >&2 || true
    fail "The runner's system packages could not be installed (bin/installdependencies.sh)."
  fi
  sleep 5
done
# 5. Registered as deploy, with the label the deploy job asks for. --replace takes over an old
# registration of the same name (this runner before, or a server set up again).
${TOKEN_ENV_NOTE}
if ! out=$(ACTIONS_RUNNER_INPUT_TOKEN="$RUNNER_TOKEN" runuser -u "$USER_NAME" -- ./config.sh --unattended --url "$URL" --name "$NAME" --labels "$LABEL" --work _work --replace 2>&1); then
  fail "The runner could not register with GitHub ($(printf '%s\\n' "$out" | tail -n 1))."
fi
unset RUNNER_TOKEN
# What it was registered with, for the next plan (the runner's .runner holds no labels).
printf 'label=%s\\nurl=%s\\n' "$LABEL" "$URL" | write_file "$DIR/.opscrew-runner" 0644
# 6. Its systemd service, run as deploy (svc.sh needs root and the runner's folder).
quiet ./svc.sh install "$USER_NAME" || fail "The runner's service could not be installed (svc.sh install: $last)."
quiet ./svc.sh start || fail "The runner's service did not start (svc.sh start: $last)."`,
    failed: "The runner is not registered and running.",
    runnerToken: "registration",
    doing: "installing the GitHub Actions runner",
    timeoutMs: 15 * MINUTE,
  });
}

/**
 * How a step's scripts run: the Portainer and tunnel connector steps for Hetzner/DigitalOcean run
 * as the login (the deploy user); everything else as root.
 */
export function runAsOf(step: HostStep): RunAs {
  return (step.id === "portainer" || step.id === "tunnel-connector") &&
    step.params.runAs === "login"
    ? "login"
    : "root";
}

/** The fixed scripts for one step of a plan; throws INVALID_INPUT on bad parameters. */
export function stepScripts(plan: HostPlan, step: HostStep): StepScripts {
  const id: HostStepId = step.id;
  switch (id) {
    case "package-repair":
      return packageRepairScripts();
    case "docker":
      return plan.purpose === "setup" ? dockerScripts(step) : dockerUndoScripts();
    case "docker-daemon":
      return dockerDaemonScripts(plan.purpose);
    case "fail2ban":
      return fail2banScripts(plan.purpose, step);
    case "deploy-user":
      return deployUserScripts(plan.purpose, step);
    case "deploy-key":
      return deployKeyScripts(step);
    case "sshd":
      return sshdScripts(plan.purpose, step);
    case "ufw":
      return ufwScripts(plan.purpose, step);
    case "web-filter":
      return webFilterScripts(step);
    case "unattended-upgrades":
      return upgradesScripts(plan.purpose, step);
    case "sysctl":
      return sysctlScripts(plan.purpose, step);
    case "runtime-dirs":
      return runtimeScripts(plan, step);
    case "app-dirs":
      return appDirsScripts(plan, step);
    case "app-record":
      return appRecordScripts(plan, step);
    case "github-runner":
      return runnerScripts(plan, step);
    case "edge":
      return edgeScripts(plan, step);
    case "tunnel-connector":
      return tunnelScripts(plan, step);
    case "portainer":
      return portainerScripts(plan, step);
  }
}

// ---------------------------------------------------------------------------------------------
// Dead-man switch and host record

export function deadManUnit(step: GuardedStep): string {
  return `opscrew-undo-${step}`;
}

/** Saves the current state, writes the undo script, and schedules it with `systemd-run`. */
export function armScript(
  deadMan: { step: GuardedStep; capture: string; params: ScriptParams },
  seconds: number,
): string {
  const { step, capture } = deadMan;
  const helpers = step === "ufw" ? UFW_HELPERS : "";
  return buildScript(
    `deadman.arm.${step}`,
    { ...deadMan.params, STEP: step, UNIT: deadManUnit(step), DELAY: seconds },
    `${APT_FUNCTIONS}
${helpers}
install -d -m 0700 ${OPSCREW_DIR} ${DEAD_MAN_DIR}
if systemctl is-active --quiet "$UNIT.timer"; then
  # An interrupted run left its undo waiting: put that state back before changing anything.
  sh "${DEAD_MAN_DIR}/$STEP.undo.sh" >/dev/null 2>&1 || true
  systemctl stop "$UNIT.timer" >/dev/null 2>&1 || true
fi
systemctl stop "$UNIT.service" >/dev/null 2>&1 || true
systemctl reset-failed "$UNIT.timer" "$UNIT.service" >/dev/null 2>&1 || true
${capture}
chmod 0700 "${DEAD_MAN_DIR}/$STEP.undo.sh"
# The undo and a cancel take turns with flock on $STEP.lock: the undo marks $STEP.fired, the
# cancel marks $STEP.cancelled. Both marks start out absent.
rm -f "${DEAD_MAN_DIR}/$STEP.fired" "${DEAD_MAN_DIR}/$STEP.cancelled"
systemd-run --quiet --unit="$UNIT" --on-active="\${DELAY}s" --timer-property=AccuracySec=1s /bin/sh "${DEAD_MAN_DIR}/$STEP.undo.sh"
systemctl is-active --quiet "$UNIT.timer" || fail 'OpsCrew could not schedule the automatic undo, so it changed nothing.'
echo armed`,
  );
}

/**
 * Cancels the scheduled undo; prints `cancelled`, or `fired` when it already ran (or started).
 * Stopping the timer cannot stop an undo that has begun, so the cancel and the undo take turns
 * with `flock` on `$STEP.lock`: an undo holding the lock finishes first and leaves `$STEP.fired`;
 * otherwise the cancel leaves `$STEP.cancelled`, and an undo that starts later does nothing.
 * The lock and the cancelled mark stay until the next arm.
 */
export function cancelScript(step: GuardedStep): string {
  return buildScript(
    `deadman.cancel.${step}`,
    { STEP: step, UNIT: deadManUnit(step) },
    `systemctl stop "$UNIT.timer" >/dev/null 2>&1 || true
install -d -m 0700 ${OPSCREW_DIR} ${DEAD_MAN_DIR}
exec 9>"${DEAD_MAN_DIR}/$STEP.lock"
if flock -w 80 9; then
  if [ -e "${DEAD_MAN_DIR}/$STEP.fired" ]; then result=fired
  else
    touch "${DEAD_MAN_DIR}/$STEP.cancelled"
    result=cancelled
  fi
else
  # An undo still holds the lock after 80 seconds: count the change as undone.
  result=fired
fi
rm -f "${DEAD_MAN_DIR}/$STEP.undo.sh" "${DEAD_MAN_DIR}/$STEP.prev" "${DEAD_MAN_DIR}/$STEP.fired"
echo "$result"`,
  );
}

/** Runs the scheduled undo now and cancels the timer. */
export function triggerScript(step: GuardedStep): string {
  return buildScript(
    `deadman.trigger.${step}`,
    { STEP: step, UNIT: deadManUnit(step) },
    `if [ -f "${DEAD_MAN_DIR}/$STEP.undo.sh" ]; then sh "${DEAD_MAN_DIR}/$STEP.undo.sh"; fi
systemctl stop "$UNIT.timer" >/dev/null 2>&1 || true
rm -f "${DEAD_MAN_DIR}/$STEP".*
echo restored`,
  );
}

/** Reads `/etc/opscrew/host.json`; prints nothing when it does not exist. */
export function readRecordScript(): string {
  return buildScript(
    "record.read",
    { RECORD_PATH },
    `if [ -f "$RECORD_PATH" ]; then cat "$RECORD_PATH"; fi`,
  );
}

/** Writes `/etc/opscrew/host.json` (root only) atomically. `json` has no secrets. */
export function writeRecordScript(json: string): string {
  return buildScript(
    "record.write",
    { RECORD_PATH, RECORD: json },
    `${APT_FUNCTIONS}
install -d -m 0700 ${OPSCREW_DIR}
printf '%s\\n' "$RECORD" | write_file "$RECORD_PATH" 0600`,
  );
}
