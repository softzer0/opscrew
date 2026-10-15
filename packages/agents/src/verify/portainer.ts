import { OpsCrewError } from "@opscrew/core";
import {
  portainerConnectorStackName,
  portainerStackName,
  portainerStackVolumes,
  portainerUpdaterStackName,
  type RenderedFile,
} from "@opscrew/iac-templates";
import type { DeployPlan, PortainerDeployTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { PORTAINER_BACKUPS_NOTE, PORTAINER_HOST_NOTE } from "../design/portainer";
import { portainerDnsRecordNote } from "../provision/publish";
import { readPortainerConnection } from "../shared";

/** Hosts that mean "this computer"; they are not Portainer's address to anyone else. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Registers the address of the user's Portainer (as `.opscrew/server.json` records it) with the
 * redactor, so no output names it, not even inside an address the user gave for their route.
 */
export async function hidePortainerAddress(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<void> {
  const connection = await readPortainerConnection(deps.paths).catch(() => undefined);
  if (connection === undefined) return;
  const parsed = new URL(connection.url);
  deps.redactor.addLiteral(connection.url, "portainer-address");
  deps.redactor.addLiteral(parsed.origin, "portainer-address");
  if (!LOOPBACK.has(parsed.hostname)) {
    deps.redactor.addLiteral(parsed.host, "portainer-address");
    deps.redactor.addLiteral(parsed.hostname, "portainer-address");
  }
}

/**
 * The address `opscrew verify` checks for the user's Portainer: the one given (the user's own
 * route, for web mode `proxy` without a domain), else the app's domain. Stops plainly when there
 * is neither.
 */
export function portainerVerifyUrl(plan: DeployPlan, given: string | undefined): string {
  if (given !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(given);
    } catch {
      url = undefined;
    }
    if (
      url === undefined ||
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        "The address to check must be an http:// or https:// address without a login.",
        {
          hint: "Give the address your reverse proxy serves the app on, for example https://shop.example.com.",
        },
      );
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  }
  if (plan.dns.domain !== undefined) return `https://${plan.dns.domain}`;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "opscrew/plan.yaml has no domain, and OpsCrew does not know where your reverse proxy serves the app, so there is nothing to verify.",
    {
      hint: "Run `opscrew verify --url <the address your reverse proxy serves the app on>`, or give the app a domain with `opscrew dns --domain <hostname>`.",
    },
  );
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function webLine(plan: DeployPlan, target: PortainerDeployTarget): string {
  const web = target.web;
  if (web.mode === "tunnel") {
    return `Through a Cloudflare Tunnel: the cloudflared container in \`${portainerStackName(plan)}\` connects out to Cloudflare, and the stack publishes no port on the host.`;
  }
  if (web.mode === "proxy") {
    return `Through your own reverse proxy, which forwards to port ${web.port} of the host and manages the certificate (OpsCrew does not).`;
  }
  return "Through Caddy in the app's stack on ports 80 and 443 of the host, with automatic certificates.";
}

function redeployLines(plan: DeployPlan, target: PortainerDeployTarget): string[] {
  const branch = plan.cicd.branch;
  const write = `Every push to \`${branch}\` runs \`${plan.cicd.workflowPath}\`: it builds the image, pushes it to GitHub Container Registry and writes \`compose.yaml\` with the new image to the \`opscrew-deploy\` branch.`;
  return target.redeploy === "updater"
    ? [
        write,
        `The updater stack \`${portainerUpdaterStackName(plan)}\` asks your Portainer once a minute, over the local network, to redeploy \`${portainerStackName(plan)}\` from that branch when it changed.`,
      ]
    : [
        write,
        `The workflow then calls your Portainer's stack webhook through Cloudflare Access (the stack \`${portainerConnectorStackName(plan)}\` runs the connector); your Portainer is not reachable from the internet otherwise.`,
      ];
}

/**
 * `opscrew/RUNBOOK.md` for an app in the user's Portainer: how it runs and deploys, where its logs
 * are, how to roll back and rotate secrets, how to remove it, and that OpsCrew does not change the
 * host and backups are the user's. Committed: never Portainer's address, a token or a value.
 */
export function renderPortainerRunbook(
  plan: DeployPlan,
  ctx: { opscrewVersion: string; github: { owner: string; repo: string } },
): RenderedFile {
  if (plan.target.provider !== "portainer") {
    throw new Error(`Expected a plan for your Portainer, got ${plan.target.provider}.`);
  }
  const target = plan.target;
  const app = portainerStackName(plan);
  const repo = `${ctx.github.owner}/${ctx.github.repo}`;
  const volumes = portainerStackVolumes(plan);
  const url =
    plan.dns.domain !== undefined
      ? `https://${plan.dns.domain}`
      : target.web.mode === "proxy"
        ? `your reverse proxy's route to port ${target.web.port} of the host`
        : "not set yet";
  const database = plan.services.postgres
    ? `PostgreSQL in the app's stack, data in the volume \`${app}_postgres_data\``
    : plan.externalServices.length > 0
      ? `External: ${plan.externalServices.join(", ")} (not managed by OpsCrew)`
      : "None";
  const dns = portainerDnsRecordNote(plan);
  const lines = [
    `# Runbook: ${plan.app.name}`,
    "",
    `Generated by OpsCrew ${ctx.opscrewVersion} from \`opscrew/plan.yaml\`. Run \`opscrew verify\` to refresh it.`,
    "",
    "## At a glance",
    "",
    "| | |",
    "|---|---|",
    `| App | ${cell(url)} |`,
    `| Health check | \`${plan.app.healthPath}\` |`,
    `| Runs on | ${cell(`Your Portainer, environment ${target.environmentId} (${target.arch}), as the stack \`${app}\``)} |`,
    `| Visitors | ${cell(webLine(plan, target))} |`,
    `| Deploys | ${cell(`every push to \`${plan.cicd.branch}\` runs \`${plan.cicd.workflowPath}\``)} |`,
    `| Image | \`ghcr.io/${repo.toLowerCase()}\` (GitHub Container Registry) |`,
    `| Database | ${cell(database)} |`,
    "",
    "## How a change reaches your Portainer",
    "",
    ...redeployLines(plan, target).map((line) => `- ${line}`),
    "- The workflow reports success only once the site answers its health check with the new version; otherwise it writes the previous image back to the `opscrew-deploy` branch, so the previous version returns.",
    "",
    "## Rolling back",
    "",
    `Re-run an earlier successful run of \`${plan.cicd.workflowPath}\` in GitHub Actions: it writes that run's image to the \`opscrew-deploy\` branch, and your Portainer deploys it.`,
    "",
    "## Logs and status",
    "",
    `In your Portainer: Stacks → \`${app}\` → a container → Logs. \`opscrew verify\` checks the site from outside, \`opscrew drift\` compares the stacks with what OpsCrew sets up, and \`opscrew secure\` checks the app and its stack.`,
    "",
    ...(dns !== undefined ? ["## DNS", "", dns, ""] : []),
    "## Secrets",
    "",
    "The app's values live only in the stack's environment in your Portainer, set through its API from the computer that ran `opscrew provision`; they are never in the repository, the pull requests or GitHub Actions.",
    "To change one, update the production values and run `opscrew provision`: its stack plan names the variables that change (never their values). After rotating the repository or registry token, run `opscrew provision --replace-token repository` or `--replace-token registry`.",
    "",
    "## What OpsCrew does not do here",
    "",
    `- ${PORTAINER_HOST_NOTE}`,
    `- ${PORTAINER_BACKUPS_NOTE}${volumes.length > 0 ? ` This app's volumes: ${volumes.map((name) => `\`${name}\``).join(", ")}.` : ""}`,
    "- OpsCrew changes nothing in your Portainer that it did not create: other stacks, volumes, registry entries and Portainer's settings stay yours.",
    "",
    "## Removing the app",
    "",
    "`opscrew destroy` removes the app's stacks, the registry entry OpsCrew added, the deploy secrets and the app's Cloudflare resources, after approvals and a typed confirmation of the app's name. The app's volumes stay unless you add `--delete-data`.",
    "",
  ];
  return { path: "opscrew/RUNBOOK.md", content: lines.join("\n"), kind: "doc" };
}
