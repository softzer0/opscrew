import type {
  CheckResult,
  PolicyResult,
  RemoteExec,
  Scanner,
  ScanReport,
} from "@opscrew/contracts";
import {
  isUserFacingError,
  plural,
  replaceNames,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import {
  defaultTcpConnect,
  evaluatePlanPolicies,
  ownServerHostChecks,
  probePorts,
  probeSshPasswordAuth,
  runHostChecks,
  runScan,
  type TcpConnect,
} from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import { findSavedPlan } from "../provision/plan-apply";
import type { PortainerServices } from "../provision/types";
import {
  exists,
  hidesServerAddress,
  SshRemoteExec,
  serverAddress,
  withoutServerAddress,
} from "../shared";
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
} from "./report";

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
}

/** Outcome of {@link runSecure}. */
export interface SecureResult {
  scan: ScanReport;
  /** Undefined when no plan JSON was given. */
  policies?: PolicyResult[];
  hostChecks: CheckResult[];
  probes: CheckResult[];
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
): Promise<{ hostChecks: CheckResult[]; probes: CheckResult[]; skipped?: string }> {
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
  if (remote === undefined) {
    skipped = `the deploy key is not on this machine (it is created by \`opscrew provision\`). Run the checks from the machine that ${own !== undefined ? "prepared your server" : "provisioned the server"}.`;
  } else if (own !== undefined) {
    reporter.step("Checking your server's hardening over SSH");
    hostChecks = await runHostChecks(remote, ownServerHostChecks(own.hardening));
  } else {
    reporter.step(`Checking the server's hardening over SSH (${host})`);
    hostChecks = await runHostChecks(remote);
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
  return { hostChecks, probes, ...(skipped !== undefined ? { skipped } : {}) };
}

/**
 * The secure phase: re-runs the repository scan, evaluates the plan policies (when an engine plan
 * is given), runs the hardening checks on the server over SSH as `deploy`, probes from outside that
 * only the expected ports answer and that SSH refuses passwords, then writes
 * `opscrew/SECURITY_REPORT.md` and prints a summary. Marks `secure` (`failed` when anything fails).
 */
export async function runSecure(
  deps: PhaseDeps,
  options: RunSecureOptions = {},
): Promise<SecureResult> {
  try {
    return await secure(deps, options);
  } catch (error) {
    await deps.state.markPhase(
      "secure",
      "failed",
      isUserFacingError(error) ? deps.redactor.redact(error.message) : undefined,
    );
    throw error;
  }
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
        : "OpsCrew does not know the server's address on this computer. If the app is deployed, run `opscrew secure` on the computer that provisioned the server (its `.opscrew/` folder holds the address); otherwise deploy it first.";
  } else {
    const checked = await checkServer(deps, plan, sshHost, own, options);
    hostChecks = checked.hostChecks;
    probes = checked.probes;
    hostChecksSkipped = checked.skipped;
  }

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
    ...(portainer
      ? { portainer: { notes: PORTAINER_SECURE_NOTES, probesSkipped: PORTAINER_PROBES_SKIPPED } }
      : {}),
  };
  // The report is committed: behind Cloudflare's proxy it never names the server's address, and
  // for a server the user owns it never names its address or host name at all (FR-902).
  const report = say(
    plan.target.provider === "own"
      ? replaceNames(
          renderSecurityReport(privateReportInput(input, own?.hidden ?? [])),
          own?.hidden ?? [],
          "your server",
        )
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
  // A server the user owns: the terminal says "your server", never its address or host name.
  const hidden = own?.hidden ?? [];
  const summary = say(
    plan.target.provider === "own"
      ? replaceNames(
          renderSecuritySummary(privateReportInput(input, hidden), { reportPath }),
          hidden,
          "your server",
        )
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
        replaceNames(
          `${portainer ? "Portainer checks" : "Server checks"} skipped: ${hostChecksSkipped}`,
          hidden,
          "your server",
        ),
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
    problems,
    passed,
    reportPath,
    report,
    summary,
  };
}
