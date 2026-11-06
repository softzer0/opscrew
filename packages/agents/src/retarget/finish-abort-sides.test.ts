import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { appDir, portainerTarget } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { DestroyPreview } from "../destroy/types";
import {
  everythingShown,
  forbiddenIn,
  PortainerLifecycleGitHub,
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
} from "../drift/__fixtures__/portainer-project";
import {
  deployBranchOf,
  ensureDeployKey,
  type OwnServerConnectionInput,
  readServerAddresses,
  recordOwnServer,
  restoreOldConnection,
  setAsideOldConnection,
} from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  FakeHosts,
  LAN_IPV4,
  type MoveEvent,
  movePlan,
  OWN_IPV4,
  ownPlan,
  ownRunner,
  preparedServerFacts,
  ScriptedApprovalHandler,
} from "../testing";
import { removeNewSide, reportAborted } from "./abort";
import { deleteOldDeployBranch, removeOldSide } from "./finish";
import type { MoveSession } from "./session";
import { cloudProviders, moveSide } from "./sides";
import type { RetargetResult } from "./types";

/** An approval handler's answer to a request. */
type Answer = boolean | { approved: boolean; confirmation?: string | undefined };

/** Approves everything, typing the app's name for a deletion. */
function approveAll(request: ApprovalRequest): Answer {
  return request.allowDestroy ? { approved: true, confirmation: request.confirmPhrase } : true;
}

/** A plan moving from `from` to `to`, at `step`. */
function moving(from: DeployPlan, to: DeployPlan, step: "created" | "switched"): DeployPlan {
  return DeployPlanSchema.parse({
    ...to,
    retarget: { from: { target: from.target }, step, startedAt: "2026-11-05T12:00:00.000Z" },
  });
}

/** The typed confirmations a run asked for, answered `answer`. */
function typed(answer = true) {
  const previews: DestroyPreview[] = [];
  return {
    previews,
    confirm: async (preview: DestroyPreview) => {
      previews.push(preview);
      return answer;
    },
  };
}

/** The side's removal as `--finish` (old) or `--abort` (new) runs it, typed name given; a stop. */
async function removeSide(
  session: MoveSession,
  which: "old" | "new",
): Promise<RetargetResult | undefined> {
  const confirm = async () => true;
  if (which === "new") return removeNewSide(session, { confirm });
  const removed = await removeOldSide(session, { confirm });
  return "stop" in removed ? removed.stop : undefined;
}

describe("moveSide", () => {
  const session = (plan: DeployPlan) =>
    ({ plan, services: {}, deps: { paths: {} } }) as unknown as MoveSession;
  const cloud = movePlan();
  const own = ownPlan();
  const portainer = portainerPlan();

  it("picks each side by its target, and only cloud sides need provider tokens", () => {
    for (const [from, to, kinds, providers] of [
      [cloud, own, ["cloud", "own"], ["hetzner"]],
      [own, cloud, ["own", "cloud"], ["hetzner"]],
      [portainer, own, ["portainer", "own"], []],
      [cloud, portainer, ["cloud", "portainer"], ["hetzner"]],
    ] as const) {
      const s = session(moving(from, to, "created"));
      expect([moveSide(s, "old").kind, moveSide(s, "new").kind]).toEqual(kinds);
      expect(cloudProviders(s)).toEqual(providers);
    }
  });
});

/** The new own server's login, its host key pinned. */
const NEW_LOGIN: OwnServerConnectionInput = {
  host: OWN_IPV4,
  port: 22,
  user: "root",
  agent: true,
  reachable: true,
  hostKey: ED25519_FINGERPRINT,
};
/** The old own server's login. */
const OLD_LOGIN: OwnServerConnectionInput = { ...NEW_LOGIN, host: LAN_IPV4, port: 2222 };

/**
 * A move to or from a server the user owns (`which`: the own side), the other side a cloud
 * server, with the app set up there.
 */
async function ownMove(which: "old" | "new", interactive = true) {
  const plan =
    which === "old"
      ? moving(ownPlan({ deployed: true }), movePlan(), "switched")
      : moving(movePlan(), ownPlan({ deployed: true }), "created");
  const project = await createProject(plan);
  const handler = new ScriptedApprovalHandler(approveAll);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: { ...process.env, OPSCREW_HOME: join(project.root, ".home-opscrew") },
    runner: ownRunner(),
    approvalHandler: handler,
    interactive,
  });
  if (which === "old") {
    await recordOwnServer(deps.paths, OLD_LOGIN);
    await setAsideOldConnection(deps.paths, "own");
  } else {
    await recordOwnServer(deps.paths, NEW_LOGIN);
  }
  const host = new FakeHostServer(preparedServerFacts(deps.paths.projectId));
  const session = {
    deps,
    plan,
    services: { own: { host, homeDir: await mkdtemp(join(tmpdir(), "opscrew-own-home-")) } },
    deployKey: await ensureDeployKey(deps.paths, deps.redactor),
    servers: {},
    command: which === "old" ? "opscrew retarget --finish" : "opscrew retarget --abort",
    approve: undefined,
  } as unknown as MoveSession;
  return { deps, plan, handler, host, session };
}

/** SC-2304 on the user's own server: only the app's teardown host plan, never an undo. */
function expectOnlyTheApp(s: Awaited<ReturnType<typeof ownMove>>) {
  expect(s.host.applies.map((a) => a.plan.purpose)).toEqual(["teardown"]);
  expect(s.host.applies[0]?.plan.app).toBe("shop");
  const request = s.handler.requests.find((r) => r.kind === "host-apply");
  expect(request).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
  expect(request?.details).toContain("Your server itself stays");
  // No IaC plan or provider call deletes the server: nothing but the host plan was asked for.
  expect(s.handler.requests.map((r) => r.kind)).toEqual(["host-apply"]);
}

describe.skipIf(!findExecutable("git"))("--finish and --abort on a server the user owns", () => {
  it("--finish takes only the app off the old server, after the typed name (SC-2304)", async () => {
    const s = await ownMove("old");
    const name = typed();
    expect(await removeOldSide(s.session, { confirm: name.confirm })).toEqual({
      snapshotId: undefined,
    });
    expect(name.previews).toMatchObject([{ name: "shop", provider: "own", resources: [] }]);
    expectOnlyTheApp(s);
  });

  it("--abort takes only the app off the new server, recording the abort at the typed name (SC-2304)", async () => {
    const s = await ownMove("new");
    // The abort is on record before the teardown changes the server.
    const recorded: unknown[] = [];
    const apply = s.host.apply.bind(s.host);
    s.host.apply = async (...args) => {
      recorded.push((await readArtifact("plan", s.deps.paths.files.plan)).retarget?.abort);
      return apply(...args);
    };
    const name = typed();
    expect(await removeNewSide(s.session, { confirm: name.confirm })).toBeUndefined();
    expectOnlyTheApp(s);
    expect(recorded).toEqual([{ step: "started" }]);
    expect(s.deps.audit.entries.some((e) => e.action === "retarget abort started")).toBe(true);
  });

  it("deletes nothing and records no abort when the name is not typed, or no one is asked", async () => {
    for (const confirm of [typed(false).confirm, undefined]) {
      const s = await ownMove("new");
      await expect(removeNewSide(s.session, { confirm })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
      });
      expect(s.host.applies).toEqual([]);
      expect((await readArtifact("plan", s.deps.paths.files.plan)).retarget?.abort).toBeUndefined();
      const f = await ownMove("old");
      await expect(removeOldSide(f.session, { confirm })).rejects.toMatchObject({
        code: "APPROVAL_REFUSED",
      });
      expect(f.host.applies).toEqual([]);
    }
  });

  it("a script stops with --confirm and --approve, then removes the app once both are given", async () => {
    for (const which of ["old", "new"] as const) {
      const s = await ownMove(which, false);
      const stop = await removeSide(s.session, which);
      const hash = stop?.pendingPlanHash as string;
      expect(stop?.next.join(" ")).toContain(`--confirm shop --approve ${hash}`);
      expect(s.host.applies).toEqual([]);
      s.session.approve = hash;
      expect(await removeSide(s.session, which)).toBeUndefined();
      expect(s.host.applies.map((a) => a.options.approvedHash)).toEqual([hash]);
    }
  });

  it("leaks no address or key into output, audit entries or approvals", async () => {
    const texts: string[] = [];
    for (const which of ["old", "new"] as const) {
      const s = await ownMove(which);
      await removeSide(s.session, which);
      const key = await readFile(s.session.deployKey.privateKeyFile, "utf8");
      texts.push(key.trim());
      texts.push(
        `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}\n${JSON.stringify(s.handler.requests)}`,
      );
    }
    const [oldKey, oldSeen, newKey, newSeen] = texts as [string, string, string, string];
    for (const seen of [oldSeen, newSeen]) {
      for (const secret of [OWN_IPV4, LAN_IPV4, oldKey, newKey]) expect(seen).not.toContain(secret);
    }
  });

  it("after an abort, checks the app on the old server through its restored login and never says its address", async () => {
    for (const answers of [false, true]) {
      const s = await ownMove("old");
      // As the abort leaves it: the login back in its usual slot, the plan's target the old server.
      await restoreOldConnection(s.deps.paths, { from: "own", to: "hetzner" });
      const { retarget: _aborted, ...restored } = s.plan;
      s.session.plan = DeployPlanSchema.parse({ ...restored, target: ownPlan().target });
      const events: MoveEvent[] = [];
      const hosts = new FakeHosts(events);
      if (answers) hosts.deploy(LAN_IPV4);
      s.session.services = { ...s.session.services, remote: hosts.remote };
      await reportAborted(s.session, { ipv4: OWN_IPV4 });
      // The health check reached the restored login's host.
      expect(events).toContainEqual(expect.objectContaining({ host: LAN_IPV4, op: "health" }));
      const text = s.deps.reporter.text();
      expect(text).toContain(
        answers
          ? "The move is aborted; shop runs on your old server."
          : `does not answer its health check. Check it over your SSH login to that server with \`cd ${appDir(s.session.plan)} && docker compose ps\`.`,
      );
      for (const address of [OWN_IPV4, LAN_IPV4]) expect(text).not.toContain(address);
      expect(text).not.toContain("ssh deploy@");
    }
  });
});

/** GitHub with branch deletion, as the real client has it. */
class BranchGitHub extends PortainerLifecycleGitHub {
  readonly deletedBranches: string[] = [];
  /** Thrown by `deleteBranch`, as an unreachable or refusing GitHub would. */
  fail: Error | undefined;
  async deleteBranch(_owner: string, _repo: string, branch: string) {
    if (this.fail !== undefined) throw this.fail;
    this.deletedBranches.push(branch);
    return "deleted" as const;
  }
}

/** A user's own stack and volume next to OpsCrew's in the environment: never touched. */
const DECOY = {
  Id: 9,
  Name: "media",
  Type: 2,
  EndpointId: 3,
  Status: 1,
  Env: [],
  DeploymentStatus: [],
  file: "services:\n  media:\n    image: jellyfin/jellyfin\n",
};

/**
 * A move from (`which: "old"`) or to (`"new"`) the user's Portainer, with the app's stacks
 * provisioned there and its deploy branch written; the other side a cloud server.
 */
async function portainerMove(
  which: "old" | "new",
  interactive = true,
  answer: (request: ApprovalRequest) => Answer = approveAll,
) {
  const base = portainerPlan();
  const s = await portainerProject({ plan: base, portainer: { stacks: [DECOY] }, answer });
  await provisionPortainerProject(s);
  s.fake.volumes.push(
    ...["opscrew-shop_db_data", "opscrew-shop_version"].map((Name) => ({
      Name,
      Labels: { "com.docker.compose.project": "opscrew-shop" },
    })),
    { Name: "media_data", Labels: { "com.docker.compose.project": "media" } },
  );
  const plan =
    which === "old" ? moving(base, movePlan(), "switched") : moving(movePlan(), base, "created");
  if (which === "old") await setAsideOldConnection(s.deps.paths, "portainer");
  s.deps.interactive = interactive;
  const github = new BranchGitHub(s.bare);
  const session = {
    deps: s.deps,
    plan,
    services: { portainer: s.services.portainer },
    github: { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
    githubApi: github,
    command: which === "old" ? "opscrew retarget --finish" : "opscrew retarget --abort",
    approve: undefined,
  } as unknown as MoveSession;
  return { ...s, base, plan, github, session };
}

/** SC-2304 in the user's Portainer: only the app's stacks and volumes, never the environment. */
function expectOnlyTheStacks(s: Awaited<ReturnType<typeof portainerMove>>) {
  expect(s.fake.stacks.map((stack) => stack.Name)).toEqual(["media"]);
  expect(s.fake.volumes.map((volume) => volume.Name)).toEqual(["media_data"]);
  expect(
    s.fake.calls.filter((call) => /^(DELETE|PUT|POST) \/api\/endpoints\/\d+(\?|$)/.test(call)),
  ).toEqual([]);
  expect(s.handler.requests.find((r) => r.kind === "stack-apply")).toMatchObject({
    allowDestroy: true,
    confirmPhrase: "shop",
  });
}

describe.skipIf(!findExecutable("git"))("--finish and --abort in the user's Portainer", () => {
  it("--finish removes only the app's stacks and volumes, then deletes the old deploy branch (SC-2304)", async () => {
    const s = await portainerMove("old");
    const name = typed();
    expect(await removeOldSide(s.session, { confirm: name.confirm })).toEqual({
      snapshotId: undefined,
    });
    expect(name.previews[0]).toMatchObject({ name: "shop", provider: "portainer" });
    expectOnlyTheStacks(s);
    expect(
      (await readServerAddresses(s.deps.paths)).retarget?.fromPortainer?.created.stacks,
    ).toEqual([]);

    const branch = deployBranchOf(s.base);
    expect(await deleteOldDeployBranch(s.session, portainerTarget(s.base.target))).toBeUndefined();
    expect(s.github.deletedBranches).toEqual([branch]);
    const approval = s.handler.requests.at(-1);
    expect(approval).toMatchObject({
      kind: "git-push",
      title: `Delete the branch ${branch} in acme/shop`,
    });
    expect(s.deps.audit.entries.at(-1)).toMatchObject({
      kind: "git",
      action: "delete branch",
      target: `acme/shop:${branch}`,
    });
  });

  it("keeps the deploy branch when its deletion is refused, and says how to delete it", async () => {
    let refuse = false;
    const s = await portainerMove("old", true, (request) =>
      refuse && request.kind === "git-push" ? false : approveAll(request),
    );
    refuse = true;
    const left = await deleteOldDeployBranch(s.session, portainerTarget(s.base.target));
    expect(left).toContain(`git push origin --delete ${deployBranchOf(s.base)}`);
    expect(s.github.deletedBranches).toEqual([]);
  });

  it("warns and keeps going when GitHub fails to delete the deploy branch", async () => {
    const s = await portainerMove("old");
    s.github.fail = new OpsCrewError("PROVIDER_ERROR", "GitHub is unreachable.");
    const left = await deleteOldDeployBranch(s.session, portainerTarget(s.base.target));
    expect(left).toContain(`git push origin --delete ${deployBranchOf(s.base)}`);
    expect(s.deps.reporter.text()).toContain(
      `deleting the branch ${deployBranchOf(s.base)} of acme/shop failed: GitHub is unreachable.`,
    );
  });

  it("--abort removes only the app's stacks and volumes, recording the abort at the typed name (SC-2304)", async () => {
    const s = await portainerMove("new");
    expect(await removeNewSide(s.session, { confirm: async () => true })).toBeUndefined();
    expectOnlyTheStacks(s);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).retarget?.abort).toEqual({
      step: "started",
    });
  });

  it("a script stops with --confirm and --approve, then removes the stacks once both are given", async () => {
    for (const which of ["old", "new"] as const) {
      const s = await portainerMove(which, false);
      const stop = await removeSide(s.session, which);
      const hash = stop?.pendingPlanHash as string;
      expect(stop?.next.join(" ")).toContain(`--confirm shop --approve ${hash}`);
      expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop");
      s.session.approve = hash;
      expect(await removeSide(s.session, which)).toBeUndefined();
      expectOnlyTheStacks(s);
      // The teardown applied is the one the script approved.
      expect(s.handler.requests.find((r) => r.kind === "stack-apply")?.planHash).toBe(hash);
    }
  });

  it("never shows the token, a password or Portainer's address", async () => {
    for (const which of ["old", "new"] as const) {
      const s = await portainerMove(which);
      await removeSide(s.session, which);
      if (which === "old") await deleteOldDeployBranch(s.session, portainerTarget(s.base.target));
      const shown = await everythingShown(s);
      for (const secret of forbiddenIn(s)) expect(shown).not.toContain(secret);
    }
  });
});
