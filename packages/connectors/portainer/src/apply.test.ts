import { randomBytes, randomUUID } from "node:crypto";
import type { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { type FakePortainerOptions, fakeClock } from "./__fixtures__/fake-portainer";
import {
  BRANCH_KEY,
  world as baseWorld,
  CONNECTOR_COMPOSE,
  desired,
  fingerprintsFor,
  REPO,
  secrets,
  UPDATER_COMPOSE,
} from "./__fixtures__/scenario";
import { type ApplyStackOptions, applyStackPlan, StackApplyError } from "./apply";
import type { PortainerClient } from "./client";
import { portainerClient } from "./client";
import {
  type DesiredStacks,
  planStacks,
  planStackTeardown,
  type StackPlan,
  stackPlanHash,
} from "./plan";

/** The local value key of these tests: clients fingerprint what they read with it. */
const KEY = randomBytes(32);
const world = (options: FakePortainerOptions = {}) => baseWorld(options, KEY);
type World = ReturnType<typeof world>;
type Secrets = ReturnType<typeof secrets>;

/** Desired stacks bound to the values of `s`, as provision makes them. */
function bound(
  s: Parameters<typeof fingerprintsFor>[1],
  overrides: Partial<DesiredStacks> = {},
): DesiredStacks {
  return desired({ valueFingerprints: fingerprintsFor(KEY, s), ...overrides });
}

/** {@link applyStackPlan} with the value key. */
function apply(client: PortainerClient, plan: StackPlan, opts: ApplyStackOptions) {
  return applyStackPlan(client, plan, { valueKey: KEY, ...opts });
}

function mutating(w: World, from = 0) {
  return w.fake.calls.slice(from).filter((call) => call.method !== "GET");
}

async function setupApplied(
  w: World,
  overrides: Partial<DesiredStacks> = {},
  role: "admin" | "limited" = "admin",
  s: Secrets = secrets(),
) {
  const plan = planStacks(await w.inspect(role), bound(s, overrides));
  const clock = fakeClock();
  const result = await apply(w.client(role), plan, {
    approvedHash: stackPlanHash(plan),
    secrets: s,
    wait: { now: clock.now, sleep: clock.sleep },
  });
  return { s, plan, result, clock };
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error as OpsCrewError,
  );

describe("applyStackPlan: the safety gate", () => {
  it("refuses a plan whose hash is not the approved one and changes nothing", async () => {
    const w = world();
    const plan = planStacks(await w.inspect(), desired());
    const start = w.fake.calls.length;
    const error = await failure(
      apply(w.client(), plan, { approvedHash: "0".repeat(64), secrets: secrets() }),
    );
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    const tampered: StackPlan = {
      ...plan,
      changes: plan.changes.map((change) =>
        change.id === "app-stack"
          ? { ...change, params: { ...change.params, reference: "refs/heads/main" } }
          : change,
      ),
    };
    const again = await failure(
      apply(w.client(), tampered, {
        approvedHash: stackPlanHash(plan),
        secrets: secrets(),
      }),
    );
    expect(again.code).toBe("PLAN_HASH_MISMATCH");
    expect(w.fake.calls.length).toBe(start);
  });

  it("refuses a plan with findings or blocked changes", async () => {
    const w = world();
    const blocked = planStacks(await w.inspect("limited"), desired());
    expect(blocked.findings.length).toBeGreaterThan(0);
    const start = w.fake.calls.length;
    const error = await failure(
      apply(w.client("limited"), blocked, {
        approvedHash: stackPlanHash(blocked),
        secrets: secrets(),
      }),
    );
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toMatch(/ghcr\.io/);
    expect(w.fake.calls.length).toBe(start);
  });

  it("refuses missing, extra or mismatched secrets before changing anything", async () => {
    const w = world();
    const base = secrets();
    const plan = planStacks(await w.inspect(), bound(base));
    const cases: Array<[string, unknown, RegExp]> = [
      ["missing env value", { ...base, env: { DATABASE_URL: "x" } }, /STRIPE_KEY/],
      [
        "extra env value",
        { ...base, env: { ...base.env, EXTRA: "y" } },
        /EXTRA.*not in the approved plan/,
      ],
      ["no webhook", { ...base, webhookId: undefined }, /webhook/],
      ["webhook not a UUID", { ...base, webhookId: "not-a-uuid" }, /webhook/],
      ["no repository token", { ...base, repositoryToken: undefined }, /repository/],
      ["no registry token", { ...base, registryToken: undefined }, /registry/],
      [
        "updater value missing",
        { ...base, updaterEnv: { PORTAINER_PINNED_KEY: "k" } },
        /PORTAINER_WEBHOOK_URL/,
      ],
      [
        "updater calls another webhook",
        {
          ...base,
          updaterEnv: {
            ...base.updaterEnv,
            PORTAINER_WEBHOOK_URL: `https://nas.lan:9443/api/stacks/webhooks/${randomUUID()}`,
          },
        },
        /same webhook/,
      ],
      [
        "updater calls no webhook",
        {
          ...base,
          updaterEnv: {
            ...base.updaterEnv,
            PORTAINER_WEBHOOK_URL: "https://nas.lan:9443/api/status",
          },
        },
        /None of the updater's values is a URL calling the app stack's webhook/,
      ],
      [
        "webhook only in a query string",
        {
          ...base,
          updaterEnv: {
            ...base.updaterEnv,
            PORTAINER_WEBHOOK_URL: `https://nas.lan:9443/x?u=/api/stacks/webhooks/${base.webhookId}`,
          },
        },
        /None of the updater's values/,
      ],
      [
        "empty pinned key for https while OpsCrew pins Portainer's certificate",
        { ...base, updaterEnv: { ...base.updaterEnv, PORTAINER_PINNED_KEY: "" } },
        /PORTAINER_PINNED_KEY is empty while its webhook URL uses https/,
      ],
      [
        "webhook URL that is not http or https",
        {
          ...base,
          updaterEnv: {
            ...base.updaterEnv,
            PORTAINER_WEBHOOK_URL: `ftp://nas.lan/api/stacks/webhooks/${base.webhookId}`,
          },
        },
        /None of the updater's values/,
      ],
    ];
    const start = w.fake.calls.length;
    for (const [label, value, pattern] of cases) {
      const error = await failure(
        apply(w.client(), plan, {
          approvedHash: stackPlanHash(plan),
          secrets: value as never,
        }),
      );
      expect(error.code, label).toBe("INVALID_INPUT");
      expect(error.message, label).toMatch(pattern);
      for (const secret of [base.repositoryToken, base.registryToken, base.env.STRIPE_KEY]) {
        expect(`${error.message} ${error.hint ?? ""}`, label).not.toContain(secret);
      }
    }
    expect(w.fake.calls.length).toBe(start);
  });

  it("refuses a plan that sends values without a values digest, before any request", async () => {
    const w = world();
    const s = secrets();
    const unbound = planStacks(await w.inspect(), desired());
    expect(unbound.valuesDigest).toBeUndefined();
    const start = w.fake.calls.length;
    const error = await failure(
      apply(w.client(), unbound, { approvedHash: stackPlanHash(unbound), secrets: s }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toMatch(/sends values but is not bound to them/);
    expect(w.fake.calls.length).toBe(start);
  });

  it("allows an empty pinned key with an http webhook URL (a local Portainer)", async () => {
    const w = world();
    const base = secrets();
    const s: Secrets = {
      ...base,
      updaterEnv: {
        PORTAINER_WEBHOOK_URL: `http://host.docker.internal:9000/api/stacks/webhooks/${base.webhookId}`,
        PORTAINER_PINNED_KEY: "",
      },
    };
    const { result } = await setupApplied(w, {}, "admin", s);
    expect(result.applied).toEqual(["registry", "app-stack", "updater-stack"]);
    const updater = w.fake.state.stacks.find((stack) => stack.Name === "opscrew-shop-updater");
    expect(updater?.Env).toContainEqual({ name: "PORTAINER_PINNED_KEY", value: "" });
  });

  it("allows an empty pinned key with https only when OpsCrew reaches Portainer unpinned", async () => {
    const w = world();
    const base = secrets();
    const s: Secrets = {
      ...base,
      updaterEnv: { ...base.updaterEnv, PORTAINER_PINNED_KEY: "" },
    };
    // OpsCrew reaches this Portainer over plain HTTP on this computer: nothing is pinned, so curl
    // checks the certificate against the public authorities.
    const local = portainerClient({ url: "http://localhost:9000" }, w.fake.tokens.admin, {
      request: w.fake.request,
      valueKey: KEY,
    });
    expect(local.pinned).toBe(false);
    expect(w.client().pinned).toBe(true);
    const plan = planStacks(await w.inspect(), bound(s));
    const clock = fakeClock();
    const done = await apply(local, plan, {
      approvedHash: stackPlanHash(plan),
      secrets: s,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    expect(done.applied).toContain("updater-stack");
  });
});

describe("applyStackPlan: setup", () => {
  it("creates the registry entry, the app's Git stack and the updater, waits, and records every id", async () => {
    const w = world();
    const decoyBefore = structuredClone(w.decoy);
    const start = w.fake.calls.length;
    const { s, result, clock } = await setupApplied(w);
    const calls = mutating(w, start);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/registries",
      "PUT /api/endpoints/3/registries/100",
      "POST /api/stacks/create/standalone/repository",
      "POST /api/stacks/create/standalone/string",
    ]);
    expect(calls[0]?.body).toEqual({
      Name: "opscrew-shop",
      Type: 3,
      URL: "ghcr.io",
      BaseURL: "",
      Authentication: true,
      Username: "opscrew",
      Password: s.registryToken,
    });
    expect(calls[1]?.body).toEqual({
      UserAccessPolicies: { "1": { RoleId: 0 } },
      TeamAccessPolicies: {},
      Namespaces: [],
    });
    expect(calls[2]?.query.get("endpointId")).toBe("3");
    expect(calls[2]?.body).toEqual({
      Name: "opscrew-shop",
      RepositoryURL: REPO,
      RepositoryReferenceName: "refs/heads/opscrew-deploy",
      ComposeFile: "compose.yaml",
      AdditionalFiles: [],
      RepositoryAuthentication: true,
      RepositoryUsername: "x-access-token",
      RepositoryPassword: s.repositoryToken,
      AutoUpdate: { Webhook: s.webhookId, ForcePullImage: false },
      Env: [
        { name: "DATABASE_URL", value: s.env.DATABASE_URL },
        { name: "STRIPE_KEY", value: s.env.STRIPE_KEY },
      ],
      TLSSkipVerify: false,
      FromAppTemplate: false,
    });
    expect(calls[3]?.body).toEqual({
      Name: "opscrew-shop-updater",
      StackFileContent: UPDATER_COMPOSE,
      Env: [
        { name: "PORTAINER_PINNED_KEY", value: s.updaterEnv.PORTAINER_PINNED_KEY },
        { name: "PORTAINER_WEBHOOK_URL", value: s.updaterEnv.PORTAINER_WEBHOOK_URL },
      ],
      FromAppTemplate: false,
    });
    for (const call of w.fake.calls) {
      // Only Portainer's public status call goes without the token.
      const expected = call.path === "/api/system/status" ? undefined : w.fake.tokens.admin;
      expect(call.headers["X-API-Key"], call.path).toBe(expected);
    }

    expect(result.applied).toEqual(["registry", "app-stack", "updater-stack"]);
    expect(result.record).toEqual({
      stacks: [
        { id: 101, name: "opscrew-shop", role: "app" },
        { id: 102, name: "opscrew-shop-updater", role: "updater" },
      ],
      registryId: 100,
      volumes: ["opscrew-shop_db-data"],
    });
    expect(JSON.stringify(result)).not.toContain(s.webhookId);
    const app = w.fake.state.stacks.find((stack) => stack.Name === "opscrew-shop");
    expect(app?.Status).toBe(1);
    expect(app?.containers).toBe("running");
    expect(clock.waits.length).toBeGreaterThan(0);
    expect(w.fake.state.stacks.find((stack) => stack.Id === 50)).toEqual(decoyBefore);
  });

  it("shows no changes when run again (FR-1012), and applying that plan changes nothing", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    const plan = planStacks(await w.inspect(), bound(s, { record: result.record }));
    expect(plan.changes.map((change) => change.state)).toEqual([
      "in-place",
      "in-place",
      "in-place",
    ]);
    const start = w.fake.calls.length;
    const again = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: s,
    });
    expect(again).toEqual({ applied: [], record: result.record });
    expect(mutating(w, start)).toEqual([]);
  });

  it("always sends the full Env when it updates a stack", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    const env = { ...s.env, SENTRY_DSN: "https://example.invalid/1" };
    const plan = planStacks(
      await w.inspect(),
      bound(
        { ...s, env },
        {
          record: result.record,
          envKeys: ["DATABASE_URL", "STRIPE_KEY", "SENTRY_DSN"],
          updater: { compose: `${UPDATER_COMPOSE}# v2\n` },
        },
      ),
    );
    const start = w.fake.calls.length;
    const clock = fakeClock();
    await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: { ...s, env },
      wait: { now: clock.now, sleep: clock.sleep },
    });
    const calls = mutating(w, start);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/stacks/101/git",
      "PUT /api/stacks/101/git/redeploy",
      "PUT /api/stacks/102",
    ]);
    const names = (body: unknown) =>
      ((body as { Env: { name: string }[] }).Env ?? []).map((pair) => pair.name);
    expect(names(calls[0]?.body)).toEqual(["DATABASE_URL", "SENTRY_DSN", "STRIPE_KEY"]);
    expect(names(calls[1]?.body)).toEqual(["DATABASE_URL", "SENTRY_DSN", "STRIPE_KEY"]);
    expect(names(calls[2]?.body)).toEqual(["PORTAINER_PINNED_KEY", "PORTAINER_WEBHOOK_URL"]);
    expect(calls[0]?.body).toMatchObject({
      AutoUpdate: { Webhook: s.webhookId, ForcePullImage: false },
      RepositoryReferenceName: "refs/heads/opscrew-deploy",
      ConfigFilePath: "compose.yaml",
    });
    const app = w.fake.state.stacks.find((stack) => stack.Id === 101);
    expect(app?.Env.map((pair) => pair.name)).toEqual(["DATABASE_URL", "SENTRY_DSN", "STRIPE_KEY"]);
  });

  it("switches to the Cloudflare redeploy: removes the updater, creates the connector with the tunnel token", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    const plan = planStacks(
      await w.inspect(),
      bound(s, {
        record: result.record,
        redeploy: "cloudflare",
        updater: undefined,
        tunnelConnector: { compose: CONNECTOR_COMPOSE },
      }),
    );
    const start = w.fake.calls.length;
    const clock = fakeClock();
    const next = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: { env: s.env, tunnelToken: s.tunnelToken },
      wait: { now: clock.now, sleep: clock.sleep },
    });
    const calls = mutating(w, start);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /api/stacks/102",
      "POST /api/stacks/create/standalone/string",
    ]);
    expect(calls[1]?.body).toMatchObject({
      Name: "opscrew-shop-portainer-tunnel",
      Env: [{ name: "TUNNEL_TOKEN", value: s.tunnelToken }],
    });
    expect(next.record.stacks.map((stack) => stack.role)).toEqual(["app", "tunnel-connector"]);
  });

  it("reports Portainer's reason when a deploy fails, stops there and says what was done (R7)", async () => {
    const w = world({ outcomes: [{ kind: "missing-image" }] });
    const s = secrets();
    const plan = planStacks(await w.inspect(), bound(s));
    const clock = fakeClock();
    const start = w.fake.calls.length;
    const error = (await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: s,
        wait: { now: clock.now, sleep: clock.sleep },
      }),
    )) as StackApplyError;
    expect(error).toBeInstanceOf(StackApplyError);
    expect(error.message).toMatch(/opscrew-shop did not deploy.*manifest unknown/);
    expect(error.message).toMatch(/Done before it: .*registry entry/);
    expect(error.applied).toEqual(["registry"]);
    // The app stack is OpsCrew's as soon as it exists, and so are its volumes.
    expect(error.record).toEqual({
      stacks: [{ id: 101, name: "opscrew-shop", role: "app" }],
      registryId: 100,
      volumes: ["opscrew-shop_db-data"],
    });
    expect(mutating(w, start).map((call) => call.path)).not.toContain(
      "/api/stacks/create/standalone/string",
    );
    expect(`${error.message} ${error.hint}`).not.toContain(s.repositoryToken);
  });

  it("says the app is down when an update fails on a taken port (R7)", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    w.fake.state.outcomes.push({ kind: "port-conflict" });
    const fewer = { ...s, env: { DATABASE_URL: s.env.DATABASE_URL } };
    const plan = planStacks(
      await w.inspect(),
      bound(fewer, { record: result.record, envKeys: ["DATABASE_URL"] }),
    );
    const clock = fakeClock();
    const error = await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: fewer,
        wait: { now: clock.now, sleep: clock.sleep },
      }),
    );
    expect(error.message).toMatch(/port is already allocated/);
    expect(error.hint).toMatch(/app is down/);
    const app = w.fake.state.stacks.find((stack) => stack.Id === 101);
    expect(app?.containers).toBe("stopped");
    expect(app?.Env.map((pair) => pair.name)).toEqual(["DATABASE_URL"]);
  });

  it("waits only as long as allowed and says what is known", async () => {
    const w = world({ deployPolls: 10_000 });
    const s = secrets();
    const plan = planStacks(await w.inspect(), bound(s));
    const clock = fakeClock();
    const error = (await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: s,
        wait: { timeoutMs: 20_000, intervalMs: 5_000, now: clock.now, sleep: clock.sleep },
      }),
    )) as StackApplyError;
    expect(error.message).toMatch(/still deploying after 20 seconds/);
    expect(error.hint).toMatch(/Portainer/);
    expect(clock.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(20_000);
    expect(error.record.stacks).toEqual([{ id: 101, name: "opscrew-shop", role: "app" }]);
  });

  it("records what it created when a later call fails, and redacts echoed secrets", async () => {
    const s = secrets();
    const w = world({
      override: (call) =>
        call.path === "/api/stacks/create/standalone/repository"
          ? {
              status: 500,
              body: {
                message: "Unable to clone git repository",
                details: `https://x-access-token:${s.repositoryToken}@github.com/acme/shop: ${s.env.STRIPE_KEY}`,
              },
            }
          : undefined,
    });
    const plan = planStacks(await w.inspect(), bound(s));
    const error = (await failure(
      apply(w.client(), plan, { approvedHash: stackPlanHash(plan), secrets: s }),
    )) as StackApplyError;
    expect(error.applied).toEqual(["registry"]);
    expect(error.record.registryId).toBe(100);
    expect(error.message).toMatch(/Unable to clone/);
    expect(error.message).toMatch(/Added the registry entry opscrew-shop/);
    expect(error.message).not.toContain(s.repositoryToken);
    expect(error.message).not.toContain(s.env.STRIPE_KEY);
  });

  it("lets a limited token create its stacks for a public image", async () => {
    const w = world();
    const { result } = await setupApplied(
      w,
      { registry: { url: "ghcr.io", private: false } },
      "limited",
    );
    expect(result.applied).toEqual(["app-stack", "updater-stack"]);
    expect(w.fake.state.stacks.filter((stack) => stack.ownerId === 2)).toHaveLength(2);
  });
});

describe("the fake Portainer's webhook (research R5)", () => {
  it("redeploys only when the deploy branch changed", async () => {
    const w = world();
    const { s } = await setupApplied(w);
    const app = w.fake.state.stacks.find((stack) => stack.Name === "opscrew-shop");
    const before = app?.deploys;
    // Assumption from R5, checked against a real Portainer by the live test (T1008): an
    // unchanged branch does not redeploy.
    expect((await w.fake.callWebhook(s.webhookId)).status).toBe(204);
    expect(app?.deploys).toBe(before);
    const branch = w.fake.state.git[BRANCH_KEY];
    if (branch)
      Object.assign(branch, { commit: "c2", file: "services:\n  web:\n    image: app@sha256:2\n" });
    expect((await w.fake.callWebhook(s.webhookId)).status).toBe(204);
    w.fake.settle();
    expect(app?.deploys).toBe((before ?? 0) + 1);
    expect(app?.file).toContain("app@sha256:2");
    expect((await w.fake.callWebhook(randomUUID())).status).toBe(404);
  });
});

describe("applyStackPlan: teardown", () => {
  it("removes exactly the recorded stacks and registry entry and keeps the data", async () => {
    const w = world();
    const { result } = await setupApplied(w);
    const decoyBefore = structuredClone(w.decoy);
    const plan = planStackTeardown(await w.inspect(), result.record, { deleteData: false });
    const start = w.fake.calls.length;
    const done = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: { env: {} },
    });
    expect(mutating(w, start).map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /api/stacks/102",
      "DELETE /api/stacks/101",
      "DELETE /api/registries/100",
    ]);
    expect(done.applied).toEqual(["updater-stack", "app-stack", "registry"]);
    expect(done.record).toEqual({ stacks: [], volumes: ["opscrew-shop_db-data"] });
    expect(w.fake.state.stacks).toEqual([decoyBefore]);
    expect(w.fake.state.volumes.map((volume) => volume.Name).sort()).toEqual([
      "jellyfin_config",
      "opscrew-shop_db-data",
    ]);
  });

  it("with deleteData, stops the app, deletes only its recorded volumes, then removes it", async () => {
    const w = world();
    const { result } = await setupApplied(w);
    const plan = planStackTeardown(await w.inspect(), result.record, { deleteData: true });
    const start = w.fake.calls.length;
    const done = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: { env: {} },
    });
    expect(mutating(w, start).map((call) => `${call.method} ${call.path}`)).toEqual([
      "DELETE /api/stacks/102",
      "POST /api/stacks/101/stop",
      "DELETE /api/endpoints/3/docker/volumes/opscrew-shop_db-data",
      "DELETE /api/stacks/101",
      "DELETE /api/registries/100",
    ]);
    expect(done.record).toEqual({ stacks: [], volumes: [] });
    expect(w.fake.state.volumes.map((volume) => volume.Name)).toEqual(["jellyfin_config"]);
  });

  it("works for a limited token: the volumes go while the stack still grants access (R9)", async () => {
    const w = world();
    const { result } = await setupApplied(w, { registry: undefined }, "limited");
    const plan = planStackTeardown(await w.inspect("limited"), result.record, { deleteData: true });
    expect(plan.findings).toEqual([]);
    const done = await apply(w.client("limited"), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: { env: {} },
    });
    expect(done.record).toEqual({ stacks: [], volumes: [] });
    expect(w.fake.state.volumes.map((volume) => volume.Name)).toEqual(["jellyfin_config"]);
  });

  it("forgets what is already gone without calling Portainer for it", async () => {
    const w = world();
    const { result } = await setupApplied(w);
    w.fake.state.stacks = w.fake.state.stacks.filter((stack) => stack.Id !== 102);
    const plan = planStackTeardown(await w.inspect(), result.record, { deleteData: false });
    const start = w.fake.calls.length;
    const done = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: { env: {} },
    });
    expect(mutating(w, start).map((call) => call.path)).toEqual([
      "/api/stacks/101",
      "/api/registries/100",
    ]);
    expect(done.record.stacks).toEqual([]);
  });

  it("names the volume that could not be deleted and keeps it recorded", async () => {
    const w = world({
      override: (call) =>
        call.method === "DELETE" && call.path.includes("/docker/volumes/")
          ? { status: 409, body: { message: "remove opscrew-shop_db-data: volume is in use" } }
          : undefined,
    });
    const { result } = await setupApplied(w);
    const plan = planStackTeardown(await w.inspect(), result.record, { deleteData: true });
    const error = (await failure(
      apply(w.client(), plan, { approvedHash: stackPlanHash(plan), secrets: { env: {} } }),
    )) as StackApplyError;
    expect(error.message).toMatch(/volume is in use/);
    expect(error.applied).toEqual(["updater-stack"]);
    expect(error.record).toEqual({
      stacks: [{ id: 101, name: "opscrew-shop", role: "app" }],
      registryId: 100,
      volumes: ["opscrew-shop_db-data"],
    });
    expect(w.fake.state.stacks.some((stack) => stack.Id === 101)).toBe(true);
  });
});

describe("secrets in errors", () => {
  it("never puts a secret into an apply error", async () => {
    const s = secrets();
    const w = world({
      override: (call) =>
        call.path === "/api/stacks/create/standalone/string"
          ? {
              status: 400,
              body: {
                message: `bad env ${s.updaterEnv.PORTAINER_WEBHOOK_URL} ${fakeSecret("github-pat", "repo-read")}`,
              },
            }
          : undefined,
    });
    const plan = planStacks(await w.inspect(), bound(s));
    const clock = fakeClock();
    const error = await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: s,
        wait: { now: clock.now, sleep: clock.sleep },
      }),
    );
    const text = `${error.message} ${error.hint ?? ""}`;
    expect(text).not.toContain(s.webhookId);
    expect(text).not.toContain(s.repositoryToken);
    expect(text).toMatch(/REDACTED/);
  });
});

describe("applyStackPlan: recovery", () => {
  it("after a failed deploy, the re-plan redeploys the stack and it becomes active", async () => {
    const w = world({ outcomes: [{ kind: "missing-image" }] });
    const s = secrets();
    const first = planStacks(await w.inspect(), bound(s));
    const clock = fakeClock();
    const error = (await failure(
      apply(w.client(), first, {
        approvedHash: stackPlanHash(first),
        secrets: s,
        wait: { now: clock.now, sleep: clock.sleep },
      }),
    )) as StackApplyError;
    const app = w.fake.state.stacks.find((stack) => stack.Name === "opscrew-shop");
    expect(app?.Status).toBe(4);

    const plan = planStacks(await w.inspect(), bound(s, { record: error.record }));
    const appChange = plan.changes.find((change) => change.id === "app-stack");
    expect(appChange).toMatchObject({ state: "change", params: { action: "redeploy" } });
    const start = w.fake.calls.length;
    const done = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: s,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    const calls = mutating(w, start).map((call) => `${call.method} ${call.path}`);
    expect(calls).toEqual([
      "PUT /api/stacks/101/git/redeploy",
      "POST /api/stacks/create/standalone/string",
    ]);
    const redeploy = mutating(w, start)[0]?.body as { Env: { name: string }[] };
    expect(redeploy.Env.map((pair) => pair.name)).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    expect(app?.Status).toBe(1);
    expect(done.applied).toEqual(["app-stack", "updater-stack"]);
  });

  it("starts a stopped stack again", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    const updater = w.fake.state.stacks.find((stack) => stack.Id === 102);
    if (updater) updater.Status = 2;
    const plan = planStacks(await w.inspect(), bound(s, { record: result.record }));
    expect(plan.changes[2]?.params.action).toBe("start");
    const start = w.fake.calls.length;
    await apply(w.client(), plan, { approvedHash: stackPlanHash(plan), secrets: s });
    expect(mutating(w, start).map((call) => call.path)).toEqual(["/api/stacks/102/start"]);
    expect(updater?.Status).toBe(1);
  });

  it("tells a new deploy by its time, not by the number of entries (the list may be capped)", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    // Portainer keeps a short history, and this deploy finishes before it answers.
    w.fake.state.deploymentStatusLimit = 2;
    w.fake.state.deployPolls = 0;
    const plan = planStacks(
      await w.inspect(),
      bound(s, { record: result.record, updater: { compose: `${UPDATER_COMPOSE}# v2\n` } }),
    );
    const clock = fakeClock();
    await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: s,
      wait: { timeoutMs: 10_000, now: clock.now, sleep: clock.sleep },
    });
    const updater = w.fake.state.stacks.find((stack) => stack.Id === 102);
    expect(updater?.DeploymentStatus).toHaveLength(2);
    expect(updater?.file).toContain("# v2");
    expect(clock.waits).toEqual([]);
  });

  it("does not take the old active status for the new deploy", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    w.fake.state.deployPolls = 2;
    // Portainer answers before it marks the stack deploying: the old Status 1 must not count.
    w.fake.state.answerBeforeDeploying = true;
    w.fake.state.outcomes.push({ kind: "invalid" });
    const plan = planStacks(
      await w.inspect(),
      bound(s, { record: result.record, updater: { compose: `${UPDATER_COMPOSE}# v3\n` } }),
    );
    const clock = fakeClock();
    const error = await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: s,
        wait: { now: clock.now, sleep: clock.sleep },
      }),
    );
    expect(error.message).toMatch(/did not deploy.*yaml/);
  });

  it("waits for a start Portainer finishes after it answers (Status 2 is not final)", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    const updater = w.fake.state.stacks.find((stack) => stack.Id === 102);
    if (updater) updater.Status = 2;
    w.fake.state.startPolls = 2;
    const plan = planStacks(await w.inspect(), bound(s, { record: result.record }));
    const clock = fakeClock();
    const done = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: s,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    expect(done.applied).toEqual(["updater-stack"]);
    expect(updater?.Status).toBe(1);
    expect(clock.waits.length).toBe(2);
  });

  it("says a started stack is still stopped when the wait runs out", async () => {
    const w = world();
    const { s, result } = await setupApplied(w);
    const updater = w.fake.state.stacks.find((stack) => stack.Id === 102);
    if (updater) updater.Status = 2;
    w.fake.state.startPolls = 10_000;
    const plan = planStacks(await w.inspect(), bound(s, { record: result.record }));
    const clock = fakeClock();
    const error = (await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: s,
        wait: { timeoutMs: 20_000, intervalMs: 5_000, now: clock.now, sleep: clock.sleep },
      }),
    )) as StackApplyError;
    expect(error.message).toMatch(/opscrew-shop-updater is still stopped 20 seconds after/);
    expect(clock.waits.reduce((sum, ms) => sum + ms, 0)).toBe(20_000);
  });

  it("without Time on the entries, tells a new deploy by a longer history", async () => {
    const w = world({ untimedDeploymentStatus: true });
    const { s, result } = await setupApplied(w);
    // The deploy finishes before Portainer answers: only the history's length shows it.
    w.fake.state.deployPolls = 0;
    const plan = planStacks(
      await w.inspect(),
      bound(s, { record: result.record, updater: { compose: `${UPDATER_COMPOSE}# v4\n` } }),
    );
    const clock = fakeClock();
    await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: s,
      wait: { timeoutMs: 10_000, now: clock.now, sleep: clock.sleep },
    });
    const updater = w.fake.state.stacks.find((stack) => stack.Id === 102);
    expect(updater?.DeploymentStatus.at(-1)).toEqual({ Status: 1 });
    expect(updater?.file).toContain("# v4");
    expect(clock.waits).toEqual([]);
  });

  it("without Time on a capped history, waits until it has seen the deploy run", async () => {
    const w = world({ untimedDeploymentStatus: true });
    const { s, result } = await setupApplied(w);
    // The history stays one entry long and Portainer answers before marking the deploy: the old
    // Status 1 must not count; seeing Status 3 tells the new deploy.
    w.fake.state.deploymentStatusLimit = 1;
    w.fake.state.answerBeforeDeploying = true;
    w.fake.state.deployPolls = 1;
    w.fake.state.outcomes.push({ kind: "invalid" });
    const plan = planStacks(
      await w.inspect(),
      bound(s, { record: result.record, updater: { compose: `${UPDATER_COMPOSE}# v5\n` } }),
    );
    const clock = fakeClock();
    const error = await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: s,
        wait: { now: clock.now, sleep: clock.sleep },
      }),
    );
    expect(error.message).toMatch(/did not deploy.*yaml/);
    const updater = w.fake.state.stacks.find((stack) => stack.Id === 102);
    expect(updater?.DeploymentStatus).toHaveLength(1);
  });
});

describe("applyStackPlan: volumes only in a teardown that deletes data", () => {
  it("refuses a volumes change in a setup plan or a teardown that keeps data", async () => {
    const w = world();
    const { result } = await setupApplied(w);
    const facts = await w.inspect();
    const keep = planStackTeardown(facts, result.record, { deleteData: false });
    const withData = planStackTeardown(facts, result.record, { deleteData: true });
    const volumes = withData.changes.find((change) => change.id === "volumes");
    if (volumes === undefined) throw new Error("no volumes change");
    const smuggled: StackPlan[] = [
      { ...keep, changes: [volumes, ...keep.changes] },
      {
        ...planStacks(facts, desired({ record: result.record })),
        changes: [volumes],
      },
    ];
    const start = w.fake.calls.length;
    for (const plan of smuggled) {
      const error = await failure(
        apply(w.client(), plan, {
          approvedHash: stackPlanHash(plan),
          secrets: { env: {} },
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(/record does not list \(volumes\)/);
    }
    expect(w.fake.calls.length).toBe(start);
  });
});

describe("applyStackPlan: value fingerprints", () => {
  async function fingerprinted() {
    const key = KEY;
    const w = world();
    const s = secrets();
    const plan = planStacks(
      await w.inspect(),
      desired({ valueFingerprints: fingerprintsFor(key, s) }),
    );
    const clock = fakeClock();
    const result = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: s,
      valueKey: key,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    return { key, w, s, result, clock };
  }

  it("shows no changes when nothing changed, and a rotated value by its key only", async () => {
    const { key, w, s, result, clock } = await fingerprinted();
    const again = planStacks(
      await w.inspect(),
      desired({ record: result.record, valueFingerprints: fingerprintsFor(key, s) }),
    );
    expect(again.changes.every((change) => change.state === "in-place")).toBe(true);

    const rotated = { ...s, env: { ...s.env, STRIPE_KEY: fakeSecret("stripe-live-key", "next") } };
    const plan = planStacks(
      await w.inspect(),
      desired({ record: result.record, valueFingerprints: fingerprintsFor(key, rotated) }),
    );
    expect(plan.changes[1]?.params.changedValues).toEqual(["STRIPE_KEY"]);
    expect(JSON.stringify(plan)).not.toContain(rotated.env.STRIPE_KEY);
    await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: rotated,
      valueKey: key,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    const app = w.fake.state.stacks.find((stack) => stack.Id === 101);
    expect(app?.Env.find((pair) => pair.name === "STRIPE_KEY")?.value).toBe(rotated.env.STRIPE_KEY);
    const settled = planStacks(
      await w.inspect(),
      desired({ record: result.record, valueFingerprints: fingerprintsFor(key, rotated) }),
    );
    expect(settled.changes.every((change) => change.state === "in-place")).toBe(true);
  });

  it("sets a changed webhook on the app stack and in the updater", async () => {
    const { key, w, s, result, clock } = await fingerprinted();
    const next = { ...secrets(), env: s.env };
    const plan = planStacks(
      await w.inspect(),
      desired({ record: result.record, valueFingerprints: fingerprintsFor(key, next) }),
    );
    await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: next,
      valueKey: key,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    const app = w.fake.state.stacks.find((stack) => stack.Id === 101);
    expect(app?.AutoUpdate?.Webhook).toBe(next.webhookId);
    expect((await w.fake.callWebhook(next.webhookId)).status).toBe(204);
    expect((await w.fake.callWebhook(s.webhookId)).status).toBe(404);
  });

  it("refuses values other than the approved ones, before any request", async () => {
    const { key, w, s, result } = await fingerprinted();
    const rotated = {
      ...s,
      env: { ...s.env, STRIPE_KEY: fakeSecret("stripe-live-key", "approved") },
    };
    const plan = planStacks(
      await w.inspect(),
      desired({ record: result.record, valueFingerprints: fingerprintsFor(key, rotated) }),
    );
    const swapped = {
      ...s,
      env: { ...s.env, STRIPE_KEY: fakeSecret("stripe-live-key", "swapped") },
    };
    const start = w.fake.calls.length;
    const error = await failure(
      apply(w.client(), plan, {
        approvedHash: stackPlanHash(plan),
        secrets: swapped,
        valueKey: key,
      }),
    );
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toMatch(/values supplied are not the ones/);
    expect(`${error.message} ${error.hint}`).not.toContain(swapped.env.STRIPE_KEY);
    const noKey = await failure(
      applyStackPlan(w.client(), plan, { approvedHash: stackPlanHash(plan), secrets: rotated }),
    );
    expect(noKey.message).toMatch(/value key/);
    expect(w.fake.calls.length).toBe(start);
  });
});

describe("applyStackPlan: replacing the repository and registry tokens", () => {
  /** A set-up app, then the plan that replaces `tokens` with new values. */
  async function replacing(tokens: { repository?: boolean; registry?: boolean }) {
    const w = world();
    const { s, result } = await setupApplied(w);
    const next = {
      ...s,
      repositoryToken: fakeSecret("github-pat", "repo-next"),
      registryToken: fakeSecret("github-token", "packages-next"),
    };
    const plan = planStacks(
      await w.inspect(),
      bound(next, { record: result.record, replaceTokens: tokens }),
    );
    return { w, s, next, plan, result };
  }

  it("saves the new repository token with the Git settings and redeploys with it", async () => {
    const { w, s, next, plan } = await replacing({ repository: true });
    // GitHub accepts only the new token from now on.
    const branch = w.fake.state.git[BRANCH_KEY];
    if (branch) branch.password = next.repositoryToken;
    const start = w.fake.calls.length;
    const clock = fakeClock();
    const done = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: next,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    expect(done.applied).toEqual(["app-stack"]);
    const calls = mutating(w, start);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/stacks/101/git",
      "PUT /api/stacks/101/git/redeploy",
    ]);
    expect(calls[0]?.body).toMatchObject({
      RepositoryAuthentication: true,
      RepositoryUsername: "x-access-token",
      RepositoryPassword: next.repositoryToken,
      AutoUpdate: { Webhook: s.webhookId, ForcePullImage: false },
    });
    const app = w.fake.state.stacks.find((stack) => stack.Id === 101);
    expect(app?.GitConfig?.Authentication?.Password).toBe(next.repositoryToken);
    expect(app?.Status).toBe(1);
  });

  it("sends the new registry token to the entry OpsCrew added, then grants it again", async () => {
    const { w, next, plan } = await replacing({ registry: true });
    const start = w.fake.calls.length;
    const done = await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: next,
    });
    expect(done.applied).toEqual(["registry"]);
    const calls = mutating(w, start);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /api/registries/100",
      "PUT /api/endpoints/3/registries/100",
    ]);
    expect(calls[0]?.body).toEqual({
      Name: "opscrew-shop",
      URL: "ghcr.io",
      Authentication: true,
      Username: "opscrew",
      Password: next.registryToken,
    });
    const entry = w.fake.state.registries.find((registry) => registry.Id === 100);
    expect(entry?.Password).toBe(next.registryToken);
    expect(entry?.accesses).toEqual({ 3: [1] });
    expect(JSON.stringify(done)).not.toContain(next.registryToken);
  });

  it("keeps the entry usable even if Portainer clears its grants on the update", async () => {
    const { w, next, plan } = await replacing({ registry: true });
    w.fake.state.registryUpdateClearsGrants = true;
    await apply(w.client(), plan, { approvedHash: stackPlanHash(plan), secrets: next });
    const entry = w.fake.state.registries.find((registry) => registry.Id === 100);
    expect(entry?.accesses).toEqual({ 3: [1] });
    expect(
      planStacks(await w.inspect(), bound(next, { record: plan.record })).changes[0],
    ).toMatchObject({
      id: "registry",
      state: "in-place",
    });
  });

  it("refuses an update aimed at another entry name or URL, or without the grant", async () => {
    const { w, next, plan } = await replacing({ registry: true });
    const start = w.fake.calls.length;
    const tamper = (params: Record<string, unknown>): StackPlan => ({
      ...plan,
      changes: plan.changes.map((change) =>
        change.id === "registry"
          ? ({ ...change, params: { ...change.params, ...params } } as StackPlan["changes"][number])
          : change,
      ),
    });
    const { grantUserId: _grant, ...withoutGrant } = plan.changes[0]?.params ?? {};
    const tampered = [
      tamper({ name: "team-ghcr" }),
      tamper({ url: "registry.example" }),
      {
        ...plan,
        changes: plan.changes.map((change) =>
          change.id === "registry" ? { ...change, params: withoutGrant } : change,
        ),
      },
    ];
    for (const bad of tampered) {
      const error = await failure(
        apply(w.client(), bad, { approvedHash: stackPlanHash(bad), secrets: next }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(/record does not list \(registry\)/);
    }
    expect(w.fake.calls.length).toBe(start);
  });

  it("replaces both in one plan, the registry entry first", async () => {
    const { w, next, plan } = await replacing({ repository: true, registry: true });
    const branch = w.fake.state.git[BRANCH_KEY];
    if (branch) branch.password = next.repositoryToken;
    const start = w.fake.calls.length;
    const clock = fakeClock();
    await apply(w.client(), plan, {
      approvedHash: stackPlanHash(plan),
      secrets: next,
      wait: { now: clock.now, sleep: clock.sleep },
    });
    expect(mutating(w, start).map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /api/registries/100",
      "PUT /api/endpoints/3/registries/100",
      "POST /api/stacks/101/git",
      "PUT /api/stacks/101/git/redeploy",
    ]);
  });

  it("refuses a token other than the approved one, before any request", async () => {
    const { w, next, plan } = await replacing({ repository: true, registry: true });
    const start = w.fake.calls.length;
    for (const swapped of [
      { ...next, repositoryToken: fakeSecret("github-pat", "repo-swapped") },
      { ...next, registryToken: fakeSecret("github-token", "packages-swapped") },
    ]) {
      const error = await failure(
        apply(w.client(), plan, { approvedHash: stackPlanHash(plan), secrets: swapped }),
      );
      expect(error.code).toBe("PLAN_HASH_MISMATCH");
      expect(error.message).toMatch(/values supplied are not the ones/);
      const text = `${error.message} ${error.hint ?? ""}`;
      for (const secret of [swapped.repositoryToken, swapped.registryToken]) {
        expect(text).not.toContain(secret);
      }
    }
    expect(w.fake.calls.length).toBe(start);
  });

  it("binds the tokens a first setup sends, too", async () => {
    const w = world();
    const s = secrets();
    const plan = planStacks(await w.inspect(), bound(s));
    const start = w.fake.calls.length;
    for (const swapped of [
      { ...s, repositoryToken: fakeSecret("github-pat", "repo-swapped") },
      { ...s, registryToken: fakeSecret("github-token", "packages-swapped") },
    ]) {
      const error = await failure(
        apply(w.client(), plan, { approvedHash: stackPlanHash(plan), secrets: swapped }),
      );
      expect(error.code).toBe("PLAN_HASH_MISMATCH");
    }
    expect(w.fake.calls.length).toBe(start);
  });

  it("refuses a replace without the token, before any request", async () => {
    const { w, next, plan } = await replacing({ repository: true, registry: true });
    const start = w.fake.calls.length;
    const cases: Array<[Record<string, undefined>, RegExp]> = [
      [{ repositoryToken: undefined }, /The repository token is missing/],
      [{ registryToken: undefined }, /The registry token \(OPSCREW_GHCR_READ_TOKEN\) is missing/],
    ];
    for (const [without, pattern] of cases) {
      const error = await failure(
        apply(w.client(), plan, {
          approvedHash: stackPlanHash(plan),
          secrets: { ...next, ...without } as never,
        }),
      );
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toMatch(pattern);
    }
    expect(w.fake.calls.length).toBe(start);
  });
});
