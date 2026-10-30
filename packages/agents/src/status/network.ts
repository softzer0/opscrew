/**
 * `status`'s private network section (feature 018, US2, FR-1811, FR-1817): each link between the
 * servers with its state, last handshake and measured round trip, the devices with their last
 * handshake, the grants, whether public SSH is open, and each port that should be published on a
 * private address and is not.
 */
import { plural } from "@opscrew/core";
import { serviceSpec } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { NetworkLink } from "../network";

/** A service a server should publish on its private address and does not. */
export interface UnpublishedPort {
  server: string;
  service: string;
  port: number;
  address: string;
}

/** `5 seconds ago`, `3 minutes ago`, `2 hours ago` or `4 days ago`. */
function ageText(seconds: number): string {
  if (seconds < 60) return `${plural(seconds, "second")} ago`;
  if (seconds < 3600) return `${plural(Math.floor(seconds / 60), "minute")} ago`;
  if (seconds < 2 * 86_400) return `${plural(Math.floor(seconds / 3600), "hour")} ago`;
  return `${plural(Math.floor(seconds / 86_400), "day")} ago`;
}

/** Why a link of `from` was not read, in words. */
export function notReadText(link: NetworkLink): string {
  return link.reason === "no-root"
    ? `OpsCrew can't read the private network on server ${link.from} without root (give its login passwordless sudo)`
    : `OpsCrew could not reach server ${link.from} over SSH`;
}

/** A link's last handshake and round trip in words: `last handshake 5 seconds ago, …`. */
export function handshakeText(link: NetworkLink): string {
  return [
    link.handshakeAgeSeconds === undefined
      ? "no handshake yet"
      : `last handshake ${ageText(link.handshakeAgeSeconds)}`,
    ...(link.roundTripMs === undefined ? [] : [`round trip ${link.roundTripMs} ms`]),
  ].join(", ");
}

/** A link's state: up or down with {@link handshakeText}, or why it was not read. */
function linkText(link: NetworkLink): string {
  if (link.reason !== undefined) return `not read: ${notReadText(link)}`;
  return `${link.up ? "up" : "down"}, ${handshakeText(link)}`;
}

/** A service's words: `PostgreSQL (db)`. */
export function serviceWords(plan: DeployPlan, name: string): string {
  const service = plan.services.find((s) => s.name === name);
  return service === undefined ? name : `${serviceSpec(service.kind).title} (${name})`;
}

/**
 * The lines of the private network's section; none without a network. `flag` is the command's
 * ` --env <name>` for the fix.
 */
export function networkStatusLines(
  plan: DeployPlan,
  links: readonly NetworkLink[],
  unpublished: readonly UnpublishedPort[],
  flag = "",
): string[] {
  const network = plan.network;
  if (network === undefined) return [];
  const devices = new Set(network.devices.map((device) => device.name));
  const lines = [`Private network (${network.range}):`];
  for (const link of links.filter((l) => !devices.has(l.to))) {
    lines.push(`  ${link.from} to ${link.to}: ${linkText(link)}`);
  }
  for (const device of network.devices) {
    const seen = links
      .filter((link) => link.to === device.name)
      .map(
        (link) =>
          `with server ${link.from} ${
            link.reason !== undefined
              ? "not read"
              : link.handshakeAgeSeconds === undefined
                ? "never"
                : ageText(link.handshakeAgeSeconds)
          }`,
      );
    lines.push(
      `  Device ${device.name} (${device.address}): ${seen.length === 0 ? "no server with a public address to connect to" : `last handshake ${seen.join(", ")}`}`,
    );
  }
  if (network.devices.length === 0) lines.push("  Devices: none");
  for (const grant of network.grants) {
    lines.push(
      `  Access: device ${grant.device} to ${serviceWords(plan, grant.service)}, ${grant.access}`,
    );
  }
  if (network.grants.length === 0) lines.push("  Access to databases and caches: none");
  lines.push(
    network.publicSsh
      ? "  Public SSH: open on every server"
      : "  Public SSH: closed on every server (SSH answers only on the private network)",
  );
  for (const port of unpublished) {
    const who = port.server === APP_SERVER ? "the devices granted it" : "the app";
    lines.push(
      `  Warning: ${serviceWords(plan, port.service)} on server ${port.server} is not published on its private address ${port.address}:${port.port}, so ${who} can't reach it. Run \`opscrew provision${flag}\` to fix it.`,
    );
  }
  return lines;
}
