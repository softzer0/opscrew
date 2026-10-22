import { mkdirSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exists, readTextIfExists } from "@opscrew/core";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { renderDriftReport, runDrift } from "../drift";
import { runProvision } from "../provision";
import { runSecure } from "../secure";
import { componentStatusReport, tlsStatusReport } from "../status";
import { ScriptedApprovalHandler } from "../testing";
import { runVerify } from "../verify";
import { DIGEST, FakeComputer, localPlan, localProject } from "./__fixtures__/computer";
import { destroyLocalhost } from "./destroy";
import { appFolder, localRoots } from "./services";

/**
 * The app provisioned on the fake computer, and the stack as the start script leaves it running:
 * its containers, the image in `.env` and the leaf certificate in place.
 */
async function deployed(approve = new ScriptedApprovalHandler()) {
  const computer = new FakeComputer();
  const plan = localPlan({ image: "registry" });
  const { deps, root } = await localProject(plan, computer, { approve });
  await runProvision(deps, { services: { localhost: computer.services() } });
  computer.deployed();
  const folder = appFolder(deps.paths, plan);
  await writeFile(join(folder, ".env"), `APP_IMAGE=ghcr.io/acme/shop@${DIGEST}\n`);
  const tls = join(localRoots(deps.paths).edge, "tls", "shop");
  await rename(join(tls, "local.pem.new"), join(tls, "local.pem"));
  await rename(join(tls, "local.key.new"), join(tls, "local.key"));
  computer.scripts.length = 0;
  return { deps, root, computer, folder, approve };
}

describe("verify on this computer", () => {
  it("checks the app through 127.0.0.1 with its hostname, writes the runbook and records the first deploy", async () => {
    const { deps, computer } = await deployed();
    const result = await runVerify(deps, { localhost: computer.services() });
    expect(result.passed).toBe(true);
    expect(result.url).toBe("https://shop.localhost:8443");
    expect(Object.fromEntries(result.checks.map((c) => [c.id, c.status]))).toEqual({
      "local-health": "pass",
      "local-certificate": "pass",
      "local-redirect": "pass",
      "local-secret-files": "pass",
      "local-loopback": "pass",
      "local-components": "pass",
      "local-trust": "warn",
    });
    // Every request goes to 127.0.0.1 (the request's own host) with the Host header and SNI.
    expect(computer.requests.every((r) => r.hostname === "shop.localhost")).toBe(true);
    expect(
      computer.requests
        .filter((r) => r.scheme === "https")
        .every((r) => r.ca?.includes("BEGIN CERTIFICATE")),
    ).toBe(true);
    expect(result.checks.find((c) => c.id === "local-trust")?.remediation).toContain(
      "opscrew localhost trust",
    );
    const runbook = await readFile(join(deps.paths.root, "opscrew", "RUNBOOK.md"), "utf8");
    expect(runbook).toContain("https://shop.localhost:8443");
    expect(runbook).toContain("docker compose -p opscrew-shop logs -f app");
    expect(runbook).not.toContain(deps.paths.homeDir);
    expect(
      (await readArtifact("plan", deps.paths.files.plan)).deployment.firstDeployAt,
    ).toBeDefined();
  });

  it("fails when the app does not answer, or the edge listens beyond 127.0.0.1", async () => {
    const { deps, computer } = await deployed();
    computer.answer = (input) => (input.scheme === "http" ? { status: 200 } : { status: 503 });
    const edge = computer.containers.find((c) => c.service === "caddy");
    if (edge !== undefined) edge.ports = "0.0.0.0:8443->443/tcp";
    const result = await runVerify(deps, { localhost: computer.services() });
    expect(result.passed).toBe(false);
    const status = Object.fromEntries(result.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      "local-health": "fail",
      "local-loopback": "fail",
      "local-redirect": "warn",
    });
    expect(
      (await readArtifact("plan", deps.paths.files.plan)).deployment.firstDeployAt,
    ).toBeUndefined();
  });
});

describe("status on this computer", () => {
  it("shows the components from the app's Compose project, the certificate, the CA and the memory", async () => {
    const { deps, computer } = await deployed();
    await runVerify(deps, { localhost: computer.services() });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    const components = await componentStatusReport(deps, plan);
    expect(components.lines).toEqual([
      "Components:",
      "  The web process (app): running",
      "  PostgreSQL (db): running",
    ]);
    const { lines } = await tlsStatusReport(deps, plan);
    expect(lines).toEqual([
      "Proxy: Caddy, on this computer (127.0.0.1 only)",
      "Address: https://shop.localhost:8443",
      "Certificates:",
      expect.stringMatching(
        /^ {2}shop\.localhost \(from OpsCrew's local CA\): expires 2027-10-11 \(365 days left\)$/,
      ),
      expect.stringContaining("Local CA: not trusted"),
      expect.stringMatching(/^Memory: the stack's limits \d+ MB of the 8192 MB Docker has\.$/),
    ]);
    // Docker's memory lowered since: the limits no longer fit.
    computer.info = {
      MemTotal: 256 * 1024 ** 2,
      OperatingSystem: "Docker Desktop",
      OSType: "linux",
      Architecture: "x86_64",
    };
    expect((await tlsStatusReport(deps, plan)).lines.at(-1)).toContain("the limits no longer fit");
  });
});

describe("drift on this computer", () => {
  it("is clean right after the deploy, and lists what changed on this computer since", async () => {
    const { deps, computer, folder } = await deployed();
    const clean = await runDrift(deps);
    expect(clean).toMatchObject({
      clean: true,
      provider: "localhost",
      files: { changed: [], created: [] },
    });
    expect(clean.engine).toBeUndefined();
    expect(renderDriftReport(clean)).toContain("OpsCrew drift check (this computer,");
    expect(renderDriftReport(clean)).toContain(
      "the stack on this computer is as OpsCrew set it up",
    );

    await writeFile(join(folder, "compose.yaml"), "edited on this computer\n");
    const db = computer.containers.find((c) => c.service === "db");
    if (db !== undefined) db.running = false;
    const drifted = await runDrift(deps);
    expect(drifted.clean).toBe(false);
    expect(drifted.host?.differences.map((d) => d.detail)).toEqual([
      "compose.yaml in the app's folder differs from the repository's.",
      "db is stopped.",
    ]);
    expect(renderDriftReport(drifted)).toContain(
      "The stack on this computer differs from what OpsCrew set up (2):",
    );
  });
});

describe("destroy on this computer", () => {
  it("removes only OpsCrew's containers, networks and folders, after the app's name is typed", async () => {
    const { deps, computer, folder, approve } = await deployed();
    const result = await destroyLocalhost(
      deps,
      await readArtifact("plan", deps.paths.files.plan),
      {},
      computer.services(),
    );
    const request = approve.requests.at(-1);
    expect(request).toMatchObject({
      kind: "host-apply",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    const [teardown] = computer.scripts;
    expect(teardown?.script).toContain(
      'ids="$(docker ps -a -q --filter label=com.docker.compose.project=opscrew-shop)"',
    );
    expect(teardown?.script).toContain(
      "docker network ls -q --filter label=com.docker.compose.project=opscrew-shop",
    );
    // The data volumes stay without --delete-data; the computer's last app takes the edge along.
    expect(teardown?.script).not.toContain("volume rm");
    expect(teardown?.script).toContain("label=com.docker.compose.project=opscrew-edge");
    expect(teardown?.script).toContain('rm -rf "$EDGE_DIR"');
    expect(teardown?.script).toContain(`rm -rf "$APPS_DIR"/'shop'`);
    expect(result.remaining[0]).toContain("opscrew-shop_db_data");
    expect(result.remaining[0]).toContain("--delete-data");
    expect(deps.reporter.text()).toContain("The data volumes stay");
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.destroyedAt).toBeDefined();
    expect(plan.approvals.at(-1)).toMatchObject({ kind: "host-apply" });
    expect(await exists(folder)).toBe(true); // the fake shell removed nothing
  });

  it("removes the volumes too with --delete-data, and keeps the edge for the computer's other apps", async () => {
    const { deps, computer } = await deployed();
    await mkdir(join(localRoots(deps.paths).apps, "blog"), { recursive: true });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await destroyLocalhost(deps, plan, { deleteData: true }, computer.services());
    const [teardown] = computer.scripts;
    expect(teardown?.script).toContain(
      "docker volume ls -q --filter label=com.docker.compose.project=opscrew-shop",
    );
    expect(teardown?.script).not.toContain("label=com.docker.compose.project=opscrew-edge");
    expect(teardown?.script).toContain("kamal-proxy remove 'shop'");
    expect(teardown?.script).toContain(`rm -rf "$EDGE_DIR"/tls/'shop'`);
    expect(teardown?.script).toContain("caddy reload");
    expect(deps.reporter.text()).toContain(
      "OpsCrew's edge stays for the other apps on this computer (blog).",
    );
  });

  it("changes nothing when the teardown is not approved, and refuses when nothing is there", async () => {
    const { deps, computer } = await deployed(
      new ScriptedApprovalHandler(
        (request) => !(request.kind === "host-apply" && request.allowDestroy === true),
      ),
    );
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await expect(destroyLocalhost(deps, plan, {}, computer.services())).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("Nothing on this computer was changed."),
    });
    expect(computer.scripts).toEqual([]);
    const empty = new FakeComputer();
    const fresh = await localProject(localPlan(), empty);
    await expect(
      destroyLocalhost(fresh.deps, localPlan(), {}, empty.services()),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: "Nothing is deployed for this project, so there is nothing to destroy.",
    });
    expect(await readTextIfExists(join(fresh.root, "opscrew", "plan.yaml"))).toBeDefined();
  });
});

describe("destroy under the lock", () => {
  it("plans again and refuses when another app came to share the edge since the approval", async () => {
    let apps = "";
    const { deps, computer } = await deployed(
      new ScriptedApprovalHandler((request) => {
        // Another project's app is provisioned while the user reads the teardown.
        if (request.kind === "host-apply" && request.allowDestroy === true) {
          mkdirSync(join(apps, "blog"), { recursive: true });
        }
        return true;
      }),
    );
    apps = localRoots(deps.paths).apps;
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await expect(destroyLocalhost(deps, plan, {}, computer.services())).rejects.toMatchObject({
      code: "PLAN_HASH_MISMATCH",
      message: expect.stringContaining(
        "another app now shares OpsCrew's edge. Nothing was changed.",
      ),
    });
    // The shared edge was never removed.
    expect(computer.scripts).toEqual([]);
    expect(await exists(localRoots(deps.paths).edge)).toBe(true);
  });
});

describe("the hostname served", () => {
  it("is the one verify checks, and drift reports a new one as pending once another localhost environment comes", async () => {
    const { deps, root, computer } = await deployed();
    // A second localhost environment of the app: prod's hostname becomes prod.shop.localhost.
    await writeArtifact(
      "plan",
      join(root, "opscrew", "environments", "dev", "plan.yaml"),
      localPlan({ environment: "dev" }),
    );
    await runVerify(deps, { localhost: computer.services() });
    expect(computer.requests.every((r) => r.hostname === "shop.localhost")).toBe(true);
    const report = await runDrift(deps);
    expect(report.clean).toBe(false);
    expect(report.pending).toEqual([
      expect.objectContaining({
        address: "the app's hostname shop.localhost → prod.shop.localhost",
        action: "update",
      }),
    ]);
    expect(renderDriftReport(report)).toContain(
      "the app's hostname shop.localhost → prod.shop.localhost (not applied yet)",
    );
  });
});

describe("secure on this computer", () => {
  it("checks only what applies to a local stack, and says which server checks do not", async () => {
    const { deps, computer } = await deployed();
    // This test computer's own OS: the file modes are read from its disk.
    const local = computer.services({ platform: process.platform });
    const secure = () => runSecure(deps, { scanners: [], offline: true, localhost: local });
    const result = await secure();
    const status = Object.fromEntries(result.hostChecks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      "local-loopback": "pass",
      "local-containers": "pass",
      "local-certificate": "pass",
    });
    if (process.platform !== "win32") {
      expect(status).toMatchObject({ "local-ca-key": "pass", "local-env-files": "pass" });
    }
    expect(result.probes).toEqual([]);
    expect(result.problems.filter((p) => p.status === "fail")).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.report).toContain("## The stack on this computer");
    expect(result.report).toContain(
      "a server's checks (its SSH settings, firewall, fail2ban, automatic security updates and kernel settings) do not apply to a local stack",
    );
    expect(result.report).toContain("OpsCrew probes no port of this computer from outside");
    // A container on the host's network fails the hardening check.
    computer.network = (name) => (name === "opscrew-shop-app-1" ? "host" : "bridge");
    const loose = await secure();
    expect(loose.hostChecks.find((c) => c.id === "local-containers")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("opscrew-shop-app-1 shares the host's network or processes"),
    });
  });

  it("skips the server, SSH and TLS audits with --deep", async () => {
    const { deps, computer } = await deployed();
    const result = await runSecure(deps, {
      scanners: [],
      offline: true,
      deep: true,
      localhost: computer.services(),
    });
    expect(result.deep?.map((tool) => tool.results.map((r) => r.status))).toEqual([
      ["skip"],
      ["skip"],
      ["skip"],
    ]);
  });
});
