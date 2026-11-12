import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const KEYS = "/repos/acme/shop/keys";
const BODY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOpscrewDeployKeyBodyForTestsOnly0000000";
const PUBLIC_KEY = `${BODY} opscrew@shop-prod`;
const TITLE = "opscrew shop-prod";

const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

function key(id: number, title: string, body: string, readOnly = true) {
  return { id, title, key: body, read_only: readOnly, verified: true };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  const opsError = error as OpsCrewError;
  expect(`${opsError.message} ${opsError.hint ?? ""} ${JSON.stringify(error)}`).not.toContain(
    TOKEN,
  );
  return opsError;
}

describe("deploy keys", () => {
  it("adds a read-only key and answers its id", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${KEYS}`]: { body: [key(7, "someone else", "ssh-ed25519 AAAAother")] },
      [`POST ${KEYS}`]: { status: 201, body: key(42, TITLE, BODY) },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    expect(await client.addDeployKey("acme", "shop", TITLE, PUBLIC_KEY)).toEqual({
      id: 42,
      state: "added",
    });
    expect(calls[0]?.url).toContain(`${KEYS}?per_page=100`);
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: KEYS,
      body: { title: TITLE, key: PUBLIC_KEY, read_only: true },
    });
  });

  it("reports a key with that title and key as existing, without adding it again", async () => {
    const { fetch, calls } = fakeFetch({ [`GET ${KEYS}`]: { body: [key(9, TITLE, BODY)] } });
    const client = new GitHubClient({ token: TOKEN, fetch });
    expect(await client.addDeployKey("acme", "shop", TITLE, PUBLIC_KEY)).toEqual({
      id: 9,
      state: "existing",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("adds the key when the one listed with that title can write", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${KEYS}`]: { body: [key(9, TITLE, BODY, false)] },
      [`POST ${KEYS}`]: { status: 422, body: { message: "Validation Failed" } },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).addDeployKey("acme", "shop", TITLE, PUBLIC_KEY),
    );
    expect(calls[1]?.method).toBe("POST");
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Validation Failed");
  });

  it("says a deploy key serves one repository only when GitHub answers the key is in use", async () => {
    const { fetch } = fakeFetch({
      [`GET ${KEYS}`]: { body: [] },
      [`POST ${KEYS}`]: {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            {
              resource: "PublicKey",
              code: "custom",
              field: "key",
              message: "key is already in use",
            },
          ],
        },
      },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).addDeployKey("acme", "shop", TITLE, PUBLIC_KEY),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("A deploy key serves one repository only");
    expect(error.hint).toContain("run the command again");
  });

  it("names Administration when the token can't add the key", async () => {
    const { fetch } = fakeFetch({
      [`GET ${KEYS}`]: { body: [] },
      [`POST ${KEYS}`]: {
        status: 403,
        body: { message: "Resource not accessible by personal access token" },
      },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).addDeployKey("acme", "shop", TITLE, PUBLIC_KEY),
    );
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Administration: Read and write");
  });

  it("lists every page of deploy keys", async () => {
    const next = `${GITHUB_API}${KEYS}?per_page=100&page=2`;
    const { fetch } = fakeFetch({
      [`GET ${KEYS}?per_page=100&page=2`]: { body: [key(2, "b", "ssh-rsa AAAAb", false)] },
      [`GET ${KEYS}`]: {
        body: [key(1, "a", "ssh-ed25519 AAAAa")],
        headers: { link: `<${next}>; rel="next"` },
      },
    });
    expect(await new GitHubClient({ token: TOKEN, fetch }).listDeployKeys("acme", "shop")).toEqual([
      { id: 1, title: "a", key: "ssh-ed25519 AAAAa", readOnly: true },
      { id: 2, title: "b", key: "ssh-rsa AAAAb", readOnly: false },
    ]);
  });

  it("refuses a deploy key list it can't read", async () => {
    const { fetch } = fakeFetch({ [`GET ${KEYS}`]: { body: [{ id: "x" }] } });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).listDeployKeys("acme", "shop"),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
  });

  it("names Administration: Read when the token can't list the keys", async () => {
    const { fetch } = fakeFetch({
      [`GET ${KEYS}`]: { status: 403, body: { message: "Resource not accessible" } },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).listDeployKeys("acme", "shop"),
    );
    expect(error.hint).toContain("Administration: Read");
  });

  it("removes a deploy key, and answers absent for one already gone", async () => {
    const { fetch, calls } = fakeFetch({
      [`DELETE ${KEYS}/42`]: { status: 204 },
      [`DELETE ${KEYS}/43`]: { status: 404, body: { message: "Not Found" } },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    expect(await client.removeDeployKey("acme", "shop", 42)).toBe("deleted");
    expect(await client.removeDeployKey("acme", "shop", 43)).toBe("absent");
    expect(calls[0]).toMatchObject({ method: "DELETE", path: `${KEYS}/42` });
  });

  it("names Administration when the token can't remove a key", async () => {
    const { fetch } = fakeFetch({
      [`DELETE ${KEYS}/42`]: { status: 403, body: { message: "Resource not accessible" } },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).removeDeployKey("acme", "shop", 42),
    );
    expect(error.hint).toContain("Administration: Read and write");
  });
});

describe("githubSshHostKeys", () => {
  const ED25519 =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
  const ECDSA = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=";

  it("answers known_hosts lines for github.com and [ssh.github.com]:443", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /meta": { body: { ssh_keys: [ED25519, ECDSA], hooks: [] } },
    });
    expect(await new GitHubClient({ token: TOKEN, fetch }).githubSshHostKeys()).toEqual([
      `github.com ${ED25519}`,
      `github.com ${ECDSA}`,
      `[ssh.github.com]:443 ${ED25519}`,
      `[ssh.github.com]:443 ${ECDSA}`,
    ]);
    expect(calls[0]?.path).toBe("/meta");
  });

  for (const [name, body] of [
    ["no keys", { ssh_keys: [] }],
    ["no ssh_keys", { hooks: [] }],
    ["a line that is not a key", { ssh_keys: [`${ED25519}\ngithub.com ssh-rsa AAAA`] }],
  ] as const) {
    it(`refuses an answer with ${name}`, async () => {
      const { fetch } = fakeFetch({ "GET /meta": { body } });
      const error = await failure(new GitHubClient({ token: TOKEN, fetch }).githubSshHostKeys());
      expect(error.code).toBe("PROVIDER_ERROR");
    });
  }

  it("says GitHub could not be reached", async () => {
    const { fetch } = fakeFetch({ "GET /meta": { error: new TypeError("fetch failed") } });
    const error = await failure(new GitHubClient({ token: TOKEN, fetch }).githubSshHostKeys());
    expect(error.message).toContain("Could not reach GitHub");
  });
});
