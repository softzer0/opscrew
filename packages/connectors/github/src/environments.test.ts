import { OpsCrewError } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import sodium from "libsodium-wrappers";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const ENV = "/repos/acme/shop/environments/staging";
const PROBE = "/repos/acme/shop/environments/opscrew-probe";
const ME = { login: "octocat", id: 583231 };
const NOT_FOUND: FakeReply = { status: 404, body: { message: "Not Found" } };
/** GitHub's 403 for a fine-grained token without the permission, as the spike saw it. */
const NO_ADMIN: FakeReply = {
  status: 403,
  body: { message: "Resource not accessible by personal access token" },
  headers: { "x-accepted-github-permissions": "administration=write" },
};

const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

const client = (fetch: ReturnType<typeof fakeFetch>["fetch"]) =>
  new GitHubClient({ token: TOKEN, fetch });

/** An environment as GitHub answers it, with no rules (what a Free private repository shows). */
function environment(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    name,
    url: `https://api.github.com/repos/acme/shop/environments/${name}`,
    protection_rules: [],
    deployment_branch_policy: null,
    ...extra,
  };
}

/** The same environment with the rules the capability probe asks for, enforced. */
function enforced(name: string) {
  return environment(name, {
    protection_rules: [
      {
        id: 3,
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [{ type: "User", reviewer: { login: ME.login, id: ME.id } }],
      },
      { id: 4, type: "branch_policy" },
    ],
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  });
}

/** A probe that existed before the check, with rules of its own and admin bypass off. */
const EXISTING = environment("opscrew-probe", {
  protection_rules: [{ id: 2, type: "wait_timer", wait_timer: 5 }],
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  can_admins_bypass: false,
});
/** The PUT that gives {@link EXISTING} back its rules. */
const EXISTING_BODY = {
  wait_timer: 5,
  prevent_self_review: false,
  reviewers: [],
  deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  can_admins_bypass: false,
};

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  const opsError = error as OpsCrewError;
  expect(`${opsError.message} ${opsError.hint ?? ""} ${JSON.stringify(error)}`).not.toContain(
    TOKEN,
  );
  return opsError;
}

describe("putEnvironment, getEnvironment and deleteEnvironment", () => {
  it("sends the rules in GitHub's shape and reads back what GitHub shows", async () => {
    const { fetch, calls } = fakeFetch({
      [`PUT ${ENV}`]: { body: { ...enforced("staging"), can_admins_bypass: false } },
    });
    const view = await client(fetch).putEnvironment("acme", "shop", "staging", {
      waitTimer: 0,
      preventSelfReview: false,
      reviewers: [{ type: "User", id: ME.id }],
      branchPolicy: { protectedBranches: false, customBranchPolicies: true },
      canAdminsBypass: false,
    });
    expect(calls[0]?.body).toEqual({
      wait_timer: 0,
      prevent_self_review: false,
      reviewers: [{ type: "User", id: ME.id }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      can_admins_bypass: false,
    });
    expect(view).toEqual({
      name: "staging",
      waitTimer: 0,
      preventSelfReview: false,
      reviewers: [{ type: "User", id: ME.id }],
      branchPolicy: { protectedBranches: false, customBranchPolicies: true },
      canAdminsBypass: false,
    });
  });

  it("sends only the rules it was given, and null for every branch", async () => {
    const { fetch, calls } = fakeFetch({ [`PUT ${ENV}`]: { body: environment("staging") } });
    await client(fetch).putEnvironment("acme", "shop", "staging", { branchPolicy: null });
    expect(calls[0]?.body).toEqual({ deployment_branch_policy: null });
  });

  it("reads a Free private repository's environment, which comes back without rules", async () => {
    const { fetch } = fakeFetch({ [`GET ${ENV}`]: { body: environment("staging") } });
    expect(await client(fetch).getEnvironment("acme", "shop", "staging")).toEqual({
      name: "staging",
      waitTimer: 0,
      preventSelfReview: false,
      reviewers: [],
      branchPolicy: null,
      canAdminsBypass: true,
    });
  });

  it("reads a wait timer", async () => {
    const { fetch } = fakeFetch({
      [`GET ${ENV}`]: {
        body: environment("staging", {
          protection_rules: [{ id: 2, type: "wait_timer", wait_timer: 30 }],
        }),
      },
    });
    expect(await client(fetch).getEnvironment("acme", "shop", "staging")).toMatchObject({
      waitTimer: 30,
    });
  });

  it("is undefined for a missing environment (404)", async () => {
    const { fetch } = fakeFetch({ [`GET ${ENV}`]: NOT_FOUND });
    expect(await client(fetch).getEnvironment("acme", "shop", "staging")).toBeUndefined();
  });

  it("encodes the environment's name in the path", async () => {
    const { fetch, calls } = fakeFetch({ "GET /repos/acme/shop/environments/": NOT_FOUND });
    await client(fetch).getEnvironment("acme", "shop", "a b/c");
    expect(calls[0]?.path).toBe("/repos/acme/shop/environments/a%20b%2Fc");
  });

  it("deletes an environment, and a missing one (404) counts as deleted", async () => {
    for (const reply of [{ status: 204 }, NOT_FOUND]) {
      const { fetch, calls } = fakeFetch({ [`DELETE ${ENV}`]: reply });
      await expect(
        client(fetch).deleteEnvironment("acme", "shop", "staging"),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    }
  });

  it("names Administration on a 403, from GitHub's header, without the token", async () => {
    for (const call of [
      (c: GitHubClient) => c.putEnvironment("acme", "shop", "staging", {}),
      (c: GitHubClient) => c.getEnvironment("acme", "shop", "staging"),
      (c: GitHubClient) => c.deleteEnvironment("acme", "shop", "staging"),
    ]) {
      const { fetch } = fakeFetch({ [ENV]: NO_ADMIN });
      const error = await failure(call(client(fetch)));
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain("Administration: Read and write");
    }
  });

  it("names Administration on a 403 even when GitHub sends no header", async () => {
    const { fetch } = fakeFetch({
      [ENV]: { status: 403, body: { message: "Resource not accessible by integration" } },
    });
    const error = await failure(client(fetch).putEnvironment("acme", "shop", "staging", {}));
    expect(error.hint).toContain("Administration: Read and write");
  });

  it("refuses an answer that is not an environment", async () => {
    const { fetch } = fakeFetch({ [`GET ${ENV}`]: { body: { id: 1 } } });
    const error = await failure(client(fetch).getEnvironment("acme", "shop", "staging"));
    expect(error.code).toBe("PROVIDER_ERROR");
  });
});

describe("environmentCapability", () => {
  it("reports a Free private repository's environment without rules, and deletes the probe", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [NOT_FOUND, { body: environment("opscrew-probe") }],
      [`PUT ${PROBE}`]: { body: environment("opscrew-probe") },
      [`DELETE ${PROBE}`]: { status: 204 },
    });
    expect(await client(fetch).environmentCapability("acme", "shop", "opscrew-probe")).toEqual({
      environments: true,
      branchPolicies: false,
      reviewers: false,
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${PROBE}`,
      "GET /user",
      `PUT ${PROBE}`,
      `GET ${PROBE}`,
      `DELETE ${PROBE}`,
    ]);
    // It asks for the rules it checks: the user as reviewer and a custom branch policy.
    expect(calls[2]?.body).toEqual({
      prevent_self_review: false,
      reviewers: [{ type: "User", id: ME.id }],
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
  });

  it("reports the rules GitHub enforced on read-back", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [NOT_FOUND, { body: enforced("opscrew-probe") }],
      [`PUT ${PROBE}`]: { body: enforced("opscrew-probe") },
      [`DELETE ${PROBE}`]: { status: 204 },
    });
    expect(await client(fetch).environmentCapability("acme", "shop", "opscrew-probe")).toEqual({
      environments: true,
      branchPolicies: true,
      reviewers: true,
    });
  });

  it("trusts the read-back, not the PUT's answer", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [NOT_FOUND, { body: environment("opscrew-probe") }],
      [`PUT ${PROBE}`]: { body: enforced("opscrew-probe") },
      [`DELETE ${PROBE}`]: { status: 204 },
    });
    expect(await client(fetch).environmentCapability("acme", "shop", "opscrew-probe")).toEqual({
      environments: true,
      branchPolicies: false,
      reviewers: false,
    });
  });

  it("falls back to a plain environment when GitHub refuses the rules (422)", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [NOT_FOUND, { body: environment("opscrew-probe") }],
      [`PUT ${PROBE}`]: [
        { status: 422, body: { message: "Validation Failed" } },
        { body: environment("opscrew-probe") },
      ],
      [`DELETE ${PROBE}`]: { status: 204 },
    });
    expect(await client(fetch).environmentCapability("acme", "shop", "opscrew-probe")).toEqual({
      environments: true,
      branchPolicies: false,
      reviewers: false,
    });
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      expect.objectContaining({ prevent_self_review: false }),
      {},
    ]);
  });

  it("reports no environments when GitHub refuses them without naming a permission", async () => {
    const refused: FakeReply = {
      status: 403,
      body: { message: "Environments are not available for this repository" },
    };
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: NOT_FOUND,
      [`PUT ${PROBE}`]: refused,
    });
    expect(await client(fetch).environmentCapability("acme", "shop", "opscrew-probe")).toEqual({
      environments: false,
      branchPolicies: false,
      reviewers: false,
    });
    // Nothing was created, so nothing is deleted.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("stops on a 403 that names the missing permission, without the token", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: NOT_FOUND,
      [`PUT ${PROBE}`]: NO_ADMIN,
    });
    const error = await failure(
      client(fetch).environmentCapability("acme", "shop", "opscrew-probe"),
    );
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Administration: Read and write");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("puts back the rules of a probe that already existed instead of deleting it", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [{ body: EXISTING }, { body: enforced("opscrew-probe") }],
      [`PUT ${PROBE}`]: [{ body: enforced("opscrew-probe") }, { body: EXISTING }],
    });
    expect(await client(fetch).environmentCapability("acme", "shop", "opscrew-probe")).toEqual({
      environments: true,
      branchPolicies: true,
      reviewers: true,
    });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: EXISTING_BODY });
  });

  it("puts an existing probe back even when the read-back fails", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [{ body: EXISTING }, { status: 500, body: { message: "boom" } }],
      [`PUT ${PROBE}`]: [{ body: enforced("opscrew-probe") }, { body: EXISTING }],
    });
    const error = await failure(
      client(fetch).environmentCapability("acme", "shop", "opscrew-probe"),
    );
    expect(error.message).toContain("boom");
    expect(calls.at(-1)).toMatchObject({ method: "PUT", body: EXISTING_BODY });
  });

  it("still deletes the probe when the read-back fails", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [NOT_FOUND, { status: 500, body: { message: "boom" } }],
      [`PUT ${PROBE}`]: { body: environment("opscrew-probe") },
      [`DELETE ${PROBE}`]: { status: 204 },
    });
    await failure(client(fetch).environmentCapability("acme", "shop", "opscrew-probe"));
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("deletes a new probe when the PUT itself fails, and a 404 on the delete is fine", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: NOT_FOUND,
      [`PUT ${PROBE}`]: { status: 500, body: { message: "boom" } },
      [`DELETE ${PROBE}`]: NOT_FOUND,
    });
    const error = await failure(
      client(fetch).environmentCapability("acme", "shop", "opscrew-probe"),
    );
    expect(error.message).toContain("boom");
    expect(calls.at(-1)?.method).toBe("DELETE");
  });

  it("says what to delete when the new probe cannot be deleted", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [NOT_FOUND, { body: environment("opscrew-probe") }],
      [`PUT ${PROBE}`]: { body: environment("opscrew-probe") },
      [`DELETE ${PROBE}`]: { status: 500, body: { message: "boom" } },
    });
    const error = await failure(
      client(fetch).environmentCapability("acme", "shop", "opscrew-probe"),
    );
    expect(error.message).toContain("could not delete it again");
    expect(error.hint).toBe("Delete opscrew-probe in Settings → Environments of acme/shop.");
  });

  it("says which rules to put back when the existing probe cannot be restored", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: [{ body: EXISTING }, { body: enforced("opscrew-probe") }],
      [`PUT ${PROBE}`]: [
        { body: enforced("opscrew-probe") },
        { status: 500, body: { message: "boom" } },
      ],
    });
    const error = await failure(
      client(fetch).environmentCapability("acme", "shop", "opscrew-probe"),
    );
    expect(error.message).toContain("could not put them back");
    expect(error.hint).toBe(
      "In Settings → Environments of acme/shop, give opscrew-probe back its rules: required reviewers: none; prevent self-review: off; wait timer: 5 minutes; deployment branches: protected branches; allow administrators to bypass: off.",
    );
  });

  it("stops on a 403 saying admin rights are needed (an OAuth token), naming Administration", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [`GET ${PROBE}`]: NOT_FOUND,
      [`PUT ${PROBE}`]: {
        status: 403,
        body: { message: "Must have admin rights to Repository." },
      },
    });
    const error = await failure(
      client(fetch).environmentCapability("acme", "shop", "opscrew-probe"),
    );
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Administration: Read and write");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("environment secrets", () => {
  const SECRETS = `${ENV}/secrets`;

  async function keyPair() {
    await sodium.ready;
    const pair = sodium.crypto_box_keypair();
    return {
      pair,
      key: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
    };
  }

  it("reads the environment's public key", async () => {
    const { key } = await keyPair();
    const { fetch, calls } = fakeFetch({
      [`GET ${SECRETS}/public-key`]: { body: { key_id: "k9", key } },
    });
    expect(await client(fetch).environmentPublicKey("acme", "shop", "staging")).toEqual({
      keyId: "k9",
      key,
    });
    expect(calls[0]?.path).toBe(`${SECRETS}/public-key`);
  });

  it("seals the value locally with the environment's key", async () => {
    const { pair, key } = await keyPair();
    const value = fakeSecret("generic-password", "env-secret");
    const { fetch, calls } = fakeFetch({
      [`GET ${SECRETS}/public-key`]: { body: { key_id: "k9", key } },
      [`PUT ${SECRETS}/OPSCREW_SSH_KEY`]: { status: 201 },
    });
    await client(fetch).setEnvironmentSecret("acme", "shop", "staging", "OPSCREW_SSH_KEY", value);
    expect(JSON.stringify(calls)).not.toContain(value);
    const body = calls.find((c) => c.method === "PUT")?.body as {
      encrypted_value: string;
      key_id: string;
    };
    expect(body.key_id).toBe("k9");
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey,
    );
    expect(sodium.to_string(opened)).toBe(value);
  });

  it("uses a key it is given without reading it again", async () => {
    const { key } = await keyPair();
    const { fetch, calls } = fakeFetch({ [`PUT ${SECRETS}/OPSCREW_HOST`]: { status: 204 } });
    await client(fetch).setEnvironmentSecret("acme", "shop", "staging", "OPSCREW_HOST", "x", {
      keyId: "k9",
      key,
    });
    expect(calls.map((c) => c.method)).toEqual(["PUT"]);
  });

  it("rejects an invalid secret name before calling GitHub", async () => {
    const { fetch, calls } = fakeFetch({});
    await expect(
      client(fetch).setEnvironmentSecret("acme", "shop", "staging", "bad-name", "x"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      client(fetch).deleteEnvironmentSecret("acme", "shop", "staging", "bad-name"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });

  it("deletes a secret, and a missing one (404) counts as deleted", async () => {
    for (const reply of [{ status: 204 }, NOT_FOUND]) {
      const { fetch, calls } = fakeFetch({ [`DELETE ${SECRETS}/OPSCREW_HOST`]: reply });
      await expect(
        client(fetch).deleteEnvironmentSecret("acme", "shop", "staging", "OPSCREW_HOST"),
      ).resolves.toBeUndefined();
      expect(calls).toHaveLength(1);
    }
  });

  it("names Environments on a 403, from GitHub's header or without it", async () => {
    for (const headers of [{ "x-accepted-github-permissions": "environments=write" }, undefined]) {
      const { fetch } = fakeFetch({
        [SECRETS]: {
          status: 403,
          body: { message: "Resource not accessible by personal access token" },
          ...(headers ? { headers } : {}),
        },
      });
      const error = await failure(client(fetch).environmentPublicKey("acme", "shop", "staging"));
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain("Environments: Read and write");
    }
  });
});
