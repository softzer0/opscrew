import { readFile } from "node:fs/promises";
import { OpsCrewError } from "@opscrew/core";
import {
  type Architecture,
  type DeployPlan,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordOwnServerAnswers } from "../interview";
import { type OwnServerFacts, ownServerConnector } from "../providers";
import { recordOwnServer } from "../shared";
import {
  autoBuild,
  createTestPhaseDeps,
  euCatalog,
  makeFacts,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
  type TestPhaseDeps,
} from "../testing";
import {
  buildOwnServerOption,
  distinctAmounts,
  OWN_SERVER_BACKUPS_NOTE,
  OWN_SERVER_LOCATION,
  OWN_SERVER_TYPE,
  type OwnServerAccess,
  type OwnServerOptionInput,
} from "./own";
import { optionToPlan } from "./plan";
import { previewDesignOptions, runDesign } from "./run";

const IPV4 = "203.0.113.10";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const BIG: OwnServerFacts = {
  arch: "arm64",
  vcpus: 4,
  memoryGb: 8,
  diskFreeGb: 120,
  os: "Ubuntu 24.04",
};

const ownRequirements = (overrides: Partial<Requirements> = {}): Requirements => {
  const { region: _region, ...base } = makeRequirements();
  return { ...base, provider: "own", ...overrides };
};

/** The single own-server option, served directly unless `access` says otherwise. */
const ownOptions = async (
  input: Omit<OwnServerOptionInput, "access"> & { access?: OwnServerAccess },
) => [(await buildOwnServerOption({ access: "public", ...input })).option];

const catalogOf = (facts: OwnServerFacts) =>
  ownServerConnector({ facts, now: () => NOW }).catalog();

describe("buildOwnServerOption", () => {
  it("offers the inspected server as one recommended option without a price", async () => {
    const requirements = ownRequirements({ budgetMonthly: { amount: 20, currency: "USD" } });
    const options = await ownOptions({
      facts: staticSpaFacts(),
      requirements,
      catalog: catalogOf(BIG),
    });
    expect(options).toHaveLength(1);
    const [option] = options;
    expect(option).toMatchObject({
      id: "own-server",
      title: "Your server",
      target: {
        provider: "own",
        vcpus: 4,
        memoryGb: 8,
        diskGb: 120,
        architecture: "arm",
      },
      backups: false,
      fitsBudget: true,
      recommended: true,
      cost: {
        monthly: { amount: 0, currency: "USD" },
        breakdown: [
          {
            item: "Your own server (you already pay for it)",
            monthly: { amount: 0, currency: "USD" },
          },
        ],
      },
    });
    expect(option?.summary).toContain("No server price: you already pay for this server.");
    expect(option?.summary).toContain(OWN_SERVER_BACKUPS_NOTE);
    expect(option?.summary).toContain("Ubuntu 24.04");
    expect(option?.tradeoffs).toContain(OWN_SERVER_BACKUPS_NOTE);
    expect(option?.tradeoffs.join(" ")).toMatch(/builds the app image for arm64/);
    expect(option?.tradeoffs.join(" ")).not.toMatch(/memory|free disk/);
  });

  it("never shows the schema placeholders in what the user reads", async () => {
    const [option] = await ownOptions({
      facts: nextPostgresFacts(),
      requirements: ownRequirements(),
      catalog: catalogOf(BIG),
    });
    if (option === undefined) throw new Error("no option");
    expect(option.summary).toBe(
      "Your own server (4 vCPU, 8 GB memory, 120 GB free disk, arm64, Ubuntu 24.04) running the app and Postgres with Docker Compose behind Caddy. Memory limits: the app 512 MB, db 512 MB; OpsCrew's edge and the system 512 MB; 6.5 GB of 8.0 GB free. No server price: you already pay for this server. OpsCrew cannot turn on backups or snapshots on your own server; backups are your responsibility.",
    );
    expect(option.target).toMatchObject({
      serverType: OWN_SERVER_TYPE,
      location: OWN_SERVER_LOCATION,
    });
    // How the CLI and the MCP server print an option's server line.
    const t = option.target;
    const serverLine = `Server: ${t.serverType} in ${t.location}, ${t.vcpus} vCPU (${t.cpuType}), ${t.memoryGb} GB RAM, ${t.diskGb} GB disk`;
    expect(serverLine).toBe(
      "Server: your server in its current location, 4 vCPU (shared), 8 GB RAM, 120 GB disk",
    );
    // "own" only ever appears as "your own server", never as a bare placeholder.
    const placeholder = /\bown\b(?! server)/i;
    for (const text of [option.title, option.summary, serverLine, ...option.tradeoffs]) {
      expect(text).not.toMatch(placeholder);
    }
  });

  it("warns when the server's memory or free disk are below the app's needs", async () => {
    const options = await ownOptions({
      facts: nextPostgresFacts(),
      requirements: ownRequirements(),
      catalog: catalogOf({ arch: "amd64", vcpus: 1, memoryGb: 1.95, diskFreeGb: 25 }),
    });
    const tradeoffs = options[0]?.tradeoffs.join("\n") ?? "";
    // Next.js with Postgres for fewer than 1,000 users: 4 GB memory and 30 GB of free disk
    // (10 GB for the app and its images, 20 GB for the database; the OS is already installed).
    expect(tradeoffs).toMatch(
      /Your server has 2 GB of memory, but OpsCrew plans at least 4 GB for the app and Postgres/,
    );
    expect(tradeoffs).toMatch(
      /Your server has 25 GB of free disk, but OpsCrew plans at least 30 GB of free disk/,
    );
    expect(tradeoffs).toMatch(/Postgres runs in a container on the same server; back up its data/);
  });

  describe("size boundaries", () => {
    const warningsFor = async (
      facts: Parameters<typeof nextPostgresFacts>[0] | "static",
      server: Partial<OwnServerFacts>,
    ) => {
      const { warnings } = await buildOwnServerOption({
        facts: facts === "static" ? staticSpaFacts() : nextPostgresFacts(facts),
        requirements: ownRequirements(),
        catalog: catalogOf({ arch: "amd64", vcpus: 1, memoryGb: 8, diskFreeGb: 100, ...server }),
        access: "public",
      });
      return warnings.join("\n");
    };

    it("does not warn about a server that is big enough once the OS is installed", async () => {
      // A 40 GB server with 36 GB free and a static app: the OS is not part of the app's need.
      expect(await warningsFor("static", { diskFreeGb: 36 })).toBe("");
      // A "1 GB" server reports about 0.95 GB; a static SPA needs 1 GB.
      expect(await warningsFor("static", { memoryGb: 0.95 })).toBe("");
      // Exactly the need is fine too.
      expect(await warningsFor({}, { memoryGb: 4, diskFreeGb: 30 })).toBe("");
      expect(await warningsFor({}, { memoryGb: 3.6, diskFreeGb: 30 })).toBe("");
    });

    it("warns about real shortfalls, with numbers that never read the same", async () => {
      expect(await warningsFor("static", { memoryGb: 0.89 })).toMatch(
        /Your server has 0\.9 GB of memory, but OpsCrew plans at least 1 GB/,
      );
      expect(await warningsFor({}, { memoryGb: 3.5 })).toMatch(
        /has 3\.5 GB of memory, but OpsCrew plans at least 4 GB/,
      );
      expect(await warningsFor("static", { diskFreeGb: 9.6 })).toMatch(
        /has 9\.6 GB of free disk, but OpsCrew plans at least 10 GB of free disk/,
      );
      expect(await warningsFor({}, { diskFreeGb: 20 })).toMatch(
        /has 20 GB of free disk, but OpsCrew plans at least 30 GB/,
      );
    });

    it("warns once below an engine's smallest server, naming the engine", async () => {
      const { warnings } = await buildOwnServerOption({
        facts: makeFacts({
          services: [
            { kind: "opensearch", evidence: ["dependency:@opensearch-project/opensearch"] },
          ],
        }),
        requirements: ownRequirements(),
        catalog: catalogOf({ arch: "amd64", vcpus: 2, memoryGb: 2, diskFreeGb: 100 }),
        access: "public",
      });
      expect(warnings).toEqual([
        "OpenSearch (opensearch) runs comfortably only on a server with at least 4 GB of memory, and yours has 2 GB, so it may slow down or stop when memory runs out. Add memory to the server, or turn the service off in opscrew/plan.yaml (enabled: false) and give the app a hosted OpenSearch's address instead.",
      ]);
    });

    it("warns about a full disk instead of failing", async () => {
      const facts = staticSpaFacts();
      const { option, warnings } = await buildOwnServerOption({
        facts,
        requirements: ownRequirements(),
        catalog: catalogOf({ arch: "amd64", vcpus: 1, memoryGb: 2, diskFreeGb: 0 }),
        access: "public",
      });
      expect(warnings.join("\n")).toMatch(/has 0 GB of free disk, but OpsCrew plans at least 10/);
      expect(option.summary).toContain("0 GB free disk");
    });

    it("shows decimals only when rounding would make both amounts the same", () => {
      expect(distinctAmounts(2, 4)).toEqual(["2", "4"]);
      expect(distinctAmounts(1.95, 4)).toEqual(["2", "4"]);
      expect(distinctAmounts(0.89, 1)).toEqual(["0.9", "1"]);
      expect(distinctAmounts(3.96, 4)).toEqual(["3.96", "4"]);
      expect(distinctAmounts(9.6, 10)).toEqual(["9.6", "10"]);
    });
  });

  it("explains the tunnel and that it needs a domain on Cloudflare", async () => {
    const build = (requirements: Requirements) =>
      ownOptions({
        facts: staticSpaFacts(),
        requirements,
        catalog: catalogOf(BIG),
        access: "tunnel",
      });
    const without = (await build(ownRequirements()))[0];
    expect(without?.tradeoffs.join(" ")).toMatch(
      /Cloudflare Tunnel, which needs a domain on your Cloudflare account, and you have not given one/,
    );
    const withDomain = (
      await build(ownRequirements({ domain: "app.example.com", dnsProvider: "cloudflare" }))
    )[0];
    expect(withDomain?.summary).toMatch(/served through a Cloudflare Tunnel/);
    expect(withDomain?.tradeoffs.join(" ")).not.toMatch(/have not given one/);
  });

  it("stops plainly before the server is inspected and refuses another provider's catalogue", async () => {
    const error = await ownOptions({
      facts: staticSpaFacts(),
      requirements: ownRequirements(),
      catalog: ownServerConnector().catalog(),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(/has not inspected your server yet/),
    });
    await expect(
      ownOptions({
        facts: staticSpaFacts(),
        requirements: ownRequirements(),
        catalog: euCatalog(),
      }),
    ).rejects.toThrow(/own-server catalogue but got the hetzner one/);
  });

  it("turns the option into an own-server target and needs the access mode", async () => {
    const facts = staticSpaFacts();
    // A tunnel serves the app on a Cloudflare domain.
    const requirements = ownRequirements({ domain: "app.example.com", dnsProvider: "cloudflare" });
    const [option] = await ownOptions({ facts, requirements, catalog: catalogOf(BIG) });
    if (option === undefined) throw new Error("no option");
    const plan = optionToPlan(option, {
      facts,
      requirements,
      now: NOW,
      codeChanges: [],
      build: autoBuild(facts),
      access: "tunnel",
    });
    expect(plan.target).toEqual({
      provider: "own",
      mode: "vps-compose",
      arch: "arm64",
      access: "tunnel",
    });
    expect(() =>
      optionToPlan(option, {
        facts,
        requirements,
        now: NOW,
        codeChanges: [],
        build: autoBuild(facts),
      }),
    ).toThrow(/access mode/);
  });

  it("refuses a domain Cloudflare serves two levels below its zone, unless DNS only", async () => {
    const facts = staticSpaFacts();
    const requirements = ownRequirements({
      domain: "api.shop.example.com",
      dnsProvider: "cloudflare",
    });
    const [option] = await ownOptions({ facts, requirements, catalog: catalogOf(BIG) });
    if (option === undefined) throw new Error("no option");
    const input = { facts, requirements, now: NOW, codeChanges: [], build: autoBuild(facts) };
    const reason =
      "Cloudflare's free certificate covers only example.com and *.example.com, so api.shop.example.com would fail HTTPS at Cloudflare's edge. plan.yaml was not changed.";
    expect(() => optionToPlan(option, { ...input, access: "tunnel" })).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: reason,
        hint: "In `opscrew interview`, use a name one level below example.com, such as api-shop.example.com, or if the internet can reach your server, serve it with DNS only (server.reachable yes, server.serve dns-only).",
      }),
    );
    expect(() => optionToPlan(option, { ...input, access: "public", serving: "proxy" })).toThrow(
      expect.objectContaining({
        message: reason,
        hint: "In `opscrew interview`, use a name one level below example.com, such as api-shop.example.com, or serve it with DNS only (server.serve dns-only).",
      }),
    );
    const direct = optionToPlan(option, { ...input, access: "public", serving: "dns-only" });
    expect(direct.dns).toMatchObject({ domain: "api.shop.example.com", proxied: false });
  });
});

async function setup(requirements: Requirements): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({ clock: { now: () => NOW } });
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: staticSpaFacts(),
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  return deps;
}

const answers = (reachable: boolean, serve: "tunnel" | "proxy" | "dns-only" = "tunnel") => ({
  host: IPV4,
  port: 22,
  user: "root",
  agent: true,
  reachable,
  serve,
});

describe("runDesign for a server the user owns", () => {
  it("writes an own-server plan from the inspected facts and the interview's answers", async () => {
    const deps = await setup(ownRequirements());
    await recordOwnServerAnswers(deps.paths, answers(true));
    const result = await runDesign(deps, { ownServer: { facts: BIG } });

    expect(result.chosen.id).toBe("own-server");
    expect(result.priceSource).toBe("live");
    expect(result.plan.target).toEqual({
      provider: "own",
      mode: "vps-compose",
      arch: "arm64",
      access: "public",
    });
    expect(result.plan.cost.monthly.amount).toBe(0);
    const text = await readFile(deps.paths.files.plan, "utf8");
    expect(text).not.toContain(IPV4);
    expect(text).not.toMatch(/location:|serverType:|backups:|image:|own-server\.json/);
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(result.plan);
    const said = deps.reporter.text();
    expect(said).toMatch(/Your server \(own-server\): no server price/);
    expect(said).toContain(OWN_SERVER_BACKUPS_NOTE);
    expect(said).toMatch(/no server cost \(you already pay for this server\)/);
    expect(said).not.toMatch(/€|\$0/);
    // Apart from the option id, "own" only appears as "your own server".
    expect(said.replace(/own-server/g, "")).not.toMatch(/\bown\b(?! server)/i);
    expect((await deps.state.read()).phases.design).toMatchObject({
      status: "ok",
      summary: "own-server, no server cost",
    });
  });

  it("plans the tunnel for a server the internet cannot reach, with a Cloudflare domain", async () => {
    const deps = await setup(
      ownRequirements({ domain: "app.example.com", dnsProvider: "cloudflare" }),
    );
    await recordOwnServerAnswers(deps.paths, answers(false));
    const result = await runDesign(deps, { ownServer: { facts: { ...BIG, arch: "amd64" } } });
    expect(result.plan.target).toEqual({
      provider: "own",
      mode: "vps-compose",
      arch: "amd64",
      access: "tunnel",
    });
    expect(result.plan.dns).toMatchObject({ provider: "cloudflare", domain: "app.example.com" });
  });

  it("serves a reachable server with a Cloudflare domain as the user chose: the tunnel by default", async () => {
    const requirements = ownRequirements({ domain: "app.example.com", dnsProvider: "cloudflare" });
    const facts = { ...BIG, arch: "amd64" as const };

    // No choice recorded, or the tunnel: the tunnel, also for a reachable server.
    for (const serve of [undefined, "tunnel"] as const) {
      const deps = await setup(requirements);
      const { serve: _serve, ...base } = answers(true);
      // A record from before the serving question existed has no `serve`.
      if (serve === undefined) await recordOwnServer(deps.paths, base);
      else await recordOwnServerAnswers(deps.paths, answers(true, serve));
      const result = await runDesign(deps, { ownServer: { facts } });
      expect(result.plan.target).toMatchObject({ access: "tunnel" });
    }

    // Behind Cloudflare's proxy with the web filter: only as the explicit choice.
    const proxy = await setup(requirements);
    await recordOwnServerAnswers(proxy.paths, answers(true, "proxy"));
    const filtered = await runDesign(proxy, { ownServer: { facts } });
    expect(filtered.plan.target).toMatchObject({ access: "public" });
    expect(filtered.plan.dns).toMatchObject({ provider: "cloudflare", proxied: true });
    expect(filtered.plan.security.httpAllowedFrom).toBe("cloudflare");
    expect(filtered.chosen.summary).toMatch(/a filter in Docker lets only Cloudflare/);
    expect(filtered.chosen.tradeoffs.join(" ")).toMatch(/fails closed/);

    // DNS only: the server answers everyone; Cloudflare only answers DNS.
    const dnsOnly = await setup(requirements);
    await recordOwnServerAnswers(dnsOnly.paths, answers(true, "dns-only"));
    const open = await runDesign(dnsOnly, { ownServer: { facts } });
    expect(open.plan.target).toMatchObject({ access: "public" });
    expect(open.plan.dns).toMatchObject({ provider: "cloudflare", proxied: false });
    expect(open.plan.security.httpAllowedFrom).toBe("any");
    expect(open.chosen.tradeoffs.join(" ")).toMatch(/neither hides nor protects/);
  });

  it("refuses the web filter plainly for a server known only by an IPv6 address", async () => {
    const deps = await setup(
      ownRequirements({ domain: "app.example.com", dnsProvider: "cloudflare" }),
    );
    await recordOwnServer(deps.paths, { ...answers(true, "proxy"), host: "2001:db8::10" });
    const error = await runDesign(deps, { ownServer: { facts: BIG } }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(/needs your server's public IPv4 address/),
      hint: expect.stringMatching(/Cloudflare Tunnel/),
    });
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
    // With its public IPv4 address known, the filter mode is planned.
    await recordOwnServer(deps.paths, {
      ...answers(true, "proxy"),
      host: "2001:db8::10",
      publicIpv4: IPV4,
    });
    const result = await runDesign(deps, { ownServer: { facts: BIG } });
    expect(result.plan.dns).toMatchObject({ proxied: true });
  });

  it("serves a reachable server without a Cloudflare domain with DNS only, whatever the answer", async () => {
    const deps = await setup(ownRequirements());
    await recordOwnServerAnswers(deps.paths, answers(true, "proxy"));
    const result = await runDesign(deps, { ownServer: { facts: BIG } });
    expect(result.plan.target).toMatchObject({ access: "public" });
    expect(result.plan.dns).toMatchObject({ provider: "none", proxied: false });
  });

  it("refuses a tunnel without a Cloudflare domain before writing anything", async () => {
    const deps = await setup(ownRequirements());
    await recordOwnServerAnswers(deps.paths, answers(false));
    const error = await runDesign(deps, { ownServer: { facts: BIG } }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(/needs a domain on your Cloudflare account/),
    });
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
    // The read-only preview lists the option and says what is missing.
    const preview = await previewDesignOptions(deps, { ownServer: { facts: BIG } });
    expect(preview.access).toBe("tunnel");
    expect(preview.warnings.join(" ")).toMatch(/needs a domain on your Cloudflare account/);
  });

  it("warns when the server is smaller than planned for the users, and takes the access mode from the caller", async () => {
    // The containers' limits fit 1.5 GB, but OpsCrew plans 2 GB for 1k-10k users.
    const deps = await setup(ownRequirements({ expectedMonthlyUsers: "1k-10k" }));
    const result = await runDesign(deps, {
      ownServer: { facts: { ...BIG, memoryGb: 1.5, diskFreeGb: 5 }, access: "public" },
    });
    expect(result.plan.target).toMatchObject({ provider: "own", access: "public" });
    expect(result.warnings.join("\n")).toMatch(/1\.5 GB of memory/);
    expect(result.warnings.join("\n")).toMatch(/has 5 GB of free disk/);
  });

  describe("the server's memory holds this app next to the other OpsCrew apps there", () => {
    it("refuses before writing anything when the limits do not fit, saying how much the others take", async () => {
      const deps = await setup(ownRequirements());
      const blog = { name: "blog", memoryMb: 1280, tunnel: false };
      const error = await runDesign(deps, {
        ownServer: { facts: { ...BIG, memoryGb: 2 }, access: "public", apps: [blog] },
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
      expect((error as OpsCrewError).message).toBe(
        "Your server has 2048 MB of memory. After 384 MB for the system and 128 MB for OpsCrew's edge, the other OpsCrew app on it takes 1280 MB of memory limits (\"blog\" 1280 MB), which leaves 256 MB, and this app's containers have 512 MB of memory limits. Nothing was written.",
      );
      await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
    });

    it("warns when little stays free, and leaves out the app's own record on a redesign", async () => {
      const deps = await setup(ownRequirements());
      const blog = { name: "blog", memoryMb: 1024, tunnel: false };
      const own = { name: "landing", memoryMb: 9999, tunnel: false };
      const result = await runDesign(deps, {
        ownServer: { facts: { ...BIG, memoryGb: 2.2 }, access: "public", apps: [blog, own] },
      });
      expect(result.plan.app.name).toBe("landing");
      expect(result.warnings.join("\n")).toContain(
        'Your server keeps only 11% of its memory free after the memory limits of this app (512 MB) and of the other OpsCrew app on it (1024 MB: "blog" 1024 MB)',
      );
    });
  });

  it("keeps the rolling deploys the user set in plan.yaml for a small server (FR-1215)", async () => {
    const deps = await setup(ownRequirements());
    // A server under 1 GB holds the app once its memory limit is lowered to 256 MB.
    const big = await runDesign(deps, { ownServer: { facts: BIG, access: "public" } });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...big.plan,
      app: { ...big.plan.app, memoryMb: 256 },
      deploy: { strategy: "recreate", reason: "A small server.", drainSeconds: 30 },
    });
    const ownServer = { facts: { ...BIG, memoryGb: 0.9 }, access: "public" } as const;
    const first = await runDesign(deps, { ownServer });
    expect(first.plan.deploy.strategy).toBe("recreate");
    const rolling = { strategy: "rolling", drainSeconds: 30 } as const;
    await writeArtifact("plan", deps.paths.files.plan, { ...first.plan, deploy: rolling });
    const again = await runDesign(deps, { ownServer });
    expect(again.plan.deploy).toEqual(rolling);
    expect(again.lines).toContain(
      "Deploys: rolling. You chose rolling in opscrew/plan.yaml (deploy.strategy).",
    );
  });

  it("stops plainly without the interview's answers or the inspected server", async () => {
    const deps = await setup(ownRequirements());
    const noAnswers = await runDesign(deps, { ownServer: { facts: BIG } }).catch((e) => e);
    expect(noAnswers).toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringMatching(/opscrew interview/),
    });
    await recordOwnServerAnswers(deps.paths, answers(true));
    const noFacts = await runDesign(deps).catch((e: unknown) => e);
    expect(noFacts).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(/has not inspected your server yet/),
    });
    expect((await deps.state.read()).phases.design?.status).toBe("failed");
  });

  it("does not offer retarget between a deployed cloud server and the user's own", async () => {
    const deps = await setup(makeRequirements());
    const cloud = await runDesign(deps, { catalog: euCatalog() });
    const deployed: DeployPlan = {
      ...cloud.plan,
      deployment: { lastApplyAt: "2026-10-12T10:00:00.000Z" },
    };
    await writeArtifact("plan", deps.paths.files.plan, deployed);
    await writeArtifact("requirements", deps.paths.files.requirements, ownRequirements());
    await recordOwnServerAnswers(deps.paths, answers(true));
    const error = await runDesign(deps, { ownServer: { facts: BIG } }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(
        /deployed on Hetzner Cloud, but opscrew\/requirements\.yaml now asks for your own server/,
      ),
      hint: expect.stringMatching(/cannot move an app to or from a server you already own/),
    });
    expect((error as { hint: string }).hint).not.toMatch(/retarget/);
  });
});
