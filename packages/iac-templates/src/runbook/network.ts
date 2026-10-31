import {
  APP_SERVER,
  type DeployPlan,
  networkInterface,
  type PlanService,
  servicesOn,
} from "@opscrew/plan-schema";
import { serviceSpec } from "../catalog";
import { PROVIDER_TEXT } from "../providers";
import { cell, opscrew, runbookFolders } from "./shared";

/** `PostgreSQL (db)`. */
function serviceWords(service: PlanService): string {
  return `${serviceSpec(service.kind).title} (\`${service.name}\`)`;
}

/** Where a server is: `Hetzner Cloud cx33 in hel1`, or `your own server`. */
function place(
  target: DeployPlan["target"] | NonNullable<DeployPlan["servers"]>[number]["target"],
) {
  if (target.provider === "own") return "your own server";
  if (target.provider !== "hetzner" && target.provider !== "digitalocean") {
    throw new Error(`A server of the private network can't be on ${target.provider}.`);
  }
  return PROVIDER_TEXT[target.provider].serverLabel(target.serverType, target.location);
}

/**
 * "Servers and the private network", when the plan has one (`plan.network`): each server with
 * where it is, what runs on it and its private address and port, how the services on other servers
 * are reached, the devices and their grants, public SSH, a move in progress, and the commands that
 * cover every server. Nothing without a network. Public keys only, never a secret or a public
 * address.
 */
export function networkSection(plan: DeployPlan, environments?: readonly string[]): string[] {
  const network = plan.network;
  if (network === undefined) return [];
  const run = (command: string) => `\`${opscrew(plan, command, environments)}\``;
  const servers = plan.servers ?? [];
  const member = (name: string) => network.members.find((m) => m.name === name);
  const row = (name: string, where: string, runs: string[]) => {
    const m = member(name);
    const address =
      m === undefined ? "" : `${m.address}, UDP ${m.port} (\`${networkInterface(m)}\`)`;
    return `| \`${name}\` | ${cell(where)} | ${cell(runs.join(", "))} | ${address} |`;
  };
  const appRuns = [
    "the app, its workers and cron jobs, the edge",
    ...servicesOn(plan, APP_SERVER).map(serviceWords),
  ];
  const elsewhere = servers.flatMap((server) => servicesOn(plan, server.name));
  const noLogin = elsewhere.filter((s) => serviceSpec(s.kind).auth === "internal-only");
  const lines = [
    "## Servers and the private network",
    "",
    "| Server | Where | Runs | Private address |",
    "|---|---|---|---|",
    row(APP_SERVER, place(plan.target), appRuns),
    ...servers.map((server) =>
      row(server.name, place(server.target), servicesOn(plan, server.name).map(serviceWords)),
    ),
    "",
    servers.length > 0
      ? `The servers are linked by the app's private WireGuard network (\`${network.range}\`): every packet between them is`
      : `The app's private WireGuard network (\`${network.range}\`) links your devices to the server: every packet is`,
    "encrypted and tied to the sender's key. Each server's private key stays on that server and on the machine",
    "that ran `opscrew provision`; this repository holds only public keys.",
  ];
  if (elsewhere.length > 0) {
    lines.push(
      "A service on another server listens only on that server's private address, and answers only the app's server",
      "and the devices granted access to it. The app reaches it there; its code and settings files are unchanged.",
    );
  }
  if (noLogin.length > 0) {
    lines.push(
      `${noLogin.map(serviceWords).join(", ")} ${noLogin.length === 1 ? "has" : "have"} no login: only the app's servers reach ${noLogin.length === 1 ? "it" : "them"}, and no device can be given access.`,
    );
  }
  lines.push(
    "",
    `- ${run("status")} shows each server and each link: whether it is up, its last handshake and its measured round trip.`,
    `- ${run("logs --service <name>")} reads the lines on the server that runs the service; ${run("drift")}, ${run("secure")} and`,
    `  ${run("verify")} check every server and name it.`,
    ...(servers.length > 0
      ? [
          `- ${run("destroy")} lists every server and asks for each one's typed name before it deletes a server OpsCrew created.`,
        ]
      : []),
    "",
  );

  if (plan.move !== undefined) {
    const { service, from, to, step } = plan.move;
    lines.push(
      step === "switched"
        ? `**A move:** \`${service}\` runs on \`${to}\` now. Its old copy stays, stopped, on \`${from}\` until ${run("provision --finish-move")} removes it, after you type the service's name.`
        : `**A move in progress:** \`${service}\` moves from \`${from}\` to \`${to}\`. ${run("provision")} continues it, with a maintenance window you approve first.`,
      "",
    );
  }

  lines.push("### Devices and SSH", "");
  if (network.devices.length === 0) {
    lines.push(
      `No device is on the network yet. ${run("vpn add <name> --this-computer")} adds this computer, and \`--qr\` shows a phone's`,
      "configuration as a QR code for the WireGuard app.",
    );
  } else {
    lines.push(
      ...network.devices.map((d) => `- \`${d.name}\`: ${d.address}`),
      "",
      `With its tunnel on, a device reaches SSH on each server's private address. ${run("vpn list")} shows when each device last`,
      `connected; ${run("vpn remove <name>")} takes a lost device off every server.`,
    );
  }
  lines.push("");
  if (network.grants.length > 0) {
    lines.push(
      "Database and cache access, each with its own login (never the app's):",
      "",
      ...network.grants.map((g) => `- \`${g.device}\` to \`${g.service}\`, ${g.access}`),
      "",
      `${run("vpn revoke <device> <service>")} removes a login and its rule.`,
      "",
    );
  }

  lines.push(
    network.publicSsh
      ? `Public SSH is open to the allow-list in \`${runbookFolders(plan, undefined).artefacts}/plan.yaml\`. Once deploys run on the server's own runner and this computer is a device, ${run("secure --close-public-ssh")} closes it.`
      : `**Public SSH is closed:** SSH answers only on the private network, so turn this computer's tunnel on before any command that reaches a server. ${run("secure --open-public-ssh")} opens it again to the allow-list it had.`,
    "",
  );
  return lines;
}
