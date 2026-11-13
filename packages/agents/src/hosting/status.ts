/**
 * `opscrew status` for an app on a hosting account with a panel (027 plan 6), read-only: what the
 * agent's `state/status` says (the running release, those kept, the last attempt and its reason),
 * the hostname's certificate, the account's disk left, and for a PHP app on Apache how long a
 * switch takes to reach every PHP process. Also how every command after provision reaches the
 * account.
 */
import type { HostingFiles, HostingPanel } from "@opscrew/contracts";
import { errorText, isUserFacingError, OpsCrewError } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { hasDeployment } from "../shared";
import { hostingAccountLines, readHostingAccount } from "./facts";
import { connectPanel, hostingFiles, PANEL_NAMES } from "./panels";
import { hostingFolder, hostingTarget, hostnameOf } from "./provision-plans";
import { type HostingRecord, readHostingRecord } from "./record";
import { keyValues } from "./requests";
import { reachSftpHost, sftpFilesFromEnv } from "./sftp";

/** What a test gives the hosting commands. */
export interface HostingAccountServices {
  /**
   * The account's files where the panel's API has none (Plesk's); by default the SFTP connector
   * when the user gives SFTP access (`sftpFilesFromEnv`).
   */
  files?: HostingFiles;
}

/** A hosting account as the commands after provision reach it. */
export interface HostingReach {
  record: HostingRecord;
  panel: HostingPanel;
  /** Undefined where the panel's API has no file calls and no other way was given. */
  files: HostingFiles | undefined;
  /** `<user> at <host>`. */
  account: string;
  /** The app's folder from the home folder, `opscrew/<app>-<env>`. */
  folder: string;
  hostname: string;
}

/**
 * The account `opscrew provision` recorded on this computer, through its panel's connector (the
 * token from the environment).
 * @throws OpsCrewError `PHASE_PRECONDITION` without a record of the account's panel.
 */
export async function reachHostingAccount(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: HostingAccountServices = {},
): Promise<HostingReach> {
  const record = await readHostingRecord(deps.paths);
  if (record?.panel === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has no record of the hosting account's panel on this computer (.opscrew/hosting.json), so it can't reach the app there.",
      {
        hint: "Run the command on the computer that ran `opscrew provision`, or on one where .opscrew/ was restored from OpsCrew's recovery copy.",
      },
    );
  }
  const { panel, url, user } = await connectPanel(deps, record.panel);
  return {
    record,
    panel,
    files: hostingFiles(panel, services.files ?? sftpFilesFromEnv(deps)),
    account: `${user} at ${new URL(url).hostname}`,
    folder: hostingFolder(plan),
    hostname: hostnameOf(plan),
  };
}

/**
 * The account's files, or the stop where its panel has no file calls and no SFTP login is set:
 * `what` is what OpsCrew can't do then (`roll the app back`).
 */
export function requireFiles(reach: HostingReach, what: string): HostingFiles {
  if (reach.files !== undefined) return reach.files;
  const name = PANEL_NAMES[reach.panel.kind];
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${name}'s API can't read or write files, so OpsCrew reaches them over SFTP, and OPSCREW_SFTP_HOST, OPSCREW_SFTP_USER and OPSCREW_SFTP_KEY aren't set: it can't ${what}.`,
    {
      hint: "Set them to the account's SFTP login (OPSCREW_SFTP_KEY is your key file's path), then run the command again.",
    },
  );
}

/** A release's id, `<run id>-<attempt>`. */
const RELEASE_ID = /^[1-9][0-9]*-[1-9][0-9]*$/;

const ReleaseOrNone = z.union([z.string().regex(RELEASE_ID), z.literal("")]);

/** `state/status` as the agent writes it (`AGENT_SH`'s `write_status`). */
const AgentStatusSchema = z
  .object({
    running: ReleaseOrNone.default(""),
    previous: ReleaseOrNone.default(""),
    kept: z.string().default(""),
    attempt: ReleaseOrNone.default(""),
    result: z.enum(["deployed", "refused", "failed", ""]).default(""),
    reason: z.string().default(""),
    at: z.string().default(""),
  })
  .transform((status, ctx) => {
    const kept = status.kept === "" ? [] : status.kept.split(",");
    if (kept.some((id) => !RELEASE_ID.test(id))) {
      ctx.addIssue({ code: "custom", message: "kept isn't a list of releases" });
    }
    return {
      ...(status.running === "" ? {} : { running: status.running }),
      ...(status.previous === "" ? {} : { previous: status.previous }),
      kept,
      ...(status.attempt === "" || status.result === ""
        ? {}
        : {
            attempt: {
              release: status.attempt,
              result: status.result,
              ...(status.reason === "" ? {} : { reason: status.reason }),
              at: status.at,
            },
          }),
    };
  });

/** What the agent says of the app's releases. */
export type AgentStatus = z.output<typeof AgentStatusSchema>;

/**
 * The agent's `state/status`, validated; `undefined` before it wrote one (no release yet).
 * @throws OpsCrewError `PROVIDER_ERROR` for a file OpsCrew can't read.
 */
export async function readAgentStatus(
  files: HostingFiles,
  folder: string,
): Promise<AgentStatus | undefined> {
  const text = await files.readFile(`${folder}/state/status`);
  if (text === undefined) return undefined;
  const parsed = AgentStatusSchema.safeParse(keyValues(text));
  if (parsed.success) return parsed.data;
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    `OpsCrew can't read the agent's status on the account (~/${folder}/state/status).`,
    { hint: "`opscrew logs` shows the agent's last lines." },
  );
}

/** Orders release ids newest first, by run id, then attempt. */
export function newestFirst(a: string, b: string): number {
  const [runA = 0, attemptA = 0] = a.split("-").map(Number);
  const [runB = 0, attemptB = 0] = b.split("-").map(Number);
  return runB - runA || attemptB - attemptA;
}

const RESULT_WORDS = { deployed: "deployed", refused: "was refused", failed: "failed" } as const;

/** The status's lines on the releases and the last attempt; `first` says who deploys the first. */
function releaseLines(
  status: AgentStatus | undefined,
  first = "the agent deploys the first one the deploy workflow publishes",
): string[] {
  if (status?.running === undefined) {
    return [
      `Release: none runs yet; ${first}.`,
      ...(status === undefined ? [] : attemptLines(status)),
    ];
  }
  const others = status.kept.filter((id) => id !== status.previous);
  const kept =
    status.previous === undefined
      ? "No earlier release is kept for a rollback."
      : `Kept for a rollback: ${[`${status.previous} (the default)`, ...others].join(", ")}.`;
  return [`Release: ${status.running} runs. ${kept}`, ...attemptLines(status)];
}

function attemptLines(status: AgentStatus): string[] {
  const { attempt } = status;
  if (attempt === undefined) return [];
  const reason = attempt.reason === undefined ? "" : `: ${attempt.reason}`;
  return [
    `Last attempt: release ${attempt.release} ${RESULT_WORDS[attempt.result]} at ${formatUtc(attempt.at)}${reason}.`,
  ];
}

/** The hostname's certificate in a line. */
async function certificateLine(panel: HostingPanel, hostname: string): Promise<string> {
  const name = PANEL_NAMES[panel.kind];
  const certificate = await panel.certificate(hostname);
  if (certificate === undefined) {
    return `Certificate: ${name}'s API doesn't show certificates; check ${hostname}'s in ${name}.`;
  }
  if (certificate.installed) {
    const until =
      certificate.notAfter === undefined
        ? ""
        : `, valid until ${certificate.notAfter.slice(0, 10)}`;
    return `Certificate: ${hostname}'s is installed${until}.`;
  }
  if (certificate.inProgress) return `Certificate: ${name} is issuing ${hostname}'s now.`;
  const problem = certificate.problem === undefined ? "" : ` (${certificate.problem})`;
  return `Certificate: ${hostname} has none yet${problem}; until it has one, the app answers over HTTP.`;
}

/**
 * What `status` shows of an app on a hosting account (027 plan 6), read-only: the account and the
 * app's folder, the running release and those kept, the last attempt and its reason (from the
 * agent's `state/status`), the hostname's certificate, the account's facts with its disk left
 * (`hostingAccountLines`), and for a PHP app on Apache that a switch reaches every PHP process in
 * about 2 minutes (research R16). A part that can't be read says why in its place; nothing is read
 * before provision ran. Redacted.
 */
export async function hostingStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: HostingAccountServices = {},
): Promise<{ lines: string[] }> {
  if (!hasDeployment(plan)) {
    const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
    return {
      lines: [
        `The hosting account isn't set up for the app yet: \`opscrew provision${flags}\` sets it up.`,
      ],
    };
  }
  const note = (what: string, error: unknown) => {
    if (!isUserFacingError(error)) throw error;
    return [`OpsCrew could not read ${what}. ${errorText(error)}`];
  };
  const lines: string[] = [];
  if (hostingTarget(plan).panel === "sftp") {
    try {
      const reach = await reachSftpHost(deps, plan);
      deps.reporter.step("Reading the app on the SFTP host (read-only)");
      lines.push(
        `SFTP host: ${reach.account}; the app is in ${reach.folder}/ and answers on https://${reach.hostname}.`,
        ...releaseLines(
          await readAgentStatus(reach.files, reach.folder),
          "the deploy workflow uploads the first one",
        ),
        `${reach.hostname}, its document root ${reach.documentRoot} and its certificate are yours to manage in your host's panel.`,
      );
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "read the app on the SFTP host (read-only)",
        target: "SFTP host",
        decision: "allow",
      });
    } catch (error) {
      lines.push(...note("the SFTP host", error));
    }
    return { lines: lines.map((line) => deps.redactor.redact(line)) };
  }
  try {
    const reach = await reachHostingAccount(deps, plan, services);
    deps.reporter.step("Reading the app on the hosting account (read-only)");
    lines.push(
      `Hosting account: ${PANEL_NAMES[reach.panel.kind]} account ${reach.account}; the app is in ~/${reach.folder}/ and answers on https://${reach.hostname}.`,
    );
    try {
      lines.push(
        ...releaseLines(await readAgentStatus(requireFiles(reach, "read it"), reach.folder)),
      );
    } catch (error) {
      lines.push(...note("the agent's status", error));
    }
    try {
      lines.push(await certificateLine(reach.panel, reach.hostname));
    } catch (error) {
      lines.push(...note("the certificate", error));
    }
    const account = await readHostingAccount(reach.panel, deps.fetch);
    lines.push(...hostingAccountLines(account));
    if (account.webServer === "Apache" && hostingTarget(plan).app === "php") {
      lines.push(
        "On Apache with PHP-FPM, some requests may still run the release before for about 2 minutes after a deploy or a rollback: OpsCrew turns on opcache.revalidate_path so PHP's code cache follows the switch once PHP's path cache expires, and its checks wait that long.",
      );
    }
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "read the app on the hosting account (read-only)",
      target: "hosting account",
      decision: "allow",
    });
  } catch (error) {
    lines.push(...note("the hosting account", error));
  }
  return { lines: lines.map((line) => deps.redactor.redact(line)) };
}
