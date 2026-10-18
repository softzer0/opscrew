/**
 * Every version OpsCrew pins: images by the digest of their multi-arch index, tools by version and
 * SHA-256, GitHub Actions by commit, the runtime defaults and what the pinned Buildpacks builder
 * offers. `scripts/update-pins.mjs` refreshes the digests, checksums and commits (change a tag or
 * version here first), and with `--offers` the Buildpacks offers:
 * `pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs [--offers]`. A value
 * marked `TODO(pins)` is not pinned yet; the script fills it.
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
  node: {
    ref: "node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5",
  },
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
export type ImageKey = keyof typeof IMAGES;

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
  /** The cosign release `sigstore/cosign-installer` installs; the installer verifies it. */
  cosign: {
    version: "v3.1.3",
  },
} as const satisfies Record<string, ToolPin>;
export type ToolKey = keyof typeof TOOLS;

/**
 * GitHub Actions the workflows use, as `owner/name@<commit> # <tag>`. An action still pinned by
 * tag only (`owner/name@<tag>`) is filled by the script; `@TODO` needs its tag set first.
 */
export const ACTIONS = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  setupBuildx: "docker/setup-buildx-action@f87e5991a6d7451dcb8d9637bfbc97413f497069 # v4.4.1",
  buildPush: "docker/build-push-action@c3c9e263c25d99ce0380d002d59b67737d91b0dc # v7.4.0",
  cosignInstaller: "sigstore/cosign-installer@6f9f17788090df1f26f669e9d70d6ae9567deba6 # v4.1.2",
  setupPack:
    "buildpacks/github-actions/setup-pack@a96fc9720ee9ccf19d4c87c3de9c344a2c404c29 # v6.2.0",
  login: "docker/login-action@dbcb813823bdd20940b903addbd779551569679f # v4.6.0",
} as const satisfies Record<string, string>;
export type ActionKey = keyof typeof ACTIONS;

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
