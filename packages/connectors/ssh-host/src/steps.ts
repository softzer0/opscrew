// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell and Go templates, not JavaScript templates.
/**
 * Fixed shell templates for every host step. Each step has a read-only `check` (prints
 * `state=in-place|change` and the current values as `prev.<key>=<value>`), an `apply`, and a
 * `verify` that proves the change took effect. Parameters are validated here and shell-quoted by
 * `buildScript`; secrets never appear in a script, they arrive on stdin.
 */
import { createHash } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import {
  ADDONS_ROOT,
  DOCKER_DAEMON_JSON,
  DOCKER_DAEMON_JSON_PATH,
  DOCKER_PACKAGES,
  FAIL2BAN_JAIL_PATH,
  fail2banJail,
  MIN_DOCKER_MAJOR,
  PORTAINER_DIR,
  PORTAINER_PORT,
  PORTAINER_PROJECT,
  READY_FLAG,
  SSHD_HEADER,
  TUNNEL_DIR,
  TUNNEL_PROJECT,
  UFW_SSH_COMMENT,
  UFW_WEB_COMMENT,
  WEB_RULES,
} from "./constants";
import {
  AUTO_UPGRADES_FILE,
  MARKER_PATH,
  OPSCREW_DIR,
  RECORD_PATH,
  RUNTIME_DIRS,
  SSHD_DROP_IN,
} from "./facts";
import { canonicalCidr } from "./parse";
import { APT_FUNCTIONS, APT_LOG, buildScript, type ScriptParams } from "./shell";
import {
  ComposeTextSchema,
  type HostPlan,
  type HostStep,
  type HostStepId,
  TunnelIdSchema,
} from "./types";
import {
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

export const DEAD_MAN_DIR = `${OPSCREW_DIR}/deadman`;
export const BACKUP_DIR = `${OPSCREW_DIR}/backup`;
export const SSHD_BACKUP = `${BACKUP_DIR}/10-opscrew.conf`;

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
const AppNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);

/** Wraps a verify body in `verify_state` and adds the check's state line. */
function checkScript(
  name: string,
  p: ScriptParams,
  helpers: string,
  verify: string,
  snapshot: string,
) {
  return buildScript(
    `${name}.check`,
    p,
    `${APT_FUNCTIONS}
${helpers}
verify_state() {
${verify}
}
${snapshot}
if verify_state >/dev/null 2>&1; then echo state=in-place; else echo state=change; fi`,
    { tolerant: true },
  );
}

function verifyScript(
  name: string,
  p: ScriptParams,
  helpers: string,
  verify: string,
  message: string,
) {
  return buildScript(
    `${name}.verify`,
    { ...p, VERIFY_FAILED: message },
    `${APT_FUNCTIONS}
${helpers}
verify_state() {
${verify}
}
verify_state || fail "$VERIFY_FAILED" 5`,
  );
}

/**
 * A changing script. It ignores SIGHUP and SIGPIPE, so a dropped SSH session never stops it
 * half-way (apt and dpkg keep going; their output goes to a log file, not the session).
 */
function applyScript(name: string, p: ScriptParams, helpers: string, body: string) {
  return buildScript(`${name}.apply`, p, `trap '' HUP PIPE\n${APT_FUNCTIONS}\n${helpers}\n${body}`);
}

// ---------------------------------------------------------------------------------------------
// package-repair: finish an interrupted dpkg run before anything else uses apt

function packageRepairScripts(): StepScripts {
  const sp = { UPDATES: "/var/lib/dpkg/updates" };
  const verify = `  [ -z "$(ls -A "$UPDATES" 2>/dev/null)" ]`;
  const apply = `install -d -m 0700 "$(dirname '${APT_LOG}')"
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
done`;
  return {
    check: checkScript("package-repair", sp, "", verify, "echo prev.interrupted=true"),
    apply: applyScript("package-repair", sp, "", apply),
    verify: verifyScript(
      "package-repair",
      sp,
      "",
      verify,
      "dpkg still reports an interrupted run.",
    ),
    doing: "finishing the interrupted package installation",
    timeoutMs: 10 * MINUTE,
  };
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
  const sp = {
    DISTRO: p.distro,
    MIN_MAJOR: MIN_DOCKER_MAJOR,
    PACKAGES: DOCKER_ACTION_PACKAGES[p.action],
  };
  const helpers = `docker_major() {
  v=$(dpkg-query -W -f='\${Version}' docker-ce 2>/dev/null) || return 1
  printf '%s' "$v" | sed -e 's/^[0-9]*://' -e 's/^\\([0-9]*\\).*/\\1/'
}`;
  const verify = `  major=$(docker_major) || return 1
  [ -n "$major" ] && [ "$major" -ge "$MIN_MAJOR" ] || return 1
  is_installed docker-compose-plugin || return 1
  is_installed docker-buildx-plugin || return 1
  systemctl is-active --quiet docker || return 1
  docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || return 1`;
  const snapshot = `v=$(dpkg-query -W -f='\${Version}' docker-ce 2>/dev/null) || v=''
echo "prev.engine=\${v:-absent}"
if grep -qs 'download.docker.com' /etc/apt/sources.list /etc/apt/sources.list.d/*; then echo prev.repository=present; else echo prev.repository=absent; fi`;
  const apply = `. /etc/os-release
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
[ "\${major:-0}" -ge "$MIN_MAJOR" ] || fail "Docker's repository did not offer Docker Engine $MIN_MAJOR or newer for this release."`;
  return {
    check: checkScript("docker", sp, helpers, verify, snapshot),
    apply: applyScript("docker", sp, helpers, apply),
    verify: verifyScript(
      "docker",
      sp,
      helpers,
      verify,
      `Docker Engine ${MIN_DOCKER_MAJOR} or newer with the Compose plugin is not running after the install.`,
    ),
    doing: "installing Docker Engine",
    timeoutMs: 30 * MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// deploy-user

const DeployParams = z.object({
  user: z.literal("deploy"),
  publicKey: z.string().regex(/^[a-z0-9@.-]+ [A-Za-z0-9+/]+={0,3}( [^\r\n\0]{0,200})?$/),
});

function deployUserScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    const sp = { USER_NAME: "deploy" };
    const verify = `  ! getent passwd "$USER_NAME" >/dev/null 2>&1`;
    return {
      check: checkScript(
        "deploy-user.undo",
        sp,
        "",
        verify,
        `if getent passwd "$USER_NAME" >/dev/null 2>&1; then echo prev.existed=true; else echo prev.existed=false; fi`,
      ),
      apply: applyScript(
        "deploy-user.undo",
        sp,
        "",
        `if getent passwd "$USER_NAME" >/dev/null 2>&1; then
  pkill -u "$USER_NAME" >/dev/null 2>&1 || true
  sleep 1
  userdel -r "$USER_NAME" >/dev/null 2>&1 || userdel "$USER_NAME" >/dev/null 2>&1 || true
fi
if getent passwd "$USER_NAME" >/dev/null 2>&1; then fail "OpsCrew could not remove the $USER_NAME user; it may still be logged in."; fi
if getent group "$USER_NAME" >/dev/null 2>&1 && [ -z "$(getent group "$USER_NAME" | cut -d: -f4)" ]; then groupdel "$USER_NAME" >/dev/null 2>&1 || true; fi`,
      ),
      verify: verifyScript("deploy-user.undo", sp, "", verify, "The deploy user still exists."),
      doing: "removing the deploy user",
      timeoutMs: 2 * MINUTE,
    };
  }
  const p = params(step, DeployParams);
  const sp = { USER_NAME: p.user, PUBLIC_KEY: p.publicKey };
  const helpers = `user_home() { getent passwd "$USER_NAME" | cut -d: -f6; }`;
  const verify = `  getent passwd "$USER_NAME" >/dev/null 2>&1 || return 1
  home=$(user_home)
  [ "$(cat "$home/.ssh/authorized_keys" 2>/dev/null)" = "$PUBLIC_KEY" ] || return 1
  id -nG "$USER_NAME" | tr ' ' '\\n' | grep -qx docker || return 1`;
  const snapshot = `if getent passwd "$USER_NAME" >/dev/null 2>&1; then echo prev.existed=true; else echo prev.existed=false; fi
if id -nG "$USER_NAME" 2>/dev/null | tr ' ' '\\n' | grep -qx docker; then echo prev.dockerGroup=true; else echo prev.dockerGroup=false; fi`;
  const apply = `getent group docker >/dev/null 2>&1 || fail 'The docker group is missing; Docker must be installed first.'
if ! getent passwd "$USER_NAME" >/dev/null 2>&1; then
  useradd --create-home --user-group --shell /bin/bash "$USER_NAME"
  # "*" means no password login at all, without marking the account locked for key logins.
  usermod -p '*' "$USER_NAME"
fi
home=$(user_home)
if [ -z "$home" ] || [ "$home" = / ]; then fail "The $USER_NAME user has no home directory."; fi
if [ -L "$home/.ssh" ]; then fail "$home/.ssh is a symbolic link; OpsCrew does not follow it."; fi
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$home/.ssh"
keys="$home/.ssh/authorized_keys"
if [ -L "$keys" ]; then fail "$keys is a symbolic link; OpsCrew does not follow it."; fi
# OpsCrew created this user: its keys file holds exactly the current deploy key, so an old
# deploy key stops working. Written beside the old file and renamed over it in one step.
tmp=$(mktemp "$home/.ssh/.authorized_keys.XXXXXX")
printf '%s\\n' "$PUBLIC_KEY" > "$tmp"
chown "$USER_NAME:$USER_NAME" "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$keys"
usermod -aG docker "$USER_NAME"`;
  return {
    check: checkScript("deploy-user", sp, helpers, verify, snapshot),
    apply: applyScript("deploy-user", sp, helpers, apply),
    verify: verifyScript(
      "deploy-user",
      sp,
      helpers,
      verify,
      "The deploy user does not have the deploy key or Docker access after the change.",
    ),
    doing: "creating the deploy user",
    timeoutMs: 2 * MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// sshd

const SshdParams = z.object({
  permitRootLogin: z.enum(["no", "prohibit-password"]),
  disablePasswords: z.boolean(),
  kbdInteractiveOff: z.boolean(),
});

const SSHD_RELOAD =
  "systemctl try-reload-or-restart ssh.service 2>/dev/null || systemctl try-reload-or-restart sshd.service";

/**
 * Dead-man capture shared by sshd setup and undo: restore the drop-in as it is right now. The
 * undo marks itself as fired first (so a cancel racing it knows), and brings a stopped or failed
 * ssh unit back (reset-failed, then reload-or-restart; Debian/Ubuntu call it ssh.service).
 */
const SSHD_CAPTURE = `if [ -f ${SSHD_DROP_IN} ]; then cp -p ${SSHD_DROP_IN} ${DEAD_MAN_DIR}/sshd.prev; else rm -f ${DEAD_MAN_DIR}/sshd.prev; fi
cat > ${DEAD_MAN_DIR}/sshd.undo.sh <<'OPSCREW_UNDO'
#!/bin/sh
# Written by OpsCrew: puts the previous SSH settings back.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
# Takes turns with a cancel: whoever holds the lock first decides; a cancelled undo does nothing.
exec 9>${DEAD_MAN_DIR}/sshd.lock
flock 9
if [ -e ${DEAD_MAN_DIR}/sshd.cancelled ]; then exit 0; fi
touch ${DEAD_MAN_DIR}/sshd.fired
if [ -f ${DEAD_MAN_DIR}/sshd.prev ]; then cp -p ${DEAD_MAN_DIR}/sshd.prev ${SSHD_DROP_IN}; else rm -f ${SSHD_DROP_IN}; fi
systemctl reset-failed ssh.service sshd.service >/dev/null 2>&1 || true
systemctl reload-or-restart ssh.service >/dev/null 2>&1 || systemctl reload-or-restart sshd.service >/dev/null 2>&1 || true
OPSCREW_UNDO`;

function sshdScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  const timer = "! systemctl is-active --quiet opscrew-undo-sshd.timer";
  if (purpose === "undo") {
    const sp = { DROPIN: SSHD_DROP_IN, BACKUP: SSHD_BACKUP, HEADER: SSHD_HEADER };
    const verify = `  if [ -f "$BACKUP" ]; then cmp -s "$BACKUP" "$DROPIN" || return 1
  elif [ -f "$DROPIN" ]; then return 1; fi
  ${timer}`;
    const apply = `if [ -f "$BACKUP" ]; then cp -p "$BACKUP" "$DROPIN"; else rm -f "$DROPIN"; fi
[ -d /run/sshd ] || install -d -m 0755 /run/sshd
if ! sshd -t >/dev/null 2>&1; then
  sh ${DEAD_MAN_DIR}/sshd.undo.sh >/dev/null 2>&1 || true
  fail 'The previous SSH settings did not pass sshd -t, so OpsCrew kept its own.' 4
fi
${SSHD_RELOAD}`;
    return {
      check: checkScript(
        "sshd.undo",
        sp,
        "",
        verify,
        `if [ -f "$DROPIN" ]; then echo prev.dropIn=present; else echo prev.dropIn=absent; fi`,
      ),
      apply: applyScript("sshd.undo", sp, "", apply),
      verify: verifyScript("sshd.undo", sp, "", verify, "The previous SSH settings are not back."),
      deadMan: { step: "sshd", capture: SSHD_CAPTURE, params: {} },
      doing: "restoring the previous SSH settings",
      timeoutMs: 2 * MINUTE,
    };
  }
  const p = params(step, SshdParams);
  const sp = {
    DROPIN: SSHD_DROP_IN,
    BACKUP: SSHD_BACKUP,
    HEADER: SSHD_HEADER,
    ROOT_LOGIN: p.permitRootLogin,
    PASSWORDS_OFF: p.disablePasswords,
    KBD_OFF: p.kbdInteractiveOff,
  };
  const helpers = `config_ok() {
  eff=$(sshd -T 2>/dev/null) || return 1
  alt=$ROOT_LOGIN
  if [ "$ROOT_LOGIN" = prohibit-password ]; then alt=without-password; fi
  printf '%s\\n' "$eff" | grep -Eqx "permitrootlogin ($ROOT_LOGIN|$alt)" || return 1
  if [ "$PASSWORDS_OFF" = true ]; then printf '%s\\n' "$eff" | grep -qx 'passwordauthentication no' || return 1; fi
  if [ "$KBD_OFF" = true ]; then printf '%s\\n' "$eff" | grep -Eqx '(kbdinteractiveauthentication|challengeresponseauthentication) no' || return 1; fi
  return 0
}
expected_dropin() {
  printf '%s\\n' "$HEADER"
  printf 'PermitRootLogin %s\\n' "$ROOT_LOGIN"
  if [ "$PASSWORDS_OFF" = true ]; then printf '%s\\n' 'PasswordAuthentication no'; fi
  if [ "$KBD_OFF" = true ]; then printf '%s\\n' 'KbdInteractiveAuthentication no'; fi
}
dropin_ok() { [ "$(cat "$DROPIN" 2>/dev/null)" = "$(expected_dropin)" ]; }`;
  const verify = `  config_ok || return 1
  dropin_ok || return 1
  ${timer}`;
  const snapshot = `if [ -f "$DROPIN" ]; then echo prev.dropIn=present; else echo prev.dropIn=absent; fi
eff=$(sshd -T 2>/dev/null) || eff=''
echo "prev.permitRootLogin=$(printf '%s\\n' "$eff" | sed -n 's/^permitrootlogin //p' | head -n 1)"
echo "prev.passwordAuthentication=$(printf '%s\\n' "$eff" | sed -n 's/^passwordauthentication //p' | head -n 1)"`;
  const apply = `install -d -m 0755 /etc/ssh/sshd_config.d
install -d -m 0700 ${OPSCREW_DIR} ${BACKUP_DIR}
# Keep the file that was there before OpsCrew, once, for undo.
if [ -f "$DROPIN" ] && [ ! -e "$BACKUP" ] && ! head -n 1 "$DROPIN" | grep -qxF -- "$HEADER"; then cp -p "$DROPIN" "$BACKUP"; fi
tmp=$(mktemp /etc/ssh/sshd_config.d/.opscrew.XXXXXX)
expected_dropin > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$DROPIN"
[ -d /run/sshd ] || install -d -m 0755 /run/sshd
if ! sshd -t >/dev/null 2>&1; then
  sh ${DEAD_MAN_DIR}/sshd.undo.sh >/dev/null 2>&1 || true
  fail 'The new SSH settings did not pass sshd -t, so OpsCrew put the previous ones back.' 4
fi
if ! config_ok; then
  sh ${DEAD_MAN_DIR}/sshd.undo.sh >/dev/null 2>&1 || true
  fail 'Another SSH setting takes precedence over the file OpsCrew writes (a file in /etc/ssh/sshd_config.d that is read first, or a Match block), so OpsCrew put the previous settings back.' 4
fi
${SSHD_RELOAD}`;
  return {
    check: checkScript("sshd", sp, helpers, verify, snapshot),
    apply: applyScript("sshd", sp, helpers, apply),
    verify: verifyScript("sshd", sp, helpers, verify, "The SSH settings are not in effect."),
    deadMan: { step: "sshd", capture: SSHD_CAPTURE, params: {} },
    doing: "changing the SSH settings",
    timeoutMs: 2 * MINUTE,
  };
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

function ufwScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  const timer = "! systemctl is-active --quiet opscrew-undo-ufw.timer";
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
    const verify = `  if ! command -v ufw >/dev/null 2>&1; then return 0; fi
  ADDED=$(ufw_added)
  for r in $REMOVE_RULES; do if has_rule "$r"; then return 1; fi; done
  if [ "$DISABLE" = true ] && ufw_active; then return 1; fi
  if [ -n "$DEFAULT_INCOMING" ] && [ "$(ufw_policy INPUT)" != "$DEFAULT_INCOMING" ]; then return 1; fi
  if [ -n "$DEFAULT_OUTGOING" ] && [ "$(ufw_policy OUTPUT)" != "$DEFAULT_OUTGOING" ]; then return 1; fi
  if [ -n "$DEFAULT_ROUTED" ] && [ "$(ufw_policy FORWARD)" != "$DEFAULT_ROUTED" ]; then return 1; fi
  ${timer}`;
    const capture = `ADDED=$(ufw_added)
was_active=no
if ufw_active; then was_active=yes; fi
{
  echo '#!/bin/sh'
  echo '# Written by OpsCrew: puts back the firewall rules OpsCrew was removing.'
  echo 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH'
  echo 'exec 9>${DEAD_MAN_DIR}/ufw.lock'
  echo 'flock 9'
  echo 'if [ -e ${DEAD_MAN_DIR}/ufw.cancelled ]; then exit 0; fi'
  echo 'touch ${DEAD_MAN_DIR}/ufw.fired'
  policy_lines
  for r in $REMOVE_RULES; do if has_rule "$r"; then echo "ufw allow $r >/dev/null 2>&1 || true"; fi; done
  if [ "$was_active" = yes ]; then echo 'ufw --force enable >/dev/null 2>&1 || true'; fi
} > ${DEAD_MAN_DIR}/ufw.undo.sh`;
    const apply = `command -v ufw >/dev/null 2>&1 || exit 0
# The default policies OpsCrew set go back to what they were first, so a default of "allow" is
# back before OpsCrew's SSH rule goes (SSH is never closed in between); ufw goes off last.
if [ -n "$DEFAULT_INCOMING" ]; then ufw default "$DEFAULT_INCOMING" incoming >/dev/null; fi
if [ -n "$DEFAULT_OUTGOING" ]; then ufw default "$DEFAULT_OUTGOING" outgoing >/dev/null; fi
if [ -n "$DEFAULT_ROUTED" ]; then ufw default "$DEFAULT_ROUTED" routed >/dev/null; fi
for r in $REMOVE_RULES; do ufw --force delete allow "$r" >/dev/null 2>&1 || true; done
if [ "$DISABLE" = true ]; then ufw --force disable >/dev/null; fi`;
    return {
      check: checkScript(
        "ufw.undo",
        sp,
        UFW_HELPERS,
        verify,
        "if ufw_active; then echo prev.active=true; else echo prev.active=false; fi",
      ),
      apply: applyScript("ufw.undo", sp, UFW_HELPERS, apply),
      verify: verifyScript(
        "ufw.undo",
        sp,
        UFW_HELPERS,
        verify,
        "OpsCrew's firewall rules are still there.",
      ),
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
    };
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
  // SSH_PORTS and WEB_ADD hold only what no existing rule covers (the plan worked that out from
  // the rules on the server, including source-limited and "limit" rules).
  const verify = `  command -v ufw >/dev/null 2>&1 || return 1
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
  ${timer}`;
  const snapshot = `if command -v ufw >/dev/null 2>&1; then echo prev.installed=true; else echo prev.installed=false; fi
if ufw_active; then echo prev.active=true; else echo prev.active=false; fi
echo "prev.rules=$(ufw_added | sed -n -e "s/^ufw //" -e "s/ comment '.*'\\$//" -e '/^[a-z]/p' | tr '\\n' ',' | sed 's/,$//')"
echo "prev.defaultIncoming=$(ufw_policy INPUT)"
echo "prev.defaultOutgoing=$(ufw_policy OUTPUT)"
echo "prev.defaultRouted=$(ufw_policy FORWARD)"`;
  // The undo the dead-man runs: delete the rules this change adds, put the default policies back
  // and turn ufw off if it was off.
  const capture = `ADDED=$(ufw_added)
was_active=no
if ufw_active; then was_active=yes; fi
{
  echo '#!/bin/sh'
  echo '# Written by OpsCrew: puts the previous firewall state back.'
  echo 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH'
  echo 'exec 9>${DEAD_MAN_DIR}/ufw.lock'
  echo 'flock 9'
  echo 'if [ -e ${DEAD_MAN_DIR}/ufw.cancelled ]; then exit 0; fi'
  echo 'touch ${DEAD_MAN_DIR}/ufw.fired'
  if [ "$was_active" = no ]; then echo 'ufw --force disable >/dev/null 2>&1 || true'; fi
  policy_lines
  for port in $SSH_PORTS; do if ! has_rule "$port/tcp"; then echo "ufw --force delete allow $port/tcp >/dev/null 2>&1 || true"; fi; done
  for r in $WEB_ADD; do if ! has_rule "$r"; then echo "ufw --force delete allow $r >/dev/null 2>&1 || true"; fi; done
  if [ "$WEB" != true ]; then
    for r in $WEB_RULES; do if has_own_rule "$r" "$WEB_COMMENT"; then echo "ufw allow $r comment '$WEB_COMMENT' >/dev/null 2>&1 || true"; fi; done
  fi
} > ${DEAD_MAN_DIR}/ufw.undo.sh`;
  const apply = `command -v ufw >/dev/null 2>&1 || fail 'ufw is not installed.'
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
ufw_active || fail 'ufw did not turn on.'`;
  return {
    check: checkScript("ufw", sp, UFW_HELPERS, verify, snapshot),
    preApply: p.install
      ? applyScript(
          "ufw.install",
          {},
          "",
          "if ! command -v ufw >/dev/null 2>&1; then apt_get update; apt_get install ufw; fi",
        )
      : undefined,
    apply: applyScript("ufw", sp, UFW_HELPERS, apply),
    verify: verifyScript("ufw", sp, UFW_HELPERS, verify, "The firewall rules are not in effect."),
    deadMan: { step: "ufw", capture, params: sp },
    doing: "setting up the ufw firewall",
    timeoutMs: 5 * MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// web-filter: only Cloudflare reaches the web ports Docker publishes (see web-filter.ts)

/** Space-separated IPv4 networks in the form `canonicalCidr` gives, sorted, without duplicates. */
const Ipv4NetworksSchema = z
  .string()
  .regex(/^[0-9./]{7,18}( [0-9./]{7,18})*$/)
  .refine(
    (value) => {
      const list = value.split(" ");
      return (
        list.every((net) => {
          const network = canonicalCidr(net);
          return network?.family === "ipv4" && network.cidr === net;
        }) && list.join(" ") === [...new Set(list)].sort().join(" ")
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
write_file() {
  install -d -m 0755 "$(dirname "$1")"
  tmp=$(mktemp "$(dirname "$1")/.opscrew.XXXXXX")
  printf '%s' "$2" | base64 -d > "$tmp"
  chmod "$3" "$tmp"
  mv -f "$tmp" "$1"
}
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
    const verify = `  [ ! -e "$SCRIPT" ] && [ ! -e "$UNIT_FILE" ] && [ ! -e "$DROP_IN" ] || return 1
  if command -v iptables >/dev/null 2>&1 && iptables -w -n -L "$CHAIN" >/dev/null 2>&1; then
    return 1
  fi`;
    // Docker first stops requiring the filter (it keeps running), then the rules and files go.
    const apply = `rm -f "$DROP_IN"
systemctl daemon-reload
systemctl disable "$SERVICE" >/dev/null 2>&1 || true
systemctl stop "$SERVICE" >/dev/null 2>&1 || true
remove_rules
rm -f "$UNIT_FILE" "$SCRIPT"
systemctl daemon-reload`;
    return {
      check: checkScript("web-filter.remove", files, WEB_FILTER_HELPERS, verify, ""),
      apply: applyScript("web-filter.remove", files, WEB_FILTER_HELPERS, apply),
      verify: verifyScript(
        "web-filter.remove",
        files,
        WEB_FILTER_HELPERS,
        verify,
        "OpsCrew's web filter is still on the server.",
      ),
      doing: "removing OpsCrew's web filter",
      timeoutMs: 2 * MINUTE,
    };
  }
  const script = webFilterScript({ ipv4: p.ipv4.split(" ") });
  const sp = {
    ...files,
    SCRIPT_B64: base64(script),
    UNIT_B64: base64(WEB_FILTER_UNIT_TEXT),
    DROPIN_B64: base64(WEB_FILTER_DROP_IN_TEXT),
    SCRIPT_SHA256: sha256(script),
    UNIT_SHA256: sha256(WEB_FILTER_UNIT_TEXT),
    DROPIN_SHA256: sha256(WEB_FILTER_DROP_IN_TEXT),
    IPV4: p.ipv4,
  };
  const verify = `  file_is "$SCRIPT" "$SCRIPT_SHA256" || return 1
  file_is "$UNIT_FILE" "$UNIT_SHA256" || return 1
  file_is "$DROP_IN" "$DROPIN_SHA256" || return 1
  [ "$(systemctl is-enabled "$SERVICE" 2>/dev/null)" = enabled ] || return 1
  systemctl is-active --quiet "$SERVICE" || return 1
  chain_ok "$IPV4" || return 1
  leading_ok || return 1`;
  const snapshot = `if [ -e "$SCRIPT" ]; then echo prev.installed=true; else echo prev.installed=false; fi`;
  // The script installs the rules right away (an atomic change of OpsCrew's chain; Docker keeps
  // running). Only once it worked does Docker start to require the unit, so a failure here never
  // leaves a Docker that cannot start.
  const apply = `${WEB_FILTER_BACKEND_CHECK}
if systemctl is-active --quiet docker && ! iptables -w -n -L DOCKER-USER >/dev/null 2>&1; then
  fail "Docker is running but has no DOCKER-USER chain in iptables, so OpsCrew's web filter cannot work. Nothing was changed."
fi
write_file "$SCRIPT" "$SCRIPT_B64" 0755
write_file "$UNIT_FILE" "$UNIT_B64" 0644
"$SCRIPT" || fail "OpsCrew could not install its web filter (see the message above); Docker was not changed."
write_file "$DROP_IN" "$DROPIN_B64" 0644
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
# Starting the unit runs the script once more (no change); Docker is not restarted.
systemctl start "$SERVICE"`;
  return {
    check: checkScript("web-filter", sp, WEB_FILTER_HELPERS, verify, snapshot),
    apply: applyScript("web-filter", sp, WEB_FILTER_HELPERS, apply),
    verify: verifyScript(
      "web-filter",
      sp,
      WEB_FILTER_HELPERS,
      verify,
      "OpsCrew's web filter is not in effect.",
    ),
    doing: "setting up the web filter for Cloudflare's addresses",
    timeoutMs: 2 * MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// unattended-upgrades

function upgradesScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  const sp = { CONF: AUTO_UPGRADES_FILE };
  if (purpose === "undo") {
    const p = params(step, z.object({ removePackage: z.boolean(), disableService: z.boolean() }));
    const verify = `  [ ! -e "$CONF" ] || return 1
  if [ "$REMOVE_PACKAGE" = true ]; then ! is_installed unattended-upgrades || return 1; fi
  if [ "$DISABLE_SERVICE" = true ]; then [ "$(systemctl is-enabled unattended-upgrades 2>/dev/null)" != enabled ] || return 1; fi`;
    const up = { ...sp, REMOVE_PACKAGE: p.removePackage, DISABLE_SERVICE: p.disableService };
    return {
      check: checkScript("unattended-upgrades.undo", up, "", verify, ""),
      apply: applyScript(
        "unattended-upgrades.undo",
        up,
        "",
        `rm -f "$CONF"
if [ "$DISABLE_SERVICE" = true ]; then systemctl disable --now unattended-upgrades.service >/dev/null 2>&1 || true; fi
if [ "$REMOVE_PACKAGE" = true ] && is_installed unattended-upgrades; then apt_get remove unattended-upgrades; fi`,
      ),
      verify: verifyScript(
        "unattended-upgrades.undo",
        up,
        "",
        verify,
        "OpsCrew's automatic-update settings are still there.",
      ),
      doing: "removing OpsCrew's automatic-update settings",
      timeoutMs: 10 * MINUTE,
    };
  }
  const verify = `  is_installed unattended-upgrades || return 1
  dump=$(apt-config dump 2>/dev/null) || return 1
  printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Update-Package-Lists "1";' || return 1
  printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Unattended-Upgrade "1";' || return 1
  [ "$(systemctl is-enabled unattended-upgrades 2>/dev/null)" = enabled ] || return 1`;
  const snapshot = `if is_installed unattended-upgrades; then echo prev.installed=true; else echo prev.installed=false; fi
if [ -e "$CONF" ]; then echo prev.file=present; else echo prev.file=absent; fi
if [ "$(systemctl is-enabled unattended-upgrades 2>/dev/null)" = enabled ]; then echo prev.serviceEnabled=true; else echo prev.serviceEnabled=false; fi`;
  const apply = `if ! is_installed unattended-upgrades; then apt_get update; apt_get install unattended-upgrades; fi
dump=$(apt-config dump 2>/dev/null) || dump=''
if ! printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Unattended-Upgrade "1";' || ! printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Update-Package-Lists "1";'; then
  tmp=$(mktemp /etc/apt/.opscrew.XXXXXX)
  printf '%s\\n' '// Managed by OpsCrew: automatic security updates.' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$CONF"
fi
systemctl enable --now unattended-upgrades.service >/dev/null`;
  return {
    check: checkScript("unattended-upgrades", sp, "", verify, snapshot),
    apply: applyScript("unattended-upgrades", sp, "", apply),
    verify: verifyScript(
      "unattended-upgrades",
      sp,
      "",
      verify,
      "Automatic security updates are not on after the change (another file in /etc/apt/apt.conf.d may turn them off).",
    ),
    doing: "turning on automatic security updates",
    timeoutMs: 10 * MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// docker-daemon: OpsCrew's /etc/docker/daemon.json, only where there is none

function dockerDaemonScripts(purpose: HostPlan["purpose"]): StepScripts {
  const sp = {
    DAEMON_JSON: DOCKER_DAEMON_JSON_PATH,
    CONTENT_B64: base64(DOCKER_DAEMON_JSON),
    CONTENT_SHA256: sha256(DOCKER_DAEMON_JSON),
  };
  const helpers = `ours() { [ -f "$DAEMON_JSON" ] && [ "$(sha256sum "$DAEMON_JSON" | cut -d ' ' -f 1)" = "$CONTENT_SHA256" ]; }`;
  if (purpose === "undo") {
    const verify = "  ! ours";
    return {
      check: checkScript("docker-daemon.undo", sp, helpers, verify, ""),
      apply: applyScript(
        "docker-daemon.undo",
        sp,
        helpers,
        `# Only the file exactly as OpsCrew wrote it goes; a file the user changed stays.
if ours; then
  rm -f "$DAEMON_JSON"
  systemctl reload docker >/dev/null 2>&1 || true
fi`,
      ),
      verify: verifyScript(
        "docker-daemon.undo",
        sp,
        helpers,
        verify,
        "OpsCrew's daemon.json is still there.",
      ),
      doing: "removing OpsCrew's Docker daemon settings",
      timeoutMs: 2 * MINUTE,
    };
  }
  // The user's own settings count as in place and are never overwritten: their daemon.json,
  // the same options given as dockerd flags (Docker refuses to start when a flag and daemon.json
  // set the same option), or an active Swarm (which does not allow live-restore).
  const setupHelpers = `${helpers}
own_settings() {
  if systemctl show -p ExecStart docker 2>/dev/null | grep -Eq -- '--(log-driver|log-opt|live-restore|no-new-privileges)'; then return 0; fi
  if systemctl is-active --quiet docker && [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = active ]; then return 0; fi
  return 1
}
busy() { systemctl is-active --quiet docker && [ -n "$(docker ps -q 2>/dev/null)" ]; }`;
  const verify = `  [ -f "$DAEMON_JSON" ] || own_settings`;
  const apply = `if [ -e "$DAEMON_JSON" ] || own_settings; then exit 0; fi
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
fi`;
  return {
    check: checkScript(
      "docker-daemon",
      sp,
      setupHelpers,
      verify,
      `if [ -e "$DAEMON_JSON" ]; then echo prev.file=present; else echo prev.file=absent; fi`,
    ),
    apply: applyScript("docker-daemon", sp, setupHelpers, apply),
    verify: verifyScript(
      "docker-daemon",
      sp,
      setupHelpers,
      verify,
      "/etc/docker/daemon.json is missing.",
    ),
    doing: "writing Docker's daemon settings",
    timeoutMs: 5 * MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// fail2ban: a jail for SSH on every real sshd port

function fail2banScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  if (purpose === "undo") {
    const p = params(step, z.object({ removePackage: z.boolean(), disableService: z.boolean() }));
    const sp = {
      JAIL: FAIL2BAN_JAIL_PATH,
      REMOVE_PACKAGE: p.removePackage,
      DISABLE_SERVICE: p.disableService,
    };
    const verify = `  [ ! -e "$JAIL" ] || return 1
  if [ "$REMOVE_PACKAGE" = true ]; then ! is_installed fail2ban || return 1; fi
  if [ "$DISABLE_SERVICE" = true ]; then ! systemctl is-active --quiet fail2ban || return 1; fi`;
    return {
      check: checkScript("fail2ban.undo", sp, "", verify, ""),
      apply: applyScript(
        "fail2ban.undo",
        sp,
        "",
        `rm -f "$JAIL"
if [ "$REMOVE_PACKAGE" = true ]; then
  if is_installed fail2ban; then apt_get remove fail2ban; fi
elif [ "$DISABLE_SERVICE" = true ]; then
  systemctl disable --now fail2ban >/dev/null 2>&1 || true
else
  systemctl try-reload-or-restart fail2ban >/dev/null 2>&1 || true
fi`,
      ),
      verify: verifyScript(
        "fail2ban.undo",
        sp,
        "",
        verify,
        "OpsCrew's fail2ban jail is still there.",
      ),
      doing: "removing OpsCrew's fail2ban jail",
      timeoutMs: 10 * MINUTE,
    };
  }
  const p = params(step, z.object({ sshPorts: PortsSchema, install: z.boolean() }));
  const jail = fail2banJail(p.sshPorts.split(" ").map(Number));
  const sp = { JAIL: FAIL2BAN_JAIL_PATH, JAIL_B64: base64(jail), JAIL_SHA256: sha256(jail) };
  const verify = `  systemctl is-active --quiet fail2ban || return 1
  [ -f "$JAIL" ] && [ "$(sha256sum "$JAIL" | cut -d ' ' -f 1)" = "$JAIL_SHA256" ] || return 1
  fail2ban-client status sshd >/dev/null 2>&1 || return 1`;
  const snapshot = `if is_installed fail2ban; then echo prev.installed=true; else echo prev.installed=false; fi
if systemctl is-active --quiet fail2ban; then echo prev.active=true; else echo prev.active=false; fi
if [ -e "$JAIL" ]; then echo prev.jail=present; else echo prev.jail=absent; fi`;
  const apply = `if ! is_installed fail2ban || ! is_installed python3-systemd; then
  apt_get update
  apt_get install fail2ban python3-systemd
fi
install -d -m 0755 /etc/fail2ban/jail.d
tmp=$(mktemp /etc/fail2ban/.opscrew.XXXXXX)
printf '%s' "$JAIL_B64" | base64 -d > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$JAIL"
systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban
i=0
until fail2ban-client status sshd >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 15 ]; then fail 'fail2ban did not start its SSH jail; run "sudo fail2ban-client -t" on the server to see why.'; fi
  sleep 2
done`;
  return {
    check: checkScript("fail2ban", sp, "", verify, snapshot),
    apply: applyScript("fail2ban", sp, "", apply),
    verify: verifyScript("fail2ban", sp, "", verify, "fail2ban is not guarding SSH."),
    doing: "setting up fail2ban",
    timeoutMs: 10 * MINUTE,
  };
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
// runtime-dirs

function runtimeScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose === "teardown") {
    const p = params(step, z.object({ app: AppNameSchema, deleteData: z.boolean() }));
    const sp = {
      APP: p.app,
      DELETE_DATA: p.deleteData,
      APP_DIR: "/srv/app",
      APP_COMPOSE: "/srv/app/compose.yaml",
      DATA_DIR: "/srv/data",
    };
    const verify = `  project_gone "$APP" "$DELETE_DATA" || return 1
  if [ -d "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR")" ]; then return 1; fi
  if [ "$DELETE_DATA" = true ] && [ -d "$DATA_DIR" ] && [ -n "$(ls -A "$DATA_DIR")" ]; then return 1; fi
  return 0`;
    const apply = `for d in "$APP_DIR" "$DATA_DIR"; do
  if [ -L "$d" ]; then fail "$d is a symbolic link; OpsCrew does not follow it."; fi
done
remove_project "$APP" "$APP_COMPOSE" "$APP_DIR" "$DELETE_DATA"
if [ -d "$APP_DIR" ]; then find "$APP_DIR" -xdev -mindepth 1 -delete; fi
if [ "$DELETE_DATA" = true ] && [ -d "$DATA_DIR" ]; then find "$DATA_DIR" -xdev -mindepth 1 -delete; fi
if [ "$DELETE_DATA" = true ] && ! project_gone "$APP" true; then
  fail 'Some Docker volumes of the app could not be removed.'
fi`;
    return {
      check: checkScript(
        "runtime-dirs.teardown",
        sp,
        PROJECT_HELPERS,
        verify,
        `echo "prev.appFiles=$(ls -A "$APP_DIR" 2>/dev/null | wc -l)"
echo "prev.dataFiles=$(ls -A "$DATA_DIR" 2>/dev/null | wc -l)"`,
      ),
      apply: applyScript("runtime-dirs.teardown", sp, PROJECT_HELPERS, apply),
      verify: verifyScript(
        "runtime-dirs.teardown",
        sp,
        PROJECT_HELPERS,
        verify,
        "Some of the app's containers, volumes or files are still on the server.",
      ),
      doing: "removing the app's containers and files",
      timeoutMs: 10 * MINUTE,
    };
  }
  if (plan.purpose === "undo") {
    const p = params(
      step,
      z.object({ dirs: z.string().regex(/^(\/srv\/(app|data))( \/srv\/(app|data))?$/) }),
    );
    const sp = { DIRS: p.dirs };
    const verify = `  for d in $DIRS; do
    if [ -d "$d" ] && [ ! -L "$d" ] && [ -z "$(ls -A "$d")" ]; then return 1; fi
  done
  return 0`;
    return {
      check: checkScript("runtime-dirs.undo", sp, "", verify, ""),
      apply: applyScript(
        "runtime-dirs.undo",
        sp,
        "",
        `for d in $DIRS; do
  # Only empty directories go; anything with files in it (kept app data) stays.
  if [ -d "$d" ] && [ ! -L "$d" ] && [ -z "$(ls -A "$d")" ]; then rmdir "$d"; fi
done`,
      ),
      verify: verifyScript(
        "runtime-dirs.undo",
        sp,
        "",
        verify,
        "An empty runtime directory is still there.",
      ),
      doing: "removing the empty runtime directories",
      timeoutMs: 2 * MINUTE,
    };
  }
  const sp = { USER_NAME: "deploy", DIRS: RUNTIME_DIRS.join(" ") };
  const verify = `  for d in $DIRS; do
    [ -d "$d" ] && [ ! -L "$d" ] || return 1
    [ "$(stat -c '%U:%G:%a' "$d")" = "$USER_NAME:$USER_NAME:750" ] || return 1
  done`;
  const snapshot = `for d in $DIRS; do
  key=$(basename "$d")
  if [ -e "$d" ]; then echo "prev.$key=present"; else echo "prev.$key=absent"; fi
done`;
  const apply = `for d in $DIRS; do
  if [ -L "$d" ]; then fail "$d is a symbolic link; OpsCrew does not follow it."; fi
  install -d -m 0750 -o "$USER_NAME" -g "$USER_NAME" "$d"
  chown "$USER_NAME:$USER_NAME" "$d"
  chmod 0750 "$d"
done`;
  return {
    check: checkScript("runtime-dirs", sp, "", verify, snapshot),
    apply: applyScript("runtime-dirs", sp, "", apply),
    verify: verifyScript(
      "runtime-dirs",
      sp,
      "",
      verify,
      "/srv/app and /srv/data are not set up for deploy.",
    ),
    doing: "creating /srv/app and /srv/data",
    timeoutMs: 2 * MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// app-marker

function markerScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose === "teardown") {
    const sp = { MARKER_PATH };
    const verify = `  [ ! -e "$MARKER_PATH" ]`;
    return {
      check: checkScript("app-marker.teardown", sp, "", verify, ""),
      apply: applyScript("app-marker.teardown", sp, "", `rm -f "$MARKER_PATH"`),
      verify: verifyScript("app-marker.teardown", sp, "", verify, "The app marker is still there."),
      doing: "removing the app marker",
      timeoutMs: MINUTE,
    };
  }
  if (plan.purpose === "undo") {
    const sp = { OPSCREW_DIR, MARKER_PATH, READY_FLAG };
    const verify = `  [ ! -e "$OPSCREW_DIR" ] && [ ! -e "$READY_FLAG" ]`;
    return {
      check: checkScript("app-marker.undo", sp, "", verify, ""),
      apply: applyScript(
        "app-marker.undo",
        sp,
        "",
        `if [ -e "$MARKER_PATH" ]; then fail 'An OpsCrew app is still on this server; remove it first.'; fi
rm -f "$READY_FLAG"
rm -rf "$OPSCREW_DIR" "$(dirname '${APT_LOG}')"`,
      ),
      verify: verifyScript("app-marker.undo", sp, "", verify, `${OPSCREW_DIR} is still there.`),
      doing: "removing OpsCrew's records",
      timeoutMs: MINUTE,
    };
  }
  const p = params(
    step,
    z.object({
      app: AppNameSchema,
      projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
      ownProject: z.boolean(),
    }),
  );
  const sp = {
    MARKER_PATH,
    MARKER: JSON.stringify({ app: p.app, projectId: p.projectId }),
    READY_FLAG,
    APP: p.app,
    OWN_PROJECT: p.ownProject,
  };
  const verify = `  [ -f "$MARKER_PATH" ] && [ "$(cat "$MARKER_PATH")" = "$MARKER" ] && [ -f "$READY_FLAG" ]`;
  const apply = `install -d -m 0700 ${OPSCREW_DIR}
if [ -f "$MARKER_PATH" ] && [ "$(cat "$MARKER_PATH")" != "$MARKER" ]; then
  fail 'Another OpsCrew app is already on this server; one server runs one OpsCrew app for now.'
fi
# Before the server is marked for the app: no Compose project of that name that OpsCrew did not
# deploy (the plan checked; this checks again on the server itself).
if [ ! -f "$MARKER_PATH" ] && [ "$OWN_PROJECT" != true ] && command -v docker >/dev/null 2>&1; then
  if ! systemctl is-active --quiet docker; then
    fail 'Docker is installed but not running, so OpsCrew cannot see its containers. Start Docker (sudo systemctl start docker), then plan again.'
  fi
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=$APP") ||
    fail 'OpsCrew could not list the Docker containers on this server, so it does not mark the server for the app.'
  volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$APP") ||
    fail 'OpsCrew could not list the Docker volumes on this server, so it does not mark the server for the app.'
  if [ -n "$containers$volumes" ]; then
    fail "Docker already has containers or volumes of a Compose project named $APP that OpsCrew did not deploy, so OpsCrew does not mark this server for the app."
  fi
fi
tmp=$(mktemp ${OPSCREW_DIR}/.app.XXXXXX)
printf '%s\\n' "$MARKER" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$MARKER_PATH"
# The same "setup finished" flag cloud-init sets on servers OpsCrew creates.
install -d -m 0755 "$(dirname "$READY_FLAG")"
touch "$READY_FLAG"`;
  return {
    check: checkScript(
      "app-marker",
      sp,
      "",
      verify,
      `if [ -e "$MARKER_PATH" ]; then echo prev.marker=present; else echo prev.marker=absent; fi`,
    ),
    apply: applyScript("app-marker", sp, "", apply),
    verify: verifyScript("app-marker", sp, "", verify, "The app marker was not written."),
    doing: "marking the server for the app",
    timeoutMs: MINUTE,
  };
}

// ---------------------------------------------------------------------------------------------
// tunnel-connector and portainer: their own Compose projects, files rendered by the caller

const DirSchema = z
  .string()
  .regex(/^(\/[A-Za-z0-9._-]+){2,}$/)
  .refine((dir) => !dir.split("/").includes(".."), { message: "must not contain .." });

/** How a step runs: as root (servers the user owns) or as the SSH login (Hetzner, DigitalOcean). */
export type RunAs = "root" | "login";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** Shell helpers shared by the add-on scripts. */
const ADDON_HELPERS = `compose() { docker compose -p "$PROJECT" -f "$DIR/compose.yaml" "$@"; }
compose_is() { [ -f "$DIR/compose.yaml" ] && [ "$(sha256sum "$DIR/compose.yaml" | cut -d ' ' -f 1)" = "$1" ]; }
write_compose() {
  tmp=$(mktemp "$DIR/.compose.XXXXXX")
  printf '%s' "$1" | base64 -d > "$tmp"
  chmod 0600 "$tmp"
  mv -f "$tmp" "$DIR/compose.yaml"
}
running() { [ -n "$(compose ps --status running -q 2>/dev/null)" ]; }`;

function removeAddonScripts(
  name: "tunnel-connector" | "portainer",
  dir: string,
  project: string,
  deleteData: boolean,
  runAs: RunAs = "root",
): StepScripts {
  const sp = { DIR: dir, PROJECT: project, DELETE_DATA: deleteData, ADDONS_ROOT, RUN_AS: runAs };
  const verify = `  [ ! -e "$DIR" ] || return 1
  project_gone "$PROJECT" "$DELETE_DATA" || return 1
  return 0`;
  const apply = `remove_project "$PROJECT" "$DIR/compose.yaml" "$DIR" "$DELETE_DATA"
rm -rf "$DIR"
# OpsCrew's shared parent goes too once it is empty.
if [ "$RUN_AS" = root ] && [ -d "$ADDONS_ROOT" ] && [ -z "$(ls -A "$ADDONS_ROOT")" ]; then rmdir "$ADDONS_ROOT"; fi`;
  return {
    check: checkScript(`${name}.remove`, sp, PROJECT_HELPERS, verify, ""),
    apply: applyScript(`${name}.remove`, sp, PROJECT_HELPERS, apply),
    verify: verifyScript(
      `${name}.remove`,
      sp,
      PROJECT_HELPERS,
      verify,
      `OpsCrew's ${name} is still on the server.`,
    ),
    doing: name === "portainer" ? "removing Portainer" : "removing the tunnel connector",
    timeoutMs: 5 * MINUTE,
  };
}

const RemoveParams = z.object({
  remove: z.literal(true),
  deleteData: z.boolean().optional(),
  dir: DirSchema.optional(),
  runAs: z.enum(["root", "login"]).optional(),
});

/** Where a tunnel connector step runs: root steps live in OpsCrew's root-owned directory only. */
function tunnelLocation(step: HostStep, dir: string, runAs: RunAs): void {
  if (runAs === "root" && dir !== TUNNEL_DIR) throw invalid(step, "dir");
}

function tunnelScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose !== "setup" || step.params.remove === true) {
    const p = params(step, RemoveParams);
    const dir = p.dir ?? TUNNEL_DIR;
    const runAs = p.runAs ?? "root";
    tunnelLocation(step, dir, runAs);
    return removeAddonScripts("tunnel-connector", dir, TUNNEL_PROJECT, false, runAs);
  }
  const p = params(
    step,
    z.object({
      compose: ComposeTextSchema,
      tunnelId: TunnelIdSchema,
      needsToken: z.boolean(),
      dir: DirSchema.optional(),
      runAs: z.enum(["root", "login"]).optional(),
    }),
  );
  const dir = p.dir ?? TUNNEL_DIR;
  const runAs = p.runAs ?? "root";
  tunnelLocation(step, dir, runAs);
  const sp = {
    DIR: dir,
    PROJECT: TUNNEL_PROJECT,
    ADDONS_ROOT,
    RUN_AS: runAs,
    COMPOSE_B64: base64(p.compose),
    COMPOSE_SHA256: sha256(p.compose),
    TUNNEL_ID: p.tunnelId,
    NEEDS_TOKEN: p.needsToken,
  };
  const verify = `  [ -s "$DIR/tunnel.env" ] || return 1
  [ "$(head -n 1 "$DIR/tunnel.id" 2>/dev/null)" = "$TUNNEL_ID" ] || return 1
  compose_is "$COMPOSE_SHA256" || return 1
  running || return 1`;
  const apply = `umask 077
if [ "$RUN_AS" = root ]; then install -d -m 0700 "$ADDONS_ROOT"; fi
install -d -m 0700 "$DIR"
token=''
IFS= read -r token || true
recreate=''
if [ -n "$token" ]; then
  case "$token" in
    *[!A-Za-z0-9+/=_.-]*) token=''; fail 'The tunnel token has unexpected characters, so it was not written.' ;;
  esac
  tmp=$(mktemp "$DIR/.tunnel.XXXXXX")
  printf 'TUNNEL_TOKEN=%s\\n' "$token" > "$tmp"
  token=''
  chmod 0600 "$tmp"
  mv -f "$tmp" "$DIR/tunnel.env"
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
done`;
  return {
    check: checkScript(
      "tunnel-connector",
      sp,
      ADDON_HELPERS,
      verify,
      `if [ -e "$DIR/compose.yaml" ]; then echo prev.installed=true; else echo prev.installed=false; fi`,
    ),
    apply: applyScript("tunnel-connector", sp, ADDON_HELPERS, apply),
    verify: verifyScript(
      "tunnel-connector",
      sp,
      ADDON_HELPERS,
      verify,
      "The tunnel connector is not running.",
    ),
    secret: { name: "tunnelToken", required: p.needsToken },
    doing: "starting the Cloudflare Tunnel connector",
    timeoutMs: 10 * MINUTE,
  };
}

const PortainerParams = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/),
  dir: DirSchema,
  runAs: z.enum(["root", "login"]),
  composeInitial: ComposeTextSchema,
  composeFinal: ComposeTextSchema,
  needsPassword: z.boolean(),
});

/** Where a Portainer step runs: root steps live in OpsCrew's root-owned directory only. */
function portainerLocation(step: HostStep, dir: string, runAs: RunAs): void {
  if (runAs === "root" && dir !== PORTAINER_DIR) throw invalid(step, "dir");
}

function portainerScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose !== "setup" || step.params.remove === true) {
    const p = params(step, RemoveParams);
    const dir = p.dir ?? PORTAINER_DIR;
    const runAs = p.runAs ?? "root";
    portainerLocation(step, dir, runAs);
    const deleteData =
      plan.purpose === "teardown" ? plan.deleteData === true : p.deleteData === true;
    return removeAddonScripts("portainer", dir, PORTAINER_PROJECT, deleteData, runAs);
  }
  const p = params(step, PortainerParams);
  portainerLocation(step, p.dir, p.runAs);
  const sp = {
    DIR: p.dir,
    RUN_AS: p.runAs,
    PROJECT: PORTAINER_PROJECT,
    PORT: PORTAINER_PORT,
    INITIAL_B64: base64(p.composeInitial),
    FINAL_B64: base64(p.composeFinal),
    FINAL_SHA256: sha256(p.composeFinal),
    NEEDS_PASSWORD: p.needsPassword,
  };
  const helpers = `${ADDON_HELPERS}
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
}`;
  const verify = `  compose_is "$FINAL_SHA256" || return 1
  [ ! -e "$DIR/admin_password" ] || return 1
  running || return 1`;
  const apply = `umask 077
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
  tmp=$(mktemp "$DIR/.password.XXXXXX")
  printf '%s' "$pw" > "$tmp"
  pw=''
  chmod 0600 "$tmp"
  mv -f "$tmp" "$DIR/admin_password"
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
rm -f "$DIR/admin_password"`;
  return {
    check: checkScript(
      "portainer",
      sp,
      helpers,
      verify,
      `if [ -e "$DIR/compose.yaml" ]; then echo prev.installed=true; else echo prev.installed=false; fi`,
    ),
    apply: applyScript("portainer", sp, helpers, apply),
    verify: verifyScript("portainer", sp, helpers, verify, "Portainer is not running as planned."),
    secret: { name: "portainerPassword", required: p.needsPassword },
    doing: "setting up Portainer",
    timeoutMs: 10 * MINUTE,
  };
}

/**
 * A one-step host plan that turns Portainer on or off in `dir`. On servers OpsCrew created
 * (Hetzner, DigitalOcean) it runs as the SSH login (`runAs: "login"`, the default: the deploy user
 * in its home directory), needs no root and writes no host record. On a server the user owns use
 * `runAs: "root"` with `dir` = `PORTAINER_DIR` (for example to turn it off and delete its data;
 * turning it on there is part of `planHost`). Apply it with `applyHostPlan` like any host plan.
 *
 * `connector` adds the Cloudflare Tunnel connector that serves Portainer's subdomain, run the same
 * way in its own `dir` (its token is supplied at apply as `tunnelToken`), or `{ dir, remove: true }`
 * removes one an earlier subdomain left behind. It comes before the Portainer step.
 */
export function planPortainer(options: {
  app: string;
  dir: string;
  runAs?: RunAs;
  enable?: { version: string; compose: { initial: string; final: string }; needsPassword: boolean };
  disable?: { deleteData: boolean };
  connector?:
    | { dir: string; compose: string; tunnelId: string; needsToken: boolean }
    | { dir: string; remove: true };
}): HostPlan {
  const { app, dir, enable, disable, connector } = options;
  const runAs = options.runAs ?? "login";
  if ((enable === undefined) === (disable === undefined)) {
    throw new OpsCrewError("INVALID_INPUT", "Turn Portainer either on or off, not both.");
  }
  const connectorStep: HostStep | undefined =
    connector === undefined
      ? undefined
      : "remove" in connector
        ? {
            id: "tunnel-connector",
            title: "Remove the Cloudflare Tunnel connector that served Portainer's subdomain",
            state: "change",
            params: { remove: true, dir: connector.dir, runAs },
          }
        : {
            id: "tunnel-connector",
            title: `Run the Cloudflare Tunnel connector for Portainer's subdomain${imageIn(connector.compose)}`,
            state: "change",
            reason:
              "cloudflared runs as its own Compose project and connects out to Cloudflare; no inbound port is opened. Its token is written to a file only its owner can read at apply time and is never part of this plan.",
            params: {
              compose: connector.compose,
              tunnelId: connector.tunnelId,
              needsToken: connector.needsToken,
              dir: connector.dir,
              runAs,
            },
          };
  const params: Record<string, string | number | boolean> = enable
    ? {
        version: enable.version,
        dir,
        runAs,
        composeInitial: enable.compose.initial,
        composeFinal: enable.compose.final,
        needsPassword: enable.needsPassword,
      }
    : { remove: true, deleteData: disable?.deleteData === true, dir, runAs };
  const plan: HostPlan = {
    schemaVersion: 1,
    purpose: "setup",
    app,
    steps: [
      ...(connectorStep === undefined ? [] : [connectorStep]),
      {
        id: "portainer",
        title: enable
          ? `Run Portainer CE ${enable.version}, reachable only from the server itself (127.0.0.1:${PORTAINER_PORT})`
          : disable?.deleteData
            ? "Remove Portainer and its data"
            : "Remove Portainer (its data volume stays)",
        state: "change",
        params,
      },
    ],
    findings: [],
  };
  // Validate now so a bad directory or version fails before anything is approved.
  for (const item of plan.steps) stepScripts(plan, item);
  return plan;
}

/** ` (<image>)` for a Compose file's first image, for a step title. */
function imageIn(compose: string): string {
  const image = /^\s*image:\s*["']?([^"'\s]+)/m.exec(compose)?.[1];
  return image === undefined ? "" : ` (${image})`;
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

// ---------------------------------------------------------------------------------------------

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
    case "sshd":
      return sshdScripts(plan.purpose, step);
    case "ufw":
      return ufwScripts(plan.purpose, step);
    case "web-filter":
      return webFilterScripts(step);
    case "unattended-upgrades":
      return upgradesScripts(plan.purpose, step);
    case "runtime-dirs":
      return runtimeScripts(plan, step);
    case "app-marker":
      return markerScripts(plan, step);
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

/** Read-only: prints `/etc/opscrew/app.json` (the app the server belongs to), or nothing. */
export function readMarkerScript(): string {
  return buildScript(
    "marker.read",
    { MARKER_PATH },
    `if [ -f "$MARKER_PATH" ]; then cat "$MARKER_PATH"; fi`,
    { tolerant: true },
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
    `install -d -m 0700 ${OPSCREW_DIR}
tmp=$(mktemp ${OPSCREW_DIR}/.host.XXXXXX)
printf '%s\\n' "$RECORD" > "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$RECORD_PATH"`,
  );
}
