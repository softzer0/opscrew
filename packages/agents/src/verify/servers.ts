/**
 * `verify`'s checks of an app's servers and private network (feature 018, US2, FR-1811): every
 * server answers over SSH, every link between the servers is up, and every port that should be
 * published on a private address is. Each failure names the server and the next step. Read-only.
 */
import type { CheckResult, RemoteExec } from "@opscrew/contracts";
import { errorText, isUserFacingError } from "@opscrew/core";
import { publishedOnNetwork } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { ReadNetworkServices } from "../network";
import { checkResult } from "../shared";
import { handshakeText, notReadText, serviceWords } from "../status/network";
import { appServers, readLinks, readPublishedPorts, serverShell } from "../status/servers";

/**
 * The checks of every server of a plan with a private network; none without one. `remote` and
 * `network` replace the shells and the WireGuard read in tests; `flag` is the commands'
 * ` --env <name>`.
 */
export async function serverChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: { remote?: (host: string) => RemoteExec; network?: ReadNetworkServices; flag: string },
): Promise<CheckResult[]> {
  const network = plan.network;
  if (network === undefined) return [];
  const { flag } = options;
  const services = options.remote === undefined ? {} : { remote: options.remote };
  const checks: CheckResult[] = [];
  const unreachable = new Set<string>();
  for (const server of appServers(plan)) {
    deps.reporter.step(`Checking server ${server} over SSH (read-only)`);
    const reachable = {
      id: `server-${server}-reachable`,
      title: `Server ${server} answers over SSH`,
    };
    let published: Awaited<ReturnType<typeof readPublishedPorts>>;
    try {
      const { docker } = await serverShell(deps, plan, server, services);
      published = await readPublishedPorts(docker, plan.app.name);
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      unreachable.add(server);
      checks.push(
        checkResult(
          reachable.id,
          reachable.title,
          "high",
          "fail",
          `OpsCrew could not read server ${server} over SSH. ${errorText(error)}`,
          {
            remediation: `Check that server ${server} is on and that this computer reaches it over SSH (\`opscrew status${flag}\` reads every server), then run \`opscrew verify${flag}\` again.`,
          },
        ),
      );
      continue;
    }
    checks.push(
      checkResult(reachable.id, reachable.title, "high", "pass", `Server ${server} answers.`),
    );
    for (const expected of publishedOnNetwork(plan, server)) {
      const what = serviceWords(plan, expected.service);
      const where = `${expected.address}:${expected.port}`;
      const found = published.some(
        (p) =>
          p.service === expected.service &&
          p.address === expected.address &&
          p.port === expected.port,
      );
      checks.push(
        checkResult(
          `server-${server}-${expected.service}-published`,
          `${what} on server ${server} is published on its private address`,
          "high",
          found ? "pass" : "fail",
          found
            ? `${what} on server ${server} is published on ${where}.`
            : `${what} on server ${server} is not published on its private address ${where}, so ${server === APP_SERVER ? "the devices granted it" : "the app"} can't reach it.`,
          found
            ? {}
            : {
                remediation: `Run \`opscrew provision${flag}\` to fix it, then \`opscrew verify${flag}\` again.`,
              },
        ),
      );
    }
  }
  const devices = new Set(network.devices.map((device) => device.name));
  const links = await readLinks(deps, plan, services, options.network);
  for (const link of links) {
    if (devices.has(link.to) || unreachable.has(link.from)) continue;
    const id = `link-${link.from}-${link.to}`;
    const title = `The private link from server ${link.from} to server ${link.to} is up`;
    const port = network.members.find((m) => m.name === link.to)?.port;
    if (link.reason === "no-root") {
      checks.push(
        checkResult(id, title, "medium", "warn", `${notReadText(link)}.`, {
          remediation: `Give the login OpsCrew uses on server ${link.from} passwordless sudo, then run \`opscrew verify${flag}\` again.`,
        }),
      );
    } else if (link.reason === "unreachable") {
      checks.push(
        checkResult(
          id,
          title,
          "high",
          "fail",
          `OpsCrew could not read the private network on server ${link.from}: its WireGuard interface may be down.`,
          {
            remediation: `Run \`opscrew provision${flag}\`: it shows the network's host plan for server ${link.from} and sets the network up again.`,
          },
        ),
      );
    } else {
      checks.push(
        checkResult(
          id,
          title,
          "high",
          link.up ? "pass" : "fail",
          `The private link from server ${link.from} to server ${link.to} is ${link.up ? "up" : "down"} (${handshakeText(link)}).`,
          link.up
            ? {}
            : {
                remediation: `Check that server ${link.to} is on and that its firewall and its provider's let WireGuard's UDP port ${port} in, then run \`opscrew provision${flag}\`: it shows the network's host plans and sets them up again.`,
              },
        ),
      );
    }
  }
  return checks;
}
