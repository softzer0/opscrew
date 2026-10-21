import { OpsCrewError, Redactor, sha256Hex } from "@opscrew/core";
import { fakeFetch as coreFakeFetch, type FakeReply, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { GITHUB_API } from "./github";
import { GitHubClient } from "./index";

const TOKEN = fakeSecret("github-token");
const PULL_TOKEN = fakeSecret("generic-password", "ghcr-pull");
const ME = { login: "octocat", id: 583231 };
const V2 = "GET https://ghcr.io/v2/acme/shop";
const TOKEN_ROUTE = "GET https://ghcr.io/token";
const INDEX_TYPE = "application/vnd.oci.image.index.v1+json";
const MANIFEST_TYPE = "application/vnd.oci.image.manifest.v1+json";
const SLSA_V1 = "https://slsa.dev/provenance/v1";
const BUILDER = "https://github.com/acme/shop/actions/runs/123456/attempts/1";

const fakeFetch = (routes: Record<string, FakeReply | FakeReply[]>) =>
  coreFakeFetch(routes, { base: GITHUB_API });

const digestOf = (text: string) => `sha256:${sha256Hex(text)}`;

/** An image as buildx pushes it with provenance: an index, an attestation manifest, the statement. */
function image(
  options: { builderId?: string; predicateType?: string; attestation?: boolean } = {},
) {
  const statement = JSON.stringify({
    _type: "https://in-toto.io/Statement/v0.1",
    predicateType: options.predicateType ?? SLSA_V1,
    subject: [{ name: "pkg:docker/ghcr.io/acme/shop", digest: { sha256: "a".repeat(64) } }],
    predicate: {
      buildDefinition: { buildType: "https://mobyproject.org/buildkit@v1" },
      runDetails: { builder: { id: options.builderId ?? BUILDER } },
    },
  });
  const sbom = JSON.stringify({ predicateType: "https://spdx.dev/Document" });
  const attestation = JSON.stringify({
    schemaVersion: 2,
    mediaType: MANIFEST_TYPE,
    config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digestOf("{}") },
    layers: [
      {
        mediaType: "application/vnd.in-toto+json",
        digest: digestOf(sbom),
        size: sbom.length,
        annotations: { "in-toto.io/predicate-type": "https://spdx.dev/Document" },
      },
      {
        mediaType: "application/vnd.in-toto+json",
        digest: digestOf(statement),
        size: statement.length,
        annotations: { "in-toto.io/predicate-type": options.predicateType ?? SLSA_V1 },
      },
    ],
  });
  const platform = digestOf("platform manifest");
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: INDEX_TYPE,
    manifests: [
      {
        mediaType: MANIFEST_TYPE,
        digest: platform,
        size: 1,
        platform: { architecture: "amd64", os: "linux" },
      },
      ...(options.attestation === false
        ? []
        : [
            {
              mediaType: MANIFEST_TYPE,
              digest: digestOf(attestation),
              size: attestation.length,
              annotations: {
                "vnd.docker.reference.digest": platform,
                "vnd.docker.reference.type": "attestation-manifest",
              },
              platform: { architecture: "unknown", os: "unknown" },
            },
          ]),
    ],
  });
  const digest = digestOf(index);
  const routes: Record<string, FakeReply> = {
    "GET /user": { body: ME },
    [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
    [`${V2}/manifests/${digest}`]: {
      text: index,
      headers: { "content-type": INDEX_TYPE, "docker-content-digest": digest },
    },
    [`${V2}/manifests/${digestOf(attestation)}`]: {
      text: attestation,
      headers: { "content-type": MANIFEST_TYPE },
    },
    [`${V2}/blobs/${digestOf(statement)}`]: {
      text: statement,
      headers: { "content-type": "application/vnd.in-toto+json" },
    },
  };
  return { digest, index, routes };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(OpsCrewError);
  const opsError = error as OpsCrewError;
  const text = `${opsError.message} ${opsError.hint ?? ""} ${JSON.stringify(error)}`;
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(PULL_TOKEN);
  return opsError;
}

describe("taggedDigest", () => {
  it("reads the tag's digest from GHCR with a pull token for the user's token", async () => {
    const { digest } = image();
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/opscrew-prod`]: {
        body: { schemaVersion: 2, manifests: [] },
        headers: { "docker-content-digest": digest },
      },
    });
    const redactor = new Redactor();
    const client = new GitHubClient({ token: TOKEN, fetch, redactor });
    expect(await client.taggedDigest("acme", "shop", "opscrew-prod")).toBe(digest);

    const tokenCall = calls.find((c) => c.url.startsWith("https://ghcr.io/token"));
    const query = new URL(tokenCall?.url ?? "").searchParams;
    expect(query.get("scope")).toBe("repository:acme/shop:pull");
    expect(query.get("service")).toBe("ghcr.io");
    expect(tokenCall?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`octocat:${TOKEN}`).toString("base64")}`,
    );
    const manifestCall = calls.at(-1);
    expect(manifestCall?.headers.Authorization).toBe(`Bearer ${PULL_TOKEN}`);
    expect(manifestCall?.headers.Accept).toContain(INDEX_TYPE);
    expect(manifestCall?.headers.Accept).toContain(
      "application/vnd.docker.distribution.manifest.list.v2+json",
    );
    // The registry's token is masked from the moment it arrives.
    expect(redactor.redact(`Bearer ${PULL_TOKEN}`)).not.toContain(PULL_TOKEN);
  });

  it("hashes the index when GHCR sends no digest header", async () => {
    const { index, digest } = image();
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/opscrew-prod`]: { text: index, headers: { "content-type": INDEX_TYPE } },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).taggedDigest("acme", "shop", "opscrew-prod"),
    ).toBe(digest);
  });

  it("is undefined for a tag GHCR does not have (404)", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/opscrew-staging`]: {
        status: 404,
        body: { errors: [{ code: "MANIFEST_UNKNOWN" }] },
      },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).taggedDigest(
        "acme",
        "shop",
        "opscrew-staging",
      ),
    ).toBeUndefined();
  });

  it("names the image in lower case, as GHCR requires", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/opscrew-prod`]: { status: 404 },
    });
    await new GitHubClient({ token: TOKEN, fetch }).taggedDigest("Acme", "Shop", "opscrew-prod");
    expect(calls.at(-1)?.url).toBe("https://ghcr.io/v2/acme/shop/manifests/opscrew-prod");
  });

  it("uses an explicit registry credential instead of the client's token", async () => {
    const readToken = fakeSecret("github-token", "ghcr-read");
    const { digest } = image();
    const { fetch, calls } = fakeFetch({
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/opscrew-prod`]: {
        body: { schemaVersion: 2, manifests: [] },
        headers: { "docker-content-digest": digest },
      },
    });
    const redactor = new Redactor();
    const client = new GitHubClient({ token: TOKEN, fetch, redactor });
    const credential = { username: "deployer", token: readToken };
    expect(await client.taggedDigest("acme", "shop", "opscrew-prod", credential)).toBe(digest);
    // No GitHub API call: the user name comes with the credential.
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["ghcr.io", "ghcr.io"]);
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`deployer:${readToken}`).toString("base64")}`,
    );
    expect(redactor.redact(readToken)).not.toContain(readToken);
  });

  it("reads provenance with an explicit registry credential", async () => {
    const readToken = fakeSecret("github-token", "ghcr-read");
    const { digest, routes } = image();
    const { "GET /user": _user, ...registry } = routes;
    const { fetch, calls } = fakeFetch(registry);
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest, {
        username: "deployer",
        token: readToken,
      }),
    ).toMatchObject({ runId: 123456 });
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it("explains a refused pull token without printing either token", async () => {
    for (const status of [401, 403]) {
      const { fetch } = fakeFetch({
        "GET /user": { body: ME },
        [TOKEN_ROUTE]: { status, body: { errors: [{ code: "DENIED" }] } },
      });
      const error = await failure(
        new GitHubClient({ token: TOKEN, fetch }).taggedDigest("acme", "shop", "opscrew-prod"),
      );
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.hint).toContain("read:packages");
      expect(error.hint).toContain("OPSCREW_GHCR_READ_TOKEN");
    }
  });

  it("explains a refused manifest read", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/opscrew-prod`]: { status: 403, body: { errors: [{ code: "DENIED" }] } },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).taggedDigest("acme", "shop", "opscrew-prod"),
    );
    expect(error.code).toBe("CREDENTIALS_INVALID");
  });

  it("refuses a tag that is not one before calling GHCR", async () => {
    const { fetch, calls } = fakeFetch({});
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).taggedDigest("acme", "shop", "../x"),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("imageProvenance", () => {
  it("reads the build run from the SLSA v1 provenance in the image's attestation", async () => {
    const { digest, routes } = image();
    const { fetch, calls } = fakeFetch(routes);
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    ).toEqual({ builderId: BUILDER, runId: 123456, repository: "acme/shop" });
    // Only the provenance layer is fetched, not the SBOM beside it.
    expect(calls.filter((c) => c.url.includes("/blobs/"))).toHaveLength(1);
  });

  it("gives only the builder when it is not a GitHub Actions run", async () => {
    const { digest, routes } = image({ builderId: "https://example.com/builder" });
    const { fetch } = fakeFetch(routes);
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    ).toEqual({ builderId: "https://example.com/builder" });
  });

  it("is undefined for an image without an attestation", async () => {
    const { digest, routes } = image({ attestation: false });
    const { fetch } = fakeFetch(routes);
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    ).toBeUndefined();
  });

  it("is undefined for provenance that is not SLSA v1", async () => {
    const { digest, routes } = image({ predicateType: "https://slsa.dev/provenance/v0.2" });
    const { fetch } = fakeFetch(routes);
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    ).toBeUndefined();
  });

  it("is undefined for a single manifest, which holds no attestation", async () => {
    const manifest = JSON.stringify({ schemaVersion: 2, mediaType: MANIFEST_TYPE, layers: [] });
    const digest = digestOf(manifest);
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/${digest}`]: { text: manifest, headers: { "content-type": MANIFEST_TYPE } },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    ).toBeUndefined();
  });

  it("is undefined for a digest GHCR does not have (404)", async () => {
    const digest = digestOf("gone");
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/${digest}`]: { status: 404 },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    ).toBeUndefined();
  });

  it("refuses content that does not match its digest", async () => {
    const { digest, routes } = image();
    const { fetch } = fakeFetch({
      ...routes,
      [`${V2}/manifests/${digest}`]: { text: "{}", headers: { "content-type": INDEX_TYPE } },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("does not match");
  });

  it("refuses a provenance blob that does not match its digest", async () => {
    const { digest, routes } = image();
    const blob = Object.keys(routes).find((key) => key.includes("/blobs/")) ?? "";
    const forged = JSON.stringify({
      predicateType: SLSA_V1,
      predicate: { runDetails: { builder: { id: "https://github.com/evil/fork/actions/runs/1" } } },
    });
    const { fetch } = fakeFetch({ ...routes, [blob]: { text: forged } });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", digest),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("does not match");
  });

  it("refuses a digest that is not one before calling GHCR", async () => {
    const { fetch, calls } = fakeFetch({});
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).imageProvenance("acme", "shop", "latest"),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("workflowRun", () => {
  it("reads the run's repository, branch, commit and workflow file", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/123456": {
        body: {
          id: 123456,
          head_branch: "main",
          head_sha: "b".repeat(40),
          path: ".github/workflows/opscrew-deploy.yml",
          repository: { id: 1, full_name: "acme/shop" },
        },
      },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).workflowRun("acme", "shop", 123456),
    ).toEqual({
      repository: "acme/shop",
      headBranch: "main",
      headSha: "b".repeat(40),
      path: ".github/workflows/opscrew-deploy.yml",
    });
    expect(calls[0]?.path).toBe("/repos/acme/shop/actions/runs/123456");
  });

  it("is undefined for a run GitHub does not have (404)", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/9": { status: 404, body: { message: "Not Found" } },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).workflowRun("acme", "shop", 9),
    ).toBeUndefined();
  });
});
