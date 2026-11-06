import { appDirs, hostPlanHash, otherActiveApps, planTeardown } from "@opscrew/connector-ssh-host";
import { listText, plural } from "@opscrew/core";
import { serverData } from "../../destroy/checks";
import { confirmDeletion } from "../../destroy/deletion";
import { applyHostPlanApproved, type OwnHost } from "../../destroy/own";
import { project } from "../../destroy/servers";
import type { DestroyPreview } from "../../destroy/types";
import { requireNoForeignPreviews } from "../../previews/host";
import { edgeSwitch, readEdgeOver } from "../../provision/origin-tls";
import { applyOwnHostPlan, prepareOwnServer } from "../../provision/own";
import type { ProvisionOptions, ProvisionServices } from "../../provision/types";
import { lazyRepository } from "../../runners";
import { adapterBlocked, approveAndApplyHostPlan, boundHostAdapter } from "../../shared";
import {
  connectAndInspectOwnServer,
  ownServerLoginCheck,
  requireOwnServerRecord,
} from "../../shared/own-server";
import type { MoveServer } from "../removal";
import { auditStep, type MoveSession, moveOf, recordNewServer, saveMove } from "../session";
import { appliesNow, pendingStop } from "../steps";
import { sshSide } from "./ssh";
import type { MoveSide, SideStop } from "./types";

/** What an own side reaches the server with: the host adapter and logins (fakes in tests). */
export type OwnSideServices = Pick<ProvisionServices, "own" | "runnerGitHub">;

/** A new own side's choices from the command line (a script's `--host-key`, `--password-logins`). */
export type OwnSideOptions = Pick<ProvisionOptions, "hostKey" | "passwordLogins">;

/** Said wherever the app comes off a server the user owns. */
const SERVER_STAYS =
  "Your server itself stays: OpsCrew never deletes, rebuilds or reinstalls it, and leaves its own host settings (Docker, the deploy user, SSH and the firewall) as they are.";

/**
 * A side that is a server the user owns (`which`: the old one or the new one), reached over SSH:
 * as `deploy` with the deploy key for the app, as the user's admin login for its host plans. The
 * new side's login is `.opscrew/server.json`'s `own`, the old side's `retarget.fromOwn`.
 * - `prepare` connects, inspects and refuses what provision refuses (another app's name or
 *   hostnames, another proxy shared with other apps, foreign previews, the wrong architecture…),
 *   then applies the own host plan by its hash, setting the app up beside any other apps;
 * - `deploy` waits for the app's health route and stops the edge, unless other apps share it;
 * - `remove` takes only the app off the server with a teardown host plan that deletes its data,
 *   after the typed app name, approved with `allowDestroy`. Never the undo host plan.
 */
export function ownSide(
  which: MoveServer,
  services: OwnSideServices = {},
  options: OwnSideOptions = {},
): MoveSide {
  const login = which === "new" ? "own" : "fromOwn";
  const own = services.own ?? {};
  const ssh = sshSide({
    which,
    words: () => `your ${which} server`,
    login: async (session) => {
      const connection = await requireOwnServerRecord(session.deps.paths, login);
      return { host: connection.host, port: connection.port };
    },
    sharedEdge: true,
    // The server's record names the app that turned the monitoring stack on.
    ownsMonitoring: async (session) => {
      const { facts } = await connectAndInspectOwnServer(session.deps, {
        services: { ...own, host: boundHostAdapter(own.host) },
        phase: "retarget",
        login,
        detail: "whose the monitoring stack is",
      });
      return facts.record?.addons?.monitoring === session.plan.app.name;
    },
  });
  return {
    kind: "own",
    ...ssh,
    prepare: (session) => prepare(session, services, options),
    remove: (session, confirm) => remove(session, which, services, confirm),
  };
}

/**
 * Step `created` on a server the user owns: connected (pinned host key) and inspected, checked as
 * provision checks it before any change, then the own host plan, shown and approved by its hash
 * (`host-apply`). A script stops with the hash. The server's public address becomes the move's new
 * address.
 */
async function prepare(
  session: MoveSession,
  services: OwnSideServices,
  options: OwnSideOptions,
): Promise<SideStop> {
  const { deps, plan, command } = session;
  const deployPublicKey = session.deployKey.publicKeyOpenSsh;
  const run = await prepareOwnServer(deps, {
    plan,
    options,
    services: {
      ...services,
      ...(session.services.cloudflare !== undefined
        ? { cloudflare: session.services.cloudflare }
        : {}),
    },
    deployPublicKey,
    deployKeyFile: session.deployKey.privateKeyFile,
    phase: "retarget",
    command,
  });
  await requireNoForeignPreviews(deps.paths, plan, run.facts, command);
  // The proxy every OpsCrew app on the server shares: another one is refused while others are there.
  const others = otherActiveApps(run.facts.apps, plan.app.name).map((record) => record.app);
  const edgeNote = edgeSwitch(
    plan,
    await readEdgeOver(deps, run.session.remote, plan.app.name),
    others,
  );
  if (edgeNote !== undefined) deps.reporter.warn(edgeNote);

  // A script without `--approve` only sees the plan; `--approve` naming it is used up here.
  const planOnly = !deps.interactive && session.approve === undefined;
  const outcome = await applyOwnHostPlan(deps, run, {
    plan,
    outputs: {},
    deployPublicKey,
    ...(options.passwordLogins !== undefined ? { passwordLogins: options.passwordLogins } : {}),
    phase: "retarget",
    command,
    planOnly,
    shown: (hash) => {
      if (session.approve === hash) session.approve = undefined;
    },
  });
  if (planOnly && outcome.plan.steps.some((step) => step.state === "change")) {
    return pendingStop(session, outcome.hash);
  }
  // Public mode always has the address DNS points to (prepareOwnServer stops without one). It goes
  // to OpsCrew's local state, beside the old side's set-aside login.
  if (run.address !== undefined) {
    await recordNewServer(session, run.address);
  }
  await saveMove(session, { ...moveOf(session), step: "created" });
  await auditStep(session, "created", "your new server is ready for the app");
  return undefined;
}

/**
 * `--finish` (the old side) and `--abort` (the new side) on a server the user owns: the teardown
 * host plan of the app with its data, after the typed app name, approved by its hash with
 * `allowDestroy`. Only the app's own parts go (with the last OpsCrew app on the server, the shared
 * edge too); the server and OpsCrew's host settings stay. A script stops with the hash.
 */
async function remove(
  session: MoveSession,
  which: MoveServer,
  services: OwnSideServices,
  confirm: (preview: DestroyPreview) => Promise<boolean>,
): Promise<SideStop> {
  const { deps, plan, command } = session;
  const app = plan.app.name;
  const words = `your ${which} server`;
  const own = services.own ?? {};
  const adapter = boundHostAdapter(own.host);
  const { session: ssh, facts } = await connectAndInspectOwnServer(deps, {
    services: { ...own, host: adapter },
    phase: "retarget",
    login: which === "new" ? "own" : "fromOwn",
  });
  const teardown = planTeardown(
    facts,
    { deleteData: true, app, projectId: deps.paths.projectId, ...(await project(deps)) },
    command,
  );
  const blocked = teardown.steps.filter((step) => step.state === "blocked");
  if (teardown.findings.length > 0 || blocked.length > 0) {
    throw adapterBlocked({
      cannot: `OpsCrew cannot remove ${app} from ${words}`,
      nothing: "changed nothing there",
      findings: teardown.findings,
      blocked,
      fallbackHint: `Fix what blocks these steps on the server, then run \`${command}\` again.`,
    });
  }
  const changes = teardown.steps.filter((step) => step.state === "change");
  if (changes.length === 0) {
    deps.reporter.info(`Nothing of ${app} is left on ${words}.`);
    return undefined;
  }
  const data = [...serverData(plan), `what it stored in ${appDirs(app).data} and in its volumes`];
  const dataWarning =
    which === "old"
      ? `Removing the app from ${words} deletes its data there: ${listText(data)}. The move copied it to the new side, where the app runs now; OpsCrew takes no snapshot of your own server.`
      : `Removing the app from ${words} deletes its data there: ${listText(data)}. That is the move's copy; the app and its data stay on the old side.`;
  const hostSteps = changes.map((step) => step.title);
  deps.reporter.info(
    [`This removes ${app} from ${words}:`, ...hostSteps.map((title) => `  - ${title}`)].join("\n"),
  );
  deps.reporter.warn(dataWarning);
  await confirmDeletion(
    {
      deps,
      provider: "own",
      app,
      command,
      what: `removal of ${app} from ${words}`,
      phase: "retarget",
    },
    {
      name: app,
      provider: "own",
      deleteProtection: false,
      resources: [],
      snapshot: false,
      dataWarning,
      hostSteps,
    },
    confirm,
  );

  const host: OwnHost = {
    session: ssh,
    apply: adapter.apply,
    verifyLogin:
      own.verifyLogin ??
      ownServerLoginCheck(deps, ssh, {
        deployKeyFile: session.deployKey.privateKeyFile,
        ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
      }),
    repository: lazyRepository(deps, services.runnerGitHub),
  };
  const title = `Remove ${app} from ${words} with its data (${plural(changes.length, "change")})`;
  const intro = [
    `This removes ${app} from ${words}, including its data.`,
    dataWarning,
    SERVER_STAYS,
  ];
  if (
    teardown.steps.some((step) => step.state === "change") &&
    !appliesNow(session, hostPlanHash(teardown))
  ) {
    // Shown and saved for `--approve <hash>`; the typed name comes with `--confirm`.
    const shown = await approveAndApplyHostPlan(deps, {
      plan: teardown,
      remote: ssh.remote,
      apply: host.apply,
      verifyLogin: host.verifyLogin,
      title,
      server: words,
      upToDate: `Nothing on ${words} needs to change.`,
      command,
      phase: "retarget",
      allowDestroy: true,
      confirmPhrase: app,
      intro,
      planOnly: true,
      secrets: async () => ({}),
    });
    return pendingStop(session, shown.hash, ["--confirm", app]);
  }
  const outcome = await applyHostPlanApproved(deps, host, teardown, {
    deployPlan: plan,
    name: app,
    title,
    intro,
    refused: `The removal of ${app} from ${words} was not approved, so nothing on it was changed.`,
    command,
  });
  deps.reporter.success(
    `Removed ${app} from ${words} (${plural(outcome.steps.length, "change")}).`,
  );
  return undefined;
}
