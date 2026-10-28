import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { dockerFrames, fakePortainer } from "./__fixtures__/fake-portainer";
import { PortainerApiError, portainerClient } from "./client";
import { sinceAfter } from "./docker";
import { PortainerCertificateError } from "./pinned";
import { valueFingerprint, valueFingerprints } from "./values";

describe("valueFingerprints", () => {
  it("is HMAC-SHA256(key, name NUL value) in hex, per entry", () => {
    const key = randomBytes(32);
    const value = fakeSecret("generic-password", "hmac");
    const expected = createHmac("sha256", key).update(`DB_PASSWORD\0${value}`).digest("hex");
    expect(valueFingerprints(key, { DB_PASSWORD: value })).toEqual({ DB_PASSWORD: expected });
    // The name is part of it: the same value under another name differs.
    expect(valueFingerprints(key, { OTHER: value }).OTHER).not.toBe(expected);
    // One value alone gives the same fingerprint, and needs the same key.
    expect(valueFingerprint(key, "DB_PASSWORD", value)).toBe(expected);
    expect(() => valueFingerprint(randomBytes(8), "DB_PASSWORD", value)).toThrow(/16 bytes/);
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
      serverVersion: "29.9.1",
      swarmActive: false,
      cpus: 4,
      memoryBytes: 8 * 1024 ** 3,
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

  it("reduces containers to their project, service and published ports, volumes to name and project", async () => {
    const { client } = setup({
      containers: [
        { EndpointId: 3, project: "media", running: true, ports: [8096] },
        { EndpointId: 3, running: true, ports: [80, 443] },
        { EndpointId: 3, project: "old", running: false, ports: [8080] },
        { EndpointId: 3, project: "opscrew-shop", service: "worker", running: true, ports: [] },
        {
          EndpointId: 3,
          project: "opscrew-shop",
          service: "release",
          oneOff: true,
          running: false,
          ports: [],
        },
      ],
      volumes: [
        { EndpointId: 3, Name: "opscrew-shop_db-data", project: "opscrew-shop" },
        { EndpointId: 3, Name: "media_config", project: "media" },
      ],
    });
    const containers = await client.listContainers(3);
    expect(containers).toEqual([
      { id: "c0", project: "media", running: true, publishedPorts: [8096] },
      { id: "c1", running: true, publishedPorts: [80, 443] },
      { id: "c2", project: "old", running: false, publishedPorts: [] },
      // The Compose service, except for a one-off container.
      { id: "c3", project: "opscrew-shop", service: "worker", running: true, publishedPorts: [] },
      { id: "c4", project: "opscrew-shop", running: false, publishedPorts: [] },
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

  it("masks the token in a failed request's error, and passes a changed certificate on as it is", async () => {
    const token = fakePortainer().tokens.admin;
    const thrown = new OpsCrewError("PROVIDER_ERROR", `The proxy refused ${token}.`, {
      hint: `Retry without ${token}.`,
    });
    const leaky = portainerClient(endpoint, token, {
      request: async () => {
        throw thrown;
      },
    });
    const error = (await leaky.currentUser().catch((caught: unknown) => caught)) as OpsCrewError;
    // A new error: the one the request threw is left as it was.
    expect(error).not.toBe(thrown);
    expect(thrown.hint).toContain(token);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe("The proxy refused [REDACTED:PORTAINER_API_KEY].");
    expect(error.hint).toBe("Retry without [REDACTED:PORTAINER_API_KEY].");

    const changed = new PortainerCertificateError(
      `SHA256:${"AB".repeat(32)}`,
      `SHA256:${"CD".repeat(32)}`,
    );
    const pinned = portainerClient(endpoint, token, {
      request: async () => {
        throw changed;
      },
    });
    await expect(pinned.currentUser()).rejects.toBe(changed);
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

  it("sends a registry entry's login again, keeping its grants, never echoing the token", async () => {
    const { client, fake } = setup();
    const first = fakeSecret("github-token", "packages-first");
    const next = fakeSecret("github-token", "packages-next");
    const { id } = await client.createRegistry({
      name: "opscrew-shop",
      url: "ghcr.io",
      username: "acme",
      password: first,
    });
    await client.grantRegistry(3, id, 1);
    await client.updateRegistry(id, {
      name: "opscrew-shop",
      url: "ghcr.io",
      username: "acme",
      password: next,
    });
    const call = fake.calls.at(-1);
    expect(`${call?.method} ${call?.path}`).toBe(`PUT /api/registries/${id}`);
    expect(call?.body).toEqual({
      Name: "opscrew-shop",
      URL: "ghcr.io",
      Authentication: true,
      Username: "acme",
      Password: next,
    });
    const entry = fake.state.registries.find((registry) => registry.Id === id);
    expect(entry?.Password).toBe(next);
    expect(entry?.accesses).toEqual({ 3: [1] });

    const limited = setup({ registries: fake.state.registries }, "limited").client;
    const refused = (await limited
      .updateRegistry(id, {
        name: "opscrew-shop",
        url: "ghcr.io",
        username: "acme",
        password: next,
      })
      .catch((caught: unknown) => caught)) as PortainerApiError;
    expect(refused.status).toBe(403);
    expect(refused.message).toMatch(/replace the token of the registry entry opscrew-shop/);
    expect(`${refused.message}${refused.hint}`).not.toContain(next);
  });
});

describe("container reads", () => {
  const T1 = "2026-10-28T09:00:01.000000001Z";
  const T2 = "2026-10-28T09:00:02.000000002Z";
  const stack = (ownerId: number) => ({
    Id: 7,
    Name: "opscrew-shop",
    Type: 2 as const,
    EndpointId: 3,
    Env: [],
    Status: 1 as const,
    DeploymentStatus: [],
    AutoUpdate: null,
    GitConfig: null,
    file: "services: {}",
    ownerId,
    containers: "none" as const,
    ports: [],
    deploys: 1,
  });
  const app = {
    EndpointId: 3,
    project: "opscrew-shop",
    service: "app",
    running: true,
    ports: [],
    id: "a1b2c3",
  };

  it("reads a container's log lines with the fixed query, since in nanoseconds", async () => {
    const { client, fake } = setup({
      stacks: [stack(1)],
      containers: [
        {
          ...app,
          logs: dockerFrames([1, `${T1} up\n${T2} GET /`], [2, `${T2} oops\n`], [1, " 200\n"]),
        },
      ],
    });
    const since = sinceAfter(T1);
    expect(await client.containerLogs(3, "a1b2c3", { tail: 50, since })).toEqual([
      { stream: "stdout", time: T1, line: "up" },
      { stream: "stderr", time: T2, line: "oops" },
      { stream: "stdout", time: T2, line: "GET / 200" },
    ]);
    await client.containerLogs(3, "a1b2c3", { tail: 200, since: 1_761_642_000 });
    await client.containerLogs(3, "a1b2c3", { tail: 200 });
    const logs = "/api/endpoints/3/docker/containers/a1b2c3/logs";
    expect(fake.calls.map((call) => [call.path, call.query.toString()])).toEqual([
      [logs, `stdout=1&stderr=1&timestamps=1&tail=50&since=${since}`],
      [logs, "stdout=1&stderr=1&timestamps=1&tail=200&since=1761642000"],
      [logs, "stdout=1&stderr=1&timestamps=1&tail=200"],
    ]);
    // Nothing but whole seconds or <seconds>.<nanoseconds> reaches the query.
    for (const bad of ["1&follow=1", "-5", "1.1234567890", "", -1, 1.5]) {
      await expect(
        client.containerLogs(3, "a1b2c3", { tail: 10, since: bad }),
        String(bad),
      ).rejects.toThrow(/since/);
    }
    await expect(client.containerLogs(3, "a1b2c3", { tail: 0 })).rejects.toThrow(/tail/);
    await expect(client.containerLogs(3, "../../info", { tail: 10 })).rejects.toThrow(/container/);
    expect(fake.calls).toHaveLength(3);
  });

  it("passes a TTY container's raw stream as stdout", async () => {
    const { client } = setup({
      containers: [{ ...app, project: "other", logs: Buffer.from(`${T1} one\r\n${T2} two\r\n`) }],
    });
    expect(await client.containerLogs(3, "a1b2c3", { tail: 10 })).toEqual([
      { stream: "stdout", time: T1, line: "one" },
      { stream: "stdout", time: T2, line: "two" },
    ]);
  });

  it("reads one stats sample without one-shot, and the host's memory as no limit", async () => {
    const host = 8 * 1024 ** 3;
    const sample = (limit: number) => ({
      read: "2026-10-28T09:00:02Z",
      cpu_stats: {
        cpu_usage: { total_usage: 3_000_000_000 },
        system_cpu_usage: 200_000_000_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 2_000_000_000 },
        system_cpu_usage: 190_000_000_000,
        online_cpus: 2,
      },
      memory_stats: { usage: 500_000_000, limit, stats: { inactive_file: 200_000_000 } },
      networks: { eth0: { rx_bytes: 1 } },
    });
    const { client, fake } = setup({
      containers: [
        { ...app, stats: sample(host) },
        { ...app, id: "limited", stats: sample(256 * 1024 * 1024) },
      ],
    });
    const figures = await client.containerStats(3, "a1b2c3");
    // (1e9 / 10e9) × 2 × 100
    expect(figures.cpuPercent).toBeCloseTo(20, 10);
    expect(figures).toEqual({ cpuPercent: figures.cpuPercent, memoryUsedBytes: 300_000_000 });
    expect(await client.containerStats(3, "limited")).toMatchObject({
      memoryLimitBytes: 256 * 1024 * 1024,
    });
    const stats = fake.calls.filter((call) => call.path.endsWith("/stats"));
    expect(stats.map((call) => call.query.toString())).toEqual(["stream=false", "stream=false"]);
  });

  it("keeps only the restart count, start time and memory limit: never Config.Env", async () => {
    const secret = fakeSecret("stripe-live-key", "inspect");
    const inspect = (memory: number) => ({
      Id: "a1b2c3",
      RestartCount: 2,
      State: { Status: "running", StartedAt: "2026-10-28T08:00:00.123456789Z", Pid: 42 },
      HostConfig: { Memory: memory, Binds: ["/srv:/srv"] },
      Config: { Env: [`STRIPE_KEY=${secret}`], Image: "ghcr.io/acme/shop" },
    });
    const { client } = setup({
      containers: [
        { ...app, inspect: inspect(536_870_912) },
        { ...app, id: "unlimited", inspect: inspect(0) },
      ],
    });
    const details = await client.containerInspect(3, "a1b2c3");
    expect(details).toEqual({
      restartCount: 2,
      startedAt: "2026-10-28T08:00:00.123456789Z",
      memoryLimitBytes: 536_870_912,
    });
    expect(JSON.stringify(details)).not.toContain(secret);
    expect(await client.containerInspect(3, "unlimited")).toEqual({
      restartCount: 2,
      startedAt: "2026-10-28T08:00:00.123456789Z",
    });
  });

  it("says on 403 that a standard user's token sees only that user's stacks", async () => {
    const { client } = setup({ stacks: [stack(1)], containers: [app] }, "limited");
    for (const read of [
      () => client.containerLogs(3, "a1b2c3", { tail: 10 }),
      () => client.containerStats(3, "a1b2c3"),
      () => client.containerInspect(3, "a1b2c3"),
    ]) {
      const error = (await read().catch((caught: unknown) => caught)) as PortainerApiError;
      expect(error).toBeInstanceOf(PortainerApiError);
      expect(error.status).toBe(403);
      expect(error.message).toMatch(/may not read this container/);
      expect(error.message).toMatch(
        /a standard user's token sees only the containers of that user's own stacks/,
      );
      expect(error.hint).toMatch(/administrator's access token/);
    }
    // The stack's owner reads them.
    const owner = setup(
      { stacks: [stack(2)], containers: [{ ...app, logs: new Uint8Array() }] },
      "limited",
    );
    expect(await owner.client.containerLogs(3, "a1b2c3", { tail: 10 })).toEqual([]);
  });
});
