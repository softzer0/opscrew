// biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions, not JavaScript templates.
import { createHash } from "node:crypto";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { readCheckScript, renderGeneratedCheck } from "../../scripts/gen-modules";
import { testPlan } from "../__fixtures__/plans";
import { CHECK_SCRIPT } from "../generated/check";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { ssrPlan } from "../serverless/__fixtures__/plans";
import type { RenderedFile } from "../types";
import { inEnvironment, ofApp } from "../workflow/__fixtures__/plans";
import { checkEnvironmentKey, checkServerSecret, renderCheck } from "./index";

type Check = NonNullable<NonNullable<DeployPlan["observability"]>["check"]>;

const PUBLIC = { owner: "example-org", name: "example-app", public: true };
const PRIVATE = { ...PUBLIC, public: false };

/** `plan` with the scheduled check on (and `check`'s settings). */
function withCheck(plan: DeployPlan, check: Check = {}): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, observability: { check: { enabled: true, ...check } } });
}

function file(files: RenderedFile[], path: string): string {
  const found = files.find((f) => f.path === path);
  if (found === undefined) throw new Error(`renderCheck wrote no ${path}.`);
  return found.content;
}

const workflowOf = (files: RenderedFile[]) => file(files, ".github/workflows/opscrew-check.yml");
const configOf = (files: RenderedFile[]) => JSON.parse(file(files, "opscrew/check/check.json"));

/** The minutes of the workflow's cron line. */
function cronMinutes(files: RenderedFile[]): number[] {
  const cron: string = parse(workflowOf(files)).on.schedule[0].cron;
  expect(cron).toMatch(/^[\d,]+ \* \* \* \*$/);
  return (cron.split(" ")[0] ?? "").split(",").map(Number);
}

/** The private repository: a server runner, a Portainer environment and a Cloudflare app. */
function privatePlans(): DeployPlan[] {
  const own = testPlan({ provider: "own", domain: "shop.example.com" });
  return [
    inEnvironment(withCheck(own, { webhook: "ntfy" }), { runner: "server" }),
    // An environment with the check off is left out.
    inEnvironment(own, { name: "staging" }),
    withCheck(ofApp(portainerTestPlan({ domain: "portal.example.com" }), "docs")),
    withCheck(ofApp(ssrPlan(), "site")),
  ];
}

describe("renderCheck", () => {
  it("renders the workflow, check.json and check.mjs for a public repository with one cloud environment", () => {
    const files = renderCheck({
      plans: [withCheck(testPlan({ domain: "example.com", www: true }))],
      repo: PUBLIC,
    });
    expect(files.map((f) => [f.path, f.kind])).toEqual([
      [".github/workflows/opscrew-check.yml", "workflow"],
      ["opscrew/check/check.json", "workflow"],
      ["opscrew/check/check.mjs", "workflow"],
    ]);
    expect(workflowOf(files)).toMatchSnapshot();
    expect(file(files, "opscrew/check/check.json")).toMatchSnapshot();
    expect(file(files, "opscrew/check/check.mjs")).toBe(CHECK_SCRIPT);
    const workflow = parse(workflowOf(files));
    expect(workflow.permissions).toEqual({ contents: "read", issues: "write" });
    expect(workflow.on.workflow_dispatch).toEqual({});
    expect(workflow.jobs.check.if).toBe("github.repository == 'example-org/example-app'");
    expect(workflow.jobs.check["timeout-minutes"]).toBe(5);
    expect(workflow.jobs.check.concurrency).toEqual({
      group: "opscrew-check",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs.check.steps.at(-1)).toEqual({
      name: "Run the check",
      env: {
        GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
        OPSCREW_CHECK_PAUSED: "${{ vars.OPSCREW_CHECK_PAUSED }}",
        OPSCREW_CHECK_SSH_KEY: "${{ secrets.OPSCREW_CHECK_SSH_KEY }}",
        OPSCREW_CHECK_SERVER: "${{ secrets.OPSCREW_CHECK_SERVER }}",
      },
      run: "node opscrew/check/check.mjs",
    });
    expect(configOf(files).environments).toEqual([
      {
        key: "shop/prod",
        hosts: [
          { hostname: "example.com", healthPath: "/api/health" },
          { hostname: "www.example.com", healthPath: "/api/health" },
        ],
        server: { id: "hetzner-shop", secret: "OPSCREW_CHECK_SERVER", via: "github" },
      },
    ]);
  });

  it("renders a private repository's server runner, Portainer environment and Cloudflare app", () => {
    const files = renderCheck({ plans: privatePlans(), repo: PRIVATE });
    expect(workflowOf(files)).toMatchSnapshot();
    expect(file(files, "opscrew/check/check.json")).toMatchSnapshot();
    const config = configOf(files);
    expect(config.intervalMinutes).toBe(60);
    expect(config.webhook).toBe("ntfy");
    expect(config.public).toBe(false);
    expect(config.environments).toEqual([
      {
        key: "shop/prod",
        hosts: [{ hostname: "shop.example.com", healthPath: "/api/health" }],
        server: { id: "own-shop", via: "own-runner" },
      },
      { key: "docs/prod", hosts: [{ hostname: "portal.example.com", healthPath: "/api/health" }] },
      { key: "site/prod", hosts: [{ hostname: "docs.example.com", healthPath: "/" }] },
    ]);
    const workflow = parse(workflowOf(files));
    expect(workflow.jobs.check.steps.at(-1).env).toEqual({
      GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      OPSCREW_CHECK_PAUSED: "${{ vars.OPSCREW_CHECK_PAUSED }}",
      OPSCREW_CHECK_WEBHOOK: "${{ secrets.OPSCREW_CHECK_WEBHOOK }}",
      OPSCREW_CHECK_NTFY_TOKEN: "${{ secrets.OPSCREW_CHECK_NTFY_TOKEN }}",
    });
    const disk = workflow.jobs["disk-own-shop"];
    expect(disk["runs-on"]).toEqual(["self-hosted", "opscrew-shop-prod"]);
    expect(disk.concurrency).toEqual({
      group: "opscrew-check-disk-own-shop",
      "cancel-in-progress": false,
    });
    expect(disk.steps.at(-1).run).toBe("node opscrew/check/check.mjs --only disk:own-shop");
  });

  it("checks a runner machine's server over SSH from a job on that machine", () => {
    const cloud = withCheck(testPlan({ domain: "shop.example.com" }));
    const staging = inEnvironment(cloud, {
      name: "staging",
      runner: "host",
      runnerHost: { name: "builder", arch: "amd64" },
    });
    const files = renderCheck({ plans: [cloud, staging], repo: PRIVATE });
    expect(configOf(files).environments[1]).toEqual({
      key: "shop-staging/staging",
      hosts: [{ hostname: "staging-shop.example.com", healthPath: "/api/health" }],
      server: {
        id: "hetzner-shop-staging",
        secret: "OPSCREW_STAGING_CHECK_SERVER",
        via: "runner-host",
      },
    });
    const workflow = parse(workflowOf(files));
    expect(workflow.jobs.check.steps.at(-1).env).not.toHaveProperty("OPSCREW_STAGING_CHECK_SERVER");
    const disk = workflow.jobs["disk-hetzner-shop-staging"];
    expect(disk["runs-on"]).toEqual(["self-hosted", "opscrew-shop-staging"]);
    expect(disk.steps.at(-1).env).toEqual({
      GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      OPSCREW_CHECK_PAUSED: "${{ vars.OPSCREW_CHECK_PAUSED }}",
      OPSCREW_CHECK_SSH_KEY: "${{ secrets.OPSCREW_CHECK_SSH_KEY }}",
      OPSCREW_STAGING_CHECK_SERVER: "${{ secrets.OPSCREW_STAGING_CHECK_SERVER }}",
    });
  });

  it("takes the interval from the first app's prod plan, else 15 when public and 60 when private", () => {
    const prod = withCheck(testPlan({ domain: "shop.example.com" }), { intervalMinutes: 30 });
    const docs = withCheck(ofApp(testPlan({ domain: "docs.example.com" }), "docs"), {});
    expect(configOf(renderCheck({ plans: [docs, prod], repo: PUBLIC })).intervalMinutes).toBe(30);
    expect(cronMinutes(renderCheck({ plans: [docs, prod], repo: PUBLIC }))).toHaveLength(2);
    // The first app's prod plan sets it even with its own check off.
    const off = DeployPlanSchema.parse({
      ...prod,
      observability: { check: { enabled: false, intervalMinutes: 10 } },
    });
    expect(configOf(renderCheck({ plans: [off, docs], repo: PRIVATE })).intervalMinutes).toBe(10);
    expect(configOf(renderCheck({ plans: [docs], repo: PUBLIC })).intervalMinutes).toBe(15);
    expect(configOf(renderCheck({ plans: [docs], repo: PRIVATE })).intervalMinutes).toBe(60);
  });

  it("runs every interval from a minute derived from the repository's name, never at :00", () => {
    for (const interval of [5, 10, 15, 20, 30, 60] as const) {
      for (const name of ["example-app", "shop", "docs", "a", "b", "c", "d", "e", "f", "g"]) {
        const repo = { owner: "example-org", name, public: true };
        const plans = [
          withCheck(testPlan({ domain: "shop.example.com" }), { intervalMinutes: interval }),
        ];
        const minutes = cronMinutes(renderCheck({ plans, repo }));
        const hash = createHash("sha256").update(`example-org/${name}`).digest().readUInt32BE(0);
        const first = 1 + (hash % (interval - 1));
        expect(minutes).toEqual(
          Array.from({ length: 60 / interval }, (_, i) => first + i * interval),
        );
        expect(minutes.every((minute) => minute > 0 && minute < 60)).toBe(true);
        expect(cronMinutes(renderCheck({ plans, repo }))).toEqual(minutes);
      }
    }
  });

  it("renders nothing when no plan has the check on", () => {
    const plan = testPlan({ domain: "shop.example.com" });
    expect(renderCheck({ plans: [], repo: PUBLIC })).toEqual([]);
    expect(renderCheck({ plans: [plan], repo: PUBLIC })).toEqual([]);
    const off = DeployPlanSchema.parse({ ...plan, observability: { check: { enabled: false } } });
    expect(renderCheck({ plans: [off], repo: PUBLIC })).toEqual([]);
  });

  it("leaves out destroyed environments", () => {
    const prod = withCheck(testPlan({ domain: "shop.example.com" }));
    const destroyed = DeployPlanSchema.parse({
      ...withCheck(ofApp(testPlan({ domain: "docs.example.com" }), "docs")),
      deployment: { destroyedAt: "2026-10-27T12:00:00.000Z" },
    });
    expect(
      configOf(renderCheck({ plans: [prod, destroyed], repo: PUBLIC })).environments.map(
        (environment: { key: string }) => environment.key,
      ),
    ).toEqual(["shop/prod"]);
  });

  it("checks a server's disk once when two environments share it", () => {
    const prod = withCheck(testPlan({ provider: "own", domain: "shop.example.com" }));
    // Two environments with one server id. Valid plans of one repository never have one (each
    // app name is unique there), so this plan skips the schema.
    const staging: DeployPlan = { ...inEnvironment(prod, { name: "staging" }), app: prod.app };
    const config = configOf(renderCheck({ plans: [prod, staging], repo: PUBLIC }));
    expect(config.environments.map((e: { server?: unknown }) => e.server)).toEqual([
      { id: "own-shop", secret: "OPSCREW_CHECK_SERVER", via: "github" },
      undefined,
    ]);
  });

  it("gives an own server in tunnel mode a disk check only from its own runner", () => {
    const tunnel = withCheck(
      testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" }),
    );
    expect(configOf(renderCheck({ plans: [tunnel], repo: PUBLIC })).environments[0].server).toBe(
      undefined,
    );
    const onServer = inEnvironment(tunnel, { runner: "server" });
    expect(
      configOf(renderCheck({ plans: [onServer], repo: PUBLIC })).environments[0].server,
    ).toEqual({
      id: "own-shop",
      via: "own-runner",
    });
  });

  it("writes no address, key or webhook URL into any file", () => {
    for (const files of [
      renderCheck({ plans: privatePlans(), repo: PRIVATE }),
      renderCheck({ plans: [withCheck(testPlan({ domain: "shop.example.com" }))], repo: PUBLIC }),
    ]) {
      for (const { path, content } of files.filter((f) => !f.path.endsWith(".mjs"))) {
        expect(content, path).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
        expect(content, path).not.toMatch(/[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,}/i);
        expect(content, path).not.toMatch(/https?:\/\//);
        expect(content, path).not.toMatch(/PRIVATE KEY|ssh-ed25519/);
      }
    }
  });

  it("keys an environment by its app's key or name and its environment", () => {
    const prod = testPlan();
    expect(checkEnvironmentKey(prod)).toBe("shop/prod");
    expect(checkEnvironmentKey(inEnvironment(prod, { name: "staging" }))).toBe(
      "shop-staging/staging",
    );
    expect(checkEnvironmentKey(ofApp(prod, "docs"))).toBe("docs/prod");
  });

  it("writes a server secret as the JSON check.mjs reads", () => {
    const reach = {
      host: "203.0.113.10",
      port: 22,
      user: "deploy",
      knownHosts: "203.0.113.10 ssh-ed25519 AAAA",
    };
    expect(JSON.parse(checkServerSecret(reach))).toEqual(reach);
  });
});

describe("the generated copy of check.mjs", () => {
  it("matches check/check.mjs (run gen:modules after editing it)", () => {
    expect(CHECK_SCRIPT).toBe(readCheckScript());
    expect(renderGeneratedCheck(CHECK_SCRIPT)).toContain("export const CHECK_SCRIPT");
  });
});
