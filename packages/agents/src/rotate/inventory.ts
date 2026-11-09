/**
 * The credentials of an environment that `opscrew rotate` lists and takes by name (plan.md 1.):
 * what OpsCrew made for it, then the user's own tokens it uses, each with how it rotates, what
 * else changes and its date. Names and dates only: no value is ever read into the result.
 */
import { join } from "node:path";
import { exists } from "@opscrew/core";
import { hasLogin, serviceSpec, tunnelMode, usesTunnel } from "@opscrew/iac-templates";
import {
  type CredentialEntry,
  type DeployPlan,
  monitoringOf,
  type PlanService,
  type SelfHostedServiceKind,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { providerProfile } from "../providers/profiles";
import { copyPath } from "../secrets/files";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { readValidJson } from "../shared/files";
import { declared } from "../vpn/grants";
import { readCredentialsRecord, type UserTokenName } from "./record";
import { tokenFirstSeen, tokenSeenAt } from "./record-tokens";
import type { TokenExpiry } from "./tokens";

/** What a credential is (spec, Key Entities). */
export type CredentialKind =
  | "service"
  | "app-secret"
  | "ssh-key"
  | "wireguard-key"
  | "device-login"
  | "cloudflare-token"
  | "state-passphrase"
  | "add-on"
  | "recovery-key"
  | "user-token";

/**
 * How a credential rotates: `seamless` (old and new valid together, or nothing reads it while it
 * changes), `swap` (new connections the old app opens fail for `seconds`), `restart` (its service
 * restarts, about `seconds`), `logout` (the app's users are logged out or its tokens stop working),
 * `devices` (the user's devices need a new config or password), `replace` (a new one replaces it,
 * the old one stops), `none` (nothing to rotate: `changes` says why).
 */
export type CredentialRotation =
  | { mode: "seamless" }
  | { mode: "swap"; seconds: number }
  | { mode: "restart"; seconds: number }
  | { mode: "logout" }
  | { mode: "devices" }
  | { mode: "replace" }
  | { mode: "none" };

/**
 * A credential's date: last `rotated` or `made` (the record, a device's `addedAt`), else the
 * environment's `first-deploy` (made before the record had it), or a user token's `first-seen`.
 */
export interface CredentialDate {
  at: string;
  source: "rotated" | "made" | "first-deploy" | "first-seen";
}

/** One credential of {@link credentialInventory}. */
export interface Credential {
  /** The name `opscrew rotate` takes: `db`, `app:SECRET_KEY_BASE`, `deploy-key`, `hetzner`. */
  name: string;
  kind: CredentialKind;
  rotation: CredentialRotation;
  /** What else changes, one plain sentence. */
  changes: string;
  /** Absent when unknown. */
  date?: CredentialDate;
}

/** The window of a swap or a restart until the app runs on the new value (plan, Decisions 2). */
const WINDOW_SECONDS = 30;

/**
 * How each kind of service rotates, as research R5 and R10 found (Dragonfly holds two passwords).
 * TODO(T2503): replace with the catalog's `serviceSpec(kind).rotation` (`mode`, `seconds`) once it
 * lands, and remove this map.
 */
const SERVICE_ROTATION: Readonly<Record<SelfHostedServiceKind, "dual" | "swap" | "restart">> = {
  postgres: "swap",
  mysql: "dual",
  mariadb: "swap",
  mongodb: "swap",
  valkey: "dual",
  redis: "dual",
  dragonfly: "dual",
  rabbitmq: "swap",
  nats: "restart",
  kafka: "swap",
  redpanda: "swap",
  // Its S3 key could be held twice, but its RPC secret only changes with a restart.
  garage: "restart",
  opensearch: "swap",
  elasticsearch: "swap",
  meilisearch: "restart",
  typesense: "restart",
  clickhouse: "restart",
  neo4j: "swap",
};

/** A service's credential: all its generated secrets under its plan name. */
function serviceCredential(service: PlanService): Omit<Credential, "date"> {
  const { title } = serviceSpec(service.kind);
  const seconds = WINDOW_SECONDS;
  const base = { name: service.name, kind: "service" as const };
  if (!hasLogin(service)) {
    return {
      ...base,
      rotation: { mode: "none" },
      changes: `Nothing to rotate: the broker has no login (019).`,
    };
  }
  switch (SERVICE_ROTATION[service.kind]) {
    case "dual":
      return {
        ...base,
        rotation: { mode: "seamless" },
        changes: `${title} accepts the old and the new value until the app's rolling deploy, then only the new one.`,
      };
    case "swap":
      return {
        ...base,
        rotation: { mode: "swap", seconds },
        changes: `New connections the running app opens to ${title} fail for about ${seconds} seconds, until its rolling deploy; open connections stay.`,
      };
    case "restart":
      return {
        ...base,
        rotation: { mode: "restart", seconds },
        changes: `${title} restarts with the new value (about ${seconds} seconds), and the app reconnects with it in its rolling deploy.`,
      };
  }
}

/**
 * The app secrets whose framework keeps the previous value beside the new one, so nobody is logged
 * out (research R8), and `CRON_SECRET`, whose both sides change in one deploy.
 */
const SEAMLESS_APP_SECRETS: Readonly<Record<string, string>> = {
  APP_KEY:
    "The old key stays in APP_PREVIOUS_KEYS, so nobody is logged out and encrypted data stays readable.",
  BETTER_AUTH_SECRET:
    "The old secret stays in BETTER_AUTH_SECRETS, so nobody is logged out and encrypted data stays readable.",
  CRON_SECRET: "The app and OpsCrew's cron caller change together in one deploy.",
};

const LOGOUT =
  "Every user of the app is logged out, or the tokens the app issued stop working; you type the app's name to go ahead.";

function appSecretCredentials(names: readonly string[]): Omit<Credential, "date">[] {
  const parts = names.map((name): Omit<Credential, "date"> => {
    const seamless = SEAMLESS_APP_SECRETS[name];
    return {
      name: `app:${name}`,
      kind: "app-secret",
      rotation: seamless === undefined ? { mode: "logout" } : { mode: "seamless" },
      changes: seamless ?? LOGOUT,
    };
  });
  if (parts.length === 0) return [];
  const logout = parts.some((part) => part.rotation.mode === "logout");
  const app: Omit<Credential, "date"> = {
    name: "app",
    kind: "app-secret",
    rotation: logout ? { mode: "logout" } : { mode: "seamless" },
    changes: `Rotates each of the app's generated secrets (${names.join(", ")})${logout ? `. ${LOGOUT}` : "."}`,
  };
  return [app, ...parts];
}

/**
 * The user's own tokens: the variables each is read from (in order, the first named in messages),
 * and when an environment uses it.
 */
export const USER_TOKENS: readonly {
  name: UserTokenName;
  vars: readonly string[];
  uses: (plan: DeployPlan) => boolean;
  /** A token the user may leave unset: listed only when it is set. */
  optional?: true;
}[] = [
  {
    name: "hetzner",
    vars: providerProfile("hetzner").tokenVars,
    uses: (plan) => plan.target.provider === "hetzner",
  },
  {
    name: "digitalocean",
    vars: providerProfile("digitalocean").tokenVars,
    uses: (plan) => plan.target.provider === "digitalocean",
  },
  {
    name: "cloudflare",
    vars: ["CLOUDFLARE_API_TOKEN"],
    uses: (plan) =>
      plan.dns.provider === "cloudflare" ||
      plan.target.provider === "cloudflare-workers" ||
      tunnelTokenUsed(plan),
  },
  { name: "github", vars: ["GITHUB_TOKEN", "GH_TOKEN"], uses: () => true },
  {
    name: "cloudflare-deploy",
    vars: ["OPSCREW_CLOUDFLARE_DEPLOY_TOKEN"],
    uses: (plan) => plan.target.provider === "cloudflare-workers",
  },
  {
    name: "ghcr",
    vars: ["OPSCREW_GHCR_READ_TOKEN"],
    uses: (plan) => plan.target.provider === "portainer" || plan.target.provider === "localhost",
    optional: true,
  },
  {
    name: "ntfy",
    vars: ["OPSCREW_CHECK_NTFY_TOKEN"],
    uses: (plan) =>
      plan.observability?.check?.enabled === true && plan.observability.check.webhook === "ntfy",
    optional: true,
  },
];

const USER_TOKEN_CHANGES =
  "You make the new token and set it here; OpsCrew checks it, replaces every copy it made of it and names the page to delete the old one.";

/** True when the environment has a Cloudflare Tunnel, whose token OpenTofu keeps in the state. */
function tunnelTokenUsed(plan: DeployPlan): boolean {
  return (
    usesTunnel(plan) ||
    (plan.target.provider === "portainer" && plan.target.web.mode === "tunnel") ||
    portainerWebhook(plan)
  );
}

/**
 * True for a Portainer the deploy redeploys through Cloudflare: its webhook behind Access, with a
 * service token and a tunnel of its own.
 */
function portainerWebhook(plan: DeployPlan): boolean {
  return plan.target.provider === "portainer" && plan.target.redeploy === "cloudflare";
}

/**
 * Every credential of the environment of `deps.paths` that it has, by plan 1's names: each
 * service with generated secrets (one that is off only while its values are kept; a broker without
 * its login with nothing to rotate), `app` and each `app:<NAME>` whose generated value this
 * computer keeps (a value the user set is theirs; a preview environment's server makes its own),
 * the SSH keys on this computer (`check-key` with the first app's prod, which holds the
 * repository's one), `network`, each `device:<name>` and `grant:<device>/<service>`, the Access
 * and Tunnel tokens, `state-passphrase` with state encryption, `monitoring`, `portainer` and
 * `beszel` (hub mode) when on, `recovery-key` with a recovery copy; then the user's tokens the
 * environment uses (an optional one only when set). A date comes from the record, else the first
 * deploy; a token's from when this computer first saw it, by its fingerprint. Writes nothing unless
 * `options.recordTokens`, which records a token seen for the first time (then dated now); without
 * it such a token has no date.
 * @throws ArtifactError `ARTIFACT_INVALID` when the record is damaged.
 */
export async function credentialInventory(
  deps: Pick<PhaseDeps, "paths" | "env" | "clock">,
  plan: DeployPlan,
  options: { recordTokens?: boolean } = {},
): Promise<Credential[]> {
  const { paths } = deps;
  const made: Omit<Credential, "date">[] = [];
  /** Dates from the plan itself, by name, for those the record does not have. */
  const madeAt = new Map<string, string>();

  if (plan.environment?.previews === undefined) {
    const generated = (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
    const kept = (service: PlanService) =>
      service.kind === "postgres"
        ? generated.dbPassword !== undefined
        : generated.services?.[service.name] !== undefined;
    for (const service of plan.services) {
      if (serviceSpec(service.kind).secrets.length === 0) continue;
      if (service.enabled || kept(service)) made.push(serviceCredential(service));
    }
    made.push(
      ...appSecretCredentials(
        plan.app.env
          .filter((v) => v.source === "generated" && generated.env?.[v.name] !== undefined)
          .map((v) => v.name),
      ),
    );
  }

  const firstAppProd = paths.app === undefined && paths.environment === "prod";
  const keys = [
    {
      name: "deploy-key",
      file: paths.files.deployKey,
      changes:
        "The new key is added to every server and to GitHub, and the old one removed once a deploy with the new one passed.",
    },
    ...(firstAppProd
      ? [
          {
            name: "check-key",
            file: paths.files.checkKey,
            changes:
              "The scheduled check's new key is added to every server and to GitHub, and the old one removed once a check run with the new one passed.",
          },
        ]
      : []),
    {
      name: "preview-key",
      file: paths.files.previewKey,
      changes:
        "The new key is added to the preview server and to GitHub, and the old one removed once the preview server's check with the new one passed.",
    },
  ];
  for (const key of keys) {
    if (await exists(key.file)) {
      made.push({
        name: key.name,
        kind: "ssh-key",
        rotation: { mode: "seamless" },
        changes: key.changes,
      });
    }
  }

  const network = plan.network;
  if (network !== undefined) {
    const devices = network.devices.map((device) => device.name);
    made.push({
      name: "network",
      kind: "wireguard-key",
      rotation: devices.length > 0 ? { mode: "devices" } : { mode: "seamless" },
      changes:
        devices.length > 0
          ? `Each server gets a new WireGuard key (a new handshake of seconds), and each device a new config to import (${devices.join(", ")}); the old configs work until then.`
          : "Each server gets a new WireGuard key, a new handshake of seconds.",
    });
    for (const device of network.devices) {
      const name = `device:${device.name}`;
      madeAt.set(name, device.addedAt);
      made.push({
        name,
        kind: "wireguard-key",
        rotation: { mode: "devices" },
        changes: `${device.name} gets a new key pair and a new config to import; its old config stops working.`,
      });
    }
    /**
     * True for a Valkey's, Redis's or Dragonfly's logins, which live in the service's settings: they
     * rotate beside the old password until the app's switch; the others' change at once.
     */
    const inSettings = (name: string) => plan.services.some((s) => s.name === name && declared(s));
    for (const grant of network.grants) {
      made.push({
        name: `grant:${grant.device}/${grant.service}`,
        kind: "device-login",
        rotation: { mode: "devices" },
        changes: `${grant.device}'s login to ${grant.service} gets a new password, shown once; the old one stops working ${inSettings(grant.service) ? "after the app's switch to the service's new settings" : "at once"}.`,
      });
    }
  }

  if (tunnelMode(plan) || portainerWebhook(plan)) {
    made.push({
      name: "access-token",
      kind: "cloudflare-token",
      rotation: { mode: "replace" },
      changes:
        "An approved infrastructure plan replaces the Cloudflare Access service token the deploy reaches the server through, and the deploy's GitHub secrets follow.",
    });
  }
  if (tunnelTokenUsed(plan)) {
    made.push({
      name: "tunnel-token",
      kind: "cloudflare-token",
      rotation: { mode: "replace" },
      changes:
        "Cloudflare changes the Tunnel's token in place while its connectors stay connected, then each connector restarts with the new one (seconds); runs only in a terminal.",
    });
  }
  if (plan.infra.stateEncryption && (await exists(paths.files.statePassphrase))) {
    made.push({
      name: "state-passphrase",
      kind: "state-passphrase",
      rotation: { mode: "seamless" },
      changes:
        "One approved apply rewrites the infrastructure state under the new passphrase; nothing in the cloud changes.",
    });
  }
  const monitoring = monitoringOf(plan);
  const postgres = plan.services.some((s) => s.kind === "postgres" && s.enabled);
  // An environment that sends to another's stack has only the monitoring's login to its Postgres.
  if (monitoring !== undefined && (monitoring.where.kind !== "shared" || postgres)) {
    made.push({
      name: "monitoring",
      kind: "add-on",
      rotation: { mode: "seamless" },
      changes:
        monitoring.where.kind === "shared"
          ? "The monitoring's login to PostgreSQL changes; Grafana's password belongs to the environment that runs the monitoring."
          : postgres
            ? "Grafana's admin password and the monitoring's login to PostgreSQL change; you sign in to Grafana with the new password."
            : "Grafana's admin password changes; you sign in to Grafana with the new one.",
    });
  }
  if (plan.portainer?.enabled === true) {
    made.push({
      name: "portainer",
      kind: "add-on",
      rotation: { mode: "seamless" },
      changes: "Portainer's admin password changes; you sign in to Portainer with the new one.",
    });
  }
  const beszel = plan.observability?.beszel;
  if (beszel?.enabled === true && beszel.mode === "hub") {
    made.push({
      name: "beszel",
      kind: "add-on",
      rotation: { mode: "restart", seconds: WINDOW_SECONDS },
      changes:
        "Beszel's dashboard password and its agent's token and key change; the hub and the agent restart with them.",
    });
  }
  if (await exists(join(paths.root, copyPath(paths)))) {
    made.push({
      name: "recovery-key",
      kind: "recovery-key",
      rotation: { mode: "seamless" },
      changes:
        "The recovery copy is encrypted to a new key in a pull request; keep the new key where you keep the old one.",
    });
  }

  const record = (await readCredentialsRecord(deps)).environments[paths.environment] ?? {};
  const firstDeployAt = plan.deployment.firstDeployAt;
  const dated = made.map((credential): Credential => {
    if (credential.rotation.mode === "none") return credential;
    const date =
      credential.name === "app"
        ? oldest(made.filter((c) => c.name.startsWith("app:")).map((c) => dateOf(c.name)))
        : dateOf(credential.name);
    return date === undefined ? credential : { ...credential, date };
  });
  function dateOf(name: string): CredentialDate | undefined {
    return (
      entryDate(record[name]) ??
      fromPlan(madeAt.get(name), "made") ??
      fromPlan(firstDeployAt, "first-deploy")
    );
  }

  const tokens: Credential[] = [];
  for (const token of USER_TOKENS) {
    if (!token.uses(plan)) continue;
    const value = token.vars.map((name) => deps.env[name]?.trim()).find((v) => v);
    if (value === undefined && token.optional) continue;
    const seen =
      value === undefined
        ? undefined
        : options.recordTokens === true
          ? await tokenFirstSeen(deps, token.name, value)
          : await tokenSeenAt(deps, token.name, value);
    tokens.push({
      name: token.name,
      kind: "user-token",
      rotation: { mode: "replace" },
      changes: USER_TOKEN_CHANGES,
      ...(seen === undefined ? {} : { date: { at: seen, source: "first-seen" } }),
    });
  }
  return [...dated, ...tokens];
}

function entryDate(entry: CredentialEntry | undefined): CredentialDate | undefined {
  if (entry?.rotatedAt !== undefined) return { at: entry.rotatedAt, source: "rotated" };
  if (entry?.madeAt !== undefined) return { at: entry.madeAt, source: "made" };
  return undefined;
}

function fromPlan(
  at: string | undefined,
  source: CredentialDate["source"],
): CredentialDate | undefined {
  return at === undefined ? undefined : { at, source };
}

/** The oldest of `dates`; unknown when any is. */
function oldest(dates: readonly (CredentialDate | undefined)[]): CredentialDate | undefined {
  if (dates.length === 0 || dates.some((date) => date === undefined)) return undefined;
  return (dates as CredentialDate[]).reduce((first, date) =>
    Date.parse(date.at) < Date.parse(first.at) ? date : first,
  );
}

/** A credential as `opscrew rotate` lists it: a user's token with what its provider says. */
export type ListedCredential = Credential & Partial<Omit<TokenExpiry, "name" | "firstSeen">>;

/** The credentials of `inventory`, each user token with its expiry from `expiries`. */
export function listedCredentials(
  inventory: readonly Credential[],
  expiries: readonly TokenExpiry[],
): ListedCredential[] {
  return inventory.map((credential) => {
    const expiry = expiries.find((token) => token.name === credential.name);
    if (expiry === undefined) return credential;
    const { name: _name, firstSeen: _seen, ...rest } = expiry;
    return { ...credential, ...rest };
  });
}

const DAY_MS = 86_400_000;

/** `2026-10-01, 39 days ago` (or `in 3 days` for a date to come). */
function dayText(at: string, now: Date): string {
  const days = Math.round((Date.parse(at) - now.getTime()) / DAY_MS);
  const when =
    days === 0
      ? "today"
      : days > 0
        ? `in ${days} day${days === 1 ? "" : "s"}`
        : `${-days} day${days === -1 ? "" : "s"} ago`;
  return `${at.slice(0, 10)}, ${when}`;
}

/** How a credential rotates, in words. */
function rotationText(rotation: CredentialRotation): string {
  switch (rotation.mode) {
    case "seamless":
      return "seamless: the old and the new value work together while it changes";
    case "swap":
      return `a short swap: new connections fail for up to ${rotation.seconds} seconds`;
    case "restart":
      return `a restart of the service, about ${rotation.seconds} seconds`;
    case "logout":
      return "the app's users are logged out, or its issued tokens stop working";
    case "devices":
      return "your devices need their new configuration";
    case "replace":
      return "you make the new one";
    case "none":
      return "nothing to rotate";
  }
}

/** When a credential was made or last rotated, in words. */
function dateText(date: CredentialDate | undefined, now: Date): string {
  if (date === undefined) return "date unknown";
  const day = dayText(date.at, now);
  switch (date.source) {
    case "rotated":
      return `rotated ${day}`;
    case "made":
      return `made ${day}`;
    case "first-deploy":
      return `since the first deploy, ${day}`;
    case "first-seen":
      return `first seen on this computer ${day}`;
  }
}

/** What a user's token's provider says of its expiry, in words; empty when it says nothing. */
function expiryText(credential: ListedCredential, now: Date): string {
  if (credential.expiresAt !== undefined) {
    const past = Date.parse(credential.expiresAt) <= now.getTime();
    return `; ${past ? "expired" : "expires"} ${dayText(credential.expiresAt, now)}`;
  }
  if (credential.notRead !== undefined) {
    return `; its expiry could not be read: ${credential.notRead.replace(/\.$/, "")}`;
  }
  return "";
}

/**
 * `opscrew rotate`'s listing (and `opscrew_credentials`'s) of `credentials` of `app` in `environment`: what OpsCrew made, each
 * by the name the command takes with how it rotates, its date and what else changes; then the
 * user's own tokens with their expiry where the provider gives it. `where.opscrew` is how its
 * commands start: `opscrew`, or `npx opscrew` for Claude Code.
 */
export function credentialListLines(
  credentials: readonly ListedCredential[],
  where: { app: string; environment: string; flag: string; opscrew: string },
  now: Date,
): string[] {
  const made = credentials.filter((c) => c.kind !== "user-token");
  const tokens = credentials.filter((c) => c.kind === "user-token");
  const lines =
    made.length === 0
      ? [
          `OpsCrew has made no credentials for ${where.app} in ${where.environment} yet: \`${where.opscrew} provision${where.flag}\` makes them.`,
        ]
      : [
          `The credentials OpsCrew made for ${where.app} in ${where.environment} (\`${where.opscrew} rotate <name>${where.flag}\` rotates one):`,
          ...made.flatMap((c) =>
            c.rotation.mode === "none"
              ? [`- ${c.name}: ${rotationText(c.rotation)}. ${c.changes}`]
              : [
                  `- ${c.name}: ${rotationText(c.rotation)}; ${dateText(c.date, now)}.`,
                  `  ${c.changes}`,
                ],
          ),
        ];
  if (tokens.length === 0) return lines;
  return [
    ...lines,
    "",
    `Your own tokens (make the new one at its provider, set it, then \`${where.opscrew} rotate <name>${where.flag}\`):`,
    ...tokens.map(
      (c) =>
        `- ${c.name}${c.variable === undefined ? "" : ` (${c.variable})`}: ${dateText(c.date, now)}${expiryText(c, now)}.`,
    ),
  ];
}
