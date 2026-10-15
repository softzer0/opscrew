import { randomUUID } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { type FakeStack, fakePortainer } from "./__fixtures__/fake-portainer";
import { portainerClient } from "./client";
import { inspectPortainer } from "./inspect";
import { opscrewStackNames } from "./names";

const endpoint = { url: "https://nas.lan:9443", certFingerprint: `SHA256:${"AB".repeat(32)}` };
const names = opscrewStackNames("shop");

function stack(overrides: Partial<FakeStack> & Pick<FakeStack, "Id" | "Name">): FakeStack {
  return {
    Type: 2,
    EndpointId: 3,
    Env: [],
    Status: 1,
    DeploymentStatus: [{ Status: 1, Time: 1 }],
    AutoUpdate: null,
    GitConfig: null,
    file: "services:\n  updater:\n    image: curl\n",
    ownerId: 1,
    containers: "running",
    ports: [],
    deploys: 1,
    ...overrides,
  };
}

function connect(fake: ReturnType<typeof fakePortainer>, role: "admin" | "limited" = "admin") {
  return portainerClient(endpoint, role === "admin" ? fake.tokens.admin : fake.tokens.limited, {
    request: fake.request,
  });
}

const codes = (facts: { findings: { code: string }[] }) => facts.findings.map((f) => f.code);

describe("inspectPortainer", () => {
  it("reads version, user and environments without an environment chosen", async () => {
    const fake = fakePortainer();
    const facts = await inspectPortainer(connect(fake), { names });
    expect(facts).toMatchObject({
      version: "2.45.2",
      edition: "CE",
      composeVersion: "2.39.1",
      user: { id: 1, username: "admin", role: "admin" },
      environments: [{ id: 3, name: "nas", kind: "docker", swarm: false, status: "up" }],
      stacks: [],
      findings: [],
    });
    expect(facts.environment).toBeUndefined();
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reads the chosen environment: architecture, OpsCrew stacks with env keys only, registries, projects, ports", async () => {
    const secret = fakeSecret("stripe-live-key", "inspect");
    const webhook = randomUUID();
    const fake = fakePortainer({
      environments: [
        {
          Id: 3,
          Name: "nas",
          Type: 2,
          Status: 1,
          swarm: false,
          arch: "aarch64",
          dockerVersion: "29.9.1",
          users: [2],
        },
      ],
      stacks: [
        stack({
          Id: 7,
          Name: "opscrew-shop",
          Env: [{ name: "STRIPE_KEY", value: secret }],
          AutoUpdate: { Webhook: webhook, ForcePullImage: false },
          GitConfig: {
            URL: "https://github.com/acme/shop",
            ReferenceName: "refs/heads/opscrew-deploy",
            ConfigFilePath: "compose.yaml",
            Authentication: null,
          },
          ports: [80, 443],
        }),
        stack({ Id: 8, Name: "jellyfin", Env: [{ name: "PASSWORD", value: secret }] }),
      ],
      registries: [
        {
          Id: 4,
          Name: "ghcr",
          Type: 3,
          URL: "ghcr.io",
          Username: "acme",
          Password: fakeSecret("github-token", "registry"),
          accesses: { 3: [2] },
        },
      ],
      containers: [{ EndpointId: 3, project: "jellyfin", running: true, ports: [8096] }],
      volumes: [
        { EndpointId: 3, Name: "opscrew-shop_db-data", project: "opscrew-shop" },
        { EndpointId: 3, Name: "jellyfin_config", project: "jellyfin" },
      ],
    });
    const facts = await inspectPortainer(connect(fake), { environmentId: 3, names });
    expect(facts.findings).toEqual([]);
    expect(facts.environment).toEqual({
      id: 3,
      name: "nas",
      arch: "arm64",
      dockerVersion: "29.9.1",
    });
    expect(facts.stacks).toHaveLength(1);
    expect(facts.stacks[0]).toMatchObject({
      id: 7,
      name: "opscrew-shop",
      envKeys: ["STRIPE_KEY"],
      autoUpdate: { webhook: true, forcePullImage: false },
      file: "services:\n  updater:\n    image: curl\n",
    });
    expect(facts.stacks[0]?.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.registries).toEqual([{ id: 4, name: "ghcr", url: "ghcr.io", type: 3 }]);
    expect(facts.registryEntries).toEqual([
      { id: 4, name: "ghcr", url: "ghcr.io", type: 3, environments: [3] },
    ]);
    expect(facts.projects).toEqual([{ name: "opscrew-shop", containers: 1 }]);
    expect(facts.publishedPorts).toEqual([
      { port: 80, project: "opscrew-shop" },
      { port: 443, project: "opscrew-shop" },
      { port: 8096, project: "jellyfin" },
    ]);
    expect(facts.volumes).toEqual([{ name: "opscrew-shop_db-data", project: "opscrew-shop" }]);
    const text = JSON.stringify(facts);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(webhook);
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("with a limited token, skips admin-only reads and still sees its registries", async () => {
    const fake = fakePortainer({
      registries: [
        {
          Id: 4,
          Name: "ghcr",
          Type: 3,
          URL: "ghcr.io",
          Username: "acme",
          Password: "x",
          accesses: { 3: [2] },
        },
      ],
    });
    const facts = await inspectPortainer(connect(fake, "limited"), { environmentId: 3, names });
    expect(facts.user?.role).toBe("user");
    expect(facts.findings).toEqual([]);
    expect(facts.registries).toEqual([{ id: 4, name: "ghcr", url: "ghcr.io", type: 3 }]);
    expect(facts.registryEntries).toBeUndefined();
    expect(facts.projects).toBeUndefined();
    expect(facts.publishedPorts).toBeUndefined();
    expect(fake.calls.map((call) => call.path)).not.toContain("/api/registries");
  });

  it("refuses Portainer older than 2.45 and Compose older than 2.23", async () => {
    const facts = await inspectPortainer(
      connect(fakePortainer({ version: "2.33.1", composeVersion: "v2.21.0" })),
      { names },
    );
    expect(codes(facts)).toEqual(["portainer-version", "compose-version"]);
    expect(facts.findings[0]?.message).toContain("2.33.1");
    expect(facts.findings[1]?.message).toContain("2.21.0");
    const ok = await inspectPortainer(connect(fakePortainer({ version: "2.46.0-rc1" })), { names });
    expect(ok.findings).toEqual([]);
  });

  it("refuses Swarm, Kubernetes, Edge and down environments", async () => {
    const base = {
      Status: 1 as const,
      swarm: false,
      arch: "x86_64",
      dockerVersion: "29",
      users: [],
    };
    const fake = fakePortainer({
      environments: [
        { ...base, Id: 1, Name: "swarm", Type: 2, swarm: true },
        { ...base, Id: 2, Name: "k8s", Type: 5 },
        { ...base, Id: 3, Name: "edge", Type: 4 },
        { ...base, Id: 4, Name: "off", Type: 1, Status: 2 },
        { ...base, Id: 5, Name: "aci", Type: 3 },
        { ...base, Id: 6, Name: "arm32", Type: 1, arch: "armv7l" },
      ],
    });
    const client = connect(fake);
    const expected: Record<number, string> = {
      1: "environment-type",
      2: "environment-type",
      3: "environment-type",
      4: "environment-down",
      5: "environment-type",
      6: "architecture",
    };
    for (const [id, code] of Object.entries(expected)) {
      const facts = await inspectPortainer(client, { environmentId: Number(id), names });
      expect(codes(facts), `environment ${id}`).toEqual([code]);
    }
    const swarm = await inspectPortainer(client, { environmentId: 1, names });
    expect(swarm.findings[0]?.message).toMatch(/Swarm/);
    const edge = await inspectPortainer(client, { environmentId: 3, names });
    expect(edge.findings[0]?.message).toMatch(/Edge/);
  });

  it("names the missing access: a rejected token, an environment the user may not use", async () => {
    const fake = fakePortainer();
    const wrong = portainerClient(endpoint, fakeSecret("hcloud-token", "revoked"), {
      request: fake.request,
    });
    const rejected = await inspectPortainer(wrong, { environmentId: 3, names });
    expect(codes(rejected)).toEqual(["token-rejected"]);
    expect(rejected.findings[0]?.message).toMatch(/401/);
    expect(rejected.findings[0]?.hint).toMatch(/PORTAINER_API_KEY/);

    const noAccess = fakePortainer({
      environments: [
        {
          Id: 3,
          Name: "nas",
          Type: 1,
          Status: 1,
          swarm: false,
          arch: "x86_64",
          dockerVersion: "29",
          users: [],
        },
      ],
    });
    const facts = await inspectPortainer(connect(noAccess, "limited"), { environmentId: 3, names });
    expect(codes(facts)).toEqual(["environment-missing"]);
    expect(facts.findings[0]?.hint).toMatch(/access/);
  });

  it("turns a 403 on a read into a finding naming the access", async () => {
    const fake = fakePortainer({
      override: (call) =>
        call.path === "/api/stacks"
          ? { status: 403, body: { message: "Access denied" } }
          : undefined,
    });
    const facts = await inspectPortainer(connect(fake, "limited"), { environmentId: 3, names });
    expect(codes(facts)).toEqual(["access-denied"]);
    expect(facts.findings[0]?.message).toMatch(/403/);
    expect(facts.findings[0]?.message).toMatch(/manage stacks/);
  });

  it("blocks when Portainer does not report its Compose version", async () => {
    const fake = fakePortainer({
      override: (call) =>
        call.path === "/api/system/version"
          ? {
              status: 200,
              body: { ServerVersion: "2.45.2", ServerEdition: "CE", Dependencies: {} },
            }
          : undefined,
    });
    const facts = await inspectPortainer(connect(fake), { names });
    expect(codes(facts)).toEqual(["compose-version"]);
    expect(facts.findings[0]?.message).toMatch(/could not read the Compose version/);
  });

  it("sees volumes named like the app's whatever their label, so a teardown can refuse them", async () => {
    const fake = fakePortainer({
      volumes: [
        { EndpointId: 3, Name: "opscrew-shop_db-data", project: "jellyfin" },
        { EndpointId: 3, Name: "opscrew-shop_cache" },
        { EndpointId: 3, Name: "jellyfin_config", project: "jellyfin" },
      ],
    });
    const facts = await inspectPortainer(connect(fake), { environmentId: 3, names });
    expect(facts.volumes).toEqual([
      { name: "opscrew-shop_db-data", project: "jellyfin" },
      { name: "opscrew-shop_cache" },
    ]);
  });

  it("refuses names that are not OpsCrew's", async () => {
    const client = connect(fakePortainer());
    await expect(inspectPortainer(client, { names: ["jellyfin"] })).rejects.toThrow(/opscrew-/);
    await expect(inspectPortainer(client, { names, environmentId: 0 })).rejects.toThrow();
  });
});
