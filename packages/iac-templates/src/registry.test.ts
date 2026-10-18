import type { FetchLike } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { imageDigest, MANIFEST_ACCEPT, parseBearerChallenge, registryOf } from "./registry";

const DIGEST = `sha256:${"ab".repeat(32)}`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** A registry that answers in order with `answers`, recording each request. */
function fakeRegistry(answers: Response[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
    });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`Unexpected request: ${String(input)}`);
    return answer;
  };
  return { fetch, calls };
}

const withDigest = () => new Response(null, { headers: { "docker-content-digest": DIGEST } });

describe("registryOf", () => {
  it("applies Docker Hub's defaults and reads other registries' hosts", () => {
    expect(registryOf("node")).toEqual({ host: "registry-1.docker.io", name: "library/node" });
    expect(registryOf("valkey/valkey")).toEqual({
      host: "registry-1.docker.io",
      name: "valkey/valkey",
    });
    expect(registryOf("ghcr.io/railwayapp/railpack-frontend")).toEqual({
      host: "ghcr.io",
      name: "railwayapp/railpack-frontend",
    });
  });
});

describe("parseBearerChallenge", () => {
  it("reads a registry's bearer challenge", () => {
    expect(
      parseBearerChallenge(
        'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/node:pull"',
      ),
    ).toEqual({
      realm: "https://auth.docker.io/token",
      service: "registry.docker.io",
      scope: "repository:library/node:pull",
    });
    expect(parseBearerChallenge('Bearer realm="https://ghcr.io/token"')).toEqual({
      realm: "https://ghcr.io/token",
    });
    expect(() => parseBearerChallenge('Basic realm="x"')).toThrow(/bearer/i);
  });
});

describe("imageDigest", () => {
  it("asks for the index with a HEAD and returns its digest", async () => {
    const registry = fakeRegistry([withDigest()]);
    expect(await imageDigest(registry.fetch, "ghcr.io/acme/tool", "v1")).toBe(DIGEST);
    expect(registry.calls).toEqual([
      {
        url: "https://ghcr.io/v2/acme/tool/manifests/v1",
        method: "HEAD",
        headers: { Accept: MANIFEST_ACCEPT },
      },
    ]);
    expect(MANIFEST_ACCEPT).toContain("application/vnd.oci.image.index.v1+json");
  });

  it("answers a bearer challenge with an anonymous pull token", async () => {
    const token = "anonymous-pull-token";
    const registry = fakeRegistry([
      new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"',
        },
      }),
      Response.json({ token }),
      withDigest(),
    ]);
    expect(await imageDigest(registry.fetch, "node", "20-alpine")).toBe(DIGEST);
    expect(registry.calls.map((call) => call.url)).toEqual([
      "https://registry-1.docker.io/v2/library/node/manifests/20-alpine",
      "https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnode%3Apull",
      "https://registry-1.docker.io/v2/library/node/manifests/20-alpine",
    ]);
    expect(registry.calls[2]?.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("fails plainly when the registry refuses or sends no digest", async () => {
    await expect(
      imageDigest(fakeRegistry([new Response(null, { status: 404 })]).fetch, "node", "1"),
    ).rejects.toThrow("registry-1.docker.io answered 404 for node manifests/1.");
    await expect(
      imageDigest(fakeRegistry([new Response(null)]).fetch, "node", "1"),
    ).rejects.toThrow("The registry sent no digest for node:1.");
    const refused = fakeRegistry([
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="https://a.example/t"' },
      }),
      new Response(null, { status: 403 }),
    ]);
    await expect(imageDigest(refused.fetch, "node", "1")).rejects.toThrow(
      "refused a pull token for node (403)",
    );
  });
});
