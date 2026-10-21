import type {
  CheckResult,
  PolicyResult,
  RemoteExec,
  Scanner,
  ScanReport,
} from "@opscrew/contracts";
import { exists, plural, replaceNames, toPosixRelative, writeFileAtomic } from "@opscrew/core";
import { IMAGES, TOOLS } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import {
  type DeepPins,
  type DeepToolResult,
  defaultTcpConnect,
  evaluatePlanPolicies,
  HOST_CHECKS,
  type LocalDocker,
  localDocker,
  localDockerProblem,
  ownServerHostChecks,
  probePorts,
  probeSshPasswordAuth,
  runHostChecks,
  runLynis,
  runScan,
  runSshAudit,
  runTestssl,
  serviceHostChecks,
  skippedTool,
  type TcpConnect,
} from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import { findSavedPlan } from "../provision/plan-apply";
import type { PortainerServices } from "../provision/types";
import { hidesServerAddress, SshRemoteExec, serverAddress, withoutServerAddress } from "../shared";
import { runPhase } from "../shared/phase-status";
import { verifyHosts } from "../verify/checks";
import { type OwnSecureTarget, ownSecureTarget } from "./own";
import {
  PORTAINER_PROBES_SKIPPED,
  PORTAINER_SECURE_NOTES,
  portainerSecurityChecks,
} from "./portainer";
import { probeExpectedPorts, probeOwnServerPorts } from "./probes";
import {
  renderSecurityReport,
  renderSecuritySummary,
  type SecurityProblem,
  type SecurityReportInput,
  securityProblems,
  UNKNOWN_SERVER_ADDRESS,
} from "./report";
import { serviceCheckInputs, servicePorts } from "./services";

/** Options for {@link runSecure}; every side effect has a default built from `deps`. */
export interface RunSecureOptions {
  /** The engine's plan JSON (`PlanSummary.planJson`) to evaluate the plan policies against. */
  planJson?: unknown;
  /** Runs commands on the server (default: `SshRemoteExec` with the project's deploy key). */
  remote?: RemoteExec;
  /** TCP probe for the outside port checks (default `node:net`). */
  tcpConnect?: TcpConnect;
  /** Scanners for the repository scan (default: the `opscrew scan` set). */
  scanners?: readonly Scanner[];
  /** Keep the scan offline (no OSV lookups). Default false. */
  offline?: boolean;
  /** Probe timeout in milliseconds (default 3000). */
  probeTimeoutMs?: number;
  /** Whether this computer can reach IPv6 addresses (default: it has a global IPv6 address). */
  ipv6Route?: () => Promise<boolean>;
  /** The user's Portainer: its client (default: the pinned `portainerClient`; a fake in tests). */
  portainer?: Pick<PortainerServices, "client">;
  /** Also run the deeper checks, Lynis, ssh-audit and testssl.sh (`--deep`). Default false. */
  deep?: boolean;
  /** Docker on this computer, for ssh-audit and testssl.sh (default: `docker` through `deps.runner`). */
  docker?: LocalDocker;
}

/** Outcome of {@link runSecure}. */
export interface SecureResult {
  scan: ScanReport;
  /** Undefined when no plan JSON was given. */
  policies?: PolicyResult[];
  hostChecks: CheckResult[];
  probes: CheckResult[];
  /** The deeper checks, one per tool; undefined without `deep`. */
  deep?: DeepToolResult[];
  /** Every failure and warning, most severe first. */
  problems: SecurityProblem[];
  /** True when nothing failed (warnings allowed). */
  passed: boolean;
  /** Repo-relative path of `SECURITY_REPORT.md`. */
  reportPath: string;
  /** The report text that was written. */
  report: string;
  /** Short terminal summary (also sent to the reporter). */
  summary: string;
}

/**
 * The report input without the server's address: no `host`, and check targets that name one of
 * `names` (its addresses or host name) are left out (the checks still say what they found).
 */
function privateReportInput(
  input: SecurityReportInput,
  names: readonly (string | undefined)[],
): SecurityReportInput {
  const { host: _host, ...rest } = input;
  const named = new Set(names.filter((name) => name !== undefined));
  const strip = (checks: readonly CheckResult[]) =>
    checks.map(({ target, ...check }) =>
      target === undefined || named.has(target) ? check : { ...check, target },
    );
  return { ...rest, hostChecks: strip(input.hostChecks), probes: strip(input.probes) };
}

/**
 * The server's hardening checks, run as `deploy` over SSH (pinned host key), and the outside
 * probes. On a server the user owns (`own`) they run on the recorded login's address and port with
 * what OpsCrew set up there (sshd's real ports, root's key-only login, a password choice), and the
 * probes expect SSH and, in public mode, the web ports, in tunnel mode no web port at all. On a
 * server OpsCrew created they run on `host` with the provider firewall's expectations.
 */
async function checkServer(
  deps: PhaseDeps,
  plan: DeployPlan,
  host: string,
  own: OwnSecureTarget | undefined,
  options: RunSecureOptions,
): Promise<{
  hostChecks: CheckResult[];
  probes: CheckResult[];
  skipped?: string;
  remote?: RemoteExec;
}> {
  const { paths, reporter } = deps;
  const remote =
    options.remote ??
    ((await exists(paths.files.deployKey))
      ? new SshRemoteExec({
          host,
          ...(own !== undefined ? { port: own.sshPort } : {}),
          keyFile: paths.files.deployKey,
          knownHostsFile: paths.files.knownHosts,
          runner: deps.runner,
        })
      : undefined);
  let hostChecks: CheckResult[] = [];
  let skipped: string | undefined;
  // The app's services: no published port, and their login set (FR-1328).
  const services = serviceHostChecks(plan.app.name, serviceCheckInputs(plan));
  if (remote === undefined) {
    skipped = `the deploy key is not on this machine (it is created by \`opscrew provision\`). Run the checks from the machine that ${own !== undefined ? "prepared your server" : "provisioned the server"}.`;
  } else if (own !== undefined) {
    reporter.step("Checking your server's hardening over SSH");
    hostChecks = await runHostChecks(remote, [...ownServerHostChecks(own.hardening), ...services]);
  } else {
    reporter.step(`Checking the server's hardening over SSH (${host})`);
    hostChecks = await runHostChecks(remote, [...HOST_CHECKS, ...services]);
  }
  reporter.step(
    own === undefined
      ? `Probing ${host} from outside`
      : own.access === "tunnel"
        ? "Probing your server from this machine (the app is served through the Cloudflare Tunnel, so no web port should answer)"
        : "Probing your server from outside",
  );
  const connect = options.tcpConnect ?? defaultTcpConnect;
  const timeoutMs = options.probeTimeoutMs ?? 3000;
  const probeHost = own?.probeHost ?? host;
  const probes = [
    ...(own === undefined
      ? await probeExpectedPorts(host, plan, { connect, timeoutMs })
      : await probeOwnServerPorts(probeHost, plan, {
          connect,
          timeoutMs,
          sshPort: own.sshPort,
          ...(own.probeIpv6 !== undefined ? { ipv6: own.probeIpv6 } : {}),
          ...(options.ipv6Route !== undefined ? { ipv6Route: options.ipv6Route } : {}),
        })),
    ...(await probePorts(probeHost, {
      services: servicePorts(plan),
      connect,
      timeoutMs,
      providerName: own !== undefined ? "ufw" : providerProfile(planProvider(plan)).displayName,
    })),
    await probeSshPasswordAuth(host, {
      runner: deps.runner,
      knownHostsFile: paths.files.knownHosts,
      ...(own !== undefined
        ? { port: own.sshPort, passwordsKept: own.hardening.passwordsKept }
        : {}),
    }),
  ];
  return {
    hostChecks,
    probes,
    ...(skipped !== undefined ? { skipped } : {}),
    ...(remote !== undefined ? { remote } : {}),
  };
}

/** The pins the deeper checks run from: Lynis's container is the pinned Alpine curl image. */
const DEEP_PINS: DeepPins = {
  lynisImage: IMAGES.curl.ref,
  lynis: TOOLS.lynis,
  sshAudit: IMAGES.sshAudit.ref,
  testssl: IMAGES.testssl.ref,
};

/** True when visitors reach the app at Cloudflare's edge: proxied DNS or a Cloudflare Tunnel. */
function behindCloudflare(plan: DeployPlan): boolean {
  const { dns, target } = plan;
  return (
    (dns.provider === "cloudflare" && dns.proxied) ||
    (target.provider === "own" && target.access === "tunnel") ||
    (target.provider === "portainer" && target.web.mode === "tunnel")
  );
}

/** How the deeper checks reach the server; undefined in the user's Portainer (no SSH). */
interface DeepServer {
  /** The SSH session as `deploy`; undefined when the server checks were skipped. */
  remote?: RemoteExec;
  /** Why the server checks were skipped. */
  skipped?: string;
  sshHost?: string;
  sshPort: number;
}

const PORTAINER_DEEP_SKIPPED =
  "OpsCrew reaches your Portainer only through its API, never over SSH, so the server audit and the SSH audit do not run there. The TLS audit still runs.";
const PORTAINER_DEEP_HINT =
  "Run Lynis and ssh-audit on the Portainer host yourself if you manage it.";

/**
 * The deeper checks (FR-1420–FR-1424), after today's checks: Lynis on the server over SSH,
 * ssh-audit and testssl.sh (per public hostname, labelled Cloudflare's edge when proxied) from this
 * computer's Docker. A tool that cannot run gives one `skip` with how to enable it, and the others
 * still run. In the user's Portainer only testssl.sh runs.
 */
async function deepChecks(
  deps: PhaseDeps,
  plan: DeployPlan,
  server: DeepServer | undefined,
  docker: LocalDocker,
): Promise<DeepToolResult[]> {
  const { reporter } = deps;
  const unreachable = (tool: "lynis" | "ssh-audit") =>
    server === undefined
      ? skippedTool(tool, DEEP_PINS, PORTAINER_DEEP_SKIPPED, PORTAINER_DEEP_HINT)
      : skippedTool(
          tool,
          DEEP_PINS,
          `The server could not be reached: ${server.skipped ?? UNKNOWN_SERVER_ADDRESS}`,
          "Run `opscrew secure --deep` on the computer that provisioned the server.",
        );

  let lynis: DeepToolResult;
  if (server?.remote === undefined) {
    lynis = unreachable("lynis");
  } else {
    reporter.step("Auditing the server with Lynis, read-only (up to 4 minutes)");
    lynis = await runLynis(server.remote, DEEP_PINS, deps.fetch);
  }

  const noDocker = await localDockerProblem(docker);
  let sshAudit: DeepToolResult;
  if (server?.sshHost === undefined) {
    sshAudit = unreachable("ssh-audit");
  } else if (noDocker !== undefined) {
    sshAudit = skippedTool("ssh-audit", DEEP_PINS, noDocker.message, noDocker.remediation);
  } else {
    reporter.step("Auditing the server's SSH with ssh-audit");
    sshAudit = await runSshAudit(docker, server.sshHost, server.sshPort, DEEP_PINS);
  }

  const hostnames = verifyHosts(plan);
  let testssl: DeepToolResult;
  if (hostnames.length === 0) {
    testssl = skippedTool(
      "testssl",
      DEEP_PINS,
      "The app has no domain, so there is no TLS to audit: testssl.sh tests hostnames only.",
      "Give the app a domain, provision it, then run `opscrew secure --deep` again.",
    );
  } else if (noDocker !== undefined) {
    testssl = skippedTool("testssl", DEEP_PINS, noDocker.message, noDocker.remediation);
  } else {
    // One result for all hostnames, with the version testssl.sh reported where it could scan.
    const edge = behindCloudflare(plan);
    const runs: DeepToolResult[] = [];
    for (const hostname of hostnames) {
      reporter.step(
        `Auditing the TLS of ${hostname} with testssl.sh${edge ? " (at Cloudflare's edge)" : ""}`,
      );
      runs.push(await runTestssl(docker, hostname, DEEP_PINS, { edge }));
    }
    const scanned = (run: DeepToolResult) => run.results.some((r) => r.status !== "skip");
    testssl = {
      tool: "testssl",
      version: (runs.find(scanned) ?? (runs[0] as DeepToolResult)).version,
      results: runs.flatMap((run) => run.results),
    };
  }
  return [lynis, sshAudit, testssl];
}

/**
 * The secure phase: re-runs the repository scan, evaluates the plan policies (when an engine plan
 * is given), runs the hardening checks on the server over SSH as `deploy`, probes from outside that
 * only the expected ports answer and that SSH refuses passwords, with `deep` also runs the deeper
 * checks (see `deepChecks`), then writes
 * `opscrew/SECURITY_REPORT.md` and prints a summary. Marks `secure` (`failed` when anything fails).
 */
export async function runSecure(
  deps: PhaseDeps,
  options: RunSecureOptions = {},
): Promise<SecureResult> {
  return runPhase(deps, "secure", () => secure(deps, options));
}

async function secure(deps: PhaseDeps, options: RunSecureOptions): Promise<SecureResult> {
  const { paths, reporter } = deps;
  const say = (text: string) => deps.redactor.redact(text);
  const plan = await readArtifact("plan", paths.files.plan);
  // A server the user owns is reached by its recorded login instead (see `ownSecureTarget`); the
  // user's Portainer through its API (see `portainerSecurityChecks`), never its host.
  const portainer = plan.target.provider === "portainer";
  const address =
    plan.target.provider === "own" || portainer ? undefined : await serverAddress(deps, plan);
  const host = address?.ipv4;

  reporter.step("Scanning the repository");
  const scan = await runScan(paths.root, {
    offline: options.offline ?? false,
    fetch: deps.fetch,
    runner: deps.runner,
    version: deps.version,
    now: () => deps.clock.now(),
    ...(options.scanners !== undefined ? { scanners: options.scanners } : {}),
  });

  // Without an explicit plan JSON, re-check the plan that was last applied (saved by provision).
  const planJson =
    options.planJson ??
    (plan.deployment.lastPlanHash === undefined
      ? undefined
      : (await findSavedPlan(paths.files.plansDir, plan.deployment.lastPlanHash))?.planJson);
  const policies = planJson === undefined ? undefined : evaluatePlanPolicies(planJson, plan);

  let hostChecks: CheckResult[] = [];
  let probes: CheckResult[] = [];
  let hostChecksSkipped: string | undefined;
  let remote: RemoteExec | undefined;
  const own = plan.target.provider === "own" ? await ownSecureTarget(deps, plan) : undefined;
  const sshHost = own?.sshHost ?? host;
  if (portainer) {
    const checked = await portainerSecurityChecks(deps, plan, options.portainer);
    hostChecks = checked.checks;
    hostChecksSkipped = checked.skipped;
  } else if (sshHost === undefined) {
    hostChecksSkipped =
      plan.target.provider === "own"
        ? "OpsCrew does not know how to reach your server on this computer. Run `opscrew secure` on the computer that ran `opscrew provision` (its `.opscrew/` folder holds the login and the confirmed host key)."
        : UNKNOWN_SERVER_ADDRESS;
  } else {
    const checked = await checkServer(deps, plan, sshHost, own, options);
    hostChecks = checked.hostChecks;
    probes = checked.probes;
    hostChecksSkipped = checked.skipped;
    remote = checked.remote;
  }

  const deep = options.deep
    ? await deepChecks(
        deps,
        plan,
        portainer
          ? undefined
          : {
              ...(remote !== undefined ? { remote } : {}),
              ...(hostChecksSkipped !== undefined ? { skipped: hostChecksSkipped } : {}),
              ...(sshHost !== undefined ? { sshHost } : {}),
              sshPort: own?.sshPort ?? 22,
            },
        options.docker ?? localDocker(deps.runner),
      )
    : undefined;

  const shownHost = plan.target.provider === "own" ? own?.probeHost : host;
  const input: SecurityReportInput = {
    appName: plan.app.name,
    version: deps.version,
    generatedAt: deps.clock.now().toISOString(),
    scan,
    hostChecks,
    probes,
    ...(shownHost !== undefined ? { host: shownHost } : {}),
    ...(policies !== undefined ? { policies } : {}),
    ...(hostChecksSkipped !== undefined ? { hostChecksSkipped } : {}),
    ...(deep !== undefined ? { deep } : {}),
    ...(portainer
      ? { portainer: { notes: PORTAINER_SECURE_NOTES, probesSkipped: PORTAINER_PROBES_SKIPPED } }
      : {}),
  };
  // A server the user owns: the report and the terminal say "your server", never its address or
  // host name.
  const hidden = own?.hidden ?? [];
  const hide = (text: string) => replaceNames(text, hidden, "your server");
  // The report is committed: behind Cloudflare's proxy it never names the server's address, and
  // for a server the user owns it never names its address or host name at all (FR-902).
  const report = say(
    plan.target.provider === "own"
      ? hide(renderSecurityReport(privateReportInput(input, hidden)))
      : hidesServerAddress(plan)
        ? withoutServerAddress(
            renderSecurityReport(privateReportInput(input, [address?.ipv4, address?.ipv6])),
            [address],
          )
        : renderSecurityReport(input),
  );
  await writeFileAtomic(paths.files.securityReport, report);
  const reportPath = toPosixRelative(paths.root, paths.files.securityReport);

  const problems = securityProblems(input);
  const passed = problems.every((problem) => problem.status !== "fail");
  const summary = say(
    plan.target.provider === "own"
      ? hide(renderSecuritySummary(privateReportInput(input, hidden), { reportPath }))
      : renderSecuritySummary(input, { reportPath }),
  );
  const [headline = "", ...details] = summary.trimEnd().split("\n");
  if (passed) reporter.success(headline);
  else reporter.error(headline);
  for (const line of details) reporter.info(line);
  if (portainer) reporter.info(PORTAINER_SECURE_NOTES.join(" "));
  if (hostChecksSkipped !== undefined)
    reporter.warn(
      say(
        hide(`${portainer ? "Portainer checks" : "Server checks"} skipped: ${hostChecksSkipped}`),
      ),
    );

  const failures = problems.filter((problem) => problem.status === "fail").length;
  await deps.state.markPhase(
    "secure",
    passed ? "ok" : "failed",
    passed
      ? `no failures, ${plural(problems.length, "warning")}`
      : `${plural(failures, "problem")} to fix`,
  );
  return {
    scan,
    ...(policies !== undefined ? { policies } : {}),
    hostChecks,
    probes,
    ...(deep !== undefined ? { deep } : {}),
    problems,
    passed,
    reportPath,
    report,
    summary,
  };
}
