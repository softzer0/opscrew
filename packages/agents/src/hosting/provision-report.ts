/**
 * The agent's first report (027 plan 2, `state/report`): its read-only GitHub key, the account's
 * PHP CLIs, the tools it found and whether GitHub answers over SSH. Read through the panel's files,
 * validated with zod, and checked before the app's plan is made.
 */
import type { HostingFiles } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { z } from "zod";
import { type PhpBinary, phpVersionOf } from "./php";
import { keyValues, type WaitOptions } from "./requests";

/** The tools the agent reports on. */
const TOOLS = ["git", "openssl", "flock", "mysqldump", "tar", "curl", "ssh", "ssh-keygen"] as const;

const YesNo = z.enum(["yes", "no"]).transform((value) => value === "yes");

/** An OpenSSH ed25519 public key line, as `ssh-keygen` writes it. */
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: \S+)?$/;

/** The agent's report as OpsCrew uses it. */
interface AgentReport {
  /** The agent's read-only GitHub key's public half; empty without `ssh-keygen`. */
  publicKey: string;
  php: PhpBinary[];
  tools: Record<(typeof TOOLS)[number], boolean>;
  /** GitHub answers over SSH on port 22, and on `ssh.github.com:443`. */
  github: { port22: boolean; port443: boolean };
}

const ReportSchema = z.record(z.string(), z.string()).transform((values, ctx): AgentReport => {
  const key = values.public_key ?? "";
  if (key !== "" && !PUBLIC_KEY.test(key)) {
    ctx.addIssue({ code: "custom", message: "public_key isn't an ed25519 public key" });
  }
  const php: PhpBinary[] = [];
  for (let n = 1; values[`php.${n}.path`] !== undefined; n++) {
    const path = values[`php.${n}.path`] ?? "";
    const version = phpVersionOf(values[`php.${n}.version`] ?? "");
    if (!/^\/[A-Za-z0-9._/-]+$/.test(path)) {
      ctx.addIssue({ code: "custom", message: `php.${n}.path isn't a path` });
    }
    // A CLI that doesn't answer `-v` (a broken build) is left out.
    if (version === undefined) continue;
    const modules = (values[`php.${n}.modules`] ?? "")
      .split(",")
      .map((module) => module.trim().toLowerCase().replace(/\s+/g, "-"))
      .filter((module) => module !== "");
    php.push({ path, version, modules });
  }
  const flag = (name: string) => {
    const parsed = YesNo.safeParse(values[name]);
    if (!parsed.success) ctx.addIssue({ code: "custom", message: `${name} isn't yes or no` });
    return parsed.success && parsed.data;
  };
  const tools = Object.fromEntries(TOOLS.map((tool) => [tool, flag(`tool.${tool}`)])) as Record<
    (typeof TOOLS)[number],
    boolean
  >;
  return {
    publicKey: key,
    php,
    tools,
    github: { port22: flag("github.22"), port443: flag("github.443") },
  };
});

/**
 * The report in `text` (`state/report`).
 * @throws OpsCrewError `PROVIDER_ERROR` for one OpsCrew can't read.
 */
function parseAgentReport(text: string, path: string): AgentReport {
  const parsed = ReportSchema.safeParse(keyValues(text));
  if (parsed.success) return parsed.data;
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    `OpsCrew can't read the agent's report (${path}): ${parsed.error.issues[0]?.message ?? "it isn't the agent's"}.`,
    {
      hint: `Remove ${path} in the panel's File Manager: the agent writes it again within a minute. Then run \`opscrew provision\` again.`,
    },
  );
}

/** Why the account can't run the agent, and what to do. */
interface ReportMisfit {
  reason: string;
  fix: string;
}

/**
 * What the report shows the account lacks for the agent (plan 2): a tool it uses (`mysqldump` only
 * for an app with a database), its own key, or GitHub over SSH.
 */
export function reportMisfit(
  report: AgentReport,
  input: { database: boolean },
): ReportMisfit | undefined {
  const needed = TOOLS.filter((tool) => tool !== "mysqldump" || input.database);
  const missing = needed.filter((tool) => !report.tools[tool]);
  if (missing.length > 0) {
    return {
      reason: `the account has no ${listText(missing)}, which OpsCrew's agent needs to deploy`,
      fix: `Ask your host for ${listText(missing)} in the account's shell and cron jobs, then run \`opscrew provision\` again.`,
    };
  }
  if (report.publicKey === "") {
    return {
      reason: "the agent couldn't make its read-only GitHub key",
      fix: "Run `opscrew logs` to see why, then run `opscrew provision` again.",
    };
  }
  if (!report.github.port22 && !report.github.port443) {
    return {
      reason:
        "the account can't reach GitHub over SSH, on port 22 or on ssh.github.com's port 443, so the agent can't fetch releases",
      fix: "Ask your host to allow outgoing SSH from the account to github.com (port 22) or ssh.github.com (port 443), then run `opscrew provision` again.",
    };
  }
  return undefined;
}

/** How long OpsCrew waits for the agent's first report: 3 minutes, three runs of its cron line. */
const REPORT_WAIT_MS = 3 * 60 * 1000;
const POLL_MS = 10_000;

/**
 * The agent's report in `<folder>/state/report`, waited for up to 3 minutes.
 * @throws OpsCrewError `PROVIDER_ERROR` when it doesn't come: the agent's cron line may be missing.
 */
export async function waitForReport(
  files: HostingFiles,
  folder: string,
  { sleep }: WaitOptions,
): Promise<AgentReport> {
  const path = `${folder}/state/report`;
  for (let attempt = 0; attempt * POLL_MS <= REPORT_WAIT_MS; attempt++) {
    if (attempt > 0) await sleep(POLL_MS);
    const text = await files.readFile(path);
    if (text !== undefined) return parseAgentReport(text, path);
  }
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    "OpsCrew's agent on the hosting account didn't write its first report within 3 minutes. Its cron line may be missing, or cron may be off for the account. The agent and its line are recorded; nothing else was made.",
    {
      hint: `Check in the panel's cron jobs that the line running ~/${folder}/agent.sh every minute is there and that cron runs for the account, then run \`opscrew provision\` again. \`opscrew destroy\` removes the agent.`,
    },
  );
}
