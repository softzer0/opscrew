import type { CheckResult, Severity } from "@opscrew/contracts";
import { z } from "zod";
import { markNoise } from "./noise";
import { dockerRunSkip, imageVersion, json, runLocalContainer, skipResult } from "./shared";
import type { DeepPins, DeepToolResult, LocalDocker } from "./types";

/** testssl.sh's time limit per hostname (contract "Guarantees"). */
export const TESTSSL_TIMEOUT_MS = 2 * 60_000;

const TestsslSeverity = z.enum([
  "OK",
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
  "WARN",
  "FATAL",
]);

const ItemSchema = z.object({
  id: z.string().min(1),
  severity: TestsslSeverity,
  finding: z.string(),
});

const section = z.array(ItemSchema).optional();

/** A target's results, by section (`-p -S -h` fills these). */
const TargetSchema = z.object({
  targetHost: z.string().min(1),
  pretest: section,
  protocols: section,
  grease: section,
  ciphers: section,
  serverPreferences: section,
  fs: section,
  serverDefaults: section,
  headerResponse: section,
  vulnerabilities: section,
  cipherTests: section,
  browserSimulations: section,
  rating: section,
});

/**
 * `scanResult` holds a target's sections, or, when the scan stopped (such as a refused
 * connection), the `FATAL` item itself.
 */
const TestsslSchema = z.object({
  version: z.string(),
  scanResult: z.array(z.union([ItemSchema, TargetSchema])),
});

/** One testssl.sh finding. */
export interface TestsslItem {
  id: string;
  severity: z.infer<typeof TestsslSeverity>;
  finding: string;
}

/** testssl.sh's `--jsonfile-pretty` JSON, zod-checked: its version and every finding of the scan. */
export function parseTestssl(json: unknown): { version: string; items: TestsslItem[] } {
  const parsed = TestsslSchema.parse(json);
  const items = parsed.scanResult.flatMap((entry): TestsslItem[] => {
    if ("severity" in entry) return [entry];
    const { targetHost: _, ...sections } = entry;
    return Object.values(sections).flatMap((items) => items ?? []);
  });
  return { version: parsed.version.trim(), items };
}

const SEVERITY: Partial<Record<TestsslItem["severity"], Severity>> = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

/** A hostname as the report shows it: a proxied one is Cloudflare's edge (FR-1423). */
function shownTarget(hostname: string, edge: boolean): string {
  return edge ? `${hostname} (Cloudflare's edge)` : hostname;
}

/**
 * The results for `hostname`: CRITICAL to LOW map one to one (CRITICAL and HIGH `fail`, MEDIUM and
 * LOW `warn`), OK and INFO are dropped, and WARN or FATAL (a problem with the scan) is a `skip`
 * with its reason. Known noise is marked; with nothing to report, one `pass`.
 */
export function testsslResults(
  items: readonly TestsslItem[],
  hostname: string,
  edge: boolean,
): CheckResult[] {
  const target = shownTarget(hostname, edge);
  const results = items.flatMap((item): CheckResult[] => {
    const finding = item.finding === "--" ? "none" : item.finding;
    if (item.severity === "WARN" || item.severity === "FATAL") {
      return [
        skipResult(
          "testssl",
          `testssl.sh could not test this fully: ${finding}`,
          "Check that this computer can reach the hostname on port 443, then run `opscrew secure --deep` again.",
          target,
        ),
      ];
    }
    const severity = SEVERITY[item.severity];
    if (severity === undefined) return [];
    return [
      {
        id: item.id,
        title: `TLS check ${item.id}`,
        status: severity === "critical" || severity === "high" ? "fail" : "warn",
        severity,
        message: `${item.id}: ${finding}`,
        ...(edge
          ? {
              remediation:
                "This is what Cloudflare serves to visitors: change it in Cloudflare's SSL/TLS settings for the zone.",
            }
          : {}),
        target,
        source: "testssl",
      },
    ];
  });
  if (results.length > 0) return markNoise(results, "testssl");
  return [
    {
      id: "tls",
      title: "TLS has no problems testssl.sh reports",
      status: "pass",
      severity: "info",
      message: "testssl.sh found nothing to report.",
      target,
      source: "testssl",
    },
  ];
}

/**
 * testssl.sh from this computer, in its pinned image, against `hostname:443` (always a hostname,
 * never an address, so the trust results are right), within {@link TESTSSL_TIMEOUT_MS}. Its screen
 * output is dropped inside the container and only its JSON file comes back. `edge` labels a
 * proxied hostname's results as Cloudflare's edge. A scan without JSON gives one `skip`.
 */
export async function runTestssl(
  docker: LocalDocker,
  hostname: string,
  pins: DeepPins,
  opts: { edge: boolean },
): Promise<DeepToolResult> {
  const result = await runLocalContainer(
    docker,
    "testssl",
    [
      "--entrypoint",
      "/bin/sh",
      pins.testssl,
      "-c",
      'testssl.sh "$@" > /dev/null; cat /tmp/testssl.json',
      "testssl",
      "--quiet",
      "--warnings",
      "batch",
      "--color",
      "0",
      "--connect-timeout",
      "10",
      "--jsonfile-pretty",
      "/tmp/testssl.json",
      "-p",
      "-S",
      "-h",
      `${hostname}:443`,
    ],
    TESTSSL_TIMEOUT_MS,
  );
  const target = shownTarget(hostname, opts.edge);
  const answer = result.timedOut ? undefined : json(result);
  const version = imageVersion(pins.testssl);
  if (answer === undefined) {
    return {
      tool: "testssl",
      version,
      results: [dockerRunSkip("testssl", result, `testing ${hostname}`, "2 minutes", target)],
    };
  }
  try {
    const parsed = parseTestssl(answer);
    return {
      tool: "testssl",
      version: parsed.version,
      results: testsslResults(parsed.items, hostname, opts.edge),
    };
  } catch {
    return {
      tool: "testssl",
      version,
      results: [
        skipResult(
          "testssl",
          `testssl.sh's answer about ${hostname} could not be read, so it gives no result.`,
          "Run `opscrew secure --deep` again. If it keeps failing, report it to OpsCrew.",
          target,
        ),
      ],
    };
  }
}
