import { readFile } from "node:fs/promises";
import { portainerHostSettingProblem } from "@opscrew/iac-templates";
import {
  type Architecture,
  DesignOptionSchema,
  type Requirements,
  readArtifact,
  serviceOf,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  type PortainerConnectionInput,
  recordPortainerConnection,
  recordServerAddress,
} from "../shared";
import {
  createTestPhaseDeps,
  euCatalog,
  makeRequirements,
  nextPostgresFacts,
  staticSpaFacts,
  type TestPhaseDeps,
} from "../testing";
import {
  buildPortainerOption,
  PORTAINER_BACKUPS_NOTE,
  PORTAINER_HOST_NOTE,
  PORTAINER_OPTION_ID,
  portainerDesignChoice,
} from "./portainer";
import { previewDesignOptions, runDesign } from "./run";
import { PORTAINER_RECREATE_NOTE } from "./strategy";

const URL_ = "https://nas.home.example.com:9443";
const now = new Date("2026-10-11T12:00:00.000Z");

const CONNECTION: PortainerConnectionInput = {
  url: URL_,
  environmentId: 3,
  environmentName: "local",
  arch: "arm64",
  redeploy: "updater",
  web: { mode: "tunnel" },
};

const onCloudflare = (overrides: Partial<Requirements> = {}) =>
  makeRequirements({
    provider: "portainer",
    region: undefined,
    dnsProvider: "cloudflare",
    domain: "app.example.com",
    ...overrides,
  });

async function setup(
  requirements: Requirements,
  connection: PortainerConnectionInput | null = CONNECTION,
  facts = staticSpaFacts(),
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps();
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
  if (connection !== null) await recordPortainerConnection(deps.paths, connection);
  return deps;
}

describe("the design option in an existing Portainer", () => {
  it("is one unpriced option with the environment's architecture and the notes", () => {
    const option = buildPortainerOption({
      facts: nextPostgresFacts(),
      requirements: onCloudflare(),
      choice: { environmentId: 3, arch: "arm64", redeploy: "updater", web: { mode: "tunnel" } },
      now,
    });
    expect(DesignOptionSchema.parse(option)).toEqual(option);
    expect(option).toMatchObject({
      id: PORTAINER_OPTION_ID,
      title: "Your Portainer",
      target: { provider: "portainer", architecture: "arm" },
      backups: false,
      fitsBudget: true,
      recommended: true,
      cost: { monthly: { amount: 0, currency: "EUR" }, source: "live" },
    });
    expect(option.summary).toContain("Docker Compose stack in the environment you picked (arm64)");
    expect(option.summary).toContain("No server price: you already run this Portainer.");
    expect(option.summary).toContain(PORTAINER_HOST_NOTE);
    expect(option.summary).toContain(PORTAINER_BACKUPS_NOTE);
    expect(PORTAINER_HOST_NOTE).toBe(
      "OpsCrew does not change the host: its firewall, SSH and Portainer's own security stay yours.",
    );
    expect(option.tradeoffs).toContain(
      "Your Portainer host uses arm64, so OpsCrew builds the app image for arm64.",
    );
    expect(option.tradeoffs).toContain(PORTAINER_BACKUPS_NOTE);
    expect(serviceOf(option, "postgres")).toBeDefined();
    // Never Portainer's address.
    expect(JSON.stringify(option)).not.toContain("nas.home");
  });

  it("refuses plainly without the interview's answers or the environment's architecture", () => {
    expect(() => portainerDesignChoice(undefined)).toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        message: expect.stringContaining("does not know which Portainer and environment"),
      }),
    );
    const { arch: _arch, ...noArch } = CONNECTION;
    expect(() =>
      portainerDesignChoice({ ...noArch, created: { stacks: [], volumes: [] } } as never),
    ).toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        hint: "Pick the environment again with `opscrew interview`, then run `opscrew design` again.",
      }),
    );
  });
});

describe("runDesign for an existing Portainer", () => {
  it("writes the plan's target from the answers, with no price and no address", async () => {
    const deps = await setup(onCloudflare());
    const result = await runDesign(deps);
    expect(result.options.map((o) => o.id)).toEqual([PORTAINER_OPTION_ID]);
    expect(result.plan.target).toEqual({
      provider: "portainer",
      mode: "portainer-stack",
      environmentId: 3,
      arch: "arm64",
      redeploy: "updater",
      web: { mode: "tunnel" },
    });
    // Served through the tunnel, behind Cloudflare.
    expect(result.plan.dns).toMatchObject({ provider: "cloudflare", proxied: true });
    const plan = await readFile(deps.paths.files.plan, "utf8");
    expect(plan).not.toMatch(/nas\.home|9443/);
    expect(deps.reporter.text()).toContain("no server cost (you already run this Portainer)");
    expect(deps.reporter.text()).toContain(PORTAINER_HOST_NOTE);
    expect(deps.reporter.text()).toContain(PORTAINER_BACKUPS_NOTE);
    expect((await deps.state.read()).phases.design).toMatchObject({
      status: "ok",
      summary: "portainer, no server cost",
    });
    // FR-1217: Portainer recreates the stack, and design says so.
    expect(result.plan.deploy).toEqual({
      strategy: "recreate",
      drainSeconds: 30,
      reason: PORTAINER_RECREATE_NOTE,
    });
    expect(deps.reporter.text()).toContain(`Deploys: recreate. ${PORTAINER_RECREATE_NOTE}`);
    // Built for the environment's architecture.
    expect(result.plan.app.build).toMatchObject({ builder: "generated-dockerfile" });
  });

  it("serves the user's proxy and Caddy with DNS only, and keeps the port", async () => {
    const proxy = await setup(onCloudflare({ domain: "api.shop.example.com" }), {
      ...CONNECTION,
      arch: "amd64",
      redeploy: "cloudflare",
      web: { mode: "proxy", port: 8081 },
    });
    const viaProxy = await runDesign(proxy);
    expect(viaProxy.plan.target).toMatchObject({
      arch: "amd64",
      redeploy: "cloudflare",
      web: { mode: "proxy", port: 8081 },
    });
    // DNS only: a name deeper than Cloudflare's free certificate is fine then.
    expect(viaProxy.plan.dns).toMatchObject({ domain: "api.shop.example.com", proxied: false });
    expect(viaProxy.plan.security.httpAllowedFrom).toBe("any");

    const caddy = await setup(
      makeRequirements({
        provider: "portainer",
        region: undefined,
        domain: "app.example.com",
        dnsProvider: "other",
      }),
      {
        ...CONNECTION,
        web: { mode: "caddy" },
      },
    );
    const viaCaddy = await runDesign(caddy);
    expect(viaCaddy.plan.target).toMatchObject({ web: { mode: "caddy" }, redeploy: "updater" });
    expect(viaCaddy.plan.dns).toMatchObject({ provider: "none", domain: "app.example.com" });
  });

  it("refuses answers the requirements no longer allow, before plan.yaml is written", async () => {
    for (const [connection, requirements, message] of [
      [
        CONNECTION,
        makeRequirements({ provider: "portainer", region: undefined }),
        /Cloudflare Tunnel, which needs a domain on your Cloudflare account/,
      ],
      [
        { ...CONNECTION, redeploy: "cloudflare", web: { mode: "proxy", port: 8080 } },
        makeRequirements({ provider: "portainer", region: undefined }),
        /through Cloudflare Access, which needs a domain on your Cloudflare account/,
      ],
      [
        { ...CONNECTION, web: { mode: "caddy" } },
        makeRequirements({ provider: "portainer", region: undefined }),
        /Caddy serves the app on ports 80 and 443 with certificates for your domain/,
      ],
      [
        CONNECTION,
        onCloudflare({ domain: "api.shop.example.com" }),
        /api\.shop\.example\.com would fail HTTPS at Cloudflare's edge/,
      ],
    ] as const) {
      const deps = await setup(requirements, connection);
      await expect(runDesign(deps)).rejects.toThrow(message);
      await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
    }
    const unanswered = await setup(onCloudflare(), null);
    await expect(runDesign(unanswered)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("does not know which Portainer and environment"),
    });
  });

  it("plans cron routes the stack's image cannot call turned off, saying why, by the stack renderer's check", async () => {
    const facts = {
      ...staticSpaFacts(),
      cronJobs: [
        { schedule: "0 5 * * *", route: "/api/cron/cleanup", source: "vercel.json" as const },
      ],
    };
    const deps = await setup(onCloudflare(), CONNECTION, facts);
    const { plan } = await runDesign(deps);
    expect(plan.target.provider).toBe("portainer");
    expect(plan.app.build?.probe).toBe("wget");
    expect(plan.processes.cron).toEqual([
      { name: "cleanup", schedule: "0 5 * * *", route: "/api/cron/cleanup", enabled: false },
    ]);
    expect(deps.reporter.text()).toContain(
      "The cron job cleanup calls the app's routes, but the image is a static site served by Caddy, whose busybox wget cannot send the job's secret, and a static site answers no route, so OpsCrew turned it off in opscrew/plan.yaml (processes.cron).",
    );
  });

  it("keeps the app's files in Garage in the app's stack, its cheapest storage there", async () => {
    const facts = {
      ...nextPostgresFacts(),
      services: [
        ...nextPostgresFacts().services,
        { kind: "s3" as const, evidence: ["dependency:@aws-sdk/client-s3"] },
      ],
      objectStorage: { client: "@aws-sdk/client-s3", presignedUploads: false, variables: [] },
    };
    const deps = await setup(onCloudflare(), CONNECTION, facts);
    const { plan } = await runDesign(deps);
    expect(plan.storage?.objectStorage).toMatchObject({ provider: "garage", region: "garage" });
    expect(serviceOf(plan, "garage")).toBeDefined();
  });

  it.each([
    ["opensearch", "@opensearch-project/opensearch"],
    ["elasticsearch", "@elastic/elasticsearch"],
  ] as const)("keeps %s external, saying why and what to use instead", async (kind, client) => {
    const facts = {
      ...nextPostgresFacts(),
      services: [...nextPostgresFacts().services, { kind, evidence: [`dependency:${client}`] }],
    };
    const deps = await setup(onCloudflare(), CONNECTION, facts);
    const { plan } = await runDesign(deps);
    expect(plan.services.map((service) => service.kind)).not.toContain(kind);
    expect(plan.externalServices).toContain(kind);
    const line = portainerHostSettingProblem(kind) as string;
    expect(line).toContain("vm.max_map_count");
    expect(deps.reporter.text()).toContain(line);
  });

  it("keeps cron routes on in a stack whose image can call them", async () => {
    const facts = {
      ...nextPostgresFacts(),
      cronJobs: [
        { schedule: "0 5 * * *", route: "/api/cron/cleanup", source: "vercel.json" as const },
      ],
    };
    const deps = await setup(onCloudflare(), CONNECTION, facts);
    const { plan } = await runDesign(deps);
    expect(plan.processes.cron[0]?.enabled).toBe(true);
    expect(deps.reporter.text()).not.toContain("OpsCrew turned it off");
  });

  it("previews the option without writing anything", async () => {
    const deps = await setup(onCloudflare());
    const preview = await previewDesignOptions(deps);
    expect(preview.options.map((o) => o.id)).toEqual([PORTAINER_OPTION_ID]);
    expect(preview.portainer).toMatchObject({ environmentId: 3, arch: "arm64" });
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
  });

  it("stops before a switch to or from a deployed Portainer target", async () => {
    const deps = await setup(onCloudflare());
    const deployed = await runDesign(deps);
    await writeArtifact("plan", deps.paths.files.plan, {
      ...deployed.plan,
      deployment: { ...deployed.plan.deployment, lastApplyAt: "2026-10-11T12:30:00.000Z" },
    });
    await writeArtifact("requirements", deps.paths.files.requirements, makeRequirements());
    await expect(runDesign(deps, { catalog: euCatalog() })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Your app is deployed in your Portainer, but opscrew/requirements.yaml now asks for Hetzner Cloud. opscrew/plan.yaml was not changed.",
      hint: expect.stringContaining(
        "OpsCrew cannot move an app to or from your Portainer. Run `opscrew destroy` first",
      ),
    });
    expect((await readArtifact("plan", deps.paths.files.plan)).target.provider).toBe("portainer");
  });

  it("treats stacks OpsCrew's record lists as live, even when no apply was recorded", async () => {
    const deps = await setup(onCloudflare());
    await runDesign(deps);
    // A stack apply that failed half-way: the record lists the stack, the plan no apply time.
    await recordPortainerConnection(deps.paths, {
      ...CONNECTION,
      created: { stacks: [{ id: 12, name: "opscrew-landing", role: "app" }], volumes: [] },
    });
    await writeArtifact("requirements", deps.paths.files.requirements, makeRequirements());
    await expect(runDesign(deps, { catalog: euCatalog() })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "An earlier apply may have created resources for your Portainer",
      ),
      hint: expect.stringContaining("OpsCrew cannot move an app to or from your Portainer."),
    });
    // Nothing recorded as created: the switch is allowed.
    await recordPortainerConnection(deps.paths, CONNECTION);
    const switched = await runDesign(deps, { catalog: euCatalog() });
    expect(switched.plan.target.provider).toBe("hetzner");
  });

  it("stops before a deployed Hetzner server is switched to a Portainer", async () => {
    const deps = await setup(makeRequirements());
    const deployed = await runDesign(deps, { catalog: euCatalog() });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...deployed.plan,
      deployment: { ...deployed.plan.deployment, lastApplyAt: "2026-10-11T12:30:00.000Z" },
    });
    await recordServerAddress(deps.paths, { ipv4: "203.0.113.10" });
    await writeArtifact("requirements", deps.paths.files.requirements, onCloudflare());
    await expect(runDesign(deps)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "Your app is deployed on Hetzner Cloud, but opscrew/requirements.yaml now asks for your Portainer. opscrew/plan.yaml was not changed.",
      hint: expect.stringContaining(
        "OpsCrew cannot move an app to or from your Portainer. Run `opscrew destroy` first",
      ),
    });
    expect((await readArtifact("plan", deps.paths.files.plan)).target.provider).toBe("hetzner");
  });
});
