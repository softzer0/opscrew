/**
 * Every version OpsCrew pins: images by the digest of their multi-arch index, tools by version and
 * SHA-256 (sops, for the user's machine, per platform), GitHub Actions by commit, the Python
 * packages and package managers the generated Dockerfiles install by version, the runtime defaults
 * and what the pinned Buildpacks builder offers. `scripts/update-pins.mjs` refreshes the digests, checksums and commits (change a tag or
 * version here first) and moves the packages to their newest releases; with `--offers` it
 * refreshes the Buildpacks offers instead:
 * `pnpm --filter @opscrew/iac-templates exec tsx scripts/update-pins.mjs [--offers]`.
 */
import type { LocalPlatform, LocalToolPin } from "@opscrew/core";
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

/** A tool released as one archive for every architecture (Lynis, a shell script): URL and SHA-256. */
export interface ArchiveToolPin {
  version: string;
  url: string;
  sha256: string;
}

// Sources: the 012 spikes (2026-10-18) and the pins OpsCrew used before 012 (Trivy 2026-10-11,
// cloudflared 2026-10-14, curl 2026-10-15), each read from the registry API.
export const IMAGES = {
  /** Base of the generated Node Dockerfiles. */
  nodeAlpine: {
    ref: "node:24-alpine@sha256:6a1c190e17215d844926b0677f4bf87273ff7d5e54db06d3b5b5863ab0b09a3d",
  },
  /** Base of the generated Python Dockerfiles. */
  python: {
    ref: "python:3.14-slim@sha256:fbecd461fc72d21b2143c6eaba25143738079154a6d0ea3da3aec724f50eed4a",
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
    ref: "curlimages/curl:8.23.0@sha256:11e64e28c5f58c8d93ee95fcf22ac055f48b0bc440e0ce7d8013bbb5ad6aa8ac",
  },
  /** Paketo's Ubuntu 24.04 builder (lifecycle 0.21.22), amd64 and arm64. */
  paketoBuilder: {
    ref: "paketobuildpacks/ubuntu-noble-builder:0.0.203@sha256:ba79c24b55830210fc5ee06768237ab989dbaeec36adb60a986bcb8e70e4d7cd",
  },
  // Runs as 1002:1001, which BUILDPACKS_RUN_USER in workflow/build.ts repeats: when this pin
  // changes, rerun OPSCREW_DOCKER_TESTS=1 pnpm --filter @opscrew/iac-templates exec vitest run src/docker/sqlite-volume.test.ts
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
  // The 013 services (2026-10-19): each image's LTS or stable line, never a rolling tag such as
  // `latest` (research.md R2, R3, R4 and R8).
  /** MySQL 8.4 LTS (Docker's `latest` is an Innovation release). */
  mysql: {
    ref: "mysql:8.4@sha256:0f51e63e537a1f176423fa03ef559aabe6fa4372a53160a44bc7e75da7d15364",
  },
  /** MariaDB's current LTS line, the one its `lts` tag points to. */
  mariadb: {
    ref: "mariadb:12.3@sha256:99c125f103f5d081ebbc9ffe064e63daf7f688ac33a5f7f29af2d7260a96debf",
  },
  mongodb: {
    ref: "mongo:8.0@sha256:4a4ab5d4834207389e0d7270fac988e21ffedccecba77991a552f755df229907",
  },
  /** Without the management plugin. */
  rabbitmq: {
    ref: "rabbitmq:4.3@sha256:3e5cc23235b0eb850f604e8ace10d9a9b6d05be3e36730e53522ee9ead707a9e",
  },
  /** The alpine variant has the shell and `wget` a healthcheck needs; the default is scratch. */
  nats: {
    ref: "nats:2.15-alpine@sha256:2ae57dfba3063d5e25fecb75256118c0882a1a2d2cf7d0fba17a7c701df956f6",
  },
  /** Kafka publishes only version tags and `latest`, so this is an exact release. */
  kafka: {
    ref: "apache/kafka:4.3.1@sha256:77e3df9054047a88b520d0cc46e16696d3b22022e1d580aeccd2632df6532837",
  },
  redpanda: {
    ref: "redpandadata/redpanda:v26.2.5@sha256:badca2d958f81da675c3055a9ecb6ebb590325582bcf16936148ffd65e96e920",
  },
  garage: {
    ref: "dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020",
  },
  // Next to Valkey (2026-10-20, research.md R9). Redis 8's image loads Search, JSON, Time Series
  // and Bloom (the engines check runs MODULE LIST); Dragonfly's releases are on its own
  // registry only (Docker Hub has no v2 tags).
  redis: {
    ref: "redis:8.10.2-alpine@sha256:3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0",
  },
  dragonfly: {
    ref: "docker.dragonflydb.io/dragonflydb/dragonfly:v2.0.2@sha256:061f00b201b58e12f974e4e96c761a881ee1c05e9d8ee967466a604b7299753b",
  },
  // The 013 search and analytics engines (2026-10-19, research.md R5): each one's current
  // release, or its LTS line.
  opensearch: {
    ref: "opensearchproject/opensearch:3.9.0@sha256:adfa61f85025d06b4aeb562e7e74fde7e31c437039c93c3862c17e9acebd6c7c",
  },
  /** Elastic's own image (Elastic License 2.0), as Docker Hub's official copy publishes it. */
  elasticsearch: {
    ref: "elasticsearch:9.5.5@sha256:33cae13fc18ef105e960cdd32327d402fbd7c6d4376c0b879ad703ee289d45d8",
  },
  meilisearch: {
    ref: "getmeili/meilisearch:v1.55.0@sha256:ff546679970126f8822e15d1b6a06bfbff1f2ce2e43f810cfb5258012f92de5c",
  },
  typesense: {
    ref: "typesense/typesense:30.2@sha256:610f2d34b1f93d00762869da2c67736775e5798d19a2c8b91b014b8a0cc1e110",
  },
  /** ClickHouse's LTS line, the one its `lts` tag points to. */
  clickhouse: {
    ref: "clickhouse:26.3@sha256:74ea7dc439d751248b2691a3d865af36ea5f2f16f28e0e6e2c8061224be147dd",
  },
  /** The Community edition, in calendar versions. */
  neo4j: {
    ref: "neo4j:2026.09-community@sha256:d6269a020149934597c8c3df926d080a612796dbbb48861ca9d5b1109cabf0d8",
  },
  // The 014 checks and edge (2026-10-21, research.md R1 and R5).
  /** ssh-audit, run on the user's machine against the server's SSH port (`secure --deep`). */
  sshAudit: {
    ref: "positronsecurity/ssh-audit:v3.9.0@sha256:6d5dee75fe91b5f6279f683f0e7d4374d2ba83e2227c8d9a17097aac2775127d",
  },
  /**
   * testssl.sh, run on the user's machine. The project tags its images by release line only, so
   * this is the 3.2 line (3.2.4 and its backported fixes).
   */
  testssl: {
    ref: "ghcr.io/testssl/testssl.sh:3.2@sha256:36e25ef4b7a0382f6fe302313e62c212afbef2c2baa86cbc108399170e38449a",
  },
  /** The non-root nginx of the nginx edge (`target.edge: nginx`), the stable 1.30 line. */
  nginx: {
    ref: "nginxinc/nginx-unprivileged:1.30.6-alpine@sha256:f5116ed4606f3eb015dd4a8e28cb9b351476dc0ad4bc6e9f93b19cec130cdf03",
  },
  /** Obtains and renews the nginx edge's certificates. */
  certbot: {
    ref: "certbot/certbot:v5.8.0@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20",
  },
  /** Let's Encrypt's test ACME server, for OpsCrew's Docker tests only. */
  pebble: {
    ref: "ghcr.io/letsencrypt/pebble:2.10.1@sha256:ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199",
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
  /**
   * The cron runner built into app images that have cron jobs (the release assets
   * `supercronic-linux-amd64` and `supercronic-linux-arm64`). Upstream publishes only SHA-1s, so
   * the pin script checks those and records the SHA-256 of the downloaded binary.
   */
  supercronic: {
    version: "0.2.50",
    sha256: {
      amd64: "d2d7c97fbfefc763d5bbcbbb3f8d61f9dd3410ce5d05a737c414994b80b8cdd0",
      arm64: "a1c0af9872e8de89a1ce5c1b596e26c42917d5a2cf914d98faee2e28156899e2",
    },
  },
  /** The cosign release `sigstore/cosign-installer` installs; the installer verifies it. */
  cosign: {
    version: "v3.1.3",
  },
  /**
   * Lynis, streamed to the server for `secure --deep`. CISOfy publishes the tarball's SHA-256 on
   * its downloads page ({@link LYNIS_DOWNLOADS_PAGE}), which the pin script checks the download
   * against; change `url` with `version`.
   */
  lynis: {
    version: "3.1.7",
    url: "https://downloads.cisofy.com/lynis/lynis-3.1.7.tar.gz",
    sha256: "b5314a07fd85fa3ffc7da57b508f0108ec3280d84e4af823f805d95cbbc2428c",
  },
} as const satisfies Record<string, ToolPin | ArchiveToolPin>;
export type ToolKey = keyof typeof TOOLS;

/** The page where CISOfy publishes the current Lynis release and its SHA-256. */
export const LYNIS_DOWNLOADS_PAGE = "https://cisofy.com/downloads/lynis/";

/** A tool {@link TOOL_RELEASES} lists: every tool with a checksum per architecture. */
export type ReleasedTool = Exclude<ToolKey, "cosign" | "lynis">;

/**
 * Where each tool with a checksum releases: the GitHub repository, its tag and archive per
 * architecture. cosign has none: `sigstore/cosign-installer` verifies the binary it installs.
 * `sha1InReleaseNotes` marks a release whose notes give only a SHA-1 per asset.
 */
export const TOOL_RELEASES: Record<
  ReleasedTool,
  {
    repo: string;
    tag: (version: string) => string;
    asset: Record<PinArch, (version: string) => string>;
    sha1InReleaseNotes?: true;
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
  supercronic: {
    repo: "aptible/supercronic",
    tag: (v) => `v${v}`,
    asset: { amd64: () => "supercronic-linux-amd64", arm64: () => "supercronic-linux-arm64" },
    sha1InReleaseNotes: true,
  },
};

/** The download URL of the release asset of `tool` at its pinned version, for `arch`. */
export function toolDownloadUrl(tool: ReleasedTool, arch: PinArch): string {
  const { version } = TOOLS[tool];
  const release = TOOL_RELEASES[tool];
  return `https://github.com/${release.repo}/releases/download/${release.tag(version)}/${release.asset[arch](version)}`;
}

/**
 * Where sops releases: the raw binary per platform, and the checksums file the pin script checks
 * GitHub's SHA-256 of each binary against.
 */
export const SOPS_RELEASE: {
  repo: string;
  tag: (version: string) => string;
  asset: Record<LocalPlatform, (version: string) => string>;
  checksums: (version: string) => string;
} = {
  repo: "getsops/sops",
  tag: (v) => `v${v}`,
  asset: {
    "linux-amd64": (v) => `sops-v${v}.linux.amd64`,
    "linux-arm64": (v) => `sops-v${v}.linux.arm64`,
    "darwin-amd64": (v) => `sops-v${v}.darwin.amd64`,
    "darwin-arm64": (v) => `sops-v${v}.darwin.arm64`,
    "windows-amd64": (v) => `sops-v${v}.amd64.exe`,
    "windows-arm64": (v) => `sops-v${v}.arm64.exe`,
  },
  checksums: (v) => `sops-v${v}.checksums.txt`,
};

const SOPS_VERSION = "3.13.3";

/** The pinned sops release asset for `platform`, with its SHA-256. */
function sopsAsset(platform: LocalPlatform, sha256: string): { url: string; sha256: string } {
  const { repo, tag, asset } = SOPS_RELEASE;
  return {
    url: `https://github.com/${repo}/releases/download/${tag(SOPS_VERSION)}/${asset[platform](SOPS_VERSION)}`,
    sha256,
  };
}

/** Tools OpsCrew fetches onto the user's machine (`fetchPinnedTool` in `@opscrew/core`). */
export const LOCAL_TOOLS = {
  /** sops, which writes and reads the recovery copy (`opscrew/secrets.sops.json`). */
  sops: {
    name: "sops",
    version: SOPS_VERSION,
    envOverride: "OPSCREW_SOPS_BIN",
    assets: {
      "linux-amd64": sopsAsset(
        "linux-amd64",
        "e5bec3346a873ae91d871550f3e698c1aad962aff462a080e40f25fde17fef6b",
      ),
      "linux-arm64": sopsAsset(
        "linux-arm64",
        "53b0abacd38ef1b12a66d6c100956691b9cefce018d91f81e73ddf7438b94d77",
      ),
      "darwin-amd64": sopsAsset(
        "darwin-amd64",
        "42162d5cef10b74fcf80a045a70e658d7ce6e63d6ea1be6f347e44015714468d",
      ),
      "darwin-arm64": sopsAsset(
        "darwin-arm64",
        "b97c0d434aab577dc40310e8d22ff9e45eef4c80638ab978daae9b4681c59286",
      ),
      "windows-amd64": sopsAsset(
        "windows-amd64",
        "a4a9a398858fe8b2ef72d9686d930bf7c5cece9be74ad83ac3b53cfdd70e6b1c",
      ),
      "windows-arm64": sopsAsset(
        "windows-arm64",
        "7f936a0d08edbeba3eb8f50bad1fe71eba83a140a80dfd17051f3bdb4facb08a",
      ),
    },
  },
} as const satisfies Record<string, LocalToolPin>;

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
  pipenv: "2026.10.2",
  poetry: "2.5.1",
  uv: "0.13.4",
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
