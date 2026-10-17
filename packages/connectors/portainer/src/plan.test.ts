import { createHash, randomBytes } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_COMPOSE,
  desired,
  fingerprintsFor,
  PLACEHOLDER,
  REPO,
  secrets,
  UPDATER_COMPOSE,
  world,
} from "./__fixtures__/scenario";
import type { PortainerFacts } from "./facts";
import {
  type CreatedRecord,
  CreatedRecordSchema,
  type DesiredStacks,
  planStacks,
  planStackTeardown,
  type StackPlan,
  StackPlanSchema,
  stackPlanHash,
} from "./plan";
import { valueFingerprint, valueFingerprints } from "./values";

const ids = (plan: StackPlan) => plan.changes.map((change) => `${change.id}:${change.state}`);
const codes = (plan: StackPlan) => plan.findings.map((finding) => finding.code);

/** Facts of a Portainer where OpsCrew already set the app up as `desired()` describes. */
function setUp(facts: PortainerFacts): PortainerFacts {
  return {
    ...facts,
    stacks: [
      {
        id: 101,
        name: "opscrew-shop",
        type: 2,
        environmentId: 3,
        status: 1,
        deploymentStatus: [{ status: 1 }],
        envKeys: ["DATABASE_URL", "STRIPE_KEY"],
        autoUpdate: { webhook: true, forcePullImage: false, forceUpdate: false },
        gitConfig: {
          url: `${REPO}.git`,
          referenceName: "refs/heads/opscrew-deploy",
          configFilePath: "compose.yaml",
          authenticated: true,
        },
        file: PLACEHOLDER,
      },
      {
        id: 102,
        name: "opscrew-shop-updater",
        type: 2,
        environmentId: 3,
        status: 1,
        deploymentStatus: [{ status: 1 }],
        envKeys: ["PORTAINER_PINNED_KEY", "PORTAINER_WEBHOOK_URL"],
        file: UPDATER_COMPOSE,
        fileSha256: sha(UPDATER_COMPOSE),
      },
    ],
    registryEntries: [
      { id: 100, name: "opscrew-shop", url: "ghcr.io", type: 3, environments: [3] },
    ],
    projects: [
      { name: "opscrew-shop", containers: 1 },
      { name: "opscrew-shop-updater", containers: 1 },
    ],
  };
}

const record: CreatedRecord = {
  stacks: [
    { id: 101, name: "opscrew-shop", role: "app" },
    { id: 102, name: "opscrew-shop-updater", role: "updater" },
  ],
  registryId: 100,
  volumes: ["opscrew-shop_db-data"],
};

function sha(text: string): string {
  // Same as the adapter: SHA-256 hex of the UTF-8 text.
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("planStacks", () => {
  it("plans a first setup in order: registry, app stack, updater stack", async () => {
    const facts = await world().inspect();
    const plan = planStacks(facts, desired());
    expect(ids(plan)).toEqual(["registry:change", "app-stack:change", "updater-stack:change"]);
    expect(plan.findings).toEqual([]);
    expect(plan).toMatchObject({
      schemaVersion: 1,
      purpose: "setup",
      app: "shop",
      environmentId: 3,
    });
    const [registry, app, updater] = plan.changes;
    expect(registry?.params).toMatchObject({
      action: "create",
      name: "opscrew-shop",
      url: "ghcr.io",
      username: "opscrew-shop",
      grantUserId: 1,
    });
    expect(app?.params).toMatchObject({
      action: "create",
      name: "opscrew-shop",
      repository: REPO,
      reference: "refs/heads/opscrew-deploy",
      composeFile: "compose.yaml",
      repositoryAuthentication: true,
      envKeys: ["DATABASE_URL", "STRIPE_KEY"],
      webhook: true,
      forcePullImage: false,
      volumes: ["opscrew-shop_db-data"],
    });
    expect(updater?.params).toMatchObject({
      action: "create",
      name: "opscrew-shop-updater",
      compose: UPDATER_COMPOSE,
      envKeys: ["PORTAINER_PINNED_KEY", "PORTAINER_WEBHOOK_URL"],
    });
    expect(StackPlanSchema.parse(plan)).toEqual(plan);
  });

  it("hashes the canonical JSON: same plan, same hash; any change, another hash", async () => {
    const facts = await world().inspect();
    const plan = planStacks(facts, desired());
    expect(stackPlanHash(plan)).toMatch(/^[0-9a-f]{64}$/);
    const again = planStacks(
      await world().inspect(),
      desired({ envKeys: ["STRIPE_KEY", "DATABASE_URL"] }),
    );
    expect(stackPlanHash(again)).toBe(stackPlanHash(plan));
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, item]) => [key, reverseKeys(item)]),
            )
          : value;
    const reordered = reverseKeys(plan) as StackPlan;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(plan));
    expect(stackPlanHash(reordered)).toBe(stackPlanHash(plan));
    const other = planStacks(facts, desired({ envKeys: ["DATABASE_URL"] }));
    expect(stackPlanHash(other)).not.toBe(stackPlanHash(plan));
  });

  it("shows no changes when everything is already set up (FR-1012)", async () => {
    const facts = setUp(await world().inspect());
    const plan = planStacks(facts, desired({ record }));
    expect(ids(plan)).toEqual([
      "registry:in-place",
      "app-stack:in-place",
      "updater-stack:in-place",
    ]);
    expect(plan.changes.every((change) => change.state === "in-place")).toBe(true);
    expect(plan.record).toEqual(record);
  });

  it("plans an update when env keys, the webhook or the updater file differ", async () => {
    const facts = setUp(await world().inspect());
    const app = facts.stacks[0];
    if (app?.autoUpdate) app.autoUpdate = { ...app.autoUpdate, webhook: false };
    const plan = planStacks(
      facts,
      desired({
        record,
        envKeys: ["DATABASE_URL", "STRIPE_KEY", "NEW_KEY"],
        updater: { compose: `${UPDATER_COMPOSE}# v2\n` },
      }),
    );
    expect(ids(plan)).toEqual(["registry:in-place", "app-stack:change", "updater-stack:change"]);
    expect(plan.changes[1]?.params).toMatchObject({ action: "update", stackId: 101 });
    expect(String(plan.changes[1]?.title)).toMatch(/environment variables.*webhook/);
    expect(plan.changes[2]?.params).toMatchObject({ action: "update", stackId: 102 });
  });

  it("re-grants a recorded registry entry that is no longer granted on the environment", async () => {
    const facts = setUp(await world().inspect());
    facts.registryEntries = [{ id: 100, name: "opscrew-shop", url: "ghcr.io", environments: [] }];
    const plan = planStacks(facts, desired({ record }));
    expect(plan.changes[0]).toMatchObject({
      id: "registry",
      state: "change",
      params: { action: "grant", registryId: 100 },
    });
  });

  it("creates a recorded stack again when Portainer no longer has it", async () => {
    const facts = setUp(await world().inspect());
    facts.stacks = facts.stacks.filter((stack) => stack.id !== 102);
    facts.projects = [{ name: "opscrew-shop", containers: 1 }];
    const plan = planStacks(facts, desired({ record }));
    expect(plan.changes[2]).toMatchObject({ state: "change", params: { action: "create" } });
    expect(plan.changes[2]?.reason).toMatch(/no longer has/);
  });

  it("blocks a name taken by a stack OpsCrew did not create (FR-1006)", async () => {
    const facts = setUp(await world().inspect());
    const plan = planStacks(facts, desired());
    expect(plan.changes[1]?.state).toBe("blocked");
    expect(codes(plan)).toContain("stack-name-taken");
    const finding = plan.findings.find((item) => item.code === "stack-name-taken");
    expect(finding?.message).toContain('"opscrew-shop" (id 101)');
    expect(finding?.hint).toMatch(/never changes a stack it did not create/);
  });

  it("with an admin token, blocks a Compose project with the name started outside Portainer", async () => {
    const { inspect } = world({
      containers: [{ EndpointId: 3, project: "opscrew-shop", running: true, ports: [] }],
    });
    const plan = planStacks(await inspect(), desired());
    expect(plan.changes[1]?.state).toBe("blocked");
    expect(codes(plan)).toEqual(["project-name-taken"]);
  });

  it("with a limited token, uses a ghcr.io entry it may use, or stops with the FR-1018 steps", async () => {
    const without = planStacks(await world().inspect("limited"), desired());
    expect(ids(without)).toEqual(["app-stack:change", "updater-stack:change"]);
    expect(codes(without)).toEqual(["registry-missing"]);
    const steps = without.findings[0];
    expect(steps?.message).toMatch(/only an administrator/);
    expect(steps?.hint).toMatch(/Custom registry/);
    expect(steps?.hint).toMatch(/ghcr\.io/);
    expect(steps?.hint).toMatch(/read:packages/);
    expect(steps?.hint).toMatch(/public/);
    expect(steps?.hint).toContain("dev");

    const { inspect } = world({
      registries: [
        {
          Id: 9,
          Name: "ghcr",
          Type: 3,
          URL: "ghcr.io",
          Username: "acme",
          Password: "x",
          accesses: { 3: [2] },
        },
      ],
    });
    const withEntry = planStacks(await inspect("limited"), desired());
    expect(withEntry.findings).toEqual([]);
    expect(withEntry.changes[0]?.reason).toMatch(/ghcr/);
  });

  it("adds no registry entry for a public image", async () => {
    const plan = planStacks(
      await world().inspect(),
      desired({ registry: { url: "ghcr.io", private: false } }),
    );
    expect(ids(plan)).toEqual(["app-stack:change", "updater-stack:change"]);
    const limited = planStacks(await world().inspect("limited"), desired({ registry: undefined }));
    expect(limited.findings).toEqual([]);
  });

  it("blocks a registry entry name taken by an entry OpsCrew did not add", async () => {
    const { inspect } = world({
      registries: [
        {
          Id: 9,
          Name: "opscrew-shop",
          Type: 3,
          URL: "ghcr.io",
          Username: "x",
          Password: "x",
          accesses: {},
        },
      ],
    });
    const plan = planStacks(await inspect(), desired());
    expect(plan.changes[0]?.state).toBe("blocked");
    expect(codes(plan)).toEqual(["registry-name-taken"]);
  });

  it("switches redeploy modes: the recorded updater goes, the connector comes", async () => {
    const facts = setUp(await world().inspect());
    const plan = planStacks(
      facts,
      desired({
        record,
        redeploy: "cloudflare",
        updater: undefined,
        tunnelConnector: { compose: CONNECTOR_COMPOSE },
      }),
    );
    expect(ids(plan)).toEqual([
      "registry:in-place",
      "app-stack:in-place",
      "updater-stack:change",
      "tunnel-connector-stack:change",
    ]);
    expect(plan.changes[2]?.params).toMatchObject({ action: "remove", stackId: 102 });
    expect(plan.changes[3]?.params).toMatchObject({
      action: "create",
      name: "opscrew-shop-portainer-tunnel",
      envKeys: ["TUNNEL_TOKEN"],
    });
  });

  it("checks host ports with an admin token, ignoring the app's own containers", async () => {
    const { inspect } = world({
      containers: [{ EndpointId: 3, project: "npm", running: true, ports: [80, 443] }],
    });
    const plan = planStacks(await inspect(), desired({ ports: [80, 443] }));
    expect(codes(plan)).toEqual(["ports-taken"]);
    expect(plan.findings[0]?.message).toMatch(/80, 443/);
    expect(plan.findings[0]?.message).toContain("npm");

    const facts = setUp(await world().inspect());
    facts.publishedPorts = [
      { port: 80, project: "opscrew-shop" },
      { port: 443, project: "opscrew-shop" },
    ];
    expect(planStacks(facts, desired({ record, ports: [80, 443] })).findings).toEqual([]);

    const limited = planStacks(
      await world().inspect("limited"),
      desired({ ports: [80, 443], registry: undefined }),
    );
    expect(limited.findings).toEqual([]);
    expect(limited.changes[0]?.reason).toMatch(/cannot see other users' containers/);
  });

  it("says before applying that a stack in error loses its containers on the next deploy", async () => {
    const facts = setUp(await world().inspect());
    const app = facts.stacks[0];
    if (app) app.status = 4;
    const plan = planStacks(facts, desired({ record, envKeys: ["DATABASE_URL"] }));
    expect(plan.changes[1]?.reason).toMatch(/error state.*removes all of its containers/);
  });

  it("carries the inspection's findings and blocks on them", async () => {
    const { inspect } = world({ version: "2.33.0" });
    const plan = planStacks(await inspect(), desired());
    expect(codes(plan)).toEqual(["portainer-version"]);
  });

  it("refuses desired stacks that are not valid", async () => {
    const facts = await world().inspect();
    const bad: Array<[string, unknown]> = [
      ["env key", desired({ envKeys: ["NOT-VALID"] })],
      ["duplicate env key", desired({ envKeys: ["A", "A"] })],
      ["updater missing", desired({ updater: undefined })],
      ["connector missing", desired({ redeploy: "cloudflare", updater: undefined })],
      [
        "repository login",
        desired({
          repository: {
            url: "https://user:pw@github.com/acme/shop",
            branch: "opscrew-deploy",
            composeFile: "compose.yaml",
            private: true,
          },
        }),
      ],
      ["app name", desired({ app: "Shop!" })],
      ["environment", desired({ environmentId: 4 })],
      [
        "connector variables",
        desired({
          redeploy: "cloudflare",
          updater: undefined,
          tunnelConnector: { compose: `${CONNECTOR_COMPOSE}      OTHER: \${OTHER}\n` },
        }),
      ],
      [
        "record of another app",
        desired({
          record: { stacks: [{ id: 5, name: "opscrew-blog", role: "app" }], volumes: [] },
        }),
      ],
    ];
    for (const [label, value] of bad) {
      expect(() => planStacks(facts, value as never), label).toThrow();
    }
  });
});

describe("planStackTeardown", () => {
  it("removes exactly the recorded stacks and registry entry, keeping data by default", async () => {
    const facts = setUp(await world().inspect());
    const plan = planStackTeardown(facts, record, { deleteData: false, app: "shop" });
    expect(plan.purpose).toBe("teardown");
    expect(plan.deleteData).toBe(false);
    expect(ids(plan)).toEqual(["updater-stack:change", "app-stack:change", "registry:change"]);
    expect(plan.changes.map((change) => change.params.stackId ?? change.params.registryId)).toEqual(
      [102, 101, 100],
    );
    expect(JSON.stringify(plan)).not.toContain("jellyfin");
  });

  it("with deleteData, deletes the recorded volumes after stopping the app, before removing it", async () => {
    const facts = setUp(await world().inspect());
    const plan = planStackTeardown(facts, record, { deleteData: true, app: "shop" });
    expect(ids(plan)).toEqual([
      "updater-stack:change",
      "volumes:change",
      "app-stack:change",
      "registry:change",
    ]);
    expect(plan.changes[1]?.params).toEqual({
      action: "remove",
      names: ["opscrew-shop_db-data"],
      stopStackId: 101,
    });
    expect(plan.changes[1]?.title).toMatch(/cannot be undone/);
  });

  it("mentions volumes of the app's project that are not in the record, and keeps them", async () => {
    const facts = setUp(await world().inspect());
    facts.volumes = [
      { name: "opscrew-shop_db-data", project: "opscrew-shop" },
      { name: "opscrew-shop_cache", project: "opscrew-shop" },
    ];
    const plan = planStackTeardown(facts, record, { deleteData: true, app: "shop" });
    expect(plan.changes[1]?.params.names).toEqual(["opscrew-shop_db-data"]);
    expect(plan.changes[1]?.reason).toMatch(/not record are kept: opscrew-shop_cache/);
  });

  it("says what is already gone, and never removes a stack OpsCrew did not create", async () => {
    const facts = setUp(await world().inspect());
    facts.stacks = facts.stacks.filter((stack) => stack.id !== 102);
    const plan = planStackTeardown(facts, record, { deleteData: false, app: "shop" });
    expect(plan.changes[0]).toMatchObject({ id: "updater-stack", state: "in-place" });
    expect(plan.changes[0]?.reason).toMatch(/does not show/);

    const replaced = setUp(await world().inspect());
    const app = replaced.stacks[0];
    if (app) app.id = 555;
    const other = planStackTeardown(replaced, record, { deleteData: false, app: "shop" });
    expect(other.changes[1]).toMatchObject({ id: "app-stack", state: "in-place" });
    expect(other.changes[1]?.reason).toMatch(/did not create.*leaves it alone/);
  });

  it("blocks removing the registry entry with a limited token", async () => {
    const facts = setUp(await world().inspect("limited"));
    facts.registryEntries = undefined;
    const plan = planStackTeardown(facts, record, { deleteData: false, app: "shop" });
    expect(plan.changes.at(-1)).toMatchObject({ id: "registry", state: "blocked" });
  });

  it("plans nothing for an empty record, and refuses an app name OpsCrew cannot use", async () => {
    const facts = await world().inspect();
    expect(() =>
      planStackTeardown(facts, { stacks: [], volumes: [] }, { deleteData: false, app: "Shop!" }),
    ).toThrow(/app name/);
    const plan = planStackTeardown(
      facts,
      { stacks: [], volumes: [] },
      { deleteData: false, app: "shop" },
    );
    expect(plan.changes).toEqual([]);
  });

  it("blocks a recorded volume whose Compose project is not the app's stack", async () => {
    const facts = setUp(await world().inspect());
    facts.volumes = [{ name: "opscrew-shop_db-data", project: "jellyfin" }];
    const plan = planStackTeardown(facts, record, { deleteData: true, app: "shop" });
    expect(plan.changes.find((change) => change.id === "volumes")).toMatchObject({
      state: "blocked",
    });
    expect(plan.changes.find((change) => change.id === "volumes")?.reason).toMatch(
      /the project jellyfin, not the app stack opscrew-shop/,
    );
    const unlabelled = setUp(await world().inspect());
    unlabelled.volumes = [{ name: "opscrew-shop_db-data" }];
    expect(
      planStackTeardown(unlabelled, record, { deleteData: true, app: "shop" }).changes.find(
        (change) => change.id === "volumes",
      )?.state,
    ).toBe("blocked");
    // Not seen at all (for example a limited token after the stack is gone): nothing to compare.
    const unseen = setUp(await world().inspect());
    unseen.volumes = [];
    expect(
      planStackTeardown(unseen, record, { deleteData: true, app: "shop" }).changes.find(
        (change) => change.id === "volumes",
      )?.state,
    ).toBe("change");
  });

  it("refuses a record with volumes that are not the app stack's", async () => {
    const facts = setUp(await world().inspect());
    expect(() =>
      planStackTeardown(
        facts,
        { ...record, volumes: ["jellyfin_config"] },
        { deleteData: true, app: "shop" },
      ),
    ).toThrow(/not the app stack's/);
  });
});

describe("app names", () => {
  it("follow plan-schema's rule: up to 41 characters, a trailing dash allowed", async () => {
    const long = "a".repeat(41);
    const facts = await world().inspect();
    for (const app of [long, "shop-"]) {
      const plan = planStacks(facts, desired({ app, volumes: [] }));
      expect(plan.app).toBe(app);
      expect(plan.changes.find((change) => change.id === "app-stack")?.params.name).toBe(
        `opscrew-${app}`,
      );
      expect(StackPlanSchema.parse(plan)).toEqual(plan);
    }
    expect(() => planStacks(facts, desired({ app: "a".repeat(42) }))).toThrow();
    const longest = CreatedRecordSchema.safeParse({
      stacks: [{ id: 1, name: `opscrew-${long}-portainer-tunnel`, role: "tunnel-connector" }],
      volumes: [`opscrew-${long}_data`],
    });
    expect(longest.success).toBe(true);
  });
});

describe("planStacks: recovery, ownership and values", () => {
  it("redeploys a stack in error and starts a stopped one", async () => {
    const facts = setUp(await world().inspect());
    const [app, updater] = facts.stacks;
    if (app === undefined || updater === undefined) throw new Error("setUp");
    app.status = 4;
    app.deploymentStatus = [{ status: 4, message: "manifest unknown", time: 9 }];
    updater.status = 2;
    const plan = planStacks(facts, desired({ record }));
    expect(ids(plan)).toEqual(["registry:in-place", "app-stack:change", "updater-stack:change"]);
    expect(plan.changes[1]?.params).toMatchObject({ action: "redeploy", stackId: 101 });
    expect(plan.changes[1]?.title).toMatch(/Redeploy .*manifest unknown/);
    expect(plan.changes[1]?.reason).toMatch(/removes all of its containers/);
    expect(plan.changes[2]?.params).toMatchObject({ action: "start", stackId: 102 });
  });

  it("refuses desired volumes that are not the app stack's", async () => {
    const facts = await world().inspect();
    expect(() => planStacks(facts, desired({ volumes: ["jellyfin_config"] }))).toThrow(
      /opscrew-<app>_/,
    );
    expect(() =>
      planStacks(facts, desired({ record: { stacks: [], volumes: ["opscrew-blog_data"] } })),
    ).toThrow(/not the app stack's/);
  });

  it("blocks any of the app's names on a stack OpsCrew did not record, whatever the mode", async () => {
    const facts = setUp(await world().inspect());
    const strayRecord: CreatedRecord = {
      stacks: [{ id: 101, name: "opscrew-shop", role: "app" }],
      registryId: 100,
      volumes: [],
    };
    // Cloudflare mode does not use the updater, but a stack with its name still blocks.
    const plan = planStacks(
      facts,
      desired({
        record: strayRecord,
        redeploy: "cloudflare",
        updater: undefined,
        tunnelConnector: { compose: CONNECTOR_COMPOSE },
      }),
    );
    expect(codes(plan)).toEqual(["stack-name-taken"]);
    expect(plan.findings[0]?.message).toContain('"opscrew-shop-updater" (id 102)');
  });

  it("compares values by keyed fingerprint and names only the keys that changed", () => {
    const key = randomBytes(32);
    const s = secrets();
    const fingerprints = fingerprintsFor(key, s);
    const facts = (stacksFrom: ReturnType<typeof secrets>): PortainerFacts =>
      withFingerprints(key, stacksFrom);
    const unchanged = planStacks(facts(s), desired({ record, valueFingerprints: fingerprints }));
    expect(unchanged.changes.map((change) => change.state)).toEqual([
      "in-place",
      "in-place",
      "in-place",
    ]);
    expect(unchanged.valuesDigest).toBeUndefined();

    const rotated = {
      ...s,
      env: { ...s.env, STRIPE_KEY: fakeSecret("stripe-live-key", "rotated") },
    };
    const plan = planStacks(
      facts(s),
      desired({ record, valueFingerprints: fingerprintsFor(key, rotated) }),
    );
    expect(ids(plan)).toEqual(["registry:in-place", "app-stack:change", "updater-stack:in-place"]);
    expect(plan.changes[1]?.params).toMatchObject({
      action: "update",
      changedValues: ["STRIPE_KEY"],
    });
    expect(plan.changes[1]?.title).toMatch(/the value of STRIPE_KEY/);
    expect(plan.valuesDigest).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(plan);
    for (const value of [rotated.env.STRIPE_KEY, s.env.STRIPE_KEY, s.webhookId]) {
      expect(text).not.toContain(value);
    }
    for (const fp of Object.values(fingerprintsFor(key, rotated).app ?? {})) {
      expect(text).not.toContain(fp);
    }
  });

  it("plans setting a changed webhook, and the updater that calls it", () => {
    const key = randomBytes(32);
    const s = secrets();
    const next = secrets();
    const plan = planStacks(
      withFingerprints(key, s),
      desired({ record, valueFingerprints: fingerprintsFor(key, { ...next, env: s.env }) }),
    );
    expect(plan.changes[1]?.params).toMatchObject({ action: "update" });
    expect(plan.changes[1]?.params.differences).toEqual(["the webhook"]);
    expect(plan.changes[2]?.params).toMatchObject({
      action: "update",
      changedValues: ["PORTAINER_WEBHOOK_URL"],
    });
  });

  it("updates the updater whenever the app stack's webhook changes, even with the same values", () => {
    const key = randomBytes(32);
    const s = secrets();
    const next = secrets();
    // Only the webhook differs; the updater's fingerprints are the ones Portainer holds.
    const fingerprints = {
      ...fingerprintsFor(key, s),
      webhook: valueFingerprint(key, "webhook", next.webhookId),
    };
    const plan = planStacks(
      withFingerprints(key, s),
      desired({ record, valueFingerprints: fingerprints }),
    );
    expect(plan.changes[1]?.params.differences).toEqual(["the webhook"]);
    expect(plan.changes[2]).toMatchObject({
      state: "change",
      params: { action: "update", differences: ["the app stack's webhook, which it calls"] },
    });
    expect(plan.changes[2]?.params.changedValues).toBeUndefined();

    // The app stack created again: its webhook is new to Portainer, so the updater follows.
    const gone = withFingerprints(key, s);
    gone.stacks = gone.stacks.filter((stack) => stack.id !== 101);
    gone.projects = [{ name: "opscrew-shop-updater", containers: 1 }];
    const recreated = planStacks(
      gone,
      desired({ record, valueFingerprints: fingerprintsFor(key, s) }),
    );
    expect(recreated.changes[1]?.params.action).toBe("create");
    expect(recreated.changes[2]?.params).toMatchObject({
      action: "update",
      differences: ["the app stack's webhook, which it calls"],
    });

    // The same webhook: the updater stays as it is.
    const same = planStacks(
      withFingerprints(key, s),
      desired({
        record,
        envKeys: ["DATABASE_URL"],
        valueFingerprints: fingerprintsFor(key, {
          ...s,
          env: { DATABASE_URL: s.env.DATABASE_URL },
        }),
      }),
    );
    expect(same.changes[1]?.params.action).toBe("update");
    expect(same.changes[2]?.state).toBe("in-place");
  });

  it("needs the fingerprints of every part the redeploy mode uses, when given", async () => {
    const key = randomBytes(32);
    const facts = await world().inspect();
    const all = fingerprintsFor(key, secrets());
    const { app: _app, ...noApp } = all;
    const { updater: _updater, ...noUpdater } = all;
    const { connector: _connector, ...noConnector } = all;
    const cloudflare = {
      redeploy: "cloudflare" as const,
      updater: undefined,
      tunnelConnector: { compose: CONNECTOR_COMPOSE },
    };
    expect(() => planStacks(facts, desired({ valueFingerprints: noApp }))).toThrow(
      /valueFingerprints\.app: is required/,
    );
    expect(() => planStacks(facts, desired({ valueFingerprints: noUpdater }))).toThrow(
      /valueFingerprints\.updater: is required/,
    );
    expect(() =>
      planStacks(facts, desired({ ...cloudflare, valueFingerprints: noConnector })),
    ).toThrow(/valueFingerprints\.connector: is required/);
    // The other mode's part is not needed.
    expect(planStacks(facts, desired({ valueFingerprints: noConnector })).valuesDigest).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(
      planStacks(facts, desired({ ...cloudflare, valueFingerprints: noUpdater })).valuesDigest,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends the values again when Portainer's cannot be compared (no value key)", async () => {
    const s = secrets();
    const facts = setUp(await world().inspect());
    const plan = planStacks(
      facts,
      desired({ record, valueFingerprints: fingerprintsFor(randomBytes(32), s) }),
    );
    expect(plan.changes[1]?.params).toMatchObject({
      action: "update",
      changedValues: ["DATABASE_URL", "STRIPE_KEY"],
    });
    expect(plan.changes[2]?.params).toMatchObject({ action: "update" });
  });

  it("covers the values digest with the plan hash and needs every fingerprint it sends", async () => {
    const key = randomBytes(32);
    const s = secrets();
    const facts = await world().inspect();
    const plan = planStacks(facts, desired({ valueFingerprints: fingerprintsFor(key, s) }));
    expect(plan.valuesDigest).toMatch(/^[0-9a-f]{64}$/);
    const other = planStacks(
      facts,
      desired({
        valueFingerprints: fingerprintsFor(key, { ...s, webhookId: secrets().webhookId }),
      }),
    );
    expect(other.valuesDigest).not.toBe(plan.valuesDigest);
    expect(stackPlanHash(other)).not.toBe(stackPlanHash(plan));
    const { webhook: _webhook, ...withoutWebhook } = fingerprintsFor(key, s);
    expect(() => planStacks(facts, desired({ valueFingerprints: withoutWebhook }))).toThrow(
      /valueFingerprints.webhook/,
    );
    const partial = { ...fingerprintsFor(key, s), app: { DATABASE_URL: "0".repeat(64) } };
    expect(() => planStacks(facts, desired({ valueFingerprints: partial }))).toThrow(
      /valueFingerprints.app lacks STRIPE_KEY/,
    );
  });
});

describe("planStacks: replacing the repository and registry tokens", () => {
  it("replaces the repository token by a Git update that names it, never the token", () => {
    const key = randomBytes(32);
    const s = secrets();
    const next = { ...s, repositoryToken: fakeSecret("github-pat", "repo-next") };
    const plan = planStacks(
      withFingerprints(key, s),
      desired({
        record,
        valueFingerprints: fingerprintsFor(key, next),
        replaceTokens: { repository: true },
      }),
    );
    expect(ids(plan)).toEqual(["registry:in-place", "app-stack:change", "updater-stack:in-place"]);
    expect(plan.changes[1]?.params).toMatchObject({
      action: "update",
      stackId: 101,
      differences: ["the repository token (replaced)"],
      replacesToken: "repository",
      repositoryAuthentication: true,
    });
    expect(plan.changes[1]?.title).toMatch(
      /Update the Git stack opscrew-shop: the repository token/,
    );
    expect(plan.valuesDigest).toMatch(/^[0-9a-f]{64}$/);
    const text = JSON.stringify(plan);
    for (const secret of [s.repositoryToken, next.repositoryToken]) {
      expect(text).not.toContain(secret);
    }

    // Another token, another digest (so another plan hash).
    const other = planStacks(
      withFingerprints(key, s),
      desired({
        record,
        valueFingerprints: fingerprintsFor(key, {
          ...s,
          repositoryToken: fakeSecret("github-pat", "repo-other"),
        }),
        replaceTokens: { repository: true },
      }),
    );
    expect(other.valuesDigest).not.toBe(plan.valuesDigest);
    expect(stackPlanHash(other)).not.toBe(stackPlanHash(plan));
  });

  it("replaces the registry token of the entry OpsCrew added, and always grants it again", () => {
    const key = randomBytes(32);
    const s = secrets();
    const fingerprints = fingerprintsFor(key, s);
    const facts = withFingerprints(key, s);
    const plan = planStacks(
      facts,
      desired({ record, valueFingerprints: fingerprints, replaceTokens: { registry: true } }),
    );
    expect(ids(plan)).toEqual(["registry:change", "app-stack:in-place", "updater-stack:in-place"]);
    expect(plan.changes[0]?.title).toBe(
      "Replace the token of the registry entry opscrew-shop (ghcr.io) and let admin use it on environment nas",
    );
    expect(plan.changes[0]?.params).toEqual({
      action: "update",
      name: "opscrew-shop",
      url: "ghcr.io",
      registryId: 100,
      username: "opscrew-shop",
      replacesToken: "registry",
      grantUserId: 1,
    });
    expect(plan.valuesDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(plan)).not.toContain(s.registryToken);

    facts.registryEntries = [{ id: 100, name: "opscrew-shop", url: "ghcr.io", environments: [] }];
    const ungranted = planStacks(
      facts,
      desired({ record, valueFingerprints: fingerprints, replaceTokens: { registry: true } }),
    );
    expect(ungranted.changes[0]?.params).toEqual(plan.changes[0]?.params);
    expect(ungranted.changes[0]?.reason).toMatch(/no longer usable on the environment/);
  });

  it("logs the entry in with an explicit user name when one is given, adding or replacing", async () => {
    const registry = { url: "ghcr.io", private: true, username: "acme" } as const;
    const added = planStacks(await world().inspect(), desired({ registry }));
    expect(added.changes[0]?.params).toMatchObject({ action: "create", username: "acme" });
    const key = randomBytes(32);
    const s = secrets();
    const replaced = planStacks(
      withFingerprints(key, s),
      desired({
        record,
        registry,
        valueFingerprints: fingerprintsFor(key, s),
        replaceTokens: { registry: true },
      }),
    );
    expect(replaced.changes[0]?.params).toMatchObject({ action: "update", username: "acme" });
  });

  it("sends only OpsCrew's own entry name and ghcr.io, never what Portainer shows", () => {
    const key = randomBytes(32);
    const s = secrets();
    const fingerprints = fingerprintsFor(key, s);
    const replace = desired({
      record,
      valueFingerprints: fingerprints,
      replaceTokens: { registry: true },
    });
    // Another spelling of ghcr.io: the update sends the constant.
    const spelled = withFingerprints(key, s);
    spelled.registryEntries = [
      { id: 100, name: "opscrew-shop", url: "https://GHCR.io/", environments: [3] },
    ];
    expect(planStacks(spelled, replace).changes[0]?.params).toMatchObject({
      action: "update",
      name: "opscrew-shop",
      url: "ghcr.io",
    });
    // A renamed entry: blocked, naming it.
    const renamed = withFingerprints(key, s);
    renamed.registryEntries = [{ id: 100, name: "team-ghcr", url: "ghcr.io", environments: [3] }];
    const plan = planStacks(renamed, replace);
    expect(plan.changes[0]).toMatchObject({
      id: "registry",
      state: "blocked",
      params: { name: "opscrew-shop", url: "ghcr.io", registryId: 100 },
    });
    expect(plan.changes[0]?.reason).toMatch(
      /OpsCrew added \(id 100\) is now named "team-ghcr", not opscrew-shop.*Rename it back/,
    );
    expect(JSON.stringify(plan.changes[0]?.params)).not.toContain("team-ghcr");
  });

  it("adds a missing entry as usual: creating it sends the token anyway", async () => {
    const key = randomBytes(32);
    const s = secrets();
    const fingerprints = fingerprintsFor(key, s);
    const facts = await world().inspect();
    const replaced = planStacks(
      facts,
      desired({ valueFingerprints: fingerprints, replaceTokens: { registry: true } }),
    );
    const usual = planStacks(facts, desired({ valueFingerprints: fingerprints }));
    expect(replaced.changes[0]?.params.action).toBe("create");
    expect(replaced.changes).toEqual(usual.changes);
    expect(replaced.valuesDigest).toBe(usual.valuesDigest);
  });

  it("binds every token a change sends, and needs its fingerprint", async () => {
    const key = randomBytes(32);
    const s = secrets();
    const facts = await world().inspect();
    const all = fingerprintsFor(key, s);
    const { repositoryToken: _repository, ...noRepositoryToken } = all;
    const { registryToken: _registry, ...noRegistryToken } = all;
    const { repositoryToken: _r, registryToken: _g, ...noTokens } = all;
    // A first setup creates the registry entry and the private Git stack: both tokens go out.
    expect(() => planStacks(facts, desired({ valueFingerprints: noRepositoryToken }))).toThrow(
      /valueFingerprints\.repositoryToken is missing/,
    );
    expect(() => planStacks(facts, desired({ valueFingerprints: noRegistryToken }))).toThrow(
      /valueFingerprints\.registryToken is missing/,
    );
    // Without a private repository or image, no token goes out and none is needed.
    const open = planStacks(
      facts,
      desired({
        repository: {
          url: REPO,
          branch: "opscrew-deploy",
          composeFile: "compose.yaml",
          private: false,
        },
        registry: { url: "ghcr.io", private: false },
        valueFingerprints: noTokens,
      }),
    );
    expect(open.valuesDigest).toMatch(/^[0-9a-f]{64}$/);
    // A different registry token gives another digest, even on a first setup.
    const rotated = planStacks(
      facts,
      desired({
        valueFingerprints: fingerprintsFor(key, {
          ...s,
          registryToken: fakeSecret("github-token", "next"),
        }),
      }),
    );
    const usual = planStacks(facts, desired({ valueFingerprints: all }));
    expect(rotated.valuesDigest).not.toBe(usual.valuesDigest);
  });

  it("refuses a replace it cannot do, and blocks one a limited token cannot do", async () => {
    const key = randomBytes(32);
    const s = secrets();
    const facts = await world().inspect();
    const all = fingerprintsFor(key, s);
    const { repositoryToken: _repository, ...noRepositoryToken } = all;
    const { registryToken: _registry, ...noRegistryToken } = all;
    const cases: Array<[Partial<DesiredStacks>, RegExp]> = [
      [
        {
          repository: {
            url: REPO,
            branch: "opscrew-deploy",
            composeFile: "compose.yaml",
            private: false,
          },
          replaceTokens: { repository: true },
        },
        /replaceTokens\.repository: needs a private repository/,
      ],
      [
        { registry: { url: "ghcr.io", private: false }, replaceTokens: { registry: true } },
        /replaceTokens\.registry: needs a private image/,
      ],
      [
        { valueFingerprints: noRepositoryToken, replaceTokens: { repository: true } },
        /valueFingerprints\.repositoryToken: is required to replace the repository token/,
      ],
      [
        { valueFingerprints: noRegistryToken, replaceTokens: { registry: true } },
        /valueFingerprints\.registryToken: is required to replace the registry token/,
      ],
    ];
    for (const [overrides, pattern] of cases) {
      expect(() => planStacks(facts, desired({ valueFingerprints: all, ...overrides }))).toThrow(
        pattern,
      );
    }
    expect(() =>
      planStacks(
        facts,
        desired({ valueFingerprints: undefined, replaceTokens: { repository: true } }),
      ),
    ).toThrow(/valueFingerprints\.repositoryToken: is required/);

    const limited = planStacks(
      await world().inspect("limited"),
      desired({ valueFingerprints: all, replaceTokens: { registry: true } }),
    );
    expect(limited.changes[0]).toMatchObject({ id: "registry", state: "blocked" });
    expect(limited.changes[0]?.reason).toMatch(/Only a Portainer administrator's token/);
  });
});

/** `setUp()` facts as a client with `key` reads them, holding the values of `s`. */
function withFingerprints(key: Uint8Array, s: ReturnType<typeof secrets>): PortainerFacts {
  const base = setUp({
    version: "2.45.2",
    composeVersion: "2.39.1",
    user: { id: 1, username: "admin", role: "admin" },
    environments: [{ id: 3, name: "nas", kind: "docker", type: 1, swarm: false, status: "up" }],
    environment: { id: 3, name: "nas", arch: "amd64" },
    stacks: [],
    findings: [],
  });
  const [app, updater] = base.stacks;
  if (app?.autoUpdate === undefined || updater === undefined) throw new Error("setUp");
  app.envFingerprints = valueFingerprints(key, s.env);
  app.autoUpdate.webhookFingerprint = valueFingerprint(key, "webhook", s.webhookId);
  updater.envFingerprints = valueFingerprints(key, s.updaterEnv);
  return base;
}
