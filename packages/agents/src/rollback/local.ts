/**
 * The rollback of an app on this computer (plan.md 5., FR-1908, US4 #2): back to the image its
 * last deploy replaced (`.env.previous`) while Docker still has it, with the same start script as a
 * deploy in its `rollback` mode, which runs no release command.
 */
import { join } from "node:path";
import {
  canonicalJson,
  exists,
  OpsCrewError,
  type ProjectPaths,
  sha256Hex,
  toPosixRelative,
} from "@opscrew/core";
import { checkEnvironmentKey, edgeProxy, renderWorkflow } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { workflowBranch } from "../environments/branches";
import { switchTo } from "../localhost/apply";
import { githubRegistry } from "../localhost/image";
import { withLocalLock } from "../localhost/lock";
import { runningImage } from "../localhost/plan";
import {
  appFolder,
  computer,
  localShell,
  requireOwnLocalApp,
  requireShell,
} from "../localhost/services";
import { localAddress, localSite, localTarget, servedSite } from "../localhost/site";
import { localRenderContext } from "../localhost/stack";
import { appImageOf } from "../promote/image";
import { NOTHING_CHANGED, requireWorkflowApplied } from "../promote/shared";
import { approve } from "../promote/site";
import { deployPauseOf } from "../shared/deploy-pause";
import { pushesDeploy } from "../status/deploys";
import { databaseStep } from "./database";
import type { RollbackResult } from "./index";
import { imageRollbackHash, readRollback, writeRollback } from "./record";
import { type RollbackRepository, type RollbackRun, rollbackRepository } from "./run";
import {
  type PinnedVersion,
  pausedText,
  pausedWhile,
  requireNoDeployRunning,
  UNKNOWN_COMMIT,
} from "./server";
import type { VersionView } from "./types";
import { describeImage, shortImage } from "./versions";

/** The digest of an image reference `…@sha256:…`; `undefined` for a local build's tag. */
function digestOf(image: string): string | undefined {
  const at = image.indexOf("@");
  return at === -1 ? undefined : image.slice(at + 1);
}

/** An image as the result shows it: by its digest, or a local build by its tag. */
function imageView(image: string): VersionView {
  const digest = digestOf(image);
  return digest === undefined ? { version: image } : { digest };
}

/** The deploy workflow the local runner's plan generates, as provision renders it. */
async function localWorkflow(deps: PhaseDeps, plan: DeployPlan): Promise<string> {
  return renderWorkflow(
    plan,
    await localRenderContext(deps, plan, await localSite(deps.paths, plan)),
  ).content;
}

/** True when `rollback.json` says this computer went back from `previous` to `running`. */
async function wentBackFrom(
  paths: Pick<ProjectPaths, "stateDir">,
  running: string | undefined,
  previous: string | undefined,
): Promise<boolean> {
  const last = await readRollback(paths);
  return last !== undefined && last.digest === running && last.from.digest === previous;
}

/**
 * The image to go back to, `.env.previous`'s, and the one running.
 * @throws OpsCrewError `PHASE_PRECONDITION` when there is none, when it is the image running, or
 * when it is the one this computer rolled back from (`rollback.json`).
 */
async function chooseLocal(
  run: RollbackRun,
  folder: string,
): Promise<{ running: string; previous: string }> {
  const { deps, environment, flags } = run;
  const running = await runningImage(folder);
  const previous = await runningImage(folder, ".env.previous");
  const forward = `Check out the commit to go back to, then run \`opscrew provision${flags}\`: it deploys it.`;
  if (running === undefined || previous === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer keeps no earlier version of ${environment}'s app (${folder} has no ${running === undefined ? ".env" : ".env.previous"}), so there is nothing to roll back to. ${NOTHING_CHANGED}`,
      { hint: forward },
    );
  }
  if (previous === running) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The version before on this computer is the image ${environment} runs now, ${shortImage(running)}, so there is nothing to go back to. ${NOTHING_CHANGED}`,
      { hint: forward },
    );
  }
  if (await wentBackFrom(deps.paths, running, previous)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The version before on this computer, ${shortImage(previous)}, is the one \`opscrew rollback\` went back from: this computer keeps only the version before. ${NOTHING_CHANGED}`,
      { hint: `Deploy forward with \`opscrew provision${flags}\`.` },
    );
  }
  return { running, previous };
}

/**
 * The pause entry of a rollback to `image`, with the commit its provenance names
 * ({@link UNKNOWN_COMMIT} for a local build, or an image GHCR no longer describes).
 */
async function pinnedImage(
  run: RollbackRun,
  github: RollbackRepository,
  image: string,
): Promise<PinnedVersion> {
  const digest = digestOf(image);
  if (digest === undefined) return { image, commit: UNKNOWN_COMMIT };
  const described = await describeImage(run.deps, appImageOf(run.deps, run.plan, github), digest);
  return { image: digest, commit: described?.commit ?? UNKNOWN_COMMIT };
}

/**
 * This computer's rollback, or its `--list` (`.env`'s image and `.env.previous`'s). Each refusal
 * before any change:
 * 1. the app's folder belongs to this project, and keeps an earlier image that is neither the one
 *    running nor the one this computer rolled back from (`rollback.json`);
 * 2. Docker still has that image (US4 #2), and with the local runner the deploy workflow on its
 *    branch is the one the plan generates, which pauses (`requireWorkflowApplied`; drift is not
 *    asked: it counts a broken app's stopped containers as pending), and no run of it is queued or
 *    in progress (FR-1907);
 * 3. how to treat the database (`databaseStep`), then the `promote` approval, bound to
 *    {@link imageRollbackHash} of the environment, both image references, the plan's hash and the
 *    database step; never granted by `--yes`. A database choice that changes data is approved like
 *    a destroy, with the app's name typed.
 *
 * Then, when the local runner deploys the environment from its branch, its deploys are paused and
 * the deploys created just before are waited for. Only then is this computer's deploy lock taken,
 * so neither the approval nor the wait holds it. Under the lock the images are read again, and a
 * rollback whose hash is no longer the approved one stops; otherwise the database step's one-time
 * approval is left in the app's folder, and `switchTo` switches the app to the image in the start
 * script's `rollback` mode, checks it, and puts the image it ran back when that fails; whatever
 * happened, an unused one-time approval goes. Any error after the pause puts the pause back as it
 * was. Recorded in `rollback.json`, and audited by the hash.
 */
export async function rollbackLocal(run: RollbackRun): Promise<RollbackResult> {
  const { deps, options, plan, environment, command, services } = run;
  const local = computer(deps, services.localhost);
  const folder = appFolder(deps.paths, plan);
  const pauses = pushesDeploy(plan);
  if (options.list === true) {
    const running = await runningImage(folder);
    const previous = await runningImage(folder, ".env.previous");
    const target = !(await wentBackFrom(deps.paths, running, previous));
    const versions = [
      ...(running !== undefined ? [{ ...imageView(running), marks: ["running" as const] }] : []),
      ...(previous !== undefined && previous !== running
        ? [target ? { ...imageView(previous), marks: ["previous" as const] } : imageView(previous)]
        : []),
    ];
    const paused = pauses
      ? await deployPauseOf(await rollbackRepository(deps, services), plan)
      : undefined;
    return { kind: "list", versions, ...(paused !== undefined ? { paused } : {}), leftOut: [] };
  }
  if (options.to !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `This computer keeps only the version before the one ${environment} runs, so --to has nothing to choose from. ${NOTHING_CHANGED}`,
      { hint: `Leave --to out, then run \`${command}\` again.` },
    );
  }

  // 1.–2. The images, Docker's copy of the earlier one, and with the local runner its workflow.
  await requireOwnLocalApp(deps.paths, plan, "deploy");
  const { running, previous } = await chooseLocal(run, folder);
  const inspected = await deps.runner.run("docker", ["image", "inspect", previous], {
    env: deps.env,
    timeoutMs: 30_000,
  });
  if (inspected.exitCode !== 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `Docker on this computer no longer has ${previous}, the version before, so OpsCrew cannot go back to it. ${NOTHING_CHANGED}`,
      {
        hint: `Check out the commit to go back to, then run \`opscrew provision${run.flags}\`: it deploys it.`,
      },
    );
  }
  const exec = await localShell(deps, await requireShell(local));
  const registry = previous.startsWith("ghcr.io/")
    ? (local.registry ?? (await githubRegistry(deps)))
    : undefined;
  const github = pauses ? await rollbackRepository(deps, services) : undefined;
  if (github !== undefined) {
    await requireWorkflowApplied(deps, {
      target: environment,
      plan,
      github,
      command,
      branch: workflowBranch(plan, github.defaultBranch),
      workflow: await localWorkflow(deps, plan),
      what: "rollback",
    });
    await requireNoDeployRunning(run, github);
  }
  const pinned = github === undefined ? undefined : await pinnedImage(run, github, previous);
  const database = await databaseStep(run, {
    current: running,
    target: previous,
    words: shortImage(previous),
  });

  // 3. The approval, bound to the rollback's hash.
  const targetPlanHash = sha256Hex(canonicalJson(plan));
  const hashOf = (now: string | undefined, before: string | undefined) =>
    imageRollbackHash({
      environment: checkEnvironmentKey(plan),
      current: now ?? "",
      target: before ?? "",
      targetPlanHash,
      ...(database.binding !== undefined ? { database: database.binding } : {}),
    });
  const hash = hashOf(running, previous);
  const site = await servedSite(deps.paths, plan);
  const address = localAddress(site, localTarget(plan));
  await approve(
    { deps, approveHash: options.approveHash, target: environment, what: "rollback" },
    {
      title: `Roll ${environment} back to ${shortImage(previous)} on this computer`,
      details: [
        `Now: ${running}`,
        `Back to: ${previous}, the version before, which Docker on this computer still has`,
        ...database.lines,
        `Target: ${environment} on this computer (${address}), ${toPosixRelative(deps.paths.root, deps.paths.files.plan)} with plan hash ${targetPlanHash}`,
        `Deploy: the start script switches the app to that image; nothing is rebuilt.${pauses ? ` Afterwards ${environment}'s deploys pause until \`${command} --resume\`.` : ""}`,
        `Rollback hash: ${hash}`,
      ].join("\n"),
      hash,
      later: `${command}${database.flags} --approve ${hash}`,
      ...(database.confirmPhrase !== undefined ? { confirmPhrase: database.confirmPhrase } : {}),
    },
  );

  // The switch under the lock, its check, and the way back when it fails.
  const audit = (action: string, decision: "approved" | "refused", detail: string) =>
    deps.audit.append({
      kind: "remote-exec",
      actor: "opscrew",
      action,
      target: hash,
      decision,
      detail,
    });
  const switchBack = async (): Promise<void> => {
    // Another deploy may have changed the images since the approval.
    if (hashOf(await runningImage(folder), await runningImage(folder, ".env.previous")) !== hash) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The images on this computer are no longer the ones in the rollback you approved (${hash}): another deploy changed ${environment} meanwhile. ${NOTHING_CHANGED}`,
        { hint: `Run \`${command}\` again, review the new rollback and approve its hash.` },
      );
    }
    await audit("local rollback started", "approved", `${plan.app.name} on this computer`);
    deps.reporter.step(`Switching ${plan.app.name} back to ${shortImage(previous)}`);
    // The start script uses the one-time approval once; what it left unused goes afterwards.
    await database.leave();
    let switched: Awaited<ReturnType<typeof switchTo>>;
    try {
      switched = await switchTo(deps, {
        exec,
        local,
        plan,
        site,
        image: previous,
        rollback: true,
        registry,
        additions: await exists(join(folder, `additions.${edgeProxy(plan)}`)),
      });
    } finally {
      await database.clear();
    }
    if (switched.healthy) return;
    const after =
      switched.back === "restored"
        ? `OpsCrew switched it back: ${environment} runs ${shortImage(running)} again, the version it ran.`
        : switched.back === "unchanged"
          ? `${environment} still runs ${shortImage(running)}, the version it ran.`
          : `OpsCrew could not switch back to ${shortImage(running)}: run \`docker compose ps\` in ${folder}.`;
    const why =
      switched.startFailed === undefined
        ? `${shortImage(previous)} did not answer at ${address}${plan.app.healthPath}.`
        : `The rollback on this computer failed:\n${switched.startFailed}`;
    await audit(
      "local rollback failed",
      "refused",
      `${previous}: ${switched.back ?? "no outcome"}`,
    );
    throw new OpsCrewError("COMMAND_FAILED", deps.redactor.redact(`${why}\n${after}`), {
      hint: `\`opscrew logs --failed${run.flags}\` shows its last lines. Fix the cause, then deploy forward with \`opscrew provision${run.flags}\`.`,
    });
  };
  const locked = () => withLocalLock(deps.paths, local.sleep, switchBack);
  if (github === undefined || pinned === undefined) {
    await locked();
  } else {
    await pausedWhile(run, github, pinned, async (beforeChange) => {
      await beforeChange();
      await locked();
    });
  }

  await writeRollback(deps.paths, {
    digest: previous,
    ...(pinned !== undefined && pinned.commit !== UNKNOWN_COMMIT ? { commit: pinned.commit } : {}),
    from: { digest: running },
    at: deps.clock.now().toISOString(),
    hash,
    database: database.record,
  });
  await audit("local rollback finished", "approved", previous);
  deps.reporter.success(
    `${environment} runs ${shortImage(previous)} again on this computer (${address}): no build, and no release command ran. ${database.outcome}`,
  );
  if (pauses) deps.reporter.info(pausedText(run));
  return {
    kind: "rolled-back",
    status: "deployed",
    target: { ...imageView(previous), marks: ["previous"] },
    from: { ...imageView(running), marks: ["running"] },
    paused: pauses,
    how: "local",
    database: database.record,
  };
}
