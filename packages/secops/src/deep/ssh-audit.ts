import type { CheckResult } from "@opscrew/contracts";
import { z } from "zod";
import { markNoise } from "./noise";
import { dockerRunSkip, imageVersion, json, runLocalContainer, skipResult } from "./shared";
import type { DeepPins, DeepToolResult, LocalDocker } from "./types";

/** ssh-audit's built-in policy for OpsCrew's servers (Ubuntu 24.04), as ssh-audit names it. */
export const SSH_AUDIT_POLICY = "Hardened Ubuntu Server 24.04 LTS (version 2)";

/** ssh-audit's time limit per run (contract "Guarantees"). */
export const SSH_AUDIT_TIMEOUT_MS = 60_000;

const KINDS = ["kex", "key", "enc", "mac"] as const;
type AlgorithmKind = (typeof KINDS)[number];

const KIND_NAME: Record<AlgorithmKind, string> = {
  kex: "key exchange",
  key: "host key",
  enc: "cipher",
  mac: "MAC",
};

const Notes = z.object({
  fail: z.array(z.string()).optional(),
  warn: z.array(z.string()).optional(),
  info: z.array(z.string()).optional(),
});
const Algorithm = z.object({ algorithm: z.string().min(1), notes: Notes });

const AuditSchema = z.object({
  banner: z.object({ software: z.string().nullish() }),
  kex: z.array(Algorithm),
  key: z.array(Algorithm),
  enc: z.array(Algorithm),
  mac: z.array(Algorithm),
});

const PolicySchema = z.object({
  policy: z.string().min(1),
  passed: z.boolean(),
  errors: z.array(
    z.object({
      mismatched_field: z.string().min(1),
      actual: z.array(z.string()),
      expected_required: z.array(z.string()),
      expected_optional: z.array(z.string()),
    }),
  ),
});

/** One algorithm the server offers, with what ssh-audit fails and warns about it. */
export interface SshAuditAlgorithm {
  kind: AlgorithmKind;
  name: string;
  fail: string[];
  warn: string[];
}

/** What OpsCrew reads from ssh-audit's audit (`-jj`). */
export interface SshAuditResult {
  /** The server's SSH software, such as `OpenSSH_9.6p1`. */
  software?: string;
  algorithms: SshAuditAlgorithm[];
}

/** What OpsCrew reads from ssh-audit's policy test (`-jj -P`). */
export interface SshAuditPolicyResult {
  policy: string;
  passed: boolean;
  /** The settings that differ from the policy, such as `Key exchanges`. */
  mismatched: string[];
}

/** ssh-audit's `-jj` JSON, zod-checked. */
export function parseSshAudit(json: unknown): SshAuditResult {
  const audit = AuditSchema.parse(json);
  return {
    ...(audit.banner.software ? { software: audit.banner.software } : {}),
    algorithms: KINDS.flatMap((kind) =>
      audit[kind].map((a) => ({
        kind,
        name: a.algorithm,
        fail: a.notes.fail ?? [],
        warn: a.notes.warn ?? [],
      })),
    ),
  };
}

/** ssh-audit's `-jj -P <policy>` JSON, zod-checked. */
export function parseSshAuditPolicy(json: unknown): SshAuditPolicyResult {
  const policy = PolicySchema.parse(json);
  return {
    policy: policy.policy,
    passed: policy.passed,
    mismatched: policy.errors.map((e) => e.mismatched_field),
  };
}

const HARDENING_GUIDE =
  "ssh-audit's hardening guide for Ubuntu 24.04 (https://www.ssh-audit.com/hardening_guides.html) lists the settings for /etc/ssh/sshd_config.d/.";

/**
 * The results: the policy test high `fail` (or `pass`), and each algorithm ssh-audit fails or warns
 * about low `warn`, with known noise marked.
 */
export function sshAuditResults(
  audit: SshAuditResult,
  policy: SshAuditPolicyResult,
): CheckResult[] {
  const results: CheckResult[] = [
    {
      id: "policy",
      title: `SSH meets ssh-audit's "${policy.policy}" policy`,
      status: policy.passed ? "pass" : "fail",
      severity: "high",
      message: policy.passed
        ? "The SSH server meets the policy."
        : `The SSH server does not meet the policy: ${policy.mismatched.join(", ")} differ.`,
      ...(policy.passed
        ? {}
        : { remediation: `Offer only what the policy expects. ${HARDENING_GUIDE}` }),
      source: "ssh-audit",
    },
    ...audit.algorithms
      .filter((a) => a.fail.length > 0 || a.warn.length > 0)
      .map(
        (a): CheckResult => ({
          id: `${a.kind}:${a.name}`,
          title: `SSH ${KIND_NAME[a.kind]} ${a.name}`,
          status: "warn",
          severity: "low",
          message: `${a.name}: ${[...a.fail, ...a.warn].join("; ")}.`,
          remediation: `Remove ${a.name} from the server's SSH ${KIND_NAME[a.kind]}s. ${HARDENING_GUIDE}`,
          source: "ssh-audit",
        }),
      ),
  ];
  return markNoise(results, "ssh-audit");
}

/**
 * ssh-audit from this computer, in its pinned image, against `host:port`: the audit (`-jj`, without
 * the connection-rate test, so a few connections only) and the Ubuntu 24.04 policy test (`-jj -P`),
 * each within {@link SSH_AUDIT_TIMEOUT_MS}. ssh-audit exits 3 even with complete JSON, so only the
 * JSON counts. A run without its JSON (refused, timed out) gives one `skip`, never a pass.
 */
export async function runSshAudit(
  docker: LocalDocker,
  host: string,
  port: number,
  pins: DeepPins,
): Promise<DeepToolResult> {
  const version = imageVersion(pins.sshAudit);
  const done = (results: CheckResult[]): DeepToolResult => ({
    tool: "ssh-audit",
    version,
    results,
  });
  const run = async (...mode: string[]) => {
    const result = await runLocalContainer(
      docker,
      "ssh-audit",
      [pins.sshAudit, "-jj", ...mode, "-p", String(port), host],
      SSH_AUDIT_TIMEOUT_MS,
    );
    const answer = result.timedOut ? undefined : json(result);
    return answer === undefined
      ? { skip: dockerRunSkip("ssh-audit", result, `auditing SSH on port ${port}`, "1 minute") }
      : { answer };
  };
  const audit = await run("--skip-rate-test");
  if (audit.skip !== undefined) return done([audit.skip]);
  const policy = await run("-P", SSH_AUDIT_POLICY);
  if (policy.skip !== undefined) return done([policy.skip]);
  try {
    return done(sshAuditResults(parseSshAudit(audit.answer), parseSshAuditPolicy(policy.answer)));
  } catch {
    return done([
      skipResult(
        "ssh-audit",
        `ssh-audit's answer about port ${port} could not be read, so it gives no result.`,
        "Run `opscrew secure --deep` again. If it keeps failing, report it to OpsCrew.",
      ),
    ]);
  }
}
