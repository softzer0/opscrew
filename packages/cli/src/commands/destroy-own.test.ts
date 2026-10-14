import path from "node:path";
import type { DestroyServices } from "@opscrew/agents";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { type DeployProject, deployProject } from "../ui/__fixtures__/deploy";
import { CANCEL, GIT, projectContext, run, ScriptedPrompts } from "../ui/__fixtures__/harness";
import {
  FakeHost,
  fakeHome,
  OWN_FINGERPRINT,
  OwnRunner,
  ownPlan,
  ownServices,
  preparedFacts,
  recordOwnLogin,
} from "../ui/__fixtures__/own";
import { withDeployServices } from "../ui/deploy-services";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Records what reaches the base handler (after the typed-name handler) and answers `answer`. */
class BaseApprovals implements ApprovalHandler {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answer: (request: ApprovalRequest) => boolean = () => false) {}
  async request(request: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(request);
    return {
      approved: this.answer(request),
      approver: "test",
      decidedAt: "2026-10-14T12:00:00.000Z",
    };
  }
}

interface Options {
  interactive?: boolean;
  typed?: unknown[];
  /** Replaces the real `--approve` handler (the default keeps it, so hashes are checked). */
  approvals?: ApprovalHandler;
}

/** A deployed app on the user's own server (no Cloudflare), its login and pinned host key recorded. */
async function setup(options: Options = {}) {
  project = await deployProject(ownPlan({ domain: null, deployed: true }));
  await recordOwnLogin(project, { hostKey: OWN_FINGERPRINT });
  const paths = resolveProjectPaths(project.root, { env: project.env });
  const host = new FakeHost(preparedFacts(paths.projectId));
  const prompts = new ScriptedPrompts(options.typed ?? []);
  const deletedSecrets: string[] = [];
  const own = ownServices(host, await fakeHome(project));
  const services: DestroyServices = {
    own,
    cloudflare: null,
    github: {
      deleteActionsSecret: async (_owner, _repo, name) => {
        deletedSecrets.push(name);
      },
    },
  };
  const context = () => {
    const ctx = projectContext(project as DeployProject, {
      interactive: options.interactive ?? false,
      services: {
        runner: new OwnRunner(),
        prompts,
        ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
      },
    });
    withDeployServices(ctx, { destroy: services });
    return ctx;
  };
  return { context, host, prompts, deletedSecrets, paths };
}

const purposes = (host: FakeHost) => host.applies.map((apply) => apply.plan.purpose);

describe.skipIf(!GIT)("opscrew destroy on a server the user owns", () => {
  it("asks for the app's name with the agents' prompt and removes only the app", async () => {
    // The human approves removing the deploy secrets; every other approval is refused.
    const base = new BaseApprovals((request) => request.kind === "github-secrets");
    const s = await setup({ interactive: true, typed: ["shop"], approvals: base });
    const ctx = s.context();
    expect(await run(ctx, "destroy"), ctx.errors).toBe(0);
    expect(base.requests.map((r) => r.kind)).toEqual(["github-secrets"]);
    expect(s.prompts.calls[0]?.message).toContain("Type shop (the app's name)");
    expect(s.prompts.calls[0]?.message).toContain("your server itself stays");
    expect(purposes(s.host)).toEqual(["teardown"]);
    expect(ctx.output).toContain("(confirmed with the app's name)");
    expect(ctx.output).toContain("back up anything on it yourself");
    expect(s.deletedSecrets).toContain("OPSCREW_SSH_PRIVATE_KEY");
    const plan = await readArtifact("plan", path.join(s.paths.root, "opscrew", "plan.yaml"));
    expect(plan.approvals.at(-1)).toMatchObject({ kind: "host-apply", approver: "typed app name" });
  });

  it("changes nothing when the typed name is wrong or cancelled", async () => {
    for (const typed of ["shopx", CANCEL]) {
      const s = await setup({ interactive: true, typed: [typed], approvals: new BaseApprovals() });
      const ctx = s.context();
      expect(await run(ctx, "destroy")).toBe(1);
      expect(s.host.applies).toEqual([]);
      await project?.cleanup();
      project = undefined;
    }
  });

  it("--confirm <app> in a script approves the teardown; --undo-host needs its own --approve <hash>", async () => {
    const s = await setup();
    const first = s.context();
    expect(await run(first, "destroy", "--confirm", "shop", "--undo-host")).toBe(1);
    // The app is removed (typed name), the undo plan was refused: it needs its own approval.
    expect(purposes(s.host)).toEqual(["teardown"]);
    expect(first.errors).toContain("Undoing OpsCrew's changes to your server was not approved");
    const undoHash = /Host plan hash: ([0-9a-f]{64})/g;
    const hashes = [...first.output.matchAll(undoHash)].map((m) => m[1] as string);
    const undo = hashes.at(-1) as string;

    // --yes does not exist here, and a wrong hash grants nothing.
    const wrong = s.context();
    const other = "0".repeat(64);
    expect(
      await run(wrong, "destroy", "--confirm", "shop", "--undo-host", "--approve", other),
    ).toBe(1);
    expect(purposes(s.host)).toEqual(["teardown"]);

    const second = s.context();
    const args = ["destroy", "--confirm", "shop", "--undo-host", "--approve", undo];
    expect(await run(second, ...args), second.errors).toBe(0);
    expect(purposes(s.host)).toEqual(["teardown", "undo"]);
    expect(s.host.applies.at(-1)?.options.approvedHash).toBe(undo);
  });

  it("--delete-data passes the choice on, and the teardown still needs the typed name", async () => {
    const base = new BaseApprovals();
    const s = await setup({ approvals: base });
    const ctx = s.context();
    expect(await run(ctx, "destroy", "--confirm", "shop", "--delete-data"), ctx.errors).toBe(0);
    const teardown = s.host.applies[0]?.plan;
    expect(teardown?.purpose).toBe("teardown");
    expect(JSON.stringify(teardown?.steps)).toContain('"deleteData":true');
    // The typed-name handler approved it; nothing reached the base handler as a host plan.
    expect(base.requests.filter((r) => r.kind === "host-apply")).toEqual([]);
  });

  it("refuses the own-server flags for a server OpsCrew created", async () => {
    project = await deployProject();
    const ctx = projectContext(project, { services: { runner: new OwnRunner() } });
    expect(await run(ctx, "destroy", "--confirm", "shop", "--undo-host")).toBe(2);
    expect(ctx.errors).toContain("only to a server you already own");
  });

  it("shows the own-server options in --help", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "destroy", "--help")).toBe(0);
    for (const option of [
      "--undo-host",
      "--delete-data",
      "--host-key <fingerprint>",
      "--approve",
    ]) {
      expect(ctx.output).toContain(option);
    }
  });
});
