import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import { cloudTarget } from "@opscrew/iac-templates";
import {
  type Architecture,
  type DeployPlan,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { recordOwnServerAnswers } from "../interview";
import { readServerAddresses, recordServerAddress } from "../shared";
import { generatedValuesFile } from "../shared/app-secrets";
import { inspectOwnServerForDesign } from "../shared/own-server-design";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  euCatalog,
  FakeHostServer,
  freshFacts,
  LAN_IPV4,
  MemoryCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  OWN_IPV4,
  offer,
  ownRunner,
  ScriptedRunner,
  type TestPhaseDeps,
  testKeyMaker,
} from "../testing";
import { placementEstimate } from "./placement";
import { previewDesignOptions, runDesign } from "./run";

async function setup(
  facts: ProjectFacts = nextPostgresFacts(),
  requirements: Requirements = makeRequirements(),
  options: Parameters<typeof createTestPhaseDeps>[0] = {},
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps(options);
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  return deps;
}

/** Edits plan.yaml as a user does, without OpsCrew's rules (a server with no network yet). */
async function editPlan(
  deps: Pick<TestPhaseDeps, "paths">,
  edit: (raw: Record<string, unknown> & { services: Record<string, unknown>[] }) => void,
): Promise<void> {
  const file = deps.paths.files.plan;
  const raw = parse(await readFile(file, "utf8"));
  edit(raw);
  await writeFile(file, stringify(raw));
}

/** Places the service `service` on the extra server `server`, written as `target` (none: defaults). */
function place(service: string, server: string, target?: Record<string, unknown>) {
  return (raw: Record<string, unknown> & { services: Record<string, unknown>[] }) => {
    const servers = (raw.servers as unknown[] | undefined) ?? [];
    raw.servers = [...servers, { name: server, ...(target === undefined ? {} : { target }) }];
    const entry = raw.services.find((s) => s.name === service);
    if (entry === undefined) throw new Error(`no service ${service}`);
    entry.server = server;
  };
}

/** The first design (Postgres `db` on the app's server), then `db` placed on server `db`. */
async function placedDb(target?: Record<string, unknown>) {
  const deps = await setup();
  const first = await runDesign(deps, { catalog: euCatalog() });
  await editPlan(deps, place("db", "db", target));
  return { deps, first };
}

/** Records a deployment where every service runs on the app's server, as provision does. */
async function deployed(
  deps: TestPhaseDeps,
  placement: Record<string, string> | undefined,
  edit: (plan: DeployPlan) => DeployPlan = (plan) => plan,
): Promise<void> {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  await writeArtifact(
    "plan",
    deps.paths.files.plan,
    edit({
      ...plan,
      deployment: {
        lastApplyAt: "2026-10-11T12:30:00.000Z",
        ...(placement === undefined ? {} : { placement }),
      },
    }),
  );
}

describe("design with a service on a server of its own", () => {
  it("sizes a new server at the app's provider and location, prices each server and the total, and links them", async () => {
    const { deps, first } = await placedDb();
    expect(first.plan.services.map((s) => [s.name, s.server])).toEqual([["db", undefined]]);
    const keys = testKeyMaker();
    const result = await runDesign(deps, { catalog: euCatalog(), keys });
    const { plan } = result;

    // The app's server is sized without Postgres, and server db takes its provider and location.
    expect(plan.target).toMatchObject({ location: "fsn1", serverType: "cx13" });
    expect(plan.servers).toEqual([
      {
        name: "db",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "fsn1",
          serverType: "cx13",
          image: "ubuntu-24.04",
          backups: false,
        },
      },
    ]);
    expect(plan.services.map((s) => [s.name, s.server])).toEqual([["db", "db"]]);

    // The network: the app's server and server db, with public keys only in the plan.
    const [app, db] = keys.made;
    expect(plan.network?.members).toEqual([
      {
        name: "app",
        address: expect.stringMatching(/\.1$/),
        port: 51820,
        publicKey: app?.publicKey,
      },
      { name: "db", address: expect.stringMatching(/\.2$/), port: 51820, publicKey: db?.publicKey },
    ]);
    const generated = JSON.parse(await readFile(generatedValuesFile(deps), "utf8"));
    expect(generated.network).toEqual({ app: app?.privateKey, db: db?.privateKey });
    const text = await readFile(deps.paths.files.plan, "utf8");
    for (const pair of keys.made) {
      expect(text).not.toContain(pair.privateKey);
      expect(deps.reporter.text()).not.toContain(pair.privateKey);
    }

    // One cost line per server, and the total.
    expect(plan.cost.breakdown).toEqual([
      { item: "Server cx13 (fsn1)", monthly: { amount: 4.19, currency: "EUR" } },
      { item: "Primary IPv4 address", monthly: { amount: 0.5, currency: "EUR" } },
      {
        item: "Server db (cx13 in fsn1), with its IPv4 address",
        monthly: { amount: 4.69, currency: "EUR" },
      },
    ]);
    expect(plan.cost.monthly).toEqual({ amount: 9.38, currency: "EUR" });
    expect(result.lines).toEqual(
      expect.arrayContaining([
        "Server app: Hetzner cx13 in Falkenstein (fsn1), 2 vCPU and 4 GB memory, €4.69/month (estimate as of 2026-09-01).",
        "Memory limits on server app: the app 512 MB (€0.59/month); OpsCrew's edge and the system 512 MB; 3.0 GB of 4.0 GB free.",
        "Server db: Hetzner cx13 in Falkenstein (fsn1), 2 vCPU and 4 GB memory, €4.69/month (estimate as of 2026-09-01).",
        "Memory limits on server db: db 512 MB (€0.59/month); the system 384 MB; 3.1 GB of 4.0 GB free.",
        "Monthly total for the app's 2 servers: €9.38 (estimate as of 2026-09-01).",
        "Each query from the app to db on server db waits about 2 ms (an estimate: 2 ms plus 1 ms per 50 km between fsn1 and fsn1, 0 km apart), so a page that makes 20 queries in a row takes about 40 ms longer.",
      ]),
    );
    expect(result.lines.filter((line) => line.startsWith("Memory limits"))).toHaveLength(2);
    expect(result.warnings.join("\n")).not.toContain("waits about");
    expect(deps.reporter.text()).toContain("€9.38/month for its 2 servers");

    // Nothing changed: the plan stays as it is, and no key is made again.
    const again = await createTestPhaseDeps({ root: deps.paths.root, env: deps.env });
    const kept = await runDesign(again, { catalog: euCatalog(), keys });
    expect(kept.plan).toEqual(plan);
    expect(keys.made).toHaveLength(2);
    expect(again.reporter.text()).toContain("opscrew/plan.yaml is up to date");
  });

  it("keeps the size and location the user set, and warns when the hop is long", async () => {
    const { deps } = await placedDb({ provider: "hetzner", location: "hel1", serverType: "cx11" });
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(result.plan.servers?.[0]?.target).toMatchObject({
      location: "hel1",
      serverType: "cx11",
    });
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        "Each query from the app to db on server db waits about 29 ms, so a page that makes 20 queries in a row takes about 574 ms longer",
      ),
    );
    // A type the provider does not offer there is refused, naming one that is.
    await editPlan(deps, (raw) => {
      const [server] = raw.servers as { target: Record<string, unknown> }[];
      if (server !== undefined) server.target = { location: "nbg1", serverType: "cx99" };
    });
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "Hetzner offers no server type cx99 in nbg1, which server db names (servers[].target.serverType). plan.yaml was not changed.",
      hint: expect.stringContaining("such as cx23"),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("prices a server at the other provider in the app's currency", async () => {
    const { deps } = await placedDb({ provider: "digitalocean" });
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    const server = result.plan.servers?.[0];
    expect(server?.target).toMatchObject({ provider: "digitalocean", location: "fra1" });
    const line = result.plan.cost.breakdown.at(-1);
    expect(line?.item).toMatch(
      /^Server db \(.+ in fra1\), \$\d+\.\d\d converted at 1 EUR = 1\.10 USD$/,
    );
    expect(line?.monthly.currency).toBe("EUR");
    expect(result.warnings).toContainEqual(
      expect.stringContaining("DIGITALOCEAN_TOKEN is not set"),
    );
    // Falkenstein to Frankfurt is past the threshold.
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Each query from the app to db on server db waits about 7 ms"),
    );
    expect(result.lines).toContainEqual(
      expect.stringContaining("Converted at a fixed approximate rate"),
    );
  });

  it("says that Kafka on another server has no login and only the app's servers reach it", async () => {
    const facts = makeFacts({
      services: [{ kind: "kafka", evidence: ["dependency:kafkajs"] }],
    });
    const deps = await setup(facts);
    const first = await runDesign(deps, { catalog: euCatalog() });
    const kafka = first.plan.services[0]?.name ?? "";
    await editPlan(deps, place(kafka, "events"));
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(result.lines).toContain(
      `Apache Kafka (${kafka}) on server events has no login: only the app's servers reach it, through the private network, and no device can be given access to it.`,
    );
  });

  it("prices the app's server without the placed services in the read-only preview", async () => {
    const { deps } = await placedDb();
    const preview = await previewDesignOptions(deps, { catalog: euCatalog() });
    expect(preview.options.find((o) => o.recommended)?.target.serverType).toBe("cx13");
  });

  it("warns when the servers together cost more than the budget", async () => {
    // The app's cx13 (€4.69) and a cx33 for db (€8.99) are over the budget of €10.
    const { deps } = await placedDb({ serverType: "cx33" });
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(result.warnings).toContain(
      "The app's 2 servers cost €13.68/month together, over your budget of €10.00/month. Raise the budget with `opscrew interview`, or keep more services on the app's server.",
    );
    // Within the budget, nothing is said.
    const { deps: cheap } = await placedDb();
    const fits = await runDesign(cheap, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(fits.warnings.join("\n")).not.toContain("over your budget");
  });

  it("gives Dragonfly on another server that server's vCPUs as its threads", async () => {
    const facts = nextPostgresFacts({
      services: [
        { kind: "postgres", evidence: ["dependency:pg"] },
        { kind: "redis", evidence: ["compose-image:dragonfly", "dependency:ioredis"] },
      ],
    });
    const deps = await setup(
      facts,
      makeRequirements({ budgetMonthly: { amount: 50, currency: "EUR" } }),
    );
    const first = await runDesign(deps, { catalog: euCatalog() });
    const cache = first.plan.services.find((s) => s.kind === "dragonfly");
    const appVcpus = first.chosen.target.vcpus;
    expect(cache?.options).toMatchObject({ threads: appVcpus });
    // Placed on a server of its own with more vCPUs, the threads design set follow that server.
    await editPlan(deps, (raw) => {
      place("cache", "cache", { serverType: "cx43" })(raw);
      const entry = raw.services.find((s) => s.name === "cache") as {
        options: Record<string, unknown>;
      };
      delete entry.options.threads;
    });
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(result.plan.services.find((s) => s.name === "cache")?.options).toMatchObject({
      threads: 8,
    });
    expect(appVcpus).not.toBe(8);
  });
});

describe("design refuses what it cannot place, before any change", () => {
  it("refuses a placement when the app does not run on a server", async () => {
    const { deps } = await placedDb();
    await writeArtifact(
      "requirements",
      deps.paths.files.requirements,
      makeRequirements({ provider: "portainer" }),
    );
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "opscrew/plan.yaml places services on other servers (servers, services[].server or network), but the app runs on your Portainer, and placement and the private network apply to servers only. Nothing was written.",
      hint: expect.stringContaining("choose a cloud server or your own server"),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("stops while `opscrew retarget` moves the app, even with a server added meanwhile", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: euCatalog() });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      target: {
        provider: "digitalocean",
        mode: "vps-compose",
        location: "fra1",
        serverType: "s-1vcpu-2gb",
        image: "ubuntu-24-04-x64",
        backups: true,
        edge: "caddy",
      },
      deployment: { lastApplyAt: "2026-10-11T12:30:00.000Z" },
      retarget: {
        from: { target: cloudTarget(plan.target), deploy: plan.deploy },
        step: "renamed",
        startedAt: "2026-10-12T09:00:00.000Z",
      },
    });
    await editPlan(deps, place("db", "db"));
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "A move to DigitalOcean is in progress.",
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });
});

/** Answers the login questions of an extra server the user owns, counting the questions asked. */
function loginAsker(host = OWN_IPV4) {
  const asked: string[] = [];
  const ask = async (server: string, questions: { id: string; prompt: string }[]) => {
    asked.push(server);
    expect(questions.map((q) => q.id)).toEqual([
      "server.host",
      "server.port",
      "server.user",
      "server.key",
    ]);
    expect(questions[0]?.prompt).toBe(`Server ${server}: What is your server's address?`);
    return {
      "server.host": host,
      "server.port": "22",
      "server.user": "root",
      "server.key": "agent",
    };
  };
  return { asked, ask };
}

describe("an extra server the user owns", () => {
  it("asks for its login once, keeps it, inspects the server and picks a free port", async () => {
    const deps = await setup(nextPostgresFacts(), makeRequirements(), {
      interactive: true,
      runner: ownRunner(),
    });
    await runDesign(deps, { catalog: euCatalog() });
    await editPlan(deps, place("db", "home", { provider: "own" }));
    const host = new FakeHostServer(
      HostFactsSchema.parse({ ...freshFacts({ memoryGb: 2 }), udpPortsInUse: [51820] }),
    );
    const { asked, ask } = loginAsker();
    const result = await runDesign(deps, {
      catalog: euCatalog(),
      keys: testKeyMaker(),
      askServerLogin: ask,
      extraServers: { host },
    });
    expect(asked).toEqual(["home"]);
    expect(host.inspections).toBe(1);
    expect(result.plan.servers).toEqual([
      { name: "home", target: { provider: "own", mode: "vps-compose", arch: "amd64" } },
    ]);
    const record = await readServerAddresses(deps.paths);
    expect(record.ownServers?.home).toEqual({
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      hostKey: ED25519_FINGERPRINT,
    });
    expect(record.servers?.home).toEqual({ ipv4: OWN_IPV4 });
    // Its address stays on this computer: never in the plan or the audit log.
    expect(await readFile(deps.paths.files.plan, "utf8")).not.toContain(OWN_IPV4);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(OWN_IPV4);
    expect(deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "inspect host (read-only)", target: "own server home" }),
    );
    // 51820 is taken there, so the network listens on the next port.
    expect(result.plan.network?.members.find((m) => m.name === "home")?.port).toBe(51821);
    expect(result.lines).toEqual(
      expect.arrayContaining([
        "Server home: your own server (2 vCPU, 2 GB memory, Ubuntu 24.04.3 LTS), no server cost.",
        "Memory limits on server home: db 512 MB; the system 384 MB; 1.1 GB of 2.0 GB free.",
        "OpsCrew cannot estimate the delay of each query from the app to db on server home: it does not know your own server's location. `opscrew status` measures it once the servers are linked.",
      ]),
    );
    // The total is the app's server alone: the user already pays for theirs.
    expect(result.plan.cost.monthly).toEqual(result.chosen.cost.monthly);

    // The next design asks nothing and inspects the server again.
    const again = await runDesign(deps, {
      catalog: euCatalog(),
      askServerLogin: ask,
      extraServers: { host },
    });
    expect(asked).toEqual(["home"]);
    expect(host.inspections).toBe(2);
    expect(again.plan.network).toEqual(result.plan.network);
  });

  it("links the app's own server to a cloud server, on a port its inspection shows free", async () => {
    const requirements = makeRequirements({ provider: "own", region: undefined });
    const deps = await setup(nextPostgresFacts(), requirements, { runner: ownRunner() });
    await recordOwnServerAnswers(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      serve: "dns-only",
    });
    const host = new FakeHostServer(
      HostFactsSchema.parse({
        ...freshFacts({ memoryGb: 8 }),
        udpPortsInUse: [51820],
        wireguardInterfaces: ["wg0"],
      }),
    );
    // What the CLI passes: the inspection of the app's server, with its network's facts.
    const ownServer = await inspectOwnServerForDesign(deps, {
      hostKey: ED25519_FINGERPRINT,
      services: { host },
    });
    expect(ownServer.network).toEqual({ udpPortsInUse: [51820], wireguardInterfaces: ["wg0"] });
    await runDesign(deps, { ownServer });
    await editPlan(deps, place("db", "db", { provider: "hetzner", location: "fsn1" }));
    const result = await runDesign(deps, { ownServer, keys: testKeyMaker() });
    expect(result.plan.network?.members.map((m) => [m.name, m.port])).toEqual([
      ["app", 51821],
      ["db", 51820],
    ]);
    expect(result.plan.servers?.[0]?.target).toMatchObject({
      provider: "hetzner",
      location: "fsn1",
    });
    expect(result.warnings).toContainEqual(expect.stringContaining("HCLOUD_TOKEN is not set"));
  });

  it("stops without a terminal to ask for the login in", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: euCatalog() });
    await editPlan(deps, place("db", "home", { provider: "own" }));
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Server home is your own, and OpsCrew does not know its address and SSH login on this computer. plan.yaml was not changed.",
    });
  });

  it("refuses a service on a server without a public address", async () => {
    const deps = await setup(nextPostgresFacts(), makeRequirements(), {
      interactive: true,
      runner: ownRunner(),
    });
    await runDesign(deps, { catalog: euCatalog() });
    await editPlan(deps, place("db", "home", { provider: "own" }));
    const lan = freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    });
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await runDesign(deps, {
      catalog: euCatalog(),
      askServerLogin: loginAsker(LAN_IPV4).ask,
      extraServers: { host: new FakeHostServer(lan) },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Server home has no public IPv4 address OpsCrew can find, so it cannot run db: the deploys and OpsCrew's commands reach an extra server at its public address. plan.yaml was not changed.",
      hint: expect.stringContaining("Place db on a cloud server"),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("refuses two servers that both lack a public address", async () => {
    const requirements = makeRequirements({
      provider: "own",
      region: undefined,
      dnsProvider: "cloudflare",
      domain: "shop.example.com",
    });
    const deps = await setup(nextPostgresFacts(), requirements, {
      interactive: true,
      runner: ownRunner(),
    });
    await recordOwnServerAnswers(deps.paths, {
      host: LAN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: false,
      serve: "tunnel",
    });
    const ownServer = {
      facts: { arch: "amd64", vcpus: 4, memoryGb: 8, diskFreeGb: 100 },
      network: { udpPortsInUse: [], wireguardInterfaces: [] },
    } as const;
    await runDesign(deps, { ownServer });
    await editPlan(deps, place("db", "home", { provider: "own" }));
    const lan = freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: "192.168.1.30", public: false }],
    });
    const error = await runDesign(deps, {
      ownServer,
      askServerLogin: loginAsker("192.168.1.30").ask,
      extraServers: { host: new FakeHostServer(lan) },
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Neither the app's server nor server home has a public IPv4 address OpsCrew can find, so the private network cannot link them: one of the two must be reachable. plan.yaml was not changed.",
    });
  });
});

/**
 * Two types in fsn1 alone, so the app's server stays in its location whatever its size: the moves
 * below never replace it.
 */
function fsn1Catalog(): MemoryCatalog {
  return new MemoryCatalog([
    offer({ id: "cx13", vcpus: 2, memoryGb: 4, diskGb: 40, price: 4.19, location: "fsn1" }),
    offer({ id: "cx33", vcpus: 4, memoryGb: 8, diskGb: 80, price: 8.49, location: "fsn1" }),
  ]);
}

/** A runner whose servers report the database's size over SSH. */
function sizedRunner(bytes: number): ScriptedRunner {
  return new ScriptedRunner((command, args) =>
    command === "ssh" && args.join(" ").includes("pg_database_size")
      ? { exitCode: 0, stdout: `${bytes}\n`, stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" },
  );
}

describe("moving a service of a deployed app", () => {
  it("moves Postgres with its data, showing the window from the database's size", async () => {
    const deps = await setup(nextPostgresFacts(), makeRequirements(), {
      runner: sizedRunner(50 * 1024 * 1024),
    });
    await runDesign(deps, { catalog: fsn1Catalog() });
    await deployed(deps, { db: "app" });
    await recordServerAddress(deps.paths, { ipv4: "203.0.113.10" });
    await editPlan(deps, place("db", "db"));
    const result = await runDesign(deps, { catalog: fsn1Catalog(), keys: testKeyMaker() });
    expect(result.plan.move).toEqual({
      service: "db",
      from: "app",
      to: "db",
      step: "started",
      copy: "dump",
    });
    expect(result.lines).toContain(
      "Moving db (PostgreSQL) from the app's server to server db needs a maintenance window of about 3 minutes for the database's 50.0 MB: the app stops, the data is copied, and the app starts against server db. Any failure starts the app again on the old copy, which stays, stopped, on the app's server until `opscrew provision --finish-move`.",
    );
    const ssh = (deps.runner as ScriptedRunner).calls.find((call) => call.command === "ssh");
    expect(ssh?.args).toContain("deploy@203.0.113.10");

    // The move in progress is kept; another service can't move until it is finished.
    const again = await runDesign(deps, { catalog: fsn1Catalog() });
    expect(again.plan.move).toEqual(result.plan.move);
  });

  it("says when the database's size cannot be read, and moves anyway", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: fsn1Catalog() });
    // Deployed before placement was recorded: everything runs on the app's server.
    await deployed(deps, undefined);
    await editPlan(deps, place("db", "db"));
    const result = await runDesign(deps, { catalog: fsn1Catalog(), keys: testKeyMaker() });
    expect(result.plan.move).toMatchObject({ from: "app", to: "db", copy: "dump" });
    expect(result.lines).toContainEqual(
      expect.stringContaining(
        "OpsCrew could not read the database's size (OpsCrew does not know the address of the app's server (app) on this computer), so `opscrew provision` measures it",
      ),
    );
  });

  it("starts Valkey empty with a warning about queued jobs", async () => {
    const facts = nextPostgresFacts({
      services: [
        { kind: "postgres", evidence: ["dependency:pg"] },
        { kind: "redis", evidence: ["dependency:ioredis"] },
      ],
    });
    const deps = await setup(facts);
    await runDesign(deps, { catalog: euCatalog() });
    await deployed(deps, { db: "app", cache: "app" });
    await editPlan(deps, place("cache", "cache"));
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(result.plan.move).toEqual({
      service: "cache",
      from: "app",
      to: "cache",
      step: "started",
      copy: "empty",
    });
    expect(result.warnings).toContain(
      "cache (Valkey) starts empty on server cache: what it holds on the app's server is not copied, so jobs waiting in it are lost. Let the queue drain before `opscrew provision`.",
    );

    // A second move while this one is in progress is refused.
    await editPlan(deps, place("db", "cache"));
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "cache is moving from the app's server to server cache, and OpsCrew moves one service at a time. plan.yaml was not changed.",
    });
  });

  it("refuses moving another kind's data on a live app until 022, and two moves at once", async () => {
    const facts = makeFacts({
      services: [
        { kind: "mongodb", evidence: ["dependency:mongodb"] },
        { kind: "postgres", evidence: ["dependency:pg"] },
      ],
    });
    const deps = await setup(facts);
    const first = await runDesign(deps, { catalog: euCatalog() });
    const [mongo, db] = ["mongodb", "postgres"].map(
      (kind) => first.plan.services.find((s) => s.kind === kind)?.name ?? "",
    );
    await deployed(deps, Object.fromEntries(first.plan.services.map((s) => [s.name, "app"])));
    const before = await readFile(deps.paths.files.plan, "utf8");
    await editPlan(deps, place(mongo ?? "", "data"));
    const refused = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "Moving the others comes with retargeting anywhere (feature 022)",
      ),
    });
    await writeFile(deps.paths.files.plan, before);
    await editPlan(deps, (raw) => {
      place(db ?? "", "data")(raw);
      const entry = raw.services.find((s) => s.name === mongo);
      if (entry !== undefined) entry.server = "data";
    });
    const both = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(both).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("at once, and OpsCrew moves one service at a time"),
    });
  });

  it("places any service anywhere on an app that was never deployed", async () => {
    const facts = makeFacts({ services: [{ kind: "mongodb", evidence: ["dependency:mongodb"] }] });
    const deps = await setup(facts);
    const first = await runDesign(deps, { catalog: euCatalog() });
    await editPlan(deps, place(first.plan.services[0]?.name ?? "", "data"));
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(result.plan.move).toBeUndefined();
    expect(result.plan.servers?.map((s) => s.name)).toEqual(["data"]);
  });

  it("moves Postgres back to the app's server, keeping its server until the move is finished", async () => {
    const deps = await setup();
    await runDesign(deps, { catalog: fsn1Catalog() });
    await editPlan(deps, place("db", "db"));
    const keys = testKeyMaker();
    const split = await runDesign(deps, { catalog: fsn1Catalog(), keys });
    await deployed(deps, { db: "db" });
    const before = await readFile(deps.paths.files.plan, "utf8");

    // Removing the server while it still holds the data is refused, with or without the network.
    for (const network of [true, false]) {
      await editPlan(deps, (raw) => {
        delete raw.servers;
        if (!network) delete raw.network;
        for (const service of raw.services) delete service.server;
      });
      const error = await runDesign(deps, { catalog: fsn1Catalog() }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message:
          "Server db still holds db's data, which moves away from it, so it must stay in servers until the move is finished. plan.yaml was not changed.",
      });
      await writeFile(deps.paths.files.plan, before);
    }

    // Kept in servers, it holds the old copy and runs nothing else; it is still priced.
    await editPlan(deps, (raw) => {
      for (const service of raw.services) delete service.server;
    });
    const back = await runDesign(deps, { catalog: fsn1Catalog(), keys });
    expect(back.plan.move).toMatchObject({ service: "db", from: "db", to: "app", copy: "dump" });
    expect(back.plan.servers).toEqual(split.plan.servers);
    expect(back.plan.network?.members).toEqual(split.plan.network?.members);
    // The app's server holds Postgres again, so it grows; server db is still billed.
    expect(back.plan.target).toMatchObject({ serverType: "cx33" });
    expect(back.plan.cost.breakdown.at(-1)).toEqual(split.plan.cost.breakdown.at(-1));
    expect(back.warnings).toContainEqual(
      expect.stringContaining("changes the server type from cx13 to cx33"),
    );
    expect(back.lines).toContainEqual(
      expect.stringContaining("Moving db (PostgreSQL) from server db to the app's server"),
    );
    expect(back.lines.join("\n")).not.toContain("Each query from the app to db");
  });
});

/** An app with Postgres (`db`) and Redis (`cache`), designed once with every service at home. */
async function dbAndCache(catalog: () => MemoryCatalog = euCatalog) {
  const facts = nextPostgresFacts({
    services: [
      { kind: "postgres", evidence: ["dependency:pg"] },
      { kind: "redis", evidence: ["dependency:ioredis"] },
    ],
  });
  const deps = await setup(
    facts,
    makeRequirements({ budgetMonthly: { amount: 100, currency: "EUR" } }),
  );
  await runDesign(deps, { catalog: catalog() });
  return deps;
}

/** Writes the infrastructure root's tfvars as provision last rendered them. */
async function renderedTfvars(deps: TestPhaseDeps, values: Record<string, unknown>) {
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const dir = join(deps.paths.root, plan.infra.dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "terraform.tfvars.json"), JSON.stringify(values));
}

describe("an extra server's type", () => {
  it("refuses a type that no longer holds its services, naming one that does", async () => {
    const deps = await dbAndCache();
    await editPlan(deps, place("db", "data", { location: "fsn1", serverType: "cx13" }));
    await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    // A second service, bigger, on the same server.
    await editPlan(deps, (raw) => {
      const cache = raw.services.find((s) => s.name === "cache");
      if (cache !== undefined) Object.assign(cache, { server: "data", memoryMb: 4096 });
    });
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message:
        "Server data is a cx13 (2 vCPU, 4 GB memory), but db and cache on it need 4.9 GB of memory with the system's share. plan.yaml was not changed.",
      hint: "Choose a bigger type for server data, such as cx33, or leave serverType out so OpsCrew sizes the server for its services, then run `opscrew design` again.",
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("warns when its services leave little of its memory free", async () => {
    const deps = await dbAndCache();
    await editPlan(deps, (raw) => {
      place("db", "data", { location: "fsn1", serverType: "cx13" })(raw);
      const db = raw.services.find((s) => s.name === "db");
      if (db !== undefined) db.memoryMb = 3200;
    });
    const result = await runDesign(deps, { catalog: euCatalog(), keys: testKeyMaker() });
    expect(result.warnings).toContain(
      "Server data (cx13) keeps only 14% of its memory free after its services' memory limits and the system, so a service that grows can make the server run out of memory. Choose a bigger type for it or lower a memory limit in opscrew/plan.yaml.",
    );
  });
});

describe("a deployed extra server that changes", () => {
  it("warns of a resize and a replace, from the location and type provision last rendered", async () => {
    const deps = await dbAndCache(fsn1Catalog);
    await editPlan(deps, place("cache", "data"));
    const split = await runDesign(deps, { catalog: fsn1Catalog(), keys: testKeyMaker() });
    expect(split.plan.servers?.[0]?.target).toMatchObject({ location: "fsn1", serverType: "cx13" });
    await deployed(deps, { db: "app", cache: "data" });
    await renderedTfvars(deps, { data_location: "fsn1", data_server_type: "cx13" });
    const same = await runDesign(deps, { catalog: fsn1Catalog() });
    expect(same.warnings.join("\n")).not.toMatch(/server data/i);

    await editPlan(deps, (raw) => {
      const [server] = raw.servers as { target: Record<string, unknown> }[];
      if (server !== undefined) server.target = { location: "fsn1", serverType: "cx33" };
    });
    const resized = await runDesign(deps, { catalog: fsn1Catalog() });
    expect(resized.warnings).toContain(
      "The plan changes server data's type from cx13 to cx33, so the next `opscrew provision` will resize it. Its services are offline while it restarts.",
    );

    await editPlan(deps, (raw) => {
      const [server] = raw.servers as { target: Record<string, unknown> }[];
      if (server !== undefined) server.target = { location: "hel1", serverType: "cx11" };
    });
    const replaced = await runDesign(deps, { catalog: euCatalog() });
    expect(replaced.warnings).toContain(
      "Server data already runs in fsn1 (cx13). The plan puts it in hel1 (cx11), so the next `opscrew provision` will replace it: it creates a new one and deletes the old one together with the data on it. Back up its data first, or set its location back to fsn1 (servers[].target.location) to keep the server.",
    );
  });

  it("refuses a move in the same design that replaces a server it touches", async () => {
    // The destination: server data moves to another location while db moves onto it.
    const deps = await dbAndCache(fsn1Catalog);
    await editPlan(deps, place("cache", "data"));
    await runDesign(deps, { catalog: fsn1Catalog(), keys: testKeyMaker() });
    await deployed(deps, { db: "app", cache: "data" });
    await renderedTfvars(deps, { data_location: "nbg1", data_server_type: "cx23" });
    await editPlan(deps, (raw) => {
      const db = raw.services.find((s) => s.name === "db");
      if (db !== undefined) db.server = "data";
    });
    const error = await runDesign(deps, { catalog: fsn1Catalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "db moves from the app's server to server data, and the next `opscrew provision` would also replace server data (another location or provider). OpsCrew does one at a time. plan.yaml was not changed.",
      hint: expect.stringContaining("servers[].target.location as it was"),
    });

    // The app's server: taking Postgres off it makes the cheapest option another location.
    const app = await setup();
    await runDesign(app, { catalog: euCatalog() });
    await deployed(app, { db: "app" });
    await editPlan(app, place("db", "db"));
    const moved = await runDesign(app, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(moved).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("would also replace the app's server"),
      hint: expect.stringContaining("`opscrew design --option <id>`"),
    });
    // An option in the server's location keeps it, and the move goes ahead.
    const kept = await runDesign(app, {
      catalog: euCatalog(),
      optionId: "hetzner-single-cx33-nbg1",
      keys: testKeyMaker(),
    });
    expect(kept.plan.move).toMatchObject({ service: "db", from: "app", to: "db" });
  });
});

describe("the network follows the servers", () => {
  it("drops a server's member when the server leaves the plan, and keeps the others' keys", async () => {
    const facts = nextPostgresFacts({
      services: [
        { kind: "postgres", evidence: ["dependency:pg"] },
        { kind: "redis", evidence: ["dependency:ioredis"] },
      ],
    });
    const deps = await setup(facts);
    await runDesign(deps, { catalog: euCatalog() });
    await editPlan(deps, (raw) => {
      place("db", "db")(raw);
      place("cache", "cache")(raw);
    });
    const keys = testKeyMaker();
    const both = await runDesign(deps, { catalog: euCatalog(), keys });
    expect(both.plan.network?.members.map((m) => m.name)).toEqual(["app", "db", "cache"]);
    await editPlan(deps, (raw) => {
      raw.servers = (raw.servers as { name: string }[]).filter((s) => s.name !== "cache");
      for (const service of raw.services) if (service.name === "cache") delete service.server;
    });
    const one = await runDesign(deps, { catalog: euCatalog(), keys });
    expect(one.plan.network?.members).toEqual(both.plan.network?.members.slice(0, 2));
    expect(keys.made).toHaveLength(3);
  });
});

describe("reading plan.yaml's placement", () => {
  it("stops on a placement field that is not valid, naming it, and keeps the plan", async () => {
    const { deps } = await placedDb();
    await editPlan(deps, (raw) => {
      raw.servers = [{ name: "Db" }];
      const entry = raw.services[0];
      if (entry !== undefined) entry.server = "app";
    });
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await runDesign(deps, { catalog: euCatalog() }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringMatching(
        /^opscrew\/plan\.yaml places services in a way OpsCrew cannot read: services\.0\.server .+; servers\.0\.name .+\. Nothing was written\.$/,
      ),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("writes a new plan, as before, when the rest of the file is not valid", async () => {
    const { deps } = await placedDb();
    await editPlan(deps, (raw) => {
      raw.app = "not an app";
    });
    const result = await runDesign(deps, { catalog: euCatalog() });
    expect(result.warnings).toContainEqual(
      expect.stringContaining("The existing opscrew/plan.yaml could not be read"),
    );
    expect(result.plan.servers).toBeUndefined();
  });
});

describe("placementEstimate", () => {
  it("prices one service on one server and estimates its delay", async () => {
    const deps = await setup();
    const { plan } = await runDesign(deps, { catalog: euCatalog() });
    const estimate = await placementEstimate({
      plan,
      service: "db",
      server: { provider: "hetzner", location: "hel1" },
      catalog: euCatalog(),
    });
    expect(estimate.server).toMatchObject({ serverType: "cx11", vcpus: 1, memoryGb: 2 });
    expect(estimate.server?.cost.monthly).toEqual({ amount: 1.5, currency: "EUR" });
    expect(estimate.total).toEqual({
      amount: Math.round((plan.cost.monthly.amount + 1.5) * 100) / 100,
      currency: "EUR",
    });
    expect(estimate.delay.estimate?.roundTripMs).toBeGreaterThan(28);
    expect(estimate.delay.warning).toBeDefined();

    const own = await placementEstimate({ plan, service: "db", server: { provider: "own" } });
    expect(own).toEqual({
      total: plan.cost.monthly,
      delay: {
        text: expect.stringContaining("`opscrew status` measures it"),
      },
    });
    await expect(
      placementEstimate({ plan, service: "nope", server: { provider: "own" } }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", hint: "Use one of: db." });
  });
});
