import { readFile } from "node:fs/promises";
import { AppBuildSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  assetSha256,
  buildpackTomlUrl,
  buildpackVersion,
  checkedAssetSha256,
  dependencyVersions,
  formatActionPin,
  latestReleaseUrl,
  latestReleaseVersion,
  lynisPublished,
  OFFER_SOURCES,
  parseActionPin,
  parseImageRef,
  platformManifest,
  readBuilderConfig,
  releaseNotesSha1,
  replaceOffers,
  replacePin,
  setPackageVersion,
  setSopsChecksum,
  setToolChecksum,
  verifiedSha256,
} from "../scripts/update-pins-lib";
import {
  ACTIONS,
  BUILDPACKS_OFFERS,
  detectStack,
  IMAGES,
  LOCAL_TOOLS,
  LYNIS_DOWNLOADS_PAGE,
  PACKAGE_MANAGERS,
  PYPI_PACKAGES,
  RUNTIME_DEFAULTS,
  SOPS_RELEASE,
  TOOL_RELEASES,
  TOOLS,
  toolDownloadUrl,
} from "./index";

const SOURCE = readFile(new URL("./pins.ts", import.meta.url), "utf8");
const FIXTURES = new URL("./__fixtures__/pins/", import.meta.url);
const HEX64 = /^[0-9a-f]{64}$/;

describe("pins.ts", () => {
  it("is exported from the package root, next to detectStack", () => {
    expect(typeof detectStack).toBe("function");
    for (const table of [IMAGES, TOOLS, ACTIONS, RUNTIME_DEFAULTS, BUILDPACKS_OFFERS]) {
      expect(Object.keys(table).length).toBeGreaterThan(0);
    }
  });

  it("pins every image as repo:tag@sha256", () => {
    for (const [key, { ref }] of Object.entries(IMAGES)) {
      expect(parseImageRef(ref).digest, key).toMatch(HEX64);
    }
    const tags = Object.fromEntries(
      Object.entries(IMAGES).map(([key, { ref }]) => [key, parseImageRef(ref).tag]),
    );
    expect(tags).toMatchObject({
      nodeAlpine: "24-alpine",
      kamalProxy: "v0.10.2",
      railpackFrontend: "v0.42.0",
      paketoBuilder: "0.0.203",
      paketoRun: "0.0.145",
      mysql: "8.4",
      mariadb: "12.3",
      mongodb: "8.0",
      rabbitmq: "4.3",
      nats: "2.15-alpine",
      kafka: "4.3.1",
      redpanda: "v26.2.5",
      garage: "v2.4.1",
      redis: "8.10.2-alpine",
      dragonfly: "v2.0.2",
      opensearch: "3.9.0",
      elasticsearch: "9.5.5",
      meilisearch: "v1.55.0",
      typesense: "30.2",
      clickhouse: "26.3",
      neo4j: "2026.09-community",
      sshAudit: "v3.9.0",
      testssl: "3.2",
      nginx: "1.30.6-alpine",
      certbot: "v5.8.0",
      pebble: "2.10.1",
    });
    expect(parseImageRef(IMAGES.sshAudit.ref).repo).toBe("positronsecurity/ssh-audit");
    expect(parseImageRef(IMAGES.testssl.ref).repo).toBe("ghcr.io/testssl/testssl.sh");
    expect(parseImageRef(IMAGES.nginx.ref).repo).toBe("nginxinc/nginx-unprivileged");
    expect(parseImageRef(IMAGES.certbot.ref).repo).toBe("certbot/certbot");
    expect(parseImageRef(IMAGES.pebble.ref).repo).toBe("ghcr.io/letsencrypt/pebble");
    expect(parseImageRef(IMAGES.kafka.ref).repo).toBe("apache/kafka");
    expect(parseImageRef(IMAGES.redpanda.ref).repo).toBe("redpandadata/redpanda");
    expect(parseImageRef(IMAGES.garage.ref).repo).toBe("dxflrs/garage");
    expect(parseImageRef(IMAGES.redis.ref).repo).toBe("redis");
    expect(parseImageRef(IMAGES.dragonfly.ref).repo).toBe(
      "docker.dragonflydb.io/dragonflydb/dragonfly",
    );
    expect(Object.keys(IMAGES).sort()).toEqual(
      [
        "caddy",
        "certbot",
        "cloudflared",
        "curl",
        "dockerfileSyntax",
        "dragonfly",
        "redis",
        "garage",
        "kafka",
        "kamalProxy",
        "mariadb",
        "mongodb",
        "mysql",
        "nats",
        "nodeAlpine",
        "opensearch",
        "elasticsearch",
        "meilisearch",
        "typesense",
        "clickhouse",
        "neo4j",
        "nginx",
        "paketoBuilder",
        "paketoRun",
        "pebble",
        "portainer",
        "postgres",
        "python",
        "railpackFrontend",
        "rabbitmq",
        "redpanda",
        "sshAudit",
        "testssl",
        "trivy",
        "valkey",
      ].sort(),
    );
  });

  it("pins pack, Railpack and supercronic by version and a SHA-256 per architecture, cosign by version", async () => {
    expect(TOOLS.pack.version).toBe("0.40.9");
    expect(TOOLS.railpack.version).toBe("0.42.0");
    expect(TOOLS.supercronic.version).toBe("0.2.50");
    expect(TOOLS.cosign).not.toHaveProperty("sha256");
    for (const [tool, pin] of Object.entries(TOOLS)) {
      if (!("sha256" in pin) || typeof pin.sha256 === "string") continue;
      for (const [arch, value] of Object.entries(pin.sha256)) {
        expect(value, `${tool} ${arch}`).toMatch(HEX64);
      }
    }
    const lines = (await SOURCE).split("\n");
    expect(lines.filter((line) => /^\s+(amd64|arm64|version|sha256): ""/.test(line))).toEqual([]);
    expect(lines.filter((line) => /^\s+"",?$|sopsAsset\("[\w-]+", ""\)/.test(line))).toEqual([]);
  });

  it("pins Lynis by its tarball and SHA-256", () => {
    expect(TOOLS.lynis).toEqual({
      version: "3.1.7",
      url: "https://downloads.cisofy.com/lynis/lynis-3.1.7.tar.gz",
      sha256: expect.stringMatching(HEX64),
    });
    expect(LYNIS_DOWNLOADS_PAGE).toBe("https://cisofy.com/downloads/lynis/");
  });

  it("pins sops for the user's machine: each platform's release binary and its SHA-256", () => {
    const sops = LOCAL_TOOLS.sops;
    expect(sops).toMatchObject({
      name: "sops",
      version: "3.13.3",
      envOverride: "OPSCREW_SOPS_BIN",
    });
    expect(Object.keys(sops.assets).sort()).toEqual([
      "darwin-amd64",
      "darwin-arm64",
      "linux-amd64",
      "linux-arm64",
      "windows-amd64",
      "windows-arm64",
    ]);
    const base = "https://github.com/getsops/sops/releases/download/v3.13.3/";
    expect(sops.assets["linux-amd64"].url).toBe(`${base}sops-v3.13.3.linux.amd64`);
    expect(sops.assets["linux-arm64"].url).toBe(`${base}sops-v3.13.3.linux.arm64`);
    expect(sops.assets["darwin-amd64"].url).toBe(`${base}sops-v3.13.3.darwin.amd64`);
    expect(sops.assets["darwin-arm64"].url).toBe(`${base}sops-v3.13.3.darwin.arm64`);
    expect(sops.assets["windows-amd64"].url).toBe(`${base}sops-v3.13.3.amd64.exe`);
    expect(sops.assets["windows-arm64"].url).toBe(`${base}sops-v3.13.3.arm64.exe`);
    for (const [platform, asset] of Object.entries(sops.assets)) {
      expect(asset.sha256, platform).toMatch(HEX64);
    }
    expect(new Set(Object.values(sops.assets).map((asset) => asset.sha256)).size).toBe(6);
    expect(SOPS_RELEASE.checksums("3.13.3")).toBe("sops-v3.13.3.checksums.txt");
  });

  it("pins every action by commit with its tag in a comment", () => {
    for (const value of Object.values(ACTIONS)) {
      expect(formatActionPin(parseActionPin(value))).toBe(value);
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
      "docker/build-push-action",
      "docker/login-action",
      "docker/setup-buildx-action",
      "sigstore/cosign-installer",
    ]);
  });

  it("pins the Python packages and package managers the Dockerfiles install by exact version", () => {
    expect(Object.keys(PYPI_PACKAGES).sort()).toEqual([
      "gunicorn",
      "pipenv",
      "poetry",
      "uv",
      "uvicorn",
    ]);
    expect(Object.keys(PACKAGE_MANAGERS).sort()).toEqual(["pnpm", "yarn"]);
    for (const [name, version] of Object.entries({ ...PYPI_PACKAGES, ...PACKAGE_MANAGERS })) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
    // Projects without packageManager have Yarn 1 lockfiles.
    expect(PACKAGE_MANAGERS.yarn).toMatch(/^1\./);
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
  it("splits image references into repository, tag and digest", () => {
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
  });

  it("reads an action in a subfolder, whose commit comes from its repository's tag", () => {
    const sha = "f".repeat(40);
    const setupPack = parseActionPin(`buildpacks/github-actions/setup-pack@${sha} # v5.9.0`);
    expect(setupPack).toEqual({
      action: "buildpacks/github-actions/setup-pack",
      repo: "buildpacks/github-actions",
      tag: "v5.9.0",
      sha,
    });
    expect(formatActionPin(setupPack)).toBe(`buildpacks/github-actions/setup-pack@${sha} # v5.9.0`);
    for (const bad of ["docker/build-push-action@v7", "checkout@v7"]) {
      expect(() => parseActionPin(bad), bad).toThrow(/action pin/);
    }
  });

  it("names the release assets of each tool, and reads their SHA-256", () => {
    const railpack = TOOL_RELEASES.railpack;
    expect(railpack.repo).toBe("railwayapp/railpack");
    expect(railpack.tag("0.42.0")).toBe("v0.42.0");
    expect(railpack.asset.amd64("0.42.0")).toBe(
      "railpack-v0.42.0-x86_64-unknown-linux-musl.tar.gz",
    );
    expect(TOOL_RELEASES.pack.asset.arm64("0.40.9")).toBe("pack-v0.40.9-linux-arm64.tgz");
    expect(Object.keys(TOOL_RELEASES).sort()).toEqual([
      "cloudflared",
      "pack",
      "railpack",
      "supercronic",
    ]);
    expect(toolDownloadUrl("supercronic", "arm64")).toBe(
      `https://github.com/aptible/supercronic/releases/download/v${TOOLS.supercronic.version}/supercronic-linux-arm64`,
    );
    expect(TOOL_RELEASES.supercronic.sha1InReleaseNotes).toBe(true);
    expect(TOOL_RELEASES.pack.sha1InReleaseNotes).toBeUndefined();
    expect(toolDownloadUrl("railpack", "arm64")).toBe(
      `https://github.com/railwayapp/railpack/releases/download/v${TOOLS.railpack.version}/railpack-v${TOOLS.railpack.version}-arm64-unknown-linux-musl.tar.gz`,
    );
    expect(toolDownloadUrl("cloudflared", "amd64")).toBe(
      `https://github.com/cloudflare/cloudflared/releases/download/${TOOLS.cloudflared.version}/cloudflared-linux-amd64`,
    );

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

  it("replaces one pinned value", async () => {
    const source = await SOURCE;
    const { ref } = IMAGES.nodeAlpine;
    const filled = `${parseImageRef(ref).repo}:${parseImageRef(ref).tag}@sha256:${"d".repeat(64)}`;
    const before = source.split("\n");
    const changed = replacePin(source, ref, filled)
      .split("\n")
      .filter((line, i) => line !== before[i]);
    expect(changed).toEqual([before.find((line) => line.includes(ref))?.replace(ref, filled)]);
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

  it("reads a package's newest release from PyPI's JSON and npm's latest", () => {
    expect(latestReleaseUrl("pypi", "poetry")).toBe("https://pypi.org/pypi/poetry/json");
    expect(latestReleaseUrl("npm", "pnpm")).toBe("https://registry.npmjs.org/pnpm/latest");
    expect(latestReleaseVersion("pypi", { info: { version: "2.5.1" } })).toBe("2.5.1");
    expect(latestReleaseVersion("npm", { name: "yarn", version: "1.22.22" })).toBe("1.22.22");
    for (const bad of [{ info: { version: "3.0.0b1" } }, { info: {} }, {}, null]) {
      expect(() => latestReleaseVersion("pypi", bad), JSON.stringify(bad)).toThrow(/release/);
    }
    expect(() => latestReleaseVersion("npm", { version: "13.0.0-rc.1" })).toThrow(/release/);
  });

  it("sets one package version in its table and leaves the rest alone", async () => {
    const source = await SOURCE;
    const next = setPackageVersion(source, "PYPI_PACKAGES", "uv", "9.9.9");
    const before = source.split("\n");
    expect(next.split("\n").filter((line, i) => line !== before[i])).toEqual(['  uv: "9.9.9",']);
    // pnpm is only in PACKAGE_MANAGERS.
    expect(setPackageVersion(source, "PACKAGE_MANAGERS", "pnpm", "9.9.9")).toContain(
      '  pnpm: "9.9.9",',
    );
    expect(() => setPackageVersion(source, "PYPI_PACKAGES", "pnpm", "1.0.0")).toThrow(/pnpm/);
    expect(() => setPackageVersion(source, "NOPE", "uv", "1.0.0")).toThrow(/NOPE/);
  });

  it("reads the SHA-1 a release's notes list for one asset", async () => {
    const release = JSON.parse(
      await readFile(new URL("supercronic-release.json", FIXTURES), "utf8"),
    ) as { body: string };
    expect(releaseNotesSha1(release.body, "supercronic-linux-amd64")).toBe(
      "0795da10bf6303e9680a2c2bd8dd6b9aa33ebda2",
    );
    expect(releaseNotesSha1(release.body, "supercronic-linux-arm64")).toBe(
      "e0023a0346354a153a4a2708c657308890823d14",
    );
    // The arm asset's name is a prefix of arm64's, and it has its own checksum.
    expect(releaseNotesSha1(release.body, "supercronic-linux-arm")).toBe(
      "1d03803120f035569dc528cee117b9220ee959b8",
    );
    const lf = release.body.replaceAll("\r\n", "\n");
    expect(releaseNotesSha1(lf, "supercronic-linux-arm64")).toBe(
      "e0023a0346354a153a4a2708c657308890823d14",
    );
    expect(() => releaseNotesSha1(release.body, "supercronic-darwin-arm64")).toThrow(
      /no SHA-1 for supercronic-darwin-arm64/,
    );
    expect(() => releaseNotesSha1("", "supercronic-linux-amd64")).toThrow(/SHA-1/);
  });

  it("gives an asset's SHA-256 only when its SHA-1 matches", () => {
    // The FIPS 180 test vectors for "abc".
    const abc = new TextEncoder().encode("abc");
    const sha1 = "a9993e364706816aba3e25717850c26c9cd0d89d";
    expect(verifiedSha256(abc, sha1, "abc.bin")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const other = new TextEncoder().encode("abd");
    expect(() => verifiedSha256(other, sha1, "abc.bin")).toThrow(/abc\.bin.*SHA-1/);
  });

  it("checks a download against a published SHA-256 too", () => {
    const abc = new TextEncoder().encode("abc");
    const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(verifiedSha256(abc, sha256, "lynis.tar.gz")).toBe(sha256);
    const other = new TextEncoder().encode("abd");
    expect(() => verifiedSha256(other, sha256, "lynis.tar.gz")).toThrow(
      /lynis\.tar\.gz does not match its published SHA-256/,
    );
  });

  it("takes sops's SHA-256 from GitHub only when the release's checksums file agrees", () => {
    const [a, b] = ["a".repeat(64), "b".repeat(64)];
    const name = SOPS_RELEASE.asset["linux-arm64"]("3.13.3");
    expect(name).toBe("sops-v3.13.3.linux.arm64");
    const release = {
      assets: [
        { name, digest: `sha256:${a}` },
        { name: "sops-v3.13.3.linux.arm64.spdx.sbom.json", digest: `sha256:${b}` },
      ],
    };
    const checksums = `${b}  sops-v3.13.3.linux.arm64.spdx.sbom.json\r\n${a}  ${name}\r\n`;
    expect(checkedAssetSha256(release, checksums, name)).toBe(a);
    expect(() => checkedAssetSha256(release, `${b}  ${name}\n`, name)).toThrow(
      /differs from the checksums file/,
    );
    expect(() => checkedAssetSha256(release, `${a}  ${name}.spdx.sbom.json\n`, name)).toThrow(
      /lists no sops-v3\.13\.3\.linux\.arm64/,
    );
  });

  it("reads the version and SHA-256 from Lynis's downloads page", () => {
    const sha = "c".repeat(64);
    const page = `<ul><li>Package: Lynis</li><li>Version: 3.1.7</li><li>SHA256 hash: ${sha}</li></ul>`;
    expect(lynisPublished(page)).toEqual({ version: "3.1.7", sha256: sha });
    expect(() => lynisPublished("<p>Our website is getting an overhaul.</p>")).toThrow(/Lynis/);
  });

  it("sets the Lynis checksum and one sops checksum, and leaves the rest alone", async () => {
    const source = await SOURCE;
    const sha = "f".repeat(64);
    const before = source.split("\n");
    const lynis = setToolChecksum(source, "lynis", "sha256", sha);
    expect(lynis.split("\n").filter((line, i) => line !== before[i])).toEqual([
      `    sha256: "${sha}",`,
    ]);
    expect(() => setToolChecksum(source, "pack", "sha256", sha)).toThrow(/pack sha256/);

    const sops = setSopsChecksum(source, "darwin-arm64", sha);
    const changed = sops.split("\n").filter((line, i) => line !== before[i]);
    expect(changed).toEqual([
      before
        .find((line) => line.includes(LOCAL_TOOLS.sops.assets["darwin-arm64"].sha256))
        ?.replace(LOCAL_TOOLS.sops.assets["darwin-arm64"].sha256, sha),
    ]);
  });
});
