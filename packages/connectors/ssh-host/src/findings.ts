/** Blocking findings: what OpsCrew found and what the user can do. Plain English, no secrets. */
import { listText, upperFirst } from "@opscrew/core";
import { MIN_DOCKER_MAJOR, PORTAINER_PORT, RUNNERS_DIR, TUNNEL_APP_PORT } from "./constants";
import { type HostFacts, otherActiveApps, readableRecords } from "./facts";
import type { AccessMode, HostFinding } from "./types";

/** How an app of each access mode is served, for findings. */
const SERVED: Readonly<Record<AccessMode, string>> = {
  public: "directly on ports 80 and 443 (DNS only)",
  "web-filter": "behind Cloudflare's proxy, with the web ports open to Cloudflare's addresses only",
  tunnel: "through a Cloudflare Tunnel, with no web port open",
};

/** Why the login cannot change the server: it needs a password for sudo, or cannot become root. */
export function privilegeFindings(
  facts: Pick<HostFacts, "privilege" | "user">,
  findings: HostFindings,
): HostFinding[] {
  if (facts.privilege === "sudo-password") return [findings.sudoNeedsPassword(facts.user)];
  if (facts.privilege === "none") return [findings.noRoot(facts.user)];
  return [];
}

/**
 * The apps whose records OpsCrew cannot rely on, so their hostnames and folders are unknown: a
 * record file it cannot read, or an app the host record lists (`listed`) without a record file
 * (except `app`, the one being planned: deleting its record lets its project take it again).
 */
export function damagedRecords(
  apps: HostFacts["apps"],
  listed: readonly string[],
  app: string,
  findings: HostFindings,
): HostFinding[] {
  const unreadable = apps.filter((item) => item.record === null).map((item) => item.name);
  const missing = listed.filter((name) => name !== app && !apps.some((item) => item.name === name));
  const damaged = [...unreadable, ...missing].sort();
  return damaged.length > 0 ? [findings.appRecordDamaged(damaged)] : [];
}

/**
 * Why the app `claim` cannot be recorded among `apps` (the records on the server, `listed` in the
 * host record), each finding naming the other app: a record OpsCrew cannot rely on, the app's name
 * used by another project, a hostname an app set up there holds, an app without a domain next to
 * another (it answers every name on port 80, so it must be alone), or an access mode other than
 * theirs (the apps share the firewall, and each mode needs its own stance: open, Cloudflare only,
 * or closed).
 */
export function claimFindings(
  apps: HostFacts["apps"],
  listed: readonly string[],
  claim: { app: string; projectId: string; access: AccessMode; hostnames: readonly string[] },
  findings: HostFindings,
): HostFinding[] {
  const found = damagedRecords(apps, listed, claim.app, findings);
  const named = readableRecords(apps).find((record) => record.app === claim.app);
  if (named !== undefined && named.projectId !== claim.projectId) {
    found.push(findings.appNameTaken(claim.app, named.projectId, named.state === "data-kept"));
  }
  const others = otherActiveApps(apps, claim.app);
  const wanted = new Set(claim.hostnames);
  for (const other of others) {
    const taken = other.hostnames.filter((hostname) => wanted.has(hostname));
    if (taken.length > 0) found.push(findings.hostnameTaken(other.app, taken));
  }
  const catchAll = others.find((record) => record.hostnames.length === 0);
  if (claim.hostnames.length === 0 && others[0] !== undefined) {
    found.push(findings.noDomainNextToApps(others.map((record) => record.app)));
  } else if (catchAll !== undefined) {
    found.push(findings.appWithoutDomain(catchAll.app));
  }
  const differs = others.find((record) => record.access !== null && record.access !== claim.access);
  if (differs?.access) {
    found.push(findings.accessModeConflict(differs.app, differs.access, claim.access));
  }
  return found;
}

/** The findings of a run of one command ({@link hostFindings}). */
export type HostFindings = ReturnType<typeof hostFindings>;

/**
 * The blocking findings of a run of `command` (`opscrew provision`, `opscrew dns`,
 * `opscrew destroy`): a hint that ends with running OpsCrew again names that command.
 */
export function hostFindings(command: string) {
  const rerun = `then run ${command} again`;
  return {
    sudoNeedsPassword: (user: string): HostFinding => ({
      code: "sudo-needs-password",
      message: `The login ${user} needs a password for sudo, and OpsCrew never asks for or stores passwords.`,
      hint: `Connect as root, or allow passwordless sudo for ${user}: on the server run "sudo visudo -f /etc/sudoers.d/90-opscrew-${user}" and add the line "${user} ALL=(ALL) NOPASSWD:ALL", ${rerun}.`,
    }),
    noRoot: (user: string): HostFinding => ({
      code: "no-root-access",
      message: `The login ${user || "OpsCrew used"} cannot become root: it is not root and cannot use sudo.`,
      hint: `Connect as root or as a user with passwordless sudo, ${rerun}.`,
    }),
    unsupportedOs: (name: string): HostFinding => ({
      code: "unsupported-os",
      message: `This server runs ${name || "an operating system OpsCrew could not identify"}, which OpsCrew does not support.`,
      hint: "OpsCrew supports Ubuntu 22.04, 24.04 and 26.04 LTS and Debian 12 and 13. Use a server with one of them.",
    }),
    unsupportedArch: (arch: string): HostFinding => ({
      code: "unsupported-arch",
      message: `This server's processor architecture is ${arch || "unknown"}; OpsCrew supports amd64 and arm64.`,
      hint: "Use a 64-bit server (x86-64 or ARM64). On a Raspberry Pi, install the 64-bit OS.",
    }),
    noFlock: (): HostFinding => ({
      code: "no-flock",
      message:
        "This server has no flock command (from util-linux), which OpsCrew's automatic undo of SSH and firewall changes relies on.",
      hint: `Install util-linux ("sudo apt-get install util-linux"), ${rerun}.`,
    }),
    dockerStopped: (): HostFinding => ({
      code: "docker-stopped",
      message: "Docker is installed but not running, so OpsCrew cannot see its containers.",
      hint: "Start Docker (`sudo systemctl start docker`), then plan again.",
    }),
    noSystemd: (): HostFinding => ({
      code: "no-systemd",
      message:
        "This server does not run systemd, which OpsCrew needs to manage Docker and to undo risky changes on its own.",
      hint: "Use a server (or container host) that boots with systemd.",
    }),
    sshdUnreadable: (): HostFinding => ({
      code: "sshd-unreadable",
      message: "OpsCrew could not read the SSH server's settings (sshd -T failed).",
      hint: `Check that OpenSSH server is installed and its configuration is valid (run "sudo sshd -t" on the server), ${rerun}.`,
    }),
    sshdNoInclude: (): HostFinding => ({
      code: "sshd-dropin-ignored",
      message:
        "/etc/ssh/sshd_config does not read the files in /etc/ssh/sshd_config.d, so OpsCrew cannot add its SSH settings without editing your main file.",
      hint: `Add the line "Include /etc/ssh/sshd_config.d/*.conf" at the top of /etc/ssh/sshd_config, ${rerun}.`,
    }),
    sshdDeploysBlocked: (setting: string): HostFinding => ({
      code: "sshd-blocks-deploy",
      message: `The SSH server only lets in some users (${setting}), and the deploy user OpsCrew needs for deploys is not one of them.`,
      hint: `Add deploy to that setting (or remove the setting) in your SSH configuration, ${rerun}.`,
    }),
    passwordUsersWithoutKeys: (users: readonly string[]): HostFinding => ({
      code: "password-users-without-keys",
      message: `${listText(users)} ${users.length === 1 ? "logs" : "log"} in with a password and ${users.length === 1 ? "has" : "have"} no SSH key. Turning password logins off would lock ${users.length === 1 ? "that user" : "them"} out.`,
      hint: "Give each of them an SSH key first, or decide explicitly: turn password logins off anyway, or leave password logins as they are.",
    }),
    directoryLogins: (what: readonly string[]): HostFinding => ({
      code: "directory-logins",
      message: `Users on this server may come from a directory service (${listText(what)}). OpsCrew cannot see whether they log in with passwords, so turning password logins off could lock them out.`,
      hint: "Make sure those users log in with SSH keys, then decide explicitly: turn password logins off anyway, or leave password logins as they are.",
    }),
    composeProjectExists: (app: string): HostFinding => ({
      code: "compose-project-exists",
      message: `This server already has Docker containers or volumes of a Compose project named "${app}" that OpsCrew did not deploy. OpsCrew's app would take them over.`,
      hint: `Remove that project (or rename it), or give the app another name, ${rerun}.`,
    }),
    portsInUse: (what: readonly string[]): HostFinding => ({
      code: "web-ports-in-use",
      message: `Ports 80 or 443 are already in use on this server: ${listText(what)}. OpsCrew's web server needs them to serve the app directly.`,
      hint: `Use the Cloudflare Tunnel instead (the app is served without these ports), or stop what uses them first, ${rerun}.`,
    }),
    otherFirewall: (what: readonly string[]): HostFinding => ({
      code: "other-firewall",
      message: `This server already uses another firewall: ${listText(what)}. OpsCrew does not add a second one.`,
      hint: `Either turn that firewall off and let OpsCrew manage ufw (it allows only SSH and web traffic), or keep yours and do not use OpsCrew on this server for now. ${upperFirst(rerun)} after the change.`,
    }),
    dockerNftables: (): HostFinding => ({
      code: "docker-nftables",
      message:
        "Docker on this server uses its nftables firewall backend, which has no DOCKER-USER chain, so OpsCrew cannot limit the web ports to Cloudflare's addresses there.",
      hint: `Serve the site through a Cloudflare Tunnel (recommended) or with DNS only (opscrew interview), or switch Docker back to iptables (remove "firewall-backend" from /etc/docker/daemon.json and restart Docker), ${rerun}.`,
    }),
    dockerNoIptables: (): HostFinding => ({
      code: "docker-no-iptables",
      message:
        'Docker on this server does not manage iptables ("iptables": false), so there is no DOCKER-USER chain and its published ports cannot be limited to Cloudflare\'s addresses.',
      hint: `Serve the site through a Cloudflare Tunnel (recommended) or with DNS only (opscrew interview), or let Docker manage iptables again (remove "iptables": false from /etc/docker/daemon.json and restart Docker), ${rerun}.`,
    }),
    /** `lettingAllIn`: ufw is on but its default incoming policy is "allow" (OpsCrew sets deny). */
    ufwWouldBlock: (what: readonly string[], lettingAllIn = false): HostFinding =>
      lettingAllIn
        ? {
            code: "firewall-would-block",
            message: `ufw is on but lets every incoming connection in. Once OpsCrew sets it to deny incoming traffic except SSH (and web traffic when the server serves the web), other machines could no longer reach ${listText(what)}.`,
            hint: `Stop those services or make them listen on 127.0.0.1 only, or add ufw rules that allow them (for example "sudo ufw allow 8080/tcp"; OpsCrew keeps them), ${rerun}.`,
          }
        : {
            code: "firewall-would-block",
            message: `The firewall OpsCrew turns on allows only SSH and web traffic, so other machines could no longer reach ${listText(what)}.`,
            hint: `Stop those services or make them listen on 127.0.0.1 only, or turn on ufw yourself with rules for them (OpsCrew then only adds its own rules), ${rerun}.`,
          },
    dockerSnap: (): HostFinding => ({
      code: "docker-snap",
      message:
        "Docker on this server comes from Snap. OpsCrew needs Docker Engine from Docker's own repository and does not replace the Snap package itself.",
      hint: `If nothing else needs it, remove it with "sudo snap remove docker" (this deletes its containers), ${rerun}.`,
    }),
    dockerPodman: (): HostFinding => ({
      code: "docker-podman",
      message:
        "The docker command on this server is Podman (podman-docker). OpsCrew needs Docker Engine and does not replace Podman.",
      hint: `If nothing else needs it, remove it with "sudo apt-get remove podman-docker", ${rerun}.`,
    }),
    dockerDistro: (packages: readonly string[]): HostFinding => ({
      code: "docker-distro",
      message: `Docker on this server comes from the distribution's packages (${listText(packages)}), which OpsCrew cannot upgrade to Docker Engine ${MIN_DOCKER_MAJOR} from Docker's repository without replacing them.`,
      hint: `Replacing them restarts your containers and is your decision: remove them with "sudo apt-get remove ${packages.join(" ")}" (images and volumes stay in /var/lib/docker), ${rerun}.`,
    }),
    dockerOther: (): HostFinding => ({
      code: "docker-unknown-install",
      message:
        "Docker is installed on this server, but not from a package OpsCrew recognises (for example a manual or static install).",
      hint: `Install Docker Engine from Docker's apt repository (https://docs.docker.com/engine/install/), or remove the existing install, ${rerun}.`,
    }),
    dockerConflicts: (packages: readonly string[]): HostFinding => ({
      code: "docker-conflicting-packages",
      message: `This server has packages that conflict with Docker Engine: ${listText(packages)}. Installing Docker would remove them.`,
      hint: `Remove them yourself if nothing needs them ("sudo apt-get remove ${packages.join(" ")}"), ${rerun}.`,
    }),
    appNameTaken: (app: string, projectId: string, dataKept: boolean): HostFinding => ({
      code: "app-name-taken",
      message: `This server already has the OpsCrew app "${app}" from another project folder (id ${projectId})${dataKept ? ", removed with its data kept" : ""}, and an app name belongs to one project.`,
      hint: `Give this app another name (opscrew interview), or run OpsCrew from that project folder. If it is the same app checked out somewhere else and the old folder is gone, delete /etc/opscrew/apps/${app}.json on the server so this project can take over, ${rerun}.`,
    }),
    hostnameTaken: (app: string, hostnames: readonly string[]): HostFinding => ({
      code: "hostname-taken",
      message: `The OpsCrew app "${app}" on this server already serves ${listText(hostnames)}, and a hostname belongs to one app.`,
      hint: `Use other hostnames for this app (opscrew interview), or remove "${app}" first with opscrew destroy in its project, ${rerun}.`,
    }),
    accessModeConflict: (app: string, theirs: AccessMode, mine: AccessMode): HostFinding => ({
      code: "access-mode-conflict",
      message: `The OpsCrew app "${app}" on this server is served ${SERVED[theirs]}, and this app would be served ${SERVED[mine]}. The apps share the server's firewall: ${theirs === "tunnel" || mine === "tunnel" ? "opening the web ports would also serve the tunnelled app's site on them, past its tunnel" : "the filter that lets only Cloudflare reach the web ports would cut the direct app off, and without it the other app is open to everyone"}.`,
      hint: `Serve this app the same way as "${app}" (opscrew interview), or use another server for it, ${rerun}.`,
    }),
    reservedAppName: (app: string): HostFinding => ({
      code: "reserved-app-name",
      message: `The app name "${app}" is the name of OpsCrew's shared edge on every server, so an app cannot use it.`,
      hint: `Give the app another name (opscrew interview), ${rerun}.`,
    }),
    appRecordDamaged: (apps: readonly string[]): HostFinding => ({
      code: "app-record-damaged",
      message: `OpsCrew's ${apps.length === 1 ? "record" : "records"} of ${listText(apps.map((app) => `"${app}"`))} on this server (in /etc/opscrew/apps) ${apps.length === 1 ? "is" : "are"} damaged or missing, so OpsCrew cannot tell which hostnames and folders ${apps.length === 1 ? "that app holds" : "those apps hold"}.`,
      hint: `Look at /etc/opscrew/apps and the apps /etc/opscrew/host.json lists on the server: restore a damaged record from a backup or, when that app is no longer on the server, delete its record and its name in host.json, ${rerun}.`,
    }),
    appsChanged: (now: readonly string[]): HostFinding => ({
      code: "apps-changed",
      message: `The OpsCrew apps on this server changed since this host plan was made (now ${now.length === 0 ? "none besides this one" : listText(now.map((app) => `"${app}"`))}), and its shared parts were planned for the apps as they were, so OpsCrew changes nothing.`,
      hint: `Run ${command} again to make a fresh host plan for the server as it is now, and approve that one.`,
    }),
    noDomainNextToApps: (apps: readonly string[]): HostFinding => ({
      code: "no-domain-shared",
      message: `This app has no domain, so it would answer every request on port 80 of this server, and the OpsCrew ${apps.length === 1 ? "app" : "apps"} ${listText(apps.map((app) => `"${app}"`))} ${apps.length === 1 ? "is" : "are"} already served here. Only an app with its own domain can share a server.`,
      hint: `Give this app a domain (opscrew interview), or use another server for it, ${rerun}.`,
    }),
    appWithoutDomain: (app: string): HostFinding => ({
      code: "no-domain-shared",
      message: `The OpsCrew app "${app}" on this server has no domain, so it answers every request on port 80, and another app cannot share the server with it.`,
      hint: `Give "${app}" a domain (opscrew interview and opscrew provision in its project), or use another server for this app, ${rerun}.`,
    }),
    tunnelProjectTaken: (project: string): HostFinding => ({
      code: "tunnel-project-taken",
      message: `This app's Cloudflare Tunnel connector runs as the Compose project "${project}", and the OpsCrew app "${project}" on this server already has that name.`,
      hint: `Give this app or "${project}" another name (opscrew interview), or use another server for this app, ${rerun}.`,
    }),
    recordDamaged: (): HostFinding => ({
      code: "host-record-damaged",
      message:
        "OpsCrew's record of its changes on this server (/etc/opscrew/host.json) is damaged, so OpsCrew cannot tell what it changed before.",
      hint: "Do not delete it: it is needed to undo OpsCrew's changes. Restore it from a backup if you have one, or report the problem.",
    }),
    deployUserExists: (): HostFinding => ({
      code: "deploy-user-exists",
      message:
        'A user named "deploy" already exists on this server and OpsCrew did not create it. OpsCrew does not take over existing users.',
      hint: `Rename or remove that user, ${rerun}.`,
    }),
    runnersDirTaken: (owner: string | undefined): HostFinding => ({
      code: "runners-dir-taken",
      message: `${RUNNERS_DIR} already exists on this server and is not the deploy user's folder (${owner === undefined ? "it is not a plain folder" : `its owner is ${owner}`}), so OpsCrew does not take it over for the GitHub Actions runner.`,
      hint: `Move or rename it if nothing on the server uses it, or set environment.runner to github in the plan, ${rerun}.`,
    }),
    runtimeDirExists: (paths: readonly string[]): HostFinding => ({
      code: "runtime-dir-exists",
      message: `${listText(paths)} already ${paths.length === 1 ? "exists" : "exist"} on this server and OpsCrew did not create ${paths.length === 1 ? "it" : "them"}. OpsCrew keeps the app's files there.`,
      hint: `Move or rename ${paths.length === 1 ? "it" : "them"}, ${rerun}.`,
    }),
    portainerPortInUse: (what: readonly string[]): HostFinding => ({
      code: "portainer-port-in-use",
      message: `Port ${PORTAINER_PORT}, which Portainer uses on the server itself, is already taken by ${listText(what)}.`,
      hint: `Stop what uses port ${PORTAINER_PORT}, or leave Portainer off, ${rerun}.`,
    }),
    tunnelPortInUse: (what: readonly string[]): HostFinding => ({
      code: "tunnel-port-in-use",
      message: `Port ${TUNNEL_APP_PORT}, where the app listens on the server itself for the Cloudflare Tunnel, is already taken by ${listText(what)}.`,
      hint: `Stop what uses port ${TUNNEL_APP_PORT}, or serve the app directly on ports 80 and 443 instead of through the tunnel, ${rerun}.`,
    }),
    sshdNotLocal: (addresses: readonly string[]): HostFinding => ({
      code: "sshd-not-local",
      message: `SSH listens only on ${listText(addresses)}, but the Cloudflare Tunnel reaches SSH on the server itself (localhost) so that GitHub Actions can deploy.`,
      hint: `Let sshd also listen on 127.0.0.1 (or on all addresses) with a ListenAddress line in your SSH configuration, ${rerun}.`,
    }),
    sshForwardingOff: (setting: string): HostFinding => ({
      code: "ssh-forwarding-off",
      message: `SSH port forwarding is turned off on this server (AllowTcpForwarding ${setting}), and the command that opens Portainer through SSH needs it.`,
      hint: `Allow local forwarding for the deploy user (a "Match User deploy" block with "AllowTcpForwarding local" at the end of /etc/ssh/sshd_config), or leave Portainer off, ${rerun}.`,
    }),
    appStillDeployed: (apps: readonly string[]): HostFinding => ({
      code: "app-still-deployed",
      message: `The OpsCrew ${apps.length === 1 ? "app" : "apps"} ${listText(apps.map((app) => `"${app}"`))} ${apps.length === 1 ? "is" : "are"} still on this server, and undoing OpsCrew's host changes would break ${apps.length === 1 ? "it" : "them"}.`,
      hint: `Remove ${apps.length === 1 ? "the app" : "each app"} first with opscrew destroy in ${apps.length === 1 ? "its project" : "their projects"}, then undo the host changes.`,
    }),
  } as const;
}
