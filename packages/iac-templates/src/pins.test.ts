import { readFile } from "node:fs/promises";
import { AppBuildSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  assetSha256,
  buildpackTomlUrl,
  buildpackVersion,
  dependencyVersions,
  formatActionPin,
  OFFER_SOURCES,
  parseActionPin,
  parseBearerChallenge,
  parseImageRef,
  platformManifest,
  readBuilderConfig,
  registryOf,
  replaceOffers,
  replacePin,
  setToolChecksum,
  TOOL_RELEASES,
} from "../scripts/update-pins-lib";
import { ACTIONS, BUILDPACKS_OFFERS, detectStack, IMAGES, RUNTIME_DEFAULTS, TOOLS } from "./index";

const SOURCE = readFile(new URL("./pins.ts", import.meta.url), "utf8");
const FIXTURES = new URL("./__fixtures__/pins/", import.meta.url);
const HEX64 = /^[0-9a-f]{64}$/;

/** The line of pins.ts holding `literal`, as written there (JSON-quoted). */
async function lineOf(literal: string): Promise<string> {
  const quoted = JSON.stringify(literal);
  const lines = (await SOURCE).split("\n").filter((line) => line.includes(quoted));
  expect(lines, literal).toHaveLength(1);
  return lines[0] as string;
}

describe("pins.ts", () => {
  it("is exported from the package root, next to detectStack", () => {
    expect(typeof detectStack).toBe("function");
    for (const table of [IMAGES, TOOLS, ACTIONS, RUNTIME_DEFAULTS, BUILDPACKS_OFFERS]) {
      expect(Object.keys(table).length).toBeGreaterThan(0);
    }
  });

  it("pins every image as repo:tag@sha256, or marks it for the pin script", async () => {
    for (const [key, { ref }] of Object.entries(IMAGES)) {
      const image = parseImageRef(ref);
      if (image.digest === undefined) expect(await lineOf(ref), key).toContain("TODO(pins)");
      else expect(image.digest, key).toMatch(HEX64);
    }
    const tags = Object.fromEntries(
      Object.entries(IMAGES).map(([key, { ref }]) => [key, parseImageRef(ref).tag]),
    );
    expect(tags).toMatchObject({
      node: "24-slim",
      nodeAlpine: "24-alpine",
      kamalProxy: "v0.10.2",
      railpackFrontend: "v0.42.0",
      paketoBuilder: "0.0.203",
      paketoRun: "0.0.145",
    });
    expect(Object.keys(IMAGES).sort()).toEqual(
      [
        "caddy",
        "cloudflared",
        "curl",
        "kamalProxy",
        "node",
        "nodeAlpine",
        "paketoBuilder",
        "paketoRun",
        "postgres",
        "python",
        "railpackFrontend",
        "trivy",
        "valkey",
      ].sort(),
    );
  });

  it("pins pack and Railpack by version and a SHA-256 per architecture, cosign by version", async () => {
    expect(TOOLS.pack.version).toBe("0.40.9");
    expect(TOOLS.railpack.version).toBe("0.42.0");
    expect(TOOLS.cosign).not.toHaveProperty("sha256");
    for (const [tool, pin] of Object.entries(TOOLS)) {
      for (const [arch, value] of Object.entries("sha256" in pin ? pin.sha256 : {})) {
        expect(value, `${tool} ${arch}`).toMatch(HEX64);
      }
    }
    const lines = (await SOURCE).split("\n");
    expect(lines.filter((line) => /^\s+(amd64|arm64|version): ""/.test(line))).toEqual([]);
  });

  it("pins every action by commit with its tag in a comment, or marks it for the script", async () => {
    for (const [key, value] of Object.entries(ACTIONS)) {
      const action = parseActionPin(value);
      if (action.sha === undefined) {
        expect(await lineOf(value), key).toContain("TODO(pins)");
        continue;
      }
      expect(formatActionPin({ ...action, sha: action.sha })).toBe(value);
    }
    expect(parseActionPin(ACTIONS.checkout)).toEqual({
      action: "actions/checkout",
      repo: "actions/checkout",
      sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
      tag: "v7.0.1",
    });
    const actions = Object.values(ACTIONS).map((value) => parseActionPin(value).action);
    expect(actions.sort()).toEqual([
      "actions/checkout",
      "buildpacks/github-actions/setup-pack",
      "docker/build-push-action",
      "docker/login-action",
      "docker/setup-buildx-action",
      "sigstore/cosign-installer",
    ]);
  });

  it("defaults each language by FR-1228 rule 4, to a version a plan accepts", () => {
    expect(RUNTIME_DEFAULTS).toEqual({
      node: "24",
      python: "3.14",
      go: "1.26",
      php: "8.4",
      ruby: "3.4",
      rust: "1.98",
      dotnet: "10.0",
      java: "25",
    });
    const version = AppBuildSchema.shape.runtime.shape.version;
    for (const [language, value] of Object.entries(RUNTIME_DEFAULTS)) {
      expect(version.safeParse(value).success, language).toBe(true);
    }
  });

  it("offers each Buildpacks language's default from the pinned builder, matched by prefix", () => {
    expect(Object.keys(BUILDPACKS_OFFERS).sort()).toEqual(Object.keys(OFFER_SOURCES).sort());
    for (const [language, versions] of Object.entries(BUILDPACKS_OFFERS)) {
      const wanted = RUNTIME_DEFAULTS[language as keyof typeof BUILDPACKS_OFFERS];
      expect(versions.length, language).toBeGreaterThan(0);
      expect(
        versions.some((v) => v === wanted || v.startsWith(`${wanted}.`)),
        `${language} ${wanted}`,
      ).toBe(true);
    }
    expect(BUILDPACKS_OFFERS.ruby).not.toContain("4.0.7");
  });
});

describe("the pin script's offers helpers", () => {
  const NOBLE = "io.buildpacks.stacks.noble";

  it("picks one architecture's manifest from an image index", () => {
    const index = {
      manifests: [
        { digest: `sha256:${"1".repeat(64)}`, platform: { architecture: "amd64", os: "linux" } },
        { digest: `sha256:${"2".repeat(64)}`, platform: { architecture: "arm64", os: "linux" } },
      ],
    };
    expect(platformManifest(index, "arm64")).toBe(`sha256:${"2".repeat(64)}`);
    expect(() => platformManifest({ manifests: [] }, "amd64")).toThrow(/linux\/amd64/);
  });

  it("reads the builder's stack and buildpack versions from its metadata label", async () => {
    const config = JSON.parse(await readFile(new URL("builder-config.json", FIXTURES), "utf8"));
    const builder = readBuilderConfig(config);
    expect(builder.stack).toBe(NOBLE);
    expect(buildpackVersion(builder, "paketo-buildpacks/go-dist")).toBe("2.10.31");
    expect(buildpackVersion(builder, "paketo-buildpacks/mri")).toBe("2.0.8");
    expect(() => buildpackVersion(builder, "paketo-buildpacks/ca-certificates")).toThrow(
      /3\.14\.0, 3\.13\.0/,
    );
    expect(() => buildpackVersion(builder, "paketo-buildpacks/bellsoft-liberica")).toThrow(
      /does not list/,
    );
    expect(() => readBuilderConfig({ config: { Labels: {} } })).toThrow(/metadata/);
    expect(buildpackTomlUrl("paketo-buildpacks/mri", "2.0.8")).toBe(
      "https://raw.githubusercontent.com/paketo-buildpacks/mri/v2.0.8/buildpack.toml",
    );
  });

  it("lists a dependency's versions for the builder's stack, oldest first", async () => {
    const toml = await readFile(new URL("mri-buildpack.toml", FIXTURES), "utf8");
    expect(dependencyVersions(toml, "ruby", NOBLE)).toEqual(["3.4.9", "3.4.10", "4.0.6"]);
    expect(dependencyVersions(toml, "ruby", "io.buildpacks.stacks.jammy")).toEqual(["3.3.11"]);
    expect(dependencyVersions(toml, "bundler", NOBLE)).toEqual(["2.6.9"]);
    expect(() => dependencyVersions(toml, "go", NOBLE)).toThrow(/no go/);
  });

  it("rewrites only the BUILDPACKS_OFFERS table", async () => {
    const source = await SOURCE;
    const offers = { go: ["1.26.8"], java: ["21.0.12", "25.0.4"], dotnet: ["10.0.401"], ruby: [] };
    const next = replaceOffers(source, offers);
    const at = source.indexOf("export const BUILDPACKS_OFFERS");
    expect(next.slice(0, at)).toBe(source.slice(0, at));
    expect(next.slice(at)).toContain('java: ["21.0.12", "25.0.4"],');
    expect(next.slice(at)).toContain("ruby: [],");
    expect(replaceOffers(next, BUILDPACKS_OFFERS)).toBe(replaceOffers(source, BUILDPACKS_OFFERS));
  });
});

describe("the pin script's helpers", () => {
  it("splits image references into registry, repository, tag and digest", () => {
    const digest = "a".repeat(64);
    expect(parseImageRef("node:24-slim")).toEqual({ repo: "node", tag: "24-slim" });
    expect(parseImageRef(`basecamp/kamal-proxy:v0.10.2@sha256:${digest}`)).toEqual({
      repo: "basecamp/kamal-proxy",
      tag: "v0.10.2",
      digest,
    });
    expect(parseImageRef("ghcr.io/railwayapp/railpack-frontend:v0.42.0")).toEqual({
      repo: "ghcr.io/railwayapp/railpack-frontend",
      tag: "v0.42.0",
    });
    for (const bad of ["node", "node@sha256:abc", "node:24@sha256:xyz", "Node:24"]) {
      expect(() => parseImageRef(bad), bad).toThrow(/image reference/);
    }
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

  it("reads an action pinned by tag only, for the script to resolve", () => {
    expect(parseActionPin("docker/build-push-action@v7")).toEqual({
      action: "docker/build-push-action",
      repo: "docker/build-push-action",
      tag: "v7",
    });
    // An action in a subfolder: its commit comes from the repository's tag.
    const sha = "f".repeat(40);
    const setupPack = parseActionPin(`buildpacks/github-actions/setup-pack@${sha} # v5.9.0`);
    expect(setupPack).toEqual({
      action: "buildpacks/github-actions/setup-pack",
      repo: "buildpacks/github-actions",
      tag: "v5.9.0",
      sha,
    });
    expect(formatActionPin(setupPack as Required<typeof setupPack>)).toBe(
      `buildpacks/github-actions/setup-pack@${sha} # v5.9.0`,
    );
    expect(() => parseActionPin("checkout@v7")).toThrow(/action/);
  });

  it("names the release assets of each tool, and reads their SHA-256", () => {
    const railpack = TOOL_RELEASES.railpack;
    expect(railpack.repo).toBe("railwayapp/railpack");
    expect(railpack.tag("0.42.0")).toBe("v0.42.0");
    expect(railpack.asset.amd64("0.42.0")).toBe(
      "railpack-v0.42.0-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(TOOL_RELEASES.pack.asset.arm64("0.40.9")).toBe("pack-v0.40.9-linux-arm64.tgz");
    expect(Object.keys(TOOL_RELEASES).sort()).toEqual(["pack", "railpack"]);

    const sha = "b".repeat(64);
    const release = {
      assets: [
        { name: "checksums.txt", digest: `sha256:${"c".repeat(64)}` },
        { name: "pack-v0.40.9-linux.tgz", digest: `sha256:${sha}` },
      ],
    };
    expect(assetSha256(release, "pack-v0.40.9-linux.tgz")).toBe(sha);
    expect(() => assetSha256(release, "pack-v0.40.9-macos.tgz")).toThrow(
      /checksums\.txt, pack-v0\.40\.9-linux\.tgz/,
    );
    const noDigest = { assets: [{ name: "pack-v0.40.9-linux.tgz", digest: null }] };
    expect(() => assetSha256(noDigest, "pack-v0.40.9-linux.tgz")).toThrow(/SHA-256/);
  });

  it("replaces one pinned value and drops its TODO marker", async () => {
    const source = await SOURCE;
    const { ref } = IMAGES.nodeAlpine;
    const filled = `${parseImageRef(ref).repo}:${parseImageRef(ref).tag}@sha256:${"d".repeat(64)}`;
    const before = source.split("\n");
    const changed = replacePin(source, ref, filled)
      .split("\n")
      .filter((line, i) => line !== before[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain(JSON.stringify(filled));
    expect(changed[0]).not.toContain("TODO(pins)");
    expect(replacePin(source, IMAGES.trivy.ref, IMAGES.trivy.ref)).toBe(source);
    expect(() => replacePin(source, "node:99", "node:100")).toThrow(/once/);
    expect(() => replacePin('a: "x",\nb: "x",\n', "x", "y")).toThrow(/once/);
  });

  it("sets one tool checksum in the TOOLS table and leaves the rest alone", async () => {
    const source = await SOURCE;
    const sha = "e".repeat(64);
    const next = setToolChecksum(source, "railpack", "arm64", sha);
    const railpackBlock = next.slice(next.indexOf("  railpack: {"));
    expect(railpackBlock).toMatch(new RegExp(`arm64: "${sha}",\\n`));
    expect(railpackBlock).toContain(`amd64: "${TOOLS.railpack.sha256.amd64}"`);
    expect(next.split("\n").length).toBe(source.split("\n").length);
    const packFirst = setToolChecksum(source, "pack", "amd64", sha);
    expect(packFirst.slice(0, packFirst.indexOf("  railpack: {"))).toContain(`amd64: "${sha}",`);
    expect(() => setToolChecksum(source, "cosign", "amd64", sha)).toThrow(/cosign/);
  });
});
