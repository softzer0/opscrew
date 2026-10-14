/** Blocking findings: what OpsCrew found and what the user can do. Plain English, no secrets. */
import { MIN_DOCKER_MAJOR, PORTAINER_PORT, TUNNEL_APP_PORT } from "./constants";
import type { HostFinding } from "./types";

const RERUN = "then run opscrew provision again";

function list(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const findings = {
  sudoNeedsPassword: (user: string): HostFinding => ({
    code: "sudo-needs-password",
    message: `The login ${user} needs a password for sudo, and OpsCrew never asks for or stores passwords.`,
    hint: `Connect as root, or allow passwordless sudo for ${user}: on the server run "sudo visudo -f /etc/sudoers.d/90-opscrew-${user}" and add the line "${user} ALL=(ALL) NOPASSWD:ALL", ${RERUN}.`,
  }),
  noRoot: (user: string): HostFinding => ({
    code: "no-root-access",
    message: `The login ${user || "OpsCrew used"} cannot become root: it is not root and cannot use sudo.`,
    hint: `Connect as root or as a user with passwordless sudo, ${RERUN}.`,
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
  noSystemd: (): HostFinding => ({
    code: "no-systemd",
    message:
      "This server does not run systemd, which OpsCrew needs to manage Docker and to undo risky changes on its own.",
    hint: "Use a server (or container host) that boots with systemd.",
  }),
  sshdUnreadable: (): HostFinding => ({
    code: "sshd-unreadable",
    message: "OpsCrew could not read the SSH server's settings (sshd -T failed).",
    hint: `Check that OpenSSH server is installed and its configuration is valid (run "sudo sshd -t" on the server), ${RERUN}.`,
  }),
  sshdNoInclude: (): HostFinding => ({
    code: "sshd-dropin-ignored",
    message:
      "/etc/ssh/sshd_config does not read the files in /etc/ssh/sshd_config.d, so OpsCrew cannot add its SSH settings without editing your main file.",
    hint: `Add the line "Include /etc/ssh/sshd_config.d/*.conf" at the top of /etc/ssh/sshd_config, ${RERUN}.`,
  }),
  sshdDeploysBlocked: (setting: string): HostFinding => ({
    code: "sshd-blocks-deploy",
    message: `The SSH server only lets in some users (${setting}), and the deploy user OpsCrew needs for deploys is not one of them.`,
    hint: `Add deploy to that setting (or remove the setting) in your SSH configuration, ${RERUN}.`,
  }),
  passwordUsersWithoutKeys: (users: readonly string[]): HostFinding => ({
    code: "password-users-without-keys",
    message: `${list(users)} ${users.length === 1 ? "logs" : "log"} in with a password and ${users.length === 1 ? "has" : "have"} no SSH key. Turning password logins off would lock ${users.length === 1 ? "that user" : "them"} out.`,
    hint: "Give each of them an SSH key first, or decide explicitly: turn password logins off anyway, or leave password logins as they are.",
  }),
  directoryLogins: (what: readonly string[]): HostFinding => ({
    code: "directory-logins",
    message: `Users on this server may come from a directory service (${list(what)}). OpsCrew cannot see whether they log in with passwords, so turning password logins off could lock them out.`,
    hint: "Make sure those users log in with SSH keys, then decide explicitly: turn password logins off anyway, or leave password logins as they are.",
  }),
  hostRecordOtherApp: (app: string): HostFinding => ({
    code: "host-record-other-app",
    message: `OpsCrew prepared this server for the app "${app}" before, and its record of those host changes (/etc/opscrew/host.json) still belongs to "${app}".`,
    hint: `Undo those host changes first with opscrew destroy --undo-host in the project of "${app}", then run opscrew provision again.`,
  }),
  composeProjectExists: (app: string): HostFinding => ({
    code: "compose-project-exists",
    message: `This server already has Docker containers or volumes of a Compose project named "${app}" that OpsCrew did not deploy. OpsCrew's app would take them over.`,
    hint: `Remove that project (or rename it), or give the app another name, ${RERUN}.`,
  }),
  portsInUse: (what: readonly string[]): HostFinding => ({
    code: "web-ports-in-use",
    message: `Ports 80 or 443 are already in use on this server: ${list(what)}. OpsCrew's web server needs them to serve the app directly.`,
    hint: `Use the Cloudflare Tunnel instead (the app is served without these ports), or stop what uses them first, ${RERUN}.`,
  }),
  otherFirewall: (what: readonly string[]): HostFinding => ({
    code: "other-firewall",
    message: `This server already uses another firewall: ${list(what)}. OpsCrew does not add a second one.`,
    hint: `Either turn that firewall off and let OpsCrew manage ufw (it allows only SSH and web traffic), or keep yours and do not use OpsCrew on this server for now. ${RERUN.charAt(0).toUpperCase()}${RERUN.slice(1)} after the change.`,
  }),
  ufwWouldBlock: (what: readonly string[]): HostFinding => ({
    code: "firewall-would-block",
    message: `The firewall OpsCrew turns on allows only SSH and web traffic, so other machines could no longer reach ${list(what)}.`,
    hint: `Stop those services or make them listen on 127.0.0.1 only, or turn on ufw yourself with rules for them (OpsCrew then only adds its own rules), ${RERUN}.`,
  }),
  dockerSnap: (): HostFinding => ({
    code: "docker-snap",
    message:
      "Docker on this server comes from Snap. OpsCrew needs Docker Engine from Docker's own repository and does not replace the Snap package itself.",
    hint: `If nothing else needs it, remove it with "sudo snap remove docker" (this deletes its containers), ${RERUN}.`,
  }),
  dockerPodman: (): HostFinding => ({
    code: "docker-podman",
    message:
      "The docker command on this server is Podman (podman-docker). OpsCrew needs Docker Engine and does not replace Podman.",
    hint: `If nothing else needs it, remove it with "sudo apt-get remove podman-docker", ${RERUN}.`,
  }),
  dockerDistro: (packages: readonly string[]): HostFinding => ({
    code: "docker-distro",
    message: `Docker on this server comes from the distribution's packages (${list(packages)}), which OpsCrew cannot upgrade to Docker Engine ${MIN_DOCKER_MAJOR} from Docker's repository without replacing them.`,
    hint: `Replacing them restarts your containers and is your decision: remove them with "sudo apt-get remove ${packages.join(" ")}" (images and volumes stay in /var/lib/docker), ${RERUN}.`,
  }),
  dockerOther: (): HostFinding => ({
    code: "docker-unknown-install",
    message:
      "Docker is installed on this server, but not from a package OpsCrew recognises (for example a manual or static install).",
    hint: `Install Docker Engine from Docker's apt repository (https://docs.docker.com/engine/install/), or remove the existing install, ${RERUN}.`,
  }),
  dockerConflicts: (packages: readonly string[]): HostFinding => ({
    code: "docker-conflicting-packages",
    message: `This server has packages that conflict with Docker Engine: ${list(packages)}. Installing Docker would remove them.`,
    hint: `Remove them yourself if nothing needs them ("sudo apt-get remove ${packages.join(" ")}"), ${RERUN}.`,
  }),
  anotherApp: (app: string): HostFinding => ({
    code: "another-app",
    message: `This server already runs the OpsCrew app "${app}". One server runs one OpsCrew app for now; sharing a server between apps comes with a later version.`,
    hint: `Use another server, or remove "${app}" first with opscrew destroy in its project.`,
  }),
  sameAppOtherProject: (app: string, projectId: string): HostFinding => ({
    code: "another-project",
    message: `This server runs an OpsCrew app named "${app}" from another project folder (id ${projectId}).`,
    hint: "Run OpsCrew from that project folder. If it is the same app checked out somewhere else and the old folder is gone, delete /etc/opscrew/app.json on the server so this project can take over.",
  }),
  markerDamaged: (): HostFinding => ({
    code: "marker-damaged",
    message:
      "OpsCrew's app marker on this server (/etc/opscrew/app.json) is damaged, so OpsCrew cannot tell which app owns the server.",
    hint: "Look at /etc/opscrew/app.json on the server. If no OpsCrew app runs there any more, delete the file and try again.",
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
    hint: `Rename or remove that user, ${RERUN}.`,
  }),
  runtimeDirExists: (paths: readonly string[]): HostFinding => ({
    code: "runtime-dir-exists",
    message: `${list(paths)} already ${paths.length === 1 ? "exists" : "exist"} on this server and OpsCrew did not create ${paths.length === 1 ? "it" : "them"}. OpsCrew keeps the app's files there.`,
    hint: `Move or rename ${paths.length === 1 ? "it" : "them"}, ${RERUN}.`,
  }),
  portainerPortInUse: (what: readonly string[]): HostFinding => ({
    code: "portainer-port-in-use",
    message: `Port ${PORTAINER_PORT}, which Portainer uses on the server itself, is already taken by ${list(what)}.`,
    hint: `Stop what uses port ${PORTAINER_PORT}, or leave Portainer off, ${RERUN}.`,
  }),
  tunnelPortInUse: (what: readonly string[]): HostFinding => ({
    code: "tunnel-port-in-use",
    message: `Port ${TUNNEL_APP_PORT}, where the app listens on the server itself for the Cloudflare Tunnel, is already taken by ${list(what)}.`,
    hint: `Stop what uses port ${TUNNEL_APP_PORT}, or serve the app directly on ports 80 and 443 instead of through the tunnel, ${RERUN}.`,
  }),
  sshdNotLocal: (addresses: readonly string[]): HostFinding => ({
    code: "sshd-not-local",
    message: `SSH listens only on ${list(addresses)}, but the Cloudflare Tunnel reaches SSH on the server itself (localhost) so that GitHub Actions can deploy.`,
    hint: `Let sshd also listen on 127.0.0.1 (or on all addresses) with a ListenAddress line in your SSH configuration, ${RERUN}.`,
  }),
  sshForwardingOff: (setting: string): HostFinding => ({
    code: "ssh-forwarding-off",
    message: `SSH port forwarding is turned off on this server (AllowTcpForwarding ${setting}), and the command that opens Portainer through SSH needs it.`,
    hint: `Allow local forwarding for the deploy user (a "Match User deploy" block with "AllowTcpForwarding local" at the end of /etc/ssh/sshd_config), or leave Portainer off, ${RERUN}.`,
  }),
  appStillDeployed: (app: string): HostFinding => ({
    code: "app-still-deployed",
    message: `The OpsCrew app "${app}" is still on this server, and undoing OpsCrew's host changes would break it.`,
    hint: "Remove the app first with opscrew destroy, then undo the host changes.",
  }),
} as const;
