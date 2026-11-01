/**
 * `opscrew logs --failed` (FR-1910, SC-1904): the lines the deploy kept of the last copy that failed
 * its checks, in `<app folder>/.failed-deploy/` (`about` and `<service>.log`), read-only through the
 * access `logs` uses and masked as every line.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { FAILED_DEPLOY_DIR } from "@opscrew/iac-templates";
import { type DeployPlan, isServerlessProvider } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { shortImage } from "../rollback/versions";
import { dockerLogLine, isContainerName } from "./commands";
import { type LogLine, type LogRead, logRead } from "./lines";
import { logPart, logParts } from "./parts";
import type { LogOptions } from "./read";
import { appFiles } from "./targets";

/** What sends the user back to the running version's lines. */
const RUNNING_NOW = "`opscrew logs` shows the version running now.";

/**
 * `about`'s `failed=` in words, after "that failed"; `process` is the name in `process <name>`.
 */
function failedWhat(failed: string, process: string | undefined): string {
  if (process !== undefined) return `its process check (${process} did not keep running)`;
  if (failed === "health") return "its health check";
  if (failed === "check") return "the check from outside";
  return "its checks";
}

/** The value of `key=` in `about`, or "" when it has none. */
function aboutValue(about: string, key: string): string {
  return (
    about
      .split(/\r?\n/)
      .find((line) => line.startsWith(`${key}=`))
      ?.slice(key.length + 1) ?? ""
  );
}

/**
 * The kept lines of the last failed copy (FR-1910) on the plan's app server or this computer: of
 * the part `service` names, else of the part that failed (`app`, or the process `about` names),
 * all of them or the latest `tail`. The first line names the copy's short digest, what it failed
 * and when, and that OpsCrew removed it. Portainer and the sites keep none, and it says so. The
 * read is audited as `remote-exec`, without an address.
 * @throws OpsCrewError `INVALID_INPUT` with `follow` or `since`, or a `service` the plan has no
 * part of, before connecting.
 */
export async function readFailedLogs(
  deps: PhaseDeps,
  plan: DeployPlan,
  options: LogOptions,
): Promise<LogRead> {
  if (options.follow === true || options.since !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `--failed shows the lines OpsCrew kept of the last failed deploy, so it takes no ${options.follow === true ? "--follow" : "--since"}.`,
      { hint: "Run `opscrew logs --failed` alone, or `opscrew logs` for the version running now." },
    );
  }
  const { provider } = plan.target;
  if (provider === "portainer" || isServerlessProvider(provider)) {
    const host =
      provider === "portainer"
        ? "Your Portainer keeps no failed deploy's lines: OpsCrew has no shell there to keep them."
        : `${provider === "github-pages" ? "GitHub Pages" : "Cloudflare"} keeps no failed deploy's lines: a site's deploy starts no copy that could fail its health check.`;
    return logRead(deps.redactor.redact(`${host} ${RUNNING_NOW}`), []);
  }
  const asked = options.service === undefined ? undefined : logPart(plan, options.service);
  const files = await appFiles(deps, plan, options);
  deps.reporter.step(`Reading the failed deploy's lines ${files.where} (read-only)`);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "read the failed deploy's lines (read-only)",
    target: files.audit,
    decision: "allow",
    detail: asked?.service ?? "the part that failed",
  });
  const about = await files.read(`${FAILED_DEPLOY_DIR}/about`);
  if (about === undefined || aboutValue(about, "image") === "") {
    return logRead(
      deps.redactor.redact(
        `No failed deploy's lines are kept ${files.where}: they are kept when a new version fails its checks. ${RUNNING_NOW}`,
      ),
      [],
    );
  }
  const failed = aboutValue(about, "failed");
  const process = /^process (.+)$/.exec(failed)?.[1];
  const copy = `Lines of the copy of ${shortImage(aboutValue(about, "image"))} that failed ${failedWhat(failed, process)} at ${formatUtc(aboutValue(about, "time"))}; OpsCrew removed it.`;
  const parts = logParts(plan);
  const part = asked ?? parts.find((candidate) => candidate.service === (process ?? "app"));
  if (part === undefined) {
    const gone = `It failed on ${process}, which the plan no longer has. --service takes ${listText(parts.map((p) => p.service))}.`;
    return logRead(deps.redactor.redact([copy, gone, RUNNING_NOW].join(" ")), []);
  }
  if (!isContainerName(part.composeService)) {
    throw new OpsCrewError("INTERNAL", "A part whose kept lines OpsCrew does not read.");
  }
  const log = await files.read(`${FAILED_DEPLOY_DIR}/${part.composeService}.log`);
  const none = log === undefined ? [`It kept no lines of ${part.what}.`] : [];
  const first = deps.redactor.redact([copy, ...none, RUNNING_NOW].join(" "));
  // `keep_failed` writes both streams into one file, so each line is read as stdout.
  const kept = (log ?? "").split(/\r?\n/).flatMap((text) => dockerLogLine("stdout", text) ?? []);
  const lines = kept.slice(-(options.tail ?? kept.length)).map(
    (raw): LogLine => ({
      time: raw.time,
      service: part.service,
      stream: raw.stream,
      text: deps.redactor.redact(raw.line),
    }),
  );
  return logRead(first, lines);
}
