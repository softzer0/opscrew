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
  options: {
    builderId?: string;
    predicateType?: string;
    attestation?: boolean;
    /** The platform of each image manifest in the index (default: linux/amd64). */
    platforms?: { architecture: string; os: string; variant?: string }[];
  } = {},
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
  const platform = digestOf("platform manifest amd64");
  const index = JSON.stringify({
    schemaVersion: 2,
    mediaType: INDEX_TYPE,
    manifests: [
      ...(options.platforms ?? [{ architecture: "amd64", os: "linux" }]).map((entry) => ({
        mediaType: MANIFEST_TYPE,
        digest: digestOf(`platform manifest ${entry.architecture}`),
        size: 1,
        platform: entry,
      })),
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

describe("imageFacts", () => {
  const facts = (fetch: ReturnType<typeof fakeFetch>["fetch"], digest: string) =>
    new GitHubClient({ token: TOKEN, fetch }).imageFacts("acme", "shop", digest);

  it("reads the build run and the platforms with one pull token and one read of the index", async () => {
    const { digest, routes } = image({
      platforms: [
        { architecture: "amd64", os: "linux" },
        { architecture: "arm64", os: "linux", variant: "v8" },
      ],
    });
    const { fetch, calls } = fakeFetch(routes);
    expect(await facts(fetch, digest)).toEqual({
      provenance: { builderId: BUILDER, runId: 123456, repository: "acme/shop" },
      // The attestation manifest is no platform of the image.
      platforms: [
        { architecture: "amd64", os: "linux" },
        { architecture: "arm64", os: "linux", variant: "v8" },
      ],
    });
    expect(calls.filter((c) => c.url.startsWith("https://ghcr.io/token"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith(`/manifests/${digest}`))).toHaveLength(1);
    // Only the provenance layer is fetched, not the SBOM beside it.
    expect(calls.filter((c) => c.url.includes("/blobs/"))).toHaveLength(1);
  });

  it("reads with an explicit registry credential", async () => {
    const readToken = fakeSecret("github-token", "ghcr-read");
    const { digest, routes } = image();
    const { "GET /user": _user, ...registry } = routes;
    const { fetch, calls } = fakeFetch(registry);
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageFacts("acme", "shop", digest, {
        username: "deployer",
        token: readToken,
      }),
    ).toMatchObject({ provenance: { runId: 123456 } });
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it("gives only the builder when it is not a GitHub Actions run", async () => {
    const { digest, routes } = image({ builderId: "https://example.com/builder" });
    const { fetch } = fakeFetch(routes);
    expect((await facts(fetch, digest))?.provenance).toEqual({
      builderId: "https://example.com/builder",
    });
  });

  it("has no provenance for an image without an attestation, and still its platforms", async () => {
    const { digest, routes } = image({ attestation: false });
    const { fetch } = fakeFetch(routes);
    expect(await facts(fetch, digest)).toEqual({
      provenance: undefined,
      platforms: [{ architecture: "amd64", os: "linux" }],
    });
  });

  it("has no provenance for provenance that is not SLSA v1", async () => {
    const { digest, routes } = image({ predicateType: "https://slsa.dev/provenance/v0.2" });
    const { fetch } = fakeFetch(routes);
    expect((await facts(fetch, digest))?.provenance).toBeUndefined();
  });

  it("reads a single manifest's platform from its config, and no provenance", async () => {
    const config = JSON.stringify({
      architecture: "arm64",
      os: "linux",
      rootfs: { type: "layers", diff_ids: [] },
    });
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST_TYPE,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digestOf(config) },
      layers: [],
    });
    const digest = digestOf(manifest);
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/${digest}`]: { text: manifest, headers: { "content-type": MANIFEST_TYPE } },
      [`${V2}/blobs/${digestOf(config)}`]: { text: config },
    });
    expect(await facts(fetch, digest)).toEqual({
      provenance: undefined,
      platforms: [{ architecture: "arm64", os: "linux" }],
    });
  });

  it("reads each platform of a Docker manifest list", async () => {
    const LIST_TYPE = "application/vnd.docker.distribution.manifest.list.v2+json";
    const list = JSON.stringify({
      schemaVersion: 2,
      mediaType: LIST_TYPE,
      manifests: [
        {
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          digest: digestOf("amd64"),
          size: 1,
          platform: { architecture: "amd64", os: "linux" },
        },
        {
          mediaType: "application/vnd.docker.distribution.manifest.v2+json",
          digest: digestOf("arm"),
          size: 1,
          platform: { architecture: "arm", os: "linux", variant: "v7" },
        },
      ],
    });
    const digest = digestOf(list);
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/${digest}`]: { text: list, headers: { "content-type": LIST_TYPE } },
    });
    expect(await facts(fetch, digest)).toEqual({
      provenance: undefined,
      platforms: [
        { architecture: "amd64", os: "linux" },
        { architecture: "arm", os: "linux", variant: "v7" },
      ],
    });
  });

  it("refuses a single manifest's config that does not match its digest", async () => {
    const config = JSON.stringify({ architecture: "arm64", os: "linux" });
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST_TYPE,
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digestOf(config) },
      layers: [],
    });
    const digest = digestOf(manifest);
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/${digest}`]: { text: manifest, headers: { "content-type": MANIFEST_TYPE } },
      // Another config than the one the manifest names.
      [`${V2}/blobs/${digestOf(config)}`]: {
        text: JSON.stringify({ architecture: "amd64", os: "linux" }),
      },
    });
    const error = await failure(facts(fetch, digest));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain(`GHCR sent content for ${digestOf(config)}`);
  });

  it("is undefined for a digest GHCR does not have (404)", async () => {
    const digest = digestOf("gone");
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/${digest}`]: { status: 404 },
    });
    expect(await facts(fetch, digest)).toBeUndefined();
  });

  it("refuses an index that does not match its digest", async () => {
    const { digest, routes } = image();
    const { fetch } = fakeFetch({
      ...routes,
      [`${V2}/manifests/${digest}`]: { text: "{}", headers: { "content-type": INDEX_TYPE } },
    });
    const error = await failure(facts(fetch, digest));
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
    const error = await failure(facts(fetch, digest));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("does not match");
  });

  it("refuses a digest that is not one before calling GHCR", async () => {
    const { fetch, calls } = fakeFetch({});
    const error = await failure(facts(fetch, "latest"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("imageTags", () => {
  const TAGS = `${V2}/tags/list`;
  const next = (last: string) => ({
    link: `</v2/acme/shop/tags/list?last=${last}&n=100>; rel="next"`,
  });

  it("lists every tag, following GHCR's relative Link pages, with one pull token", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${TAGS}?n=`]: { body: { name: "acme/shop", tags: ["a1", "b2"] }, headers: next("b2") },
      [`${TAGS}?last=b2`]: { body: { name: "acme/shop", tags: ["c3"] }, headers: next("c3") },
      [`${TAGS}?last=c3`]: { body: { name: "acme/shop", tags: ["opscrew-prod"] } },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    expect(await client.imageTags("acme", "shop")).toEqual(["a1", "b2", "c3", "opscrew-prod"]);

    expect(calls.filter((c) => c.url.startsWith("https://ghcr.io/token"))).toHaveLength(1);
    const lists = calls.filter((c) => c.url.includes("/tags/list"));
    expect(lists.map((c) => c.url)).toEqual([
      "https://ghcr.io/v2/acme/shop/tags/list?n=100",
      "https://ghcr.io/v2/acme/shop/tags/list?last=b2&n=100",
      "https://ghcr.io/v2/acme/shop/tags/list?last=c3&n=100",
    ]);
    for (const call of lists) expect(call.headers.Authorization).toBe(`Bearer ${PULL_TOKEN}`);
  });

  it("stops when GHCR names the same next page again", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [TAGS]: { body: { name: "acme/shop", tags: ["a1"] }, headers: next("a1") },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).imageTags("acme", "shop"),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "GHCR kept sending more pages of the tags of ghcr.io/acme/shop; run the command again, and report it to OpsCrew if it keeps happening.",
    );
    expect(calls.filter((c) => c.url.includes("/tags/list"))).toHaveLength(2);
  });

  it("stops after 100 pages", async () => {
    const pages = Array.from({ length: 150 }, (_, i) => ({
      body: { name: "acme/shop", tags: [`t${i}`] },
      headers: next(`t${i}`),
    }));
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [TAGS]: pages,
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).imageTags("acme", "shop"),
    );
    expect(error.message).toContain("GHCR kept sending more pages");
    expect(calls.filter((c) => c.url.includes("/tags/list"))).toHaveLength(100);
  });

  it("refuses a next page that is not this image's tag list", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [TAGS]: {
        body: { name: "acme/shop", tags: ["a1"] },
        headers: { link: '</v2/acme/other/tags/list?last=a1&n=100>; rel="next"' },
      },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).imageTags("acme", "shop"),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(calls.filter((c) => c.url.includes("/tags/list"))).toHaveLength(1);
  });

  it("reads an empty package's null tag list as no tags", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [TAGS]: { body: { name: "acme/shop", tags: null } },
    });
    expect(await new GitHubClient({ token: TOKEN, fetch }).imageTags("acme", "shop")).toEqual([]);
  });

  it("is undefined for a package GHCR does not have (404)", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [TAGS]: { status: 404, body: { errors: [{ code: "NAME_UNKNOWN" }] } },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).imageTags("acme", "shop"),
    ).toBeUndefined();
  });

  it("names OPSCREW_GHCR_READ_TOKEN when GHCR refuses the list, without printing a token", async () => {
    for (const status of [401, 403]) {
      const { fetch } = fakeFetch({
        "GET /user": { body: ME },
        [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
        [TAGS]: {
          status,
          body: {
            errors: [
              { code: "DENIED", message: "The token provided does not match expected scopes." },
            ],
          },
        },
      });
      const error = await failure(
        new GitHubClient({ token: TOKEN, fetch }).imageTags("acme", "shop"),
      );
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.message).toContain("ghcr.io/acme/shop");
      expect(error.hint).toContain("OPSCREW_GHCR_READ_TOKEN");
      expect(error.hint).toContain("read:packages");
    }
  });

  it("registers the read token and the pull token with the redactor before any read", async () => {
    const readToken = fakeSecret("github-token", "ghcr-read");
    const redactor = new Redactor();
    const masked = (value: string) => !redactor.redact(value).includes(value);
    const seen: boolean[][] = [];
    const routes = fakeFetch({
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [TAGS]: { body: { name: "acme/shop", tags: ["a1"] } },
    });
    const fetch: typeof routes.fetch = async (input, init) => {
      seen.push([masked(readToken), masked(PULL_TOKEN)]);
      return routes.fetch(input, init);
    };
    const client = new GitHubClient({ token: TOKEN, fetch, redactor });
    expect(
      await client.imageTags("acme", "shop", { username: "deployer", token: readToken }),
    ).toEqual(["a1"]);
    // The read token before it is sent for a pull token; the pull token before the list.
    expect(seen).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it("refuses an image name that is not one before calling GHCR", async () => {
    const { fetch, calls } = fakeFetch({});
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).imageTags("acme", "../shop"),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });
});

describe("describeTags", () => {
  it("gives each tag's digest and facts with one pull token, and no digest for a missing tag", async () => {
    const { digest, index, routes } = image();
    const { fetch, calls } = fakeFetch({
      ...routes,
      [`${V2}/manifests/abc1234-staging`]: {
        text: index,
        headers: { "content-type": INDEX_TYPE, "docker-content-digest": digest },
      },
      [`${V2}/manifests/def5678-staging`]: {
        status: 404,
        body: { errors: [{ code: "MANIFEST_UNKNOWN" }] },
      },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    expect(
      await client.describeTags("acme", "shop", ["abc1234-staging", "def5678-staging"]),
    ).toEqual([
      {
        tag: "abc1234-staging",
        digest,
        facts: {
          provenance: { builderId: BUILDER, runId: 123456, repository: "acme/shop" },
          platforms: [{ architecture: "amd64", os: "linux" }],
        },
      },
      { tag: "def5678-staging" },
    ]);
    expect(calls.filter((c) => c.url.startsWith("https://ghcr.io/token"))).toHaveLength(1);
    // The index read by tag is not read again by digest.
    expect(calls.filter((c) => c.url.endsWith(`/manifests/${digest}`))).toHaveLength(0);
  });

  it("gives a digest without facts when GHCR no longer has its manifest", async () => {
    const digest = digestOf("gone");
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/abc1234-staging`]: {
        body: { schemaVersion: 2, manifests: [] },
        headers: { "docker-content-digest": digest },
      },
      [`${V2}/manifests/${digest}`]: { status: 404 },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).describeTags("acme", "shop", [
        "abc1234-staging",
      ]),
    ).toEqual([{ tag: "abc1234-staging", digest }]);
  });

  it("reads with an explicit registry credential, and masks it and the pull token", async () => {
    const readToken = fakeSecret("github-token", "ghcr-read");
    const { digest, index, routes } = image();
    const { "GET /user": _user, ...registry } = routes;
    const { fetch, calls } = fakeFetch({
      ...registry,
      [`${V2}/manifests/abc1234-staging`]: {
        text: index,
        headers: { "docker-content-digest": digest },
      },
    });
    const redactor = new Redactor();
    const client = new GitHubClient({ token: TOKEN, fetch, redactor });
    const described = await client.describeTags("acme", "shop", ["abc1234-staging"], {
      username: "deployer",
      token: readToken,
    });
    expect(described[0]?.digest).toBe(digest);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
    const text = redactor.redact(`${readToken} ${PULL_TOKEN}`);
    expect(text).not.toContain(readToken);
    expect(text).not.toContain(PULL_TOKEN);
  });

  it("refuses a tag that is not one before calling GHCR", async () => {
    const { fetch, calls } = fakeFetch({});
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).describeTags("acme", "shop", ["ok", "../x"]),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("explains a refused read without printing a token", async () => {
    const { fetch } = fakeFetch({
      "GET /user": { body: ME },
      [TOKEN_ROUTE]: { body: { token: PULL_TOKEN } },
      [`${V2}/manifests/abc1234-staging`]: { status: 403, body: { errors: [{ code: "DENIED" }] } },
    });
    const error = await failure(
      new GitHubClient({ token: TOKEN, fetch }).describeTags("acme", "shop", ["abc1234-staging"]),
    );
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("OPSCREW_GHCR_READ_TOKEN");
  });
});

describe("workflowRun", () => {
  const MESSAGE = "Fix checkout totals\n\nThe long description";
  const record = (extra: Record<string, unknown> = {}) => ({
    id: 123456,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    created_at: "2026-10-30T09:00:00Z",
    head_branch: "main",
    head_sha: "b".repeat(40),
    head_commit: { id: "b".repeat(40), message: MESSAGE, timestamp: "2026-10-30T08:59:00Z" },
    path: ".github/workflows/opscrew-deploy.yml",
    repository: { id: 1, full_name: "acme/shop" },
    head_repository: { id: 2, full_name: "mallory/shop" },
    ...extra,
  });

  it("reads the run's source, state, time and head commit", async () => {
    const { fetch, calls } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/123456": { body: record() },
    });
    expect(
      await new GitHubClient({ token: TOKEN, fetch }).workflowRun("acme", "shop", 123456),
    ).toEqual({
      repository: "acme/shop",
      headRepository: "mallory/shop",
      event: "pull_request",
      headBranch: "main",
      headSha: "b".repeat(40),
      path: ".github/workflows/opscrew-deploy.yml",
      createdAt: "2026-10-30T09:00:00Z",
      status: "completed",
      conclusion: "success",
      headCommit: { message: MESSAGE, timestamp: "2026-10-30T08:59:00Z" },
    });
    expect(calls[0]?.path).toBe("/repos/acme/shop/actions/runs/123456");
  });

  it("has no head commit when GitHub gives none, and a run in progress has no conclusion", async () => {
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/123456": {
        body: record({ head_commit: null, status: "in_progress", conclusion: null }),
      },
    });
    const run = await new GitHubClient({ token: TOKEN, fetch }).workflowRun("acme", "shop", 123456);
    expect(run).toMatchObject({ status: "in_progress", conclusion: null });
    expect(run).not.toHaveProperty("headCommit");
  });

  it("refuses a run record without its event or head repository, without its commit message", async () => {
    const { event: _event, head_repository: _head, ...partial } = record();
    const { fetch } = fakeFetch({
      "GET /repos/acme/shop/actions/runs/7": { body: partial },
    });
    const error = await new GitHubClient({ token: TOKEN, fetch })
      .workflowRun("acme", "shop", 7)
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "PROVIDER_ERROR" });
    expect(`${(error as OpsCrewError).message} ${(error as OpsCrewError).hint}`).not.toContain(
      "checkout totals",
    );
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
