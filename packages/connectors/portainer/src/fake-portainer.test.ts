import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fakePortainer } from "./__fixtures__/fake-portainer";
import { portainerClient } from "./client";

/** The fake encodes what research R5, R7 and R11 observed on Portainer CE 2.45.2. */

const endpoint = { url: "https://nas.lan:9443", certFingerprint: `SHA256:${"AB".repeat(32)}` };
const GOOD = "services:\n  web:\n    image: app@sha256:1\n";
const NEXT = "services:\n  web:\n    image: app@sha256:2\n";

async function runningStack(options: Parameters<typeof fakePortainer>[0] = {}) {
  const fake = fakePortainer(options);
  const client = portainerClient(endpoint, fake.tokens.admin, { request: fake.request });
  const created = await client.createStringStack(3, {
    name: "opscrew-shop-updater",
    compose: GOOD,
    env: [{ name: "A", value: "1" }],
  });
  fake.settle();
  const stack = fake.state.stacks.find((item) => item.Id === created.id);
  if (stack === undefined) throw new Error("no stack");
  return { fake, client, stack };
}

describe("fake Portainer (R7 failure semantics)", () => {
  it("invalid YAML keeps the old containers and the last good file, but saves the new Env", async () => {
    const { fake, client, stack } = await runningStack();
    fake.state.outcomes.push({ kind: "invalid" });
    await client.updateStringStack(stack.Id, 3, {
      compose: "services: [",
      env: [{ name: "B", value: "2" }],
    });
    fake.settle();
    expect(stack.Status).toBe(4);
    expect(stack.containers).toBe("running");
    expect(stack.file).toBe(GOOD);
    expect(stack.Env).toEqual([{ name: "B", value: "2" }]);
    expect(stack.DeploymentStatus.at(-1)?.Message).toMatch(/yaml/);
  });

  it("a missing image keeps the containers only when the stack was healthy", async () => {
    const { fake, client, stack } = await runningStack();
    fake.state.outcomes.push({ kind: "missing-image" }, { kind: "missing-image" });
    await client.updateStringStack(stack.Id, 3, { compose: NEXT, env: [] });
    fake.settle();
    expect(stack.containers).toBe("running");
    await client.updateStringStack(stack.Id, 3, { compose: NEXT, env: [] });
    fake.settle();
    expect(stack.containers).toBe("none");
    expect(stack.file).toBe(GOOD);
  });

  it("a port conflict recreates the containers and leaves them stopped", async () => {
    const { fake, client, stack } = await runningStack();
    fake.state.outcomes.push({ kind: "port-conflict" });
    await client.updateStringStack(stack.Id, 3, { compose: NEXT, env: [] });
    fake.settle();
    expect(stack.Status).toBe(4);
    expect(stack.containers).toBe("stopped");
  });

  it("a stack already in error loses all its containers before its next deploy", async () => {
    const { fake, client, stack } = await runningStack({ deployPolls: 5 });
    fake.state.outcomes.push({ kind: "invalid" });
    await client.updateStringStack(stack.Id, 3, { compose: "x: [", env: [] });
    fake.settle();
    expect(stack.containers).toBe("running");
    await client.updateStringStack(stack.Id, 3, { compose: NEXT, env: [] });
    expect(stack.Status).toBe(3);
    expect(stack.containers).toBe("none");
    fake.settle();
    expect(stack.containers).toBe("running");
    expect(stack.file).toBe(NEXT);
  });

  it("an update without Env clears it", async () => {
    const { fake, stack } = await runningStack();
    const response = await fake.request({
      method: "PUT",
      path: `/api/stacks/${stack.Id}?endpointId=3`,
      headers: { "X-API-Key": fake.tokens.admin },
      body: JSON.stringify({ StackFileContent: NEXT }),
      timeoutMs: 1000,
    });
    expect(response.status).toBe(200);
    expect(stack.Env).toEqual([]);
  });

  it("deploys asynchronously: the answer says deploying, a later read says active", async () => {
    const fake = fakePortainer();
    const client = portainerClient(endpoint, fake.tokens.admin, { request: fake.request });
    const created = await client.createStringStack(3, {
      name: "opscrew-x",
      compose: GOOD,
      env: [],
    });
    expect(created.status).toBe(3);
    expect((await client.getStack(created.id))?.status).toBe(3);
    expect((await client.getStack(created.id))?.status).toBe(1);
  });
});

describe("fake Portainer (R5, R6, R11)", () => {
  it("ignores webhooks on string stacks", async () => {
    const { fake, stack } = await runningStack();
    const webhook = randomUUID();
    stack.AutoUpdate = { Webhook: webhook };
    const deploys = stack.deploys;
    expect((await fake.callWebhook(webhook)).status).toBe(204);
    expect(stack.deploys).toBe(deploys);
  });

  it("creates a Git stack only from a branch that exists (R11: push the placeholder first)", async () => {
    const fake = fakePortainer();
    const client = portainerClient(endpoint, fake.tokens.admin, { request: fake.request });
    await expect(
      client.createGitStack(3, {
        name: "opscrew-shop",
        repositoryUrl: "https://github.com/acme/shop",
        referenceName: "refs/heads/opscrew-deploy",
        composeFile: "compose.yaml",
        webhookId: randomUUID(),
        env: [],
      }),
    ).rejects.toThrow(/reference not found/);
    expect(fake.state.stacks).toEqual([]);
  });

  it("lowercases names and refuses a duplicate with 409", async () => {
    const { client } = await runningStack();
    await expect(
      client.createStringStack(3, { name: "OpsCrew-Shop-Updater", compose: GOOD, env: [] }),
    ).rejects.toThrow(/normalized name 'opscrew-shop-updater' already exists/);
  });
});
