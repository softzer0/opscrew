import { access } from "node:fs/promises";
import type {
  CheckResult,
  PolicyResult,
  RemoteExec,
  Scanner,
  ScanReport,
} from "@opscrew/contracts";
import { isUserFacingError, toPosixRelative, writeFileAtomic } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import {
  defaultTcpConnect,
  evaluatePlanPolicies,
  probePorts,
  probeSshPasswordAuth,
  runHostChecks,
  runScan,
  type TcpConnect,
} from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { planProvider, providerProfile } from "../providers";
import { findSavedPlan } from "../provision/plan-apply";
import {
  hidesServerAddress,
  type ServerAddress,
  SshRemoteExec,
  serverAddress,
  withoutServerAddress,
} from "../shared";
import { probeExpectedPorts } from "./probes";
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
 * The report input without the server's address: no `host`, and check targets that name the
 * address are left out (the checks still say what they found).
 */
function privateReportInput(
  input: SecurityReportInput,
  address: ServerAddress | undefined,
): SecurityReportInput {
  const { host: _host, ...rest } = input;
  const named = new Set([address?.ipv4, address?.ipv6].filter((ip) => ip !== undefined));
  const strip = (checks: readonly CheckResult[]) =>
    checks.map(({ target, ...check }) =>
      target === undefined || named.has(target) ? check : { ...check, target },
    );
  return { ...rest, hostChecks: strip(input.hostChecks), probes: strip(input.probes) };
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
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
  const address = await serverAddress(deps, plan);
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
  if (host === undefined) {
    hostChecksSkipped =
      "OpsCrew does not know the server's address on this computer. If the app is deployed, run `opscrew secure` on the computer that provisioned the server (its `.opscrew/` folder holds the address); otherwise deploy it first.";
  } else {
    const remote =
      options.remote ??
      ((await exists(paths.files.deployKey))
        ? new SshRemoteExec({
            host,
            keyFile: paths.files.deployKey,
            knownHostsFile: paths.files.knownHosts,
            runner: deps.runner,
          })
        : undefined);
    if (remote === undefined) {
      hostChecksSkipped =
        "the deploy key is not on this machine (it is created by `opscrew provision`). Run the checks from the machine that provisioned the server.";
    } else {
      reporter.step(`Checking the server's hardening over SSH (${host})`);
      hostChecks = await runHostChecks(remote);
    }
    reporter.step(`Probing ${host} from outside`);
    const connect = options.tcpConnect ?? defaultTcpConnect;
    const timeoutMs = options.probeTimeoutMs ?? 3000;
    probes = [
      ...(await probeExpectedPorts(host, plan, { connect, timeoutMs })),
      ...(await probePorts(host, {
        connect,
        timeoutMs,
        providerName: providerProfile(planProvider(plan)).displayName,
      })),
      await probeSshPasswordAuth(host, {
        runner: deps.runner,
        knownHostsFile: paths.files.knownHosts,
      }),
    ];
  }

  const input: SecurityReportInput = {
    appName: plan.app.name,
    version: deps.version,
    generatedAt: deps.clock.now().toISOString(),
    scan,
    hostChecks,
    probes,
    ...(host !== undefined ? { host } : {}),
    ...(policies !== undefined ? { policies } : {}),
    ...(hostChecksSkipped !== undefined ? { hostChecksSkipped } : {}),
  };
  // The report is committed: behind Cloudflare's proxy it never names the server's address.
  const report = say(
    hidesServerAddress(plan)
      ? withoutServerAddress(renderSecurityReport(privateReportInput(input, address)), [address])
      : renderSecurityReport(input),
  );
  await writeFileAtomic(paths.files.securityReport, report);
  const reportPath = toPosixRelative(paths.root, paths.files.securityReport);

  const problems = securityProblems(input);
  const passed = problems.every((problem) => problem.status !== "fail");
  const summary = say(renderSecuritySummary(input, { reportPath }));
  const [headline = "", ...details] = summary.trimEnd().split("\n");
  if (passed) reporter.success(headline);
  else reporter.error(headline);
  for (const line of details) reporter.info(line);
  if (hostChecksSkipped !== undefined)
    reporter.warn(say(`Server checks skipped: ${hostChecksSkipped}`));

  const failures = problems.filter((problem) => problem.status === "fail").length;
  await deps.state.markPhase(
    "secure",
    passed ? "ok" : "failed",
    passed
      ? `no failures, ${problems.length} warning${problems.length === 1 ? "" : "s"}`
      : `${failures} problem${failures === 1 ? "" : "s"} to fix`,
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
