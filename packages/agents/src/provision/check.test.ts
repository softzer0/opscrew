import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { HostPlan } from "@opscrew/connector-ssh-host";
import type { RemoteExec, ResourceChange } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { CHECK_PAUSED_VARIABLE } from "@opscrew/iac-templates";
import { DeployPlanSchema, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensureCheckKey } from "../check/key";
import { recordServerAddress } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  HOST_KEY,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
} from "../testing";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

/** The webhook's address: a secret, never in a file, an output or the audit log. */
const WEBHOOK = "https://ntfy.example.com/opscrew-alerts-7f3a9c";

/** The `shop` app on Hetzner at shop.example.com, with the check on and ntfy as its webhook. */
function checkedPlan() {
  return DeployPlanSchema.parse({
    ...testPlan({ domain: "shop.example.com" }),
    observability: { check: { enabled: true, webhook: "ntfy" } },
  });
}

async function setup() {
  const project = await createProject(checkedPlan());
  await writeFile(join(project.root, "production.env"), "STRIPE_SECRET_KEY=sk\n");
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: "hcloud-test-token",
      OPSCREW_APP_ENV_FILE: "production.env",
      OPSCREW_CHECK_WEBHOOK: WEBHOOK,
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  /** The host plans the check host applied. */
  const applied: HostPlan[] = [];
  /** The deploy user's authorized_keys as the fake server shows it. */
  let authorizedKeys = "ssh-ed25519 AAAA deploy\n";
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command, options) =>
      command === "cat ~/.ssh/authorized_keys"
        ? { exitCode: 0, stdout: authorizedKeys, stderr: "" }
        : readyRemote(host).run(command, options),
  });
  /** The infrastructure plan's changes: by default it creates the server. */
  const scenario: { changes?: ResourceChange[] } = {};
  const services: ProvisionServices = {
    engine: async () =>
      new FakeEngine({
        ...scenario,
        planJson: planJsonFor({ proxied: true }),
        outputs: {
          server_ipv4: SERVER_IPV4,
          server_ipv6: SERVER_IPV6,
          server_id: "4711",
          server_name: "shop",
          url: "https://shop.example.com",
        },
      }),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    checkHost: {
      apply: async (_remote, plan) => {
        applied.push(plan);
        return { applied: plan.steps.map((step) => step.id), skipped: [] };
      },
    },
  };
  return {
    ...project,
    deps,
    github,
    handler,
    services,
    applied,
    /** From now on the server exists: the plan only updates its firewall. */
    serverExists: () => {
      scenario.changes = [
        {
          address: "module.server.hcloud_firewall.this",
          type: "hcloud_firewall",
          name: "this",
          provider: "registry.opentofu.org/hetznercloud/hcloud",
          action: "update",
        },
      ];
    },
    serverKeys: (text: string) => {
      authorizedKeys = text;
    },
  };
}

describe.skipIf(!findExecutable("git"))("provision with the scheduled check", () => {
  it("gives a new server the check key at its first boot, inside the infrastructure plan", async () => {
    const { deps, github, handler, services, applied, root } = await setup();
    await runProvision(deps, { services });
    const key = await ensureCheckKey(deps.paths, deps.redactor);
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    );
    expect(tfvars.check_key_line).toBe(
      `restrict,command="df -P -B1 /" ${key.publicKeyOpenSsh} opscrew-check:acme/shop`,
    );
    // No host plan for it, no read of the server's keys; its secrets are stored.
    expect(handler.requests.map((request) => request.kind)).not.toContain("host-apply");
    expect(applied).toEqual([]);
    expect(deps.audit.entries.map((entry) => entry.action)).not.toContain(
      "read the deploy user's authorized keys (read-only)",
    );
    expect(github.secrets.get("OPSCREW_CHECK_SSH_KEY")).toBe(key.privateKeyOpenSsh);
  });

  it("adds the check key to an existing server, then stores the check's secrets, then commits its files", async () => {
    const { deps, github, handler, services, applied, root, git, serverExists } = await setup();
    serverExists();
    github.variables.set(
      CHECK_PAUSED_VARIABLE,
      JSON.stringify({ "shop/prod": { reason: "destroyed", since: "2026-10-01T00:00:00.000Z" } }),
    );
    await runProvision(deps, { services });

    // The order: the deploy secrets, the check key's host step, the check's secrets, the pull
    // request; then the pause ends.
    const kinds = handler.requests.map((request) => request.kind);
    const host = kinds.indexOf("host-apply");
    expect(kinds.indexOf("github-secrets")).toBeLessThan(host);
    expect(kinds.lastIndexOf("github-secrets")).toBe(host + 1);
    expect(kinds.indexOf("pull-request")).toBeGreaterThan(host + 1);
    expect(kinds.at(-1)).toBe("github-settings");
    expect(handler.requests[host + 1]?.title).toBe(
      "Store 3 secrets of the scheduled check in GitHub Actions for acme/shop",
    );

    // The host step: the key restricted to df, for this repository.
    const key = await ensureCheckKey(deps.paths, deps.redactor);
    expect(applied).toHaveLength(1);
    expect(applied[0]?.steps).toEqual([
      expect.objectContaining({
        id: "check-key",
        state: "change",
        params: expect.objectContaining({ repository: "acme/shop", runAs: "login" }),
      }),
    ]);
    const plan = await readArtifact("plan", deps.paths.files.plan);
    expect(plan.approvals).toContainEqual(expect.objectContaining({ kind: "host-apply" }));

    // The secrets: the key, the server's reach (never committed) and the webhook.
    expect(github.secrets.get("OPSCREW_CHECK_SSH_KEY")).toBe(key.privateKeyOpenSsh);
    expect(JSON.parse(github.secrets.get("OPSCREW_CHECK_SERVER") ?? "")).toEqual([
      {
        id: "app",
        host: SERVER_IPV4,
        port: 22,
        user: "deploy",
        knownHosts: `${SERVER_IPV4} ${HOST_KEY}\n`,
      },
    ]);
    expect(github.secrets.get("OPSCREW_CHECK_WEBHOOK")).toBe(WEBHOOK);
    expect(github.secrets.has("OPSCREW_CHECK_NTFY_TOKEN")).toBe(false);

    // The files, in the deploy-setup pull request, with no address.
    const committed = await git(root, "show", "--name-only", "--format=", "HEAD");
    for (const path of [
      ".github/workflows/opscrew-check.yml",
      "opscrew/check/check.json",
      "opscrew/check/check.mjs",
    ]) {
      expect(committed).toContain(path);
      const content = await readFile(join(root, path), "utf8");
      expect(content).not.toContain(SERVER_IPV4);
      expect(content).not.toContain(SERVER_IPV6);
      expect(content).not.toContain(WEBHOOK);
    }
    const config = JSON.parse(await readFile(join(root, "opscrew/check/check.json"), "utf8"));
    expect(config).toMatchObject({
      intervalMinutes: 60,
      webhook: "ntfy",
      public: false,
      environments: [
        {
          key: "shop/prod",
          hosts: [{ hostname: "shop.example.com", healthPath: "/api/health" }],
          server: { id: "hetzner-shop", secret: "OPSCREW_CHECK_SERVER", via: "github" },
        },
      ],
    });

    // The pause the teardown left is cleared.
    expect(github.variables.has(CHECK_PAUSED_VARIABLE)).toBe(false);

    // No secret reaches the output or the audit log.
    const printed = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
    expect(printed).not.toContain(WEBHOOK);
    for (const line of key.privateKeyOpenSsh.split("\n").filter((l) => !l.startsWith("-----"))) {
      if (line.length > 0) expect(printed).not.toContain(line);
    }
  });

  it("renders the same files again and skips the host step once the server has the key", async () => {
    const { deps, github, handler, services, applied, root, serverKeys, serverExists } =
      await setup();
    serverExists();
    await runProvision(deps, { services });
    const files = await Promise.all(
      ["opscrew/check/check.json", ".github/workflows/opscrew-check.yml"].map((path) =>
        readFile(join(root, path), "utf8"),
      ),
    );
    const key = await ensureCheckKey(deps.paths, deps.redactor);
    serverKeys(`restrict,command="df -P -B1 /" ${key.publicKeyOpenSsh} opscrew-check:acme/shop\n`);
    handler.requests.length = 0;
    github.openPulls.set(DEPLOY_SETUP_BRANCH, {
      number: 7,
      url: "https://github.com/acme/shop/pull/7",
    });

    await runProvision(deps, { services });
    expect(
      await Promise.all(
        ["opscrew/check/check.json", ".github/workflows/opscrew-check.yml"].map((path) =>
          readFile(join(root, path), "utf8"),
        ),
      ),
    ).toEqual(files);
    const kinds = handler.requests.map((request) => request.kind);
    expect(kinds).not.toContain("host-apply");
    expect(kinds).not.toContain("repo-write");
    // Nothing is paused, so nothing is asked about it.
    expect(kinds).not.toContain("github-settings");
    expect(applied).toHaveLength(1);
  });

  it("removes the check's files in the pull request once no plan has the check on", async () => {
    const { deps, github, services, root, git } = await setup();
    await runProvision(deps, { services });
    const plan = await readArtifact("plan", deps.paths.files.plan);
    await writeArtifact("plan", deps.paths.files.plan, {
      ...plan,
      observability: { check: { enabled: false } },
    });
    github.openPulls.set(DEPLOY_SETUP_BRANCH, {
      number: 7,
      url: "https://github.com/acme/shop/pull/7",
    });
    await runProvision(deps, { services });
    const changed = await git(root, "show", "--name-status", "--format=", "HEAD");
    for (const path of [
      ".github/workflows/opscrew-check.yml",
      "opscrew/check/check.json",
      "opscrew/check/check.mjs",
    ]) {
      expect(existsSync(join(root, path))).toBe(false);
      expect(changed).toContain(`D\t${path}`);
    }
    expect(deps.reporter.text()).toContain("the pull request removes its files");
  });

  it("--plan-only shows and saves an existing server's check-key host plan, naming its hash", async () => {
    const { deps, handler, services, applied, serverExists } = await setup();
    serverExists();
    // The server exists from an earlier provision: its address is recorded on this computer.
    await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
    const result = await runProvision(deps, { services, planOnly: true });
    const hash = /check-key plan ([0-9a-f]{64})/.exec(deps.reporter.text())?.[1];
    expect(hash).toBeDefined();
    expect(result.checkKeyPlanHash).toBe(hash);
    expect(deps.reporter.text()).toContain(`\`--approve ${hash}\``);
    expect(existsSync(join(deps.paths.files.plansDir, `host-${hash}.json`))).toBe(true);
    expect(handler.requests.map((request) => request.kind)).not.toContain("host-apply");
    expect(applied).toEqual([]);
  });
});
