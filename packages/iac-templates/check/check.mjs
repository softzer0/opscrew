// OpsCrew's scheduled check. GitHub Actions runs it from .github/workflows/opscrew-check.yml.
//
// It checks what opscrew/check/check.json (next to this file) lists, which OpsCrew generates from
// your plans:
// - each hostname's health path over HTTPS, trying again before it counts a failure;
// - how many days each hostname's certificate has left;
// - each server's disk: over SSH with a key the server lets run only `df`, or on the server's own
//   runner (`node check.mjs --only disk:<server id>`).
//
// A failing check opens a GitHub issue labelled opscrew-check, one per check, and closes it when
// the check passes again. With a webhook set (Slack, Discord or ntfy), the same text is posted
// there when an issue opens or closes. That text holds only fixed sentences, names, hostnames,
// status codes, error codes, days and disk figures: never what a server answered, never an
// address and never a secret.
//
// It needs Node.js 20 or later and nothing else. OpsCrew writes the same file into every
// repository, and `opscrew provision` replaces it.

import { execFile } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { pathToFileURL } from "node:url";

/** The label of every issue the check opens. */
const LABEL = "opscrew-check";

/** The hidden marker that ties an issue to its check's key. */
const MARKER = /<!-- opscrew-check:(\S+) -->/;

/** The key of the warning about GitHub's 60-day rule. */
const INACTIVITY_KEY = "inactivity";

/** GitHub turns scheduled workflows off in a public repository after 60 days without activity. */
const GITHUB_INACTIVITY_DAYS = 60;

/** The check warns from this many days without a commit on. */
const INACTIVITY_WARN_DAYS = 50;

const DAY_MS = 86_400_000;

/** The most each webhook takes: Slack's and Discord's in characters, ntfy's in bytes. */
const WEBHOOK_LIMITS = { slack: 4000, discord: 2000, ntfy: 4096 };

const SEE_MORE =
  "To see more, run `npx opscrew status` and `npx opscrew logs` in this repository, with `--app <key>` and `--env <name>` for an app or environment other than the first app's prod.";

const PAUSE_REASONS = {
  retarget:
    "OpsCrew is moving this app to another server (`opscrew retarget`), and the check skips it until the move is finished.",
  destroyed: "This environment was destroyed (`opscrew destroy`), and the check skips it.",
};

/**
 * Runs the check once and returns the exit code: 0 when it could report everything, 1 when it
 * could not (issues turned off while something fails, GitHub's API or the webhook failing).
 * @param {Record<string, string | undefined>} env the process's environment
 * @param {import("./check.d.mts").CheckIo} io everything the check reads and does outside itself
 * @returns {Promise<number>}
 */
export async function run(env, io) {
  const { config } = io;
  const only = onlyServer(io.argv);
  maskSecrets(env, config, io.log);

  const all = config.environments.flatMap(checksOf);
  const checks = all.filter((check) =>
    only === undefined
      ? check.kind !== "disk" || check.server.via === "github"
      : check.kind === "disk" && check.server.id === only,
  );
  if (only !== undefined && checks.length === 0) {
    io.log(
      "::error::--only takes disk:<server id>, with the id of a server opscrew/check/check.json lists. Run `npx opscrew provision` to render the workflow again.",
    );
    return 1;
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    io.log(
      "::error::GITHUB_TOKEN and GITHUB_REPOSITORY must be set: run the check in GitHub Actions.",
    );
    return 1;
  }
  if (config.webhook !== undefined && !env.OPSCREW_CHECK_WEBHOOK) {
    io.log(
      `::warning::check.json names a ${config.webhook} webhook, but the secret OPSCREW_CHECK_WEBHOOK is not set, so nothing is posted there.`,
    );
  }
  const paused = readPaused(env.OPSCREW_CHECK_PAUSED, io.log);

  // The keys this job opens and closes issues for: the main job everything but the disks that
  // jobs on self-hosted runners check; such a job only its server's disk.
  const managed = checks.map((check) => check.key);
  if (only === undefined) managed.push(INACTIVITY_KEY);
  /** Every key check.json still has: an open issue for any other is closed. */
  const known = new Set([INACTIVITY_KEY, ...all.map((check) => check.key)]);

  /** @type {Map<string, Failure | null>} a failure, null for a pass; absent when unknown */
  const results = new Map();
  await Promise.all(
    checks
      .filter((check) => paused[check.environment.key] === undefined)
      .map(async (check) => {
        const result = await runCheck(check, config.thresholds, env, io);
        if (result !== undefined) results.set(check.key, result);
      }),
  );

  const report = new Reporter(env, io);
  let repository;
  try {
    repository = await report.github("GET", "");
  } catch (error) {
    io.log(`::error::${errorText(error)} The check could not report its results.`);
    await writeSummary(io, results, paused, managed, false);
    return 1;
  }
  if (only === undefined) {
    const inactivity = await checkInactivity(repository, report, io);
    if (inactivity !== undefined) results.set(INACTIVITY_KEY, inactivity);
  }

  let open;
  if (repository.has_issues !== false) {
    try {
      await report.ensureLabel();
      open = await report.openIssues();
    } catch (error) {
      if (error.status !== 410) {
        io.log(`::error::${errorText(error)}`);
        await writeSummary(io, results, paused, managed, false);
        return 1;
      }
    }
  }
  if (open === undefined) {
    // Issues are off: the failed run and the webhook are all that can tell anyone.
    io.log(
      "::error::Issues are turned off in this repository, so the check cannot open any. Turn them on in Settings > General > Features.",
    );
    for (const key of managed) {
      const failure = results.get(key);
      if (failure) {
        await report.post({ title: failure.title, text: openingText(failure, io.now()) }, true);
      }
    }
    await writeSummary(io, results, paused, managed, true);
    return managed.some((key) => results.get(key)) || !report.ok ? 1 : 0;
  }

  for (const key of managed) {
    const issue = open.get(key);
    const pause = paused[environmentKey(key)];
    if (pause !== undefined) {
      if (issue) {
        await report.close(issue, key, `Closed while the check is paused. ${pauseText(pause)}`);
      }
      continue;
    }
    if (!results.has(key)) continue;
    const failure = results.get(key);
    if (failure && !issue) await report.open(key, failure);
    else if (failure && issue.title !== failure.title) await report.changed(issue, failure);
    else if (!failure && issue) {
      const lasted = duration(io.now().getTime() - Date.parse(issue.created_at));
      await report.close(issue, key, `Resolved after ${lasted}.`, "completed");
    }
  }
  if (only === undefined) {
    for (const [key, issue] of open) {
      if (!known.has(key)) {
        await report.close(
          issue,
          key,
          "Closed: the check no longer checks this, as opscrew/check/check.json does not list it any more.",
        );
      }
    }
  }
  await writeSummary(io, results, paused, managed, false);
  return report.ok ? 0 : 1;
}

/**
 * @typedef {object} Failure
 * @property {string} title the issue's title: a new title is a change, which gets a comment
 * @property {string} what what failed
 * @property {string} hint where to look next
 */

/** The server id of `--only disk:<server id>` (empty for another value), undefined without it. */
function onlyServer(argv) {
  const at = argv.indexOf("--only");
  if (at < 0) return undefined;
  const value = argv[at + 1] ?? "";
  return value.startsWith("disk:") ? value.slice("disk:".length) : "";
}

/**
 * Tells GitHub to hide each secret value in the job's log, line by line, and the server's address
 * and host keys inside each server secret.
 */
function maskSecrets(env, config, log) {
  const values = [
    env.OPSCREW_CHECK_SSH_KEY,
    env.OPSCREW_CHECK_WEBHOOK,
    env.OPSCREW_CHECK_NTFY_TOKEN,
  ];
  const secrets = new Set(
    config.environments.flatMap(serversOf).flatMap((server) => server.secret ?? []),
  );
  for (const secret of secrets) {
    values.push(env[secret]);
    for (const entry of parseEntries(env[secret])) values.push(entry.host, entry.knownHosts);
  }
  for (const value of values) {
    for (const line of (value ?? "").split("\n")) {
      if (line.trim() !== "") log(`::add-mask::${line.trim()}`);
    }
  }
}

/** The paused environments, from the repository variable OPSCREW_CHECK_PAUSED. */
function readPaused(text, log) {
  if (text === undefined || text.trim() === "") return {};
  try {
    const value = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
  } catch {
    // Reported below.
  }
  log(
    "::warning::The repository variable OPSCREW_CHECK_PAUSED is not a JSON object, so no environment is paused. Fix it or delete it.",
  );
  return {};
}

/** The sentence a paused environment's issues are closed with. */
function pauseText(pause) {
  const reason = pause?.reason;
  return Object.hasOwn(PAUSE_REASONS, reason)
    ? PAUSE_REASONS[reason]
    : "OpsCrew paused the check for this environment.";
}

/** The checks of one environment of check.json, each with its key. */
function checksOf(environment) {
  const checks = environment.hosts.flatMap((host) => [
    { key: `${environment.key}/https/${host.hostname}`, kind: "https", environment, host },
    {
      key: `${environment.key}/certificate/${host.hostname}`,
      kind: "certificate",
      environment,
      host,
    },
  ]);
  for (const server of serversOf(environment)) {
    checks.push({ key: `${environment.key}/disk/${server.id}`, kind: "disk", environment, server });
  }
  return checks;
}

/** The servers of one environment of check.json whose disks are checked: the app's, then the others. */
function serversOf(environment) {
  return [
    ...(environment.server === undefined ? [] : [environment.server]),
    ...(environment.extraServers ?? []),
  ];
}

/** `<app>/<env>` of a check's key. */
function environmentKey(key) {
  return key.split("/").slice(0, 2).join("/");
}

/** `<app> (<env>)` of a check's key or an environment's. */
function appLabel(key) {
  const [app, environment] = key.split("/");
  return `${app} (${environment})`;
}

/** What a key names, for the text of a closed issue. */
function describe(key) {
  if (key === INACTIVITY_KEY) return "GitHub's 60-day rule for scheduled checks";
  const [, , kind, target] = key.split("/");
  const what = { https: "HTTPS", certificate: "the certificate", disk: "the disk" }[kind] ?? kind;
  return `${appLabel(key)}, ${what} on ${target}`;
}

/** @returns {Promise<Failure | null | undefined>} */
function runCheck(check, thresholds, env, io) {
  if (check.kind === "https") return checkHttps(check, thresholds, io);
  if (check.kind === "certificate") return checkCertificate(check, thresholds, io);
  return checkDisk(check, thresholds, env, io);
}

/** The health path over HTTPS: any status below 400 passes, after up to `tries` tries. */
async function checkHttps(check, t, io) {
  const { hostname, healthPath } = check.host;
  const url = `https://${hostname}${healthPath}`;
  let outcome;
  for (let attempt = 1; attempt <= t.tries; attempt++) {
    if (attempt > 1) await io.sleep(t.retrySeconds * 1000);
    outcome = await httpsOnce(url, t.timeoutSeconds, io.fetch);
    io.log(`${url}: ${outcome.text} (try ${attempt} of ${t.tries})`);
    if (outcome.status !== undefined && outcome.status < 400) return null;
  }
  const label = appLabel(check.key);
  return {
    title:
      outcome.status === undefined
        ? `OpsCrew check: ${label} does not answer on ${hostname}`
        : `OpsCrew check: ${label} answers HTTP ${outcome.status} on ${hostname}`,
    what: `${url} failed ${t.tries} tries, ${t.retrySeconds} seconds apart. The last try got ${outcome.text}.`,
    hint: SEE_MORE,
  };
}

/** One request, which never reads the answer's body. */
async function httpsOnce(url, timeoutSeconds, fetch) {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "opscrew-check" },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    await response.body?.cancel();
    return { status: response.status, text: `HTTP ${response.status}` };
  } catch (error) {
    const code = errorCode(error);
    return {
      text: code === "TIMEOUT" ? `no answer within ${timeoutSeconds} seconds` : `the error ${code}`,
    };
  }
}

/** The certificate's days left; unknown when the host can't be reached (HTTPS covers that). */
async function checkCertificate(check, t, io) {
  const { hostname } = check.host;
  let days;
  try {
    days = await io.tlsDaysLeft(hostname, t.timeoutSeconds * 1000);
  } catch (error) {
    io.log(`${hostname}: the certificate could not be read (${errorCode(error)}).`);
    return undefined;
  }
  io.log(`${hostname}: the certificate has ${plural(days, "day")} left.`);
  if (days >= t.certDays) return null;
  const label = appLabel(check.key);
  return {
    title:
      days < 0
        ? `OpsCrew check: ${label} certificate has expired on ${hostname}`
        : `OpsCrew check: ${label} certificate expires within ${t.certDays} days on ${hostname}`,
    what:
      days < 0
        ? `The certificate of ${hostname} expired ${plural(-days, "day")} ago.`
        : `The certificate of ${hostname} expires in ${plural(days, "day")}.`,
    hint: "Certificates are normally renewed 30 days before they expire, so this one's renewal is failing. To see why, run `npx opscrew status` in this repository; on a server, `npx opscrew logs --service edge` shows the reverse proxy's lines.",
  };
}

/** The server's disk, from `df -P -B1 /` there: over SSH, or here on the server's own runner. */
async function checkDisk(check, t, env, io) {
  const { server } = check;
  let output;
  try {
    if (server.via === "own-runner") {
      output = await io.df();
    } else {
      const name = server.name ?? "app";
      const reach = parseEntries(env[server.secret]).find((entry) => entry.id === name);
      const key = env.OPSCREW_CHECK_SSH_KEY;
      if (reach === undefined || !key) {
        io.log(
          `::warning::The disk of ${server.id} was not checked: ${reach === undefined ? `the secret ${server.secret} is missing, has no entry for the server ${name} or is not in the form OpsCrew writes` : "the secret OPSCREW_CHECK_SSH_KEY is missing"}. Run \`npx opscrew provision\` for this environment.`,
        );
        return undefined;
      }
      output = await io.ssh(reach, key);
    }
  } catch (error) {
    io.log(`::warning::The disk of ${server.id} could not be read (${errorCode(error)}).`);
    return undefined;
  }
  const disk = parseDf(output);
  if (disk === undefined) {
    io.log(`::warning::The disk of ${server.id} answered in a form the check cannot read.`);
    return undefined;
  }
  io.log(`${server.id}: the disk is ${disk.percent}% full.`);
  if (disk.percent < t.diskWarn) return null;
  const threshold = disk.percent >= t.diskHigh ? t.diskHigh : t.diskWarn;
  return {
    title: `OpsCrew check: ${appLabel(check.key)} disk over ${threshold}% full on ${server.id}`,
    what: `The disk of the server ${server.id} is ${disk.percent}% full: ${gigabytes(disk.free)} free of ${gigabytes(disk.total)}.`,
    hint: "Old container images and logs usually fill it. To see more, run `npx opscrew status` in this repository; on the server, `docker system df` shows what Docker keeps.",
  };
}

/** The sizes in `df -P -B1` output's last line, or undefined when it has none. */
function parseDf(output) {
  const fields = output.trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
  if (fields.length < 6) return undefined;
  const [total, used, free] = fields.slice(-5, -2).map(Number);
  if (![total, used, free].every(Number.isFinite) || used + free <= 0) return undefined;
  return { total, free, percent: Math.ceil((used * 100) / (used + free)) };
}

/**
 * A server secret (`<prefix>CHECK_SERVER`): a JSON list with one entry per server of the
 * environment, each its name in the plan (`id`), host, SSH port, user and known-hosts line(s).
 * The entries in that form; none when the secret is absent or in another form.
 */
function parseEntries(text) {
  if (!text) return [];
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry) =>
      typeof entry?.id === "string" &&
      typeof entry.host === "string" &&
      Number.isInteger(entry.port) &&
      typeof entry.user === "string" &&
      typeof entry.knownHosts === "string",
  );
}

/**
 * GitHub's 60-day rule: in a public repository, a failure from 50 days without a commit on the
 * default branch on. Unknown when the commit can't be read.
 */
async function checkInactivity(repository, report, io) {
  if (repository.private !== false) return null;
  const branch = repository.default_branch;
  let date;
  try {
    const commit = await report.github("GET", `/commits/${encodeURIComponent(branch)}`);
    date = Date.parse(commit.commit.committer.date);
  } catch (error) {
    io.log(`::warning::${errorText(error)} The last commit's date is unknown.`);
    return undefined;
  }
  const days = Math.floor((io.now().getTime() - date) / DAY_MS);
  if (days < INACTIVITY_WARN_DAYS) return null;
  return {
    title: `OpsCrew check: GitHub turns this check off after ${GITHUB_INACTIVITY_DAYS} days without activity`,
    what: `This repository is public, and the last commit on ${branch} is ${days} days old. GitHub turns scheduled workflows off in a public repository after ${GITHUB_INACTIVITY_DAYS} days without activity, and this check would then stop.`,
    hint: `To keep it running, push any commit to ${branch}. If GitHub has turned it off already, open the repository's Actions tab, choose "OpsCrew check" and select "Enable workflow"; \`npx opscrew status\` shows the check's state.`,
  };
}

/** Opens, comments on and closes issues, and posts to the webhook; `ok` turns false on a failure. */
class Reporter {
  constructor(env, io) {
    this.env = env;
    this.io = io;
    this.ok = true;
    this.api = `${env.GITHUB_API_URL || "https://api.github.com"}/repos/${env.GITHUB_REPOSITORY}`;
  }

  /** Calls GitHub's REST API for this repository; throws a GitHubError on any failure. */
  async github(method, path, body) {
    let response;
    try {
      response = await this.io.fetch(`${this.api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.env.GITHUB_TOKEN}`,
          "user-agent": "opscrew-check",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new GitHubError(`GitHub's API could not be reached (${errorCode(error)}).`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const what = `${method} ${path.split("?")[0] || "/"}`;
      throw new GitHubError(
        `GitHub's API answered HTTP ${response.status} to ${what}.`,
        response.status,
      );
    }
    return response.status === 204 ? undefined : response.json();
  }

  /** Creates the label; one that exists already answers 422. */
  async ensureLabel() {
    try {
      await this.github("POST", "/labels", {
        name: LABEL,
        color: "d93f0b",
        description: "Opened and closed by OpsCrew's scheduled check",
      });
    } catch (error) {
      if (error.status !== 422) throw error;
    }
  }

  /** The open issues with the label, by their key, read once: every page of 100. */
  async openIssues() {
    const issues = new Map();
    for (let page = 1; ; page++) {
      const items = await this.github(
        "GET",
        `/issues?labels=${LABEL}&state=open&per_page=100&page=${page}`,
      );
      for (const item of items) {
        const key = item.pull_request ? undefined : MARKER.exec(item.body ?? "")?.[1];
        if (key !== undefined && !issues.has(key)) issues.set(key, item);
      }
      if (items.length < 100) return issues;
    }
  }

  async open(key, failure) {
    await this.guard(async () => {
      const now = this.io.now();
      const body = `<!-- opscrew-check:${key} -->\n${openingText(failure, now)}\n\nThe check closes this issue when it passes again.\n`;
      const issue = await this.github("POST", "/issues", {
        title: failure.title,
        body,
        labels: [LABEL],
      });
      this.io.log(`Opened issue #${issue.number}: ${failure.title}`);
      const text = openingText(failure, now, this.issueRef(issue));
      await this.post({ title: failure.title, text }, true);
    });
  }

  /** What fails changed: a comment, and the title that says what fails now. */
  async changed(issue, failure) {
    await this.guard(async () => {
      await this.github("POST", `/issues/${issue.number}/comments`, {
        body: `What fails changed. ${failure.what}\n\n${failure.hint}`,
      });
      await this.github("PATCH", `/issues/${issue.number}`, { title: failure.title });
      this.io.log(`Commented on issue #${issue.number}: ${failure.title}`);
    });
  }

  async close(issue, key, sentence, reason = "not_planned") {
    await this.guard(async () => {
      await this.github("POST", `/issues/${issue.number}/comments`, { body: sentence });
      await this.github("PATCH", `/issues/${issue.number}`, {
        state: "closed",
        state_reason: reason,
      });
      this.io.log(`Closed issue #${issue.number}: ${sentence}`);
      const title = `OpsCrew check: ${reason === "completed" ? "resolved" : "closed"}, ${describe(key)}`;
      await this.post({ title, text: `${sentence}\n${this.issueRef(issue)}` }, false);
    });
  }

  /** Runs one issue's change; a failing call is reported and the run goes on. */
  async guard(change) {
    try {
      await change();
    } catch (error) {
      this.ok = false;
      this.io.log(`::error::${errorText(error)}`);
    }
  }

  issueRef(issue) {
    return `Issue #${issue.number} in ${this.env.GITHUB_REPOSITORY}.`;
  }

  /** Posts `message` to the webhook check.json names, cut to its limit; never prints its address. */
  async post(message, opening) {
    const kind = this.io.config.webhook;
    const url = this.env.OPSCREW_CHECK_WEBHOOK;
    if (kind === undefined || !url) return;
    const text = `${message.title}\n${message.text}`;
    let init;
    if (kind === "slack") {
      init = json({ text: cut(text, WEBHOOK_LIMITS.slack) });
    } else if (kind === "discord") {
      init = json({ content: cut(text, WEBHOOK_LIMITS.discord), allowed_mentions: { parse: [] } });
    } else {
      const token = this.env.OPSCREW_CHECK_NTFY_TOKEN;
      init = {
        headers: {
          title: message.title,
          priority: opening ? "4" : "3",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: cutBytes(message.text, WEBHOOK_LIMITS.ntfy),
      };
    }
    let why;
    try {
      const response = await this.io.fetch(url, {
        method: "POST",
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (response.ok) return;
      why = `HTTP ${response.status}`;
    } catch (error) {
      why = errorCode(error);
    }
    this.ok = false;
    this.io.log(`::error::The ${kind} webhook failed (${why}).`);
  }
}

/** A GitHub API failure: `status` is the HTTP status, absent when GitHub wasn't reached. */
class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The text of a new issue, or of its webhook post with `ref`, where to find the issue. */
function openingText(failure, now, ref) {
  const since = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `${failure.what}\n\nSince ${since}.\n\n${failure.hint}${ref === undefined ? "" : `\n${ref}`}`;
}

function json(value) {
  return { headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

/** `text` cut to `limit` characters. */
function cut(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** `text` cut to `limit` bytes of UTF-8, never inside a character. */
function cutBytes(text, limit) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  let end = limit - 3; // room for "…"
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${new TextDecoder().decode(bytes.slice(0, end))}…`;
}

/** The job summary: each result, and what the check could not do. */
async function writeSummary(io, results, paused, managed, issuesOff) {
  if (io.summary === undefined) return;
  const lines = ["## OpsCrew check", ""];
  if (issuesOff) {
    lines.push(
      "Issues are turned off in this repository, so the check could not open any. Turn them on in Settings > General > Features.",
      "",
    );
  }
  for (const key of managed) {
    const pause = paused[environmentKey(key)];
    const failure = results.get(key);
    let state = "not checked (see the log)";
    if (pause !== undefined) state = `paused: ${pauseText(pause)}`;
    else if (failure) state = `failed: ${failure.what}`;
    else if (failure === null) state = "passed";
    lines.push(`- ${key}: ${state}`);
  }
  await io.summary(`${lines.join("\n")}\n`);
}

/** A Node error code (`ECONNREFUSED`, `CERT_HAS_EXPIRED`), `TIMEOUT`, or `UNKNOWN`: nothing else. */
function errorCode(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "TIMEOUT";
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : "UNKNOWN";
}

function errorText(error) {
  return error instanceof GitHubError
    ? error.message
    : `An error stopped the check (${errorCode(error)}).`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function gigabytes(bytes) {
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** How long an issue was open, in minutes, hours and days. */
function duration(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${plural(hours, "hour")} ${plural(minutes % 60, "minute")}`;
  return `${plural(Math.floor(hours / 24), "day")} ${plural(hours % 24, "hour")}`;
}

/** The days the certificate of `hostname` has left (negative once expired), read on port 443. */
export function tlsDaysLeft(hostname, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Only the expiry is read here: whether the certificate is trusted is the HTTPS check's.
    const socket = connect(
      { host: hostname, port: 443, servername: hostname, rejectUnauthorized: false },
      () => {
        const validTo = Date.parse(socket.getPeerCertificate().valid_to);
        socket.end();
        if (Number.isNaN(validTo)) {
          reject(Object.assign(new Error("no certificate"), { code: "NO_CERTIFICATE" }));
        } else {
          resolve(Math.floor((validTo - Date.now()) / DAY_MS));
        }
      },
    );
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })),
    );
    socket.on("error", reject);
  });
}

/**
 * `df` over SSH with the check key, which the server answers with `df -P -B1 /` whatever is asked.
 * The key and the known hosts go into files only this user can read, in the job's temporary
 * folder, removed afterwards.
 */
export async function sshDf(server, key) {
  const dir = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), "opscrew-check-"));
  const keyFile = join(dir, "key");
  const knownHosts = join(dir, "known_hosts");
  try {
    await writeFile(keyFile, key.endsWith("\n") ? key : `${key}\n`, { mode: 0o600 });
    await writeFile(knownHosts, `${server.knownHosts.trim()}\n`, { mode: 0o600 });
    return await exec("ssh", [
      "-i",
      keyFile,
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=20",
      "-p",
      String(server.port),
      `${server.user}@${server.host}`,
      "df",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** `df -P -B1 /` on this machine: the server's own runner. */
export function localDf() {
  return exec("df", ["-P", "-B1", "/"]);
}

/** Runs a program and resolves its output; a failure carries only its exit code. */
function exec(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000 }, (error, stdout) => {
      if (error === null) {
        resolve(stdout);
        return;
      }
      let code = error.code; // ENOENT when the program is missing
      if (error.killed) code = "ETIMEDOUT";
      else if (typeof code === "number") code = `EXIT_${code}`;
      reject(Object.assign(new Error(`${file} failed`), { code }));
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(new URL("./check.json", import.meta.url), "utf8"));
  process.exitCode = await run(process.env, {
    config,
    argv: process.argv.slice(2),
    fetch,
    tlsDaysLeft,
    ssh: sshDf,
    df: localDf,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    log: (line) => console.log(line),
    summary: process.env.GITHUB_STEP_SUMMARY
      ? (text) => appendFile(process.env.GITHUB_STEP_SUMMARY, text)
      : undefined,
  });
}
