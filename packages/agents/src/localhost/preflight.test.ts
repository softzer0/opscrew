import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../testing";
import { FakeComputer, localPlan, localProject } from "./__fixtures__/computer";
import { DOCKER_DESKTOP_LICENCE, localPreflight } from "./preflight";
import { localRoots } from "./services";

/** The preflight of `plan` on `computer`, with the Dockerfile a local build needs in place. */
async function preflight(
  computer = new FakeComputer(),
  plan = localPlan(),
  services = computer.services(),
) {
  const { deps, root } = await localProject(plan, computer);
  await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
  return { ...(await localPreflight(deps, plan, services)), deps, root };
}

describe("localPreflight", () => {
  it("passes on a computer with Docker, Compose, the memory, the ports and the shell", async () => {
    const { problems, notes } = await preflight();
    expect(problems).toEqual([]);
    // Docker Desktop's licence terms, once, with the free alternatives (FR-1509).
    expect(notes).toEqual([DOCKER_DESKTOP_LICENCE]);
    expect(DOCKER_DESKTOP_LICENCE).toMatch(/250 employees.*US\$10 million.*Colima/);
  });

  it("gives no licence note for Docker Engine", async () => {
    const computer = new FakeComputer();
    computer.info = {
      MemTotal: 8 * 1024 ** 3,
      OperatingSystem: "Ubuntu 24.04 LTS",
      OSType: "linux",
      Architecture: "x86_64",
    };
    expect((await preflight(computer)).notes).toEqual([]);
  });

  it("stops without Docker, and names the options and the licence once", async () => {
    for (const info of ["missing", "stopped"] as const) {
      const computer = new FakeComputer();
      computer.info = info;
      const { problems, notes } = await preflight(computer);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(
        info === "missing"
          ? /Docker is not installed.*Docker Desktop.*Colima/
          : /not running.*Start Docker Desktop/,
      );
      expect(notes).toEqual([DOCKER_DESKTOP_LICENCE]);
    }
  });

  it("stops on Windows containers, an old Compose, too little memory and a CPU the plan does not say", async () => {
    const computer = new FakeComputer();
    computer.info = {
      MemTotal: 512 * 1024 ** 2,
      OperatingSystem: "Docker Desktop",
      OSType: "windows",
      Architecture: "aarch64",
    };
    computer.compose = "2.20.3";
    const { problems } = await preflight(computer);
    expect(problems).toEqual([
      expect.stringContaining("runs Windows containers"),
      expect.stringContaining("Docker Compose is version 2.20.3, and OpsCrew needs 2.23 or newer"),
      expect.stringMatching(
        /memory limits add up to \d+ MB, but Docker on this computer has 512 MB\. Give Docker more memory.*or lower the limits in opscrew\/plan\.yaml/,
      ),
      expect.stringContaining(
        "Docker on this computer runs arm64 images, and opscrew/plan.yaml says amd64",
      ),
    ]);
    computer.compose = undefined;
    expect((await preflight(computer)).problems[1]).toContain("Docker Compose is not installed");
  });

  it("accepts Compose 2.23 and every later version", async () => {
    for (const version of ["2.23.0", "2.38.2", "5.5.1"]) {
      const computer = new FakeComputer();
      computer.compose = version;
      expect((await preflight(computer)).problems).toEqual([]);
    }
  });

  it("stops on a port another program uses, but not on one OpsCrew's edge holds", async () => {
    const computer = new FakeComputer();
    computer.busy = new Set([8443, 8080]);
    const taken = await preflight(computer);
    expect(taken.problems).toEqual([
      "Port 8443 on 127.0.0.1 is in use by another program. Stop it, then run the command again.",
      "Port 8080 on 127.0.0.1 is in use by another program. Stop it, then run the command again.",
    ]);
    const plan = DeployPlanSchema.parse({
      ...localPlan(),
      target: { ...localPlan().target, ports: { https: 443, http: 80 } },
    });
    const iis = new FakeComputer();
    iis.busy = new Set([80]);
    expect((await preflight(iis, plan)).problems).toEqual([
      expect.stringContaining(
        "Port 80 on 127.0.0.1 is in use by another program (on Windows often IIS or another web server). Stop it, or set target.ports.http to 8080",
      ),
    ]);
    const ours = new FakeComputer().deployed();
    ours.busy = new Set([8443, 8080]);
    expect((await preflight(ours)).problems).toEqual([]);
  });

  it("stops when the edge serves the computer's other apps on other ports", async () => {
    const computer = new FakeComputer();
    const plan = localPlan();
    const { deps, root } = await localProject(plan, computer);
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    const roots = localRoots(deps.paths);
    await mkdir(join(roots.apps, "blog"), { recursive: true });
    await mkdir(roots.edge, { recursive: true });
    await writeFile(
      join(roots.edge, "compose.yaml"),
      'services:\n  caddy:\n    ports:\n      - "127.0.0.1:80:80"\n      - "127.0.0.1:443:443"\n',
    );
    const { problems } = await localPreflight(deps, plan, computer.services());
    expect(problems).toEqual([
      "OpsCrew's edge on this computer serves its other apps (blog) on ports 443 and 80, and every app there shares it. Set target.ports to { https: 443, http: 80 } in opscrew/plan.yaml, then run the command again.",
    ]);
  });

  it("finds the shell: sh, or Git for Windows' bash next to git", async () => {
    const computer = new FakeComputer();
    const none = await preflight(computer, localPlan(), {
      ...computer.services(),
      which: () => undefined,
    });
    expect(none.problems).toEqual([
      "OpsCrew runs the local stack's scripts with sh, and none was found on PATH. Install a POSIX shell, then run the command again.",
    ]);
    const { deps, root } = await localProject(localPlan(), computer);
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    const git = join(root, "Git", "cmd", "git.exe");
    const windows = {
      ...computer.services({ platform: "win32" }),
      which: (name: string) => (name === "git" ? git : undefined),
    };
    expect((await localPreflight(deps, localPlan(), windows)).problems).toEqual([
      expect.stringContaining(
        "Git for Windows' bash, and it was not found next to git. Install Git for Windows",
      ),
    ]);
    await mkdir(join(root, "Git", "bin"), { recursive: true });
    await writeFile(join(root, "Git", "bin", "bash.exe"), "");
    expect((await localPreflight(deps, localPlan(), windows)).problems).toEqual([]);
  });

  it("refuses the services that need a kernel setting of the Docker host, and a bucket at a provider", async () => {
    const base = localPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      services: [
        ...base.services,
        {
          name: "search",
          kind: "elasticsearch",
          version: "9.5",
          memoryMb: 1024,
          enabled: true,
          options: {},
          reason: "search",
          licence: "Elastic",
        },
      ],
    });
    const { problems } = await preflight(new FakeComputer(), plan);
    expect(problems).toEqual([
      expect.stringMatching(
        /^Elasticsearch needs the Docker host's kernel setting vm\.max_map_count = \d+, which OpsCrew does not change on this computer.*Turn the service search off in opscrew\/plan\.yaml/,
      ),
    ]);
  });

  it("needs the Dockerfile for a local build, and a builder this computer can run", async () => {
    const computer = new FakeComputer();
    const { deps } = await localProject(localPlan(), computer);
    expect((await localPreflight(deps, localPlan(), computer.services())).problems).toEqual([
      "Dockerfile is not in the repository yet, so this computer has nothing to build. Run `opscrew adapt`, merge its pull request and pull it, then run the command again.",
    ]);
    const railpack = DeployPlanSchema.parse({
      ...localPlan(),
      app: {
        ...localPlan().app,
        build: {
          builder: "railpack",
          chosen: "auto",
          reason: "no Dockerfile",
          runtime: { language: "node", version: "22" },
          probe: "none",
        },
      },
    });
    expect((await localPreflight(deps, railpack, computer.services())).problems).toEqual([
      expect.stringContaining("This computer cannot build the app's image as GitHub Actions does"),
    ]);
  });

  it("refuses a local build for a promoted environment, which runs its source's exact image", async () => {
    const dev = localPlan({ environment: "dev" });
    const plan = DeployPlanSchema.parse({
      ...dev,
      environment: { name: "dev", deploySource: { from: "promote", source: "prod" } },
    });
    const computer = new FakeComputer();
    const { deps, root } = await localProject(plan, computer, {
      environment: "dev",
      prod: testPlan({ userSecret: false }),
    });
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    const { problems } = await localPreflight(deps, plan, computer.services());
    expect(problems).toEqual([
      "The dev environment is promoted from prod, so it runs prod's exact image, which a build on this computer would not be. Set target.image to registry in opscrew/environments/dev/plan.yaml, then run the command again.",
    ]);
    // Pulled from GitHub Container Registry, it passes.
    const pulled = DeployPlanSchema.parse({
      ...plan,
      target: { ...plan.target, image: "registry" },
    });
    expect((await localPreflight(deps, pulled, computer.services())).problems).toEqual([]);
  });

  it("says once that the image differs from production's on another CPU", async () => {
    const computer = new FakeComputer();
    computer.info = {
      MemTotal: 8 * 1024 ** 3,
      OperatingSystem: "Docker Desktop",
      OSType: "linux",
      Architecture: "aarch64",
    };
    const plan = localPlan({ environment: "dev", arch: "arm64" });
    // Prod runs on a server OpsCrew creates: its images are amd64.
    const { deps, root } = await localProject(plan, computer, {
      environment: "dev",
      prod: testPlan({ userSecret: false }),
    });
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    const { problems, notes } = await localPreflight(
      deps,
      plan,
      computer.services({ arch: "arm64" }),
    );
    expect(problems).toEqual([]);
    expect(notes).toEqual([
      DOCKER_DESKTOP_LICENCE,
      "This computer runs arm64 and prod's image is built for amd64, so OpsCrew builds the app's image on this computer: it differs from the image prod runs.",
    ]);
  });
});
