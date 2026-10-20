import { randomBytes } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ApprovalRequest, IacEngine } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { serviceSpec } from "@opscrew/iac-templates";
import { DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  deployImage,
  everythingShown,
  forbiddenIn,
  type PortainerProject,
  type PortainerProjectOptions,
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
} from "../drift/__fixtures__/portainer-project";
import {
  bucketChanges,
  bucketEngine,
  RootEngine,
  withBucket,
} from "../provision/__fixtures__/storage";
import { STORAGE_KEY_VARS, storageStateFile } from "../provision/storage";
import { readPortainerConnection } from "../shared";
import {
  deleteTunnelIn,
  FAKE_TUNNEL,
  fakeTunnelApi,
  tunnelDeletePlanJson,
  tunnelDeletes,
} from "../shared/__fixtures__/tunnel";
import { encryptedState, plainState, withStateList, writeFakeState } from "../testing";
import { runDestroy } from "./run";
import type { DestroyOptions, DestroyPreview, DestroyServices } from "./types";

type Answer = (request: ApprovalRequest) => boolean;

/** A user's own stack and volume next to OpsCrew's: never touched. */
const DECOY = {
  Id: 9,
  Name: "media",
  Type: 2,
  EndpointId: 3,
  Status: 1,
  Env: [{ name: "MEDIA_TOKEN", value: "decoy" }],
  DeploymentStatus: [],
  file: "services:\n  media:\n    image: jellyfin/jellyfin\n",
};

/**
 * A deployed Portainer project whose Cloudflare teardown deletes the tunnel (web mode `tunnel`)
 * when the plan has a Cloudflare root. `events` lists approvals, Portainer's mutations, polls of
 * Cloudflare's tunnel API and engine applies in the order they happened.
 */
async function deployed(o: PortainerProjectOptions = {}) {
  const events: string[] = [];
  let answer: Answer = () => true;
  const s = await portainerProject({
    ...o,
    portainer: { stacks: [DECOY], ...o.portainer },
    answer: (request) => {
      events.push(`approve:${request.kind}`);
      return answer(request);
    },
  });
  await provisionPortainerProject(s);
  await deployImage(s);
  // The app stack's database volume (Compose made it at the first deploy) and the decoy's.
  s.fake.volumes.push(
    {
      Name: "opscrew-shop_db_data",
      Labels: { "com.docker.compose.project": "opscrew-shop" },
    },
    { Name: "media_data", Labels: { "com.docker.compose.project": "media" } },
  );
  // Portainer's mutations go into `events` in order (clients read `fake.request` when made).
  const original = s.fake.request;
  s.fake.request = async (init) => {
    if (init.method !== "GET") events.push(`portainer:${init.method} ${init.path.split("?")[0]}`);
    return original(init);
  };
  deleteTunnelIn(
    s.engine,
    events,
    (options, summary) => options?.destroy === true && summary.changes.length === 0,
  );
  const api = fakeTunnelApi({
    events,
    connectorRunning: () => s.fake.stacks.some((stack) => stack.Name === "opscrew-shop"),
    closeAfter: 2,
  });
  s.deps.fetch = api.fetch;
  s.deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "destroy");
  s.deps.reporter.lines.length = 0;
  events.length = 0;
  return Object.assign(s, {
    events,
    api,
    answer: (next: Answer) => {
      answer = next;
    },
  });
}

function services(s: PortainerProject): DestroyServices {
  return {
    engine: s.services.engine,
    github: s.github,
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    sleep: async () => undefined,
    portainer: {
      ...(s.services.portainer?.client !== undefined
        ? { client: s.services.portainer.client }
        : {}),
      wait: { now: () => 0, sleep: async () => undefined },
    },
  };
}

const destroy = (s: PortainerProject, options: DestroyOptions = {}) =>
  runDestroy(s.deps, { services: services(s), ...options });

async function expectError(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

const exists = async (dir: string, name: string) => (await readdir(dir)).includes(name);

describe.skipIf(!findExecutable("git"))("opscrew destroy for the user's Portainer", () => {
  it("approves both plans first, removes the stacks, waits for the tunnel, then deletes it; keeps the data", async () => {
    const s = await deployed();
    const decoy = structuredClone(s.fake.stacks.find((stack) => stack.Id === DECOY.Id));
    const registryId = s.fake.registries[0]?.Id;
    const idOf = (name: string) => s.fake.stacks.find((stack) => stack.Name === name)?.Id;
    const updaterId = idOf("opscrew-shop-updater");
    const appId = idOf("opscrew-shop");
    const previews: DestroyPreview[] = [];
    const result = await destroy(s, {
      confirm: async (preview) => {
        previews.push(preview);
        return true;
      },
    });

    const app = (await readPortainerConnection(s.deps.paths))?.created;
    expect(s.events.filter((event) => event !== "poll")).toEqual([
      "approve:iac-apply",
      "approve:stack-apply",
      `portainer:DELETE /api/stacks/${updaterId}`,
      `portainer:DELETE /api/stacks/${appId}`,
      `portainer:DELETE /api/registries/${registryId}`,
      "iac-apply",
      "approve:cloudflare-apply",
      "approve:github-secrets",
    ]);
    // The tunnel was deleted only after Cloudflare reported the connector gone.
    const lastStackChange = s.events.lastIndexOf(`portainer:DELETE /api/registries/${registryId}`);
    expect(s.events.indexOf("poll")).toBeGreaterThan(lastStackChange);
    expect(s.events.indexOf("iac-apply")).toBeGreaterThan(s.events.lastIndexOf("poll"));

    // The stack teardown was approved by its hash with allowDestroy and the typed app name.
    const approval = s.handler.requests.find((request) => request.kind === "stack-apply");
    expect(approval).toMatchObject({
      planHash: result.stackPlan,
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(approval?.details).toContain("OpsCrew does not change the host");
    expect(approval?.details).toContain(
      "Backups, including the app's data volumes, are your responsibility",
    );
    // The audit names the teardown's apply and each change by the plan's hash only.
    const teardownAudit = s.deps.audit.entries.filter((entry) =>
      entry.action.startsWith("stack teardown "),
    );
    expect(teardownAudit[0]?.action).toBe("stack teardown started");
    expect(teardownAudit.slice(1).map((entry) => entry.action)).toEqual([
      "stack teardown updater-stack",
      "stack teardown app-stack",
      "stack teardown registry",
    ]);
    expect(teardownAudit.every((entry) => entry.target === result.stackPlan)).toBe(true);
    expect(previews[0]).toMatchObject({ provider: "portainer", name: "shop" });
    expect(previews[0]?.stackChanges).toEqual([
      "Remove the stack opscrew-shop-updater",
      "Remove the stack opscrew-shop",
      "Remove the registry entry opscrew-shop OpsCrew added",
    ]);

    // Only OpsCrew's stacks went; the decoy, its volume and the app's data volume stay.
    expect(s.fake.stacks.map((stack) => stack.Name)).toEqual(["media"]);
    expect(s.fake.stacks[0]).toEqual(decoy);
    expect(s.fake.registries).toEqual([]);
    expect(s.fake.volumes.map((volume) => volume.Name).sort()).toEqual([
      "media_data",
      "opscrew-shop_db_data",
    ]);
    expect(app).toEqual({ stacks: [], volumes: ["opscrew-shop_db_data"] });

    // The webhook, the value key and the saved stack plans leave this computer.
    expect(await exists(s.deps.paths.projectHomeDir, "portainer-webhook")).toBe(false);
    expect(await exists(s.deps.paths.projectHomeDir, "portainer-env.key")).toBe(false);
    expect(
      (await readdir(s.deps.paths.files.plansDir)).filter((file) => file.startsWith("stack-")),
    ).toEqual([]);

    expect(s.github.deleted.sort()).toEqual([
      "OPSCREW_BUILD_ENV",
      "OPSCREW_BUILD_SECRETS",
      "OPSCREW_PORTAINER_ACCESS_CLIENT_ID",
      "OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET",
      "OPSCREW_PORTAINER_WEBHOOK_URL",
    ]);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(plan.approvals.slice(-3).map((entry) => entry.kind)).toEqual([
      "iac-apply",
      "stack-apply",
      "cloudflare-apply",
    ]);
    expect(result.remaining.join("\n")).toContain("opscrew-shop_db_data");
    expect(result.remaining.join("\n")).toContain("OpsCrew does not change the host");
    const text = await everythingShown(s);
    for (const secret of forbiddenIn(s)) expect(text).not.toContain(secret);
  });

  it("two tunnels (Cloudflare redeploys and the app's tunnel): the connector stack goes first, both close, then the plan", async () => {
    const s = await deployed({ plan: portainerPlan({ redeploy: "cloudflare" }) });
    const webhookTunnel = "0b9e8d7c-6a5f-4e3d-8c2b-1a0f9e8d7c6b";
    // The app's tunnel with its record and Access, and the tunnel in front of the webhook.
    const changes = [...tunnelDeletes(), ...tunnelDeletes("module.portainer").slice(0, 1)];
    const planJson = tunnelDeletePlanJson(changes) as {
      resource_changes: { change: { before: { id: string } } }[];
    };
    const second = planJson.resource_changes[4];
    if (second !== undefined) second.change.before.id = webhookTunnel;
    const engine: IacEngine = s.engine;
    const plan = engine.plan.bind(engine);
    engine.plan = async (dir, file, options) => {
      const summary = await plan(dir, file, options);
      return options?.destroy === true
        ? { ...summary, changes, hasDestroy: true, planJson }
        : summary;
    };
    const connectorId = s.fake.stacks.find(
      (stack) => stack.Name === "opscrew-shop-portainer-tunnel",
    )?.Id;
    expect(connectorId).toBeDefined();

    await destroy(s);
    const firstPoll = s.events.indexOf("poll");
    expect(s.events.slice(0, 3)).toEqual([
      "approve:iac-apply",
      "approve:stack-apply",
      `portainer:DELETE /api/stacks/${connectorId}`,
    ]);
    expect(firstPoll).toBeGreaterThan(
      s.events.findIndex((event) => event.startsWith("portainer:DELETE /api/registries/")),
    );
    expect(s.events.indexOf("iac-apply")).toBeGreaterThan(s.events.lastIndexOf("poll"));
    // Both tunnels were asked about until they reported no connections.
    const polled = s.api.calls.map((call) => call.split("/cfd_tunnel/")[1]);
    expect(new Set(polled)).toEqual(new Set([FAKE_TUNNEL.tunnelId, webhookTunnel]));
    expect(polled.indexOf(webhookTunnel)).toBeGreaterThan(polled.lastIndexOf(FAKE_TUNNEL.tunnelId));
  });

  it("a Cloudflare plan that deletes no tunnel is applied only after the stack teardown is approved too", async () => {
    const s = await deployed();
    const records = tunnelDeletes().filter((change) => change.type === "cloudflare_dns_record");
    const engine: IacEngine = s.engine;
    const plan = engine.plan.bind(engine);
    engine.plan = async (dir, file, options) => {
      const summary = await plan(dir, file, options);
      return options?.destroy === true
        ? {
            ...summary,
            changes: records,
            hasDestroy: true,
            planJson: tunnelDeletePlanJson(records),
          }
        : summary;
    };
    await destroy(s);
    expect(s.events.slice(0, 4)).toEqual([
      "approve:iac-apply",
      "approve:stack-apply",
      "iac-apply",
      expect.stringMatching(/^portainer:DELETE \/api\/stacks\/\d+$/),
    ]);
    expect(s.events).not.toContain("poll");
  });

  it("--delete-data deletes the recorded volumes after stopping the app, never another one", async () => {
    const s = await deployed();
    const result = await destroy(s, { deleteData: true });
    expect(s.events).toContain(
      "portainer:DELETE /api/endpoints/3/docker/volumes/opscrew-shop_db_data",
    );
    expect(s.events.findIndex((event) => /\/stop$/.test(event))).toBeLessThan(
      s.events.findIndex((event) => event.includes("docker/volumes")),
    );
    expect(s.fake.volumes.map((volume) => volume.Name)).toEqual(["media_data"]);
    expect((await readPortainerConnection(s.deps.paths))?.created).toEqual({
      stacks: [],
      volumes: [],
    });
    expect(s.deps.reporter.text()).toContain("cannot be undone unless you have your own backup");
    expect(result.remaining.join("\n")).not.toContain("--delete-data");
  });

  it("removes every component and, only with --delete-data, their volumes, naming their data", async () => {
    const base = portainerPlan({ web: { mode: "proxy", port: 8080 } });
    const entry = (kind: "mysql" | "mongodb", fields = {}) => {
      const spec = serviceSpec(kind);
      return {
        kind,
        version: spec.defaultVersion,
        memoryMb: spec.memory.defaultMb,
        options: {},
        reason: "The app uses it.",
        licence: spec.licence.id,
        ...fields,
      };
    };
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [
        ...base.services,
        entry("mysql"),
        entry("mongodb", { options: { replicaSet: true } }),
      ],
    });
    const s = await deployed({ plan });
    const names = ["mysql_data", "mongodb_db", "mongodb_configdb"].map((v) => `opscrew-shop_${v}`);
    s.fake.volumes.push(
      ...names.map((Name) => ({ Name, Labels: { "com.docker.compose.project": "opscrew-shop" } })),
    );
    expect((await readPortainerConnection(s.deps.paths))?.created.volumes?.sort()).toEqual(
      ["opscrew-shop_db_data", ...names].sort(),
    );
    await destroy(s);
    expect(s.fake.stacks.map((stack) => stack.Name)).toEqual(["media"]);
    expect(s.fake.volumes.map((volume) => volume.Name)).toContain("opscrew-shop_mysql_data");
    expect(s.deps.reporter.text()).toContain("opscrew-shop_mysql_data) is kept");

    s.deps.reporter.lines.length = 0;
    await destroy(s, { deleteData: true });
    expect(s.fake.volumes.map((volume) => volume.Name)).toEqual(["media_data"]);
    expect(s.deps.reporter.text()).toContain(
      "(with the PostgreSQL database, the MySQL database and the MongoDB database)",
    );
  });

  it("keeps the app's R2 bucket without --delete-data, and with it deletes the bucket first", async () => {
    const key = {
      [STORAGE_KEY_VARS.accessKeyId]: fakeSecret("aws-access-key-id", "destroy"),
      [STORAGE_KEY_VARS.secretAccessKey]: fakeSecret("aws-secret-access-key", "destroy"),
    };
    const withR2 = async () => {
      const storage = bucketEngine("r2");
      const s = await portainerProject({
        plan: withBucket(portainerPlan({ web: { mode: "proxy", port: 8080 } }), "r2"),
        env: key,
      });
      const main = s.engine;
      s.services.engine = async () => new RootEngine(main, storage);
      await provisionPortainerProject(s);
      await deployImage(s);
      await writeFile(storageStateFile(s.deps.paths), plainState([]));
      s.deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "destroy");
      storage.scenario.changes = bucketChanges("r2", "delete");
      return { s, storage };
    };

    const kept = await withR2();
    const result = await destroy(kept.s);
    // Only provision's apply: no plan deleted it.
    expect(kept.storage.applied).toHaveLength(1);
    expect(kept.s.deps.reporter.text()).toContain(
      "The app's bucket shop-uploads on Cloudflare R2 (auto) and its files stay.",
    );
    expect(result.remaining.join("\n")).toContain(
      "The app's bucket shop-uploads on Cloudflare R2 (auto) with the app's files",
    );
    // A later data-only run deletes the volumes; the bucket goes only with the app, so it stays.
    const dataOnly = await destroy(kept.s, { deleteData: true });
    expect(kept.storage.applied).toHaveLength(1);
    expect(dataOnly.remaining.join("\n")).toContain(
      "The app's bucket shop-uploads on Cloudflare R2 (auto) with the app's files",
    );

    const deleted = await withR2();
    const order: string[] = [];
    const apply = deleted.storage.apply.bind(deleted.storage);
    deleted.storage.apply = async (...args: Parameters<typeof apply>) => {
      order.push("bucket");
      return apply(...args);
    };
    const request = deleted.s.fake.request;
    deleted.s.fake.request = async (init) => {
      if (init.method === "DELETE") order.push("portainer");
      return request(init);
    };
    const removed = await destroy(deleted.s, { deleteData: true });
    expect(deleted.s.handler.requests.map((r) => r.title)).toContain(
      "Delete the app's bucket shop-uploads on Cloudflare R2 with its files (1 resource to delete)",
    );
    expect(order[0]).toBe("bucket");
    expect(order).toContain("portainer");
    expect(removed.remaining.join("\n")).not.toContain("shop-uploads");
    expect(deleted.s.deps.audit.entries.at(-1)?.detail).toContain("the app's bucket deleted");
  });

  it("stops before any change when the stack teardown is refused", async () => {
    const s = await deployed();
    const mutations = s.fake.mutations().length;
    s.answer((request) => request.kind !== "stack-apply");
    const error = await expectError(destroy(s), "APPROVAL_REFUSED");
    expect(error.message).toContain(
      "nothing in your Portainer was changed and nothing in Cloudflare was deleted",
    );
    expect(s.fake.mutations()).toHaveLength(mutations);
    expect(s.events).not.toContain("iac-apply");
    expect((await readPortainerConnection(s.deps.paths))?.created.stacks).toHaveLength(2);
    expect(await exists(s.deps.paths.projectHomeDir, "portainer-webhook")).toBe(true);
  });

  it("records what is left when a removal fails part-way, and a rerun finishes", async () => {
    const s = await deployed();
    const app = s.fake.stacks.find((stack) => stack.Name === "opscrew-shop");
    const working = s.fake.request;
    let fail = true;
    s.fake.request = async (init) => {
      if (fail && init.method === "DELETE" && init.path.startsWith(`/api/stacks/${app?.Id}`)) {
        fail = false;
        return { status: 500, body: JSON.stringify({ message: "busy" }) };
      }
      return working(init);
    };
    await expect(destroy(s)).rejects.toThrow();
    expect(s.deps.audit.entries.map((entry) => entry.action)).toContain("stack teardown failed");
    const left = (await readPortainerConnection(s.deps.paths))?.created;
    expect(left?.stacks.map((stack) => stack.role)).toEqual(["app"]);
    expect(s.events).not.toContain("iac-apply");

    await destroy(s);
    expect((await readPortainerConnection(s.deps.paths))?.created.stacks).toEqual([]);
    expect(s.fake.stacks.map((stack) => stack.Name)).toEqual(["media"]);
  });

  it("a proxy setup has no Cloudflare part; a later --delete-data deletes the kept volumes", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    await destroy(s);
    expect(s.events).not.toContain("approve:iac-apply");
    expect(s.engine.calls).not.toContain("init");
    expect(s.fake.stacks.map((stack) => stack.Name)).toEqual(["media"]);
    expect(s.github.deleted).toContain("OPSCREW_BUILD_ENV");

    s.events.length = 0;
    await destroy(s, { deleteData: true });
    expect(s.events).toEqual([
      "approve:stack-apply",
      "portainer:DELETE /api/endpoints/3/docker/volumes/opscrew-shop_db_data",
    ]);
    expect(s.fake.volumes.map((volume) => volume.Name)).toEqual(["media_data"]);

    await expectError(destroy(s, { deleteData: true }), "PHASE_PRECONDITION");
  });

  it("a state an earlier removal emptied holds nothing to delete, also encrypted", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    await mkdir(s.deps.paths.files.tfstateDir, { recursive: true });
    await mkdir(dirname(s.deps.paths.files.statePassphrase), { recursive: true });
    await writeFile(
      s.deps.paths.files.statePassphrase,
      `${randomBytes(24).toString("base64url")}\n`,
    );
    await writeFile(join(s.deps.paths.files.tfstateDir, "prod.tfstate"), encryptedState());
    let inside = ["module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this"];
    const engine = withStateList(s.engine, () => inside);

    // Still holding a tunnel: its removal needs the infrastructure code, which a proxy setup lacks.
    const mutations = s.fake.mutations().length;
    const error = await expectError(destroy(s), "PHASE_PRECONDITION");
    expect(error.message).toContain("infrastructure code");
    expect(s.fake.mutations()).toHaveLength(mutations);

    inside = [];
    await destroy(s);
    expect(s.events).not.toContain("approve:iac-apply");
    expect(s.engine.calls).not.toContain("init");
    expect(s.fake.stacks.map((stack) => stack.Name)).toEqual(["media"]);
    expect(engine.stateCalls.map((call) => call.encryption !== undefined)).toEqual([true, true]);
  });

  it("stops before any change when the state for the Cloudflare resources is missing", async () => {
    const s = await deployed();
    const { rm } = await import("node:fs/promises");
    await rm(s.deps.paths.files.tfstateDir, { recursive: true, force: true });
    const mutations = s.fake.mutations().length;
    await expectError(destroy(s), "PHASE_PRECONDITION");
    expect(s.fake.mutations()).toHaveLength(mutations);
    await writeFakeState(s.deps.paths);
  });

  /** The project's GitHub fake learns to delete branches (in the bare repository pushes go to). */
  function withBranchDeletion(
    s: Awaited<ReturnType<typeof deployed>>,
    result?: () => Promise<"deleted" | "absent">,
  ) {
    const asked: string[] = [];
    Object.assign(s.github, {
      deleteBranch: async (owner: string, repo: string, branch: string) => {
        asked.push(`${owner}/${repo}:${branch}`);
        s.events.push("github:delete-branch");
        if (result !== undefined) return result();
        await s.git(s.bare, "update-ref", "-d", `refs/heads/${branch}`);
        return "deleted" as const;
      },
    });
    return asked;
  }

  it("deletes opscrew-deploy once the app's stack is gone, within the same confirmation", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    expect(await s.git(s.bare, "branch", "--list", "opscrew-deploy")).toContain("opscrew-deploy");
    const asked = withBranchDeletion(s);
    const result = await destroy(s);

    expect(asked).toEqual(["acme/shop:opscrew-deploy"]);
    const appId = s.events.findIndex((event) => /^portainer:DELETE \/api\/stacks\//.test(event));
    expect(s.events.indexOf("github:delete-branch")).toBeGreaterThan(appId);
    // No approval of its own: the destroy's covers it.
    expect(s.events.filter((event) => event.startsWith("approve:"))).toEqual([
      "approve:stack-apply",
      "approve:github-secrets",
    ]);
    expect(await s.git(s.bare, "branch", "--list", "opscrew-deploy")).toBe("");
    expect(s.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "git",
        action: "delete branch",
        target: "acme/shop:opscrew-deploy",
        detail: "deleted",
      }),
    );
    expect(s.deps.reporter.text()).toContain(
      "Once the app's stack is gone, OpsCrew also deletes the branch opscrew-deploy of acme/shop",
    );
    // The approval that covers it names it.
    const teardown = s.handler.requests.find((request) => request.kind === "stack-apply");
    expect(teardown?.details).toContain(
      "OpsCrew also deletes the branch opscrew-deploy of acme/shop, which holds the stack's file.",
    );
    expect(result.remaining.join("\n")).not.toContain("The opscrew-deploy branch");
  });

  it("the app's stacks removed by hand: nothing to approve, so the branch stays and what remains says why", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    const asked = withBranchDeletion(s);
    // Someone removed OpsCrew's stacks and registry entry in Portainer: the teardown only forgets them.
    for (const name of ["opscrew-shop", "opscrew-shop-updater"]) {
      const index = s.fake.stacks.findIndex((stack) => stack.Name === name);
      s.fake.stacks.splice(index, 1);
    }
    s.fake.registries.splice(0);
    const result = await destroy(s);
    expect(asked).toEqual([]);
    expect(s.events.filter((event) => event.startsWith("approve:"))).toEqual([
      "approve:github-secrets",
    ]);
    expect(await s.git(s.bare, "branch", "--list", "opscrew-deploy")).toContain("opscrew-deploy");
    const remains = result.remaining.join("\n");
    expect(remains).toContain("OpsCrew deletes it only together with a teardown you approve");
    expect(remains).toContain("git push origin --delete opscrew-deploy");
  });

  it("only Cloudflare left to remove: its approval names the branch, which goes after it", async () => {
    const s = await deployed();
    const asked = withBranchDeletion(s);
    for (const name of ["opscrew-shop", "opscrew-shop-updater"]) {
      const index = s.fake.stacks.findIndex((stack) => stack.Name === name);
      s.fake.stacks.splice(index, 1);
    }
    s.fake.registries.splice(0);
    await destroy(s);
    const cloudflare = s.handler.requests.find((request) => request.kind === "iac-apply");
    expect(cloudflare?.details).toContain(
      "OpsCrew also deletes the branch opscrew-deploy of acme/shop, which holds the stack's file.",
    );
    expect(s.handler.requests.some((request) => request.kind === "stack-apply")).toBe(false);
    expect(asked).toEqual(["acme/shop:opscrew-deploy"]);
    expect(s.events.indexOf("github:delete-branch")).toBeGreaterThan(s.events.indexOf("iac-apply"));
  });

  it("a branch already gone is fine", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    withBranchDeletion(s, async () => "absent");
    const result = await destroy(s);
    expect(s.deps.reporter.text()).toContain(
      "The branch opscrew-deploy of acme/shop is already gone.",
    );
    expect(result.remaining.join("\n")).not.toContain("The opscrew-deploy branch");
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
  });

  it("a GitHub error deleting the branch says how to finish, and the teardown still completes", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    withBranchDeletion(s, async () => {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        "GitHub refused to delete the branch opscrew-deploy (Forbidden).",
      );
    });
    const result = await destroy(s);
    const warning = s.deps.reporter.lines.find(
      (line) =>
        line.level === "warn" && line.message.includes("deleting the branch opscrew-deploy"),
    );
    expect(warning?.message).toContain("git push origin --delete opscrew-deploy");
    expect(warning?.message).toContain("replaces its file with a placeholder");
    expect(result.remaining.join("\n")).toContain("The opscrew-deploy branch of acme/shop");
    expect(s.github.deleted).toContain("OPSCREW_BUILD_ENV");
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
  });

  it("keeps the branch when the app's stack could not be removed", async () => {
    const s = await deployed({ plan: portainerPlan({ web: { mode: "proxy", port: 8080 } }) });
    const asked = withBranchDeletion(s);
    s.answer((request) => request.kind !== "stack-apply");
    await expectError(destroy(s), "APPROVAL_REFUSED");
    expect(asked).toEqual([]);
    expect(await s.git(s.bare, "branch", "--list", "opscrew-deploy")).toContain("opscrew-deploy");
  });

  it("stops before any approval when the Cloudflare plan deletes what was not confirmed", async () => {
    const s = await deployed();
    const engine: IacEngine = s.engine;
    const plan = engine.plan.bind(engine);
    let destroys = 0;
    const extra = {
      address: "module.dns.cloudflare_dns_record.extra",
      type: "cloudflare_dns_record",
      name: "extra",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
      action: "delete" as const,
    };
    engine.plan = async (dir, file, options) => {
      const summary = await plan(dir, file, options);
      // The first destroy plan is the preview the user confirms.
      if (options?.destroy !== true || ++destroys < 2) return summary;
      return { ...summary, changes: [...summary.changes, extra] };
    };
    const error = await expectError(
      destroy(s, { confirm: async () => true }),
      "PHASE_PRECONDITION",
    );
    expect(error.message).toBe(
      "The teardown plan now deletes resources that were not in the list you confirmed, so OpsCrew stopped. Nothing was deleted.\n  module.dns.cloudflare_dns_record.extra",
    );
    expect(error.hint).toBe("Run `opscrew destroy` again to see the current list and confirm it.");
    expect(s.events).toEqual([]);
    expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop");
  });

  it("with the app's stacks gone, the Cloudflare approval promises no next step", async () => {
    const s = await deployed();
    for (const name of ["opscrew-shop", "opscrew-shop-updater"]) {
      const index = s.fake.stacks.findIndex((stack) => stack.Name === name);
      s.fake.stacks.splice(index, 1);
    }
    s.fake.registries.splice(0);
    const records = tunnelDeletes().filter((change) => change.type === "cloudflare_dns_record");
    const engine: IacEngine = s.engine;
    const plan = engine.plan.bind(engine);
    engine.plan = async (dir, file, options) => {
      const summary = await plan(dir, file, options);
      return options?.destroy === true
        ? { ...summary, changes: records, planJson: tunnelDeletePlanJson(records) }
        : summary;
    };
    await destroy(s);
    const cloudflare = s.handler.requests.find((request) => request.kind === "iac-apply");
    expect(cloudflare?.details).toContain("Your Portainer is not part of this plan.\n");
    expect(cloudflare?.details).not.toContain("next step");
    expect(s.handler.requests.some((request) => request.kind === "stack-apply")).toBe(false);
  });

  it("a failed Cloudflare plan that goes first never says the app is out of Portainer", async () => {
    const s = await deployed();
    const records = tunnelDeletes().filter((change) => change.type === "cloudflare_dns_record");
    const engine: IacEngine = s.engine;
    const plan = engine.plan.bind(engine);
    engine.plan = async (dir, file, options) => {
      const summary = await plan(dir, file, options);
      return options?.destroy === true
        ? { ...summary, changes: records, planJson: tunnelDeletePlanJson(records) }
        : summary;
    };
    engine.apply = async () => ({ ok: false, outputs: {}, log: "Error: Cloudflare is down" });
    const error = await expectError(destroy(s), "ENGINE_FAILED");
    expect(error.hint).toBe(
      "Fix the cause shown above, then run `opscrew destroy` again; it continues with what is left.",
    );
    expect(s.events.some((event) => event.startsWith("portainer:DELETE"))).toBe(false);
    expect(s.fake.stacks.map((stack) => stack.Name)).toContain("opscrew-shop");
  });
});
