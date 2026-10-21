import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { CommandResult } from "@opscrew/contracts";
import { findExecutable, type OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedRunner,
  testPlan,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const CADDY = "opscrew/proxy/additions.caddy";
const NGINX = "opscrew/proxy/additions.nginx";

/**
 * A Hetzner project with a proxied domain whose `docker` answers as `docker` says (`undefined`:
 * Docker is not installed); git and ssh as in the other provision tests.
 */
async function project(
  o: { plan?: DeployPlan; docker?: (args: readonly string[]) => CommandResult } = {},
) {
  const created = await createProject(o.plan ?? testPlan({ domain: "shop.example.com" }));
  await writeFile(
    join(created.root, "production.env"),
    `STRIPE_SECRET_KEY=${fakeSecret("stripe-live-key")}\n`,
  );
  const base = projectRunner();
  const docker: string[][] = [];
  const runner = new ScriptedRunner((command, args, options) => {
    if (command !== "docker") return base.run(command, args, options);
    docker.push([...args]);
    if (o.docker === undefined) throw new Error("spawn docker ENOENT");
    return o.docker(args);
  });
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: created.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(created.root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner,
    approvalHandler: handler,
  });
  const zone = new FakeZone();
  const services: ProvisionServices = {
    engine: async () => new FakeEngine({ planJson: planJsonFor({ proxied: true }) }),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github: new FakeGitHub(),
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(zone),
    which: () => undefined,
  };
  return { ...created, deps, handler, services, zone, docker };
}

/** Writes the user's additions file into the project. */
async function write(s: { root: string }, path: string, text: string): Promise<void> {
  await mkdir(dirname(join(s.root, path)), { recursive: true });
  await writeFile(join(s.root, path), text);
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const refusedBefore = async (s: Awaited<ReturnType<typeof project>>) => {
  const error = (await runProvision(s.deps, { services: s.services }).catch(
    (e: unknown) => e,
  )) as OpsCrewError;
  // Nothing was asked or changed: no Cloudflare plan, no files, no infrastructure.
  expect(s.handler.requests).toEqual([]);
  expect(s.zone.writes()).toEqual([]);
  return error;
};

describe.skipIf(!findExecutable("git"))("opscrew provision: the app's own additions", () => {
  it("refuses an unsafe addition before any change, with its line and what to do", async () => {
    const s = await project({ docker: () => ok() });
    await write(
      s,
      CADDY,
      "header X-Frame-Options DENY\nreverse_proxy http://evil.example.net:80\n",
    );
    const error = await refusedBefore(s);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      `OpsCrew refuses your additions in ${CADDY}. Nothing was changed.`,
    );
    expect(error.message).toMatch(/line 2 \(upstream\): /);
    expect(error.hint).toContain(CADDY);
    // OpsCrew's rules refused it: the proxy's checker never ran.
    expect(s.docker.filter((args) => args[0] === "run")).toEqual([]);
  });

  it("refuses a file for the other proxy, with how to convert it", async () => {
    const s = await project({ docker: () => ok() });
    await write(s, NGINX, "add_header X-Test 1;\n");
    const error = await refusedBefore(s);
    expect(error.message).toBe(
      `${NGINX} holds additions for nginx, but this app's proxy is Caddy (target.edge), so OpsCrew would not use them. Nothing was changed.`,
    );
    expect(error.hint).toContain(`Write the same rules in Caddy's syntax in ${CADDY}`);
  });

  it("checks valid additions with the proxy's own checker in its pinned image, then deploys them", async () => {
    const s = await project({ docker: (args) => ok(args[0] === "version" ? "29.1.3\n" : "") });
    await write(s, CADDY, "header X-Robots-Tag noindex\n");
    await runProvision(s.deps, { services: s.services });
    const checks = s.docker.filter((args) => args[0] === "run");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        IMAGES.caddy.ref,
        "validate",
        "--adapter",
        "caddyfile",
      ]),
    );
    const site = await readFile(join(s.root, "opscrew/runtime/edge/sites/shop.caddy"), "utf8");
    expect(site).toContain("import /etc/caddy/sites/shop.additions");
    const workflow = await readFile(join(s.root, ".github/workflows/opscrew-deploy.yml"), "utf8");
    expect(workflow).toContain(CADDY);
    // The additions are committed with the deployment files, so the deploy finds them.
    expect(await s.git(s.root, "show", "--name-only", "HEAD")).toContain(CADDY);
  });

  it("on nginx checks each of the app's site files with nginx -t, and stops on its refusal", async () => {
    const nginx = (plan: DeployPlan) =>
      DeployPlanSchema.parse({ ...plan, target: { ...plan.target, edge: "nginx" } });
    const base = testPlan({ domain: "shop.example.com" });
    const s = await project({
      plan: nginx({ ...base, dns: { ...base.dns, proxied: false } }),
      docker: (args) =>
        args[0] === "version"
          ? ok("29.1.3\n")
          : {
              exitCode: 1,
              stdout: "",
              stderr:
                'nginx: [emerg] unknown directive "add_heade" in /etc/nginx/sites/shop.additions:1',
            },
    });
    await write(s, NGINX, "add_heade X-Test 1;\n");
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    // OpsCrew's own rules refuse an unknown directive first, before the checker.
    expect(error.message).toContain(`OpsCrew refuses your additions in ${NGINX}`);

    await write(s, NGINX, "add_header X-Test 1;\n");
    const checked = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(checked.code).toBe("PHASE_PRECONDITION");
    expect(checked.message).toContain(
      `nginx refused this app's site with your additions in ${NGINX}`,
    );
    expect(checked.message).toContain('unknown directive "add_heade"');
    expect(checked.message).toContain("Nothing was changed.");
    const run = s.docker.find((args) => args[0] === "run");
    expect(run).toEqual(expect.arrayContaining(["--entrypoint", "nginx", IMAGES.nginx.ref, "-t"]));
    expect(s.handler.requests).toEqual([]);
    expect(s.zone.writes()).toEqual([]);
  });

  it("without Docker, says the proxy's check runs in the deploy, and goes on", async () => {
    const s = await project();
    await write(s, CADDY, "header X-Robots-Tag noindex\n");
    await runProvision(s.deps, { services: s.services });
    expect(s.deps.reporter.text()).toContain(
      "Docker is not running on this computer, so Caddy's own check of your additions runs in the deploy, before anything reaches the server.",
    );
  });
});
