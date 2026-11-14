/**
 * `opscrew drift` for an app on a hosting account (027 plan 9, US6 scenario 2), read-only: how the
 * account and GitHub differ from what `.opscrew/hosting.json` records OpsCrew made there and from
 * the committed files. Through the panel: each recorded hostname's document root, each recorded
 * database (by name), each cron line OpsCrew made or asked the user to add; through the account's
 * files: the agent (`agent.sh`) and its settings (`settings.sh`) against the committed
 * `opscrew/hosting/agent.sh` and `<env>.sh`, by SHA-256; on GitHub: the agent's deploy key.
 *
 * A database is checked by its name only: the panel contract lists databases by name, not their
 * users, so a user removed in the panel, or cPanel's removed database listed again for a few
 * minutes (027 research R10, which destroy already handles), reads as present.
 */
import { join } from "node:path";
import type { GitHubClient } from "@opscrew/connector-github";
import type { HostingFiles, HostingPanel } from "@opscrew/contracts";
import { OpsCrewError, readTextIfExists, sha256Hex, upperFirst } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { DriftReport, HostingDifference } from "../drift/types";
import { commandFlags } from "../environments/choice";
import { gitClient, githubClientFromToken, githubCoordinates } from "../shared";
import { PANEL_NAMES } from "./panels";
import { agentCronLine } from "./php";
import { cleanPath, committedHostingFolder, environmentOf } from "./provision-plans";
import type { HostingRecord } from "./record";
import type { HostingAccountServices } from "./status";
import { type CheckedAccount, reachCheckedAccount } from "./verify";

/** What drift reads besides the account, each replaceable in tests. */
export interface HostingDriftServices extends HostingAccountServices {
  /** GitHub's deploy keys (default: the client of the user's token); `null` means no token. */
  github?: Pick<GitHubClient, "listDeployKeys"> | null;
}

/** What the drift found and what it couldn't look at. */
interface Found {
  differences: HostingDifference[];
  notes: string[];
}

/** Each recorded hostname's document root against the one the panel made. */
async function hostnameDifferences(
  panel: HostingPanel,
  record: HostingRecord,
  flag: string,
): Promise<HostingDifference[]> {
  const name = PANEL_NAMES[panel.kind];
  const differences: HostingDifference[] = [];
  for (const { key, value } of record.objects.filter((o) => o.kind === "hostname")) {
    const root = await panel.documentRoot(key);
    if (root === undefined) {
      differences.push({
        title: `${key} is gone from the account`,
        detail: `The app doesn't answer there. OpsCrew's record still lists it, so \`opscrew provision${flag}\` doesn't add it again: add it in ${name}${value === undefined ? "" : ` with the document root ~/${value}`}, or run \`opscrew destroy${flag}\` and provision anew.`,
      });
    } else if (value !== undefined && cleanPath(root) !== cleanPath(value)) {
      differences.push({
        title: `${key}'s document root is ~/${cleanPath(root)}, not ~/${cleanPath(value)}`,
        detail: `It no longer serves the app's running release. Set it back to ~/${cleanPath(value)} in ${name}.`,
      });
    }
  }
  return differences;
}

/** Each recorded database, by name. */
async function databaseDifferences(
  panel: HostingPanel,
  record: HostingRecord,
  flag: string,
): Promise<HostingDifference[]> {
  const recorded = record.objects.filter((o) => o.kind === "database");
  if (recorded.length === 0) return [];
  const listed = await panel.listDatabases();
  return recorded
    .filter(({ key }) => !listed.includes(key))
    .map(({ key }) => ({
      title: `The database ${key} is gone from the account`,
      detail: `The app can't reach its data. OpsCrew's record still lists it, so \`opscrew provision${flag}\` doesn't make it again: restore it from ${PANEL_NAMES[panel.kind]}'s backups under the same name, or run \`opscrew destroy${flag}\` and provision anew.`,
    }));
}

/**
 * The cron lines OpsCrew made (by the panel's key, else by their text) and those it asked the user
 * to add in the panel (by their text). A panel whose API lists none is a note.
 */
async function cronDifferences(
  panel: HostingPanel,
  record: HostingRecord,
  folder: string,
): Promise<Found> {
  const name = PANEL_NAMES[panel.kind];
  const agent = agentCronLine(folder);
  const made = record.objects.flatMap((o) =>
    o.kind === "cron" && o.value !== undefined ? [{ key: o.key, line: o.value }] : [],
  );
  const asked = record.objects.flatMap((o) =>
    o.kind !== "panel-step"
      ? []
      : o.key === "agent-cron"
        ? [agent]
        : o.key.startsWith("cron:")
          ? [o.key.slice("cron:".length)]
          : [],
  );
  if (made.length === 0 && asked.length === 0) return { differences: [], notes: [] };
  const jobs = await panel.listCron();
  if (jobs === undefined) {
    return {
      differences: [],
      notes: [
        `${name}'s API doesn't list scheduled tasks, so OpsCrew didn't compare the cron lines: check in ${name} that the agent's line runs ~/${folder}/agent.sh every minute.`,
      ],
    };
  }
  const lines = jobs.map((job) => ({ key: job.key, line: `${job.schedule} ${job.command}` }));
  const gone = (line: string): HostingDifference =>
    line === agent
      ? {
          title: "The agent's cron line is gone",
          detail: `Without it the agent deploys no release and carries out no request. Add it again in ${name}'s cron jobs: ${line}`,
        }
      : {
          title: `The cron line "${line}" is gone`,
          detail: `The app's scheduled command no longer runs. Add it again in ${name}'s cron jobs.`,
        };
  const differences: HostingDifference[] = [];
  for (const { key, line } of made) {
    const now = lines.find((job) => job.key === key);
    if (now === undefined) {
      if (!lines.some((job) => job.line === line)) differences.push(gone(line));
    } else if (now.line !== line && !lines.some((job) => job.line === line)) {
      differences.push({
        title: `The cron line OpsCrew made as "${line}" is now "${now.line}"`,
        detail: `It changed in ${name}. Put it back in ${name}'s cron jobs unless you changed it on purpose.`,
      });
    }
  }
  for (const line of asked) {
    if (!lines.some((job) => job.line === line)) differences.push(gone(line));
  }
  return { differences, notes: [] };
}

/**
 * The agent and its settings on the account against the committed copies, by SHA-256: a pair
 * where neither exists is no difference (an SFTP host has no agent).
 */
async function fileDifferences(
  deps: PhaseDeps,
  plan: DeployPlan,
  files: HostingFiles,
  folder: string,
  flag: string,
): Promise<HostingDifference[]> {
  const committed = committedHostingFolder(plan);
  const pairs = [
    { what: "the agent", repo: `${committed}/agent.sh`, account: `${folder}/agent.sh` },
    {
      what: "the agent's settings file",
      repo: `${committed}/${environmentOf(plan)}.sh`,
      account: `${folder}/settings.sh`,
    },
  ];
  const provision = `\`opscrew provision${flag}\` writes OpsCrew's copy back (it shows the hosting plan first).`;
  const short = (text: string) => sha256Hex(text).slice(0, 12);
  const differences: HostingDifference[] = [];
  for (const pair of pairs) {
    const [committed, account] = await Promise.all([
      readTextIfExists(join(deps.paths.root, pair.repo)),
      files.readFile(pair.account),
    ]);
    // A Windows checkout's CRLF line ends are the same text.
    const repo = committed?.replaceAll("\r\n", "\n");
    if (repo === undefined && account === undefined) continue;
    if (account === undefined) {
      differences.push({
        title: `${upperFirst(pair.what)} is gone from the account (~/${pair.account})`,
        detail: provision,
      });
    } else if (repo === undefined) {
      differences.push({
        title: `${pair.repo} isn't in the repository`,
        detail: `OpsCrew can't compare the account's copy of ${pair.what} (~/${pair.account}) with it. ${provision}`,
      });
    } else if (sha256Hex(repo) !== sha256Hex(account)) {
      differences.push({
        title: `The account's copy of ${pair.what} (~/${pair.account}) differs from ${pair.repo}`,
        detail: `One of them changed outside OpsCrew (SHA-256 ${short(account)}… on the account, ${short(repo)}… committed). ${provision}`,
      });
    }
  }
  return differences;
}

/** The agent's deploy key on GitHub, by its id or, added again, by its key. */
async function deployKeyDifferences(
  deps: PhaseDeps,
  record: HostingRecord,
  services: HostingDriftServices,
): Promise<Found> {
  const recorded = record.objects.filter((o) => o.kind === "deploy-key");
  if (recorded.length === 0) return { differences: [], notes: [] };
  let coordinates: { owner: string; repo: string };
  try {
    coordinates = await githubCoordinates(gitClient(deps));
  } catch {
    return {
      differences: [],
      notes: [
        "The repository has no GitHub remote named origin, so OpsCrew didn't check the agent's deploy key.",
      ],
    };
  }
  const api = services.github === undefined ? await githubClientFromToken(deps) : services.github;
  if (!api) {
    return {
      differences: [],
      notes: ["No GitHub token was found, so OpsCrew didn't check the agent's deploy key."],
    };
  }
  const { owner, repo } = coordinates;
  const keys = await api.listDeployKeys(owner, repo);
  const differences = recorded
    .filter((o) => !keys.some((key) => String(key.id) === o.key || key.key.trim() === o.value))
    .map((o) => ({
      title: `The agent's deploy key is gone from ${owner}/${repo}`,
      detail: `The agent can't fetch releases without it. Add it again as a read-only deploy key in the repository's Settings → Deploy keys${o.value === undefined ? "" : `: ${o.value}`}`,
    }));
  return { differences, notes: [] };
}

/**
 * `opscrew drift` on a hosting account (see the module's comment). What OpsCrew can't reach here
 * (the files without SFTP, a panel's cron lines its API doesn't list, GitHub without a token) is a
 * note. Audited; changes nothing.
 * @throws OpsCrewError `PHASE_PRECONDITION` without a record of the account, or on an SFTP host
 * whose files OpsCrew can't reach here.
 */
export async function hostingDrift(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: HostingDriftServices = {},
): Promise<DriftReport> {
  const flag = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  deps.reporter.step("Reading the app on the hosting account and its deploy key (read-only)");
  const account: CheckedAccount = await reachCheckedAccount(deps, plan, services);
  const { record, panel, files, folder } = account;
  if (panel === undefined && files === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew can't reach the SFTP host's files from this computer, so there is nothing it can compare.",
      { hint: "Run `opscrew drift` where OpsCrew reaches the host over SFTP." },
    );
  }
  const differences: HostingDifference[] = [];
  const notes: string[] = [];
  if (panel !== undefined) {
    differences.push(...(await hostnameDifferences(panel, record, flag)));
    differences.push(...(await databaseDifferences(panel, record, flag)));
    const cron = await cronDifferences(panel, record, folder);
    differences.push(...cron.differences);
    notes.push(...cron.notes);
  }
  if (files === undefined) {
    notes.push(
      `${panel === undefined ? "OpsCrew" : `${PANEL_NAMES[panel.kind]}'s API`} can't read the account's files here, so OpsCrew didn't compare the agent and its settings with the committed copies.`,
    );
  } else {
    differences.push(...(await fileDifferences(deps, plan, files, folder, flag)));
  }
  const keys = await deployKeyDifferences(deps, record, services);
  differences.push(...keys.differences);
  notes.push(...keys.notes);

  const redact = (text: string) => deps.redactor.redact(text);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "drift-check of the app on the hosting account (read-only)",
    target: "hosting account",
    decision: "allow",
    detail: differences.length === 0 ? "no drift" : `${differences.length} differences`,
  });
  return {
    drift: [],
    pending: [],
    files: { changed: [], created: [] },
    foreignDnsRecords: [],
    hosting: differences.map((d) => ({ title: redact(d.title), detail: redact(d.detail) })),
    clean: differences.length === 0,
    checkedAt: deps.clock.now().toISOString(),
    provider: "hosting",
    ...(notes.length > 0 ? { notes: notes.map(redact) } : {}),
  };
}
