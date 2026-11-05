import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  appDirs,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, tfstateFile } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { previewProject } from "../previews/__fixtures__/plan";
import { deploySecretNames } from "../provision/secrets";
import { ensureStatePassphrase, recordOwnServer } from "../shared";
import {
  ED25519_FINGERPRINT,
  FakeDestroyGitHub,
  FakeHostServer,
  FakeServers,
  fakeCloudflare,
  fakeSharedCloudflare,
  HOST_KEY,
  OWN_IPV4,
  OwnEngine,
  ownRunner,
  PUBLIC_CHANGES,
  preparedServerFacts,
  projectRunner,
  publicOutputs,
  ScriptedDestroyEngine,
  SERVER_IPV4,
} from "../testing";
import { runDestroy } from "./run";
import type { DestroyPreview, DestroyServices } from "./types";

describe.skipIf(!findExecutable("git"))(
  "destroy --env <preview> on a server OpsCrew created",
  () => {
    it("deletes the server and the record with the typed name, then the GitHub secrets and environment, and says when the previews' images go", async () => {
      const project = await previewProject({ env: { HCLOUD_TOKEN: fakeSecret("hcloud-token") } });
      const { deps } = project;
      // Its secrets in the GitHub environment OpsCrew created for it.
      const plan = DeployPlanSchema.parse({
        ...project.plan,
        environment: { ...project.plan.environment, secrets: "environment" },
      });
      await writeArtifact("plan", deps.paths.files.plan, plan);
      deps.runner = projectRunner();
      const github = new FakeDestroyGitHub();
      const names = deploySecretNames(plan);
      const secrets = new Map(names.map((name) => [name, "stored"]));
      github.environments.set("preview", secrets);
      await mkdir(dirname(deps.paths.files.deploySecrets), { recursive: true });
      await writeFile(
        deps.paths.files.deploySecrets,
        `${JSON.stringify({ host: SERVER_IPV4, repo: "acme/shop", names, environment: "preview", createdEnvironment: true })}\n`,
      );
      await ensureStatePassphrase(deps.paths);
      await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
      await writeFile(tfstateFile(deps.paths), '{"version":4,"resources":[]}\n');
      await mkdir(join(deps.paths.root, plan.infra.dir), { recursive: true });
      await writeFile(deps.paths.files.knownHosts, `${SERVER_IPV4} ${HOST_KEY}\n`);
      const services: DestroyServices = {
        engine: async () => new ScriptedDestroyEngine(),
        provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
        servers: new FakeServers(),
        cloudflare: fakeCloudflare(),
        github,
        sleep: async () => undefined,
      };

      const result = await runDestroy(deps, { services, snapshot: false });

      const requests = (deps.approvalHandler as unknown as { requests: { kind: string }[] })
        .requests;
      expect(requests.find((r) => r.kind === "iac-apply" && "allowDestroy" in r)).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "shop-preview",
      });
      expect(github.environments.has("preview")).toBe(false);
      expect(result.secretsRemoved.sort()).toEqual([...names].sort());
      expect(result.remaining).toContain(
        "The images of the previews that were still running (ghcr.io/acme/shop:pr-*): the deploy workflows' image cleanup deletes them within 31 days.",
      );
    });
  },
);

/** The facts of the user's server set up as `shop-preview`'s preview server, with pr-42 running. */
function previewServerFacts(projectId: string): HostFacts {
  const facts = structuredClone(preparedServerFacts(projectId));
  const [entry] = facts.apps;
  const app = "shop-preview";
  if (entry?.record === undefined || entry.record === null) throw new Error("no app record");
  entry.name = app;
  entry.record = {
    ...entry.record,
    app,
    composeProject: app,
    folders: appDirs(app),
  };
  if (facts.record !== null) facts.record.apps = [app];
  const shop = appDirs("shop");
  facts.dirs = facts.dirs.map((dir) =>
    dir.path === shop.app
      ? { ...dir, path: appDirs(app).app }
      : dir.path === shop.data
        ? { ...dir, path: appDirs(app).data }
        : dir,
  );
  facts.previews = [
    {
      app,
      files: { "bin/opscrew-preview": "c".repeat(64) },
      values: true,
      tls: true,
      cron: ["17 * * * * /srv/apps/shop-preview/bin/opscrew-preview gc"],
      numbers: [42],
    },
  ];
  return HostFactsSchema.parse(facts);
}

/** An own-server preview environment, provisioned, with its fakes; `answer` decides approvals. */
async function ownPreview(answer?: (request: ApprovalRequest) => boolean) {
  const { deps, plan } = await previewProject({ own: true, ...(answer ? { answer } : {}) });
  deps.runner = ownRunner();
  await recordOwnServer(deps.paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
  });
  await ensureStatePassphrase(deps.paths);
  await mkdir(dirname(tfstateFile(deps.paths)), { recursive: true });
  await writeFile(tfstateFile(deps.paths), '{"version":4,"resources":[]}\n');
  await mkdir(join(deps.paths.root, plan.infra.dir), { recursive: true });
  const server = new FakeHostServer(previewServerFacts(deps.paths.projectId));
  const engine = new OwnEngine(PUBLIC_CHANGES, publicOutputs(), publicOutputs());
  const services: DestroyServices = {
    engine: async () => engine,
    github: new FakeDestroyGitHub(),
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    sharedCloudflare: fakeSharedCloudflare(),
    own: { host: server, homeDir: deps.paths.root },
  };
  return { deps, server, engine, services };
}

describe.skipIf(!findExecutable("git"))("destroy --env <preview> on the user's own server", () => {
  it("removes the previews with a destroying host plan first, then the app, in one confirmation", async () => {
    const { deps, server, services } = await ownPreview();
    const previews: DestroyPreview[] = [];
    const result = await runDestroy(deps, {
      services,
      hostKey: ED25519_FINGERPRINT,
      confirm: async (preview) => {
        previews.push(preview);
        return true;
      },
    });

    // One typed confirmation lists the previews' removal before the app's.
    expect(previews).toHaveLength(1);
    expect(previews[0]?.hostSteps?.[0]).toContain('Remove the previews of "shop-preview" (pr-42)');
    // The previews' plan is applied first, approved by its hash with the typed app name.
    const [first, second] = server.applies;
    expect(first?.plan.steps).toEqual([
      expect.objectContaining({
        id: "previews",
        params: expect.objectContaining({ remove: true }),
      }),
    ]);
    expect(first?.plan.deleteData).toBe(true);
    expect(second?.plan.purpose).toBe("teardown");
    const requests = (deps.approvalHandler as unknown as { requests: ApprovalRequest[] }).requests;
    const removal = requests.find((r) => r.title.startsWith("Remove the previews of"));
    expect(removal).toMatchObject({
      kind: "host-apply",
      allowDestroy: true,
      confirmPhrase: "shop-preview",
      planHash: hostPlanHash(first?.plan as HostPlan),
    });
    expect(result.remaining.join("\n")).toContain("deletes them within 31 days");
  });

  it("applies nothing when the typed name is not given", async () => {
    const { deps, server, engine, services } = await ownPreview();
    await expect(
      runDestroy(deps, { services, hostKey: ED25519_FINGERPRINT, confirm: async () => false }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(server.applies).toEqual([]);
    expect(engine.applies).toEqual([]);
  });

  it("applies nothing when the previews' removal is not approved", async () => {
    const { deps, server, engine, services } = await ownPreview(
      (request) => !request.title.startsWith("Remove the previews of"),
    );
    await expect(
      runDestroy(deps, { services, hostKey: ED25519_FINGERPRINT, confirm: async () => true }),
    ).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("nothing on your server was changed"),
    });
    expect(server.applies).toEqual([]);
    expect(engine.applies).toEqual([]);
  });
});
