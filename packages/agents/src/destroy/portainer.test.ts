import { readdir } from "node:fs/promises";
import type { ApprovalRequest, IacEngine } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
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
import { writeFakeState } from "../provision/__fixtures__/fakes";
import { readPortainerConnection } from "../shared";
import {
  deleteTunnelIn,
  FAKE_TUNNEL,
  fakeTunnelApi,
  tunnelDeletePlanJson,
  tunnelDeletes,
} from "../shared/__fixtures__/tunnel";
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
      Name: "opscrew-shop_postgres_data",
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
      "opscrew-shop_postgres_data",
    ]);
    expect(app).toEqual({ stacks: [], volumes: ["opscrew-shop_postgres_data"] });

    // The webhook, the value key and the saved stack plans leave this computer.
    expect(await exists(s.deps.paths.projectHomeDir, "portainer-webhook")).toBe(false);
    expect(await exists(s.deps.paths.projectHomeDir, "portainer-env.key")).toBe(false);
    expect(
      (await readdir(s.deps.paths.files.plansDir)).filter((file) => file.startsWith("stack-")),
    ).toEqual([]);

    expect(s.github.deleted.sort()).toEqual([
      "OPSCREW_BUILD_ENV",
      "OPSCREW_PORTAINER_ACCESS_CLIENT_ID",
      "OPSCREW_PORTAINER_ACCESS_CLIENT_SECRET",
      "OPSCREW_PORTAINER_WEBHOOK_URL",
    ]);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(plan.approvals.slice(-2).map((entry) => entry.kind)).toEqual([
      "iac-apply",
      "stack-apply",
    ]);
    expect(result.remaining.join("\n")).toContain("opscrew-shop_postgres_data");
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
      "portainer:DELETE /api/endpoints/3/docker/volumes/opscrew-shop_postgres_data",
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
      "portainer:DELETE /api/endpoints/3/docker/volumes/opscrew-shop_postgres_data",
    ]);
    expect(s.fake.volumes.map((volume) => volume.Name)).toEqual(["media_data"]);

    await expectError(destroy(s, { deleteData: true }), "PHASE_PRECONDITION");
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
});
