/**
 * The interview's follow-ups for a hosting account (feature 027, US1 scenario 1, US3; plan 7, 10):
 * which panel answers, found without asking; the hostname among the names the account allows,
 * which becomes the app's domain (`dns.domain`); and for an SFTP host, its host key read with
 * `ssh-keyscan` and confirmed, the folder OpsCrew deploys into and the path PHP sees for it; for a
 * panel without file calls (Plesk) given SFTP access too, that SFTP host's key confirmed the same way.
 * Nothing on the account changes here.
 */
import type { HostingFacts } from "@opscrew/contracts";
import {
  listText,
  normalizeHostName,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
} from "@opscrew/core";
import { FqdnSchema, type Question } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { connectPanel, HOSTING_VARS_HINT, hostingReach, SFTP_HOST_VAR } from "../hosting/panels";
import {
  type HostingRecord,
  readHostingRecord,
  type SftpRecord,
  updateHostingRecord,
} from "../hosting/record";
import { requireSftpLogin, sftpLogin } from "../hosting/sftp";
import {
  HOST_KEY_FINGERPRINT,
  hostKeyFingerprint,
  keysFor,
  knownHostsName,
  type ScannedHostKey,
  scanHostKeys,
  writeKnownHost,
} from "../shared";
import { FIX_ANSWERS_HINT, type FollowUps, isBlank, portAnswer, withDefault } from "./follow-ups";
import type { InterviewAnswers } from "./questions";

/** The follow-up answers for a hosting account (`hosting.<field>` in answers files). */
export const HOSTING_FIELDS = ["hostname", "port", "hostKey", "folder", "phpPath"] as const;
/** One follow-up answer for a hosting account. */
export type HostingField = (typeof HOSTING_FIELDS)[number];

/** A follow-up question for a hosting account (same shape as a {@link Question}). */
export interface HostingQuestion extends Omit<Question, "id"> {
  id: `hosting.${HostingField}`;
}

/** What the interview learned about the hosting account. */
export interface HostingAnswers {
  /** The hostname the account serves the app on: the requirements' `domain`. */
  hostname: string;
  /** `.opscrew/hosting.json` as the interview leaves it: how OpsCrew reaches the account. */
  record: HostingRecord;
  /**
   * An SFTP host's key the user confirmed, pinned in OpsCrew's known_hosts file: an SFTP-only
   * host's, or the one of a panel without file calls (Plesk) that OpsCrew reaches over SFTP.
   */
  hostKey?: { host: string; port: number } & Pick<ScannedHostKey, "type" | "key">;
}

/** Options of {@link hostingAnswers}. */
export interface HostingInterviewOptions {
  /** Asks the follow-up questions, only when the answers hold none. */
  askHosting?: (questions: HostingQuestion[]) => Promise<InterviewAnswers>;
  /** The domain the interview's own question was answered with: the hostname's default. */
  domain?: string;
}

/** A folder as SFTP shows it: no newline, no `..`, never starting with `-`. */
const SFTP_FOLDER = /^(?!-)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]+$/;
/** An absolute path PHP sees, with no newline and no `..`. */
const PHP_PATH = /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n]*$/;

/**
 * The follow-ups for the hosting account the environment reaches (`hostingReach`): a panel's, or
 * an SFTP host's. The answers given (`given`) win; otherwise `options.askHosting` asks them.
 * Throws `OpsCrewError("INVALID_INPUT")` naming each missing or invalid answer; nothing is written.
 */
export async function hostingAnswers(
  deps: Pick<
    PhaseDeps,
    "paths" | "env" | "fetch" | "redactor" | "runner" | "approvals" | "interactive"
  >,
  given: Pick<FollowUps<HostingField>, "values" | "unknown">,
  options: HostingInterviewOptions = {},
): Promise<HostingAnswers> {
  if (given.unknown.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${given.unknown.join(", ")}: not a known answer (use ${HOSTING_FIELDS.map((f) => `hosting.${f}`).join(", ")}).`,
      { hint: FIX_ANSWERS_HINT },
    );
  }
  const reach = hostingReach(deps.env);
  if (reach === undefined) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      "You chose a hosting account, but OpsCrew can't reach one: its variables aren't set.",
      {
        hint: `${HOSTING_VARS_HINT} Then run \`opscrew interview\` again.`,
      },
    );
  }
  const previous = await readHostingRecord(deps.paths);
  return reach === "panel"
    ? panelAnswers(deps, given, options, previous)
    : sftpAnswers(deps, given, options, previous);
}

/** Asks `questions` when no follow-up was given and there is someone to ask. */
async function ask(
  given: Pick<FollowUps<HostingField>, "values">,
  options: HostingInterviewOptions,
  questions: HostingQuestion[],
): Promise<Partial<Record<HostingField, unknown>>> {
  if (Object.keys(given.values).length > 0 || options.askHosting === undefined) return given.values;
  const answers = await options.askHosting(questions);
  const values: Partial<Record<HostingField, unknown>> = {};
  for (const field of HOSTING_FIELDS) {
    const answer = answers[`hosting.${field}`];
    if (answer !== undefined) values[field] = answer;
  }
  return values;
}

const text = (value: unknown) => (isBlank(value) ? undefined : String(value).trim());

/** The account a record reaches: the panel's host and user, else the SFTP host and user. */
function accountOf(record: HostingRecord): string {
  const { panel, sftp } = record;
  return panel !== undefined
    ? `panel ${new URL(panel.url).hostname} ${panel.user}`
    : `sftp ${sftp?.host} ${sftp?.user}`;
}

/** Stops when the record lists objects OpsCrew made on another account than the one now reached. */
function requireSameAccount(previous: HostingRecord | undefined, next: HostingRecord): void {
  if (previous === undefined || previous.objects.length === 0) return;
  if (accountOf(previous) === accountOf(next)) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    "OpsCrew made objects for this app on another hosting account than the one your variables reach now, and its record lists them. Nothing was written.",
    {
      hint: "Run `opscrew destroy` with the variables set back to that account first, so nothing OpsCrew made is left behind. Then run `opscrew interview` again.",
    },
  );
}

/** The hostname answer, checked against the account's names when there is an account to read. */
function hostnameAnswer(
  value: unknown,
  account: HostingFacts | undefined,
  previous: HostingRecord | undefined,
): string {
  const answer = text(value);
  if (answer === undefined) {
    throw new OpsCrewError("INVALID_INPUT", "hosting.hostname (the app's hostname) is missing.", {
      hint: FIX_ANSWERS_HINT,
    });
  }
  const hostname = normalizeHostName(answer.replace(/^https?:\/\//i, "").replace(/[/:].*$/, ""));
  if (!FqdnSchema.safeParse(hostname).success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "hosting.hostname: write a hostname such as app.example.com.",
      { hint: FIX_ANSWERS_HINT },
    );
  }
  if (account === undefined) return hostname;
  const made = (previous?.objects ?? []).some(
    (object) => object.kind === "hostname" && object.key === hostname,
  );
  if (!made && account.domains.some((domain) => domain.name === hostname)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `hosting.hostname: the account already serves ${hostname}, and OpsCrew never takes over a hostname it didn't make.`,
      {
        hint: `Choose a new subdomain of one of the account's domains (${listText(ownDomains(account))}), or a domain of yours the account doesn't serve yet.`,
      },
    );
  }
  return hostname;
}

/** The account's own domains, which a new hostname may be a subdomain of. */
function ownDomains(account: HostingFacts): string[] {
  return account.domains.filter((domain) => domain.kind !== "subdomain").map((d) => d.name);
}

/** A panel's follow-ups: the panel found and read, then the hostname. */
async function panelAnswers(
  deps: Parameters<typeof hostingAnswers>[0],
  given: Pick<FollowUps<HostingField>, "values">,
  options: HostingInterviewOptions,
  previous: HostingRecord | undefined,
): Promise<HostingAnswers> {
  const { panel, url, user } = await connectPanel(deps);
  const account = await panel.inspect();
  const domains = ownDomains(account);
  const example = domains[0] === undefined ? "app.example.com" : `app.${domains[0]}`;
  const values = await ask(given, options, [
    {
      id: "hosting.hostname",
      prompt: "Which hostname should the app answer on?",
      help: `A new subdomain of one of the account's domains (${listText(domains)}), such as ${example}, or a domain of yours the account doesn't serve yet, which OpsCrew adds as an addon domain. OpsCrew never takes over a hostname that exists.`,
      kind: "text",
      ...withDefault(options.domain),
      required: true,
    },
  ]);
  const hostname = hostnameAnswer(values.hostname ?? options.domain, account, previous);
  const record: HostingRecord = {
    schemaVersion: 1,
    panel: { kind: panel.kind, url, user },
    objects: [],
  };
  requireSameAccount(previous, record);
  // A panel whose API has no file calls (Plesk's): its files go over SFTP on port 22 when the
  // user gives SFTP access, so its host key is confirmed now, as an SFTP-only host's is.
  const hostKey =
    sftpLogin(deps.env) !== undefined && !panel.operations.has("writeFile")
      ? await panelSftpKey(deps, given.values.hostKey)
      : undefined;
  return {
    hostname,
    record: { ...record, objects: previous?.objects ?? [] },
    ...(hostKey !== undefined ? { hostKey } : {}),
  };
}

/** `hosting.hostKey`, checked: a SHA-256 fingerprint, or undefined when not answered. */
function fingerprintAnswer(value: unknown): string | undefined {
  const fingerprint = text(value);
  if (fingerprint !== undefined && !HOST_KEY_FINGERPRINT.test(fingerprint)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "hosting.hostKey: write the host key's SHA-256 fingerprint, such as SHA256: followed by 43 letters, digits, + or /.",
      { hint: FIX_ANSWERS_HINT },
    );
  }
  return fingerprint;
}

/**
 * The key of the SFTP host a panel's files go over (port 22), confirmed as an SFTP-only host's is:
 * `hosting.hostKey`, else the key pinned earlier in OpsCrew's known_hosts file, else the user's
 * approval in a terminal.
 */
async function panelSftpKey(
  deps: Parameters<typeof hostingAnswers>[0],
  answer: unknown,
): Promise<NonNullable<HostingAnswers["hostKey"]>> {
  const { host } = requireSftpLogin(deps.env);
  const port = 22;
  const known = (await readTextIfExists(deps.paths.files.knownHosts)) ?? "";
  const pinned = keysFor(known, knownHostsName(host, port))
    .map((key) => hostKeyFingerprint(key.split(" ")[1] ?? ""))
    .at(0);
  const given = fingerprintAnswer(answer);
  const key = await confirmHostKey(deps, {
    host,
    port,
    ...(given !== undefined ? { given } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
  });
  return { host, port, type: key.type, key: key.key };
}

/** An SFTP host's follow-ups: the hostname, port, folder and PHP's path, then its host key. */
async function sftpAnswers(
  deps: Parameters<typeof hostingAnswers>[0],
  given: Pick<FollowUps<HostingField>, "values">,
  options: HostingInterviewOptions,
  previous: HostingRecord | undefined,
): Promise<HostingAnswers> {
  const { host, user } = requireSftpLogin(deps.env);
  const before = previous?.sftp?.host === host ? previous.sftp : undefined;
  const values = await ask(given, options, [
    {
      id: "hosting.hostname",
      prompt: "Which hostname will serve the app?",
      help: "You point it at the app's folder in your host's panel: OpsCrew can't make it over SFTP.",
      kind: "text",
      ...withDefault(options.domain),
      required: true,
    },
    {
      id: "hosting.port",
      prompt: "Which port does your host take SFTP on?",
      help: "Usually 22; your host's panel or welcome email names it.",
      kind: "text",
      default: String(before?.port ?? 22),
      required: true,
    },
    {
      id: "hosting.folder",
      prompt: "Which folder should OpsCrew deploy the app into?",
      help: "As SFTP shows it, for example opscrew. OpsCrew keeps the app's releases, settings and state there, so choose one outside the web root.",
      kind: "text",
      default: before?.folder ?? "opscrew",
      required: true,
    },
    {
      id: "hosting.phpPath",
      prompt: "What is that folder's full path as your host's PHP sees it?",
      help: "For example /home/you/opscrew. On a chrooted SFTP account it differs from what SFTP shows; your host's panel shows the home folder's full path.",
      kind: "text",
      ...withDefault(before?.phpPath),
      required: true,
    },
  ]);
  const problems: string[] = [];
  const port = values.port === undefined ? (before?.port ?? 22) : portAnswer(values.port);
  if (port === undefined) problems.push("hosting.port: write a port number from 1 to 65535");
  const folder = text(values.folder) ?? before?.folder;
  if (folder === undefined || !SFTP_FOLDER.test(folder)) {
    problems.push("hosting.folder: write the folder as SFTP shows it, such as opscrew, without ..");
  }
  const phpPath = text(values.phpPath) ?? before?.phpPath;
  if (phpPath === undefined || !PHP_PATH.test(phpPath)) {
    problems.push("hosting.phpPath: write the folder's full path, starting with /, without ..");
  }
  const fingerprint = text(values.hostKey);
  if (fingerprint !== undefined && !HOST_KEY_FINGERPRINT.test(fingerprint)) {
    problems.push(
      "hosting.hostKey: write the host key's SHA-256 fingerprint, such as SHA256: followed by 43 letters, digits, + or /",
    );
  }
  if (problems.length > 0 || port === undefined || folder === undefined || phpPath === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `Some answers about your SFTP host are missing or not valid: ${problems.join("; ")}.`,
      { hint: FIX_ANSWERS_HINT },
    );
  }
  const hostname = hostnameAnswer(values.hostname ?? options.domain, undefined, previous);
  const pinned = before?.port === port ? before.hostKey : undefined;
  const key = await confirmHostKey(deps, { host, port, given: fingerprint, pinned });
  const sftp: SftpRecord = { host, port, user, hostKey: key.fingerprint, folder, phpPath };
  const record: HostingRecord = { schemaVersion: 1, sftp, objects: [] };
  requireSameAccount(previous, record);
  return {
    hostname,
    record: { ...record, objects: previous?.objects ?? [] },
    hostKey: { host, port, type: key.type, key: key.key },
  };
}

/** What to check on the host, for every host key prompt. */
const CHECK_ON_HOST =
  "Compare it with the fingerprint your host shows (its panel, its support, or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` where you have a shell).";

/**
 * The SFTP host's key, read with `ssh-keyscan` and confirmed: the fingerprint answered as
 * `hosting.hostKey`, else the one pinned earlier, else the user's approval in a terminal. A key that
 * differs from the pinned one stops unless the new fingerprint is answered.
 */
async function confirmHostKey(
  deps: Pick<PhaseDeps, "runner" | "approvals" | "interactive">,
  input: { host: string; port: number; given?: string; pinned?: string },
): Promise<ScannedHostKey> {
  const { host, port } = input;
  const where = `${host} (port ${port})`;
  const keys = await scanHostKeys({ host, port, runner: deps.runner });
  const first = keys[0];
  if (first === undefined) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not reach SFTP at ${where}, so it could not read its host key.`,
      {
        hint: `Check ${SFTP_HOST_VAR} and the port, and that this computer can reach your host, then try again.`,
      },
    );
  }
  const presented = keys.map((key) => `${key.type} ${key.fingerprint}`).join(", ");
  const wanted = input.given ?? input.pinned;
  if (wanted !== undefined) {
    const chosen = keys.find((key) => key.fingerprint === wanted);
    if (chosen !== undefined) return chosen;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      input.given !== undefined
        ? `Your SFTP host at ${where} presented ${presented}, not the fingerprint you answered (${input.given}). OpsCrew changed nothing.`
        : `The host key of your SFTP host at ${where} changed since you confirmed it (confirmed: ${input.pinned}; now: ${presented}). OpsCrew changed nothing.`,
      {
        hint: `${CHECK_ON_HOST} If your host really changed its key, answer its new fingerprint as hosting.hostKey. Otherwise someone may be intercepting the connection.`,
      },
    );
  }
  if (!deps.interactive) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Your SFTP host's key must be confirmed before OpsCrew trusts it. ${where} presents ${first.type} ${first.fingerprint}.`,
      {
        hint: `${CHECK_ON_HOST} If it matches, answer hosting.hostKey: ${first.fingerprint}, or run \`opscrew interview\` in a terminal to confirm it there.`,
      },
    );
  }
  // The title is audited: it names no address (the details, shown only in the terminal, do).
  const decision = await deps.approvals.request({
    kind: "remote-exec",
    title: "Trust the SSH host key of your SFTP host",
    details: [
      `This is OpsCrew's first connection to your SFTP host at ${where}. It presents this host key:`,
      `  ${first.type} ${first.fingerprint}`,
      ...(keys.length > 1
        ? [
            "Other keys it offers:",
            ...keys.slice(1).map((key) => `  ${key.type} ${key.fingerprint}`),
          ]
        : []),
      CHECK_ON_HOST,
      "Approve only if the fingerprints match. OpsCrew then pins the key, and a different key later stops every command.",
    ].join("\n"),
  });
  if (!decision.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      "You did not confirm your SFTP host's key, so OpsCrew recorded nothing.",
      { hint: `${CHECK_ON_HOST} Then run \`opscrew interview\` again and confirm it.` },
    );
  }
  return first;
}

/**
 * Records the interview's answers on this computer: `.opscrew/hosting.json`, and the SFTP host's
 * confirmed key in OpsCrew's known_hosts file.
 */
export async function recordHostingAnswers(
  paths: ProjectPaths,
  answers: HostingAnswers,
): Promise<void> {
  const { hostKey } = answers;
  if (hostKey !== undefined) {
    await writeKnownHost(paths.files.knownHosts, knownHostsName(hostKey.host, hostKey.port), [
      hostKey,
    ]);
  }
  await updateHostingRecord(paths, () => answers.record);
}
