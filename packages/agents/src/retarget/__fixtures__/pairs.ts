import { writeFile } from "node:fs/promises";
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  type Retarget,
  writeArtifact,
  isCloudProvider,
} from "@opscrew/plan-schema";
import {
  type OwnServerConnectionInput,
  recordOwnServer,
  recordPortainerConnection,
  type ServerAddress,
  updateServerAddresses,
} from "../../shared";
import {
  ED25519,
  ED25519_FINGERPRINT,
  FakeHostServer,
  type MoveSideKind,
  moveHarness,
  NEW_SERVERS,
  OLD_IDS,
  OLD_IPV4,
  OLD_IPV6,
  ownRunner,
  PORTAINER_CERT,
  PORTAINER_TOKEN,
  PORTAINER_URL,
  portainerServices,
  preparedServerFacts,
  ScriptedRunner,
  targetOf,
} from "../../testing";
import { openSession } from "../session";
import { cloudProviders } from "../sides";

/** The Postgres password the app's generated values hold (synthetic). */
export const DB_PASSWORD = fakeSecret("generic-password", "move db password");
/** Where the new side is: a server's address, or the Portainer host's public one. */
export const NEW_IPV4 = "198.51.100.30";
export const NEW_IPV6 = "2001:db8:30::1";
/** The Docker fake's host name for the user's Portainer environment. */
export const PORTAINER = "portainer";

export interface PairOptions {
  step?: Retarget["step"];
  dns?: "cloudflare" | "none";
  /** The own server's SSH login port (default 22). */
  ownPort?: number;
  /** A Valkey cache beside Postgres, whose files the old side holds. */
  cache?: boolean;
  /** A Portainer old side's DNS records are still the user's (its `web.records` not true). */
  userRecords?: boolean;
  /** The app has a release command (`app.releaseCommand`), which the window runs on the new side. */
  release?: boolean;
}

/**
 * A move from `from` to `to`, recorded at `step` (default `deployed`) with an opened session,
 * over the move harness's fakes: the servers' shells and Docker APIs (the old side's database
 * holds the marker `orders before the move`, its services' data their files), the user's own
 * server's logins and host adapter, and the user's Portainer, whose Docker proxy reaches the
 * `portainer` Docker fake. Each side's app is deployed and healthy; the new side's edge stopped.
 */
export async function pairHarness(from: MoveSideKind, to: MoveSideKind, options: PairOptions = {}) {
  const h = await moveHarness({ dns: options.dns ?? "cloudflare" });
  const fromTarget = targetOf(from, options.userRecords !== true);
  const toTarget = targetOf(to);
  const base = h.plan;
  const cache = {
    kind: "valkey",
    version: "8",
    memoryMb: 128,
    options: { mode: "cache" },
    reason: "ioredis",
    licence: "BSD-3-Clause",
  };
  if (options.cache === true) h.hosts.services = ["db", "cache"];
  h.hosts.release = options.release === true;
  const plan = DeployPlanSchema.parse({
    ...base,
    services: options.cache === true ? [...base.services, cache] : base.services,
    app:
      options.release === true
        ? { ...base.app, releaseCommand: "python manage.py migrate --noinput" }
        : base.app,
    target: toTarget,
    dns: { ...base.dns, proxied: false },
    retarget: {
      from: { target: fromTarget, deploy: base.deploy },
      step: options.step ?? "deployed",
      startedAt: "2026-11-06T12:00:00.000Z",
    },
  });
  await writeArtifact("plan", h.paths.files.plan, plan);

  // The infrastructure state at `step`: a cloud old side's server (renamed from the start's
  // `server` on), a cloud new side's once created, and DNS at the old side.
  const step = plan.retarget?.step ?? "deployed";
  const servers: typeof h.engine.state.servers = {};
  if (isCloudProvider(from)) {
    servers[step === "started" ? "server" : "server_previous"] = {
      id: OLD_IDS[from],
      provider: from,
      ipv4: OLD_IPV4,
      ipv6: OLD_IPV6,
      protected: from === "hetzner",
    };
  }
  if (isCloudProvider(to) && !["started", "renamed"].includes(step)) {
    servers.server = {
      id: NEW_SERVERS[to].id,
      provider: to,
      ipv4: NEW_IPV4,
      ipv6: NEW_IPV6,
      protected: to === "hetzner",
    };
  }
  h.engine.state.servers = servers;
  if (h.engine.state.dns !== undefined) {
    h.engine.state.dns = isCloudProvider(from) ? OLD_IDS[from] : OLD_IPV4;
  }

  // Each side's address and logins in OpsCrew's local state.
  const oldAddress: ServerAddress = { ipv4: OLD_IPV4, ipv6: OLD_IPV6 };
  const newAddress: ServerAddress = { ipv4: NEW_IPV4, ipv6: NEW_IPV6 };
  const login = (host: string): OwnServerConnectionInput => ({
    host,
    port: options.ownPort ?? 22,
    user: "root",
    agent: true,
    reachable: true,
    serve: "dns-only",
    hostKey: ED25519_FINGERPRINT,
  });
  const portainerConnection = {
    url: PORTAINER_URL,
    certFingerprint: PORTAINER_CERT.fingerprint,
    environmentId: 3,
    environmentName: "local",
    arch: "amd64" as const,
    redeploy: "updater" as const,
    web: { mode: "caddy" as const, records: true },
    created: { stacks: [{ id: 7, name: "opscrew-shop", role: "app" as const }], volumes: [] },
  };
  await updateServerAddresses(h.paths, (current) => ({
    ...current,
    retarget: {
      from: oldAddress,
      next: newAddress,
      ...(from === "own" ? { fromOwn: login(OLD_IPV4) } : {}),
      ...(from === "portainer" ? { fromPortainer: portainerConnection } : {}),
    },
  }));
  if (to === "own") await recordOwnServer(h.paths, login(NEW_IPV4));
  if (to === "portainer") await recordPortainerConnection(h.paths, portainerConnection);
  // The own servers' host keys, pinned under their logins.
  const port = options.ownPort ?? 22;
  const pinned = (host: string) => (port === 22 ? host : `[${host}]:${port}`);
  await writeFile(
    h.paths.files.knownHosts,
    [
      `${OLD_IPV4} ssh-ed25519 ${ED25519}`,
      `${pinned(NEW_IPV4)} ssh-ed25519 ${ED25519}`,
      `${NEW_IPV4} ssh-ed25519 ${ED25519}`,
      "",
    ].join("\n"),
  );
  // The app's generated values: the database's password.
  await writeFile(
    `${h.paths.projectHomeDir}/generated_values.json`,
    `${JSON.stringify({ dbPassword: DB_PASSWORD })}\n`,
  );
  h.deps.redactor.addLiteral(PORTAINER_TOKEN, "PORTAINER_API_KEY");
  h.deps.env.PORTAINER_API_KEY = PORTAINER_TOKEN;

  // The old side runs the app with its data; the new side's deploy ran (its edge stopped).
  const hostOf = (kind: MoveSideKind, address: string) => (kind === "portainer" ? PORTAINER : address);
  const oldHost = hostOf(from, OLD_IPV4);
  const newHost = hostOf(to, NEW_IPV4);
  const file = (data: Buffer) => ({ type: "file" as const, mode: 0o600, uid: 999, gid: 999, data });
  // The old side's data: the database's files and the cache's.
  Object.assign(h.hosts.host(oldHost), { app: true, db: "orders before the move" });
  h.hosts.seed(
    oldHost,
    { PG_VERSION: file(Buffer.alloc(1024)), "dump.rdb": file(Buffer.from("cached pages")) },
    oldHost === PORTAINER,
  );
  // The new side's deploy ran: the app is healthy there, its edge stopped.
  if (newHost === PORTAINER) h.hosts.seed(PORTAINER, {}, true);
  else {
    h.hosts.deploy(newHost);
    Object.assign(h.hosts.host(newHost), { caddy: false });
  }

  const portainer = h.hosts.docker(PORTAINER);
  const services = {
    ...h.services,
    own: { host: new FakeHostServer(preparedServerFacts(h.paths.projectId)), homeDir: h.root },
    portainer: portainerServices(portainer),
  };
  // The own servers' host keys, as `ssh-keyscan` reads them; every other command as before.
  const own = ownRunner();
  const previous = h.deps.runner;
  h.deps.runner = new ScriptedRunner(async (command, args, runOptions) =>
    // The admin login of the user's own server; the deploy user's shells are the hosts fake's.
    command === "ssh-keyscan" || (command === "ssh" && args.some((arg) => arg.startsWith("root@")))
      ? own.run(command, args, runOptions)
      : previous.run(command, args, runOptions),
  );
  const session = await openSession(h.deps, plan, {
    command: "opscrew retarget",
    providers: cloudProviders({ plan }),
    services,
    servers: { from: oldAddress, next: newAddress },
  });
  return { ...h, plan, session, services, oldHost, newHost, portainer };
}

export type PairHarness = Awaited<ReturnType<typeof pairHarness>>;
