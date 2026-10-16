import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ED25519_FINGERPRINT,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  freshFacts,
  OWN_IPV4,
  ownPlan,
  PUBLIC_CHANGES,
} from "@opscrew/agents/testing";
import type { ApprovalHandler } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { type DeployProject, deployProject } from "../ui/__fixtures__/deploy";
import { GIT, projectContext, run } from "../ui/__fixtures__/harness";
import {
  fakeHome,
  OwnRunner,
  ownProvisionServices,
  ownServices,
  recordOwnLogin,
} from "../ui/__fixtures__/own";

let project: DeployProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

interface Setup {
  host?: FakeHostServer;
  approvals?: ApprovalHandler;
}

/** A non-interactive context (the real `--approve`/`--yes` handler) with own-server fakes. */
async function context(p: DeployProject, options: Setup = {}) {
  const engine = new FakeEngine({ changes: PUBLIC_CHANGES, planJson: {} });
  const github = new FakeGitHub();
  const host = options.host ?? new FakeHostServer();
  const ctx = projectContext(p, {
    services: {
      runner: new OwnRunner(),
      ...(options.approvals === undefined ? {} : { approvalHandler: options.approvals }),
    },
  });
  const own = ownServices(host, await fakeHome(p));
  withServices(ctx, { provision: ownProvisionServices(engine, github, own) });
  return { ctx, engine, github, host };
}

async function ownProject(): Promise<DeployProject> {
  const p = await deployProject(ownPlan());
  await recordOwnLogin(p);
  return p;
}

/** The labelled hashes printed by a `--plan-only` run on an own server. */
function printedHashes(output: string): { infra: string; host: string } {
  const infra = /infrastructure \(Cloudflare\):\s+([0-9a-f]{64})/.exec(output)?.[1];
  const host = /host plan for your server:\s+([0-9a-f]{64})/.exec(output)?.[1];
  if (infra === undefined || host === undefined) throw new Error(`No plan hashes in:\n${output}`);
  return { infra, host };
}

describe.skipIf(GIT === undefined)("opscrew provision on a server the user owns", () => {
  it("--plan-only prints both hashes and one command; repeated --approve applies exactly those plans", async () => {
    project = await ownProject();
    const first = await context(project);
    const planOnly = ["provision", "--plan-only", "--host-key", ED25519_FINGERPRINT, "--yes"];
    expect(await run(first.ctx, ...planOnly), first.ctx.errors).toBe(0);
    expect(first.engine.calls).not.toContain("apply");
    expect(first.host.applies).toEqual([]);
    const { infra, host } = printedHashes(first.ctx.output);
    expect(first.ctx.output).toContain(
      `    opscrew provision --approve ${infra} --approve ${host} --host-key ${ED25519_FINGERPRINT} --yes\n`,
    );
    // The host key is pinned on this first connection; the address stays in the local state.
    const paths = resolveProjectPaths(project.root, { env: project.env });
    expect(await readFile(paths.files.knownHosts, "utf8")).toContain(OWN_IPV4);

    const second = await context(project);
    const approve = ["provision", "--approve", infra, "--approve", host, "--yes"];
    expect(await run(second.ctx, ...approve), second.ctx.errors).toBe(0);
    expect(second.engine.applied[0]?.approval.approvedPlanHash).toBe(infra);
    expect(second.host.applies).toHaveLength(1);
    expect(second.host.applies[0]?.options.approvedHash).toBe(host);
    const plan = await readArtifact("plan", path.join(project.root, "opscrew", "plan.yaml"));
    expect(plan.approvals.map((a) => [a.kind, a.planHash])).toEqual([
      ["iac-apply", infra],
      ["host-apply", host],
    ]);
    // The CLI names no address for an own server (the agents keep it in the local state).
    expect(second.ctx.output).not.toContain("Created or updated the server at");
    expect(await readFile(paths.files.plan, "utf8")).not.toContain(OWN_IPV4);
    expect(second.ctx.output).toContain("`opscrew verify`");
  });

  it("grants the host plan only for a listed hash: the infrastructure hash alone stops before the server changes", async () => {
    project = await ownProject();
    const first = await context(project);
    await run(first.ctx, "provision", "--plan-only", "--host-key", ED25519_FINGERPRINT, "--yes");
    const { infra, host } = printedHashes(first.ctx.output);

    const second = await context(project);
    expect(await run(second.ctx, "provision", "--approve", infra, "--yes")).toBe(1);
    expect(second.engine.applied).toHaveLength(1);
    expect(second.host.applies).toEqual([]);
    expect(second.ctx.errors).toContain("The host plan was not approved");
    expect(second.ctx.errors).toContain(`--approve ${host}`);
  });

  it("never grants the host plan through --yes", async () => {
    project = await ownProject();
    const { ctx, engine, host } = await context(project);
    expect(await run(ctx, "provision", "--host-key", ED25519_FINGERPRINT, "--yes")).toBe(1);
    expect(engine.calls).not.toContain("apply");
    expect(host.applies).toEqual([]);
  });

  it("needs --host-key on the first connection when nobody can confirm it, and names the fingerprint", async () => {
    project = await ownProject();
    const { ctx, host } = await context(project);
    expect(await run(ctx, "provision", "--plan-only", "--yes")).toBe(1);
    expect(ctx.errors).toContain("--host-key");
    expect(ctx.errors).toContain(ED25519_FINGERPRINT);
    expect(host.inspections).toBe(0);
  });

  it("stops with a plain message when a different host key is pinned", async () => {
    project = await deployProject(ownPlan());
    await recordOwnLogin(project, { hostKey: `SHA256:${"A".repeat(43)}` });
    const { ctx, host } = await context(project);
    expect(await run(ctx, "provision", "--plan-only", "--yes")).toBe(1);
    expect(ctx.errors).toContain("changed since you confirmed it");
    expect(host.inspections).toBe(0);
  });

  it("--password-logins keep is the explicit choice a server with password-only users needs", async () => {
    project = await ownProject();
    const facts = freshFacts();
    facts.loginUsers = [
      { name: "root", uid: 0, password: false, keys: true },
      { name: "alice", uid: 1000, password: true, keys: false },
    ];
    const blocked = await context(project, { host: new FakeHostServer(facts) });
    const base = ["provision", "--plan-only", "--host-key", ED25519_FINGERPRINT, "--yes"];
    expect(await run(blocked.ctx, ...base)).toBe(1);
    expect(blocked.ctx.errors).toContain("--password-logins");

    const kept = await context(project, { host: new FakeHostServer(facts) });
    expect(await run(kept.ctx, ...base, "--password-logins", "keep"), kept.ctx.errors).toBe(0);
    const { host } = printedHashes(kept.ctx.output);
    expect(kept.ctx.output).toContain(
      `--approve ${host} --host-key ${ED25519_FINGERPRINT} --password-logins keep --yes`,
    );
  });

  it("rejects malformed flags with exit 2", async () => {
    project = await ownProject();
    const { ctx, engine } = await context(project);
    expect(await run(ctx, "provision", "--password-logins", "maybe")).toBe(2);
    expect(await run(ctx, "provision", "--approve", "a".repeat(64), "--approve", "nope")).toBe(2);
    expect(ctx.errors).toContain("--approve expects the 64-character SHA-256 plan hash");
    expect(await run(ctx, "provision", "--host-key", "not-a-fingerprint", "--plan-only")).toBe(2);
    expect(ctx.errors).toContain("--host-key expects");
    expect(engine.calls).toEqual([]);
  });

  it("shows the own-server options in --help", async () => {
    project = await ownProject();
    const { ctx } = await context(project);
    expect(await run(ctx, "provision", "--help")).toBe(0);
    for (const option of ["--host-key <fingerprint>", "--password-logins <choice>", "--approve"]) {
      expect(ctx.output).toContain(option);
    }
    expect(ctx.output).toMatch(/once per plan/);
  });
});
