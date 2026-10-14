/**
 * Pure planning: from inspected facts to a host plan of fixed steps, each in place, to change or
 * blocked, plus blocking findings. No I/O; the plan holds no secrets.
 */
import { createHash } from "node:crypto";
import { OpsCrewError } from "@opscrew/core";
import {
  FAIL2BAN_JAIL_PATH,
  fail2banJail,
  MIN_DOCKER_MAJOR,
  PORTAINER_DIR,
  PORTAINER_PORT,
  PORTAINER_PROJECT,
  PORTAINER_REPOSITORY,
  SUPPORTED_ARCH,
  SUPPORTED_OS,
  sshdDropIn,
  TUNNEL_APP_PORT,
  UFW_SSH_COMMENT,
  UFW_WEB_COMMENT,
  WEB_RULES,
} from "./constants";
import { type HostFacts, HostFactsSchema, type HostRecordEntry, RUNTIME_DIRS } from "./facts";
import { findings } from "./findings";
import { isLoopback, majorOf, publishesPort, ufwRuleCovers } from "./parse";
import {
  type DesiredHost,
  DesiredHostSchema,
  HOST_PLAN_SCHEMA_VERSION,
  type HostFinding,
  type HostPlan,
  type HostStep,
  type HostStepId,
} from "./types";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function parseFacts(facts: HostFacts): HostFacts {
  const parsed = HostFactsSchema.safeParse(facts);
  if (!parsed.success) {
    throw new OpsCrewError("INVALID_INPUT", "The server facts are not valid.", {
      hint: "Inspect the server again with OpsCrew before planning.",
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseDesired(desired: DesiredHost): DesiredHost {
  const parsed = DesiredHostSchema.safeParse(desired);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The settings for this server are not valid (${issue?.path.join(".") || "input"}: ${issue?.message ?? "invalid"}).`,
      { hint: "Run opscrew interview again to fix the server settings.", cause: parsed.error },
    );
  }
  return parsed.data;
}

function setupEntry(facts: HostFacts, step: HostStepId): HostRecordEntry | undefined {
  return facts.record?.changes.find((entry) => entry.step === step && entry.purpose === "setup");
}

function step(
  id: HostStepId,
  title: string,
  state: HostStep["state"],
  params: HostStep["params"],
  reason?: string,
): HostStep {
  return reason === undefined ? { id, title, state, params } : { id, title, state, reason, params };
}

/** Plain findings that make the rest of the facts unreliable; every step is blocked. */
function fatalFindings(facts: HostFacts): HostFinding[] {
  const found: HostFinding[] = [];
  if (facts.privilege === "sudo-password") found.push(findings.sudoNeedsPassword(facts.user));
  else if (facts.privilege === "none") found.push(findings.noRoot(facts.user));
  if (found.length > 0) return found;
  const versions = SUPPORTED_OS[facts.os.id];
  if (!versions?.includes(facts.os.versionId)) {
    found.push(
      findings.unsupportedOs(facts.os.prettyName || `${facts.os.id} ${facts.os.versionId}`),
    );
  }
  if (!(SUPPORTED_ARCH as readonly string[]).includes(facts.arch)) {
    found.push(findings.unsupportedArch(facts.arch || facts.machine));
  }
  if (!facts.systemd) found.push(findings.noSystemd());
  if (facts.recordDamaged) found.push(findings.recordDamaged());
  if (facts.markerDamaged) found.push(findings.markerDamaged());
  return found;
}

function isWebPort(proto: string, port: number): boolean {
  return (proto === "tcp" && (port === 80 || port === 443)) || (proto === "udp" && port === 443);
}

/** What listens on 80/443 that is not OpsCrew's own app. */
function webPortUsers(facts: HostFacts, app: string): string[] {
  const ours = (project: string) => project === app && facts.marker?.app === app;
  const users = new Set<string>();
  for (const listener of facts.listeners) {
    if (!isWebPort(listener.proto, listener.port) || isLoopback(listener.address)) continue;
    if (listener.process === "docker-proxy") {
      const owner = facts.containers.find((container) =>
        publishesPort(container.ports, listener.port),
      );
      if (!owner) users.add(`a Docker container on port ${listener.port}`);
      continue;
    }
    users.add(`${listener.process || "a program"} on port ${listener.port}/${listener.proto}`);
  }
  for (const container of facts.containers) {
    if (ours(container.project)) continue;
    for (const port of [80, 443]) {
      if (publishesPort(container.ports, port)) {
        users.add(`the container ${container.name} on port ${port}`);
      }
    }
  }
  return [...users];
}

/**
 * What holds a local-only port OpsCrew needs (18080 for the app in tunnel mode, 9443 for
 * Portainer), on any address, other than the Compose project `ownProject`.
 */
function localPortUsers(facts: HostFacts, port: number, ownProject: string | null): string[] {
  const users = new Set<string>();
  const ownContainer = facts.containers.some(
    (container) => container.project === ownProject && publishesPort(container.ports, port, true),
  );
  const anyContainer = facts.containers.some((container) =>
    publishesPort(container.ports, port, true),
  );
  for (const listener of facts.listeners) {
    if (listener.proto !== "tcp" || listener.port !== port) continue;
    if (listener.process === "docker-proxy") {
      if (!ownContainer && !anyContainer) users.add("a Docker container");
      continue;
    }
    users.add(listener.process || "another program");
  }
  for (const container of facts.containers) {
    if (container.project === ownProject) continue;
    if (publishesPort(container.ports, port, true)) users.add(`the container ${container.name}`);
  }
  return [...users];
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** UDP client sockets that a firewall with stateful rules does not break. */
const HARMLESS_UDP = new Set([68, 123, 323, 546, 5353]);

/** Services reachable from other machines today that ufw's default deny would cut off. */
function wouldBlock(facts: HostFacts, sshPorts: readonly number[], web: boolean): string[] {
  const found = new Set<string>();
  for (const listener of facts.listeners) {
    if (isLoopback(listener.address) || listener.process === "docker-proxy") continue;
    if (listener.proto === "tcp" && sshPorts.includes(listener.port)) continue;
    if (web && isWebPort(listener.proto, listener.port)) continue;
    if (listener.proto === "udp" && HARMLESS_UDP.has(listener.port)) continue;
    found.add(`${listener.port}/${listener.proto} (${listener.process || "unknown program"})`);
  }
  return [...found];
}

function globMatch(name: string, pattern: string): boolean {
  const source = pattern
    .split("")
    .map((char) =>
      char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`).test(name);
}

/** sshd user patterns may be `user@host`; only the user part matters for the deploy user. */
function userPart(pattern: string): string {
  const at = pattern.indexOf("@");
  return at >= 0 ? pattern.slice(0, at) : pattern;
}

function allowedBy(names: readonly string[], patterns: readonly string[], users: boolean): boolean {
  const clean = (p: string) => (users ? userPart(p) : p);
  const negated = patterns.filter((p) => p.startsWith("!")).map((p) => clean(p.slice(1)));
  const positive = patterns.filter((p) => !p.startsWith("!")).map(clean);
  return names.some(
    (name) => positive.some((p) => globMatch(name, p)) && !negated.some((p) => globMatch(name, p)),
  );
}

/** The sshd setting that would keep the deploy user out, or null. */
function deployBlockedBy(sshd: NonNullable<HostFacts["sshd"]>): string | null {
  const user = ["deploy"];
  const groups = ["deploy", "docker"];
  if (sshd.denyUsers.some((p) => globMatch("deploy", userPart(p.replace(/^!/, ""))))) {
    return `DenyUsers ${sshd.denyUsers.join(" ")}`;
  }
  if (sshd.denyGroups.some((p) => groups.some((g) => globMatch(g, p.replace(/^!/, ""))))) {
    return `DenyGroups ${sshd.denyGroups.join(" ")}`;
  }
  if (sshd.allowUsers.length > 0 && !allowedBy(user, sshd.allowUsers, true)) {
    return `AllowUsers ${sshd.allowUsers.join(" ")}`;
  }
  if (sshd.allowGroups.length > 0 && !allowedBy(groups, sshd.allowGroups, false)) {
    return `AllowGroups ${sshd.allowGroups.join(" ")}`;
  }
  return null;
}

/** First two fields of a public key line (type and key), without the comment. */
function keyId(line: string): string {
  return line.trim().split(/\s+/).slice(0, 2).join(" ");
}

const TITLES = {
  docker: `Docker Engine ${MIN_DOCKER_MAJOR} or newer and the Compose plugin from Docker's repository`,
  deployUser: "Deploy user with the deploy key and Docker access",
  sshd: "SSH hardening",
  ufw: "Firewall (ufw)",
  upgrades: "Turn on automatic security updates",
  runtime: "Create /srv/app and /srv/data for the app, owned by deploy",
  tunnel: "Run the Cloudflare Tunnel connector",
  portainer: "Run Portainer CE",
};

interface SetupContext {
  facts: HostFacts;
  desired: DesiredHost;
  found: HostFinding[];
}

function dockerStep({ facts, found }: SetupContext): HostStep {
  const docker = facts.docker;
  const base = { distro: facts.os.id };
  const blocked = (finding: HostFinding, reason: string) => {
    found.push(finding);
    return step("docker", TITLES.docker, "blocked", { ...base, action: "none" }, reason);
  };
  switch (docker.kind) {
    case "snap":
      return blocked(findings.dockerSnap(), "Docker comes from Snap.");
    case "podman":
      return blocked(findings.dockerPodman(), "The docker command is Podman.");
    case "distro":
      return blocked(
        findings.dockerDistro(docker.conflicting.length > 0 ? docker.conflicting : ["docker.io"]),
        "Docker comes from the distribution's packages.",
      );
    case "other":
      return blocked(findings.dockerOther(), "Docker was installed some other way.");
    case "absent":
      if (docker.conflicting.length > 0) {
        return blocked(
          findings.dockerConflicts(docker.conflicting),
          `Installing Docker would remove ${docker.conflicting.join(", ")}.`,
        );
      }
      return step(
        "docker",
        `Install Docker Engine (${MIN_DOCKER_MAJOR} or newer) and the Compose plugin from Docker's repository`,
        "change",
        { ...base, action: "install" },
        "Docker is not installed. OpsCrew adds Docker's apt repository and installs Docker Engine, containerd and the Compose and Buildx plugins (not the convenience script).",
      );
    case "docker-repo": {
      const version = docker.version ?? "an unknown version";
      if (majorOf(docker.version) < MIN_DOCKER_MAJOR) {
        return step(
          "docker",
          `Upgrade Docker Engine to ${MIN_DOCKER_MAJOR} or newer from Docker's repository`,
          "change",
          { ...base, action: "upgrade" },
          `Docker Engine ${version} is older than ${MIN_DOCKER_MAJOR}, the first version that keeps ports published on 127.0.0.1 unreachable from other machines on the network. The Docker daemon restarts during the upgrade, so running containers restart too (those with a restart policy come back on their own).`,
        );
      }
      if (!docker.composePlugin || !docker.buildxPlugin) {
        return step(
          "docker",
          "Install the Docker Compose and Buildx plugins from Docker's repository",
          "change",
          { ...base, action: "plugins" },
          `Docker Engine ${version} is installed, but the Compose or Buildx plugin is missing.`,
        );
      }
      if (!docker.running) {
        return step(
          "docker",
          "Start Docker and start it at boot",
          "change",
          { ...base, action: "start" },
          `Docker Engine ${version} is installed but not running.`,
        );
      }
      return step(
        "docker",
        TITLES.docker,
        "in-place",
        { ...base, action: "none" },
        `Docker Engine ${version} from Docker's repository is installed and running.`,
      );
    }
  }
}

/** An interrupted dpkg run (a dropped connection during apt) is finished first, as its own step. */
function packageRepairStep(facts: HostFacts): HostStep | undefined {
  if (!facts.dpkgInterrupted) return undefined;
  return step(
    "package-repair",
    "Finish the interrupted package installation (dpkg --configure -a)",
    "change",
    {},
    "A package installation on this server stopped part-way (for example because a connection dropped); apt refuses to install anything until it is finished.",
  );
}

function dockerDaemonStep({ facts }: SetupContext): HostStep {
  const title = "Docker daemon settings: log rotation, no-new-privileges, live-restore";
  const params = { path: "/etc/docker/daemon.json" };
  if (facts.dockerDaemonJson === "opscrew") {
    return step("docker-daemon", title, "in-place", params, "Already set.");
  }
  if (facts.dockerDaemonJson === "other") {
    return step(
      "docker-daemon",
      title,
      "in-place",
      params,
      "This server already has its own /etc/docker/daemon.json, so OpsCrew kept your Docker settings and changes nothing there.",
    );
  }
  // Settings given as dockerd flags would clash with the same keys in daemon.json (Docker then
  // refuses to start), and live-restore cannot be used in Swarm mode: those are the user's own.
  if (facts.docker.daemonFlags.length > 0 || facts.docker.swarm) {
    return step(
      "docker-daemon",
      title,
      "in-place",
      params,
      facts.docker.swarm
        ? "This server is part of a Docker Swarm, which does not allow live-restore, so OpsCrew kept your Docker settings and writes no daemon.json."
        : `Docker is started with its own settings (${facts.docker.daemonFlags.join(", ")}), so OpsCrew kept your Docker settings and writes no daemon.json.`,
    );
  }
  const busy = facts.containers.some((container) => container.running);
  return step(
    "docker-daemon",
    `Write /etc/docker/daemon.json: ${title.slice("Docker daemon settings: ".length)}`,
    "change",
    params,
    busy
      ? "The same settings as on servers OpsCrew creates. Docker reloads them without restarting your running containers; log rotation and no-new-privileges apply to containers created after Docker's next restart."
      : "The same settings as on servers OpsCrew creates; Docker restarts once to apply them (no containers are running).",
  );
}

function fail2banStep({ facts, desired }: SetupContext): HostStep {
  const ports = realSshPorts(facts, desired);
  const params = { sshPorts: ports.join(" "), install: !facts.packages.fail2ban };
  const title = `Brute-force protection: fail2ban jail for SSH (port ${ports.join(", ")})`;
  const f2b = facts.fail2ban;
  if (f2b.active && f2b.jail?.trim() === fail2banJail(ports).trim()) {
    return step("fail2ban", title, "in-place", params, "Already running.");
  }
  if (f2b.active && f2b.sshdJail && f2b.jail === null) {
    return step(
      "fail2ban",
      title,
      "in-place",
      params,
      "fail2ban already guards SSH on this server with your own settings, so OpsCrew leaves them alone.",
    );
  }
  return step(
    "fail2ban",
    title,
    "change",
    params,
    `${params.install ? "Installs fail2ban and adds" : "Adds"} ${FAIL2BAN_JAIL_PATH}: 5 failed logins ban an address for an hour (read from the systemd journal).`,
  );
}

function deployUserStep({ facts, desired, found }: SetupContext): HostStep {
  const params = { user: desired.deploy.user, publicKey: desired.deploy.publicKey };
  const existing = facts.deployUser;
  if (existing === null) {
    return step(
      "deploy-user",
      "Create the deploy user with the deploy key and Docker access",
      "change",
      params,
      "GitHub Actions deploys as this non-root user; it gets no password and joins the docker group.",
    );
  }
  if (setupEntry(facts, "deploy-user")?.previous.existed !== false) {
    found.push(findings.deployUserExists());
    return step(
      "deploy-user",
      TITLES.deployUser,
      "blocked",
      params,
      "A deploy user exists that OpsCrew did not create.",
    );
  }
  // OpsCrew owns this user, so its authorized_keys holds exactly the current deploy key.
  const onlyKey = existing.keys.length === 1 && existing.keys[0] === desired.deploy.publicKey;
  const hasKey = existing.keys.some((line) => keyId(line) === keyId(desired.deploy.publicKey));
  const inDocker = existing.groups.includes("docker");
  if (onlyKey && inDocker) {
    return step(
      "deploy-user",
      TITLES.deployUser,
      "in-place",
      params,
      "The deploy user has the deploy key and Docker access.",
    );
  }
  return step(
    "deploy-user",
    "Give the deploy user the deploy key and Docker access",
    "change",
    params,
    !inDocker && onlyKey
      ? "The deploy user is not in the docker group."
      : hasKey
        ? "authorized_keys is rewritten with exactly the current deploy key (other keys are revoked)."
        : "The deploy key changed: authorized_keys is rewritten with the new key, so the old one stops working.",
  );
}

function sshdStep({ facts, desired, found }: SetupContext): HostStep {
  const sshd = facts.sshd;
  const permitRootLogin = desired.admin.isRoot ? "prohibit-password" : "no";
  const rootText = desired.admin.isRoot
    ? "root keeps key-only logins (you connect as root; the stricter option is a sudo user and no root login)"
    : "root cannot log in over SSH";
  if (sshd === null) {
    found.push(findings.sshdUnreadable());
    return step("sshd", TITLES.sshd, "blocked", { permitRootLogin }, "sshd -T failed.");
  }
  const blockedBy = deployBlockedBy(sshd);
  if (blockedBy !== null) found.push(findings.sshdDeploysBlocked(blockedBy));

  const lacking = facts.loginUsers
    .filter((user) => user.uid !== 0 && user.password && !user.keys)
    .map((user) => user.name);
  // Directory users (SSSD, LDAP, Kerberos, Winbind) have passwords and keys OpsCrew cannot see.
  const directory = facts.directoryLogins;
  let disablePasswords: boolean;
  if (lacking.length === 0 && directory.length === 0) disablePasswords = true;
  else if (desired.disablePasswords !== undefined) disablePasswords = desired.disablePasswords;
  else {
    if (lacking.length > 0) found.push(findings.passwordUsersWithoutKeys(lacking));
    if (directory.length > 0) found.push(findings.directoryLogins(directory));
    return step(
      "sshd",
      TITLES.sshd,
      "blocked",
      { permitRootLogin },
      lacking.length > 0
        ? `${lacking.join(", ")} log${lacking.length === 1 ? "s" : ""} in with a password and no SSH key; password logins stay as they are until you choose.`
        : "Users from a directory service may log in with passwords; password logins stay as they are until you choose.",
    );
  }
  const kbdInteractiveOff = disablePasswords && sshd.authenticationMethods === "any";
  const params = { permitRootLogin, disablePasswords, kbdInteractiveOff };
  const why = [
    ...(lacking.length > 0
      ? [`${lacking.join(", ")} log${lacking.length === 1 ? "s" : ""} in with a password`]
      : []),
    ...(directory.length > 0 ? ["users may come from a directory service"] : []),
  ];
  const passwordText = disablePasswords
    ? "password logins off"
    : `password logins left as they are (you chose to keep them${why.length > 0 ? `; ${why.join("; ")}` : ""})`;
  // OpsCrew's drop-in must be there too: drift and `opscrew secure` read it.
  const inPlace =
    sshd.permitRootLogin === permitRootLogin &&
    (!disablePasswords || !sshd.passwordAuthentication) &&
    (!kbdInteractiveOff || !sshd.kbdInteractiveAuthentication) &&
    sshd.dropIn?.trim() === sshdDropIn(params).trim() &&
    !facts.pendingUndo.sshd;
  if (inPlace) {
    return step("sshd", `SSH: ${passwordText}, ${rootText}`, "in-place", params, "Already set.");
  }
  if (!sshd.dropInIncluded) {
    found.push(findings.sshdNoInclude());
    return step("sshd", TITLES.sshd, "blocked", params, "The sshd drop-in directory is not read.");
  }
  return step(
    "sshd",
    `Harden SSH: ${passwordText}, ${rootText}`,
    "change",
    params,
    `OpsCrew writes /etc/ssh/sshd_config.d/10-opscrew.conf, checks it with sshd -t and reloads SSH. The server undoes the change on its own unless new logins as deploy and as ${desired.admin.user} work afterwards. AllowUsers is never set.`,
  );
}

/**
 * Every port SSH really answers on: what `sshd -T` reports, ports sshd itself listens on, and
 * the port the user connects to when systemd's ssh.socket listens there (Ubuntu 24.04 and later
 * can move the socket without sshd -T knowing).
 */
function realSshPorts(facts: HostFacts, desired: DesiredHost): number[] {
  const ports = new Set(facts.sshd?.ports ?? []);
  for (const listener of facts.listeners) {
    if (listener.proto !== "tcp") continue;
    if (listener.process === "sshd") ports.add(listener.port);
    if (listener.process === "systemd" && listener.port === desired.sshPort)
      ports.add(listener.port);
  }
  if (ports.size === 0) ports.add(desired.sshPort);
  return [...ports].sort((a, b) => a - b);
}

function ufwStep({ facts, desired, found }: SetupContext): HostStep {
  const sshPorts = realSshPorts(facts, desired);
  const web = desired.access === "public";
  const portText = sshPorts.join(", ");
  const allowed = web ? `SSH (port ${portText}), HTTP and HTTPS` : `SSH (port ${portText})`;
  const covering = (port: number, proto: "tcp" | "udp") =>
    facts.firewall.ufwRules
      .map((rule) => ({ rule: rule.rule, ...ufwRuleCovers(rule.rule, port, proto) }))
      .filter((coverage) => coverage.covers);
  const notes: string[] = [];
  // An existing allow/limit rule for the SSH port counts. In tunnel mode any covering rule is
  // enough (the tunnel reaches SSH on localhost); in public mode GitHub Actions connects from
  // changing addresses, so the port must be open to every address.
  const sshRulePorts = sshPorts.filter((port) => {
    const rules = covering(port, "tcp");
    if (!web) return rules.length === 0;
    const open = rules.filter((rule) => !rule.limitedSource);
    if (open.length === 0 && rules.length > 0) {
      notes.push(
        `Your firewall lets SSH (port ${port}) in only from some addresses (${rules.map((rule) => rule.rule).join("; ")}); OpsCrew's rule opens it to every address, because GitHub Actions deploys over SSH from changing addresses.`,
      );
    }
    if (open.length > 0 && open.every((rule) => rule.rateLimited)) {
      notes.push(
        `Your "limit" rule rate-limits SSH on port ${port} (6 connections in 30 seconds per address); a deploy opens several SSH connections in a row.`,
      );
    }
    return open.length === 0;
  });
  const webRules = web
    ? WEB_RULES.filter((rule) => {
        const [port, proto] = rule.split("/") as [string, "tcp" | "udp"];
        return !covering(Number(port), proto).some((coverage) => !coverage.limitedSource);
      })
    : [];
  const params = {
    sshPorts: sshPorts.join(" "),
    sshRulePorts: sshRulePorts.join(" "),
    webRules: webRules.join(" "),
    web,
    enable: facts.firewall.ufw !== "active",
    install: facts.firewall.ufw === "absent",
  };
  if (facts.firewall.foreign.length > 0) {
    found.push(findings.otherFirewall(facts.firewall.foreign));
    return step("ufw", TITLES.ufw, "blocked", params, "Another firewall manages this server.");
  }
  const staleWeb = web
    ? []
    : facts.firewall.ufwRules.filter((rule) => rule.comment === UFW_WEB_COMMENT);
  const missing = [...sshRulePorts, ...webRules];
  if (facts.firewall.ufw === "active" && missing.length === 0 && staleWeb.length === 0) {
    if (!facts.pendingUndo.ufw) {
      return step("ufw", `Firewall (ufw) allows ${allowed}`, "in-place", params, "Already set.");
    }
  }
  if (params.enable) {
    const blocked = wouldBlock(facts, sshPorts, web);
    if (blocked.length > 0) {
      found.push(findings.ufwWouldBlock(blocked));
      return step("ufw", TITLES.ufw, "blocked", params, "Other services would be cut off.");
    }
  }
  const what = params.enable
    ? `Turn on the ufw firewall: deny incoming traffic except ${allowed}`
    : `Add ufw rules for ${allowed}`;
  const extra = web
    ? ""
    : " No web ports are opened: the app is served through the Cloudflare Tunnel.";
  return step(
    "ufw",
    what,
    "change",
    params,
    `${params.install ? "ufw is installed first. " : ""}The SSH rule for the port sshd really uses is added before anything else (existing rules for it are kept and count); the server turns the firewall back off on its own unless new logins work afterwards. Rules are marked "${UFW_SSH_COMMENT}"/"${UFW_WEB_COMMENT}" so only OpsCrew's own rules are ever removed.${extra}${notes.length > 0 ? ` ${notes.join(" ")}` : ""}`,
  );
}

function upgradesStep({ facts }: SetupContext): HostStep {
  const params = { install: !facts.packages.unattendedUpgrades };
  if (facts.packages.unattendedUpgrades && facts.autoUpgrades && facts.autoUpgradesService) {
    return step("unattended-upgrades", TITLES.upgrades, "in-place", params, "Already on.");
  }
  return step(
    "unattended-upgrades",
    TITLES.upgrades,
    "change",
    params,
    `${params.install ? "Installs unattended-upgrades and turns" : "Turns"} on daily security updates in /etc/apt/apt.conf.d/21opscrew-auto-upgrades.`,
  );
}

function runtimeStep({ facts, found }: SetupContext): HostStep {
  const ours = setupEntry(facts, "runtime-dirs") !== undefined;
  const params = { owner: "deploy" };
  const foreign = facts.dirs.filter(
    (dir) => dir.kind === "link" || dir.kind === "other" || (dir.kind === "dir" && !ours),
  );
  if (foreign.length > 0) {
    found.push(findings.runtimeDirExists(foreign.map((dir) => dir.path)));
    return step(
      "runtime-dirs",
      TITLES.runtime,
      "blocked",
      params,
      "The directories already exist.",
    );
  }
  const ready = facts.dirs.every(
    (dir) =>
      dir.kind === "dir" && dir.owner === "deploy" && dir.group === "deploy" && dir.mode === "750",
  );
  return ready
    ? step("runtime-dirs", TITLES.runtime, "in-place", params, "Already there.")
    : step(
        "runtime-dirs",
        TITLES.runtime,
        "change",
        params,
        "The deploy workflow copies the app's runtime files to /srv/app; databases keep their data in /srv/data.",
      );
}

function markerStep({ facts, desired, found }: SetupContext): HostStep {
  // A Compose project named like the app may only exist when OpsCrew deployed this app here before
  // (its record says so, for example data kept by a teardown); the apply checks again.
  const ownProject =
    facts.record?.app === desired.app &&
    (facts.record.projectId === "" || facts.record.projectId === desired.projectId);
  const params = { app: desired.app, projectId: desired.projectId, ownProject };
  const title = `Mark this server as running the OpsCrew app "${desired.app}"`;
  const marker = facts.marker;
  if (marker === null) {
    return step(
      "app-marker",
      title,
      "change",
      params,
      "Writes /etc/opscrew/app.json (one server runs one OpsCrew app) and /var/lib/opscrew-ready, the flag that says the setup finished.",
    );
  }
  if (marker.app === desired.app && marker.projectId === desired.projectId) {
    if (!facts.ready) {
      return step("app-marker", title, "change", params, "The setup-finished flag is missing.");
    }
    return step("app-marker", title, "in-place", params, "Already marked.");
  }
  found.push(
    marker.app === desired.app
      ? findings.sameAppOtherProject(marker.app, marker.projectId)
      : findings.anotherApp(marker.app),
  );
  return step("app-marker", title, "blocked", params, `The server belongs to "${marker.app}".`);
}

/** The image a rendered Compose file names first (for the step title), if any. */
function imageOf(compose: string): string | undefined {
  return /^\s*image:\s*["']?([^"'\s]+)/m.exec(compose)?.[1];
}

function tunnelStep({ facts, desired, found }: SetupContext): HostStep | undefined {
  const tunnel = facts.tunnel;
  if (desired.access !== "tunnel" || desired.tunnel === undefined) {
    if (!tunnel.installed && !tunnel.running) return undefined;
    return step(
      "tunnel-connector",
      "Remove the Cloudflare Tunnel connector",
      "change",
      { remove: true },
      "The app is now served directly, so the tunnel connector is no longer needed.",
    );
  }
  const busy = localPortUsers(
    facts,
    TUNNEL_APP_PORT,
    facts.marker?.app === desired.app ? desired.app : null,
  );
  if (busy.length > 0) found.push(findings.tunnelPortInUse(busy));
  // The tunnel reaches SSH at ssh://localhost:<port>: sshd must listen on loopback or everywhere.
  const sshPorts = realSshPorts(facts, desired);
  const sshListeners = facts.listeners.filter(
    (listener) => listener.proto === "tcp" && sshPorts.includes(listener.port),
  );
  const local = (address: string) =>
    isLoopback(address) || ["0.0.0.0", "*", "[::]", "::"].includes(address);
  if (sshListeners.length > 0 && !sshListeners.some((listener) => local(listener.address))) {
    found.push(
      findings.sshdNotLocal(sshListeners.map((listener) => `${listener.address}:${listener.port}`)),
    );
  }
  const { compose, tunnelId } = desired.tunnel;
  // A different tunnel id means a new tunnel: its token must be written and the connector restarted.
  const sameTunnel = tunnel.tunnelId === tunnelId;
  const params = { compose, tunnelId, needsToken: !tunnel.secretFile || !sameTunnel };
  const image = imageOf(compose);
  const title = `${TITLES.tunnel}${image ? ` (${image})` : ""}`;
  if (
    tunnel.installed &&
    tunnel.composeSha256 === sha256(compose) &&
    tunnel.running &&
    tunnel.secretFile &&
    sameTunnel
  ) {
    return step("tunnel-connector", title, "in-place", params, "Already running.");
  }
  if (tunnel.installed && tunnel.tunnelId !== null && !sameTunnel) {
    return step(
      "tunnel-connector",
      title,
      "change",
      params,
      "The tunnel was replaced: OpsCrew writes the new tunnel's token (supplied at apply time, never part of this plan) and restarts the connector.",
    );
  }
  return step(
    "tunnel-connector",
    title,
    "change",
    params,
    `cloudflared runs as its own Compose project in /srv/opscrew/cloudflared and connects out to Cloudflare; no inbound port is opened, and the app answers it on 127.0.0.1:${TUNNEL_APP_PORT}. Its token is written to a root-only file at apply time and is never part of this plan.`,
  );
}

function portainerStep({ facts, desired, found }: SetupContext): HostStep | undefined {
  const portainer = facts.portainer;
  if (desired.portainer === undefined) {
    if (!portainer.installed && !portainer.running) return undefined;
    return step(
      "portainer",
      "Remove Portainer (its data volume stays)",
      "change",
      { remove: true, deleteData: false, dir: PORTAINER_DIR, runAs: "root" },
      "Portainer is turned off for this project.",
    );
  }
  const { version, compose } = desired.portainer;
  const params = {
    version,
    dir: PORTAINER_DIR,
    runAs: "root",
    composeInitial: compose.initial,
    composeFinal: compose.final,
    needsPassword: !portainer.dataVolume,
  };
  const title = `${TITLES.portainer} ${version} (${PORTAINER_REPOSITORY}), reachable only from the server itself (127.0.0.1:${PORTAINER_PORT})`;
  const busy = localPortUsers(facts, PORTAINER_PORT, PORTAINER_PROJECT);
  if (busy.length > 0) {
    found.push(findings.portainerPortInUse(busy));
    return step("portainer", title, "blocked", params, `Port ${PORTAINER_PORT} is in use.`);
  }
  // Portainer is opened with `ssh -L 9443:127.0.0.1:9443 deploy@server`: local forwarding.
  const forwarding = facts.sshd?.allowTcpForwarding ?? "yes";
  if (forwarding === "no" || forwarding === "remote") {
    found.push(findings.sshForwardingOff(forwarding));
    return step("portainer", title, "blocked", params, "SSH port forwarding is off.");
  }
  if (
    portainer.installed &&
    portainer.composeSha256 === sha256(compose.final) &&
    portainer.running &&
    !portainer.secretFile
  ) {
    return step("portainer", title, "in-place", params, "Already running.");
  }
  return step(
    "portainer",
    title,
    "change",
    params,
    params.needsPassword
      ? "Portainer runs as its own Compose project in /srv/opscrew/portainer. Its admin password is generated on your computer, written to a root-only file at apply time (never part of this plan) and deleted once the admin account exists."
      : "Portainer runs as its own Compose project in /srv/opscrew/portainer; its existing admin account and data are kept.",
  );
}

/** Steps for a server OpsCrew cannot work on yet: all blocked, the findings say why. */
function allBlocked(desired: DesiredHost): HostStep[] {
  const reason = "OpsCrew cannot prepare this server yet; see the findings.";
  const steps: HostStep[] = [
    step("docker", TITLES.docker, "blocked", {}, reason),
    step("docker-daemon", "Docker daemon settings", "blocked", {}, reason),
    step("deploy-user", TITLES.deployUser, "blocked", {}, reason),
    step("sshd", TITLES.sshd, "blocked", {}, reason),
    step("ufw", TITLES.ufw, "blocked", {}, reason),
    step("fail2ban", "Brute-force protection (fail2ban)", "blocked", {}, reason),
    step("unattended-upgrades", TITLES.upgrades, "blocked", {}, reason),
    step("runtime-dirs", TITLES.runtime, "blocked", {}, reason),
    step(
      "app-marker",
      `Mark this server as running the OpsCrew app "${desired.app}"`,
      "blocked",
      {},
      reason,
    ),
  ];
  if (desired.access === "tunnel")
    steps.push(step("tunnel-connector", TITLES.tunnel, "blocked", {}, reason));
  if (desired.portainer) steps.push(step("portainer", TITLES.portainer, "blocked", {}, reason));
  return steps;
}

/**
 * The host plan that prepares the server for `desired`: Docker, the deploy user, SSH hardening,
 * ufw, automatic updates, the runtime directories, the app marker and, when asked for, the tunnel
 * connector and Portainer. Each step is in place, a change or blocked; every blocked step comes
 * with a finding that says what was found and what to do.
 */
export function planHost(facts: HostFacts, desired: DesiredHost): HostPlan {
  const f = parseFacts(facts);
  const d = parseDesired(desired);
  if (f.privilege === "root" || f.privilege === "sudo") {
    if (d.admin.isRoot !== (f.privilege === "root") || d.admin.user !== f.user) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The server was inspected as ${f.user || "an unknown user"}, but the plan is for ${d.admin.user}.`,
        { hint: "Inspect the server again with the login you want OpsCrew to use." },
      );
    }
  }
  const fatal = fatalFindings(f);
  const plan: Mutable<HostPlan> = {
    schemaVersion: HOST_PLAN_SCHEMA_VERSION,
    purpose: "setup",
    app: d.app,
    steps: [],
    findings: [],
  };
  if (fatal.length > 0) {
    plan.steps = allBlocked(d);
    plan.findings = fatal;
    return plan;
  }
  const ctx: SetupContext = { facts: f, desired: d, found: [] };
  const sameApp = (owner: { app: string; projectId: string } | null | undefined) =>
    owner?.app === d.app && (owner.projectId === "" || owner.projectId === d.projectId);
  // The host record belongs to another app (its marker is gone but its host changes remain).
  if (f.record !== null && f.record.app !== "" && !sameApp(f.record)) {
    if (f.marker === null || sameApp(f.marker)) {
      ctx.found.push(findings.hostRecordOtherApp(f.record.app));
    }
  }
  // A Compose project with the app's name that OpsCrew did not deploy would be taken over.
  const ours = sameApp(f.marker) || sameApp(f.record);
  // A stopped dockerd hides its containers and volumes: never start it from an inspection.
  if (f.docker.kind === "docker-repo" && !f.docker.running && !ours) {
    ctx.found.push(findings.dockerStopped());
  }
  if (!f.flock) ctx.found.push(findings.noFlock());
  if (
    !ours &&
    (f.containers.some((container) => container.project === d.app) ||
      f.volumeProjects.includes(d.app))
  ) {
    ctx.found.push(findings.composeProjectExists(d.app));
  }
  if (d.access === "public") {
    const users = webPortUsers(f, d.app);
    if (users.length > 0) ctx.found.push(findings.portsInUse(users));
  }
  const steps = [
    packageRepairStep(f),
    dockerStep(ctx),
    dockerDaemonStep(ctx),
    deployUserStep(ctx),
    sshdStep(ctx),
    ufwStep(ctx),
    fail2banStep(ctx),
    upgradesStep(ctx),
    runtimeStep(ctx),
    markerStep(ctx),
    tunnelStep(ctx),
    portainerStep(ctx),
  ].filter((item): item is HostStep => item !== undefined);
  plan.steps = steps;
  plan.findings = ctx.found;
  return plan;
}

/**
 * The host plan that removes the app from the server: its containers and runtime files, the
 * tunnel connector and Portainer, and the app marker. App data (/srv/data, Compose volumes,
 * Portainer's data) is deleted only with `deleteData`. The server itself is never touched.
 */
export function planTeardown(facts: HostFacts, opts: { deleteData: boolean }): HostPlan {
  const f = parseFacts(facts);
  if (typeof opts?.deleteData !== "boolean") {
    throw new OpsCrewError("INVALID_INPUT", "deleteData must be true or false.");
  }
  const deleteData = opts.deleteData;
  const found: HostFinding[] = [];
  if (f.privilege === "sudo-password") found.push(findings.sudoNeedsPassword(f.user));
  else if (f.privilege === "none") found.push(findings.noRoot(f.user));
  if (f.markerDamaged) found.push(findings.markerDamaged());
  const app = f.marker?.app ?? "";
  const steps: HostStep[] = [];
  if (app !== "") {
    const appDir = f.dirs.find((dir) => dir.path === "/srv/app");
    const dataDir = f.dirs.find((dir) => dir.path === "/srv/data");
    const containers = f.containers.filter((container) => container.project === app);
    const busy =
      containers.length > 0 ||
      (appDir?.entries ?? 0) > 0 ||
      (deleteData && (dataDir?.entries ?? 0) > 0);
    steps.push(
      step(
        "runtime-dirs",
        deleteData
          ? `Remove the app "${app}": its containers, runtime files in /srv/app, and its data in /srv/data and Compose volumes`
          : `Remove the app "${app}": its containers and runtime files in /srv/app (its data in /srv/data and Compose volumes stay)`,
        busy ? "change" : "in-place",
        { app, deleteData },
        busy
          ? `${containers.length} container${containers.length === 1 ? "" : "s"} of the app; runtime files in /srv/app.`
          : "Nothing of the app is left.",
      ),
    );
  }
  if (f.tunnel.installed) {
    steps.push(
      step(
        "tunnel-connector",
        "Remove the Cloudflare Tunnel connector and its token file",
        "change",
        { remove: true },
      ),
    );
  }
  if (f.portainer.installed || (deleteData && f.portainer.dataVolume)) {
    steps.push(
      step(
        "portainer",
        deleteData ? "Remove Portainer and its data" : "Remove Portainer (its data volume stays)",
        "change",
        { remove: true, deleteData },
      ),
    );
  }
  if (f.marker !== null) {
    steps.push(
      step(
        "app-marker",
        `Remove the marker that binds this server to "${app}"`,
        "change",
        {},
        "The server itself, Docker and OpsCrew's host settings stay; undo those separately if you want.",
      ),
    );
  }
  return {
    schemaVersion: HOST_PLAN_SCHEMA_VERSION,
    purpose: "teardown",
    app,
    steps,
    findings: found,
    deleteData,
  };
}

/** Rules OpsCrew added (by comment) that were not there before it, as `port/proto`. */
function rulesToRemove(
  facts: HostFacts,
  previous: HostRecordEntry["previous"] | undefined,
): string[] {
  const before = new Set(
    String(previous?.rules ?? "")
      .split(",")
      .map((rule) => rule.trim())
      .filter((rule) => rule !== ""),
  );
  return facts.firewall.ufwRules
    .filter((rule) => rule.comment === UFW_SSH_COMMENT || rule.comment === UFW_WEB_COMMENT)
    .filter((rule) => !before.has(rule.rule))
    .map((rule) => /^allow (\d{1,5}\/(?:tcp|udp))$/.exec(rule.rule)?.[1])
    .filter((rule): rule is string => rule !== undefined);
}

/**
 * The host plan that reverses OpsCrew's own host changes, from the record in
 * `/etc/opscrew/host.json`: Portainer and the tunnel connector, empty runtime directories,
 * automatic updates, firewall rules, SSH settings and the deploy user. Anything OpsCrew did not
 * install is left alone, and Docker stays installed (other software may use it).
 */
export function planUndo(facts: HostFacts): HostPlan {
  const f = parseFacts(facts);
  const found: HostFinding[] = [];
  if (f.privilege === "sudo-password") found.push(findings.sudoNeedsPassword(f.user));
  else if (f.privilege === "none") found.push(findings.noRoot(f.user));
  if (f.recordDamaged) found.push(findings.recordDamaged());
  if (f.markerDamaged) found.push(findings.markerDamaged());
  if (f.marker !== null) found.push(findings.appStillDeployed(f.marker.app));
  if (!f.flock) found.push(findings.noFlock());
  const record = f.record;
  const steps: HostStep[] = [];
  const app = record?.app ?? "";
  if (record === null) {
    return {
      schemaVersion: HOST_PLAN_SCHEMA_VERSION,
      purpose: "undo",
      app,
      steps,
      findings: found,
    };
  }
  const entry = (id: HostStepId) => setupEntry(f, id);
  const repair = packageRepairStep(f);
  if (repair) steps.push(repair);

  if (entry("portainer") && (f.portainer.installed || f.portainer.running)) {
    steps.push(
      step(
        "portainer",
        "Remove Portainer (its data volume stays; delete it with opscrew portainer disable)",
        "change",
        { remove: true, deleteData: false },
      ),
    );
  }
  if (entry("tunnel-connector") && (f.tunnel.installed || f.tunnel.running)) {
    steps.push(
      step("tunnel-connector", "Remove the Cloudflare Tunnel connector", "change", {
        remove: true,
      }),
    );
  }
  const runtime = entry("runtime-dirs");
  if (runtime) {
    const created = RUNTIME_DIRS.filter(
      (path) => runtime.previous[path.slice("/srv/".length)] === "absent",
    );
    const existing = f.dirs.filter(
      (dir) => created.includes(dir.path as never) && dir.kind === "dir",
    );
    const kept = existing.filter((dir) => (dir.entries ?? 0) > 0).map((dir) => dir.path);
    if (created.length > 0 && existing.length > 0) {
      steps.push(
        step(
          "runtime-dirs",
          `Remove ${created.join(" and ")} if they are empty`,
          existing.some((dir) => (dir.entries ?? 0) === 0) ? "change" : "in-place",
          { dirs: created.join(" ") },
          kept.length > 0
            ? `${kept.join(" and ")} still ${kept.length === 1 ? "holds" : "hold"} files (for example app data you kept), so ${kept.length === 1 ? "it stays" : "they stay"}.`
            : undefined,
        ),
      );
    }
  }
  const upgrades = entry("unattended-upgrades");
  if (upgrades) {
    const removePackage = upgrades.previous.installed === false;
    const disableService = !removePackage && upgrades.previous.serviceEnabled === false;
    steps.push(
      step(
        "unattended-upgrades",
        removePackage
          ? "Remove OpsCrew's automatic-update settings and the unattended-upgrades package it installed"
          : "Remove OpsCrew's automatic-update settings",
        "change",
        { removePackage, disableService },
      ),
    );
  }
  const fail2ban = entry("fail2ban");
  if (fail2ban) {
    const removePackage = fail2ban.previous.installed === false && f.packages.fail2ban;
    const disableService = !removePackage && fail2ban.previous.active === false;
    steps.push(
      step(
        "fail2ban",
        removePackage
          ? "Remove OpsCrew's fail2ban jail and the fail2ban package it installed"
          : "Remove OpsCrew's fail2ban jail for SSH",
        f.fail2ban.jail !== null || removePackage || (disableService && f.fail2ban.active)
          ? "change"
          : "in-place",
        { removePackage, disableService },
      ),
    );
  }
  const ufw = entry("ufw");
  if (ufw) {
    const removeRules = rulesToRemove(f, ufw.previous);
    const disable = ufw.previous.active === false && f.firewall.ufw === "active";
    const removePackage = ufw.previous.installed === false && f.packages.ufw;
    // OpsCrew set the default policies when it turned ufw on; put the old ones back.
    const policy = (key: string) => {
      const value = ufw.previous[key];
      return ufw.previous.active === false &&
        typeof value === "string" &&
        /^(allow|deny|reject)$/.test(value)
        ? value
        : "";
    };
    const defaults = {
      defaultIncoming: policy("defaultIncoming"),
      defaultOutgoing: policy("defaultOutgoing"),
      defaultRouted: policy("defaultRouted"),
    };
    const current = f.firewall.ufwDefaults;
    const defaultsDiffer =
      current !== null &&
      ((defaults.defaultIncoming !== "" && defaults.defaultIncoming !== current.incoming) ||
        (defaults.defaultOutgoing !== "" && defaults.defaultOutgoing !== current.outgoing) ||
        (defaults.defaultRouted !== "" && defaults.defaultRouted !== current.routed));
    const nothing = removeRules.length === 0 && !disable && !removePackage && !defaultsDiffer;
    steps.push(
      step(
        "ufw",
        disable
          ? "Turn the ufw firewall off again, remove OpsCrew's rules and put the previous default policies back"
          : "Remove the firewall rules OpsCrew added",
        nothing ? "in-place" : "change",
        { removeRules: removeRules.join(" "), disable, removePackage, ...defaults },
        removeRules.length > 0 ? `Rules: ${removeRules.join(", ")}.` : undefined,
      ),
    );
  }
  if (entry("sshd")) {
    const ours = f.sshd?.dropIn?.startsWith("# Managed by OpsCrew") ?? false;
    steps.push(
      step(
        "sshd",
        entry("sshd")?.previous.dropIn === "present"
          ? "Put back the SSH settings file that was there before OpsCrew"
          : "Remove OpsCrew's SSH settings file (10-opscrew.conf)",
        ours || f.pendingUndo.sshd ? "change" : "in-place",
        {},
        "The server undoes this on its own unless new logins still work afterwards.",
      ),
    );
  }
  const deploy = entry("deploy-user");
  if (deploy && deploy.previous.existed === false) {
    steps.push(
      step(
        "deploy-user",
        "Remove the deploy user OpsCrew created (and its home directory)",
        f.deployUser === null ? "in-place" : "change",
        {},
      ),
    );
  }
  const daemon = entry("docker-daemon");
  if (daemon && daemon.previous.file === "absent") {
    const title = "Remove the /etc/docker/daemon.json OpsCrew wrote";
    if (f.dockerDaemonJson === "opscrew") {
      steps.push(
        step(
          "docker-daemon",
          title,
          "change",
          {},
          "Docker reloads its settings; running containers keep running.",
        ),
      );
    } else if (f.dockerDaemonJson === "other") {
      steps.push(
        step(
          "docker-daemon",
          title,
          "in-place",
          {},
          "The file was changed after OpsCrew wrote it, so OpsCrew leaves it alone.",
        ),
      );
    }
  }
  if (entry("docker")) {
    steps.push(
      step(
        "docker",
        "Leave Docker installed",
        "in-place",
        {},
        "OpsCrew does not remove Docker, because other software on the server may use it. Remove it yourself with apt if you no longer need it.",
      ),
    );
  }
  steps.push(
    step("app-marker", "Remove OpsCrew's record of its changes (/etc/opscrew)", "change", {}),
  );
  return { schemaVersion: HOST_PLAN_SCHEMA_VERSION, purpose: "undo", app, steps, findings: found };
}
