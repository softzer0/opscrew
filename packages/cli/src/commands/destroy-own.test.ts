import path from "node:path";
import type { DestroyServices } from "@opscrew/agents";
import {
  ED25519_FINGERPRINT,
  FakeHostServer,
  ownPlan,
  preparedServerFacts,
} from "@opscrew/agents/testing";
import type { ApprovalDecision, ApprovalHandler, ApprovalRequest } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { type DeployProject, deployProject } from "../ui/__fixtures__/deploy";
import { CANCEL, GIT, projectContext, run, ScriptedPrompts } from "../ui/__fixtures__/harness";
import { fakeHome, OwnRunner, ownServices, recordOwnLogin } from "../ui/__fixtures__/own";
import { TypedConfirmationHandler } from "./destroy";

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
  await recordOwnLogin(project, { hostKey: ED25519_FINGERPRINT });
  const paths = resolveProjectPaths(project.root, { env: project.env });
  const host = new FakeHostServer(preparedServerFacts(paths.projectId));
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
    withServices(ctx, { destroy: services });
    return ctx;
  };
  return { context, host, prompts, deletedSecrets, paths };
}

const purposes = (host: FakeHostServer) => host.applies.map((apply) => apply.plan.purpose);

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

    // The undo plan deletes the deploy user: the hash alone (without --confirm) grants nothing,
    // and there is no --yes.
    const hashOnly = s.context();
    expect(await run(hashOnly, "destroy", "--undo-host", "--approve", undo)).toBe(1);
    const yes = s.context();
    expect(await run(yes, "destroy", "--confirm", "shop", "--undo-host", "--yes")).toBe(2);
    expect(purposes(s.host)).toEqual(["teardown"]);

    const second = s.context();
    const args = ["destroy", "--confirm", "shop", "--undo-host", "--approve", undo];
    expect(await run(second, ...args), second.errors).toBe(0);
    expect(purposes(s.host)).toEqual(["teardown", "undo"]);
    expect(s.host.applies.at(-1)?.options.approvedHash).toBe(undo);
    expect(second.output).toContain("(confirmed with --confirm shop and --approve)");
  });

  it("says how a script approves the undo plan when --approve is missing", async () => {
    const s = await setup();
    const ctx = s.context();
    expect(await run(ctx, "destroy", "--confirm", "shop", "--undo-host")).toBe(1);
    expect(ctx.errors).toContain(
      "it deletes the deploy user OpsCrew created and its home directory, so a script approves it only with --confirm shop together with --approve",
    );
  });

  it("in a terminal the undo plan asks for the app's name again; the teardown's name never covers it", async () => {
    for (const typedForUndo of ["shop", "shopx"]) {
      const asked: ApprovalRequest[] = [];
      const approvals: ApprovalHandler = {
        request: async (request) => {
          asked.push(request);
          const undo = request.kind === "host-apply";
          return {
            approved: request.kind === "github-secrets" || undo,
            approver: "test",
            decidedAt: "2026-10-14T12:00:00.000Z",
            ...(undo ? { confirmation: typedForUndo } : {}),
          };
        },
      };
      const s = await setup({ interactive: true, typed: ["shop"], approvals });
      const ctx = s.context();
      const code = await run(ctx, "destroy", "--undo-host");
      // Only the undo plan reached the person (the typed name approved the teardown).
      const hostAsks = asked.filter((request) => request.kind === "host-apply");
      expect(hostAsks).toHaveLength(1);
      expect(hostAsks[0]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
      expect(hostAsks[0]?.title).toContain("Undo OpsCrew's changes to your server");
      if (typedForUndo === "shop") {
        expect(code, ctx.errors).toBe(0);
        expect(purposes(s.host)).toEqual(["teardown", "undo"]);
      } else {
        expect(code).toBe(1);
        expect(purposes(s.host)).toEqual(["teardown"]);
      }
      await project?.cleanup();
      project = undefined;
    }
  });

  it("fails closed: a host plan not known to be the teardown never takes the typed name", async () => {
    const hash = "a".repeat(64);
    const request: ApprovalRequest = {
      kind: "host-apply",
      title: "Undo OpsCrew's changes to your server (5 changes)",
      details: "",
      planHash: hash,
      allowDestroy: true,
      confirmPhrase: "shop",
    };
    const lookups: Array<() => Promise<string | undefined>> = [
      async () => undefined,
      async () => "setup",
      async () => {
        throw new Error("plans directory unreadable");
      },
    ];
    for (const lookup of lookups) {
      const base = new BaseApprovals();
      const handler = new TypedConfirmationHandler(
        base,
        "shop",
        () => "shop",
        true,
        () => {},
        "the app's name",
        {
          purposeOf: lookup,
          scripted: true,
          hashes: [hash],
        },
      );
      const decision = await handler.request(request);
      expect(decision.approved).toBe(false);
      expect(base.requests).toEqual([request]);
    }
    // The teardown itself (by its saved purpose) is approved with the typed name.
    const base = new BaseApprovals();
    const teardown = new TypedConfirmationHandler(
      base,
      "shop",
      () => "shop",
      true,
      () => {},
      "the app's name",
      {
        purposeOf: async () => "teardown",
        scripted: true,
        hashes: [],
      },
    );
    expect(await teardown.request(request)).toMatchObject({ approved: true, confirmation: "shop" });
    expect(base.requests).toEqual([]);
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
