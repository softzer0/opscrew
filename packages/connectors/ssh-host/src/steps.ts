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
  DOCKER_PACKAGES,
  MIN_DOCKER_MAJOR,
  PORTAINER_DIR,
  PORTAINER_PORT,
  PORTAINER_PROJECT,
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
import { APT_FUNCTIONS, buildScript, type ScriptParams } from "./shell";
import { ComposeTextSchema, type HostPlan, type HostStep, type HostStepId } from "./types";

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

function applyScript(name: string, p: ScriptParams, helpers: string, body: string) {
  return buildScript(`${name}.apply`, p, `${APT_FUNCTIONS}\n${helpers}\n${body}`);
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
if [ -n "$PACKAGES" ]; then
  if ! grep -qs 'download.docker.com' /etc/apt/sources.list /etc/apt/sources.list.d/*; then
    # Docker's apt repository, as Docker documents it (never the convenience script).
    apt_get update
    apt_get install ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$DISTRO/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    arch=$(dpkg --print-architecture)
    printf '%s\\n' 'Types: deb' "URIs: https://download.docker.com/linux/$DISTRO" "Suites: $codename" 'Components: stable' "Architectures: $arch" 'Signed-By: /etc/apt/keyrings/docker.asc' > /etc/apt/sources.list.d/docker.sources
    chmod 0644 /etc/apt/sources.list.d/docker.sources
  fi
  apt_get update
  # shellcheck disable=SC2086 # PACKAGES is a fixed, space-separated list.
  apt_get install $PACKAGES
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
  grep -qxF -- "$PUBLIC_KEY" "$home/.ssh/authorized_keys" 2>/dev/null || return 1
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
install -d -m 0700 -o "$USER_NAME" -g "$USER_NAME" "$home/.ssh"
keys="$home/.ssh/authorized_keys"
if [ -L "$keys" ]; then fail "$keys is a symbolic link; OpsCrew does not follow it."; fi
if [ ! -f "$keys" ]; then install -m 0600 -o "$USER_NAME" -g "$USER_NAME" /dev/null "$keys"; fi
grep -qxF -- "$PUBLIC_KEY" "$keys" || printf '%s\\n' "$PUBLIC_KEY" >> "$keys"
chown "$USER_NAME:$USER_NAME" "$keys"
chmod 0600 "$keys"
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

/** Dead-man capture shared by sshd setup and undo: restore the drop-in as it is right now. */
const SSHD_CAPTURE = `if [ -f ${SSHD_DROP_IN} ]; then cp -p ${SSHD_DROP_IN} ${DEAD_MAN_DIR}/sshd.prev; else rm -f ${DEAD_MAN_DIR}/sshd.prev; fi
cat > ${DEAD_MAN_DIR}/sshd.undo.sh <<'OPSCREW_UNDO'
#!/bin/sh
# Written by OpsCrew: puts the previous SSH settings back.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
if [ -f ${DEAD_MAN_DIR}/sshd.prev ]; then cp -p ${DEAD_MAN_DIR}/sshd.prev ${SSHD_DROP_IN}; else rm -f ${SSHD_DROP_IN}; fi
${SSHD_RELOAD} || true
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
}`;
  const verify = `  config_ok || return 1
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
{
  printf '%s\\n' "$HEADER"
  printf 'PermitRootLogin %s\\n' "$ROOT_LOGIN"
  if [ "$PASSWORDS_OFF" = true ]; then printf '%s\\n' 'PasswordAuthentication no'; fi
  if [ "$KBD_OFF" = true ]; then printf '%s\\n' 'KbdInteractiveAuthentication no'; fi
} > "$tmp"
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

const UfwParams = z.object({
  sshPorts: PortsSchema,
  web: z.boolean(),
  enable: z.boolean(),
  install: z.boolean(),
});

const UfwUndoParams = z.object({
  removeRules: RulesSchema,
  disable: z.boolean(),
  removePackage: z.boolean(),
});

const UFW_HELPERS = `ufw_active() { ufw status 2>/dev/null | grep -q '^Status: active'; }
ufw_added() { ufw show added 2>/dev/null || true; }
has_rule() { printf '%s\\n' "$ADDED" | grep -Eq "^ufw allow $1( comment .*)?\\$"; }
has_own_rule() { printf '%s\\n' "$ADDED" | grep -qxF "ufw allow $1 comment '$2'"; }`;

function ufwScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  const timer = "! systemctl is-active --quiet opscrew-undo-ufw.timer";
  if (purpose === "undo") {
    const p = params(step, UfwUndoParams);
    const sp = { REMOVE_RULES: p.removeRules, DISABLE: p.disable, REMOVE_PACKAGE: p.removePackage };
    const verify = `  if ! command -v ufw >/dev/null 2>&1; then return 0; fi
  ADDED=$(ufw_added)
  for r in $REMOVE_RULES; do if has_rule "$r"; then return 1; fi; done
  if [ "$DISABLE" = true ] && ufw_active; then return 1; fi
  ${timer}`;
    const capture = `ADDED=$(ufw_added)
was_active=no
if ufw_active; then was_active=yes; fi
{
  echo '#!/bin/sh'
  echo '# Written by OpsCrew: puts back the firewall rules OpsCrew was removing.'
  echo 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH'
  for r in $REMOVE_RULES; do if has_rule "$r"; then echo "ufw allow $r >/dev/null 2>&1 || true"; fi; done
  if [ "$was_active" = yes ]; then echo 'ufw --force enable >/dev/null 2>&1 || true'; fi
} > ${DEAD_MAN_DIR}/ufw.undo.sh`;
    const apply = `command -v ufw >/dev/null 2>&1 || exit 0
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
    SSH_PORTS: p.sshPorts,
    WEB: p.web,
    ENABLE: p.enable,
    WEB_RULES: WEB_RULES.join(" "),
    SSH_COMMENT: UFW_SSH_COMMENT,
    WEB_COMMENT: UFW_WEB_COMMENT,
  };
  const verify = `  command -v ufw >/dev/null 2>&1 || return 1
  ufw_active || return 1
  ADDED=$(ufw_added)
  for port in $SSH_PORTS; do has_rule "$port/tcp" || return 1; done
  for r in $WEB_RULES; do
    if [ "$WEB" = true ]; then has_rule "$r" || return 1
    elif has_own_rule "$r" "$WEB_COMMENT"; then return 1; fi
  done
  ${timer}`;
  const snapshot = `if command -v ufw >/dev/null 2>&1; then echo prev.installed=true; else echo prev.installed=false; fi
if ufw_active; then echo prev.active=true; else echo prev.active=false; fi
echo "prev.rules=$(ufw_added | sed -n -e "s/^ufw //" -e "s/ comment '.*'\\$//" -e '/^[a-z]/p' | tr '\\n' ',' | sed 's/,$//')"`;
  // The undo the dead-man runs: delete the rules this change adds, turn ufw off if it was off.
  const capture = `ADDED=$(ufw_added)
was_active=no
if ufw_active; then was_active=yes; fi
{
  echo '#!/bin/sh'
  echo '# Written by OpsCrew: puts the previous firewall state back.'
  echo 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH'
  if [ "$was_active" = no ]; then echo 'ufw --force disable >/dev/null 2>&1 || true'; fi
  for port in $SSH_PORTS; do if ! has_rule "$port/tcp"; then echo "ufw --force delete allow $port/tcp >/dev/null 2>&1 || true"; fi; done
  for r in $WEB_RULES; do
    if [ "$WEB" = true ] && ! has_rule "$r"; then echo "ufw --force delete allow $r >/dev/null 2>&1 || true"; fi
    if [ "$WEB" != true ] && has_own_rule "$r" "$WEB_COMMENT"; then echo "ufw allow $r comment '$WEB_COMMENT' >/dev/null 2>&1 || true"; fi
  done
} > ${DEAD_MAN_DIR}/ufw.undo.sh`;
  const apply = `command -v ufw >/dev/null 2>&1 || fail 'ufw is not installed.'
ADDED=$(ufw_added)
# The SSH rule for every port sshd listens on comes first, before anything else changes.
for port in $SSH_PORTS; do
  if ! has_rule "$port/tcp"; then ufw allow "$port/tcp" comment "$SSH_COMMENT" >/dev/null; fi
done
for r in $WEB_RULES; do
  if [ "$WEB" = true ]; then
    if ! has_rule "$r"; then ufw allow "$r" comment "$WEB_COMMENT" >/dev/null; fi
  elif has_own_rule "$r" "$WEB_COMMENT"; then
    # Tunnel mode: remove web rules OpsCrew added earlier, never the server's own.
    ufw --force delete allow "$r" >/dev/null
  fi
done
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
// unattended-upgrades

function upgradesScripts(purpose: HostPlan["purpose"], step: HostStep): StepScripts {
  const sp = { CONF: AUTO_UPGRADES_FILE };
  if (purpose === "undo") {
    const p = params(step, z.object({ removePackage: z.boolean() }));
    const verify = `  [ ! -e "$CONF" ] || return 1
  if [ "$REMOVE_PACKAGE" = true ]; then ! is_installed unattended-upgrades || return 1; fi`;
    const up = { ...sp, REMOVE_PACKAGE: p.removePackage };
    return {
      check: checkScript("unattended-upgrades.undo", up, "", verify, ""),
      apply: applyScript(
        "unattended-upgrades.undo",
        up,
        "",
        `rm -f "$CONF"
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
  printf '%s\\n' "$dump" | grep -qx 'APT::Periodic::Unattended-Upgrade "1";' || return 1`;
  const snapshot = `if is_installed unattended-upgrades; then echo prev.installed=true; else echo prev.installed=false; fi
if [ -e "$CONF" ]; then echo prev.file=present; else echo prev.file=absent; fi`;
  const apply = `if ! is_installed unattended-upgrades; then apt_get update; apt_get install unattended-upgrades; fi
tmp=$(mktemp /etc/apt/.opscrew.XXXXXX)
printf '%s\\n' '// Managed by OpsCrew: automatic security updates.' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$CONF"`;
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
// runtime-dirs

function runtimeScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose === "teardown") {
    const p = params(step, z.object({ app: AppNameSchema, deleteData: z.boolean() }));
    const sp = { APP: p.app, DELETE_DATA: p.deleteData };
    const verify = `  if command -v docker >/dev/null 2>&1; then
    [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$APP" 2>/dev/null)" ] || return 1
  fi
  if [ -d /srv/app ] && [ -n "$(ls -A /srv/app)" ]; then return 1; fi
  if [ "$DELETE_DATA" = true ] && [ -d /srv/data ] && [ -n "$(ls -A /srv/data)" ]; then return 1; fi
  return 0`;
    const apply = `for d in ${RUNTIME_DIRS.join(" ")}; do
  if [ -L "$d" ]; then fail "$d is a symbolic link; OpsCrew does not follow it."; fi
done
if command -v docker >/dev/null 2>&1; then
  if [ "$DELETE_DATA" = true ]; then docker compose -p "$APP" down --remove-orphans --volumes >/dev/null 2>&1 || true
  else docker compose -p "$APP" down --remove-orphans >/dev/null 2>&1 || true; fi
  left=$(docker ps -aq --filter "label=com.docker.compose.project=$APP") || left=''
  if [ -n "$left" ]; then
    # shellcheck disable=SC2086 # container ids are one word each.
    docker rm -f $left >/dev/null
  fi
fi
if [ -d /srv/app ]; then find /srv/app -xdev -mindepth 1 -delete; fi
if [ "$DELETE_DATA" = true ] && [ -d /srv/data ]; then find /srv/data -xdev -mindepth 1 -delete; fi`;
    return {
      check: checkScript(
        "runtime-dirs.teardown",
        sp,
        "",
        verify,
        `echo "prev.appFiles=$(ls -A /srv/app 2>/dev/null | wc -l)"
echo "prev.dataFiles=$(ls -A /srv/data 2>/dev/null | wc -l)"`,
      ),
      apply: applyScript("runtime-dirs.teardown", sp, "", apply),
      verify: verifyScript(
        "runtime-dirs.teardown",
        sp,
        "",
        verify,
        "Some of the app's containers or files are still on the server.",
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
    const sp = { OPSCREW_DIR, MARKER_PATH };
    const verify = `  [ ! -e "$OPSCREW_DIR" ]`;
    return {
      check: checkScript("app-marker.undo", sp, "", verify, ""),
      apply: applyScript(
        "app-marker.undo",
        sp,
        "",
        `if [ -e "$MARKER_PATH" ]; then fail 'An OpsCrew app is still on this server; remove it first.'; fi
rm -rf "$OPSCREW_DIR"`,
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
    }),
  );
  const sp = { MARKER_PATH, MARKER: JSON.stringify({ app: p.app, projectId: p.projectId }) };
  const verify = `  [ -f "$MARKER_PATH" ] && [ "$(cat "$MARKER_PATH")" = "$MARKER" ]`;
  const apply = `install -d -m 0700 ${OPSCREW_DIR}
if [ -f "$MARKER_PATH" ] && [ "$(cat "$MARKER_PATH")" != "$MARKER" ]; then
  fail 'Another OpsCrew app is already on this server; one server runs one OpsCrew app for now.'
fi
tmp=$(mktemp ${OPSCREW_DIR}/.app.XXXXXX)
printf '%s\\n' "$MARKER" > "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$MARKER_PATH"`;
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
  if command -v docker >/dev/null 2>&1; then
    [ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ] || return 1
    if [ "$DELETE_DATA" = true ]; then [ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ] || return 1; fi
  fi
  return 0`;
  const apply = `if command -v docker >/dev/null 2>&1; then
  if [ "$DELETE_DATA" = true ]; then docker compose -p "$PROJECT" down --remove-orphans --volumes >/dev/null 2>&1 || true
  else docker compose -p "$PROJECT" down --remove-orphans >/dev/null 2>&1 || true; fi
  left=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT") || left=''
  if [ -n "$left" ]; then
    # shellcheck disable=SC2086 # container ids are one word each.
    docker rm -f $left >/dev/null
  fi
  if [ "$DELETE_DATA" = true ]; then
    vols=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT") || vols=''
    if [ -n "$vols" ]; then
      # shellcheck disable=SC2086 # volume names are one word each.
      docker volume rm $vols >/dev/null
    fi
  fi
fi
rm -rf "$DIR"
# OpsCrew's shared parent goes too once it is empty.
if [ "$RUN_AS" = root ] && [ -d "$ADDONS_ROOT" ] && [ -z "$(ls -A "$ADDONS_ROOT")" ]; then rmdir "$ADDONS_ROOT"; fi`;
  return {
    check: checkScript(`${name}.remove`, sp, "", verify, ""),
    apply: applyScript(`${name}.remove`, sp, "", apply),
    verify: verifyScript(
      `${name}.remove`,
      sp,
      "",
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

function tunnelScripts(plan: HostPlan, step: HostStep): StepScripts {
  if (plan.purpose !== "setup" || step.params.remove === true) {
    params(step, RemoveParams);
    return removeAddonScripts("tunnel-connector", TUNNEL_DIR, TUNNEL_PROJECT, false);
  }
  const p = params(step, z.object({ compose: ComposeTextSchema, needsToken: z.boolean() }));
  const sp = {
    DIR: TUNNEL_DIR,
    PROJECT: TUNNEL_PROJECT,
    ADDONS_ROOT,
    COMPOSE_B64: base64(p.compose),
    COMPOSE_SHA256: sha256(p.compose),
    NEEDS_TOKEN: p.needsToken,
  };
  const verify = `  [ -s "$DIR/tunnel.env" ] || return 1
  compose_is "$COMPOSE_SHA256" || return 1
  running || return 1`;
  const apply = `umask 077
install -d -m 0700 "$ADDONS_ROOT" "$DIR"
token=''
IFS= read -r token || true
if [ -n "$token" ]; then
  case "$token" in
    *[!A-Za-z0-9+/=_.-]*) token=''; fail 'The tunnel token has unexpected characters, so it was not written.' ;;
  esac
  tmp=$(mktemp "$DIR/.tunnel.XXXXXX")
  printf 'TUNNEL_TOKEN=%s\\n' "$token" > "$tmp"
  token=''
  chmod 0600 "$tmp"
  mv -f "$tmp" "$DIR/tunnel.env"
elif [ "$NEEDS_TOKEN" = true ] || [ ! -s "$DIR/tunnel.env" ]; then
  fail 'No tunnel token arrived on standard input, so the tunnel connector was not set up.'
fi
write_compose "$COMPOSE_B64"
compose up -d --remove-orphans --quiet-pull >/dev/null 2>&1 || fail 'The tunnel connector did not start (docker compose up failed).'
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
IFS= read -r pw || true
if [ -n "$pw" ]; then
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
  if [ "$code" = 404 ]; then fail 'Portainer started without an admin account, so OpsCrew stopped it. Turn Portainer on again so OpsCrew can set the admin password.'; fi
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
 * A one-step host plan that turns Portainer on (or off) in `dir`, for servers OpsCrew created
 * (Hetzner, DigitalOcean), where it runs as the SSH login (the deploy user, in its home directory).
 * Apply it with `applyHostPlan` like any host plan; it needs no root and writes no host record.
 */
export function planPortainer(options: {
  app: string;
  dir: string;
  enable?: { version: string; compose: { initial: string; final: string }; needsPassword: boolean };
  disable?: { deleteData: boolean };
}): HostPlan {
  const { app, dir, enable, disable } = options;
  if ((enable === undefined) === (disable === undefined)) {
    throw new OpsCrewError("INVALID_INPUT", "Turn Portainer either on or off, not both.");
  }
  const params: Record<string, string | number | boolean> = enable
    ? {
        version: enable.version,
        dir,
        runAs: "login",
        composeInitial: enable.compose.initial,
        composeFinal: enable.compose.final,
        needsPassword: enable.needsPassword,
      }
    : { remove: true, deleteData: disable?.deleteData === true, dir, runAs: "login" };
  const plan: HostPlan = {
    schemaVersion: 1,
    purpose: "setup",
    app,
    steps: [
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
  stepScripts(plan, plan.steps[0] as HostStep);
  return plan;
}

/** How a step's scripts run: Portainer steps for Hetzner/DigitalOcean run as the login. */
export function runAsOf(step: HostStep): RunAs {
  return step.id === "portainer" && step.params.runAs === "login" ? "login" : "root";
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
    case "docker":
      return plan.purpose === "setup" ? dockerScripts(step) : dockerUndoScripts();
    case "deploy-user":
      return deployUserScripts(plan.purpose, step);
    case "sshd":
      return sshdScripts(plan.purpose, step);
    case "ufw":
      return ufwScripts(plan.purpose, step);
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
systemd-run --quiet --unit="$UNIT" --on-active="\${DELAY}s" --timer-property=AccuracySec=1s /bin/sh "${DEAD_MAN_DIR}/$STEP.undo.sh"
systemctl is-active --quiet "$UNIT.timer" || fail 'OpsCrew could not schedule the automatic undo, so it changed nothing.'
echo armed`,
  );
}

/** Cancels the scheduled undo; prints `cancelled`, or `fired` when it already ran. */
export function cancelScript(step: GuardedStep): string {
  return buildScript(
    `deadman.cancel.${step}`,
    { STEP: step, UNIT: deadManUnit(step) },
    `if systemctl is-active --quiet "$UNIT.timer"; then
  systemctl stop "$UNIT.timer"
  result=cancelled
else
  result=fired
fi
rm -f "${DEAD_MAN_DIR}/$STEP".*
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
    `install -d -m 0700 ${OPSCREW_DIR}
tmp=$(mktemp ${OPSCREW_DIR}/.host.XXXXXX)
printf '%s\\n' "$RECORD" > "$tmp"
chmod 0600 "$tmp"
mv -f "$tmp" "$RECORD_PATH"`,
  );
}
