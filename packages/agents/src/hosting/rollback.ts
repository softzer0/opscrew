/**
 * `opscrew rollback` for an app on a hosting account (027 plan 6, ADR 0023, ADR 0028 D7, D10,
 * D11): the agent on a panel account switches back to a release it keeps, with or without the
 * database dump filed under that release, after a `promote` approval bound to the plan's hash, both
 * release ids and the database choice; on an SFTP-only host OpsCrew switches over SFTP itself
 * (plan 10). Then the environment's deploys pause. Nothing is rebuilt, and the release command
 * doesn't run.
 */
import type { SftpFiles } from "@opscrew/connector-sftp";
import type { HostingFiles } from "@opscrew/contracts";
import {
  canonicalJson,
  listText,
  OpsCrewError,
  realSleep,
  sha256Hex,
  toPosixRelative,
} from "@opscrew/core";
import { checkEnvironmentKey, healthPath } from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { approve } from "../promote/site";
import { choose, type DatabaseOffer } from "../rollback/database";
import type { RollbackResult } from "../rollback/index";
import {
  type DatabaseBinding,
  type DatabaseChoice,
  type DatabaseRecord,
  imageRollbackHash,
  writeRollback,
} from "../rollback/record";
import { type RollbackRun, rollbackRepository } from "../rollback/run";
import { pausedText, requireNoDeployRunning, UNKNOWN_COMMIT } from "../rollback/server";
import type { VersionMark, VersionView } from "../rollback/types";
import { deployPauseOf, setDeployPause } from "../shared/deploy-pause";
import { errorText } from "../verify/checks";
import { hostingTarget } from "./provision-plans";
import { RELEASE_ID, sendRequest } from "./requests";
import { reachSftpHost } from "./sftp";
import {
  type AgentStatus,
  type HostingAccountServices,
  newestFirst,
  reachHostingAccount,
  readAgentStatus,
  requireFiles,
} from "./status";

/**
 * On an SFTP-only host (027 plan 10): points `current` at release `target` with `ln -s` and
 * `rename` over SFTP, then writes `state/status` as the deploy workflow does, the last attempt
 * kept as it was.
 */
async function switchOverSftp(
  files: SftpFiles,
  folder: string,
  target: string,
  status: AgentStatus,
): Promise<void> {
  await files.link(`${folder}/current`, `releases/${target}`);
  const ids = ((await files.list(`${folder}/releases`)) ?? [])
    .filter((id) => RELEASE_ID.test(id))
    .sort(newestFirst);
  const kept = ids.filter((id) => id !== target);
  const previous = kept.find((id) => newestFirst(target, id) < 0) ?? "";
  const { attempt } = status;
  const text = [
    `running=${target}`,
    `previous=${previous}`,
    `kept=${kept.join(",")}`,
    `attempt=${attempt?.release ?? ""}`,
    `result=${attempt?.result ?? ""}`,
    `reason=${attempt?.reason ?? ""}`,
    `at=${attempt?.at ?? ""}`,
    "",
  ].join("\n");
  await files.writeFile(`${folder}/state/status`, new TextEncoder().encode(text), 0o600);
}

/** The deploy workflow's check: its tries, 5 seconds apart, about 2 minutes. */
const CHECK_TRIES = 28;
const CHECK_EVERY_MS = 5_000;
/**
 * How long after a switch a PHP app's answer counts, except behind LiteSpeed: PHP's path cache
 * (120 s) and a margin, as the deploy workflow's check (research R16).
 */
const PHP_PATH_CACHE_MS = 130_000;

/**
 * After a PHP app's switch over SFTP, at `switchedAt` (ms), asks the health path as the deploy
 * workflow's check does: over HTTPS when the hostname's certificate verifies, else HTTP, up to
 * {@link CHECK_TRIES} times, until it answers 2xx or 3xx naming release `target`. The first such
 * answer counts behind LiteSpeed; elsewhere one from {@link PHP_PATH_CACHE_MS} after the switch,
 * as PHP may run the release before until its path cache expires. Returns the last answer, in the
 * workflow's words, when none counted.
 */
async function checkSwitch(
  deps: PhaseDeps,
  sleep: (ms: number) => Promise<void>,
  input: { hostname: string; path: string; target: string; switchedAt: number },
): Promise<string | undefined> {
  const { hostname, path, target, switchedAt } = input;
  const ask = async (url: string) => {
    const response = await deps.fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    return response;
  };
  let scheme = "https";
  try {
    await ask(`https://${hostname}/`);
  } catch {
    scheme = "http";
  }
  let said = "no answer";
  for (let attempt = 1; attempt <= CHECK_TRIES; attempt++) {
    if (attempt > 1) await sleep(CHECK_EVERY_MS);
    try {
      const response = await ask(`${scheme}://${hostname}${path}`);
      const release = response.headers.get("x-opscrew-release") ?? "";
      said = `it answered ${response.status} with release ${release || "none"}`;
      if (response.status >= 200 && response.status < 400 && release === target) {
        if ((response.headers.get("server") ?? "").startsWith("LiteSpeed")) return undefined;
        if (deps.clock.now().getTime() - switchedAt >= PHP_PATH_CACHE_MS) return undefined;
      }
    } catch (error) {
      said = errorText(error);
    }
  }
  return said;
}

/** How the rollback treats the database, once chosen. */
interface DatabaseStep {
  choice: DatabaseChoice;
  /** What the hash binds; absent for an app without a database. */
  binding?: DatabaseBinding;
  /** The approval's lines on the data. */
  lines: string[];
  /** The flags of the same choice in a script. */
  flags: string;
  /** The hostname typed to approve a restore. */
  confirmPhrase?: string;
}

/**
 * The database's choice for the rollback to release `target` (ADR 0028 D7, D10): restore the dump
 * filed under it (taken before the release that replaced it), when the account keeps one, or keep
 * the database. `--database` decides, refused with its reason when not offered; else the terminal's
 * question with more than one offer; else the default: the dump outside prod, keep on prod.
 */
async function databaseStep(
  run: RollbackRun,
  input: { files: HostingFiles; folder: string; target: string; hostname: string },
): Promise<DatabaseStep> {
  const { plan, environment } = run;
  const { target, hostname } = input;
  const keepOffer: DatabaseOffer = {
    choice: "keep",
    text: `Keep it as it is: release ${target} runs against today's schema.`,
  };
  const keepLine =
    "The database, the app's settings and its values stay as they are now: the earlier release must work with them. The release command doesn't run.";
  if (hostingTarget(plan).database === undefined) {
    const none = `${environment} has no database on the hosting account, so its rollback changes only the release.`;
    await choose(run, [keepOffer], { snapshot: none, migrations: none }, "keep");
    return { choice: "keep", lines: [keepLine], flags: "" };
  }
  const dump = `${target}.sql.gz`;
  const dumps = (await input.files.list(`${input.folder}/dumps`)) ?? [];
  const offers: DatabaseOffer[] = [];
  const why: Partial<Record<DatabaseChoice, string>> = {
    migrations:
      "On a hosting account OpsCrew restores the dump taken before a release, or keeps the database: it runs no down migrations there.",
  };
  if (dumps.includes(dump)) {
    offers.push({
      choice: "snapshot",
      text: `Restore the dump taken when release ${target} stopped running (dumps/${dump}); the database as it is now is dumped first. Everything written since that dump is lost.`,
    });
  } else {
    why.snapshot = `The account keeps no dump filed under release ${target}: the agent takes one before each release when snapshots are on, and keeps those of the releases it keeps.`;
  }
  offers.push(keepOffer);
  // By default the dump outside prod (whose plan names no environment), keep on prod.
  const fallback: DatabaseChoice =
    plan.environment?.name !== undefined && offers[0]?.choice === "snapshot" ? "snapshot" : "keep";
  const choice = await choose(run, offers, why, fallback);
  const offer = offers.find((candidate) => candidate.choice === choice) as DatabaseOffer;
  const binding: DatabaseBinding = { choice, taken: null, currentRecord: null, targetRecord: null };
  if (choice === "keep") return { choice, binding, lines: [keepLine], flags: " --database keep" };
  return {
    choice,
    binding,
    lines: [
      `Database: ${offer.text}`,
      "The app's settings and its values stay as they are now. The release command doesn't run.",
      `Typing ${hostname} approves it.`,
    ],
    flags: ` --database snapshot --confirm ${hostname}`,
    confirmPhrase: hostname,
  };
}

/** A release as the list and the result show it. */
function view(id: string, marks: VersionMark[], commit?: string): VersionView {
  return {
    version: id,
    ...(commit === undefined ? {} : { commit }),
    ...(marks.length > 0 ? { marks } : {}),
  };
}

/** `release <id>`, with its commit's first 7 characters when known. */
const releaseWords = (id: string, commit: string | undefined) =>
  `release ${id}${commit === undefined ? "" : ` (commit ${commit.slice(0, 7)})`}`;

/**
 * `opscrew rollback` on a hosting account (027 plan 6, plan 10). With `list`, the releases the
 * agent keeps and the pause, read-only. Otherwise, each refusal before any change:
 * 1. the agent's `state/status` names the running release; the target is `--to`, else the newest
 *    kept release older than the running one (`previous`, ADR 0023 D4), and must be kept;
 * 2. no run of the deploy workflow is queued or in progress (ADR 0023 D6);
 * 3. the database: the dump filed under the target, or keep ({@link databaseStep});
 * 4. the `promote` approval, bound to {@link imageRollbackHash} of the environment, both release
 *    ids, the plan's hash and the choice; a restore is approved like a destroy, with the hostname
 *    typed (`--confirm` in a script); `--yes` never grants it;
 * 5. the `rollback` request, carried out by the agent (with a restore it dumps the database first,
 *    ADR 0028 D11), or on an SFTP-only host the switch over SFTP and its `state/status`
 *    ({@link switchOverSftp}), then for a PHP app the deploy workflow's check ({@link checkSwitch});
 *    a refusal or failure stops with its reason, the deploys not paused;
 * 6. the deploy pause, pinned to the release; `rollback.json` records it. The agent's `state/last`
 *    stays, so a push of the release rolled back from can't bring it back.
 */
export async function rollbackHosting(
  run: RollbackRun,
  services: HostingAccountServices = {},
): Promise<RollbackResult> {
  const { deps, options, plan, environment, command, flags } = run;
  const github = await rollbackRepository(deps, run.services);
  const reach =
    hostingTarget(plan).panel === "sftp"
      ? await reachSftpHost(deps, plan)
      : await reachHostingAccount(deps, plan, services);
  const sftp = "sftp" in reach ? reach.files : undefined;
  const php = hostingTarget(plan).app === "php";
  const files = "sftp" in reach ? reach.files : requireFiles(reach, "roll the app back");
  const { folder, hostname } = reach;
  const where = `${sftp === undefined ? "the account" : "the SFTP host"} ${reach.account}`;
  deps.reporter.step(`Reading ${environment}'s releases on the hosting account`);
  const status = await readAgentStatus(files, folder);
  const running = status?.running;
  if (options.list === true) {
    const ids = [...(running === undefined ? [] : [running]), ...(status?.kept ?? [])];
    const versions = ids
      .sort(newestFirst)
      .map((id) =>
        view(id, [
          ...(id === running ? (["running"] as const) : []),
          ...(id === status?.previous ? (["previous"] as const) : []),
        ]),
      );
    const paused = await deployPauseOf(github, plan);
    return { kind: "list", versions, ...(paused !== undefined ? { paused } : {}), leftOut: [] };
  }

  // 1. The release that runs, and the one to go back to.
  const listHint = `\`${command} --list\` lists the releases the account keeps.`;
  if (running === undefined || status === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `No release of ${environment} runs on the hosting account yet, so there is nothing to roll back. ${NOTHING_CHANGED}`,
      { hint: `\`opscrew status${flags}\` shows what the agent last did.` },
    );
  }
  const target = options.to?.trim() ?? status.previous;
  if (target === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The hosting account keeps no release of ${environment} older than ${running}, which runs now, so there is nothing to roll back to. ${NOTHING_CHANGED}`,
      {
        hint: `${listHint} Once another release has deployed, \`${command}\` goes back to this one.`,
      },
    );
  }
  if (target === running) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Release ${target} is the one ${environment} runs now. ${NOTHING_CHANGED}`,
      { hint: listHint },
    );
  }
  if (!status.kept.includes(target)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The hosting account keeps no release ${target} of ${environment}${status.kept.length === 0 ? "" : ` (it keeps ${listText(status.kept)})`}. ${NOTHING_CHANGED}`,
      { hint: `${listHint} Name one with --to <release>.` },
    );
  }

  // 2. Never while a deploy runs, and 3. the database.
  await requireNoDeployRunning(run, github);
  const commitOf = async (id: string) =>
    (await github.api.workflowRun(github.owner, github.repo, Number(id.split("-")[0])))?.headSha;
  const [targetCommit, runningCommit] = await Promise.all([commitOf(target), commitOf(running)]);
  const database = await databaseStep(run, { files, folder, target, hostname });

  // 4. The approval, bound to the rollback's hash.
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const hash = imageRollbackHash({
    environment: checkEnvironmentKey(plan),
    current: running,
    target,
    targetPlanHash,
    ...(database.binding !== undefined ? { database: database.binding } : {}),
  });
  await approve(
    { deps, approveHash: options.approveHash, target: environment, what: "rollback" },
    {
      title: `Roll ${environment} back to release ${target} on the hosting account`,
      details: [
        `Now: ${releaseWords(running, runningCommit)}`,
        `Back to: ${releaseWords(target, targetCommit)}`,
        ...database.lines,
        `Target: ${environment} (https://${hostname}) on ${where}, ${toPosixRelative(deps.paths.root, deps.paths.files.plan)} with plan hash ${targetPlanHash}`,
        sftp === undefined
          ? `Switch: the agent on the account points the hostname at release ${target} with one rename, makes PHP and LiteSpeed's cache serve it, and checks that the app answers; nothing is rebuilt. Afterwards ${environment}'s deploys pause until \`${command} --resume\`.`
          : `Switch: OpsCrew points the app's folder current at release ${target} over SFTP with one rename; nothing is rebuilt.${php ? " Then it checks that the app answers with it: on Apache with PHP-FPM, PHP may run the release before for about 2 minutes, and the check waits that long." : ""} Afterwards ${environment}'s deploys pause until \`${command} --resume\`.`,
        `Rollback hash: ${hash}`,
      ].join("\n"),
      hash,
      later: `${command} --to ${target}${database.flags} --approve ${hash}`,
      ...(database.confirmPhrase !== undefined ? { confirmPhrase: database.confirmPhrase } : {}),
    },
  );

  // 5. The switch over SFTP, or the request, carried out by the agent.
  if (sftp !== undefined) {
    deps.reporter.step(`Switching ${environment} to release ${target} over SFTP`);
    try {
      await switchOverSftp(sftp, folder, target, status);
    } catch (error) {
      if (!(error instanceof OpsCrewError)) throw error;
      throw new OpsCrewError(
        error.code,
        `${error.message} ${environment}'s deploys aren't paused.`,
        {
          hint: `${error.hint ?? "Fix the cause shown above."} Then run \`${command} --to ${target}\` again.`,
          cause: error,
        },
      );
    }
    const switchedAt = deps.clock.now().getTime();
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `switch to release ${target} over SFTP`,
      target: hash,
      decision: "approved",
    });
    if (php) {
      const path = healthPath(plan);
      deps.reporter.step(`Checking that ${hostname}${path} answers with release ${target}`);
      deps.reporter.info(
        "Waiting for PHP's path cache: PHP may still run the release before for about 2 minutes after the switch, so an answer counts only after that, or at once behind LiteSpeed.",
      );
      const said = await checkSwitch(deps, run.services.sleep ?? realSleep, {
        hostname,
        path,
        target,
        switchedAt,
      });
      if (said !== undefined) {
        throw new OpsCrewError(
          "COMMAND_FAILED",
          deps.redactor.redact(
            `OpsCrew switched ${environment} to release ${target} over SFTP, but ${hostname}${path} didn't answer 2xx or 3xx with it (${said}). ${environment}'s deploys aren't paused.`,
          ),
          {
            hint: `\`opscrew status${flags}\` shows the release that runs now. Then roll back to another release (\`${command} --list\` lists them) or deploy a fix forward.`,
          },
        );
      }
    }
  } else {
    deps.reporter.step(`Asking the agent on the account to switch to release ${target}`);
    const answer = await sendRequest(
      files,
      folder,
      { kind: "rollback", release: target, restore: database.choice === "snapshot" },
      { hash, now: deps.clock.now(), sleep: run.services.sleep ?? realSleep },
    );
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `ask the agent to roll back to release ${target}`,
      target: hash,
      decision: answer.result === "done" ? "approved" : "refused",
      detail: `${answer.result}${database.choice === "snapshot" ? ", restoring its dump" : ""}`,
    });
    if (answer.result !== "done") {
      throw new OpsCrewError(
        "COMMAND_FAILED",
        deps.redactor.redact(
          `The agent on the hosting account ${answer.result === "refused" ? "refused" : "didn't finish"} the rollback of ${environment} to release ${target}: ${answer.reason ?? "it gave no reason"}. ${environment}'s deploys aren't paused.`,
        ),
        {
          hint: `\`opscrew status${flags}\` shows the release that runs now and \`opscrew logs${flags}\` the agent's lines. Then roll back to another release (\`${command} --list\` lists them) or deploy a fix forward.`,
        },
      );
    }
  }

  // 6. The pause, and the record.
  deps.reporter.step(`Pausing ${environment}'s deploys`);
  try {
    await setDeployPause(deps, github, plan, {
      reason: "rollback",
      since: deps.clock.now().toISOString(),
      image: target,
      commit: targetCommit ?? UNKNOWN_COMMIT,
      ...(runningCommit !== undefined ? { from: runningCommit } : {}),
    });
  } catch (error) {
    if (!(error instanceof OpsCrewError)) throw error;
    throw new OpsCrewError(
      error.code,
      `${environment} runs release ${target} again, but pausing its deploys failed: ${error.message} Until they are paused, the next push to ${plan.cicd.branch} deploys over the rollback.`,
      {
        hint: `${error.hint ?? "Fix the cause shown above."} Then run \`${command} --to ${target}${database.flags}\` again: it pauses the deploys once more.`,
      },
    );
  }
  const record: DatabaseRecord = { choice: database.choice };
  await writeRollback(deps.paths, {
    digest: target,
    ...(targetCommit !== undefined ? { commit: targetCommit } : {}),
    from: { digest: running, ...(runningCommit !== undefined ? { commit: runningCommit } : {}) },
    at: deps.clock.now().toISOString(),
    hash,
    ...(database.binding !== undefined ? { database: record } : {}),
  });
  deps.reporter.success(
    `${environment} runs ${releaseWords(target, targetCommit)} again: nothing was rebuilt, and no release command ran.${database.choice === "snapshot" ? ` Its database is the dump filed under it; the one from just before is in ~/${folder}/dumps/${running}.sql.gz.` : ""}`,
  );
  deps.reporter.info(pausedText(run));
  return {
    kind: "rolled-back",
    status: "deployed",
    target: view(target, [], targetCommit),
    from: view(running, [], runningCommit),
    paused: true,
    how: "release",
    ...(database.binding !== undefined ? { database: record } : {}),
  };
}
