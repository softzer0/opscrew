/**
 * `secure` across an app's servers (feature 018, US2, US5, FR-1811, FR-1817): each extra server
 * checked as the app's is, each service published on a private address held to that address and
 * the network's filter, and the grants and public SSH's state listed. Every result about a server
 * names it, and never its address (the report is committed). Read-only.
 */

import { probePrivilege } from "@opscrew/connector-ssh-host";
import type { CheckResult, RemoteExec } from "@opscrew/contracts";
import { errorText, isUserFacingError, listText } from "@opscrew/core";
import { IMAGES, publishedOnNetwork } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, networkInterface } from "@opscrew/plan-schema";
import {
  HOST_CHECKS,
  ownServerHostChecks,
  probePorts,
  probeSshPasswordAuth,
  runHostChecks,
  type TcpConnect,
} from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { networkSteps } from "../network";
import { providerProfile } from "../providers";
import { checkResult } from "../shared";
import { type ServerLogin, serverLogin } from "../shared/server-address";
import { serviceWords } from "../status/network";
import { extraServers, readPublishedPorts, serverShell } from "../status/servers";
import { serverServiceChecks, servicePorts } from "./services";

/**
 * Reads the rules of the network's filter (`OPSCREW-<if>`) on a server as root the way
 * `privilege` says, each port with its admitted sources; undefined when the chain is missing.
 */
export type NetworkFilterReader = (
  remote: RemoteExec,
  iface: string,
  privilege: "root" | "sudo" | "docker",
  rootImage?: string,
) => Promise<{ port: number; sources: string[] }[] | undefined>;

/** What the checks of {@link serverSecurityChecks} take: fakes in tests. */
export interface ServerSecurityOptions {
  /** The shell on a server by its address (default `serverRemote`). */
  serverRemote?: (host: string) => RemoteExec;
  /**
   * False when the app's server's checks were skipped (the deploy key is not on this computer):
   * the extra servers' host checks are skipped too, and only the outside probes run.
   */
  hostChecks: boolean;
  /** The app's server's shell, when the app's checks reached it. */
  appRemote?: RemoteExec;
  /** Reads the network's filter (ssh-host's `readNetworkFilter`, or a fake in tests). */
  readNetworkFilter: NetworkFilterReader;
  connect: TcpConnect;
  timeoutMs: number;
}

/** `check` about the extra server `server`: its id, title and message name it, its target too. */
function onExtraServer(check: CheckResult, server: string): CheckResult {
  return {
    ...check,
    id: `server-${server}-${check.id}`,
    title: `Server ${server}: ${check.title}`,
    message: `On server ${server}: ${check.message}`,
    target: `server ${server}`,
  };
}

/**
 * The hardening checks and outside probes of each extra server, as the app's server gets them: its
 * host checks over its shell (as `deploy` on a server OpsCrew created, through the recorded admin
 * login on the user's own), then, from this computer, that no web port and no sensitive or service
 * port answers (an extra server serves no web traffic), and that SSH refuses passwords. `hosts` are
 * the addresses the checks reached, which the committed report must not contain.
 */
export async function extraServerChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ServerSecurityOptions,
): Promise<{
  hostChecks: CheckResult[];
  probes: CheckResult[];
  hosts: { server: string; host: string }[];
}> {
  const hostChecks: CheckResult[] = [];
  const probes: CheckResult[] = [];
  const hosts: { server: string; host: string }[] = [];
  const services = options.serverRemote === undefined ? {} : { remote: options.serverRemote };
  for (const server of extraServers(plan)) {
    let login: ServerLogin;
    try {
      login = await serverLogin(deps, plan, server);
      if (options.hostChecks) {
        const shell = await serverShell(deps, plan, server, services);
        deps.reporter.step(`Checking server ${server}'s hardening over SSH`);
        // An extra own server's SSH ports and password choice come from its own setup plan once
        // provision (T1810) keeps one per server; until then its login's port, and no passwords.
        const checks = login.own
          ? ownServerHostChecks({
              sshPorts: [login.port],
              rootLogin: login.user === "root",
              passwordsKept: false,
            })
          : HOST_CHECKS;
        const results = await runHostChecks(shell.docker, [
          ...checks,
          ...serverServiceChecks(plan, server),
        ]);
        hostChecks.push(...results.map((check) => onExtraServer(check, server)));
      }
    } catch (error) {
      if (!isUserFacingError(error)) throw error;
      hostChecks.push(
        checkResult(
          `server-${server}-reachable`,
          `Server ${server} can be checked`,
          "high",
          "fail",
          `OpsCrew could not reach server ${server}. ${errorText(error)}`,
          { target: `server ${server}` },
        ),
      );
      continue;
    }
    hosts.push({ server, host: login.host });
    deps.reporter.step(`Probing server ${server} from outside`);
    const target = plan.servers?.find((s) => s.name === server)?.target;
    const providerName =
      target === undefined || target.provider === "own"
        ? "ufw"
        : providerProfile(target.provider).displayName;
    const outside = [
      ...(await probePorts(login.host, {
        // The sensitive ports, the server's services' and the web's: none may answer.
        services: { ...servicePorts(plan, server), 80: "HTTP", 443: "HTTPS" },
        connect: options.connect,
        timeoutMs: options.timeoutMs,
        providerName,
      })),
      await probeSshPasswordAuth(login.host, {
        runner: deps.runner,
        knownHostsFile: deps.paths.files.knownHosts,
        port: login.port,
      }),
    ];
    probes.push(...outside.map((check) => onExtraServer(check, server)));
  }
  return { hostChecks, probes, hosts };
}

/**
 * For each service published on a server's private address (`publishedOnNetwork`), that it answers
 * only there (FR-1805): its container's every published address is that address, and the
 * network's filter admits on its port exactly the app's server and the devices granted it
 * (`networkSteps`' sources). A finding for each that does not.
 */
export async function privateAddressChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: ServerSecurityOptions,
): Promise<CheckResult[]> {
  const network = plan.network;
  if (network === undefined) return [];
  const services = options.serverRemote === undefined ? {} : { remote: options.serverRemote };
  /** A private address with the member it is: `server app (10.200.4.1)`, `device laptop (…)`. */
  const memberName = (address: string) => {
    const server = network.members.find((m) => m.address === address);
    if (server !== undefined) return `server ${server.name} (${address})`;
    const device = network.devices.find((d) => d.address === address);
    return device === undefined ? address : `device ${device.name} (${address})`;
  };
  const checks: CheckResult[] = [];
  for (const member of network.members) {
    const server = member.name;
    const expected = publishedOnNetwork(plan, server);
    if (expected.length === 0) continue;
    const results = await (async (): Promise<CheckResult[]> => {
      const shell =
        options.appRemote !== undefined && server === APP_SERVER
          ? { remote: options.appRemote, docker: options.appRemote }
          : await serverShell(deps, plan, server, services);
      const { remote } = shell;
      const published = await readPublishedPorts(shell.docker, plan.app.name);
      // The sources the filter should admit per port: the app's server, and the granted devices.
      const wanted = networkSteps(plan, server, {
        endpoints: {},
        wireguardInterfaces: [],
        published: expected,
        sshPort: 22,
      }).filter.rules;
      const privilege = await probePrivilege(remote);
      const root = privilege === "root" || privilege === "sudo" || privilege === "docker";
      const rules = root
        ? await options.readNetworkFilter(
            remote,
            networkInterface(member),
            privilege,
            IMAGES.caddy.ref,
          )
        : undefined;
      return expected.map((entry) => {
        const what = `${serviceWords(plan, entry.service)} on server ${server}`;
        const where = `${entry.address}:${entry.port}`;
        const bindings = published.filter((p) => p.service === entry.service);
        const elsewhere = bindings.filter((p) => p.address !== entry.address);
        const check = (status: CheckResult["status"], message: string, remediation?: string) =>
          checkResult(
            `service-${entry.service}-private`,
            `${what} answers only on the private network`,
            "critical",
            status,
            message,
            {
              target: `server ${server}`,
              ...(remediation !== undefined ? { remediation } : {}),
            },
          );
        const provision = `Run \`opscrew provision\`: it shows the host plans for server ${server} and the files that publish ${entry.service} only on ${where}.`;
        if (elsewhere.length > 0) {
          const list = listText(elsewhere.map((p) => `${p.address}:${p.port}`));
          return check(
            "fail",
            `${what} is published on ${list}, so it can be reached outside the private network.`,
            provision,
          );
        }
        if (bindings.length === 0) {
          return check(
            "warn",
            `${what} is not published on its private address ${where}, so ${server === APP_SERVER ? "the devices granted it" : "the app"} can't reach it.`,
            provision,
          );
        }
        if (!root) {
          return check(
            "warn",
            `${what} is published only on ${where}, but OpsCrew can't read the network's filter on server ${server} without root, so it was not checked.`,
            `Give the login OpsCrew uses on server ${server} passwordless sudo, then run \`opscrew secure\` again.`,
          );
        }
        const filterFix = `Run \`opscrew provision\`: it shows the network-filter host plan for server ${server}.`;
        const rule = rules?.find((r) => r.port === entry.port);
        if (rule === undefined) {
          return check(
            "fail",
            `${what} is published only on ${where}, but the network's filter has no rule for port ${entry.port}, so any address that reaches the private network can connect to it.`,
            filterFix,
          );
        }
        const sources = wanted.find((r) => r.port === entry.port)?.sources ?? [];
        const others = rule.sources.filter((source) => !sources.includes(source));
        if (others.length > 0) {
          return check(
            "fail",
            `${what} is published only on ${where}, but the network's filter also admits ${listText(others.map(memberName))} on port ${entry.port}.`,
            filterFix,
          );
        }
        const missing = sources.filter((source) => !rule.sources.includes(source));
        if (missing.length > 0) {
          return check(
            "warn",
            `${what} is published only on ${where}, but the network's filter does not admit ${listText(missing.map(memberName))}, so ${missing.length === 1 ? "it" : "they"} can't reach it.`,
            filterFix,
          );
        }
        return check(
          "pass",
          `${what} is published only on ${where}, and the network's filter admits only ${listText(sources.map(memberName))}.`,
        );
      });
    })().catch((error: unknown) => {
      if (!isUserFacingError(error)) throw error;
      return [
        checkResult(
          `server-${server}-private-ports`,
          `The services on server ${server} answer only on the private network`,
          "high",
          "warn",
          `OpsCrew could not read the ports server ${server} publishes. ${errorText(error)}`,
          { target: `server ${server}` },
        ),
      ];
    });
    checks.push(...results);
  }
  return checks;
}

/**
 * The private network's grants and public SSH's state (FR-1817, US4), listed as information: each
 * grant by device, service and access, and whether SSH answers on every server's public address.
 */
export function networkListing(plan: DeployPlan): CheckResult[] {
  const network = plan.network;
  if (network === undefined) return [];
  const grants = network.grants.map(
    (grant) => `device ${grant.device} to ${serviceWords(plan, grant.service)}, ${grant.access}`,
  );
  return [
    checkResult(
      "network-grants",
      "Device access to the app's databases and caches",
      "info",
      "pass",
      grants.length === 0
        ? "No device has access to a database or cache."
        : `${grants.join("; ")}.`,
    ),
    checkResult(
      "public-ssh",
      "Public SSH",
      "info",
      "pass",
      network.publicSsh
        ? "SSH is open on every server's public address, as `security.sshAllowedCidrs` allows."
        : "SSH is closed on every server's public address and answers only on the private network.",
    ),
  ];
}
