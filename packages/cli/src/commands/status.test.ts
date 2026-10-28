import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { recordServerAddress, serverAddressesFile } from "@opscrew/agents";
import {
  FakeGitHub,
  ScriptedRunner,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
} from "@opscrew/agents/testing";
import type { RemoteExec } from "@opscrew/contracts";
import { ProjectStateStore, resolveProjectPaths } from "@opscrew/core";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { main } from "../program";
import { createTestContext } from "../test-context";

const argv = (...args: string[]) => ["node", "opscrew", ...args];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-status-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A provisioned project: the plan (without any address) and the address in the local state. */
async function provisioned(): Promise<void> {
  const paths = resolveProjectPaths(dir, { env: {} });
  await writeArtifact("plan", paths.files.plan, testPlan({ deployed: true, userSecret: false }));
  await recordServerAddress(paths, { ipv4: SERVER_IPV4, ipv6: SERVER_IPV6 });
  await new ProjectStateStore(paths.files.state).markPhase("provision", "ok");
}

describe("opscrew status and the server's address", () => {
  it("shows the address from OpsCrew's local state", async () => {
    await provisioned();
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toMatch(/provision\s+ok/);
    expect(ctx.output).toContain(
      `Server address (kept on this computer only, never in the repository):\n  ${SERVER_IPV4} (IPv6 ${SERVER_IPV6})\n`,
    );
  });

  it("shows the image builder and the deploy strategy with their reasons", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    const plan = testPlan({ userSecret: false });
    const build = {
      builder: "railpack" as const,
      chosen: "auto" as const,
      reason: "Rust: Railpack builds it.",
      runtime: { language: "rust" as const, version: "1.98" },
      probe: "bash" as const,
    };
    await writeArtifact("plan", paths.files.plan, { ...plan, app: { ...plan.app, build } });
    await new ProjectStateStore(paths.files.state).markPhase("design", "ok");
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toContain("\nImage builder: railpack. Rust: Railpack builds it.\n");
    expect(ctx.output).toContain("\nDeploys: rolling. New versions start next to the running one");
    // The supply-chain settings, with what each does and the setting that changes it.
    expect(ctx.output).toContain("\nImage signing: off (the default). Set supplyChain.sign: true");
    expect(ctx.output).toContain("\nDeploy tags: off (the default). Set cicd.deployTags.enabled");
    expect(ctx.output).toContain(
      "\nImage retention: keeps the newest 10 deployed images in GitHub's container registry, never the running or the previous one",
    );
  });

  it("shows signing, deploy tags and image retention as plan.yaml sets them", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    const plan = testPlan({ userSecret: false });
    await writeArtifact("plan", paths.files.plan, {
      ...plan,
      supplyChain: { sign: true },
      cicd: {
        ...plan.cicd,
        deployTags: { enabled: true, release: true },
        imageRetention: { enabled: false, keep: 10 },
      },
    });
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toContain(
      "\nImage signing: on. Each image gets a keyless cosign signature.",
    );
    expect(ctx.output).toContain("Sigstore's public log");
    expect(ctx.output).toContain(
      "\nDeploy tags: on. Each healthy deploy tags its commit deploy-<UTC time> and gets a GitHub Release naming the image digest.",
    );
    expect(ctx.output).toContain("\nImage retention: off. Every deployed image stays");
  });

  it("prints only the IPv4 address with --ip, for ssh deploy@$(opscrew status --ip)", async () => {
    await provisioned();
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status", "--ip"), ctx)).toBe(0);
    expect(ctx.output).toBe(`${SERVER_IPV4}\n`);
  });

  it("still shows the phases when .opscrew/server.json is damaged, with a note on what to do", async () => {
    await provisioned();
    const paths = resolveProjectPaths(dir, { env: {} });
    await writeFile(serverAddressesFile(paths), "{ not json");
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toMatch(/provision\s+ok/);
    const note = ctx.output
      .split("\n")
      .filter((line) => line.startsWith("Server address: unknown."));
    expect(note).toHaveLength(1);
    expect(note[0]).toContain(".opscrew/server.json) is damaged");
    expect(note[0]).toContain("Delete .opscrew/server.json and run the command again");
    expect(ctx.output).not.toContain(SERVER_IPV4);

    // --ip has nothing to print: it stops with the same explanation.
    const ip = createTestContext({ cwd: dir });
    expect(await main(argv("status", "--ip"), ip)).not.toBe(0);
    expect(ip.output).toBe("");
    expect(ip.errors).toContain("is damaged");
  });

  it("shows the proxy, each certificate's expiry and the recovery copy (FR-1462)", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    const plan = testPlan({ deployed: true, domain: "shop.example.com", userSecret: false });
    await writeArtifact("plan", paths.files.plan, {
      ...plan,
      dns: { ...plan.dns, proxied: false },
      deployment: { ...plan.deployment, firstDeployAt: "2026-10-11T12:00:00.000Z" },
    });
    const ctx = createTestContext({ cwd: dir });
    withServices(ctx, {
      clock: { now: () => new Date("2026-10-21T12:00:00.000Z") },
      verify: {
        tlsConnect: async () => ({
          subjectAltNames: ["shop.example.com"],
          validFrom: "2026-10-01T00:00:00.000Z",
          validTo: "2026-12-30T00:00:00.000Z",
          issuer: "Let's Encrypt",
        }),
      },
    });
    expect(await main(argv("status"), ctx)).toBe(0);
    expect(ctx.output).toContain("\nProxy: Caddy\n");
    expect(ctx.output).toContain(
      "\nCertificates:\n  shop.example.com (from Let's Encrypt): expires 2026-12-30 (69 days left)\n",
    );
    expect(ctx.output).toContain("\nSecrets copy: none yet (`opscrew provision` makes it).\n");
  });

  describe("the app's components (FR-1331)", () => {
    /** A deployed plan with a worker and MySQL, after a deploy `opscrew verify` saw. */
    async function deployedWithComponents(): Promise<void> {
      await provisioned();
      const paths = resolveProjectPaths(dir, { env: {} });
      const base = testPlan({ deployed: true, userSecret: false });
      await writeArtifact(
        "plan",
        paths.files.plan,
        DeployPlanSchema.parse({
          ...base,
          deployment: { ...base.deployment, firstDeployAt: "2026-10-12T09:00:00.000Z" },
          processes: {
            workers: [{ name: "worker", command: "node worker.js", source: "procfile" }],
          },
          services: [
            ...base.services,
            { kind: "mysql", version: "8.4", memoryMb: 512, reason: "mysql2", licence: "GPL-2.0" },
          ],
        }),
      );
    }
    /** The deploy user's shell, answering `docker ps` (or failing with `exitCode`). */
    function shell(stdout: string, exitCode = 0) {
      const hosts: string[] = [];
      const remote = (host: string): RemoteExec => {
        hosts.push(host);
        return { host, run: async () => ({ exitCode, stdout, stderr: "" }) };
      };
      return { remote, hosts };
    }

    it("lists each component and whether it runs, read over SSH as the deploy user", async () => {
      await deployedWithComponents();
      const ssh = shell("shop-app-1|running\nshop-worker-1|exited\nshop-db-1|running\n");
      const ctx = withServices(createTestContext({ cwd: dir }), {
        provision: { remote: ssh.remote },
      });
      expect(await main(argv("status"), ctx)).toBe(0);
      expect(ssh.hosts).toEqual([SERVER_IPV4]);
      expect(ctx.output).toContain(
        [
          "Components:",
          "  The web process (app): running",
          "  The worker (worker): stopped",
          "  PostgreSQL (db): running",
          "  MySQL (mysql): no container",
        ].join("\n"),
      );
    });

    it("shows the resource figures with their flags, and the scheduled check's state and alerts", async () => {
      const env = { OPSCREW_HOME: path.join(dir, "home") };
      const paths = resolveProjectPaths(dir, { env });
      const base = testPlan({ deployed: true, userSecret: false });
      await writeArtifact(
        "plan",
        paths.files.plan,
        DeployPlanSchema.parse({
          ...base,
          deployment: { ...base.deployment, firstDeployAt: "2026-10-11T09:00:00.000Z" },
          processes: {
            workers: [{ name: "worker", command: "node worker.js", source: "procfile" }],
          },
          observability: { check: { enabled: true } },
        }),
      );
      await recordServerAddress(paths, { ipv4: SERVER_IPV4 });
      // The project's deploy key: the figures are read as the deploy user.
      await mkdir(path.dirname(paths.files.deployKey), { recursive: true });
      await writeFile(paths.files.deployKey, "placeholder for the deploy key file\n");
      const MIB = 1024 ** 2;
      const stats = (name: string, cpu: string, memory: string) =>
        JSON.stringify({ CPUPerc: cpu, MemUsage: memory, Name: name, MemPerc: "1.00%" });
      const figures = [
        "==opscrew-figures:cpus",
        "2",
        "==opscrew-figures:load",
        "0.52 0.40 0.31 1/123 4567",
        "==opscrew-figures:memory",
        "               total        used        free      shared  buff/cache   available",
        "Mem:      4000000000  1500000000   500000000     1000000  2000000000  2400000000",
        "==opscrew-figures:disk",
        "Filesystem        1-blocks        Used   Available Capacity Mounted on",
        "/dev/sda1      40000000000 39000000000  1000000000      98% /",
        "==opscrew-figures:stats",
        stats("shop-app-1", "3.25%", "486.4MiB / 512MiB"),
        stats("shop-worker-1", "0.10%", "40MiB / 3.725GiB"),
        "==opscrew-figures:inspect",
        JSON.stringify({
          name: "/shop-app-1",
          restarts: 0,
          startedAt: "2026-10-11T09:59:59Z",
          memoryLimit: 512 * MIB,
        }),
        JSON.stringify({
          name: "/shop-worker-1",
          restarts: 1,
          startedAt: "2026-10-11T11:30:00Z",
          memoryLimit: 0,
        }),
        "",
      ].join("\n");
      const remote = (host: string): RemoteExec => ({
        host,
        run: async (command) => ({
          exitCode: 0,
          stdout: command.startsWith("export LC_ALL=C")
            ? figures
            : "shop-app-1|running\nshop-worker-1|running\nshop-db-1|running\n",
          stderr: "",
        }),
      });
      const github = new FakeGitHub();
      github.workflowStates.set("opscrew-check.yml", "active");
      github.issues.set("opscrew-check", [
        {
          number: 12,
          title: "shop (prod): the disk is filling up",
          url: "https://github.com/acme/shop/issues/12",
          body: "",
          createdAt: "2026-10-11T11:00:00Z",
        },
      ]);
      const ctx = withServices(createTestContext({ cwd: dir, env }), {
        clock: { now: () => new Date("2026-10-11T12:00:00.000Z") },
        // The repository's GitHub remote, for the scheduled check.
        runner: new ScriptedRunner((_command, args) =>
          args.includes("get-url")
            ? { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "" },
        ),
        provision: { remote, github },
      });
      expect(await main(argv("status"), ctx), ctx.errors).toBe(0);
      expect(ctx.output).toContain(
        [
          "Resources (read now):",
          "  Server: load 0.52, 0.40, 0.31 (1, 5 and 15 minutes) on 2 CPUs; memory 1.5 GB used of 3.7 GB; disk 36.3 GB used, 954 MB free of 37.3 GB (98% full)",
          "  The web process (app): CPU 3.3%, memory 486 MB of 512 MB (95%), 0 restarts, started 2 hours ago",
          "  The worker (worker): CPU 0.1%, memory 40 MB (no limit), 1 restart, started 30 minutes ago",
        ].join("\n"),
      );
      // Each flag: the disk past 95% (high), the memory near its limit, the restart.
      expect(ctx.output).toMatch(/\n {2}High: The server's disk is 98% full/);
      expect(ctx.output).toContain(
        "  Warning: The web process (app) uses 95% of its 512 MB memory limit.",
      );
      expect(ctx.output).toContain(
        "  Warning: The worker (worker) restarted 1 time since the last deploy",
      );
      expect(ctx.output).toContain(
        [
          "Scheduled check (.github/workflows/opscrew-check.yml, read from GitHub now):",
          "  State: on",
          "  Open alerts:",
          "    #12 shop (prod): the disk is filling up: https://github.com/acme/shop/issues/12",
        ].join("\n"),
      );
      expect(ctx.output).not.toContain("could not read the resource figures");
    });

    it("a server it cannot read leaves a note, and the rest of status is shown", async () => {
      await deployedWithComponents();
      const ssh = shell("", 255);
      const ctx = withServices(createTestContext({ cwd: dir }), {
        provision: { remote: ssh.remote },
      });
      expect(await main(argv("status"), ctx)).toBe(0);
      expect(ctx.output).toMatch(/provision\s+ok/);
      expect(ctx.output).toContain("Components (from opscrew/plan.yaml):\n  The web process (app)");
      expect(ctx.output).toContain(
        "OpsCrew could not check whether they run. OpsCrew could not read the app's containers on the server over SSH (exit code 255).",
      );
    });

    it("before a deploy was seen, lists them from the plan without connecting; --ip never connects", async () => {
      await provisioned();
      const ssh = shell("");
      const ctx = withServices(createTestContext({ cwd: dir }), {
        provision: { remote: ssh.remote },
      });
      expect(await main(argv("status"), ctx)).toBe(0);
      expect(ctx.output).toContain(
        "Components (from opscrew/plan.yaml):\n  The web process (app)\n  PostgreSQL (db)\n",
      );
      await deployedWithComponents();
      const ip = withServices(createTestContext({ cwd: dir }), {
        provision: { remote: ssh.remote },
      });
      expect(await main(argv("status", "--ip"), ip)).toBe(0);
      expect(ssh.hosts).toEqual([]);
    });
  });

  it("says where the address is when this computer does not know it", async () => {
    const paths = resolveProjectPaths(dir, { env: {} });
    await writeArtifact("plan", paths.files.plan, testPlan({ deployed: true, userSecret: false }));
    const ctx = createTestContext({ cwd: dir });
    expect(await main(argv("status", "--ip"), ctx)).toBe(1);
    expect(ctx.output).toBe("");
    expect(ctx.errors).toContain("OpsCrew does not know the server's address on this computer.");
    expect(ctx.errors).toContain("the computer that ran `opscrew provision`");

    const plain = createTestContext({ cwd: dir });
    expect(await main(argv("status"), plain)).toBe(0);
    expect(plain.output).not.toContain("Server address");
  });
});
