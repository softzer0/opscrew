import { type DeployPlan, type OwnDeployTarget, serviceOf } from "@opscrew/plan-schema";
import { usesCloudflare } from "../predicates";
import { siteHosts } from "../runtime";
import { PORTAINER_PORT, portainerHostname, sshHostname, tunnelMode } from "../tunnel";
import type { RenderContext, RenderedFile } from "../types";
import {
  cell,
  DATABASE_DUMP,
  DEPLOY_AGAIN,
  DEPLOY_KEY_STORED,
  DRIFT_FILES,
  deployRows,
  deploySections,
  externalDatabaseCell,
  runbookHead,
  SECURITY_HEAD,
  serverCommands,
  settingsSection,
  TROUBLESHOOTING,
} from "./shared";

/**
 * `opscrew/RUNBOOK.md` for a server the user already owns. The server's address never appears in
 * it, in any mode (FR-902, stricter than ADR 0010's exception for unproxied servers): commands name
 * `<server>`, and `ctx.serverIpv4`/`serverIpv6` are ignored. No server price: the user already
 * pays for the server. Backups are the user's responsibility, and the Portainer password is only
 * named by its file.
 */
export function renderOwnRunbook(
  plan: DeployPlan,
  target: OwnDeployTarget,
  ctx: RenderContext,
): RenderedFile {
  const tunnel = tunnelMode(plan);
  const cloudflare = usesCloudflare(plan);
  const proxied = cloudflare && plan.dns.proxied;
  const hosts = siteHosts(plan);
  const url =
    hosts.length > 0 ? `https://${hosts[0]}` : "`http://<server>` (your server's address)";
  const projectDir = `~/.opscrew/projects/${ctx.projectId ?? "<project-id>"}`;
  const keyPath = `${projectDir}/deploy_key`;
  const server = "<server>";
  // Both commands connect to the server directly (in tunnel mode over the user's own network), so
  // sshd's port applies whenever it is not 22.
  const port = ctx.sshPort !== undefined && ctx.sshPort !== 22 ? `-p ${ctx.sshPort} ` : "";
  const sshHost = sshHostname(plan);
  const portainer = plan.portainer?.enabled ? plan.portainer : undefined;
  const portainerHost = portainerHostname(plan);
  const repo = `${ctx.github.owner}/${ctx.github.repo}`;
  const name = plan.app.name;

  const addresses = tunnel
    ? "none needed: the server is reached through a Cloudflare Tunnel"
    : proxied
      ? "kept private behind Cloudflare: `opscrew status` shows them"
      : "kept out of this repository: `opscrew status` shows them";
  const db = serviceOf(plan, "postgres")
    ? "PostgreSQL 17 in a container on the server, data in `/srv/data/postgres`; backups are your responsibility"
    : externalDatabaseCell(plan);
  const dns = tunnel
    ? "Cloudflare, through a Cloudflare Tunnel (no DNS record points at the server)"
    : cloudflare
      ? `Cloudflare, ${plan.dns.proxied ? "proxied (the server's address is hidden behind Cloudflare)" : "DNS only"}`
      : "No domain yet: the app is served over plain HTTP on the server's address";

  const lines = [
    ...runbookHead(plan, ctx, url),
    `| Server | ${cell(`your own server (${target.arch}); OpsCrew prepared it over SSH and never creates, rebuilds or deletes it`)} |`,
    `| IPv4 / IPv6 | ${cell(addresses)} |`,
    ...(sshHost === undefined
      ? []
      : [
          `| SSH for deploys | \`${sshHost}\`, through the tunnel and Cloudflare Access (only the deploy workflow's service token gets in) |`,
        ]),
    ...deployRows(plan, repo),
    `| Database | ${cell(db)} |`,
    `| DNS | ${cell(dns)} |`,
    ...(portainer === undefined
      ? []
      : [
          `| Portainer | ${cell(portainerHost ? `https://${portainerHost} (Cloudflare Access) and through an SSH tunnel` : "through an SSH tunnel only")} |`,
        ]),
    "| Cost | no server price: you already pay for this server; OpsCrew adds no server cost |",
    "",
    ...deploySections(plan, {
      build:
        target.arch === "arm64"
          ? ["   Your server is arm64, so the image is built on GitHub's arm64 runner."]
          : [],
      start:
        sshHost === undefined
          ? []
          : [
              `   Your server has no open port for this: the workflow installs a pinned \`cloudflared\` and connects to \`${sshHost}\``,
              "   through the Cloudflare Tunnel with a Cloudflare Access service token kept in the deploy secrets.",
            ],
    }),
    "## Connect to the server",
    "",
    "Your own login keeps working as before (with your key). To work as the deploy user:",
    "",
    ...serverCommands([`ssh ${port}-i ${keyPath} deploy@${server}`]),
    "",
    "`<server>` is the address you gave OpsCrew; it is not written in this repository. `opscrew status` shows it on the",
    "machine that ran `opscrew provision`.",
    ...(tunnel
      ? [
          `The tunnel's SSH hostname (\`${sshHost}\`) only lets the deploy workflow in; connect over your own network`,
          "or VPN as you did when you ran `opscrew provision`.",
        ]
      : proxied
        ? [
            "Cloudflare's proxy hides the address, and a published address would let anyone go around Cloudflare.",
          ]
        : []),
    "",
    DEPLOY_KEY_STORED,
    "secret). OpsCrew turned off password logins on the server.",
    "",
    "## Backups are your responsibility",
    "",
    "OpsCrew cannot turn on backups or snapshots on a server you own, and `opscrew destroy` takes no snapshot. Back up",
    "the server the way your hosting provider or your own setup allows, and keep copies somewhere else.",
    "",
  ];
  if (serviceOf(plan, "postgres")) {
    lines.push("Back up the database regularly, for example:", "", ...DATABASE_DUMP);
  }

  if (portainer !== undefined) {
    lines.push(
      "## Portainer",
      "",
      `Portainer CE ${portainer.version} shows your server's containers. It listens only on the server itself`,
      `(127.0.0.1:${PORTAINER_PORT}), because it controls Docker, which is root on the server. To open it, start an SSH tunnel`,
      "(`opscrew portainer status` prints this command for you):",
      "",
      "```bash",
      `ssh ${port}-i ${keyPath} -N -L ${PORTAINER_PORT}:127.0.0.1:${PORTAINER_PORT} deploy@${server}`,
      "```",
      "",
      `Then open https://localhost:${PORTAINER_PORT} (Portainer uses a self-signed certificate) and log in as \`admin\`.`,
      `The password is in \`${projectDir}/portainer_password\``,
      "on the machine that ran `opscrew provision`; it is never written to this repository.",
      ...(portainerHost === undefined
        ? []
        : [
            "",
            `It is also served on https://${portainerHost}, behind Cloudflare Access: only the email addresses listed in`,
            "`opscrew/plan.yaml` get in, with a one-time PIN sent to that address, and Portainer's own login still applies.",
          ]),
      "",
      "`opscrew portainer disable` removes it (deleting its data only after you type the app name).",
      "",
    );
  }

  lines.push(
    ...settingsSection([
      "- **Domain or tunnel:** run `opscrew design` and `opscrew provision`. OpsCrew shows the plans (the Cloudflare changes and",
      "  the host changes) and applies nothing without your approval.",
      "- **Switching between direct access and the tunnel** runs in two steps: OpsCrew first removes the current way in",
      "  (the DNS records, or the tunnel and its Access applications), then adds the new one, each with its own plan and",
      "  approval. The app is not reachable on its domain between the two steps.",
      "- **Your server itself** (size, operating system, other software) is yours to manage; OpsCrew changes only what its",
      "  host plan lists, and records each change in `/etc/opscrew/host.json` on the server.",
    ]),
    "## Check for drift",
    "",
    "Run `opscrew drift` on the machine that ran `opscrew provision`. It compares:",
    "",
    `- **Cloudflare with the state and the code:** DNS records${tunnel || portainerHost ? ", the tunnel and Cloudflare Access" : ""} changed`,
    "  outside OpsCrew, or changes in `opscrew/infra/` that have not been applied yet.",
    "- **The server with what OpsCrew set up:** SSH settings, firewall rules, the deploy user, runtime files and containers,",
    "  against the record in `/etc/opscrew/host.json`.",
    ...DRIFT_FILES,
    "",
    "`opscrew drift` never changes anything. To fix drift, run `opscrew provision`, which shows the plans and applies",
    "nothing without your approval.",
    "",
    ...SECURITY_HEAD,
    "- What OpsCrew set up on the server: Docker Engine from Docker's repository, a `deploy` user with key-only SSH,",
    "  password logins off (root keeps key-only access only if you log in as root), automatic security updates and,",
    `  unless another firewall already manages the server, a host firewall that allows only SSH${tunnel ? "" : ", HTTP and HTTPS"}.`,
    tunnel
      ? "- No inbound web port is open: Cloudflare's edge reaches the app only through the tunnel, which the server dials out to."
      : "- Only Caddy publishes ports (80 and 443); every other container port stays on the server.",
  );
  if (!tunnel && proxied) {
    lines.push(
      "- Web traffic comes through Cloudflare's proxy; keep the server's address private so nobody goes around it.",
    );
  }
  lines.push(
    "",
    ...TROUBLESHOOTING,
    "## Tear it down",
    "",
    "Run `opscrew destroy` on the machine that ran `opscrew provision`. It removes what OpsCrew set up for this app: the",
    `${cloudflare ? `Cloudflare ${tunnel ? "tunnel, Access applications and DNS records" : "DNS records and rules"} OpsCrew created, the ` : ""}app's containers and runtime`,
    "files on the server, and the GitHub deploy secrets. It **never** deletes, rebuilds or reinstalls your server.",
    "",
    `- **App data:** deleting the data in \`/srv/data\` needs the destroy approval and the typed app name (\`${name}\`;`,
    `  \`--confirm ${name}\` in scripts). There is no snapshot: back up first if you want to keep it.`,
    "- **Undo OpsCrew's host changes:** `opscrew destroy --undo-host` also plans the reverse of what OpsCrew changed on the",
    "  server (deploy user, SSH settings, firewall, automatic updates, Docker if OpsCrew installed it), from the record in",
    "  `/etc/opscrew/host.json`. It is a separate plan that you approve on its own.",
    `- **What remains:** your server, the container images in GitHub Container Registry (\`ghcr.io/${repo.toLowerCase()}\`), and`,
    `  the files in this repository (\`opscrew/\` and \`${plan.cicd.workflowPath}\`).`,
    "",
    ...DEPLOY_AGAIN,
  );
  return { path: "opscrew/RUNBOOK.md", content: lines.join("\n"), kind: "doc" };
}
