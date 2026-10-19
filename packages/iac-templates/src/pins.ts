/**
 * Every version OpsCrew pins: images by the digest of their multi-arch index, tools by version and
 * SHA-256, GitHub Actions by commit, the Python packages and package managers the generated
 * Dockerfiles install by version, the runtime defaults and what the pinned Buildpacks builder
 * offers. `scripts/update-pins.mjs` refreshes the digests, checksums and commits (change a tag or
 * version here first) and moves the packages to their newest releases; with `--offers` it
 * refreshes the Buildpacks offers instead:
 * `pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs [--offers]`.
 */
import type { RuntimeLanguage } from "@opscrew/plan-schema";

/** A CPU architecture OpsCrew builds images for. */
export type PinArch = "amd64" | "arm64";

/** An image as `repo:tag@sha256:<index digest>`. */
export interface ImagePin {
  ref: string;
}

/**
 * A tool binary: its release version and the SHA-256 of its Linux archive per architecture.
 * `sha256` is absent for a tool installed by an action that verifies it (cosign).
 */
export interface ToolPin {
  version: string;
  sha256?: Record<PinArch, string>;
}

// Sources: the 012 spikes (2026-10-18) and the pins OpsCrew used before 012 (Trivy 2026-10-11,
// cloudflared 2026-10-14, curl 2026-10-15), each read from the registry API.
export const IMAGES = {
  /** Base of the generated Node Dockerfiles. */
  nodeAlpine: {
    ref: "node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f",
  },
  /** Base of the generated Python Dockerfiles. */
  python: {
    ref: "python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170",
  },
  caddy: {
    ref: "caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f",
  },
  postgres: {
    ref: "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24",
  },
  valkey: {
    ref: "valkey/valkey:8-alpine@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507",
  },
  /** The switch between app copies on a server (rolling deploys). */
  kamalProxy: {
    ref: "basecamp/kamal-proxy:v0.10.2@sha256:a686220c2aa42c4f9bbcfe851b1d21b2cedee0b5c389890c29d205282379da7c",
  },
  cloudflared: {
    ref: "cloudflare/cloudflared:2026.5.1@sha256:a5b5e6fd9a372f054b9a843c219bfbcdceb54691605312a8b1ee72978bdf1aa1",
  },
  /** The report-only image scan; it runs with the Docker socket. */
  trivy: {
    ref: "aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa",
  },
  curl: {
    ref: "curlimages/curl:8.23.0@sha256:a134550be58ab783810e613ae96fd253c38f7bdd16d9bf9be350700c7a29ac06",
  },
  /** Paketo's Ubuntu 24.04 builder (lifecycle 0.21.22), amd64 and arm64. */
  paketoBuilder: {
    ref: "paketobuildpacks/ubuntu-noble-builder:0.0.203@sha256:ba79c24b55830210fc5ee06768237ab989dbaeec36adb60a986bcb8e70e4d7cd",
  },
  paketoRun: {
    ref: "paketobuildpacks/ubuntu-noble-run:0.0.145@sha256:577357bc2a59c962ce3f7d816f7ff401f408538832a1c56a9a87f6fc5829df97",
  },
  /** Portainer CE for the Portainer add-on on a server (the LTS release OpsCrew installs). */
  portainer: {
    ref: "portainer/portainer-ce:2.45.2@sha256:03f94a406496dc84d37b552795fc424ccad8d0d7200353b6a82915f6e8f73ab0",
  },
  /** The Dockerfile frontend named by the generated Dockerfile's `# syntax=` line. */
  dockerfileSyntax: {
    ref: "docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e",
  },
  /** Railpack's BuildKit frontend, matching the Railpack CLI in {@link TOOLS}. */
  railpackFrontend: {
    ref: "ghcr.io/railwayapp/railpack-frontend:v0.42.0@sha256:a42a12399fa9e83a09e475f69dbf8a45a8a74ea38a4485fcb401356d84317a14",
  },
} as const satisfies Record<string, ImagePin>;

export const TOOLS = {
  /** The Cloud Native Buildpacks CLI. */
  pack: {
    version: "0.40.9",
    sha256: {
      amd64: "dc0ee1e931cf8a106d7555a01a214864f9acb60b77adf15d69b74df4404758e9",
      arm64: "091ccb213823656c727731537ef8f1000eb4dc3ec61641506653e7f9d6da0c5e",
    },
  },
  /** The Railpack CLI (musl build), which writes the build plan the frontend runs. */
  railpack: {
    version: "0.42.0",
    sha256: {
      amd64: "81bca91d0577c7650378762609116d12d8630e2cfc1779e41d3ac3964fc7194b",
      arm64: "63c0417d6c0a437162fa2c688ddf58aabf9e4433eeffb69d8c3fb498603e2c3b",
    },
  },
  /**
   * The cloudflared Linux binary the deploy workflow installs in tunnel mode (the release assets
   * `cloudflared-linux-amd64` and `cloudflared-linux-arm64`). 2026.6.0 ignores service tokens for
   * `access ssh` and falls back to a browser login (cloudflare/cloudflared#1673), so CI would hang;
   * change the version only after a smoke test proves service tokens work.
   */
  cloudflared: {
    version: "2026.5.1",
    sha256: {
      amd64: "3c6a5ba995a258dbe90f98e5fdb2c2620b7be72c3ca761614f6eb52aee252cea",
      arm64: "7b7a8b9a2764acab0fecda633cb54a6c0df42d7f8ca1ec45c78333c2227d8d91",
    },
  },
  /** The cosign release `sigstore/cosign-installer` installs; the installer verifies it. */
  cosign: {
    version: "v3.1.3",
  },
} as const satisfies Record<string, ToolPin>;
export type ToolKey = keyof typeof TOOLS;

/** A tool {@link TOOL_RELEASES} lists: every tool with a checksum. */
export type ReleasedTool = Exclude<ToolKey, "cosign">;

/**
 * Where each tool with a checksum releases: the GitHub repository, its tag and archive per
 * architecture. cosign has none: `sigstore/cosign-installer` verifies the binary it installs.
 */
export const TOOL_RELEASES: Record<
  ReleasedTool,
  {
    repo: string;
    tag: (version: string) => string;
    asset: Record<PinArch, (version: string) => string>;
  }
> = {
  pack: {
    repo: "buildpacks/pack",
    tag: (v) => `v${v}`,
    asset: { amd64: (v) => `pack-v${v}-linux.tgz`, arm64: (v) => `pack-v${v}-linux-arm64.tgz` },
  },
  cloudflared: {
    repo: "cloudflare/cloudflared",
    tag: (v) => v,
    asset: { amd64: () => "cloudflared-linux-amd64", arm64: () => "cloudflared-linux-arm64" },
  },
  railpack: {
    repo: "railwayapp/railpack",
    tag: (v) => `v${v}`,
    asset: {
      amd64: (v) => `railpack-v${v}-x86_64-unknown-linux-musl.tar.gz`,
      arm64: (v) => `railpack-v${v}-arm64-unknown-linux-musl.tar.gz`,
    },
  },
};

/** The download URL of the release asset of `tool` at its pinned version, for `arch`. */
export function toolDownloadUrl(tool: ReleasedTool, arch: PinArch): string {
  const { version } = TOOLS[tool];
  const release = TOOL_RELEASES[tool];
  return `https://github.com/${release.repo}/releases/download/${release.tag(version)}/${release.asset[arch](version)}`;
}

/** GitHub Actions the workflows use, as `owner/name@<commit> # <tag>`. */
export const ACTIONS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  setupBuildx: "docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1",
  buildPush: "docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0",
  cosignInstaller: "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4.1.2",
  login: "docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0",
} as const satisfies Record<string, string>;

/**
 * Python packages the generated Dockerfiles install with pip, by version on PyPI: the installers
 * Poetry, uv and Pipenv, and the servers gunicorn (Django) and uvicorn (FastAPI), which are added
 * only when the app's dependencies do not install them.
 */
export const PYPI_PACKAGES = {
  gunicorn: "26.2.0",
  pipenv: "2026.10.1",
  poetry: "2.5.1",
  uv: "0.13.1",
  uvicorn: "0.54.0",
} as const satisfies Record<string, string>;

/**
 * The pnpm and Yarn releases on npm the generated Dockerfiles install with npm when package.json
 * names no `packageManager`. Yarn's is the last Yarn 1 release, the one whose lockfiles such
 * projects have.
 */
export const PACKAGE_MANAGERS = {
  pnpm: "12.14.0",
  yarn: "1.22.22",
} as const satisfies Record<string, string>;

// FR-1228 rule 4: when the app declares no version, each language defaults to an LTS release that
// has been out for at least 6 months, otherwise to the second-newest minor release. For a
// Buildpacks language the default must also be in BUILDPACKS_OFFERS (Java 25 is offered).
/** The runtime version a builder gets when the app declares none. */
export const RUNTIME_DEFAULTS = {
  node: "24",
  python: "3.14",
  go: "1.26",
  php: "8.4",
  ruby: "3.4",
  rust: "1.98",
  dotnet: "10.0",
  java: "25",
} as const satisfies Record<Exclude<RuntimeLanguage, "other">, string>;

/**
 * Versions the pinned Paketo builder provides, per language Buildpacks builds, in full as its
 * dependency buildpacks list them for its stack (`--offers` writes them). T1203 matches a declared
 * version by prefix at the app's precision: `3.4` matches `3.4.10`, `4.0.7` matches nothing.
 */
export const BUILDPACKS_OFFERS: Readonly<
  Record<"go" | "java" | "dotnet" | "ruby", readonly string[]>
> = {
  go: ["1.25.13", "1.25.14", "1.26.7", "1.26.8"],
  java: ["8.0.504", "11.0.32", "17.0.20", "21.0.12", "25.0.4", "26.0.2"],
  dotnet: ["8.0.425", "9.0.318", "10.0.401"],
  ruby: ["3.3.11", "3.3.12", "3.4.9", "3.4.10", "4.0.5", "4.0.6"],
};
