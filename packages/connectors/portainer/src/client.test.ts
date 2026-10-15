import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { type OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakePortainer } from "./__fixtures__/fake-portainer";
import { PortainerApiError, portainerClient } from "./client";
import { valueFingerprints } from "./values";

describe("valueFingerprints", () => {
  it("is HMAC-SHA256(key, name NUL value) in hex, per entry", () => {
    const key = randomBytes(32);
    const value = fakeSecret("generic-password", "hmac");
    const expected = createHmac("sha256", key).update(`DB_PASSWORD\0${value}`).digest("hex");
    expect(valueFingerprints(key, { DB_PASSWORD: value })).toEqual({ DB_PASSWORD: expected });
    // The name is part of it: the same value under another name differs.
    expect(valueFingerprints(key, { OTHER: value }).OTHER).not.toBe(expected);
  });
});

const endpoint = { url: "https://nas.lan:9443", certFingerprint: `SHA256:${"AB".repeat(32)}` };

function setup(
  options: Parameters<typeof fakePortainer>[0] = {},
  role: "admin" | "limited" = "admin",
) {
  const fake = fakePortainer(options);
  const redactor = new Redactor();
  const token = role === "admin" ? fake.tokens.admin : fake.tokens.limited;
  const client = portainerClient(endpoint, token, { request: fake.request, redactor });
  return { fake, client, redactor, token };
}

describe("portainerClient", () => {
  it("validates the endpoint even with an injected request function", () => {
    const fake = fakePortainer();
    expect(() =>
      portainerClient({ url: "http://nas.lan:9000" }, fake.tokens.admin, { request: fake.request }),
    ).toThrow(/plain HTTP/);
    expect(() =>
      portainerClient({ url: "https://nas.lan:9443" }, fake.tokens.admin, {
        request: fake.request,
      }),
    ).toThrow(/certificate/);
    expect(() => portainerClient(endpoint, "", { request: fake.request })).toThrow(
      /PORTAINER_API_KEY/,
    );
  });

  it("sends X-API-Key on every authenticated call and registers the token", async () => {
    const { fake, client, redactor, token } = setup();
    await client.systemStatus();
    await client.systemVersion();
    await client.currentUser();
    await client.listEnvironments();
    expect(fake.calls[0]?.headers["X-API-Key"]).toBeUndefined();
    for (const call of fake.calls.slice(1)) expect(call.headers["X-API-Key"]).toBe(token);
    expect(redactor.redact(`token ${token}`)).toBe("token [REDACTED:PORTAINER_API_KEY]");
  });

  it("parses version, user and environments", async () => {
    const { client } = setup();
    expect(await client.systemStatus()).toEqual({ version: "2.45.2" });
    const version = await client.systemVersion();
    expect(version).toEqual({
      version: "2.45.2",
      edition: "CE",
      support: "LTS",
      composeVersion: "2.39.1",
      dockerVersion: "29.0.0",
    });
    expect(JSON.stringify(version)).not.toContain("PORTAINER_INTERNAL");
    expect(await client.currentUser()).toEqual({ id: 1, username: "admin", role: "admin" });
    expect(await client.listEnvironments()).toEqual([
      { id: 3, name: "nas", type: 1, status: 1, swarm: false },
    ]);
    expect(await client.dockerInfo(3)).toEqual({
      architecture: "x86_64",
      osType: "linux",
      serverVersion: "29.9.1",
      swarmActive: false,
    });
  });

  it("keeps only env keys, never values, the webhook id or a Git password", async () => {
    const secretValue = fakeSecret("stripe-live-key", "env");
    const gitPassword = fakeSecret("github-pat", "repo");
    const webhook = randomUUID();
    const { client } = setup({
      stacks: [
        {
          Id: 7,
          Name: "opscrew-shop",
          Type: 2,
          EndpointId: 3,
          Env: [
            { name: "STRIPE_KEY", value: secretValue },
            { name: "A_FIRST", value: "x" },
          ],
          Status: 1,
          DeploymentStatus: [{ Status: 1, Time: 1 }],
          AutoUpdate: { Webhook: webhook, ForcePullImage: false },
          GitConfig: {
            URL: `https://user:${gitPassword}@github.com/acme/shop.git`,
            ReferenceName: "refs/heads/opscrew-deploy",
            ConfigFilePath: "compose.yaml",
            Authentication: { Username: "x-access-token", Password: gitPassword },
          },
          file: "services: {}\n",
          ownerId: 1,
          containers: "running",
          ports: [],
          deploys: 1,
        },
      ],
    });
    const [stack] = await client.listStacks(3);
    const single = await client.getStack(7);
    for (const value of [stack, single]) {
      const text = JSON.stringify(value);
      expect(text).not.toContain(secretValue);
      expect(text).not.toContain(gitPassword);
      expect(text).not.toContain(webhook);
    }
    expect(stack).toEqual({
      id: 7,
      name: "opscrew-shop",
      type: 2,
      environmentId: 3,
      status: 1,
      deploymentStatus: [{ status: 1, time: 1 }],
      envKeys: ["A_FIRST", "STRIPE_KEY"],
      autoUpdate: { webhook: true, forcePullImage: false, forceUpdate: false },
      gitConfig: {
        url: "https://github.com/acme/shop.git",
        referenceName: "refs/heads/opscrew-deploy",
        configFilePath: "compose.yaml",
        authenticated: true,
      },
    });
    expect(await client.getStack(999)).toBeUndefined();
  });

  it("with a value key, keeps keyed fingerprints of the values and the webhook, never them", async () => {
    const key = randomBytes(32);
    const secretValue = fakeSecret("stripe-live-key", "fingerprinted");
    const webhook = randomUUID();
    const fake = fakePortainer({
      stacks: [
        {
          Id: 7,
          Name: "opscrew-shop",
          Type: 2,
          EndpointId: 3,
          Env: [{ name: "STRIPE_KEY", value: secretValue }],
          Status: 1,
          DeploymentStatus: [],
          AutoUpdate: { Webhook: webhook, ForcePullImage: false },
          GitConfig: null,
          file: "services: {}\n",
          ownerId: 1,
          containers: "running",
          ports: [],
          deploys: 1,
        },
      ],
    });
    const client = portainerClient(endpoint, fake.tokens.admin, {
      request: fake.request,
      valueKey: key,
    });
    const stack = await client.getStack(7);
    expect(stack?.envFingerprints).toEqual(valueFingerprints(key, { STRIPE_KEY: secretValue }));
    expect(stack?.autoUpdate?.webhookFingerprint).toBe(valueFingerprints(key, { webhook }).webhook);
    const text = JSON.stringify(stack);
    expect(text).not.toContain(secretValue);
    expect(text).not.toContain(webhook);
    // Another key gives other fingerprints: they say nothing without the local key.
    expect(valueFingerprints(randomBytes(32), { STRIPE_KEY: secretValue }).STRIPE_KEY).not.toBe(
      stack?.envFingerprints?.STRIPE_KEY,
    );
    expect(() =>
      portainerClient(endpoint, fake.tokens.admin, {
        request: fake.request,
        valueKey: new Uint8Array(4),
      }),
    ).toThrow(/at least 16 bytes/);
  });

  it("reduces containers to their project and published ports, volumes to name and project", async () => {
    const { client } = setup({
      containers: [
        { EndpointId: 3, project: "media", running: true, ports: [8096] },
        { EndpointId: 3, running: true, ports: [80, 443] },
        { EndpointId: 3, project: "old", running: false, ports: [8080] },
      ],
      volumes: [
        { EndpointId: 3, Name: "opscrew-shop_db-data", project: "opscrew-shop" },
        { EndpointId: 3, Name: "media_config", project: "media" },
      ],
    });
    const containers = await client.listContainers(3);
    expect(containers).toEqual([
      { project: "media", running: true, publishedPorts: [8096] },
      { running: true, publishedPorts: [80, 443] },
      { project: "old", running: false, publishedPorts: [] },
    ]);
    expect(JSON.stringify(containers)).not.toContain("basicauth");
    expect(await client.listVolumes(3)).toEqual([
      { name: "opscrew-shop_db-data", project: "opscrew-shop" },
      { name: "media_config", project: "media" },
    ]);
  });

  it("names the missing access on 401 and 403, and never the token", async () => {
    const fake = fakePortainer();
    const wrong = fakeSecret("hcloud-token", "wrong-portainer-token");
    const client = portainerClient(endpoint, wrong, { request: fake.request });
    const error = (await client
      .currentUser()
      .catch((caught: unknown) => caught)) as PortainerApiError;
    expect(error).toBeInstanceOf(PortainerApiError);
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.status).toBe(401);
    expect(error.message).toMatch(/rejected the access token \(PORTAINER_API_KEY\)/);
    expect(`${error.message}${error.hint}`).not.toContain(wrong);

    const limited = setup({}, "limited").client;
    const refused = (await limited
      .listRegistries()
      .catch((caught: unknown) => caught)) as PortainerApiError;
    expect(refused.status).toBe(403);
    expect(refused.message).toMatch(/may not manage registries \(administrators only\)/);
  });

  it("names the conflicting stack on 409", async () => {
    const { client } = setup({
      git: {
        "https://github.com/acme/shop#refs/heads/opscrew-deploy": { commit: "c1", file: "x" },
      },
    });
    await client.createStringStack(3, { name: "opscrew-shop", compose: "services: {}", env: [] });
    const error = (await client
      .createStringStack(3, { name: "opscrew-shop", compose: "services: {}", env: [] })
      .catch((caught: unknown) => caught)) as PortainerApiError;
    expect(error.status).toBe(409);
    expect(error.message).toContain("opscrew-shop");
  });

  it("redacts the token and registered secrets if Portainer echoes them", async () => {
    const repoToken = fakeSecret("github-pat", "echo");
    const fake = fakePortainer({
      override: (call) =>
        call.method === "PUT"
          ? {
              status: 500,
              body: {
                message: "Unable to clone",
                details: `https://x-access-token:${repoToken}@github.com/acme/shop ${call.headers["X-API-Key"]}`,
              },
            }
          : undefined,
    });
    const client = portainerClient(endpoint, fake.tokens.admin, { request: fake.request });
    client.registerSecret(repoToken, "repository-token");
    const error = (await client
      .updateStringStack(1, 3, { compose: "x", env: [] })
      .catch((caught: unknown) => caught)) as OpsCrewError;
    expect(error.message).not.toContain(repoToken);
    expect(error.message).not.toContain(fake.tokens.admin);
    expect(client.redact(repoToken)).toBe("[REDACTED:repository-token]");
  });

  it("refuses ids and volume names that are not valid, before sending anything", async () => {
    const { fake, client } = setup();
    await expect(client.getStack(Number.NaN)).rejects.toThrow(/positive whole numbers/);
    await expect(client.removeStack(-1, 3)).rejects.toThrow(/positive whole numbers/);
    await expect(client.removeVolume(3, "../../containers")).rejects.toThrow(/volume name/);
    expect(fake.calls).toEqual([]);
  });

  it("reports an unexpected answer plainly", async () => {
    const fake = fakePortainer({
      override: (call) =>
        call.path === "/api/users/me" ? { status: 200, body: { Id: "one" } } : undefined,
    });
    const client = portainerClient(endpoint, fake.tokens.admin, { request: fake.request });
    await expect(client.currentUser()).rejects.toThrow(/unexpected answer.*Id/);
    const invalid = fakePortainer({
      override: () => ({ status: 200 }),
    });
    const other = portainerClient(endpoint, invalid.tokens.admin, { request: invalid.request });
    await expect(other.systemVersion()).rejects.toThrow(/invalid JSON/);
  });

  it("treats 404 on removals as already gone", async () => {
    const { client } = setup();
    expect(await client.removeStack(55, 3)).toBe("absent");
    expect(await client.removeRegistry(55)).toBe("absent");
    expect(await client.removeVolume(3, "missing")).toBe("absent");
  });
});
