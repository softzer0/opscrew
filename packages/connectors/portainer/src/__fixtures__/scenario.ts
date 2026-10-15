import { randomUUID } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { portainerClient } from "../client";
import { inspectPortainer } from "../inspect";
import { opscrewStackNames } from "../names";
import type { DesiredStacks, DesiredValueFingerprints } from "../plan";
import { valueFingerprints } from "../values";
import { type FakePortainerOptions, type FakeStack, fakePortainer } from "./fake-portainer";

export const endpoint = {
  url: "https://nas.lan:9443",
  certFingerprint: `SHA256:${"AB".repeat(32)}`,
};
export const REPO = "https://github.com/acme/shop";
export const BRANCH_KEY = `${REPO}#refs/heads/opscrew-deploy`;
export const PLACEHOLDER = "services:\n  placeholder:\n    image: curlimages/curl@sha256:0\n";

export const UPDATER_COMPOSE = [
  "name: opscrew-shop-updater",
  "services:",
  "  updater:",
  "    image: curlimages/curl@sha256:1111",
  '    command: ["sh", "-c", "while true; do curl -fsS --pinnedpubkey \\"$${PORTAINER_PINNED_KEY}\\" -X POST \\"$${PORTAINER_WEBHOOK_URL}\\"; sleep 60; done"]',
  "    environment:",
  "      PORTAINER_WEBHOOK_URL: ${PORTAINER_WEBHOOK_URL}",
  "      PORTAINER_PINNED_KEY: ${PORTAINER_PINNED_KEY}",
  "",
].join("\n");

export const CONNECTOR_COMPOSE = [
  "name: opscrew-shop-portainer-tunnel",
  "services:",
  "  cloudflared:",
  "    image: cloudflare/cloudflared@sha256:2222",
  "    command: tunnel --no-autoupdate run",
  "    environment:",
  "      TUNNEL_TOKEN: ${TUNNEL_TOKEN}",
  "",
].join("\n");

/** The desired stacks of the example app `shop` (private repository and image, updater mode). */
export function desired(overrides: Partial<DesiredStacks> = {}): DesiredStacks {
  return {
    app: "shop",
    environmentId: 3,
    repository: { url: REPO, branch: "opscrew-deploy", composeFile: "compose.yaml", private: true },
    envKeys: ["DATABASE_URL", "STRIPE_KEY"],
    registry: { url: "ghcr.io", private: true },
    redeploy: "updater",
    updater: { compose: UPDATER_COMPOSE },
    volumes: ["opscrew-shop_db-data"],
    ...overrides,
  };
}

/** Synthetic secrets for one apply (generated at runtime, never committed). */
export function secrets(webhookId = randomUUID()) {
  return {
    env: {
      DATABASE_URL: `postgres://shop:${fakeSecret("generic-password", "db")}@db:5432/shop`,
      STRIPE_KEY: fakeSecret("stripe-live-key", "shop"),
    },
    webhookId,
    repositoryToken: fakeSecret("github-pat", "repo-read"),
    registryToken: fakeSecret("github-token", "read-packages"),
    tunnelToken: fakeSecret("cloudflare-token", "portainer-tunnel"),
    updaterEnv: {
      PORTAINER_WEBHOOK_URL: `https://host.docker.internal:9443/api/stacks/webhooks/${webhookId}`,
      PORTAINER_PINNED_KEY: "sha256//FAKEpinnedPublicKeyBase64AAAAAAAAAAAAAAAAAAA=",
    },
  };
}

/** `DesiredStacks.valueFingerprints` for a set of secrets (as the caller computes them). */
export function fingerprintsFor(
  key: Uint8Array,
  s: {
    env: Record<string, string>;
    updaterEnv: Record<string, string>;
    tunnelToken: string;
    webhookId: string;
    repositoryToken: string;
    registryToken: string;
  },
): DesiredValueFingerprints {
  const tokens = valueFingerprints(key, {
    repositoryToken: s.repositoryToken,
    registryToken: s.registryToken,
  });
  return {
    app: valueFingerprints(key, s.env),
    updater: valueFingerprints(key, s.updaterEnv),
    connector: valueFingerprints(key, { TUNNEL_TOKEN: s.tunnelToken }),
    webhook: valueFingerprints(key, { webhook: s.webhookId }).webhook as string,
    repositoryToken: tokens.repositoryToken as string,
    registryToken: tokens.registryToken as string,
  };
}

/**
 * A fake Portainer with the deploy branch (holding the placeholder, R11) and a decoy stack.
 * With `valueKey`, clients fingerprint the values they read.
 */
export function world(options: FakePortainerOptions = {}, valueKey?: Uint8Array) {
  const repoToken = secrets().repositoryToken;
  const decoy: FakeStack = {
    Id: 50,
    Name: "jellyfin",
    Type: 2,
    EndpointId: 3,
    Env: [{ name: "PASSWORD", value: fakeSecret("generic-password", "decoy") }],
    Status: 1,
    DeploymentStatus: [{ Status: 1, Time: 1 }],
    AutoUpdate: null,
    GitConfig: null,
    file: "services:\n  jellyfin:\n    image: jellyfin/jellyfin\n",
    ownerId: 1,
    containers: "running",
    ports: [8096],
    deploys: 1,
  };
  const fake = fakePortainer({
    git: { [BRANCH_KEY]: { commit: "c1", file: PLACEHOLDER, password: repoToken } },
    stacks: [decoy],
    volumes: [
      { EndpointId: 3, Name: "opscrew-shop_db-data", project: "opscrew-shop" },
      { EndpointId: 3, Name: "jellyfin_config", project: "jellyfin" },
    ],
    ...options,
  });
  const client = (role: "admin" | "limited" = "admin") =>
    portainerClient(endpoint, role === "admin" ? fake.tokens.admin : fake.tokens.limited, {
      request: fake.request,
      ...(valueKey !== undefined && { valueKey }),
    });
  const inspect = (role: "admin" | "limited" = "admin") =>
    inspectPortainer(client(role), { environmentId: 3, names: opscrewStackNames("shop") });
  return { fake, client, inspect, decoy };
}
