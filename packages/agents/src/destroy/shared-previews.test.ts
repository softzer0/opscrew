/**
 * `destroy` with previews on dev's server (FR-2230, spec.md US9 #4): `destroy --env preview`
 * removes the previews, the recipe and the wildcard and never the server; dev's own `destroy`,
 * `retarget` and a switch of its server's proxy refuse while the previews run there.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, tfstateFile } from "@opscrew/core";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { removeEnvironment } from "../environments/remove";
import { sharedPreviewProject } from "../previews/__fixtures__/plan";
import { runProvision } from "../provision/run";
import { runRetarget } from "../retarget/run";
import { closePublicSsh } from "../secure/public-ssh";
import { ensureStatePassphrase } from "../shared";
import {
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeHostServer,
  fakeSharedCloudflare,
  freshFacts,
  HOST_ADMIN,
  HOST_IPV4,
  hostTestPlan,
  OwnEngine,
  PUBLIC_CHANGES,
  projectRunner,
  publicOutputs,
  type ScriptedApprovalHandler,
  type TestPhaseDeps,
} from "../testing";
import { savedHostPlanPurpose } from "./own";
import { runDestroy } from "./run";
import type { DestroyPreview, DestroyServices } from "./types";

/** dev's server with pr-42 of `shop-preview` running beside dev's app. */
function devServerFacts(own: boolean): HostFacts {
  const fresh = freshFacts({ user: own ? "root" : "deploy" });
  return HostFactsSchema.parse({
    ...fresh,
    dirs: [
      ...fresh.dirs,
      { path: "/srv/apps/shop-dev", kind: "dir" },
      { path: "/srv/apps/shop-preview", kind: "dir" },
    ],
    previews: [
      {
        app: "shop-preview",
        files: { "bin/opscrew-preview": "c".repeat(64) },
        values: true,
        tls: true,
        cron: ["17 * * * * /srv/apps/shop-preview/bin/opscrew-preview gc"],
        numbers: [42],
      },
    ],
  });
}

/** A provisioned preview environment on dev's server, with its fakes. */
async function sharedPreview(own: boolean, answer?: (request: ApprovalRequest) => boolean) {
  const { deps, plan, host } = await sharedPreviewProject({
    own,
    ...(answer !== undefined ? { answer } : {}),
  });
  // The project's repository, which the previews' key names, comes from its origin remote.
  deps.runner = projectRunner();
  await ensureStatePassphrase(deps.paths);
  await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
  await writeFile(tfstateFile(deps.paths), '{"version":4,"resources":[]}\n');
  await mkdir(join(deps.paths.root, plan.infra.dir), { recursive: true });
  const server = new FakeHostServer(devServerFacts(own));
  const hosts: string[] = [];
  const engine = new OwnEngine(PUBLIC_CHANGES, publicOutputs(), publicOutputs());
  const services: DestroyServices = {
    engine: async () => engine,
    github: new FakeDestroyGitHub(),
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    sharedCloudflare: fakeSharedCloudflare(),
    remote: (address): RemoteExec => {
      hosts.push(address);
      return { host: address, run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) };
    },
    // The adapter's calls, bound as the real adapter's plain functions are.
    serverHost: {
      inspect: (remote) => server.inspect(remote),
      apply: (remote, plan, options) => server.apply(remote, plan, options),
    },
  };
  return { deps, host, server, engine, services, hosts };
}

const requestsOf = (deps: { approvalHandler: unknown }) =>
  (deps.approvalHandler as ScriptedApprovalHandler).requests;

describe.skipIf(!findExecutable("git"))("destroy --env <preview> on dev's server", () => {
  it.each([
    ["a server OpsCrew created", false],
    ["the user's own server", true],
  ])(
    "on %s: removes the previews through dev's login, then the wildcard, and leaves the server",
    async (_name, own) => {
      const { deps, host, server, engine, services, hosts } = await sharedPreview(own);
      const devState = await readFile(join(host.stateDir, "server.json"), "utf8");
      const previews: DestroyPreview[] = [];
      const result = await runDestroy(deps, {
        services,
        confirm: async (preview) => {
          previews.push(preview);
          return true;
        },
      });

      // One typed confirmation, listing the previews' removal; no teardown of the server.
      expect(previews).toHaveLength(1);
      expect(previews[0]?.hostSteps?.[0]).toContain(
        'Remove the previews of "shop-preview" (pr-42)',
      );
      expect(server.applies).toHaveLength(1);
      const [removal] = server.applies;
      expect(removal?.plan.steps).toEqual([
        expect.objectContaining({
          id: "previews",
          params: expect.objectContaining({ remove: true, runAs: own ? "root" : "login" }),
        }),
      ]);
      expect(new Set(hosts)).toEqual(new Set([HOST_IPV4]));
      const approved = requestsOf(deps).find((r) => r.kind === "host-apply");
      expect(approved).toMatchObject({
        title: "Remove the previews of shop-preview from dev's server with their data",
        allowDestroy: true,
        confirmPhrase: "shop-preview",
      });
      // Saved as a previews removal, which `opscrew destroy --confirm` approves as the teardown.
      expect(await savedHostPlanPurpose(deps.paths, approved?.planHash)).toBe("previews-removal");
      expect(await savedHostPlanPurpose(deps.paths, "0".repeat(64))).toBeUndefined();
      // The wildcard goes with dev's address only as TF_VAR_*.
      const destroyPlan = engine.plans.find((p) => p.destroy);
      expect(destroyPlan?.env.TF_VAR_server_ipv4).toBe(HOST_IPV4);
      expect(engine.applies.some((a) => a.destroy)).toBe(true);
      expect(result.remaining).toContain(
        "dev's server and everything of dev on it stay as they are.",
      );
      // dev's state is untouched, and nothing of dev's server was said or audited.
      expect(await readFile(join(host.stateDir, "server.json"), "utf8")).toBe(devState);
      // Nor dev's address or admin login in what was said, audited, asked or confirmed.
      const said = [
        deps.reporter.text(),
        JSON.stringify(deps.audit.entries),
        JSON.stringify(requestsOf(deps)),
        JSON.stringify(previews),
      ].join("\n");
      expect(said).not.toContain(HOST_IPV4);
      expect(said).not.toContain(HOST_ADMIN);
      expect(
        (await readArtifact("plan", deps.paths.files.plan)).deployment.destroyedAt,
      ).toBeDefined();
    },
  );

  it("changes nothing when the previews' removal is not approved", async () => {
    const { deps, server, engine, services } = await sharedPreview(
      false,
      (request) => !request.title.startsWith("Remove the previews of"),
    );
    await expect(runDestroy(deps, { services, confirm: async () => true })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("nothing on dev's server was changed"),
    });
    expect(server.applies).toEqual([]);
    expect(engine.applies).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))("dev while previews run on its server", () => {
  async function devDeps() {
    const { deps } = await sharedPreview(false);
    return createTestPhaseDeps({ root: deps.paths.root, env: deps.env, environment: "dev" });
  }

  it.each([
    [
      "destroy",
      "destroying dev",
      (dev: TestPhaseDeps) => runDestroy(dev, { confirm: async () => true }),
      "Remove them first with `opscrew destroy --env preview` (it leaves dev's server as it is), then run `opscrew destroy --env dev` again.",
    ],
    [
      "retarget",
      "moving dev away from Hetzner Cloud",
      (dev: TestPhaseDeps) => runRetarget(dev, {}),
      expect.stringContaining("`opscrew destroy --env preview`"),
    ],
    [
      // GitHub's machines reach the previews over public SSH.
      "closing public SSH",
      "closing public SSH on dev's server",
      (dev: TestPhaseDeps) => closePublicSsh(dev),
      "Remove them first with `opscrew destroy --env preview` (it leaves dev's server as it is), then run `opscrew secure --close-public-ssh --env dev` again.",
    ],
  ])("refuses %s, naming `opscrew destroy --env preview`", async (_name, what, run, hint) => {
    const dev = await devDeps();
    await expect(run(dev)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: `The previews of the preview environment run on dev's server, and ${what} would break them. Nothing was changed.`,
      hint,
    });
  });

  it("refuses a switch of dev's own server to a Cloudflare Tunnel, before any change", async () => {
    const { deps, host } = await sharedPreview(true);
    const plan = hostTestPlan({ own: true });
    await writeArtifact(
      "plan",
      host.files.plan,
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, access: "tunnel" } }),
    );
    const dev = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      environment: "dev",
    });
    await expect(runProvision(dev, {})).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The previews of the preview environment run on dev's server, and serving dev's server through a Cloudflare Tunnel would break them. Nothing was changed.",
      hint: expect.stringContaining("`opscrew destroy --env preview`"),
    });
  });

  it("refuses removing dev while the preview environment names its server, provisioned or not", async () => {
    const { deps } = await sharedPreview(false);
    const dev = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      environment: "dev",
    });
    await writeArtifact("plan", dev.paths.files.plan, hostTestPlan({ deployed: false }));
    await expect(removeEnvironment(dev)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining("`opscrew destroy --env preview`"),
    });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({ ...plan, deployment: {} }),
    );
    await expect(removeEnvironment(dev)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "The previews of the preview environment are set up to run on dev's server, and removing dev would break them. Nothing was changed.",
      hint: "Remove that environment first with `opscrew env remove preview`, then run `opscrew env remove dev` again.",
    });
    expect(await readArtifact("plan", dev.paths.files.plan)).toBeDefined();
  });
});
