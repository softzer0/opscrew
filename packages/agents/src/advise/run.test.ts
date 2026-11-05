/**
 * Advise's run (US1, US2, US4 and the spec's edge cases): what it reads, what it couldn't, the
 * proposals in order, each server's basis, and that it changes nothing. Fakes only.
 */
import type { DependabotAlerts } from "@opscrew/connector-github";
import type { PortainerClient } from "@opscrew/connector-portainer";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { extraServerVariables } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { HOST_CHECKS } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { monitoredPlan, networked, splitPlan } from "../network/__fixtures__/plans";
import { serverServiceChecks } from "../secure/services";
import { recordOwnServer, recordPortainerConnection } from "../shared";
import { serverFiguresCommand } from "../status/resources";
import {
  fakeCertificate,
  figuresOutput,
  makeRequirements,
  movingPlan,
  OWN_IPV4,
  ownPlan,
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerPlan,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import {
  deployed,
  FakeAdviseGitHub,
  type FakeHost,
  fakeServers,
  IPS,
  inEnvironment,
  NOW,
  type ProjectInit,
  project,
  recordedHistory,
  type Scenario,
  type ScenarioInit,
  scenario,
  tree,
} from "./__fixtures__/environment";
import { type RunAdviseOptions, runAdvise } from "./run";
import { type AdviceReport, type Proposal, ProposalSchema } from "./types";

const DAY_MS = 86_400_000;
const inDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS).toISOString();
const ids = (report: AdviceReport) => report.proposals.map((p) => p.id);
const byId = (report: AdviceReport, id: string) => report.proposals.find((p) => p.id === id);

/** The example on one Hetzner cx23 in nbg1, deployed, without backups. */
function onePlan(): DeployPlan {
  const base = testPlan();
  return deployed({ ...base, target: { ...base.target, backups: false } as DeployPlan["target"] });
}

/** The interview: important data, central Europe, €10 a month. */
const REQUIREMENTS = makeRequirements({ dataCriticality: "important" });

/** One alert and Dependabot's pull request, a token expiring in 5 days. */
const ALERTS: DependabotAlerts = {
  state: "on",
  alerts: [
    { severity: "high", package: "lodash", url: "https://github.com/example/example-app/1" },
  ],
};
const PULL = {
  number: 7,
  title: "Bump lodash from 4.17.20 to 4.17.21",
  createdAt: "2026-11-01T08:00:00Z",
  url: "https://github.com/example/example-app/pull/7",
};

/** The app's server short of memory, a reboot pending and 3 security updates waiting. */
const SHORT: FakeHost = {
  figures: figuresOutput("shop", {
    memory: 0.92,
    containers: [
      { service: "app", usedMb: 120, limitMb: 512 },
      { service: "db", usedMb: 300, limitMb: 1024 },
    ],
  }),
  checks: { "reboot-required": "yes", "security-updates": "3" },
};

/** {@link onePlan}'s project, its server `SHORT`, and GitHub with `ALERTS`, `PULL` and the token. */
function oneServer(o: Partial<ScenarioInit> = {}): Promise<Scenario> {
  return scenario({
    plan: onePlan(),
    host: SHORT,
    github: new FakeAdviseGitHub({ alerts: ALERTS, pulls: [PULL], expiry: inDays(5) }),
    ...o,
  });
}

/** Each proposal is one `--json` and the MCP tool can give. */
function valid(report: AdviceReport): AdviceReport {
  for (const proposal of report.proposals) expect(ProposalSchema.parse(proposal)).toEqual(proposal);
  return report;
}

/** No address, token or secret in what advise said, audited or returned. */
function expectNoLeak(deps: TestPhaseDeps, secrets: string[], ...more: unknown[]) {
  const said = [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(more),
  ].join("\n");
  for (const value of [...Object.values(IPS), ...secrets]) expect(said).not.toContain(value);
}

describe("runAdvise: refusing", () => {
  it("refuses an environment that isn't provisioned, before reading anything", async () => {
    const plan = testPlan();
    const s = await oneServer({ plan });
    const error = await runAdvise(s.deps, plan, s.options).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
    expect((error as OpsCrewError).message).toBe(
      "The prod environment is not provisioned, so advise has nothing to read. Nothing was changed.",
    );
    expect((error as OpsCrewError).hint).toBe(
      "Run `opscrew provision` first, then `opscrew advise` again.",
    );
    expect(s.servers.commands).toEqual([]);
    expect(s.github?.calls).toEqual([]);
    expect(s.deps.audit.entries).toEqual([]);
  });
});

describe("runAdvise: one server", () => {
  it("reads every source, runs the rules and orders them by urgency, then category", async () => {
    const s = await oneServer();
    const report = valid(await runAdvise(s.deps, s.plan, s.options));
    expect(ids(report)).toEqual([
      // now: a reboot for security updates, then a token about to expire
      "security.app.reboot",
      "upkeep.env.github-token",
      // soon: a short server, then security
      "size.app.larger",
      "security.env.dependabot-alerts",
      "security.app.updates",
      // when convenient
      "reliability.app.backups",
      "reliability.env.check",
    ]);
    expect(byId(report, "size.app.larger")).toMatchObject({
      apply: { kind: "plan", change: { kind: "server-type", server: "app", serverType: "cx33" } },
      reasons: expect.arrayContaining([
        expect.objectContaining({ basis: { kind: "one-reading", at: NOW.toISOString() } }),
      ]),
    });
    expect(report.basis).toEqual({ app: { kind: "one-reading", at: NOW.toISOString() } });
    // Monitoring off on a server OpsCrew created: its history would let advise propose smaller.
    expect(report.suggestMonitoring).toBe(true);
    expect(report.checked).toEqual([
      "the plan",
      "the interview's answers",
      "server app's figures",
      "secure's host checks on server app",
      "Hetzner Cloud's prices in nbg1",
      "DigitalOcean's prices in fra1",
      "DigitalOcean's prices in ams3",
      "Dependabot alerts",
      "Dependabot's open pull requests",
      "the GitHub token's expiry",
    ]);
    // No tokens here: the dated static prices, said so.
    expect(report.notRead).toEqual([
      expect.stringMatching(
        /^live prices: DIGITALOCEAN_TOKEN is not set, so prices come from DigitalOcean's published price list dated \d{4}-\d{2}-\d{2}/,
      ),
      expect.stringMatching(
        /^live prices: HCLOUD_TOKEN is not set, so prices come from Hetzner's published price list dated \d{4}-\d{2}-\d{2}/,
      ),
    ]);
    expect(s.github?.calls).toEqual([
      "dependabotAlerts example/example-app",
      "dependabotPulls example/example-app",
      "tokenExpiry",
    ]);
  });

  it("reads the check's issues of the last 14 days when the check is on", async () => {
    const base = onePlan();
    const plan = DeployPlanSchema.parse({ ...base, observability: { check: { enabled: true } } });
    const issues = [3, 2, 1].map((day) => ({ number: day, createdAt: inDays(-day) }));
    const github = new FakeAdviseGitHub({ issues });
    const s = await oneServer({ plan, github });
    const report = await runAdvise(s.deps, plan, s.options);
    expect(github.calls).toContain(`issuesSince example/example-app opscrew-check ${inDays(-14)}`);
    expect(report.checked).toContain("the scheduled check's issues of the last 14 days");
    expect(ids(report)).toContain("reliability.env.check-flaps");
    expect(ids(report)).not.toContain("reliability.env.check");
  });

  it("reads the Cloudflare token's expiry when one is configured", async () => {
    const cloudflare = {
      verifyToken: async () => ({
        ok: true,
        identity: "user API token",
        message: "The Cloudflare token is active.",
        status: "active" as const,
        expiresOn: inDays(20),
      }),
    };
    const s = await oneServer({ cloudflare });
    const report = await runAdvise(s.deps, s.plan, s.options);
    expect(report.checked).toContain("the Cloudflare token's expiry");
    expect(byId(report, "upkeep.env.cloudflare-token")?.urgency).toBe("soon");
  });

  it("says when there is nothing to propose, with what it checked", async () => {
    const plan = DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      observability: { check: { enabled: true } },
    });
    const s = await oneServer({
      plan,
      host: { figures: figuresOutput("shop") },
      github: new FakeAdviseGitHub(),
    });
    const report = await runAdvise(s.deps, plan, s.options);
    expect(report.proposals).toEqual([]);
    expect(report.checked.length).toBeGreaterThan(5);
  });

  it("gives a site on Cloudflare's hosting only the upkeep proposals, and reads no server", async () => {
    const plan = deployed(sitePlan());
    const s = await oneServer({ plan });
    const report = valid(await runAdvise(s.deps, plan, s.options));
    expect(ids(report)).toEqual(["upkeep.env.github-token", "security.env.dependabot-alerts"]);
    expect(report.basis).toEqual({});
    expect(s.servers.commands).toEqual([]);
  });
});

describe("runAdvise: several servers, history", () => {
  /** Postgres on server `data`, the monitoring stack on the app's server: 14 and 5 days. */
  async function split(
    o: {
      prometheus?: boolean;
      plan?: DeployPlan;
      data?: FakeHost;
      tfvars?: ProjectInit["tfvars"];
    } = {},
  ) {
    const plan = o.plan ?? deployed(networked(monitoredPlan({ on: "app" })).plan);
    const deps = await project({
      plan,
      addresses: { app: IPS.app, servers: { data: IPS.data } },
      requirements: REQUIREMENTS,
      ...(o.tfvars === undefined ? {} : { tfvars: o.tfvars }),
    });
    const servers = fakeServers({
      [IPS.app]: {
        figures: figuresOutput("shop", { memory: 0.88 }),
        ...(o.prometheus === false ? {} : { prometheus: await recordedHistory() }),
      },
      [IPS.data]: o.data ?? {
        figures: figuresOutput("shop", {
          containers: [{ service: "db", usedMb: 300, limitMb: 512 }],
        }),
      },
    });
    const options: RunAdviseOptions = {
      services: { remote: servers.remote },
      github: new FakeAdviseGitHub(),
      cloudflare: null,
    };
    return { deps, plan, servers, options };
  }

  it("advises on each server by its name, on 14 days of figures where there are", async () => {
    const s = await split();
    const report = valid(await runAdvise(s.deps, s.plan, s.options));
    expect(report.basis).toEqual({
      app: { kind: "history", days: 14 },
      data: { kind: "history", days: 5 },
    });
    // Monitoring is on: nothing to suggest.
    expect(report.suggestMonitoring).toBe(false);
    expect(byId(report, "size.app.larger")?.reasons).toContainEqual(
      expect.objectContaining({ basis: { kind: "history", days: 14 } }),
    );
    expect(byId(report, "reliability.data.restart-loop-db")).toMatchObject({
      server: "data",
      reasons: [expect.objectContaining({ basis: { kind: "history", days: 5 } })],
    });
    expect(report.checked).toEqual(
      expect.arrayContaining([
        "server app's figures",
        "server data's figures",
        "secure's host checks on server app",
        "secure's host checks on server data",
        "the monitoring stack's 14 days of figures",
      ]),
    );
    expect(new Set(s.servers.commands.map((c) => c.host))).toEqual(new Set([IPS.app, IPS.data]));
    expectNoLeak(s.deps, [], report);
  });

  it("falls back to one reading when the stack doesn't answer, and says so", async () => {
    const s = await split({ prometheus: false });
    const report = await runAdvise(s.deps, s.plan, s.options);
    expect(report.basis).toEqual({
      app: { kind: "one-reading", at: NOW.toISOString() },
      data: { kind: "one-reading", at: NOW.toISOString() },
    });
    expect(report.notRead).toContain(
      "the monitoring stack's 14 days of figures: OpsCrew could not reach it (`opscrew status` says why)",
    );
    expectNoLeak(s.deps, [], report);
  });

  it("says an extra server's type is already in the plan when provision hasn't applied it", async () => {
    const base = networked(splitPlan()).plan;
    const plan = deployed({
      ...base,
      servers: base.servers?.map((s) => ({
        ...s,
        target: { ...s.target, serverType: "cx33" },
      })) as DeployPlan["servers"],
    });
    // provision last rendered data's cx23; its memory is short.
    const data = extraServerVariables("data");
    const s = await split({
      plan,
      tfvars: { [data.location]: "nbg1", [data.serverType]: "cx23" },
      data: {
        figures: figuresOutput("shop", {
          memory: 0.92,
          containers: [{ service: "db", usedMb: 300, limitMb: 512 }],
        }),
      },
    });
    const report = valid(await runAdvise(s.deps, plan, s.options));
    expect(byId(report, "size.data.larger")).toMatchObject({
      title:
        "Move server data to cx33 (4 vCPU, 8 GB memory, 80 GB disk): already in the plan, not provisioned yet",
      apply: { kind: "command", command: "opscrew provision" },
    });
  });
});

describe("runAdvise: each source on its own", () => {
  const cases: {
    name: string;
    setup: () => Promise<Scenario>;
    line: string | RegExp;
    still: string;
  }[] = [
    {
      name: "the server's figures",
      setup: () => oneServer({ host: { checks: { "reboot-required": "yes" } } }),
      line: "server app's figures: OpsCrew could not reach it (`opscrew status` says why)",
      still: "security.app.reboot",
    },
    {
      name: "a host check whose command could not run",
      setup: () =>
        oneServer({
          host: {
            ...SHORT,
            checks: {
              "reboot-required": new Error(
                `ssh: connect to host ${IPS.app} port 22: Connection refused`,
              ),
            },
          },
        }),
      line: 'server app\'s host check "No reboot pending": its command could not run',
      still: "size.app.larger",
    },
    {
      name: "the login to the server",
      setup: () => oneServer({ init: { addresses: {} } }),
      line: "secure's host checks on server app: this computer lacks the login or address OpsCrew needs (`opscrew secure` says which)",
      still: "security.env.dependabot-alerts",
    },
    {
      name: "the interview's answers",
      setup: async () => {
        const s = await oneServer();
        const { rm } = await import("node:fs/promises");
        await rm(s.deps.paths.files.shared.requirementsBase);
        return s;
      },
      line: /^the interview's answers: /,
      still: "size.app.larger",
    },
    {
      name: "a GitHub token",
      setup: () => oneServer({ github: null }),
      line: "Dependabot alerts, Dependabot's open pull requests and the GitHub token's expiry: no GitHub token is available (set GITHUB_TOKEN or run `gh auth login`)",
      still: "size.app.larger",
    },
    {
      name: "the permission Dependabot alerts: Read",
      setup: () =>
        oneServer({
          github: new FakeAdviseGitHub({
            alerts: new OpsCrewError(
              "CREDENTIALS_INVALID",
              "GitHub refused to read the Dependabot alerts of example/example-app: the token lacks a permission.",
              { hint: "Add Dependabot alerts: Read to the token." },
            ),
            pulls: [PULL],
          }),
        }),
      line: 'Dependabot alerts: the GitHub token lacks the permission "Dependabot alerts: Read"; add it to the token to have them read',
      still: "size.app.larger",
    },
    {
      name: "Dependabot's pull requests",
      setup: () =>
        oneServer({
          github: new FakeAdviseGitHub({
            alerts: ALERTS,
            pulls: new OpsCrewError("PROVIDER_ERROR", "GitHub did not answer."),
          }),
        }),
      line: "Dependabot's open pull requests: GitHub did not answer.",
      still: "security.env.dependabot-alerts",
    },
    {
      name: "the GitHub token's expiry",
      setup: () =>
        oneServer({
          github: new FakeAdviseGitHub({
            expiry: new OpsCrewError("PROVIDER_ERROR", "GitHub did not answer."),
          }),
        }),
      line: "the GitHub token's expiry: GitHub did not answer.",
      still: "size.app.larger",
    },
    {
      name: "the Cloudflare token's check",
      setup: () =>
        oneServer({
          cloudflare: {
            verifyToken: async () => ({ ok: false, message: "The Cloudflare token was rejected." }),
          },
        }),
      line: "the Cloudflare token's expiry: The Cloudflare token was rejected.",
      still: "size.app.larger",
    },
    {
      name: "an account-owned Cloudflare token's expiry",
      setup: () =>
        oneServer({
          cloudflare: {
            verifyToken: async () => ({
              ok: true,
              identity: "account API token",
              message: "The Cloudflare token can read zones.",
            }),
          },
        }),
      line: "the Cloudflare token's expiry: Cloudflare gives none for an account-owned token",
      still: "size.app.larger",
    },
    {
      name: "live prices with a token that fails",
      setup: async () => {
        const s = await oneServer({ init: { env: { HCLOUD_TOKEN: fakeSecret("hcloud-token") } } });
        // Hetzner refuses the token.
        s.deps.fetch = async () =>
          new Response('{"error":{"code":"unauthorized"}}', { status: 401 });
        return s;
      },
      line: /^live prices: The Hetzner token could not be used/,
      still: "size.app.larger",
    },
  ];

  for (const c of cases) {
    it(`lists ${c.name} as not read and goes on`, async () => {
      const s = await c.setup();
      const report = valid(await runAdvise(s.deps, s.plan, s.options));
      expect(report.notRead).toContainEqual(
        typeof c.line === "string" ? c.line : expect.stringMatching(c.line),
      );
      expect(ids(report)).toContain(c.still);
      expectNoLeak(
        s.deps,
        Object.values(s.deps.env).filter((v) => v !== undefined),
        report,
      );
    });
  }

  it("leaves a server it couldn't read out of the basis, and its size out of the proposals", async () => {
    const s = await oneServer({ host: { checks: {} } });
    const report = await runAdvise(s.deps, s.plan, s.options);
    expect(report.basis).toEqual({});
    expect(report.proposals.filter((p) => p.category === "size")).toEqual([]);
  });
});

describe("runAdvise: changes nothing", () => {
  it("writes no file, and audits only reads", async () => {
    const s = await oneServer();
    const before = await tree(s.deps.paths.root);
    await runAdvise(s.deps, s.plan, s.options);
    expect(await tree(s.deps.paths.root)).toEqual(before);
    expect(s.deps.audit.entries.length).toBeGreaterThan(0);
    for (const entry of s.deps.audit.entries) {
      expect(entry).toMatchObject({ kind: "remote-exec", decision: "allow" });
      expect(entry.action).toContain("(read-only)");
    }
    // The server got `status`'s fixed figures command and `secure`'s host checks, nothing else.
    const fixed = new Set([
      serverFiguresCommand("shop"),
      ...[...HOST_CHECKS, ...serverServiceChecks(s.plan)].map((check) => check.command),
    ]);
    expect(s.servers.commands.length).toBeGreaterThan(1);
    for (const { command } of s.servers.commands) expect(fixed).toContain(command);
  });

  it("keeps the address of a server the user owns out when reaching it fails", async () => {
    const plan = ownPlan({ deployed: true });
    const deps = await project({ plan, requirements: REQUIREMENTS });
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "alice",
      agent: true,
      reachable: true,
    });
    let tried = 0;
    const refusing = (host: string): RemoteExec => ({
      host,
      run: async () => {
        tried += 1;
        throw new OpsCrewError(
          "COMMAND_FAILED",
          `ssh: connect to host ${host} port 22: Connection refused`,
        );
      },
    });
    const report = await runAdvise(deps, plan, {
      services: { remote: refusing, own: { remote: (connection) => refusing(connection.host) } },
      github: new FakeAdviseGitHub(),
      cloudflare: null,
    });
    expect(tried).toBeGreaterThan(0);
    expect(report.notRead).toContainEqual(expect.stringMatching(/^server app's figures: /));
    expect(report.notRead.join("\n")).toMatch(/secure's host check/);
    // A server the user owns can't be resized: no monitoring to suggest.
    expect(report.suggestMonitoring).toBe(false);
    expectNoLeak(deps, [OWN_IPV4], report);
  });

  it("keeps the Portainer's address and token out when its API fails", async () => {
    const token = fakeSecret("generic-password", "portainer-token");
    const plan = portainerPlan({ deployed: true });
    const deps = await project({
      plan,
      requirements: REQUIREMENTS,
      env: { PORTAINER_API_KEY: token },
    });
    await recordPortainerConnection(deps.paths, {
      url: PORTAINER_URL,
      certFingerprint: fakeCertificate().fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
    });
    const down = async (): Promise<never> => {
      throw new OpsCrewError("PROVIDER_ERROR", `Portainer at ${PORTAINER_URL} did not answer.`);
    };
    const client = () => ({ listContainers: down, dockerInfo: down }) as unknown as PortainerClient;
    const report = await runAdvise(deps, plan, {
      services: { portainer: { client } },
      github: new FakeAdviseGitHub(),
      cloudflare: null,
    });
    expect(report.notRead).toContain(
      "server app's figures: OpsCrew could not reach it (`opscrew status` says why)",
    );
    expectNoLeak(deps, [PORTAINER_URL, PORTAINER_HOST, token], report);
  });

  it("keeps every address and token out of the report, the steps and the audit", async () => {
    const env = {
      GITHUB_TOKEN: fakeSecret("github-token"),
      CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
    };
    const plan = deployed(networked(monitoredPlan({ on: "app" })).plan);
    const deps = await project({
      plan,
      addresses: { app: IPS.app, servers: { data: IPS.data } },
      requirements: REQUIREMENTS,
      env,
    });
    const servers = fakeServers({
      [IPS.app]: {
        ...SHORT,
        checks: { "security-updates": new Error(`ssh ${IPS.app}: broken pipe`) },
      },
    });
    const report = await runAdvise(deps, plan, {
      services: { remote: servers.remote },
      github: new FakeAdviseGitHub({ alerts: ALERTS, expiry: inDays(3) }),
      cloudflare: {
        verifyToken: async () => ({ ok: false, message: "The Cloudflare token was rejected." }),
      },
    });
    expect(report.notRead.length).toBeGreaterThan(3);
    expectNoLeak(deps, Object.values(env), report);
  });
});

describe("runAdvise: environments and apps", () => {
  it("reads only its environment's servers, and names it in every command", async () => {
    const prod = await oneServer();
    const plan = inEnvironment(onePlan(), "staging");
    const staging = await project({
      plan,
      root: prod.deps.paths.root,
      environment: "staging",
      addresses: { app: IPS.stagingApp },
      requirements: REQUIREMENTS,
    });
    const servers = fakeServers({
      [IPS.app]: SHORT,
      [IPS.stagingApp]: { ...SHORT, checks: { "unattended-upgrades": "disabled" } },
    });
    const report = await runAdvise(staging, plan, {
      services: { remote: servers.remote },
      github: new FakeAdviseGitHub({ alerts: ALERTS }),
      cloudflare: null,
    });
    expect(new Set(servers.commands.map((c) => c.host))).toEqual(new Set([IPS.stagingApp]));
    const commands = report.proposals.flatMap((p) =>
      p.apply.kind === "command" ? [p.apply.command] : [],
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).toMatch(/ --env staging$/);
    // The scheduled check is for prod: staging gets none.
    expect(ids(report)).not.toContain("reliability.env.check");
  });

  it("names a further app in every command", async () => {
    const plan = deployed({ ...onePlan(), app: { ...onePlan().app, key: "docs", name: "docs" } });
    const s = await oneServer({
      plan,
      init: { app: "docs" },
      host: {
        ...SHORT,
        figures: figuresOutput("docs", { memory: 0.92 }),
        checks: { "unattended-upgrades": "disabled" },
      },
    });
    const report = await runAdvise(s.deps, plan, s.options);
    expect(byId(report, "security.app.host-checks")?.apply).toEqual({
      kind: "command",
      command: "opscrew secure --app docs",
    });
  });
});

describe("runAdvise: a move in progress", () => {
  it("reports a move to another provider and proposes nothing that changes the plan", async () => {
    const plan = movingPlan();
    const s = await oneServer({ plan });
    const report = valid(await runAdvise(s.deps, plan, s.options));
    expect(report.proposals[0]).toEqual({
      id: "moving.env.retarget",
      category: "moving",
      urgency: "now",
      title: "Finish the move in progress before other changes",
      reasons: [
        {
          text: "A move to DigitalOcean is in progress; run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it",
          basis: { kind: "plan" },
        },
        {
          text: "Until it finishes, advise proposes nothing that changes the servers or the plan",
          basis: { kind: "plan" },
        },
      ],
      apply: { kind: "command", command: "opscrew retarget" },
    });
    const others = report.proposals.slice(1);
    expect(others.length).toBeGreaterThan(0);
    for (const proposal of others) {
      expect(proposal.apply.kind).not.toBe("plan");
      expect(["size", "cost", "components"]).not.toContain(proposal.category);
    }
  });

  it("names the environment's flags, and only the abort once one began", async () => {
    const moving = inEnvironment(movingPlan(), "staging");
    const plan = DeployPlanSchema.parse({
      ...moving,
      retarget: { ...moving.retarget, abort: { step: "started" } },
    });
    const prod = await oneServer();
    const deps = await project({
      plan,
      root: prod.deps.paths.root,
      environment: "staging",
      addresses: { app: IPS.stagingApp },
      requirements: REQUIREMENTS,
    });
    const servers = fakeServers({ [IPS.stagingApp]: SHORT });
    const report = await runAdvise(deps, plan, {
      services: { remote: servers.remote },
      github: new FakeAdviseGitHub(),
      cloudflare: null,
    });
    expect(report.proposals[0]).toMatchObject({
      id: "moving.env.retarget",
      reasons: [
        {
          text: "A move to DigitalOcean is being aborted; run `opscrew retarget --env staging --abort` to finish the abort, which continues where it stopped and puts the app back on the previous server",
        },
        {
          text: "Until it finishes, advise proposes nothing that changes the servers or the plan",
        },
      ],
      apply: { kind: "command", command: "opscrew retarget --env staging --abort" },
    });
  });

  it("reports a service moving between the app's servers", async () => {
    const split = networked(monitoredPlan({ on: "app" })).plan;
    const plan = deployed(
      DeployPlanSchema.parse({
        ...split,
        move: { service: "db", from: "app", to: "data", step: "started", copy: "dump" },
      }),
    );
    const s = await oneServer({ plan, init: { addresses: { app: IPS.app } } });
    const report = valid(await runAdvise(s.deps, plan, s.options));
    expect(report.proposals[0]).toMatchObject({
      id: "moving.env.move",
      category: "moving",
      apply: { kind: "command", command: "opscrew provision" },
    });
    expect(report.proposals[0]?.reasons[0]?.text).toBe(
      "db is moving from the app's server to server data; `opscrew provision` continues the move",
    );
    expect(report.proposals.some((p: Proposal) => p.apply.kind === "plan")).toBe(false);
  });
});

describe("runAdvise: a proposal the plan already holds", () => {
  it("says so for a server type written but not provisioned yet, and names provision", async () => {
    const base = onePlan();
    const plan = deployed({
      ...base,
      target: { ...base.target, serverType: "cx33" } as DeployPlan["target"],
    });
    // provision last rendered the cx23.
    const s = await oneServer({
      plan,
      init: { tfvars: { location: "nbg1", server_type: "cx23", backups: false } },
    });
    const report = valid(await runAdvise(s.deps, plan, s.options));
    const larger = byId(report, "size.app.larger");
    expect(larger).toMatchObject({
      title:
        "Move server app to cx33 (4 vCPU, 8 GB memory, 80 GB disk): already in the plan, not provisioned yet",
      apply: { kind: "command", command: "opscrew provision" },
    });
    expect(larger?.reasons.at(-1)?.text).toBe(
      "The plan already holds this change; `opscrew provision` shows the change and applies it once you approve its hash",
    );
  });

  it("says so for a memory limit written but not deployed yet", async () => {
    const base = onePlan();
    const plan = deployed({ ...base, app: { ...base.app, memoryMb: 768 } });
    const s = await oneServer({
      plan,
      host: {
        figures: figuresOutput("shop", {
          containers: [{ service: "app", usedMb: 500, limitMb: 512 }],
        }),
      },
    });
    const report = await runAdvise(s.deps, plan, s.options);
    expect(byId(report, "size.app.app-limit")).toMatchObject({
      apply: { kind: "command", command: "opscrew provision" },
    });
  });
});
