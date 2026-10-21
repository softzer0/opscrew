import type { CheckResult, CommandResult, FetchLike, RemoteExec } from "@opscrew/contracts";
import { errorMessage } from "@opscrew/core";
import { z } from "zod";
import { markNoise } from "./noise";
import { containerName, lastLine, skippedTool, skipResult } from "./shared";
import type { DeepPins, DeepToolResult } from "./types";

/** One `warning[]` or `suggestion[]` line of a Lynis report: `ID|text|details|solution|`. */
export interface LynisItem {
  id: string;
  text: string;
  details?: string;
  solution?: string;
}

/** What OpsCrew reads from a Lynis report (`report.dat`). */
export interface LynisReport {
  version?: string;
  hardeningIndex?: number;
  warnings: LynisItem[];
  suggestions: LynisItem[];
}

const LynisItemSchema = z.object({
  // A test id such as `PKGS-7392`, or `LYNIS` for Lynis's notices about itself.
  id: z.string().regex(/^[A-Z]+(-\d+)?$/),
  text: z.string().min(1),
  details: z.string().min(1).optional(),
  solution: z.string().min(1).optional(),
});

const LynisReportSchema = z.object({
  version: z.string().min(1).optional(),
  hardeningIndex: z.number().int().min(0).max(100).optional(),
  warnings: z.array(LynisItemSchema),
  suggestions: z.array(LynisItemSchema),
});

/** A Lynis field that says nothing (`-`, empty). */
function field(value: string | undefined): string | undefined {
  const text = value?.trim().replace(/^text:/, "");
  return text === undefined || text === "" || text === "-" ? undefined : text;
}

function item(value: string): LynisItem {
  const [id = "", text = "", details, solution] = value.split("|");
  const d = field(details);
  const s = field(solution);
  return {
    id: id.trim(),
    text: text.trim(),
    ...(d !== undefined ? { details: d } : {}),
    ...(s !== undefined ? { solution: s } : {}),
  };
}

/** The key=value report Lynis writes with `--report-file`: version, hardening index, warnings, suggestions. */
export function parseLynisReport(text: string): LynisReport {
  const report: LynisReport = { warnings: [], suggestions: [] };
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "lynis_version") report.version = value.trim();
    else if (key === "hardening_index") report.hardeningIndex = Number(value);
    else if (key === "warning[]") report.warnings.push(item(value));
    else if (key === "suggestion[]") report.suggestions.push(item(value));
  }
  return LynisReportSchema.parse(report);
}

/** Lynis's page for a test, which says what it checks and how to fix it. */
function controlPage(id: string): string {
  return `See https://cisofy.com/lynis/controls/${id}/ for what Lynis checks and how to fix it.`;
}

/** The lowest Lynis hardening index that is not reported (contract "Severity mapping"). */
export const LYNIS_INDEX_THRESHOLD = 65;

/**
 * A report's results: each warning medium `warn`, each suggestion low `warn`, and the hardening
 * index (`warn` at medium below {@link LYNIS_INDEX_THRESHOLD}), with known noise marked.
 */
export function lynisResults(report: LynisReport): CheckResult[] {
  const advice = new Map(report.suggestions.map((s) => [s.id, s.text]));
  const result = (entry: LynisItem, kind: "warning" | "suggestion"): CheckResult => {
    const remediation =
      entry.solution ??
      (kind === "warning" ? advice.get(entry.id) : undefined) ??
      controlPage(entry.id);
    return {
      id: entry.id,
      title: `Lynis ${kind} ${entry.id}`,
      status: "warn",
      severity: kind === "warning" ? "medium" : "low",
      message: entry.details !== undefined ? `${entry.text} (${entry.details})` : entry.text,
      remediation,
      source: "lynis",
    };
  };
  const index = report.hardeningIndex;
  const results: CheckResult[] = [
    ...(index === undefined
      ? []
      : [
          {
            id: "hardening-index",
            title: `Lynis hardening index is ${LYNIS_INDEX_THRESHOLD} or more`,
            status: index < LYNIS_INDEX_THRESHOLD ? ("warn" as const) : ("pass" as const),
            severity: "medium" as const,
            message: `The Lynis hardening index is ${index} of 100.`,
            ...(index < LYNIS_INDEX_THRESHOLD
              ? { remediation: "Work through Lynis's warnings and suggestions to raise it." }
              : {}),
            source: "lynis",
          },
        ]),
    ...report.warnings.map((w) => result(w, "warning")),
    ...report.suggestions.map((s) => result(s, "suggestion")),
  ];
  return markNoise(results, "lynis");
}

/** Lynis's time limit on the server, the image pull included (contract "Guarantees"). */
export const LYNIS_TIMEOUT_MS = 4 * 60_000;

const SHA_MISMATCH_EXIT = 90;

/**
 * The script Lynis's container runs: the tarball (base64 on stdin) is written to the tmpfs and
 * checked against its SHA-256, then Lynis runs chrooted into the read-only host and its report is
 * printed. Single quotes never appear in it, so it fits inside `sh -c '…'`.
 */
function containerScript(sha256: string): string {
  return [
    "set -e",
    "cd /hostfs/tmp",
    "base64 -d > lynis.tar.gz",
    `echo "${sha256}  lynis.tar.gz" | sha256sum -c -s - || { echo "the Lynis tarball does not match its pinned SHA-256" >&2; exit ${SHA_MISMATCH_EXIT}; }`,
    "tar -xzf lynis.tar.gz",
    'chroot /hostfs /bin/sh -c "cd /tmp/lynis && sh ./lynis audit system --quick --no-colors --report-file /tmp/report.dat --log-file /tmp/lynis.log" > /dev/null',
    "cat report.dat",
  ].join("; ");
}

/**
 * The `docker run` of Lynis's throwaway container `name`: the host's root read-only at `/hostfs`,
 * its submounts too (Docker refuses where it cannot), an executable tmpfs over `/hostfs/tmp`, the
 * host's processes and network, no new privileges, and root inside (the pinned image runs as a
 * non-root user).
 */
export function lynisDockerCommand(pins: DeepPins, name: string): string {
  return [
    `docker run --rm -i --name ${name} --user 0`,
    "--mount type=bind,src=/,dst=/hostfs,readonly,bind-recursive=readonly",
    "--tmpfs /hostfs/tmp:rw,exec,size=128m",
    "--pid=host --net=host --security-opt no-new-privileges",
    `--entrypoint /bin/sh ${pins.lynisImage}`,
    `-c '${containerScript(pins.lynis.sha256)}'`,
  ].join(" ");
}

/**
 * Lynis on the server, run over `ssh` as `deploy` (in the docker group) through a throwaway
 * container (see {@link lynisDockerCommand}), within {@link LYNIS_TIMEOUT_MS}. The tarball is
 * downloaded here and streamed in on stdin. The image is removed afterwards when it was not on the
 * server before, so nothing stays. Anything that stops it gives one `skip` result.
 */
export async function runLynis(
  ssh: RemoteExec,
  pins: DeepPins,
  fetch: FetchLike,
): Promise<DeepToolResult> {
  const version = pins.lynis.version;
  const skip = (reason: string, remediation: string) =>
    skippedTool("lynis", pins, reason, remediation);

  let tarball: Uint8Array;
  try {
    const response = await fetch(pins.lynis.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    tarball = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    return skip(
      `Lynis ${version} could not be downloaded from ${pins.lynis.url} (${errorMessage(error)}).`,
      "Check this computer's internet connection, then run `opscrew secure --deep` again.",
    );
  }

  const image = pins.lynisImage;
  const before = await ssh.run(
    `docker image inspect ${image} > /dev/null 2>&1 && echo yes || echo no`,
  );
  if (before.exitCode !== 0) {
    return skip(
      `OpsCrew could not reach the server over SSH to run Lynis (${lastLine(before)}).`,
      "Check that the server is up and this computer can log in as `deploy`, then run `opscrew secure --deep` again.",
    );
  }
  const present = before.stdout.trim() === "yes";
  const name = containerName("lynis");
  let run: CommandResult | undefined;
  let removed: CommandResult | undefined;
  try {
    run = await ssh.run(lynisDockerCommand(pins, name), {
      timeoutMs: LYNIS_TIMEOUT_MS,
      input: Buffer.from(tarball).toString("base64"),
    });
  } finally {
    // A container that timed out or failed may still run on the server: it goes first.
    if (run === undefined || run.timedOut || run.exitCode !== 0) {
      await ssh.run(`docker rm -f ${name} > /dev/null 2>&1 || true`);
    }
    // The image is removed when it was absent before and is there now (pulled by this run).
    if (!present) {
      removed = await ssh.run(
        `if docker image inspect ${image} > /dev/null 2>&1; then docker image rm ${image} > /dev/null; fi`,
      );
    }
  }
  const left: CheckResult[] =
    removed === undefined || removed.exitCode === 0
      ? []
      : [
          {
            id: "lynis-image-removed",
            title: "Lynis's container image is removed after the audit",
            status: "warn",
            severity: "low",
            message: `The image Lynis ran in could not be removed from the server (${lastLine(removed)}).`,
            remediation: `Remove it on the server with \`docker image rm ${image}\`.`,
            source: "lynis",
          },
        ];
  const failed = (reason: string, remediation: string): DeepToolResult => ({
    tool: "lynis",
    version,
    results: [skipResult("lynis", reason, remediation), ...left],
  });

  if (run.timedOut) {
    return failed(
      "Lynis did not finish within 4 minutes, so it gives no result.",
      "Run `opscrew secure --deep` again when the server is less busy.",
    );
  }
  if (run.exitCode === SHA_MISMATCH_EXIT) {
    return failed(
      `The Lynis ${version} download does not match its pinned SHA-256, so it did not run.`,
      "Run `opscrew secure --deep` again later. If it keeps failing, the download has changed: report it to OpsCrew.",
    );
  }
  if (run.exitCode === 125 && /recursive/i.test(run.stderr)) {
    return failed(
      `This server's Docker or kernel cannot mount the host read-only, so OpsCrew does not run Lynis on it (${lastLine(run)}).`,
      "Lynis needs Linux kernel 5.12 or later and Docker 25 or later on the server. Upgrade them, then run `opscrew secure --deep` again.",
    );
  }
  if (run.exitCode !== 0) {
    return failed(
      `Lynis could not run on the server (${lastLine(run)}).`,
      "Check that `deploy` can run Docker on the server (OpsCrew puts it in the docker group), then run `opscrew secure --deep` again.",
    );
  }
  let report: LynisReport;
  try {
    report = parseLynisReport(run.stdout);
  } catch (error) {
    return failed(
      `Lynis's report could not be read (${errorMessage(error)}).`,
      "Run `opscrew secure --deep` again. If it keeps failing, report it to OpsCrew.",
    );
  }
  return {
    tool: "lynis",
    version: report.version ?? version,
    results: [...lynisResults(report), ...left],
    ...(report.hardeningIndex !== undefined ? { hardeningIndex: report.hardeningIndex } : {}),
  };
}
