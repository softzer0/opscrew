// Feature 025 (T2505): every credential an environment has, how it rotates and its date.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  type SelfHostedServiceKind,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { BESZEL_VERSION } from "../addons/settings";
import type { PhaseDeps } from "../context";
import { MONITORING_VERSIONS } from "../monitoring/settings";
import { PORTAINER_VERSION } from "../portainer/settings";
import { copyPath } from "../secrets/files";
import { generatedValuesFile } from "../shared/app-secrets";
import {
  createTestPhaseDeps,
  ownPlan,
  portainerPlan,
  previewTestPlan,
  sitePlan,
  testPlan,
  withLaptop,
} from "../testing";
import {
  type Credential,
  credentialInventory,
  credentialListLines,
  listedCredentials,
} from "./inventory";
import { credentialsRecordFile } from "./record";
import { tokenDatesFile } from "./record-tokens";

const FIRST_DEPLOY = "2026-10-11T11:30:00.000Z";

function service(name: string, kind: SelfHostedServiceKind, more: object = {}) {
  return {
    name,
    kind,
    version: serviceSpec(kind).defaultVersion,
    memoryMb: 512,
    enabled: true,
    reason: "The app uses it.",
    licence: serviceSpec(kind).licence.id,
    ...more,
  };
}

function withFirstDeploy(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    deployment: { ...plan.deployment, firstDeployAt: FIRST_DEPLOY },
  });
}

async function put(file: string, text = "x\n"): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** This computer's generated values with the app secrets `env` (values made up for the test). */
async function keepAppSecrets(deps: Pick<PhaseDeps, "paths">, env: string[], more = {}) {
  const values = Object.fromEntries(
    env.map((name) => [name, fakeSecret("generic-password", name)]),
  );
  await put(generatedValuesFile(deps), JSON.stringify({ env: values, ...more }));
}

const names = (list: Credential[]) => list.map((c) => c.name);
const byName = (list: Credential[], name: string) => list.find((c) => c.name === name);

describe("credentialInventory", () => {
  it("lists a cloud environment's database, app secret, deploy key and tokens, dated from the first deploy", async () => {
    const hetzner = fakeSecret("hcloud-token");
    const deps = await createTestPhaseDeps();
    deps.env.HCLOUD_TOKEN = hetzner;
    await put(deps.paths.files.deployKey);
    await keepAppSecrets(deps, ["SESSION_SECRET"]);
    const plan = withFirstDeploy(testPlan({ deployed: true }));
    const list = await credentialInventory(deps, plan, { recordTokens: true });
    expect(list).toEqual([
      {
        name: "db",
        kind: "service",
        rotation: { mode: "swap", seconds: 30 },
        changes:
          "New connections the running app opens to PostgreSQL fail for about 30 seconds, until its rolling deploy; open connections stay.",
        date: { at: FIRST_DEPLOY, source: "first-deploy" },
      },
      {
        name: "app",
        kind: "app-secret",
        rotation: { mode: "logout" },
        changes:
          "Rotates each of the app's generated secrets (SESSION_SECRET). Every user of the app is logged out, or the tokens the app issued stop working; you type the app's name to go ahead.",
        date: { at: FIRST_DEPLOY, source: "first-deploy" },
      },
      {
        name: "app:SESSION_SECRET",
        kind: "app-secret",
        rotation: { mode: "logout" },
        changes:
          "Every user of the app is logged out, or the tokens the app issued stop working; you type the app's name to go ahead.",
        date: { at: FIRST_DEPLOY, source: "first-deploy" },
      },
      {
        name: "deploy-key",
        kind: "ssh-key",
        rotation: { mode: "seamless" },
        changes:
          "The new key is added to every server and to GitHub, and the old one removed once a deploy with the new one passed.",
        date: { at: FIRST_DEPLOY, source: "first-deploy" },
      },
      {
        name: "hetzner",
        kind: "user-token",
        rotation: { mode: "replace" },
        changes:
          "You make the new token and set it here; OpsCrew checks it, replaces every copy it made of it and names the page to delete the old one.",
        date: { at: deps.clock.now().toISOString(), source: "first-seen" },
      },
      // Through the GitHub CLI's login no value is read, so no date.
      {
        name: "github",
        kind: "user-token",
        rotation: { mode: "replace" },
        changes:
          "You make the new token and set it here; OpsCrew checks it, replaces every copy it made of it and names the page to delete the old one.",
      },
    ]);
    const dates = await readFile(tokenDatesFile(deps.paths), "utf8");
    expect(dates).not.toContain(hetzner);
    expect(JSON.stringify(list)).not.toContain(hetzner);
  });

  it("writes nothing by default: a token never seen has no date, one seen keeps its own", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan();
    deps.env.HCLOUD_TOKEN = fakeSecret("hcloud-token");
    expect(byName(await credentialInventory(deps, plan), "hetzner")?.date).toBeUndefined();
    await expect(readFile(tokenDatesFile(deps.paths), "utf8")).rejects.toThrow();

    await credentialInventory(deps, plan, { recordTokens: true });
    const later = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      clock: { now: () => new Date("2027-01-01T00:00:00.000Z") },
    });
    expect(byName(await credentialInventory(later, plan), "hetzner")?.date).toEqual({
      at: deps.clock.now().toISOString(),
      source: "first-seen",
    });
  });

  it("leaves out an app secret the user set in their production env file: it is theirs", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        env: [...base.app.env, { name: "CRON_SECRET", secret: true, source: "generated" }],
      },
    });
    // SESSION_SECRET came from the user's file, so provision kept no generated value of it.
    await keepAppSecrets(deps, ["CRON_SECRET"]);
    const list = await credentialInventory(deps, plan);
    expect(list.filter((c) => c.kind === "app-secret").map((c) => c.name)).toEqual([
      "app",
      "app:CRON_SECRET",
    ]);
    await keepAppSecrets(deps, []);
    expect(names(await credentialInventory(deps, plan))).not.toContain("app");
  });

  it("gives each kind of service its mode, says a broker without login has nothing, skips one off without values", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [
        ...base.services,
        service("orders", "mysql"),
        service("cache", "valkey", { options: { mode: "cache" } }),
        service("queue", "dragonfly", { options: { mode: "queue" } }),
        service("events", "clickhouse"),
        service("garage", "garage"),
        service("stream", "kafka"),
        service("bus", "redpanda", { options: { login: true } }),
        service("old", "mariadb", { enabled: false }),
        service("gone", "meilisearch", { enabled: false }),
      ],
    });
    await put(
      generatedValuesFile(deps),
      JSON.stringify({ services: { old: { password: fakeSecret("generic-password") } } }),
    );
    const list = await credentialInventory(deps, plan);
    const services = list.filter((c) => c.kind === "service");
    expect(services.map((c) => [c.name, c.rotation])).toEqual([
      ["db", { mode: "swap", seconds: 30 }],
      ["orders", { mode: "seamless" }],
      ["cache", { mode: "seamless" }],
      ["queue", { mode: "seamless" }],
      ["events", { mode: "restart", seconds: 30 }],
      ["garage", { mode: "restart", seconds: 30 }],
      ["stream", { mode: "none" }],
      ["bus", { mode: "swap", seconds: 30 }],
      ["old", { mode: "swap", seconds: 30 }],
    ]);
    expect(byName(list, "orders")?.changes).toBe(
      "MySQL accepts the old and the new value until the app's rolling deploy, then only the new one.",
    );
    expect(byName(list, "events")?.changes).toBe(
      "ClickHouse restarts with the new value (about 30 seconds), and the app reconnects with it in its rolling deploy.",
    );
    expect(byName(list, "stream")?.changes).toBe(
      "Nothing to rotate: the broker has no login (019).",
    );
    // Never deployed: no date.
    expect(byName(list, "db")?.date).toBeUndefined();
  });

  it("keeps Laravel's and Better Auth's previous keys and CRON_SECRET seamless; one other logs users out", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan();
    const env = (names: string[]) =>
      DeployPlanSchema.parse({
        ...base,
        app: {
          ...base.app,
          env: [
            ...names.map((name) => ({ name, secret: true, source: "generated" })),
            { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
          ],
        },
      });
    await keepAppSecrets(deps, ["APP_KEY", "BETTER_AUTH_SECRET", "CRON_SECRET", "SECRET_KEY"]);
    const seamless = await credentialInventory(
      deps,
      env(["APP_KEY", "BETTER_AUTH_SECRET", "CRON_SECRET"]),
    );
    const apps = seamless.filter((c) => c.kind === "app-secret");
    expect(apps.map((c) => [c.name, c.rotation.mode])).toEqual([
      ["app", "seamless"],
      ["app:APP_KEY", "seamless"],
      ["app:BETTER_AUTH_SECRET", "seamless"],
      ["app:CRON_SECRET", "seamless"],
    ]);
    expect(byName(apps, "app:APP_KEY")?.changes).toContain("APP_PREVIOUS_KEYS");
    expect(byName(apps, "app:BETTER_AUTH_SECRET")?.changes).toContain("BETTER_AUTH_SECRETS");
    expect(byName(apps, "app")?.changes).toBe(
      "Rotates each of the app's generated secrets (APP_KEY, BETTER_AUTH_SECRET, CRON_SECRET).",
    );
    const mixed = await credentialInventory(deps, env(["SECRET_KEY", "CRON_SECRET"]));
    expect(byName(mixed, "app")?.rotation).toEqual({ mode: "logout" });
    expect(byName(mixed, "app:SECRET_KEY")?.rotation).toEqual({ mode: "logout" });
    expect(names(mixed)).not.toContain("app:STRIPE_SECRET_KEY");

    const none = await credentialInventory(deps, env([]));
    expect(none.filter((c) => c.kind === "app-secret")).toEqual([]);
  });

  it("lists the network, each device (dated when added) and each grant", async () => {
    const deps = await createTestPhaseDeps();
    const base = withLaptop(withFirstDeploy(testPlan({ deployed: true })));
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [...base.services, service("cache", "valkey", { options: { mode: "cache" } })],
      network: {
        ...base.network,
        grants: [{ device: "laptop", service: "cache", access: "read-only" }],
      },
    });
    const list = await credentialInventory(deps, plan);
    expect(list.filter((c) => c.kind === "wireguard-key" || c.kind === "device-login")).toEqual([
      {
        name: "network",
        kind: "wireguard-key",
        rotation: { mode: "devices" },
        changes:
          "Each server gets a new WireGuard key (a new handshake of seconds), and each device a new config to import (laptop); the old configs work until then.",
        date: { at: FIRST_DEPLOY, source: "first-deploy" },
      },
      {
        name: "device:laptop",
        kind: "wireguard-key",
        rotation: { mode: "devices" },
        changes:
          "laptop gets a new key pair and a new config to import; its old config stops working.",
        date: { at: "2026-10-30T10:00:00.000Z", source: "made" },
      },
      {
        name: "grant:laptop/cache",
        kind: "device-login",
        rotation: { mode: "devices" },
        changes:
          "laptop's login to cache gets a new password, shown once; the old one stops working after the app's switch to the service's new settings.",
        date: { at: FIRST_DEPLOY, source: "first-deploy" },
      },
    ]);
    const alone = await credentialInventory(deps, testPlan());
    expect(names(alone)).not.toContain("network");
  });

  it("lists the Access and Tunnel tokens of a server behind the tunnel, and the Cloudflare token", async () => {
    const deps = await createTestPhaseDeps();
    const tunnelled = await credentialInventory(deps, ownPlan({ access: "tunnel" }));
    expect(byName(tunnelled, "access-token")).toMatchObject({
      kind: "cloudflare-token",
      rotation: { mode: "replace" },
    });
    expect(byName(tunnelled, "tunnel-token")).toMatchObject({ rotation: { mode: "replace" } });
    expect(names(tunnelled)).toContain("cloudflare");
    expect(names(tunnelled)).not.toContain("hetzner");

    const direct = await credentialInventory(deps, ownPlan({ access: "public" }));
    expect(names(direct)).not.toContain("access-token");
    expect(names(direct)).not.toContain("tunnel-token");

    // Portainer behind the tunnel: its token, but no SSH through Access.
    const portainer = await credentialInventory(deps, portainerPlan());
    expect(names(portainer)).toContain("tunnel-token");
    expect(names(portainer)).not.toContain("access-token");
    expect(names(portainer)).not.toContain("ghcr");
    deps.env.OPSCREW_GHCR_READ_TOKEN = fakeSecret("github-pat");
    expect(names(await credentialInventory(deps, portainerPlan()))).toContain("ghcr");

    // Redeployed through Cloudflare: the webhook behind Access has a service token and a tunnel.
    const webhook = await credentialInventory(
      deps,
      portainerPlan({ redeploy: "cloudflare", web: { mode: "caddy" } }),
    );
    expect(names(webhook)).toContain("access-token");
    expect(names(webhook)).toContain("tunnel-token");
    const updater = await credentialInventory(deps, portainerPlan({ web: { mode: "caddy" } }));
    expect(names(updater)).not.toContain("access-token");
    expect(names(updater)).not.toContain("tunnel-token");
  });

  it("lists the state passphrase with its file and encryption on, and the add-ons that are on", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan({ domain: "shop.example.com", deployed: true });
    expect(names(await credentialInventory(deps, base))).not.toContain("state-passphrase");
    await put(deps.paths.files.statePassphrase);
    expect(byName(await credentialInventory(deps, base), "state-passphrase")).toMatchObject({
      kind: "state-passphrase",
      rotation: { mode: "seamless" },
    });
    const unencrypted = DeployPlanSchema.parse({
      ...base,
      infra: { ...base.infra, stateEncryption: false },
    });
    expect(names(await credentialInventory(deps, unencrypted))).not.toContain("state-passphrase");

    const addons = DeployPlanSchema.parse({
      ...base,
      portainer: { enabled: true, version: PORTAINER_VERSION, access: "local" },
      observability: {
        beszel: { enabled: true, version: BESZEL_VERSION },
        monitoring: {
          enabled: true,
          where: { kind: "app" },
          versions: MONITORING_VERSIONS,
          retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 10 },
        },
      },
    });
    const list = await credentialInventory(deps, addons);
    expect(list.filter((c) => c.kind === "add-on").map((c) => [c.name, c.rotation])).toEqual([
      ["monitoring", { mode: "seamless" }],
      ["portainer", { mode: "seamless" }],
      ["beszel", { mode: "restart", seconds: 30 }],
    ]);
    expect(byName(list, "monitoring")?.changes).toBe(
      "Grafana's admin password and the monitoring's login to PostgreSQL change; you sign in to Grafana with the new password.",
    );
    const monitoring = addons.observability?.monitoring;
    if (monitoring === undefined) throw new Error("no monitoring");
    const withoutDb = DeployPlanSchema.parse({
      ...addons,
      services: [],
      app: { ...addons.app, env: [] },
    });
    expect(byName(await credentialInventory(deps, withoutDb), "monitoring")?.changes).toBe(
      "Grafana's admin password changes; you sign in to Grafana with the new one.",
    );

    // Sending to another environment's stack: only the monitoring's login to this Postgres.
    const shared = (plan: DeployPlan): DeployPlan => ({
      ...plan,
      observability: {
        monitoring: {
          ...monitoring,
          where: { kind: "shared", owner: { plan: "opscrew/plan.yaml", server: "monitoring" } },
        },
      },
    });
    expect(byName(await credentialInventory(deps, shared(addons)), "monitoring")).toEqual({
      name: "monitoring",
      kind: "add-on",
      rotation: { mode: "seamless" },
      changes:
        "The monitoring's login to PostgreSQL changes; Grafana's password belongs to the environment that runs the monitoring.",
    });
    expect(names(await credentialInventory(deps, shared(withoutDb)))).not.toContain("monitoring");
    const agent = DeployPlanSchema.parse({
      ...base,
      observability: {
        beszel: {
          enabled: true,
          version: BESZEL_VERSION,
          mode: "agent",
          hubUrl: "https://beszel.example.net",
          hubKey: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`,
        },
      },
    });
    expect(names(await credentialInventory(deps, agent))).not.toContain("beszel");
  });

  it("lists the recovery key with a recovery copy, and the check key only at the first app's prod", async () => {
    const deps = await createTestPhaseDeps();
    await put(join(deps.paths.root, copyPath(deps.paths)), "{}\n");
    await put(deps.paths.files.checkKey);
    const list = await credentialInventory(deps, testPlan());
    expect(byName(list, "recovery-key")).toMatchObject({ kind: "recovery-key" });
    expect(byName(list, "check-key")).toMatchObject({
      kind: "ssh-key",
      rotation: { mode: "seamless" },
    });

    const staging = await createTestPhaseDeps({
      root: deps.paths.root,
      env: deps.env,
      environment: "staging",
    });
    expect(staging.paths.files.checkKey).not.toBe(deps.paths.files.checkKey);
    const other = await credentialInventory(staging, testPlan());
    expect(names(other)).not.toContain("check-key");
    expect(names(other)).not.toContain("recovery-key");
  });

  it("lists only the keys of a preview environment, whose server makes its own values", async () => {
    const deps = await createTestPhaseDeps({ environment: "preview" });
    await put(deps.paths.files.deployKey);
    await put(deps.paths.files.previewKey);
    await keepAppSecrets(deps, ["SESSION_SECRET"], { dbPassword: fakeSecret("generic-password") });
    const list = await credentialInventory(deps, previewTestPlan());
    expect(list.filter((c) => c.kind !== "user-token").map((c) => c.name)).toEqual([
      "deploy-key",
      "preview-key",
    ]);
  });

  it("dates from the record: the last rotation, else when it was made; `app` by its oldest secret", async () => {
    const deps = await createTestPhaseDeps();
    await put(deps.paths.files.deployKey);
    await writeArtifact("credentials", credentialsRecordFile(deps.paths), {
      schemaVersion: 1,
      environments: {
        prod: {
          db: {
            madeAt: "2026-01-01T00:00:00.000Z",
            rotatedAt: "2026-06-01T00:00:00.000Z",
            generation: 2,
          },
          "deploy-key": { madeAt: "2026-02-01T00:00:00.000Z", generation: 1 },
          "app:SESSION_SECRET": { rotatedAt: "2026-07-01T00:00:00.000Z", generation: 2 },
        },
        staging: { "app:CRON_SECRET": { rotatedAt: "2026-08-01T00:00:00.000Z", generation: 2 } },
      },
    });
    const base = withFirstDeploy(testPlan({ deployed: true }));
    const plan = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        env: [...base.app.env, { name: "CRON_SECRET", secret: true, source: "generated" }],
      },
    });
    await keepAppSecrets(deps, ["SESSION_SECRET", "CRON_SECRET"]);
    const list = await credentialInventory(deps, plan);
    expect(byName(list, "db")?.date).toEqual({ at: "2026-06-01T00:00:00.000Z", source: "rotated" });
    expect(byName(list, "deploy-key")?.date).toEqual({
      at: "2026-02-01T00:00:00.000Z",
      source: "made",
    });
    expect(byName(list, "app:SESSION_SECRET")?.date).toEqual({
      at: "2026-07-01T00:00:00.000Z",
      source: "rotated",
    });
    // Staging's entry is not prod's.
    expect(byName(list, "app:CRON_SECRET")?.date).toEqual({
      at: FIRST_DEPLOY,
      source: "first-deploy",
    });
    expect(byName(list, "app")?.date).toEqual({
      at: "2026-07-01T00:00:00.000Z",
      source: "rotated",
    });

    // Without a first deploy, a secret the record lacks has no date, so neither has `app`.
    const undeployed = await credentialInventory(deps, { ...plan, deployment: {} });
    expect(byName(undeployed, "app:CRON_SECRET")?.date).toBeUndefined();
    expect(byName(undeployed, "app")?.date).toBeUndefined();
  });

  it("lists the tokens a Cloudflare-hosted site and the check's ntfy alerts use", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan({ deployed: true });
    const checked = DeployPlanSchema.parse({
      ...base,
      observability: { check: { enabled: true, webhook: "ntfy" } },
    });
    expect(names(await credentialInventory(deps, checked))).not.toContain("ntfy");
    deps.env.OPSCREW_CHECK_NTFY_TOKEN = fakeSecret("generic-password", "ntfy");
    expect(names(await credentialInventory(deps, checked))).toContain("ntfy");
    expect(names(await credentialInventory(deps, base))).not.toContain("ntfy");
    expect(
      names(await credentialInventory(deps, testPlan({ provider: "digitalocean" }))),
    ).toContain("digitalocean");
    const site = await credentialInventory(deps, sitePlan());
    expect(site.filter((c) => c.kind === "user-token").map((c) => c.name)).toEqual([
      "cloudflare",
      "github",
      "cloudflare-deploy",
    ]);
  });
});

describe("credentialListLines", () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  const credentials = listedCredentials(
    [
      {
        name: "db",
        kind: "service",
        rotation: { mode: "swap", seconds: 30 },
        changes: "New connections fail for about 30 seconds.",
        date: { at: "2026-11-01T09:00:00.000Z", source: "rotated" },
      },
      { name: "kafka", kind: "service", rotation: { mode: "none" }, changes: "No login." },
      {
        name: "github",
        kind: "user-token",
        rotation: { mode: "replace" },
        changes: "You make the new token.",
        date: { at: "2026-10-01T09:00:00.000Z", source: "first-seen" },
      },
    ],
    [{ name: "github", variable: "GITHUB_TOKEN", expiresAt: "2026-11-30T00:00:00.000Z" }],
  );

  it("names each credential with how it rotates, its date and age, then the user's tokens", () => {
    const where = { app: "shop", environment: "staging", flag: " --env staging" };
    expect(credentialListLines(credentials, { ...where, opscrew: "npx opscrew" }, now)).toEqual([
      "The credentials OpsCrew made for shop in staging (`npx opscrew rotate <name> --env staging` rotates one):",
      "- db: a short swap: new connections fail for up to 30 seconds; rotated 2026-11-01, 8 days ago.",
      "  New connections fail for about 30 seconds.",
      "- kafka: nothing to rotate. No login.",
      "",
      "Your own tokens (make the new one at its provider, set it, then `npx opscrew rotate <name> --env staging`):",
      "- github (GITHUB_TOKEN): first seen on this computer 2026-10-01, 39 days ago; expires 2026-11-30, in 21 days.",
    ]);
  });
});
