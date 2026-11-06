import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import {
  formatMoney,
  isUserFacingError,
  OpsCrewError,
  readTextIfExists,
  writeFileAtomic,
} from "@opscrew/core";
import {
  checkServerSecret,
  EDGE_PROXIES,
  edgeProxy,
  keepNewerPins,
  type RenderedFile,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  isCloudProvider,
  monitoringServerName,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { checkReachesOverSsh } from "../check/provision";
import { workflowBranch } from "../environments/branches";
import { providerProfile } from "../providers";
import {
  buildAppEnvironment,
  deploySecrets,
  deploySecretsStoredFor,
  providerBucket,
  publishDeploySetup,
  requireStorageKey,
  setDeploySecrets,
  storageLogin,
} from "../provision";
import { originTlsSecret } from "../provision/origin-tls";
import { PORTAINER_SECRETS_RECORD, portainerDeploySecrets } from "../provision/secrets";
import {
  continuesHint,
  knownHostsName,
  readServerAddresses,
  readValidJson,
  readyNewServer,
  serverOfProvider,
  writeRenderedFiles,
} from "../shared";
import { codeOf, hintOf, reasonOf } from "../shared/errors";
import { moveProvider } from "../shared/vps-target";
import { bucketKeys, copyBucket, createBucket, movingBucket, renameBucket } from "./bucket";
import { oldSideTarget, previousCloud } from "./layouts";
import { joinMoveNetwork, moveMonitoring, sideServer } from "./network";
import { type PlanSession, planBounded, planThenApply } from "./plans";
import type { MoveServer } from "./removal";
import {
  auditMove,
  auditStep,
  type MoveSession,
  moveOf,
  newServer,
  pinHost,
  recordAdopted,
  recordNewServer,
  renderFiles,
  saveMove,
  savePlan,
  serverOf,
  useLayout,
  withApply,
} from "./session";
import { composeProject, moveSide, sideTarget, sideWords } from "./sides";
import { ABORT_COMMAND, approveCommand, providerWords, RUN_COMMAND } from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";

const WORKFLOW_WAIT_MS = 30 * 60_000;

/** A non-interactive run stopped before an apply: the plan's hash and the command that applies it. */
export function pendingStop(
  session: Pick<MoveSession, "plan" | "command">,
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

/**
 * True when this run applies the hash-bound plan `hash` now: an interactive run (its approval is
 * asked for), or `--approve <hash>` names exactly it (used up here). A non-interactive run without
 * it only shows the plan and stops ({@link pendingStop}).
 */
export function appliesNow(session: Pick<PlanSession, "approve" | "deps">, hash: string): boolean {
  if (session.approve === hash) {
    session.approve = undefined;
    return true;
  }
  return session.deps.interactive;
}

const DRIFT_HINT = `The infrastructure no longer matches what OpsCrew applied. Run \`${ABORT_COMMAND}\` to undo the move, then \`opscrew drift\` to see the differences and \`opscrew provision\` to bring them back in line, and start the move again.`;

/**
 * Step 2: the moves-only plan that renames a cloud old side's server to `module.server_previous`.
 * Any other old side is an address in the move's root, with nothing to rename: the step is
 * recorded with no plan.
 */
export async function renameStep(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const move = moveOf(session);
  if (!isCloudProvider(move.from.target.provider)) {
    await saveMove(session, { ...move, step: "renamed" });
    await auditStep(session, "renamed", "nothing to rename: the old side is no server module");
    return undefined;
  }
  // The bucket the move takes along is renamed first in its own root's state.
  const bucketStop = await renameBucket(session);
  if (bucketStop !== undefined) return bucketStop;
  const old = providerWords(previousCloud(move).provider);
  deps.reporter.step(
    `Renaming the current ${old.noun} in the infrastructure state (nothing changes in your cloud)`,
  );
  const files = await useLayout(session, "rename");
  const outcome = await planThenApply(session, {
    action: "rename",
    files,
    check: planBounded({
      lead: "The rename plan would do more than rename resources in the infrastructure state, so OpsCrew stopped. Nothing was changed.",
      move: (m) =>
        m.from.startsWith("module.server.") && m.to.startsWith("module.server_previous."),
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
 * Step 3 for a cloud new side (`cloudSide`'s `prepare`): the plan that creates the new server as
 * `module.server` next to the old side; its addresses (the new provider's entry of the `servers`
 * output) go to OpsCrew's local state; then SSH, host key, cloud-init.
 */
export async function createStep(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps } = session;
  const move = moveOf(session);
  const fresh = providerWords(moveProvider(session.plan.target));
  const old = sideWords(move.from.target, "old");
  deps.reporter.step(`Creating the new ${fresh.noun} on ${fresh.name}`);
  const files = await useLayout(session, "both");
  const outcome = await planThenApply(session, {
    action: "create",
    files,
    check: planBounded({
      lead: "The plan for the new server would also change, replace or delete what is already running, so OpsCrew stopped. Nothing was changed.",
      change: (c) =>
        c.action !== "delete" &&
        c.action !== "replace" &&
        !c.address.startsWith("module.server_previous."),
      // State moves change nothing that runs.
      move: () => true,
      hint: DRIFT_HINT,
    }),
    notes: [
      `This creates the new ${fresh.noun} on ${fresh.name} next to ${old}; your app keeps running there.`,
      `The new ${fresh.noun} is billed until the move is finished or aborted: about ${formatMoney(session.plan.cost.monthly)} per month extra while both run.`,
      `Then OpsCrew deploys the app there with the deploy workflow and keeps its web server (${EDGE_PROXIES[edgeProxy(session.plan)].label}) stopped until traffic is switched to it.`,
    ],
    // `opscrew design` refuses during a move: another size means aborting and starting again.
    redesignHint: `Run \`${ABORT_COMMAND}\` (your app keeps running on ${old}), then start the move again and pick another option: \`${RUN_COMMAND} --to ${moveProvider(session.plan.target)} --option <id>\`. Nothing that was already created is removed until you abort.`,
  });
  if (outcome.kind === "pending") return pendingStop(session, outcome.planHash);
  // The new server is the one on the new provider (a move between clouds changes the provider).
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
    await recordAdopted(session);
  }
  await waitForNewServer(session, next.ipv4);
  // The new bucket, when the move takes the bucket along.
  const bucketStop = await createBucket(session);
  return bucketStop;
}

/** The new side's choices from the command line that its steps use. */
type SideChoices = Pick<RetargetOptions, "hostKey" | "passwordLogins" | "publicImage">;

/** The new side with the command line's choices and the image the old side runs. */
function newSide(session: MoveSession, options: SideChoices) {
  return moveSide(session, "new", { ...options, image: runningImage });
}

/**
 * Step 3: the new side made ready for the app through its approval (`prepare`): a cloud server's
 * IaC plan, the user's own server's host plan, the Portainer environment checked for its stacks.
 */
export async function prepareStep(
  session: MoveSession,
  options: SideChoices,
): Promise<RetargetResult | undefined> {
  const stop = await newSide(session, options).prepare(session);
  if (stop !== undefined) return stop;
  if (moveOf(session).step === "created") return undefined;
  await saveMove(session, { ...moveOf(session), step: "created" });
  await auditStep(
    session,
    "created",
    `${sideWords(session.plan.target, "new")} is ready for the app`,
  );
  return undefined;
}

/**
 * The image the old side runs (its app container's, a `ghcr.io/…@sha256:…` reference), which a
 * Portainer new side deploys: the same version on both sides.
 */
async function runningImage(session: MoveSession): Promise<string> {
  const old = moveSide(session, "old");
  const docker = await old.docker(session);
  try {
    const project = composeProject(old, session.plan);
    const [app] = await docker.client.listContainers([
      `${COMPOSE_PROJECT_LABEL}=${project}`,
      `${COMPOSE_SERVICE_LABEL}=app`,
    ]);
    const image = app?.image;
    if (image === undefined || !/^ghcr\.io\/[^@\s]+@sha256:[0-9a-f]{64}$/.test(image)) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `OpsCrew cannot tell which version of the app runs on ${sideWords(moveOf(session).from.target, "old")} (its app container runs no image from GitHub Container Registry by digest), so it did not deploy it in your Portainer.`,
        {
          hint: `Check that the app runs there, then run \`${RUN_COMMAND}\` again; \`${ABORT_COMMAND}\` undoes the move.`,
        },
      );
    }
    return image;
  } finally {
    await docker.close();
  }
}

/** How the deploy workflow reaches a side over SSH: its address and its pinned host key there. */
interface SecretsReach {
  host: string;
  port: number;
  knownHosts: string;
}

/**
 * The known_hosts lines of the user's own server, pinned under its admin login (`login`), named
 * again for where the deploy workflow reaches it: its public address on the login's port.
 */
async function ownKnownHosts(
  session: MoveSession,
  login: { host: string; port: number },
  host: string,
): Promise<string> {
  const pinned = knownHostsName(login.host, login.port);
  const text = (await readTextIfExists(session.deps.paths.files.knownHosts)) ?? "";
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([names]) => names?.split(",").includes(pinned))
    .map(([, type, key]) => `${knownHostsName(host, login.port)} ${type} ${key}`);
  if (lines.length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has not pinned your server's SSH host key on this computer, so it cannot give it to GitHub Actions' deploys. Nothing was changed.",
      { hint: `Run \`${RUN_COMMAND}\` in a terminal to confirm the key, or pass \`--host-key\`.` },
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Where the deploy workflow reaches the `which` side over SSH: a cloud server at its address with
 * its host key pinned (or checked) now, the user's own server at its public address on its
 * login's port, with the key confirmed at its inspection.
 */
async function secretsReach(session: MoveSession, which: MoveServer): Promise<SecretsReach> {
  const target = which === "new" ? session.plan.target : moveOf(session).from.target;
  const address = serverOf(session, which);
  if (isCloudProvider(target.provider)) {
    const pinned = await pinHost(session, address.ipv4, target.provider);
    return { host: address.ipv4, port: 22, knownHosts: pinned.knownHostsLines };
  }
  const local = await readServerAddresses(session.deps.paths);
  const login = which === "new" ? local.own : local.retarget?.fromOwn;
  if (login === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew does not know how to reach ${sideWords(target, which)} on this computer: its login is not in .opscrew/server.json. Nothing was changed.`,
      {
        hint: "Run the command on the computer that started the move, or copy its .opscrew/server.json here, then try again.",
      },
    );
  }
  return {
    host: address.ipv4,
    port: login.port,
    knownHosts: await ownKnownHosts(session, login, address.ipv4),
  };
}

/**
 * Stores the deploy secrets for the `which` side after the `github-secrets` approval: the new one
 * at step `deployed`, the old one on abort. A side over SSH gets the deploy key, its address and
 * pinned host key and the app's environment; the user's Portainer gets the build's values only
 * (`portainerDeploySecrets`: the app's own values live in its stack's environment there).
 */
export async function storeDeploySecrets(session: MoveSession, which: MoveServer): Promise<void> {
  const { deps } = session;
  const target = sideTarget(session, which);
  // The plan as that side runs the app: its secrets are the ones its deploy workflow reads. The
  // old side's is the bucket being left, when the move takes the bucket along.
  const leaving = which === "old" ? moveOf(session).from.objectStorage : undefined;
  const plan: DeployPlan = {
    ...session.plan,
    target,
    ...(leaving !== undefined
      ? { storage: { ...session.plan.storage, objectStorage: leaving } }
      : {}),
  };
  const words = sideWords(target, which);
  // A bucket that stays where it is (FR-1332) keeps its key (`startMove` checked it is known); a
  // bucket that moves gives each side its own bucket's login.
  const key =
    providerBucket(plan) === undefined
      ? undefined
      : await requireStorageKey(deps, plan, session.services, {
          command: session.command,
          already:
            which === "new"
              ? "The new side is ready; set the key and run the command again to continue the move."
              : "The old side runs again; set the key and run the command again to finish going back.",
        });
  const storage = key === undefined ? {} : { storage: storageLogin(plan, key, session.cloudflare) };
  const portainer = target.provider === "portainer";
  const reach = portainer ? undefined : await secretsReach(session, which);
  let environment: Awaited<ReturnType<typeof buildAppEnvironment>>;
  try {
    // Without a domain, host lists (`ALLOWED_HOSTS`) name the server these secrets point to.
    environment = await buildAppEnvironment(
      deps,
      plan,
      session.services,
      reach?.host,
      portainer ? { portainer: true, ...storage } : storage,
    );
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "INVALID_INPUT") {
      throw new OpsCrewError(error.code, error.message, {
        hint: `Add them to the file named by OPSCREW_APP_ENV_FILE, or run \`${session.command}\` in a terminal to type them in.`,
      });
    }
    throw error;
  }
  deps.reporter.step(`Pointing the GitHub deploy secrets at ${words}`);
  try {
    if (reach === undefined) {
      await setDeploySecrets(
        deps,
        session.github,
        plan,
        portainerDeploySecrets({ environment }),
        environment.names,
        "retarget",
        { record: PORTAINER_SECRETS_RECORD },
      );
    } else {
      await setDeploySecrets(
        deps,
        session.github,
        plan,
        deploySecrets({
          plan,
          host: reach.host,
          privateKey: session.deployKey.privateKeyOpenSsh,
          knownHosts: reach.knownHosts,
          environment,
          ...(session.site.edge.originTls !== undefined
            ? { originTls: originTlsSecret(session.site.values) }
            : {}),
        }),
        environment.names,
        "retarget",
        // The scheduled check reads this server's disk over SSH with its key: its reach follows.
        plan.observability?.check?.enabled === true && checkReachesOverSsh(plan)
          ? {
              checkServer: checkServerSecret([
                {
                  id: APP_SERVER,
                  host: reach.host,
                  port: reach.port,
                  user: "deploy",
                  knownHosts: reach.knownHosts,
                },
              ]),
            }
          : {},
      );
    }
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "APPROVAL_REFUSED") {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The deploy secrets were not changed, so they still point to ${which === "new" ? "the old side" : "the new side"}.`,
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
    detail: `deploy secrets point to ${words}`,
  });
}

/** Line endings and the trailing newline do not count when two workflows are compared. */
export function normalised(text: string): string {
  return text.replace(/\r\n/g, "\n").trimEnd();
}

/**
 * The file at `path` on GitHub's `branch` (what a dispatched run reads), fetched from where pushes
 * go; `undefined` when it cannot be read there.
 */
export async function fileOnGitHub(
  session: Pick<MoveSession, "deps">,
  branch: string,
  path: string,
): Promise<string | undefined> {
  const { deps } = session;
  const git = (args: string[]) => deps.runner.run("git", ["-C", deps.paths.root, ...args]);
  const url = (await git(["remote", "get-url", "--push", "origin"])).stdout.trim();
  // A URL that looks like an option is never passed as one; the remote's name is used instead.
  const remote = url === "" || url.startsWith("-") ? "origin" : url;
  if ((await git(["fetch", "--quiet", remote, `refs/heads/${branch}`])).exitCode !== 0) {
    return undefined;
  }
  const shown = await git(["show", `FETCH_HEAD:${path}`]);
  return shown.exitCode === 0 ? shown.stdout : undefined;
}

/**
 * The files a side's deploy reads from the repository: the deploy workflow and the runtime files
 * it uploads to a server (Compose files, the edge's sites) or Portainer's stack template, which
 * share the path `<runtimeDir>/compose.yaml`.
 */
function deployFiles(files: readonly RenderedFile[]): RenderedFile[] {
  return files.filter((file) => file.kind === "workflow" || file.kind === "runtime");
}

/** Where a side's deploy files stand on GitHub against the ones a plan renders. */
export type DeployFilesProposal =
  | { kind: "merged" }
  | { kind: "proposed"; merge: string; branch: string }
  | { kind: "waiting"; why: string[]; branch: string };

/**
 * Proposes `plan`'s rendered deploy files that GitHub's branch does not hold in one pull request
 * (newer action pins there, Dependabot's, are kept): `merged` when it holds them all. `waiting`
 * when an earlier run's pull request is in the way (this clone is on its branch). `login` is the
 * slot of the user's own server whose SSH port the workflow uses.
 */
export async function proposeDeployFiles(
  session: MoveSession,
  plan: DeployPlan,
  login: "own" | "fromOwn" = "own",
): Promise<DeployFilesProposal> {
  const { deps } = session;
  const branch = workflowBranch(plan, session.github.defaultBranch);
  const differing: RenderedFile[] = [];
  for (const file of deployFiles(await renderFiles(session, undefined, plan, login))) {
    const committed = await fileOnGitHub(session, branch, file.path);
    const fresh =
      committed !== undefined && file.kind === "workflow"
        ? keepNewerPins(committed, file.content)
        : file.content;
    if (committed === undefined || normalised(fresh) !== normalised(committed)) {
      differing.push(file);
    }
  }
  if (differing.length === 0) return { kind: "merged" };
  await writeRenderedFiles(deps.paths.root, differing);
  try {
    const published = await publishDeploySetup(deps, {
      git: session.git,
      github: session.github,
      plan,
      paths: differing.map((file) => file.path),
      push: true,
      phase: "retarget",
    });
    return {
      kind: "proposed",
      branch,
      merge: published.prUrl
        ? `Merge ${published.prUrl}`
        : `Push the branch ${published.branch} and merge it into ${branch}`,
    };
  } catch (error) {
    if (!(isUserFacingError(error) && error.code === "PHASE_PRECONDITION")) throw error;
    return {
      kind: "waiting",
      branch,
      why: [
        deps.redactor.redact(error.message),
        ...(error.hint !== undefined ? [deps.redactor.redact(error.hint)] : []),
      ],
    };
  }
}

/**
 * True when the move's new side renders other deploy files than the old side (the workflow's SSH
 * port or build runner's architecture, Portainer's workflow and stack template against a server's
 * Compose and edge files): GitHub's must change for the new side's deploys. Asked while the old
 * side's login is still set aside.
 */
export async function deployFilesChanged(session: MoveSession): Promise<boolean> {
  const { plan } = session;
  const move = moveOf(session);
  const oldPlan: DeployPlan = {
    ...plan,
    target: oldSideTarget(move),
    deploy: move.from.deploy,
    app: { ...plan.app, ...(move.from.build !== undefined ? { build: move.from.build } : {}) },
  };
  const old = new Map(
    deployFiles(await renderFiles(session, undefined, oldPlan, "fromOwn")).map((file) => [
      file.path,
      normalised(file.content),
    ]),
  );
  return deployFiles(await renderFiles(session)).some(
    (file) => old.get(file.path) !== normalised(file.content),
  );
}

/**
 * Before the new side's first deploy: when its deploy files (the workflow, the runtime files the
 * deploy uploads or Portainer's stack template) differ from the old side's, GitHub's branch must
 * hold the new ones first. Until it does, they go into a pull request and the move stops; the next
 * run continues once it is merged.
 */
async function deployFilesStop(session: MoveSession): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const move = moveOf(session);
  if (!(await deployFilesChanged(session))) return undefined;
  const words = sideWords(plan.target, "new");
  deps.reporter.step(`Checking the deploy files for ${words} on GitHub`);
  const proposal = await proposeDeployFiles(session, plan);
  if (proposal.kind === "merged") return undefined;
  const differs = `The deploy files for ${words} differ from those on ${proposal.branch}`;
  return {
    step: move.step,
    done: false,
    next:
      proposal.kind === "waiting"
        ? [
            `${differs}, and they are not merged yet: ${proposal.why.join(" ")}`,
            `Once they are merged, run \`${RUN_COMMAND}\` again to deploy the app there and continue the move.`,
          ]
        : [
            `${differs}. ${proposal.merge}: once it is merged, every push deploys to ${words}, where the deploy secrets point now.`,
            `Then run \`${RUN_COMMAND}\` again to deploy the app there and continue the move (\`${ABORT_COMMAND}\` undoes it).`,
          ],
  };
}

/** Dispatches the deploy workflow on the plan's branch and waits for it to succeed. */
async function runDeployWorkflow(session: MoveSession): Promise<void> {
  const { deps, plan, githubApi } = session;
  const { owner, repo } = session.github;
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const branch = plan.cicd.branch;
  const words = sideWords(plan.target, "new");
  const oldStill = `The app on ${sideWords(moveOf(session).from.target, "old")} still serves your users.`;
  deps.reporter.step(`Running the deploy workflow (${workflowFile} on ${branch}) for ${words}`);
  let run: Awaited<ReturnType<typeof githubApi.waitForWorkflowRun>>;
  try {
    // Recorded as soon as GitHub accepts the dispatch, before any wait for its run.
    const { runId } = await githubApi.dispatchWorkflow(owner, repo, workflowFile, branch, {}, () =>
      auditMove(session, {
        kind: "provider-call",
        action: "dispatch workflow",
        target: `${owner}/${repo}`,
        detail: `${workflowFile} on ${branch}`,
      }),
    );
    run = await githubApi.waitForWorkflowRun(owner, repo, {
      workflowFile,
      ref: branch,
      runId,
      timeoutMs: WORKFLOW_WAIT_MS,
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
        hint: `Open the run to see what failed and push a fix (deploys now go to ${words}), then run \`${RUN_COMMAND}\` again. To go back instead, run \`${ABORT_COMMAND}\`.`,
      },
    );
  }
  deps.reporter.success(`The deploy workflow succeeded (${run.htmlUrl}).`);
}

/**
 * `.opscrew/retarget-deployed.json`: the move (its `startedAt`) whose new side the deploy workflow
 * deployed, while step `deployed` is not recorded yet. Machine-local.
 */
function deployedFile(session: Pick<MoveSession, "deps">): string {
  return join(session.deps.paths.stateDir, "retarget-deployed.json");
}

/** True when the deploy workflow already deployed this move's new side. */
async function deployedInThisMove(session: MoveSession): Promise<boolean> {
  const startedAt = await readValidJson(deployedFile(session), z.string());
  return startedAt === moveOf(session).startedAt;
}

/**
 * Step 4: with a private network, the new app server joins it first (`joinMoveNetwork`); the
 * deploy secrets point to the new side (a server's over SSH, or the build values for
 * the user's Portainer); deploy files that differ for the new side wait for their pull request
 * first; then the new side's deploy: on a server the deploy workflow puts the app there,
 * and the side checks it and stops its edge until the switch; in Portainer its stacks are applied
 * with the version the old side runs; then self-hosted monitoring's host plans for the new app
 * server (`moveMonitoring`).
 */
export async function deployStep(
  session: MoveSession,
  options: SideChoices,
): Promise<RetargetResult | undefined> {
  const { deps, plan } = session;
  const side = newSide(session, options);
  const portainer = side.kind === "portainer";
  if (!portainer && session.servers.next === undefined) {
    // A step `created` always has the address; the create step reads it from the state again.
    await saveMove(session, { ...moveOf(session), step: "renamed" });
    return { step: "renamed", done: false, next: [`Run \`${RUN_COMMAND}\` again.`] };
  }
  // The new app server joins the private network before the deploy, so the app reaches its
  // services on the extra servers.
  const joined = await joinMoveNetwork(session);
  if (joined !== undefined) return joined;
  const words = sideWords(plan.target, "new");
  const where = {
    host: portainer ? PORTAINER_SECRETS_RECORD : newServer(session).ipv4,
    owner: session.github.owner,
    repo: session.github.repo,
  };
  if (await deploySecretsStoredFor(deps, plan, where)) {
    deps.reporter.info(`The GitHub deploy secrets already point to ${words}.`);
  } else {
    await storeDeploySecrets(session, "new");
  }
  const pending = await deployFilesStop(session);
  if (pending !== undefined) return pending;
  // A script that stopped after the deploy (at a host plan's hash) does not deploy again.
  if (!portainer && !(await deployedInThisMove(session))) {
    await runDeployWorkflow(session);
    await writeFileAtomic(deployedFile(session), `${JSON.stringify(moveOf(session).startedAt)}\n`);
  }
  const stop = await side.deploy(session);
  if (stop !== undefined) return stop;
  // Self-hosted monitoring on the new app server (and the stack's own server), once the deploy
  // made the networks Alloy joins; the other servers' Alloy follows after the window.
  const stack = monitoringServerName(plan);
  if (stack !== undefined) {
    const monitored = await moveMonitoring(session, plan, () => sideServer(session, "new"), {
      servers: [APP_SERVER, stack],
    });
    if (monitored !== undefined) return monitored;
  }
  // The bucket's first copy, before the maintenance window (which copies only what changed).
  const bucket = movingBucket(plan);
  if (bucket !== undefined) await copyBucket(session, "copy", await bucketKeys(session, bucket));
  await saveMove(session, { ...moveOf(session), step: "deployed" });
  await rm(deployedFile(session), { force: true });
  deps.reporter.success(`The app runs on ${words}; the old side still serves users.`);
  await auditStep(session, "deployed", `app deployed and healthy on ${words}`);
  return undefined;
}
