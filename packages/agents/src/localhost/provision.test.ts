// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
import { X509Certificate } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson, readTextIfExists, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runProvision } from "../provision";
import { ScriptedApprovalHandler } from "../testing";
import { DIGEST, FakeComputer, localPlan, localProject } from "./__fixtures__/computer";
import { applyLocal } from "./apply";
import { caFiles } from "./ca";
import { destroyLocalhost } from "./destroy";
import { ghcrReadCredential } from "./image";
import { withLocalLock } from "./lock";
import { localPlanFile, planLocal } from "./plan";
import { appFolder, localRoots } from "./services";

/** A project for the localhost plan with its Dockerfile, and `opscrew provision` on it. */
async function project(
  plan = localPlan(),
  computer = new FakeComputer(),
  approve = new ScriptedApprovalHandler(),
) {
  const { deps, root } = await localProject(plan, computer, { approve });
  await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
  const run = (options: Parameters<typeof runProvision>[1] = {}) =>
    runProvision(deps, { ...options, services: { localhost: computer.services() } });
  return { deps, root, computer, run, approve };
}

/** The script of the start step (the switch script), from what the shell ran. */
function startScript(computer: FakeComputer): string {
  return computer.scripts.find((s) => s.script.includes("docker compose pull"))?.script ?? "";
}

describe("provision on this computer", () => {
  it("shows the local plan and its hash with --plan-only, and changes nothing", async () => {
    const { deps, run, computer } = await project();
    const result = await run({ planOnly: true });
    expect(result).toMatchObject({ applied: false, localApplied: false, outputs: {} });
    expect(result.localPlanHash).toMatch(/^[0-9a-f]{64}$/);
    // Only read-only questions to Docker; no script ran.
    expect(computer.scripts).toEqual([]);
    const saved = JSON.parse(
      await readFile(localPlanFile(deps.paths, result.localPlanHash as string), "utf8"),
    );
    expect(sha256Hex(canonicalJson(saved))).toBe(result.localPlanHash);
    expect(saved).toMatchObject({
      purpose: "setup",
      app: "shop",
      project: "opscrew-shop",
      address: "https://shop.localhost:8443",
      ports: { https: 8443, http: 8080 },
    });
    const items = saved.items as { kind: string; name: string; action: string; detail?: string }[];
    expect(items.map((i) => `${i.action} ${i.kind} ${i.name}`)).toEqual(
      expect.arrayContaining([
        "create folder srv/apps/shop",
        "create folder srv/edge",
        "create file srv/apps/shop/.opscrew-project",
        "create file srv/apps/shop/compose.yaml",
        "create file srv/apps/shop/edge/compose.yaml",
        "create file srv/apps/shop/edge/sites/shop.caddy",
        "create file srv/apps/shop/app.env",
        "create file srv/apps/shop/db.env",
        "create certificate OpsCrew local CA (test-laptop)",
        "create certificate shop.localhost",
        "change image built from Dockerfile",
        "create container opscrew-shop-app",
        "create container opscrew-shop-db",
        "create container opscrew-edge-caddy",
        "create container opscrew-edge-kamal-proxy",
        "create network opscrew-shop_internal",
        "create network opscrew-edge",
        "create volume opscrew-shop_db_data",
      ]),
    );
    // Env files are listed by name only: they hold secrets.
    expect(items.find((i) => i.name.endsWith("app.env"))?.detail).toBe(
      "secret values, never shown",
    );
    expect(deps.reporter.text()).toContain(`Local plan hash: ${result.localPlanHash}`);
    expect(deps.reporter.text()).toContain(
      "the ports on 127.0.0.1 only; certificates from OpsCrew's local CA",
    );
    // The CA is made only when the plan is applied.
    expect(await readTextIfExists(caFiles(deps.paths).key)).toBeUndefined();
  });

  it("applies the approved plan: files, the leaf, the image build, the start script and the health check", async () => {
    const { deps, run, computer, approve } = await project();
    const result = await run();
    expect(result).toMatchObject({
      localApplied: true,
      outputs: { url: "https://shop.localhost:8443" },
    });
    const requests = approve.requests;
    expect(requests.map((r) => r.kind)).toEqual(["repo-write", "host-apply"]);
    expect(requests[1]).toMatchObject({ planHash: result.localPlanHash });
    expect(requests[1]?.allowDestroy).toBeUndefined();

    const folder = appFolder(deps.paths, localPlan());
    for (const file of [
      "compose.yaml",
      "edge/compose.yaml",
      "edge/sites/shop.caddy",
      "app.env",
      "db.env",
    ]) {
      expect(await readTextIfExists(join(folder, file)), file).toBeDefined();
    }
    // The leaf for shop.localhost, signed by the local CA, where the start script takes it.
    const tls = join(localRoots(deps.paths).edge, "tls", "shop");
    const leaf = new X509Certificate(await readFile(join(tls, "local.pem.new"), "utf8"));
    const ca = new X509Certificate(await readFile(caFiles(deps.paths).certificate, "utf8"));
    expect(leaf.subjectAltName).toBe("DNS:shop.localhost");
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(Date.parse(leaf.validTo) - Date.parse("2026-10-11T12:00:00.000Z")).toBeLessThanOrEqual(
      825 * 86_400_000,
    );
    expect(ca.subject).toContain("OpsCrew local CA (test-laptop)");
    if (process.platform !== "win32") {
      expect((await stat(caFiles(deps.paths).key)).mode & 0o777).toBe(0o600);
      expect((await stat(join(tls, "local.key.new"))).mode & 0o777).toBe(0o600);
    }

    // The build, the saved previous version, then the production start script with the image.
    expect(computer.scripts[0]?.script).toContain("docker build -q -f 'Dockerfile'");
    expect(computer.scripts[1]?.script).toContain("cp .env .env.previous");
    const start = startScript(computer);
    expect(start.split("\n").slice(0, 3)).toEqual([
      "set -- 'opscrew-local/shop:0123456789ab'",
      'APPS_DIR="${OPSCREW_APPS_DIR:-/srv/apps}"',
      'EDGE_DIR="${OPSCREW_EDGE_DIR:-/srv/edge}"',
    ]);
    expect(start).toContain("--host shop.localhost");
    // The local executor's roots, and the health check through 127.0.0.1 with SNI and the CA.
    const call = computer.runner.calls.find((c) => c.command === "/bin/sh");
    expect(call?.options?.env?.OPSCREW_APPS_DIR).toBe(
      `${join(deps.paths.homeDir, "local", "srv", "apps").replaceAll("\\", "/")}`,
    );
    expect(computer.requests).toEqual([
      expect.objectContaining({
        scheme: "https",
        port: 8443,
        hostname: "shop.localhost",
        path: "/api/health",
        ca: expect.stringContaining("BEGIN CERTIFICATE"),
      }),
    ]);

    // Recorded in the plan, with the approval; the lock is released.
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.deployment.lastApplyAt).toBe("2026-10-11T12:00:00.000Z");
    expect(plan.approvals).toEqual([
      expect.objectContaining({ kind: "host-apply", planHash: result.localPlanHash }),
    ]);
    expect(
      await readTextIfExists(join(deps.paths.homeDir, "local", "deploy.lock")),
    ).toBeUndefined();
    expect(deps.audit.entries.map((e) => e.action)).toEqual(
      expect.arrayContaining(["local apply started", "local apply finished"]),
    );
    expect(deps.reporter.text()).toContain("`opscrew localhost trust`");
  });

  it("never shows the local CA's key, a leaf's key or a secret anywhere", async () => {
    const { deps, run, computer, approve } = await project(localPlan({ image: "registry" }));
    const result = await run();
    const caKey = await readFile(caFiles(deps.paths).key, "utf8");
    const tls = join(localRoots(deps.paths).edge, "tls", "shop");
    const leafKey = await readFile(join(tls, "local.key.new"), "utf8");
    const dbEnv = await readFile(join(appFolder(deps.paths, localPlan()), "db.env"), "utf8");
    const password = /POSTGRES_PASSWORD=(.+)/.exec(dbEnv)?.[1];
    expect(password).toMatch(/.{16,}/);
    const keyBody = (pem: string) => pem.split("\n")[1] as string;
    const outputs = [
      deps.reporter.text(),
      JSON.stringify(deps.audit.entries),
      JSON.stringify(approve.requests),
      await readFile(deps.paths.files.plan, "utf8"),
      await readFile(localPlanFile(deps.paths, result.localPlanHash as string), "utf8"),
      ...computer.runner.calls.map((c) => `${c.command} ${c.args.join(" ")}`),
      ...computer.scripts.map((s) => s.script),
    ];
    for (const text of outputs) {
      expect(text).not.toContain(keyBody(caKey));
      expect(text).not.toContain(keyBody(leafKey));
      expect(text).not.toContain(password);
      expect(text).not.toContain(computer.registryToken);
    }
    // The registry token reaches Docker only on the login's stdin.
    const login = computer.scripts.find((s) => s.script.includes("docker login"));
    expect(login?.input.endsWith(`${computer.registryToken}\n`)).toBe(true);
  });

  it("deploys the image prod runs from GHCR, by digest, and is up to date the next time", async () => {
    const { deps, run, computer } = await project(localPlan({ image: "registry" }));
    const first = await run();
    expect(startScript(computer).split("\n")[0]).toBe(`set -- 'ghcr.io/acme/shop@${DIGEST}'`);
    expect(computer.scripts.some((s) => s.script.includes("docker build"))).toBe(false);
    // Logged in to GHCR only around the start script, so the token never stays on disk.
    const steps = computer.scripts.map((s) =>
      s.script.includes("docker login")
        ? "login"
        : s.script.includes("docker logout ghcr.io > /dev/null 2>&1 || true")
          ? "logout"
          : s.script.includes("docker compose pull")
            ? "start"
            : "other",
    );
    expect(steps.slice(-3)).toEqual(["login", "start", "logout"]);
    // The hostname served, which verify, status and drift read.
    expect(JSON.parse(await readFile(join(deps.paths.stateDir, "localhost.json"), "utf8"))).toEqual(
      { hostname: "shop.localhost" },
    );
    expect(
      await readFile(join(appFolder(deps.paths, localPlan()), ".opscrew-project"), "utf8"),
    ).toBe(`${deps.paths.projectId}\n`);
    // What the start script leaves: the stack running, the image in .env, the leaf in place.
    computer.deployed();
    const folder = appFolder(deps.paths, localPlan());
    await writeFile(join(folder, ".env"), `APP_IMAGE=ghcr.io/acme/shop@${DIGEST}\n`);
    const tls = join(localRoots(deps.paths).edge, "tls", "shop");
    await rename(join(tls, "local.pem.new"), join(tls, "local.pem"));
    await rename(join(tls, "local.key.new"), join(tls, "local.key"));
    const scripts = computer.scripts.length;
    const again = await run();
    expect(again).toMatchObject({ localApplied: false });
    expect(again.localPlanHash).not.toBe(first.localPlanHash);
    expect(computer.scripts).toHaveLength(scripts);
    expect(deps.reporter.text()).toContain(
      "The app on this computer is up to date at https://shop.localhost:8443; nothing changes.",
    );
  });

  it("checks the app's additions to its site before any change, as on a server", async () => {
    const wrong = await project();
    await mkdir(join(wrong.root, "opscrew", "proxy"), { recursive: true });
    await writeFile(join(wrong.root, "opscrew", "proxy", "additions.nginx"), "add_header X-A b;\n");
    await expect(wrong.run()).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("holds additions for nginx"),
    });
    expect(wrong.computer.scripts).toEqual([]);
    expect(
      await readTextIfExists(join(wrong.root, "opscrew", "runtime", "compose.yaml")),
    ).toBeUndefined();

    // Caddy's own check validates the site with them, the leaf's place filled for the check.
    const right = await project();
    await mkdir(join(right.root, "opscrew", "proxy"), { recursive: true });
    await writeFile(join(right.root, "opscrew", "proxy", "additions.caddy"), "header X-A b\n");
    await right.run({ planOnly: true });
    const check = right.computer.runner.calls.find(
      (c) => c.command === "docker" && c.args[0] === "run",
    );
    expect(check?.args.join(" ")).toContain("caddy validate");
  });

  it("logs out of GHCR even when the start script fails", async () => {
    const computer = new FakeComputer();
    computer.script = (script) =>
      script.includes("docker compose pull")
        ? { exitCode: 1, stdout: "", stderr: "pull failed" }
        : { exitCode: 0, stdout: "unchanged\n", stderr: "" };
    const { run } = await project(localPlan({ image: "registry" }), computer);
    await expect(run()).rejects.toMatchObject({ code: "COMMAND_FAILED" });
    const start = computer.scripts.findIndex((s) => s.script.includes("docker compose pull"));
    expect(computer.scripts[start + 1]?.script).toContain("docker logout ghcr.io");
  });

  it("refuses an app of the same name another project runs on this computer, at plan and destroy", async () => {
    const computer = new FakeComputer();
    const a = await project(localPlan({ image: "registry" }), computer);
    await a.run();
    const folder = appFolder(a.deps.paths, localPlan());
    const before = await readFile(join(folder, "compose.yaml"), "utf8");
    computer.deployed();
    // Repository B on the same computer, its app also named shop.
    const b = await localProject(localPlan({ image: "registry" }), computer, {
      home: a.deps.paths.homeDir,
    });
    await writeFile(join(b.root, "Dockerfile"), "FROM node:22-alpine\n");
    const scripts = computer.scripts.length;
    const refusal = {
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        'This computer runs an OpsCrew app named "shop" from another project',
      ),
    };
    await expect(
      runProvision(b.deps, { services: { localhost: computer.services() } }),
    ).rejects.toMatchObject({
      ...refusal,
      message: expect.stringContaining("does not deploy over it"),
    });
    const deploy = {
      plan: localPlan(),
      site: { hostname: "shop.localhost" },
      image: {
        source: "registry" as const,
        ref: `ghcr.io/acme/shop@${DIGEST}`,
        environment: "prod",
        emulated: false,
      },
      uploads: [],
      envFiles: [],
      buildValues: { args: {}, secrets: {} },
    };
    await expect(planLocal(b.deps, deploy, computer.services())).rejects.toMatchObject(refusal);
    await expect(
      destroyLocalhost(b.deps, localPlan(), {}, computer.services()),
    ).rejects.toMatchObject({ ...refusal, message: expect.stringContaining("removes nothing") });
    // A is untouched.
    expect(computer.scripts).toHaveLength(scripts);
    expect(await readFile(join(folder, "compose.yaml"), "utf8")).toBe(before);
    expect(await readFile(join(folder, ".opscrew-project"), "utf8")).toBe(
      `${a.deps.paths.projectId}\n`,
    );
  });

  it("pulls with OPSCREW_GHCR_READ_TOKEN when it is set, hidden from every output", async () => {
    const { deps } = await localProject();
    const token = fakeSecret("github-token", "ghcr-read");
    expect(ghcrReadCredential({ ...deps, env: {} }, "acme")).toBeUndefined();
    expect(
      ghcrReadCredential({ ...deps, env: { OPSCREW_GHCR_READ_TOKEN: ` ${token} ` } }, "acme"),
    ).toEqual({
      username: "acme",
      token,
    });
    expect(deps.redactor.redact(`token ${token}`)).not.toContain(token);
  });

  it("refuses an image GHCR does not have, before any change", async () => {
    const computer = new FakeComputer();
    computer.digests.clear();
    const { run, root } = await project(localPlan({ image: "registry" }), computer);
    await expect(run()).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "GitHub Container Registry has no image labelled opscrew-prod yet",
      ),
      hint: expect.stringContaining("set target.image to local-build"),
    });
    expect(computer.scripts).toEqual([]);
    expect(
      await readTextIfExists(join(root, "opscrew", "runtime", "compose.yaml")),
    ).toBeUndefined();
  });

  it("stops on every preflight problem before any change", async () => {
    const computer = new FakeComputer();
    computer.info = "stopped";
    const { deps, run } = await project(localPlan(), computer);
    await expect(run()).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringMatching(
        /^OpsCrew cannot run the app on this computer yet, so it changed nothing:\n {2}- Docker does not answer/,
      ),
    });
    expect(computer.scripts).toEqual([]);
    expect(
      await readTextIfExists(join(deps.paths.root, "opscrew", "runtime", "compose.yaml")),
    ).toBeUndefined();
  });

  it("changes nothing when the local plan is not approved", async () => {
    const computer = new FakeComputer();
    const { run } = await project(
      localPlan(),
      computer,
      new ScriptedApprovalHandler((request) => request.kind !== "host-apply"),
    );
    await expect(run()).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining(
        "The local plan was not approved. Nothing on this computer was changed.",
      ),
      hint: expect.stringMatching(/opscrew provision --approve [0-9a-f]{64}/),
    });
    expect(computer.scripts).toEqual([]);
  });

  it("puts the previous version back when the new one does not answer", async () => {
    const computer = new FakeComputer();
    computer.answer = () => ({ status: 502 });
    computer.script = (script) =>
      script.includes("no-previous")
        ? { exitCode: 0, stdout: "restored\n", stderr: "" }
        : script.includes("docker build")
          ? { exitCode: 0, stdout: "opscrew-local/shop:0123456789ab\n", stderr: "" }
          : { exitCode: 0, stdout: "", stderr: "" };
    const { deps, run } = await project(localPlan(), computer);
    await expect(run()).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message:
        "The new version did not answer at https://shop.localhost:8443/api/health.\nOpsCrew put the previous version back.",
    });
    expect(computer.scripts.at(-1)?.script).toContain('grep -qxF "APP_IMAGE=$1" .env');
    expect(deps.audit.entries.map((e) => e.action)).toContain("local apply failed");
    expect(
      (await readArtifact("plan", deps.paths.files.plan)).deployment.lastApplyAt,
    ).toBeUndefined();
  });
  // The local runner's workflow, secrets and pull request: runners/local-provision.test.ts.
});

describe("planLocal and applyLocal", () => {
  async function deploy() {
    const computer = new FakeComputer();
    const { deps, root } = await localProject(localPlan(), computer);
    const files = [
      {
        path: "compose.yaml",
        content: "name: opscrew-shop\nservices:\n  app:\n    mem_limit: 512m\n",
      },
      {
        path: "edge/compose.yaml",
        content: "name: opscrew-edge\nservices:\n  caddy:\n    mem_limit: 64m\n",
      },
    ];
    return {
      deps,
      root,
      computer,
      deploy: {
        plan: localPlan(),
        site: { hostname: "shop.localhost" },
        image: { source: "local-build" as const, dockerfile: "Dockerfile", context: "." },
        uploads: files,
        envFiles: [{ path: "app.env", content: "SESSION_SECRET=generated\n" }],
        buildValues: { args: {}, secrets: {} },
      },
    };
  }

  it("hashes the canonical plan: the same inputs give the same hash, a changed file another", async () => {
    const { deps, deploy: input, computer } = await deploy();
    const a = await planLocal(deps, input, computer.services());
    const b = await planLocal(deps, input, computer.services());
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(sha256Hex(canonicalJson(a.plan)));
    const changed = await planLocal(
      deps,
      {
        ...input,
        uploads: [
          { ...input.uploads[0], content: "name: other\nservices: {}\n" } as never,
          input.uploads[1] as never,
        ],
      },
      computer.services(),
    );
    expect(changed.hash).not.toBe(a.hash);
    // An env file's content is in no item: changing a secret changes the item's action only.
    expect(JSON.stringify(a.plan)).not.toContain("generated");
  });

  it("applies only the plan the approval names, and only once it is approved", async () => {
    const { deps, deploy: input, computer } = await deploy();
    const { hash } = await planLocal(deps, input, computer.services());
    await expect(
      applyLocal(deps, input, { approvedHash: "0".repeat(64), services: computer.services() }),
    ).rejects.toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    await expect(
      applyLocal(deps, input, { approvedHash: hash, services: computer.services() }),
    ).rejects.toMatchObject({
      code: "PLAN_NOT_APPROVED",
    });
    expect(computer.scripts).toEqual([]);
  });
});

describe("the local deploy lock", () => {
  it("serialises deploys, and takes over a lock its process left behind", async () => {
    const { deps } = await localProject(localPlan(), new FakeComputer());
    const order: string[] = [];
    let waits = 0;
    const sleep = async () => {
      waits += 1;
    };
    let release: () => void = () => {};
    const first = withLocalLock(deps.paths, sleep, async () => {
      order.push("first");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = withLocalLock(
      deps.paths,
      async () => {
        waits += 1;
        release();
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      async () => {
        order.push("second");
      },
    );
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
    expect(waits).toBeGreaterThan(0);
    // A lock whose process is gone is taken over at once.
    await writeFile(join(deps.paths.homeDir, "local", "deploy.lock"), "2147483646\n");
    await withLocalLock(deps.paths, sleep, async () => order.push("third"));
    expect(order.at(-1)).toBe("third");
  });

  it("gives up after 10 minutes with what to do", async () => {
    const { deps } = await localProject(localPlan(), new FakeComputer());
    await mkdir(dirname(join(deps.paths.homeDir, "local", "deploy.lock")), { recursive: true });
    // This test's own process holds it, and never lets go.
    await writeFile(join(deps.paths.homeDir, "local", "deploy.lock"), `${process.pid}\n`);
    await expect(
      withLocalLock(
        deps.paths,
        async () => {},
        async () => "never",
      ),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      hint: expect.stringContaining("deploy.lock"),
    });
  });
});
