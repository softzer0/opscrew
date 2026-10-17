import { posix } from "node:path";
import { errorMessage, formatMoney, OpsCrewError } from "@opscrew/core";
import { providerProfile } from "../providers";
import {
  buildAppEnvironment,
  deploySecrets,
  deploySecretsStoredFor,
  type SavedPlan,
  setDeploySecrets,
} from "../provision";
import { continuesHint, planStop, readyNewServer, serverOfProvider } from "../shared";
import { moveProvider } from "../shared/vps-target";
import { planThenApply } from "./plans";
import { stopService, waitAppHealthy } from "./server-ops";
import {
  auditMove,
  auditStep,
  type MoveSession,
  moveOf,
  pinHost,
  recordNewServer,
  saveMove,
  savePlan,
  useLayout,
  waitsOf,
  withApply,
} from "./session";
import { ABORT_COMMAND, approveCommand, providerWords, RUN_COMMAND } from "./texts";
import type { RetargetResult } from "./types";
import { codeOf, hintOf, newRemote } from "./window";

const WORKFLOW_WAIT_MS = 30 * 60_000;

/** A non-interactive run stopped before an apply: the plan's hash and the command that applies it. */
export function pendingStop(
  session: MoveSession,
  planHash: string,
  flags: readonly string[] = [],
  before: readonly string[] = [],
): RetargetResult {
  return {
    step: moveOf(session).step,
    done: false,
    pendingPlanHash: planHash,
    next: [
      ...before,
      `Review the plan above, then run \`${approveCommand(session.command, planHash, flags)}\` to apply it and continue.`,
    ],
  };
}

/** The reason of an error in plain words, without a trailing full stop. */
export function reasonOf(error: unknown): string {
  return errorMessage(error).replace(/[.\s]+$/, "");
}

/**
 * Stops unless a moves-only plan only renames resources from `fromPrefix` to `toPrefix` (or
 * nothing at all: the state is renamed already).
 */
export function assertRenameOnly(
  saved: Pick<SavedPlan, "changes" | "moves">,
  bounds: { fromPrefix: string; toPrefix: string; what: string; hint: string },
): void {
  const problems = [
    ...saved.changes.map((change) => `${change.action} ${change.address}`),
    ...(saved.moves ?? [])
      .filter(
        (move) => !move.from.startsWith(bounds.fromPrefix) || !move.to.startsWith(bounds.toPrefix),
      )
      .map((move) => `move ${move.from} → ${move.to}`),
  ];
  if (problems.length === 0) return;
  throw planStop(
    `The ${bounds.what} plan would do more than rename resources in the infrastructure state, so OpsCrew stopped. Nothing was changed.`,
    problems,
    bounds.hint,
  );
}

const DRIFT_HINT = `The infrastructure no longer matches what OpsCrew applied. Run \`${ABORT_COMMAND}\` to undo the move, then \`opscrew drift\` to see the differences and \`opscrew provision\` to bring them back in line, and start the move again.`;

/** Step 2: the moves-only plan that renames the live server to `module.server_previous`. */
export async function renameStep(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const move = moveOf(session);
  const old = providerWords(move.from.target.provider);
  deps.reporter.step(
    `Renaming the current ${old.noun} in the infrastructure state (nothing changes in your cloud)`,
  );
  const files = await useLayout(session, "rename");
  const outcome = await planThenApply(session, {
    action: "rename",
    files,
    check: (saved) =>
      assertRenameOnly(saved, {
        fromPrefix: "module.server.",
        toPrefix: "module.server_previous.",
        what: "rename",
        hint: DRIFT_HINT,
      }),
    notes: [
      `This only renames the current ${old.noun} from module.server to module.server_previous in OpsCrew's infrastructure state, so that the new server can take its place. Nothing changes in your cloud.`,
    ],
  });
  if (outcome.kind === "pending") return pendingStop(session, outcome.planHash);
  if (outcome.kind === "unchanged") {
    deps.reporter.info("The infrastructure state already uses the move's names.");
  }
  const at = deps.clock.now().toISOString();
  await saveMove(
    session,
    { ...moveOf(session), step: "renamed" },
    outcome.kind === "applied" ? withApply(session.plan, outcome, at) : {},
  );
  await auditStep(session, "renamed", "the live server is module.server_previous in the state");
  return undefined;
}

function assertCreateOnly(saved: Pick<SavedPlan, "changes">): void {
  const problems = saved.changes.filter(
    (change) =>
      change.action === "delete" ||
      change.action === "replace" ||
      change.address.startsWith("module.server_previous."),
  );
  if (problems.length === 0) return;
  throw planStop(
    "The plan for the new server would also change, replace or delete what is already running, so OpsCrew stopped. Nothing was changed.",
    problems.map((change) => `${change.action} ${change.address}`),
    DRIFT_HINT,
  );
}

/** Waits for SSH on the new server, pins its host key and waits for its first-boot setup. */
async function waitForNewServer(session: MoveSession, host: string): Promise<void> {
  const profile = providerProfile(moveProvider(session.plan.target));
  await readyNewServer(session.deps, {
    host,
    server: `new ${profile.serverNoun}`,
    profile,
    keyFile: session.deployKey.privateKeyFile,
    again: `${continuesHint(RUN_COMMAND)} To remove the new ${profile.serverNoun} instead, run \`${ABORT_COMMAND}\`.`,
    services: session.services,
  });
}

/**
 * Step 3: the plan that creates the new server as `module.server` next to the old one; its
 * addresses (the new provider's entry of the `servers` output) go to OpsCrew's local state; then
 * SSH, host key, cloud-init.
 */
export async function createStep(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const move = moveOf(session);
  const fresh = providerWords(moveProvider(session.plan.target));
  const old = providerWords(move.from.target.provider);
  deps.reporter.step(`Creating the new ${fresh.noun} on ${fresh.name}`);
  const files = await useLayout(session, "both");
  const outcome = await planThenApply(session, {
    action: "create",
    files,
    check: assertCreateOnly,
    notes: [
      `This creates the new ${fresh.noun} on ${fresh.name} next to the current ${old.noun}; your app keeps running on the old one.`,
      `Both are billed until the move is finished or aborted: about ${formatMoney(session.plan.cost.monthly)} per month extra while they run.`,
      `Then OpsCrew deploys the app there with the deploy workflow and keeps its web server (Caddy) stopped until traffic is switched to it.`,
    ],
    // `opscrew design` refuses during a move: another size means aborting and starting again.
    redesignHint: `Run \`${ABORT_COMMAND}\` (your app keeps running on the old ${old.noun}), then start the move again and pick another option: \`${RUN_COMMAND} --to ${moveProvider(session.plan.target)} --option <id>\`. Nothing that was already created is removed until you abort.`,
  });
  if (outcome.kind === "pending") return pendingStop(session, outcome.planHash);
  // The new server is the one on the new provider (a move always changes the provider).
  const next = serverOfProvider(outcome.outputs, moveProvider(session.plan.target));
  if (next === undefined) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The new ${fresh.noun}'s address is unknown after the apply.`,
      { hint: `Run \`${RUN_COMMAND}\` again; it reads the address from the infrastructure state.` },
    );
  }
  // The address goes to OpsCrew's local state, never into opscrew/plan.yaml.
  await recordNewServer(session, next);
  if (outcome.kind === "applied") {
    const at = deps.clock.now().toISOString();
    await savePlan(session, { ...session.plan, ...withApply(session.plan, outcome, at) });
  }
  await waitForNewServer(session, next.ipv4);
  await saveMove(session, { ...moveOf(session), step: "created" });
  await auditStep(session, "created", `new ${fresh.noun} at ${next.ipv4} is ready`);
  return undefined;
}

/**
 * Stores the deploy secrets for `host` (same deploy key and app environment, the host's pinned
 * key) after the `github-secrets` approval. Used for the new server and, on abort, the old one.
 */
export async function storeDeploySecrets(
  session: MoveSession,
  host: string,
  which: "new" | "old",
): Promise<void> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const provider = which === "new" ? moveProvider(plan.target) : move.from.target.provider;
  const pinned = await pinHost(session, host, provider);
  let environment: Awaited<ReturnType<typeof buildAppEnvironment>>;
  try {
    // Without a domain, host lists (`ALLOWED_HOSTS`) name the server these secrets point to.
    environment = await buildAppEnvironment(deps, plan, session.services, host);
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "INVALID_INPUT") {
      throw new OpsCrewError(error.code, error.message, {
        hint: `Add them to the file named by OPSCREW_APP_ENV_FILE, or run \`${session.command}\` in a terminal to type them in.`,
      });
    }
    throw error;
  }
  deps.reporter.step(`Pointing the GitHub deploy secrets at the ${which} server (${host})`);
  try {
    await setDeploySecrets(
      deps,
      session.github,
      deploySecrets({
        host,
        privateKey: session.deployKey.privateKeyOpenSsh,
        knownHosts: pinned.knownHostsLines,
        environment,
      }),
      environment.names,
    );
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "APPROVAL_REFUSED") {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The deploy secrets were not changed, so they still point to the ${which === "new" ? "old" : "new"} server.`,
        { hint: `Run \`${session.command}\` again when you are ready.` },
      );
    }
    throw error;
  }
  await auditMove(session, {
    kind: "secret-set",
    action: "point deploy secrets",
    target: `${session.github.owner}/${session.github.repo}`,
    decision: "approved",
    detail: `deploy secrets point to the ${which} server ${host}`,
  });
}

/** Dispatches the deploy workflow on the plan's branch and waits for it to succeed. */
async function runDeployWorkflow(session: MoveSession): Promise<void> {
  const { deps, plan, githubApi } = session;
  const { owner, repo } = session.github;
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const branch = plan.cicd.branch;
  const fresh = providerWords(moveProvider(plan.target));
  const oldStill = "The old server still serves your users.";
  deps.reporter.step(
    `Running the deploy workflow (${workflowFile} on ${branch}) for the new ${fresh.noun}`,
  );
  const since = deps.clock.now().toISOString();
  let run: Awaited<ReturnType<typeof githubApi.waitForWorkflowRun>>;
  try {
    const { runId } = await githubApi.dispatchWorkflow(owner, repo, workflowFile, branch);
    await auditMove(session, {
      kind: "provider-call",
      action: "dispatch workflow",
      target: `${owner}/${repo}`,
      detail: `${workflowFile} on ${branch}`,
    });
    run = await githubApi.waitForWorkflowRun(owner, repo, {
      workflowFile,
      ref: branch,
      since,
      timeoutMs: WORKFLOW_WAIT_MS,
      ...(runId !== undefined ? { runId } : {}),
    });
  } catch (error) {
    throw new OpsCrewError(
      codeOf(error),
      deps.redactor.redact(`Running the deploy workflow failed: ${reasonOf(error)}. ${oldStill}`),
      {
        hint: `${hintOf(error)}Check the workflow in your repository's Actions tab, then run \`${RUN_COMMAND}\` again, or \`${ABORT_COMMAND}\` to undo the move.`,
      },
    );
  }
  const ok = run.conclusion === "success";
  await auditMove(session, {
    kind: "provider-call",
    action: "deploy workflow",
    target: run.htmlUrl,
    decision: ok ? "approved" : "refused",
    detail: `workflow run ${run.id} finished: ${run.conclusion ?? "no result"}`,
  });
  if (!ok) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The deploy workflow did not succeed (${run.conclusion ?? "no result"}): ${run.htmlUrl}. ${oldStill} Nothing else changed.`,
      {
        hint: `Open the run to see what failed and push a fix (deploys now go to the new ${fresh.noun}), then run \`${RUN_COMMAND}\` again. To go back instead, run \`${ABORT_COMMAND}\`.`,
      },
    );
  }
  deps.reporter.success(`The deploy workflow succeeded (${run.htmlUrl}).`);
}

/**
 * Step 4: the deploy secrets point to the new server, the deploy workflow puts the app there, the
 * app answers over SSH, and Caddy on the new server is stopped until the switch.
 */
export async function deployStep(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  const next = session.servers.next;
  if (next === undefined) {
    // A step `created` always has the address; the create step reads it from the state again.
    await saveMove(session, { ...move, step: "renamed" });
    return { step: "renamed", done: false, next: [`Run \`${RUN_COMMAND}\` again.`] };
  }
  const fresh = providerWords(moveProvider(plan.target));
  const where = { host: next.ipv4, owner: session.github.owner, repo: session.github.repo };
  if (await deploySecretsStoredFor(deps, where)) {
    deps.reporter.info("The GitHub deploy secrets already point to the new server.");
  } else {
    await storeDeploySecrets(session, next.ipv4, "new");
  }
  await runDeployWorkflow(session);
  const remote = newRemote(session);
  deps.reporter.step(`Checking the app on the new ${fresh.noun} over SSH`);
  await waitAppHealthy(remote, plan.app.port, plan.app.healthPath, {
    redact: deps.redactor.redact,
    ...waitsOf(session.services),
  });
  deps.reporter.step(`Stopping Caddy on the new ${fresh.noun} until traffic is switched to it`);
  await stopService(remote, "caddy", deps.redactor);
  await auditMove(session, {
    kind: "remote-exec",
    action: "stop caddy",
    target: remote.host,
    decision: "approved",
  });
  await saveMove(session, { ...moveOf(session), step: "deployed" });
  deps.reporter.success(
    `The app runs on the new ${fresh.noun}; the old server still serves users.`,
  );
  await auditStep(session, "deployed", `app deployed and healthy on ${next.ipv4}`);
  return undefined;
}
