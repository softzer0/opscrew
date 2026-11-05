/**
 * `opscrew verify --env <preview>` (FR-2221, plan.md 8.): a preview environment has no hostname
 * of its own, so verify checks its server (it answers and lists its previews through the preview
 * command) and each running preview's address (its certificate and its health endpoint). It
 * writes no runbook and records nothing in plan.yaml: previews come and go with pull requests.
 */
import type { CheckResult } from "@opscrew/contracts";
import { errorText, isUserFacingError, plural } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { defaultTcpConnect } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { listPreviews, type Preview, type PreviewList } from "../previews/list";
import { requirePreviews } from "../previews/remote";
import { checkResult, summarizeChecks } from "../shared";
import { checkHealth, checkTls, reportChecks, type VerifyCheckContext } from "./checks";
import { defaultDnsResolver, defaultTlsConnect } from "./net";
import type { RunVerifyOptions, VerifyResult } from "./run";

/** The checks of one preview: its state, then (when it runs) its certificate and health. */
async function previewChecks(p: Preview, ctx: VerifyCheckContext): Promise<CheckResult[]> {
  const read = `Read its lines with \`opscrew preview logs ${p.number}${ctx.flag ?? ""}\``;
  const logs = `${read}; a new push to its pull request tries again.`;
  /** `check` of the preview: its title names it, and a failure says to read its lines. */
  const ofPreview = (check: CheckResult): CheckResult => ({
    ...check,
    title: `pr-${p.number}: ${check.title}`,
    ...(check.status === "fail"
      ? { remediation: `${read}, and its pull request's preview job in GitHub Actions.` }
      : {}),
  });
  if (p.state === "failed") {
    return [
      checkResult(
        "preview-state",
        `pr-${p.number} runs`,
        "medium",
        "warn",
        `pr-${p.number}'s last deploy failed, so ${p.address} is not served.`,
        { remediation: logs, target: p.address },
      ),
    ];
  }
  const host = new URL(p.address).hostname;
  return [
    ...(p.state === "seed-failed"
      ? [
          checkResult(
            "preview-seed",
            `pr-${p.number}'s seed ran`,
            "low",
            "warn",
            `pr-${p.number} runs, but its seed command failed, so its databases may be empty.`,
            { remediation: logs, target: p.address },
          ),
        ]
      : []),
    ofPreview(await checkTls(host, ctx)),
    ofPreview(await checkHealth(p.address, ctx)),
  ];
}

/** The server's check: it answers over SSH, and its preview command lists the previews. */
function serverCheck(list: PreviewList | undefined, error: unknown): CheckResult {
  const id = "preview-server";
  const title = "The preview server answers and lists its previews";
  if (list !== undefined) {
    return checkResult(
      id,
      title,
      "high",
      "pass",
      `${plural(list.count, "preview")} of at most ${list.cap} on the server.`,
    );
  }
  const said = isUserFacingError(error) ? error : undefined;
  return checkResult(id, title, "high", "fail", errorText(error), {
    ...(said?.hint !== undefined ? { remediation: said.hint } : {}),
  });
}

/**
 * Verifies a preview environment (see the module's comment), marks `verify`, and returns its
 * checks; `url` is the previews' address pattern. Read-only.
 */
export async function verifyPreviews(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: RunVerifyOptions & { flag: string },
): Promise<VerifyResult> {
  const { reporter } = deps;
  const { domain } = requirePreviews(plan, deps.paths.environment, "opscrew verify");
  let list: PreviewList | undefined;
  let failure: unknown;
  try {
    list = await listPreviews(deps, plan, {
      services: options.remote !== undefined ? { remote: options.remote } : {},
    });
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    failure = error;
  }
  const ctx: VerifyCheckContext = {
    plan,
    resolver: options.resolver ?? defaultDnsResolver,
    fetch: options.fetch ?? deps.fetch,
    tlsConnect: options.tlsConnect ?? defaultTlsConnect,
    tcpConnect: options.tcpConnect ?? defaultTcpConnect,
    now: deps.clock.now(),
    deployRuns: async () => undefined,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    flag: options.flag,
  };
  const checks = [serverCheck(list, failure)];
  for (const p of list?.previews ?? []) checks.push(...(await previewChecks(p, ctx)));
  const shown = checks.map((check) => ({
    ...check,
    message: deps.redactor.redact(check.message),
  }));
  reportChecks(reporter, shown);
  const passed = shown.every((check) => check.status !== "fail");
  const summary = summarizeChecks(shown);
  if (passed) reporter.success(`The preview server and its previews are healthy (${summary}).`);
  else {
    reporter.error(
      `Verification found problems (${summary}). Fix them and run \`opscrew verify${options.flag}\` again.`,
    );
  }
  await deps.state.markPhase("verify", passed ? "ok" : "failed", summary);
  return { checks: shown, passed, url: `https://pr-<number>.${domain}`, plan };
}
