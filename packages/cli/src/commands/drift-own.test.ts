import { ensureDeployKey } from "@opscrew/agents";
import {
  ED25519_FINGERPRINT,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  ownPlan,
  preparedServerFacts,
} from "@opscrew/agents/testing";
import { Redactor, resolveProjectPaths } from "@opscrew/core";
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

async function setup(hostKey?: string) {
  project = await deployProject(ownPlan({ domain: null, deployed: true }));
  await recordOwnLogin(project, hostKey === undefined ? {} : { hostKey });
  const paths = resolveProjectPaths(project.root, { env: project.env });
  await ensureDeployKey(paths, new Redactor());
  const host = new FakeHostServer(preparedServerFacts(paths.projectId));
  const ctx = projectContext(project, { services: { runner: new OwnRunner() } });
  const own = ownServices(host, await fakeHome(project));
  withServices(ctx, {
    provision: ownProvisionServices(new FakeEngine(), new FakeGitHub(), own),
  });
  return { ctx, host };
}

describe.skipIf(!GIT)("opscrew drift on a server the user owns", () => {
  it("compares the server and prints the next steps for an own server (no cloud console)", async () => {
    const { ctx, host } = await setup(ED25519_FINGERPRINT);
    const code = await run(ctx, "drift");
    expect([0, 1], ctx.errors).toContain(code);
    expect(host.inspections).toBe(1);
    expect(ctx.output).toContain("on the server (ssh)");
    expect(ctx.output).not.toMatch(/Hetzner|DigitalOcean/);
  });

  it("--host-key trusts the server on the first connection; without it a script stops (exit 2)", async () => {
    const first = await setup();
    expect(await run(first.ctx, "drift")).toBe(2);
    expect(first.ctx.errors).toContain(`--host-key ${ED25519_FINGERPRINT}`);
    expect(first.host.inspections).toBe(0);
    await project?.cleanup();

    const second = await setup();
    const code = await run(second.ctx, "drift", "--host-key", ED25519_FINGERPRINT);
    expect([0, 1], second.ctx.errors).toContain(code);
    expect(second.host.inspections).toBe(1);
  });

  it("rejects a malformed --host-key with exit 2", async () => {
    const { ctx, host } = await setup(ED25519_FINGERPRINT);
    expect(await run(ctx, "drift", "--host-key", "md5:00")).toBe(2);
    expect(ctx.errors).toContain("--host-key expects");
    expect(host.inspections).toBe(0);
  });
});
