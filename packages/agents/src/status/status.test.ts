import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortainerClient } from "@opscrew/connector-portainer";
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ED25519_FINGERPRINT, ownProject, provisionOwn } from "../drift/__fixtures__/own-project";
import { recordPortainerConnection, recordServerAddress } from "../shared";
import {
  createTestPhaseDeps,
  fakeCertificate,
  ownPlan,
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerPlan,
  SERVER_IPV4,
  testPlan,
} from "../testing";
import {
  componentStatus,
  componentStatusLines,
  plannedComponents,
  serviceContainers,
} from "./components";
import { appDeployed, readComponentStatus } from "./run";

/** A Hetzner plan with a worker (2 copies), cron jobs, MySQL and a turned-off cache, deployed. */
function componentPlan(base = testPlan({ deployed: true })) {
  return DeployPlanSchema.parse({
    ...base,
    deployment: { ...base.deployment, lastDeployAt: "2026-10-12T09:00:00.000Z" },
    processes: {
      workers: [{ name: "worker", command: "node worker.js", source: "procfile", count: 2 }],
      cron: [{ name: "cleanup", schedule: "0 3 * * *", command: "node cleanup.js" }],
    },
    services: [
      ...base.services,
      { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
      {
        kind: "valkey",
        version: "8",
        memoryMb: 128,
        enabled: false,
        options: { mode: "cache" },
        reason: "redis",
        licence: "BSD-3-Clause",
      },
    ],
  });
}

/** A deploy user's shell that answers `docker ps` with `stdout`, recording the commands. */
function dockerPs(stdout: string, exitCode = 0) {
  const commands: string[] = [];
  const hosts: string[] = [];
  const remote = (host: string): RemoteExec => {
    hosts.push(host);
    return {
      host,
      run: async (command: string): Promise<CommandResult> => {
        commands.push(command);
        return { exitCode, stdout, stderr: exitCode === 0 ? "" : "permission denied" };
      },
    };
  };
  return { remote, commands, hosts };
}

describe("componentStatus", () => {
  it("counts each component's containers, and names the app's services the plan no longer has", () => {
    const plan = componentPlan();
    const status = componentStatus(
      plan,
      serviceContainers("shop", [
        { name: "shop-app-1", running: true },
        { name: "shop-worker-1", running: true },
        { name: "shop-worker-2", running: false },
        { name: "shop-cron-1", running: false },
        { name: "shop-cache-1", running: true },
        // One-off and one-shot containers, and another project's container, are no component.
        { name: "shop-release-run-1a2b3c", running: false },
        { name: "shop-release-1", running: false },
        { name: "blog-app-1", running: true },
      ]),
    );
    expect(status.components).toEqual([
      { service: "app", what: "the web process", containers: 1, running: 1 },
      { service: "worker", what: "the worker", containers: 2, running: 1 },
      { service: "cron", what: "the cron jobs", containers: 1, running: 0 },
      { service: "db", what: "PostgreSQL", containers: 0, running: 0 },
      { service: "mysql", what: "MySQL", containers: 0, running: 0 },
    ]);
    expect(status.others).toEqual(["cache"]);
    expect(componentStatusLines(plan, status)).toEqual([
      "Components:",
      "  The web process (app): running",
      "  The worker (worker): 1 of 2 copies running",
      "  The cron jobs (cron): stopped",
      "  PostgreSQL (db): no container",
      "  MySQL (mysql): no container",
      "  cache: on the server, but no component in opscrew/plan.yaml any more (the next deploy removes it)",
    ]);
  });

  it("the one-shot kernel-settings container of a search engine is no stray service", () => {
    const base = testPlan({ deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [
        {
          kind: "opensearch",
          version: "3.9",
          memoryMb: 1024,
          reason: "The app uses OpenSearch.",
          licence: "Apache-2.0",
        },
      ],
    });
    const status = componentStatus(
      plan,
      serviceContainers("shop", [
        { name: "shop-app-1", running: true },
        { name: "shop-app-2", running: true },
        { name: "shop-opensearch-1", running: true },
        { name: "shop-sysctl-1", running: false },
      ]),
    );
    expect(status.others).toEqual([]);
    expect(componentStatusLines(plan, status)).toEqual([
      "Components:",
      "  The web process (app): running (2 copies)",
      "  OpenSearch (opensearch): running",
    ]);
  });

  it("without a reading, lists the plan's components", () => {
    const plan = componentPlan();
    expect(plannedComponents(plan).map((c) => c.service)).toEqual([
      "app",
      "worker",
      "cron",
      "db",
      "mysql",
    ]);
    expect(componentStatusLines(plan, undefined)).toEqual([
      "Components (from opscrew/plan.yaml):",
      "  The web process (app)",
      "  The worker (worker)",
      "  The cron jobs (cron)",
      "  PostgreSQL (db)",
      "  MySQL (mysql)",
    ]);
  });

  it("an app counts as deployed once a deploy was seen, until it is destroyed", () => {
    const plan = testPlan({ deployed: true });
    expect(appDeployed(plan)).toBe(false);
    expect(appDeployed(componentPlan())).toBe(true);
    const destroyed = componentPlan();
    expect(
      appDeployed({
        deployment: { ...destroyed.deployment, destroyedAt: "2026-10-13T09:00:00.000Z" },
      }),
    ).toBe(false);
  });
});

describe("readComponentStatus on a server OpsCrew created", () => {
  it("reads the app's containers with docker ps as the deploy user at the recorded address", async () => {
    const deps = await createTestPhaseDeps();
    const plan = componentPlan();
    await writeArtifact("plan", deps.paths.files.plan, plan);
    await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
    const ssh = dockerPs("shop-app-1|running\nshop-worker-1|running\nshop-worker-2|exited\n");

    const status = await readComponentStatus(deps, plan, { services: { remote: ssh.remote } });

    expect(ssh.hosts).toEqual([SERVER_IPV4]);
    expect(ssh.commands).toEqual([
      "docker ps -a --filter label=com.docker.compose.project=shop --filter label=com.docker.compose.oneoff=False --format '{{.Names}}|{{.State}}'",
    ]);
    expect(status.components.find((c) => c.service === "worker")).toMatchObject({
      containers: 2,
      running: 1,
    });
    // Audited, without the server's address.
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({
        kind: "remote-exec",
        action: "read the app's containers (read-only)",
        decision: "allow",
      }),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(SERVER_IPV4);
  });

  it("a failed docker ps stops with what to check, without the address", async () => {
    const deps = await createTestPhaseDeps();
    const plan = componentPlan();
    await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
    const ssh = dockerPs("", 255);
    const error = await readComponentStatus(deps, plan, {
      services: { remote: ssh.remote },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("COMMAND_FAILED");
    expect((error as OpsCrewError).message).not.toContain(SERVER_IPV4);
  });

  it("stops plainly when this computer does not know the server's address", async () => {
    const deps = await createTestPhaseDeps();
    const plan = componentPlan(testPlan());
    const ssh = dockerPs("");
    const error = await readComponentStatus(deps, plan, {
      services: { remote: ssh.remote },
    }).catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
    expect(ssh.hosts).toEqual([]);
  });
});

describe("readComponentStatus in the user's Portainer", () => {
  it("reads the app stack's containers through Portainer's API, by their Compose service", async () => {
    const token = fakeSecret("generic-password", "portainer-token");
    const deps = await createTestPhaseDeps({
      env: { OPSCREW_HOME: join(await mkdtemp(join(tmpdir(), "opscrew-status-")), "home") },
    });
    deps.env.PORTAINER_API_KEY = token;
    await recordPortainerConnection(deps.paths, {
      url: PORTAINER_URL,
      certFingerprint: fakeCertificate().fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
    });
    const asked: { environment: number; token: string }[] = [];
    const client = (_endpoint: unknown, given: string) =>
      ({
        listContainers: async (environment: number) => {
          asked.push({ environment, token: given });
          return [
            { project: "opscrew-shop", service: "app", running: true, publishedPorts: [] },
            { project: "opscrew-shop", service: "worker", running: false, publishedPorts: [] },
            // The stack's own parts and one-off containers are no component.
            { project: "opscrew-shop", service: "cloudflared", running: true, publishedPorts: [] },
            { project: "opscrew-shop", service: "db-init", running: false, publishedPorts: [] },
            { project: "opscrew-shop", running: false, publishedPorts: [] },
            // Another project's container.
            { project: "media", service: "db", running: true, publishedPorts: [] },
          ];
        },
      }) as unknown as PortainerClient;
    const base = portainerPlan({ deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      deployment: { ...base.deployment, lastDeployAt: "2026-10-12T09:00:00.000Z" },
      processes: { workers: [{ name: "worker", command: "node worker.js", source: "procfile" }] },
    });

    const status = await readComponentStatus(deps, plan, { services: { portainer: { client } } });

    expect(asked).toEqual([{ environment: 3, token }]);
    expect(status).toEqual({
      components: [
        { service: "app", what: "the web process", containers: 1, running: 1 },
        { service: "worker", what: "the worker", containers: 1, running: 0 },
        { service: "db", what: "PostgreSQL", containers: 0, running: 0 },
      ],
      others: [],
    });
    expect(deps.audit.entries).toEqual([
      expect.objectContaining({
        kind: "provider-call",
        action: "list the app's containers (read-only)",
      }),
    ]);
    expect(JSON.stringify(deps.audit.entries)).not.toContain(PORTAINER_HOST);
  });
});

describe.skipIf(!findExecutable("git"))("readComponentStatus on a server the user owns", () => {
  it("reads the app's containers from the host adapter's inspection, other apps left out", async () => {
    const s = await ownProject({ plan: componentPlan(ownPlan({ deployed: true })) });
    await provisionOwn(s);
    s.host.facts = {
      ...s.host.facts,
      containers: [
        { name: "shop-app-1", project: "shop", ports: "", running: true },
        { name: "shop-mysql-1", project: "shop", ports: "", running: false },
        { name: "blog-worker-1", project: "blog", ports: "", running: true },
      ],
    };
    const plan = componentPlan(ownPlan({ deployed: true }));
    const status = await readComponentStatus(s.deps, plan, {
      hostKey: ED25519_FINGERPRINT,
      services: s.services,
    });
    expect(status.components.map((c) => [c.service, c.containers, c.running])).toEqual([
      ["app", 1, 1],
      ["worker", 0, 0],
      ["cron", 0, 0],
      ["db", 0, 0],
      ["mysql", 1, 0],
    ]);
    expect(status.others).toEqual([]);
  });
});
