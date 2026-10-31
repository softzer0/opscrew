import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES, serviceSpec } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  type Network,
  PlanServiceSchema,
  readArtifact,
  type SelfHostedServiceKind,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import {
  GeneratedValuesSchema,
  generatedValuesFile,
  recordGeneratedEntries,
} from "../shared/app-secrets";
import { readValidJson } from "../shared/files";
import { updateServerAddresses } from "../shared/server-record";
import {
  createTestPhaseDeps,
  DEPLOYED_AT,
  freshFacts,
  ScriptedApprovalHandler,
  testKeyMaker,
  testKeyPair,
  testPlan,
} from "../testing";
import { vpnGrant, vpnRevoke } from "./grants";
import type { VpnServices } from "./servers";

const APP_IPV4 = "203.0.113.10";
const DATA_IPV4 = "203.0.113.30";
/** The app's own Postgres password, as provision keeps it: never a device's. */
const APP_DB_PASSWORD = fakeSecret("generic-password", "app-db");
/** Device logins' passwords made by an earlier `vpn grant`. */
const LAPTOP = fakeSecret("generic-password", "laptop");
const PHONE = fakeSecret("generic-password", "phone");

type Grant = Network["grants"][number];

/** The plan's entry for a service of `kind` named `name`, at the catalog's version. */
function serviceOf(kind: SelfHostedServiceKind, name: string) {
  const spec = serviceSpec(kind);
  const options =
    kind === "valkey" || kind === "redis" || kind === "dragonfly" ? { mode: "cache" } : {};
  return {
    name,
    kind,
    version: spec.defaultVersion,
    memoryMb: spec.memory.defaultMb,
    enabled: true,
    options,
    reason: `The app uses ${spec.title}.`,
    licence: spec.licence.id,
  };
}

/** The first three numbers of the network's range: `10.20x.y`. */
function prefixOf(plan: Pick<DeployPlan, "network">): string {
  return (plan.network?.range ?? "").split(".").slice(0, 3).join(".");
}

/** `base` on its network, with the devices laptop (`.100`) and phone (`.101`) and `grants`. */
function networked(
  base: Omit<DeployPlan, "network">,
  grants: Grant[] = [],
  facts: Parameters<typeof allocateNetwork>[1] = {},
) {
  const deployed = { ...base, deployment: { ...base.deployment, lastApplyAt: DEPLOYED_AT } };
  const { network, privateKeys } = allocateNetwork(deployed, facts, testKeyMaker("server"));
  const prefix = prefixOf({ network });
  const devices = ["laptop", "phone"].map((name, i) => ({
    name,
    address: `${prefix}.${100 + i}`,
    publicKey: testKeyPair(name).publicKey,
    addedAt: "2026-10-30T10:00:00.000Z",
  }));
  return { plan: withNetwork(deployed, { ...network, devices, grants }), privateKeys, prefix };
}

/** Postgres (`db`) on the extra server `data`. */
const split = (grants: Grant[] = []) => networked(splitPlan(), grants);

/** One server: Postgres (`db`) and a service of `kind` named `name` on the app's server. */
function single(kind: SelfHostedServiceKind, name: string, grants: Grant[] = []) {
  const { network: _none, ...base } = testPlan();
  const service = PlanServiceSchema.parse(serviceOf(kind, name));
  return networked({ ...base, services: [...base.services, service] }, grants);
}

interface Apply {
  server: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/** A deployed project with `plan`, the servers' keys, and fake host adapters per server. */
async function world(o: {
  plan: DeployPlan;
  privateKeys: Record<string, string>;
  answer?: () => boolean;
  interactive?: boolean;
}) {
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const deps = await createTestPhaseDeps({ approvalHandler: handler });
  if (o.interactive === true) deps.interactive = true;
  await writeArtifact("plan", deps.paths.files.plan, o.plan);
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    deployment: { ipv4: APP_IPV4 },
    ...((o.plan.servers ?? []).length > 0 ? { servers: { data: { ipv4: DATA_IPV4 } } } : {}),
  }));
  await recordGeneratedEntries(deps, "network", o.privateKeys);
  const generated = await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema);
  await writeFile(
    generatedValuesFile(deps),
    `${JSON.stringify({ ...generated, dbPassword: APP_DB_PASSWORD })}
`,
  );
  const applies: Apply[] = [];
  const inspected: string[] = [];
  const services: VpnServices = {
    remote: async (server) => ({
      host: server,
      run: async () => {
        throw new Error("the fake host adapter does the work");
      },
    }),
    host: {
      async inspect(remote) {
        inspected.push(remote.host);
        return HostFactsSchema.parse(
          freshFacts({ user: "deploy", privilege: "docker" }),
        ) as HostFacts;
      },
      async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push({ server: remote.host, plan, options });
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: [],
        };
      },
    },
  };
  const plan = () => readArtifact("plan", deps.paths.files.plan);
  const passwords = async () =>
    (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema))?.grants ?? {};
  return { deps, handler, applies, inspected, services, plan, passwords };
}

type World = Awaited<ReturnType<typeof world>>;

/** A step of a host plan by its id. */
const stepOf = (plan: HostPlan | undefined, id: string) => plan?.steps.find((s) => s.id === id);

/** The network-filter step's rules in a host plan: `<port>=<source>,<source>` each. */
function filterRules(plan: HostPlan | undefined): string[] {
  return String(stepOf(plan, "network-filter")?.params.rules ?? "").split(" ");
}

/** Every text OpsCrew showed, audited, asked, saved or applied, but not the run's result. */
async function everything(w: World): Promise<string> {
  const plans = w.deps.paths.files.plansDir;
  const saved = existsSync(plans)
    ? await Promise.all((await readdir(plans)).map((name) => readFile(join(plans, name), "utf8")))
    : [];
  return [
    w.deps.reporter.text(),
    JSON.stringify(w.deps.audit.entries),
    JSON.stringify(w.handler.requests),
    JSON.stringify(w.applies.map((a) => ({ ...a, options: { ...a.options, secrets: {} } }))),
    ...saved,
    await readFile(w.deps.paths.files.plan, "utf8"),
  ].join("\n");
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Stops unchanged: no inspection, no host plan, the plan's bytes and no password. */
async function expectUnchanged(w: World, before: string): Promise<void> {
  expect(w.inspected).toEqual([]);
  expect(w.applies).toEqual([]);
  expect(await readFile(w.deps.paths.files.plan, "utf8")).toBe(before);
  expect(await w.passwords()).toEqual({});
}

describe("opscrew vpn grant", () => {
  it("gives the device a read-only Postgres login on the service's server, then admits it there, and returns the details once", async () => {
    const { plan, privateKeys, prefix } = split();
    const w = await world({ plan, privateKeys });

    const result = await vpnGrant(w.deps, "laptop", "db", { services: w.services });

    // Only the service's server: the login's host plan, then the network's, each by its hash.
    expect(w.inspected).toEqual(["data"]);
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["host-apply", "host-apply"]);
    const [grant, network] = w.applies;
    expect(stepOf(grant?.plan, "grant")?.params).toEqual({
      service: "db",
      kind: "postgres",
      login: "laptop",
      access: "read-only",
      remove: false,
    });
    const password = (await w.passwords())["laptop/db"] as string;
    expect(password).toMatch(/^[A-Za-z0-9]{16,128}$/);
    expect(grant?.options.secrets).toEqual({ grantPassword: password });
    expect(grant?.options.rootImage).toBe(IMAGES.caddy.ref);
    expect(filterRules(network?.plan)).toEqual([`5432=${prefix}.1,${prefix}.100`]);
    expect(result.hostPlanHashes).toEqual(w.applies.map((a) => hostPlanHash(a.plan)));

    const after = await w.plan();
    expect(after.network?.grants).toEqual([
      { device: "laptop", service: "db", access: "read-only" },
    ]);
    expect(after.approvals.map((a) => a.kind)).toEqual(["host-apply", "host-apply"]);

    // The details name the private address and the device's own login, never the app's.
    expect(result).toMatchObject({
      device: "laptop",
      service: "db",
      access: "read-only",
      address: `${prefix}.2`,
      port: 5432,
      applied: true,
      connection: {
        client: `psql "postgresql://laptop@${prefix}.2:5432/app"`,
        password,
        url: `postgresql://laptop:${password}@${prefix}.2:5432/app`,
      },
    });
    // On its own server the service is already published: no deploy is needed.
    expect(w.deps.reporter.text()).not.toContain("opscrew provision");

    // The password is in the generated values and the result only; the app's password nowhere.
    const text = await everything(w);
    expect(text).not.toContain(password);
    expect(text).not.toContain(APP_DB_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(APP_DB_PASSWORD);
  });

  it.each([
    [
      "mysql",
      3306,
      (p: string, pw: string) => [
        `mysql -h ${p}.1 -P 3306 -u laptop -p app`,
        `mysql://laptop:${pw}@${p}.1:3306/app`,
      ],
    ],
    [
      "mariadb",
      3306,
      (p: string, pw: string) => [
        `mysql -h ${p}.1 -P 3306 -u laptop -p app`,
        `mysql://laptop:${pw}@${p}.1:3306/app`,
      ],
    ],
    [
      "mongodb",
      27017,
      (p: string, pw: string) => [
        `mongosh "mongodb://laptop@${p}.1:27017/app?authSource=admin&directConnection=true"`,
        `mongodb://laptop:${pw}@${p}.1:27017/app?authSource=admin&directConnection=true`,
      ],
    ],
  ] as const)(
    "gives %s's login by its host step on the app's server, which publishes it at the next deploy",
    async (kind, port, lines) => {
      const { plan, privateKeys, prefix } = single(kind, "store");
      const w = await world({ plan, privateKeys });

      const result = await vpnGrant(w.deps, "laptop", "store", { services: w.services });

      expect(w.inspected).toEqual(["app"]);
      const [grant, network] = w.applies;
      expect(stepOf(grant?.plan, "grant")?.params).toMatchObject({ kind, login: "laptop" });
      const password = (await w.passwords())["laptop/store"] as string;
      expect(grant?.options.secrets).toEqual({ grantPassword: password });
      // The port wasn't published on the private address: the filter guards it from now on.
      expect(filterRules(network?.plan)).toContain(`${port}=${prefix}.1,${prefix}.100`);
      const [client, url] = lines(prefix, password);
      expect(result.connection).toEqual({ client, password, url });
      expect(result.address).toBe(`${prefix}.1`);
      expect(w.deps.reporter.text()).toContain("`opscrew provision`");
      expect(w.deps.reporter.text()).toContain("publishes store");
      expect(await everything(w)).not.toContain(password);
    },
  );

  it.each([["valkey"], ["redis"], ["dragonfly"]] as const)(
    "declares %s's login in its environment: no host step, the filter now, the secret and the deploy by provision",
    async (kind) => {
      const { plan, privateKeys, prefix } = single(kind, "cache");
      const w = await world({ plan, privateKeys });

      const result = await vpnGrant(w.deps, "laptop", "cache", { services: w.services });

      expect(w.applies.map((a) => a.plan.steps.map((s) => s.id))).toEqual([
        ["network", "network-filter"],
      ]);
      expect(filterRules(w.applies[0]?.plan)).toContain(`6379=${prefix}.1,${prefix}.100`);
      const password = (await w.passwords())["laptop/cache"] as string;
      expect(result.connection).toEqual({
        client: `redis-cli -h ${prefix}.1 -p 6379 --user laptop --askpass`,
        password,
        url: `redis://laptop:${password}@${prefix}.1:6379`,
      });
      const text = w.deps.reporter.text();
      expect(text).toContain("`opscrew provision`");
      expect(text).toContain("SHA-256");
      expect(await everything(w)).not.toContain(password);
    },
  );

  it("--full warns, asks, and gives all of the data: in a script only with --yes-full-access", async () => {
    // Interactive: the warning is asked about.
    const asked: string[] = [];
    const interactive = await world({ ...split(), interactive: true });
    const result = await vpnGrant(interactive.deps, "laptop", "db", {
      full: true,
      confirmFull: async (question) => {
        asked.push(question);
        return true;
      },
      services: interactive.services,
    });
    // The warning first, then the question.
    expect(interactive.deps.reporter.text()).toContain("change and delete");
    expect(asked).toEqual(["Give device laptop full access to db?"]);
    expect(result.access).toBe("full");
    expect(stepOf(interactive.applies[0]?.plan, "grant")?.params.access).toBe("full");
    expect((await interactive.plan()).network?.grants).toEqual([
      { device: "laptop", service: "db", access: "full" },
    ]);

    // A script: refused without --yes-full-access, before any change.
    const script = await world(split());
    const before = await readFile(script.deps.paths.files.plan, "utf8");
    const refused = await failure(
      vpnGrant(script.deps, "laptop", "db", { full: true, services: script.services }),
    );
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(refused.message).toContain("needs your confirmation");
    expect(refused.hint).toContain("opscrew vpn grant laptop db --full --yes-full-access");
    await expectUnchanged(script, before);

    const yes = await vpnGrant(script.deps, "laptop", "db", {
      full: true,
      yesFullAccess: true,
      services: script.services,
    });
    expect(yes.access).toBe("full");
    expect(script.deps.reporter.text()).toContain("change and delete");
  });

  it("stops when full access isn't confirmed, before any change", async () => {
    const w = await world({ ...split(), interactive: true });
    const before = await readFile(w.deps.paths.files.plan, "utf8");
    const error = await failure(
      vpnGrant(w.deps, "laptop", "db", {
        full: true,
        confirmFull: async () => false,
        services: w.services,
      }),
    );
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("Nothing was changed");
    await expectUnchanged(w, before);
  });

  it("refuses a broker or search engine, an unknown service or device, and a login the database uses, before any change", async () => {
    const kafka = single("kafka", "events");
    const w = await world(kafka);
    const before = await readFile(w.deps.paths.files.plan, "utf8");

    const broker = await failure(vpnGrant(w.deps, "laptop", "events", { services: w.services }));
    expect(broker.code).toBe("INVALID_INPUT");
    expect(broker.message).toContain("has no login");
    expect(broker.message).toContain("only the app's servers reach it");
    expect(broker.hint).toContain("db");

    const unknown = await failure(vpnGrant(w.deps, "laptop", "nope", { services: w.services }));
    expect(unknown.code).toBe("INVALID_INPUT");
    expect(unknown.hint).toContain("db");

    const stranger = await failure(vpnGrant(w.deps, "tablet", "db", { services: w.services }));
    expect(stranger.code).toBe("INVALID_INPUT");
    expect(stranger.hint).toContain("opscrew vpn add tablet");
    await expectUnchanged(w, before);

    // A device named like the database's own login.
    const { network: _n, ...base } = testPlan();
    const deployed = { ...base, deployment: { ...base.deployment, lastApplyAt: DEPLOYED_AT } };
    const { network, privateKeys } = allocateNetwork(deployed, {}, testKeyMaker("server"));
    const admin = {
      name: "postgres",
      address: `${prefixOf({ network })}.100`,
      publicKey: testKeyPair("postgres").publicKey,
      addedAt: "2026-10-30T10:00:00.000Z",
    };
    const reserved = await world({
      plan: withNetwork(deployed, { ...network, devices: [admin] }),
      privateKeys,
    });
    const taken = await failure(
      vpnGrant(reserved.deps, "postgres", "db", { services: reserved.services }),
    );
    expect(taken.code).toBe("INVALID_INPUT");
    expect(taken.message).toContain("already uses");
    expect(reserved.inspected).toEqual([]);
  });

  it("a refused host plan keeps the grant and its password: --approve with the shown hash finishes it", async () => {
    let answers = 0;
    const w = await world({ ...split(), answer: () => answers++ > 0 });

    const error = await failure(vpnGrant(w.deps, "laptop", "db", { services: w.services }));
    expect(error.code).toBe("APPROVAL_REFUSED");
    const refused = w.handler.requests[0]?.planHash;
    expect(error.hint).toBe(
      `To apply it later without prompts, run: opscrew vpn grant laptop db --approve ${refused}`,
    );
    const password = (await w.passwords())["laptop/db"];
    expect((await w.plan()).network?.grants).toHaveLength(1);

    const again = await vpnGrant(w.deps, "laptop", "db", { services: w.services });

    expect(again.hostPlanHashes[0]).toBe(refused);
    expect((await w.passwords())["laptop/db"]).toBe(password);
    expect(again.connection.password).toBe(password);
    expect(w.applies[0]?.options.secrets).toEqual({ grantPassword: password });
  });

  it("an --approve re-run after a refused plan still says provision publishes the service", async () => {
    let answers = 0;
    const w = await world({ ...single("mysql", "store"), answer: () => answers++ > 0 });
    await failure(vpnGrant(w.deps, "laptop", "store", { services: w.services }));
    // The refused run wrote the grant, so the plan already publishes the service.
    expect((await w.plan()).network?.grants).toHaveLength(1);
    w.deps.reporter.lines.length = 0;

    await vpnGrant(w.deps, "laptop", "store", { services: w.services });

    const text = w.deps.reporter.text();
    expect(text).toContain("`opscrew provision`");
    expect(text).toContain("publishes store");
  });

  it("refuses a service on the app's server behind a Cloudflare Tunnel, which no device reaches, before any change", async () => {
    const split = splitPlan({ app: "own-tunnel" });
    const service = PlanServiceSchema.parse(serviceOf("valkey", "cache"));
    const { plan, privateKeys } = networked(
      { ...split, services: [...split.services, service] },
      [],
      { app: { udpPortsInUse: [], wireguardInterfaces: [] } },
    );
    const w = await world({ plan, privateKeys });
    const before = await readFile(w.deps.paths.files.plan, "utf8");

    const error = await failure(vpnGrant(w.deps, "laptop", "cache", { services: w.services }));

    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("no public address");
    await expectUnchanged(w, before);
  });
});

describe("opscrew vpn revoke", () => {
  it("drops the device from the filter, then removes its Postgres login, the grant and its password", async () => {
    const grants: Grant[] = [
      { device: "laptop", service: "db", access: "read-only" },
      { device: "phone", service: "db", access: "full" },
    ];
    const { plan, privateKeys, prefix } = split(grants);
    const w = await world({ plan, privateKeys });
    await recordGeneratedEntries(w.deps, "grants", { "laptop/db": LAPTOP, "phone/db": PHONE });

    const result = await vpnRevoke(w.deps, "laptop", "db", { services: w.services });

    expect(w.inspected).toEqual(["data"]);
    const [network, grant] = w.applies;
    expect(filterRules(network?.plan)).toEqual([`5432=${prefix}.1,${prefix}.101`]);
    expect(stepOf(grant?.plan, "grant")?.params).toEqual({
      service: "db",
      kind: "postgres",
      login: "laptop",
      access: "read-only",
      remove: true,
    });
    expect(grant?.options.secrets).toEqual({});
    expect(result.hostPlanHashes).toEqual(w.applies.map((a) => hostPlanHash(a.plan)));
    expect((await w.plan()).network?.grants).toEqual([grants[1]]);
    expect(await w.passwords()).toEqual({ "phone/db": PHONE });
    expect(w.deps.reporter.text()).not.toContain("opscrew provision");
    const text = await everything(w);
    expect(text).not.toContain(LAPTOP);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(APP_DB_PASSWORD);
  });

  it("on Valkey, Redis or Dragonfly the login goes with the next deploy, which also unpublishes the port nothing needs", async () => {
    const { plan, privateKeys } = single("valkey", "cache", [
      { device: "laptop", service: "cache", access: "read-only" },
    ]);
    const w = await world({ plan, privateKeys });
    await recordGeneratedEntries(w.deps, "grants", { "laptop/cache": LAPTOP });

    await vpnRevoke(w.deps, "laptop", "cache", { services: w.services });

    // No host step for the login: only the private network's plan, which no longer lists the port.
    expect(w.applies.map((a) => a.server)).toEqual(["app"]);
    expect(stepOf(w.applies[0]?.plan, "grant")).toBeUndefined();
    expect(filterRules(w.applies[0]?.plan).some((rule) => rule.startsWith("6379="))).toBe(false);
    expect((await w.plan()).network?.grants).toEqual([]);
    expect(await w.passwords()).toEqual({});
    const text = w.deps.reporter.text();
    expect(text).toContain("`opscrew provision`");
    expect(text).toContain("stops publishing cache");
  });

  it("refuses a grant that doesn't exist, before any change", async () => {
    const { plan, privateKeys } = split([{ device: "phone", service: "db", access: "read-only" }]);
    const w = await world({ plan, privateKeys });
    const before = await readFile(w.deps.paths.files.plan, "utf8");
    const error = await failure(vpnRevoke(w.deps, "laptop", "db", { services: w.services }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("has no login to db");
    expect(w.inspected).toEqual([]);
    expect(await readFile(w.deps.paths.files.plan, "utf8")).toBe(before);
  });
});
