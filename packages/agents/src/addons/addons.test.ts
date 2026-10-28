import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { type ApplyOptions, type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { portainerDisable, portainerEnable } from "../portainer";
import { inEnvironment } from "../promote/__fixtures__/world";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { hostPlanFile, recordOwnServer, recordServerAddress } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeAddonServer,
  FakeEngine,
  FakeGitHub,
  FakeHostServer,
  fakeSharedCloudflare,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  portainerPlan,
  projectRunner,
  publicOutputs,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  TUNNEL_ID,
  testPlan,
  withOtherApp,
} from "../testing";
import { grafanaEstimate, grafanaSeries, serverReadCommand } from "./estimate";
import { type AddonServices, addonDisable, addonEnable } from "./run";
import { BESZEL_EMAIL } from "./secrets";
import { addonOpen, addonStatus, parseAddonContainers } from "./status";

const hasGit = findExecutable("git") !== undefined;

const tunnelCreate = [
  {
    address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
    type: "cloudflare_zero_trust_tunnel_cloudflared",
    name: "this",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "create" as const,
  },
];

const GRAFANA = {
  metricsUrl: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/push",
  metricsUser: "1234567",
  logsUrl: "https://logs-prod-012.grafana.net/loki/api/v1/push",
  logsUser: "7654321",
};

/** A Grafana Cloud token's shape, made at runtime (never a committed literal). */
const grafanaToken = () => `glc_${randomBytes(32).toString("hex")}`;

/** A fake ssh-ed25519 public key of a hub the user runs (public, not a secret). */
const USER_HUB_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`;

/**
 * Hetzner: a deployed app, the deploy user's shell and the host adapter as a {@link FakeAddonServer},
 * and Cloudflare's fakes for a subdomain.
 */
async function cloudSetup(
  o: {
    plan?: DeployPlan;
    env?: Record<string, string>;
    answer?: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };
    interactive?: boolean;
    /** The Cloudflare account has no Zero Trust organization and no one-time PIN login yet. */
    freshAccount?: boolean;
  } = {},
) {
  const project = await createProject(
    o.plan ?? testPlan({ domain: "shop.example.com", deployed: true }),
  );
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const tunnelToken = `eyJ${fakeSecret("cloudflare-token", "addon-tunnel")}`;
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token"),
    ...o.env,
  };
  delete env.OPSCREW_BESZEL_TOKEN;
  delete env.OPSCREW_GRAFANA_CLOUD_TOKEN;
  Object.assign(env, o.env);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
    ...(o.interactive !== undefined ? { interactive: o.interactive } : {}),
  });
  const server = new FakeAddonServer();
  const engine = new FakeEngine({
    changes: tunnelCreate,
    outputs: { server_ipv4: SERVER_IPV4, tunnel_id: TUNNEL_ID, tunnel_token: tunnelToken },
  });
  const zone = new FakeZone();
  if (o.freshAccount !== true) {
    zone.organization = {
      name: "someone-else.cloudflareaccess.com",
      auth_domain: "someone-else.cloudflareaccess.com",
    };
    zone.providers.push({ id: "pin-existing", name: "One-time PIN", type: "onetimepin" });
  }
  const services: AddonServices = {
    deployRemote: server.shell,
    applyHost: server.apply,
    cloudflare: ownCloudflare(),
    engine: async () => engine,
    sharedCloudflare: fakeSharedCloudflare(zone),
  };
  const plan = () => readArtifact("plan", deps.paths.files.plan);
  return { ...project, deps, handler, server, services, engine, tunnelToken, plan, zone };
}

const kinds = (handler: ScriptedApprovalHandler) => handler.requests.map((r) => r.kind);

/** Everything OpsCrew showed, audited or saved that a secret must never be in. */
async function everythingShown(
  s: Awaited<ReturnType<typeof cloudSetup>>,
  result: unknown,
): Promise<string> {
  const hostPlans = await Promise.all(
    s.server.applies.map((apply) =>
      readFile(hostPlanFile(s.deps.paths, hostPlanHash(apply.plan)), "utf8"),
    ),
  );
  return [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    JSON.stringify(s.handler.requests),
    await readFile(s.deps.paths.files.plan, "utf8"),
    ...hostPlans,
    JSON.stringify(s.server.applies.map((apply) => apply.plan)),
    JSON.stringify(result),
  ].join("\n");
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe.skipIf(!hasGit)("Beszel on a cloud server (as the deploy user)", () => {
  it("hub mode: generated secrets on stdin only, memory and price share shown, approved by hash", async () => {
    const s = await cloudSetup();
    const result = await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });

    expect(kinds(s.handler)).toEqual(["host-apply"]);
    const request = s.handler.requests[0];
    expect(request?.title).toBe("Run Beszel (its dashboard and agent) on the server");
    expect(request?.allowDestroy).toBeUndefined();
    expect(request?.details).toContain(
      "Memory limits of Beszel's containers: the hub (dashboard) 128 MB (€0.28/month), the agent 64 MB (€0.14/month), the read-only Docker proxy 32 MB (€0.07/month); the server has 3.7 GB.",
    );
    const apply = s.server.applies[0];
    expect(request?.planHash).toBe(hostPlanHash(apply?.plan as HostPlan));
    expect(result.hostPlanHashes).toEqual([request?.planHash]);
    expect(apply?.plan.steps.map((step) => step.id)).toEqual(["beszel"]);
    const params = apply?.plan.steps[0]?.params ?? {};
    expect(params).toMatchObject({ runAs: "login", mode: "hub", email: BESZEL_EMAIL });
    expect(Object.keys(params).filter((key) => key.startsWith("file:"))).toEqual([
      "file:compose.yaml",
      "file:Caddyfile",
      "file:config.yml",
    ]);

    // The secrets: generated here (0600), sent at apply, the hub's public half in the plan.
    const secrets = JSON.parse(await readFile(s.deps.paths.files.beszelSecrets, "utf8"));
    expect(secrets.password).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(secrets.token).toMatch(/^[0-9a-f]{48}$/);
    expect(secrets.hubKey).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END OPENSSH PRIVATE KEY-----\n$/,
    );
    expect(params.hubKey).toBe(secrets.hubPublicKey);
    if (process.platform !== "win32") {
      expect((await stat(s.deps.paths.files.beszelSecrets)).mode & 0o777).toBe(0o600);
    }
    expect(apply?.options.secrets).toEqual({
      beszelPassword: secrets.password,
      beszelToken: secrets.token,
      beszelHubKey: secrets.hubKey,
    });
    const shown = await everythingShown(s, result);
    for (const value of [secrets.password, secrets.token, secrets.hubKey]) {
      expect(shown).not.toContain(value);
    }

    // plan.yaml: on, pinned, local, with the approval; the read audited without the address.
    const plan = await s.plan();
    expect(plan.observability?.beszel).toMatchObject({
      enabled: true,
      version: "0.21.1",
      mode: "hub",
      access: "local",
    });
    expect(plan.approvals.map((a) => a.kind)).toEqual(["host-apply"]);
    const read = s.deps.audit.entries.find((entry) => entry.action.includes("CPUs and memory"));
    expect(read).toMatchObject({ kind: "remote-exec", target: "server", phase: "provision" });
    expect(JSON.stringify(s.deps.audit.entries)).not.toContain(SERVER_IPV4);
    expect(s.server.commands).toContain(serverReadCommand("shop", false));
    expect(result.status.addons[0]).toMatchObject({ kind: "beszel", enabled: true, mode: "hub" });
    expect(s.deps.reporter.text()).toContain("opscrew addon open beszel");
  });

  it("re-enable: the same host plan and secrets, and the server changes nothing", async () => {
    const s = await cloudSetup();
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    const secrets = await readFile(s.deps.paths.files.beszelSecrets, "utf8");
    const before = (await s.plan()).observability;

    const again = await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });

    expect(again.hostPlanHashes).toEqual([hostPlanHash(s.server.applies[0]?.plan as HostPlan)]);
    expect(again.hostApplied).toBe(false);
    expect(s.server.applies[1]?.result).toEqual({ applied: [], skipped: ["beszel"] });
    expect(await readFile(s.deps.paths.files.beszelSecrets, "utf8")).toBe(secrets);
    expect((await s.plan()).observability).toEqual(before);
  });

  it("disable deletes the history with the typed app name; --keep-data keeps it without one", async () => {
    const s = await cloudSetup();
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    s.handler.requests.length = 0;

    const kept = await addonDisable(s.deps, await s.plan(), "beszel", {
      keepData: true,
      services: s.services,
    });
    expect(kept.hostApplied).toBe(true);
    const keepRequest = s.handler.requests[0];
    expect(keepRequest?.title).toBe("Remove Beszel from the server (its history stays)");
    expect(keepRequest?.allowDestroy).toBeUndefined();
    expect(s.server.applies.at(-1)?.plan.steps[0]?.params).toMatchObject({
      remove: true,
      keepData: true,
    });
    // The dashboard's user keeps its password with the history.
    expect(await readFile(s.deps.paths.files.beszelSecrets, "utf8")).toContain("password");
    expect((await s.plan()).observability).toBeUndefined();

    // On again (the same secrets), then off with the history.
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    s.handler.requests.length = 0;
    const off = await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    const request = s.handler.requests[0];
    expect(request).toMatchObject({
      kind: "host-apply",
      title: "Remove Beszel and delete its history on the server",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(off.hostApplied).toBe(true);
    await expect(stat(s.deps.paths.files.beszelSecrets)).rejects.toThrow();
    expect((await s.plan()).observability).toBeUndefined();

    // Already off: nothing to do.
    s.handler.requests.length = 0;
    await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(kinds(s.handler)).toEqual([]);
  });

  it("a refused deletion of the history changes nothing", async () => {
    const s = await cloudSetup({ answer: (request) => request.allowDestroy !== true });
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    const before = await readFile(s.deps.paths.files.plan, "utf8");
    const error = await failure(
      addonDisable(s.deps, await s.plan(), "beszel", { services: s.services }),
    );
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(s.server.running.has("beszel")).toBe(true);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(before);
    expect(await readFile(s.deps.paths.files.beszelSecrets, "utf8")).toContain("password");
  });

  it("agent mode: the hub's address and key in the plan, the token from OPSCREW_BESZEL_TOKEN", async () => {
    const token = randomBytes(20).toString("hex");
    const s = await cloudSetup({ env: { OPSCREW_BESZEL_TOKEN: token } });
    const result = await addonEnable(s.deps, await s.plan(), "beszel", {
      mode: "agent",
      hubUrl: "https://beszel.example.net",
      hubKey: USER_HUB_KEY,
      services: s.services,
    });
    expect(s.handler.requests[0]?.title).toBe(
      "Run Beszel's agent on the server, connected to your hub",
    );
    const apply = s.server.applies[0];
    expect(apply?.plan.steps[0]?.params).toMatchObject({ mode: "agent", runAs: "login" });
    expect(apply?.options.secrets).toEqual({ beszelToken: token });
    expect(apply?.plan.steps[0]?.params["file:compose.yaml"]).toContain(
      "https://beszel.example.net",
    );
    expect((await s.plan()).observability?.beszel).toMatchObject({
      mode: "agent",
      hubUrl: "https://beszel.example.net",
      hubKey: USER_HUB_KEY,
    });
    // Kept for the recovery copy and a re-enable.
    expect(JSON.parse(await readFile(s.deps.paths.files.beszelSecrets, "utf8"))).toEqual({
      mode: "agent",
      token,
    });
    expect(await everythingShown(s, result)).not.toContain(token);
    expect(s.deps.reporter.text()).toContain("Open your hub at https://beszel.example.net");

    // Re-enable without the variable: the kept token, the same plan, nothing changes.
    const env = { ...s.deps.env };
    delete env.OPSCREW_BESZEL_TOKEN;
    const again = await addonEnable({ ...s.deps, env }, await s.plan(), "beszel", {
      mode: "agent",
      hubUrl: "https://beszel.example.net",
      hubKey: USER_HUB_KEY,
      services: s.services,
    });
    expect(again.hostApplied).toBe(false);
    expect(again.hostPlanHashes).toEqual([hostPlanHash(apply?.plan as HostPlan)]);

    // Off: the agent and its token go, here and on the server; it keeps no history, so no typed
    // name is asked.
    s.handler.requests.length = 0;
    await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(s.handler.requests[0]?.title).toBe("Remove Beszel's agent from the server");
    expect(s.handler.requests[0]?.allowDestroy).toBeUndefined();
    expect(s.handler.requests[0]?.confirmPhrase).toBeUndefined();
    expect(s.server.applies.at(-1)?.plan.deleteData).toBeUndefined();
    expect(s.server.running.has("beszel")).toBe(false);
    await expect(stat(s.deps.paths.files.beszelSecrets)).rejects.toThrow();
    expect((await s.plan()).observability).toBeUndefined();
  });

  it("agent mode refuses without the hub's address, its key or the token", async () => {
    const s = await cloudSetup();
    const plan = await s.plan();
    const noUrl = await failure(
      addonEnable(s.deps, plan, "beszel", { mode: "agent", hubKey: USER_HUB_KEY }),
    );
    expect(noUrl.message).toContain("--hub-url");
    const noKey = await failure(
      addonEnable(s.deps, plan, "beszel", { mode: "agent", hubUrl: "https://beszel.example.net" }),
    );
    expect(noKey.message).toContain("--hub-key");
    const noToken = await failure(
      addonEnable(s.deps, plan, "beszel", {
        mode: "agent",
        hubUrl: "https://beszel.example.net",
        hubKey: USER_HUB_KEY,
        services: s.services,
      }),
    );
    expect(noToken.code).toBe("INVALID_INPUT");
    expect(noToken.hint).toContain("OPSCREW_BESZEL_TOKEN");
    expect(s.server.applies).toEqual([]);
    expect(kinds(s.handler)).toEqual([]);
  });

  it("refuses off the server targets, a Portainer hostname, and a subdomain without emails", async () => {
    for (const plan of [
      portainerPlan({ deployed: true }),
      {
        ...testPlan({ deployed: true }),
        target: { provider: "localhost" },
      } as unknown as DeployPlan,
    ]) {
      const deps = await createTestPhaseDeps();
      const error = await failure(addonEnable(deps, plan, "beszel"));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toContain("runs only on a server OpsCrew deploys to");
      expect(error.hint).toContain("opscrew logs");
    }
    const s = await cloudSetup();
    const plan = await s.plan();
    const noEmail = await failure(
      addonEnable(s.deps, plan, "beszel", {
        access: "subdomain",
        hostname: "beszel.example.com",
        services: s.services,
      }),
    );
    expect(noEmail.message).toContain("never makes it public");
    const withPortainer: DeployPlan = {
      ...plan,
      portainer: {
        enabled: true,
        version: "2.33.1",
        access: "subdomain",
        hostname: "ops.example.com",
        allowedEmails: ["owner@example.com"],
      },
    };
    const taken = await failure(
      addonEnable(s.deps, withPortainer, "beszel", {
        access: "subdomain",
        hostname: "ops.example.com",
        allowEmails: ["owner@example.com"],
        services: s.services,
      }),
    );
    expect(taken.message).toContain("Portainer's web UI already uses ops.example.com");
    const keep = await failure(addonDisable(s.deps, plan, "grafana-cloud", { keepData: true }));
    expect(keep.message).toContain("`--keep-data` is for Beszel's history");
    expect(s.server.applies).toEqual([]);
  });

  it("refuses a mode change while Beszel is on, and agent mode over a kept hub history", async () => {
    const token = randomBytes(20).toString("hex");
    const s = await cloudSetup({ env: { OPSCREW_BESZEL_TOKEN: token } });
    const agent = {
      mode: "agent" as const,
      hubUrl: "https://beszel.example.net",
      hubKey: USER_HUB_KEY,
      services: s.services,
    };
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    const secrets = await readFile(s.deps.paths.files.beszelSecrets, "utf8");
    const switching = await failure(addonEnable(s.deps, await s.plan(), "beszel", agent));
    expect(switching.message).toContain("Beszel runs in hub mode on this server");
    expect(switching.hint).toContain("--keep-data");

    // Off with its history kept: agent mode would leave that history without its password.
    await addonDisable(s.deps, await s.plan(), "beszel", { keepData: true, services: s.services });
    const over = await failure(addonEnable(s.deps, await s.plan(), "beszel", agent));
    expect(over.message).toContain("history from hub mode may be kept on the server");
    expect(over.hint).toContain("opscrew addon enable beszel");
    expect(over.hint).toContain("opscrew addon disable beszel");
    expect(await readFile(s.deps.paths.files.beszelSecrets, "utf8")).toBe(secrets);
  });

  it("disable without --keep-data deletes a history kept earlier, with the typed app name", async () => {
    const s = await cloudSetup();
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    await addonDisable(s.deps, await s.plan(), "beszel", { keepData: true, services: s.services });
    expect(s.deps.reporter.text()).toContain("without `--keep-data` deletes it");
    s.handler.requests.length = 0;

    const result = await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(s.handler.requests[0]).toMatchObject({
      kind: "host-apply",
      title: "Delete Beszel's kept history on the server",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(s.server.applies.at(-1)?.plan.deleteData).toBe(true);
    expect(result.hostPlanHashes).toHaveLength(1);
    await expect(stat(s.deps.paths.files.beszelSecrets)).rejects.toThrow();

    // Nothing is kept any more.
    s.handler.requests.length = 0;
    await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(kinds(s.handler)).toEqual([]);
  });

  it("--plan-only then --approve: a first hub enable shows the same host plan both runs", async () => {
    const s = await cloudSetup();
    const planned = await addonEnable(s.deps, await s.plan(), "beszel", {
      planOnly: true,
      services: s.services,
    });
    expect(kinds(s.handler)).toEqual([]);
    expect(s.server.applies).toEqual([]);
    expect((await s.plan()).observability).toBeUndefined();
    const [hash] = planned.hostPlanHashes;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const result = await addonEnable(s.deps, await s.plan(), "beszel", {
      approvePlanHashes: [hash as string],
      services: s.services,
    });
    expect(result.hostPlanHashes).toEqual([hash]);
    expect(s.server.applies[0]?.options.approvedHash).toBe(hash);
    expect((await s.plan()).observability?.beszel?.enabled).toBe(true);
  });

  it("a refused host plan's hint carries Grafana Cloud's values answered at a prompt", async () => {
    const s = await cloudSetup({
      interactive: true,
      answer: (request) => request.kind !== "host-apply",
    });
    const answers: Record<string, string> = {
      "--metrics-url": GRAFANA.metricsUrl,
      "--metrics-user": GRAFANA.metricsUser,
      "--logs-url": GRAFANA.logsUrl,
      "--logs-user": GRAFANA.logsUser,
      OPSCREW_GRAFANA_CLOUD_TOKEN: grafanaToken(),
    };
    const error = await failure(
      addonEnable(s.deps, await s.plan(), "grafana-cloud", {
        services: { ...s.services, ask: async (question) => answers[question.name] as string },
      }),
    );
    expect(error.hint).toContain(
      `OPSCREW_GRAFANA_CLOUD_TOKEN=<token> opscrew addon enable grafana-cloud --metrics-url ${GRAFANA.metricsUrl} --metrics-user ${GRAFANA.metricsUser} --logs-url ${GRAFANA.logsUrl} --logs-user ${GRAFANA.logsUser} --log-sampling 100 --approve ${s.handler.requests[0]?.planHash}`,
    );
  });

  it("names --env in the commands of a staging plan: the --approve hint and approveCommand", async () => {
    const s = await cloudSetup({ answer: (request) => request.kind !== "host-apply" });
    const staging = inEnvironment(await s.plan(), "staging");
    const deps = await createTestPhaseDeps({
      root: s.root,
      environment: "staging",
      env: s.deps.env,
      runner: projectRunner(),
      approvalHandler: s.handler,
    });
    await writeArtifact("plan", deps.paths.files.plan, staging);
    await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
    const error = await failure(addonEnable(deps, staging, "beszel", { services: s.services }));
    expect(error.hint).toContain(
      `opscrew addon enable beszel --env staging --approve ${s.handler.requests[0]?.planHash}`,
    );
    const planned = await addonEnable(deps, staging, "beszel", {
      services: s.services,
      planOnly: true,
    });
    expect(planned.approveCommand).toBe("opscrew addon enable beszel --env staging");
    const off = await addonDisable(deps, staging, "beszel", { keepData: true });
    expect(off.approveCommand).toBe("opscrew addon disable beszel --env staging --keep-data");
  });

  it("disable with Beszel off removes an agent token left here, so hub mode can be turned on", async () => {
    const s = await cloudSetup();
    await mkdir(dirname(s.deps.paths.files.beszelSecrets), { recursive: true });
    await writeFile(
      s.deps.paths.files.beszelSecrets,
      JSON.stringify({ mode: "agent", token: randomBytes(20).toString("hex") }),
    );
    const refused = await failure(addonEnable(s.deps, await s.plan(), "beszel", {}));
    expect(refused.hint).toContain("opscrew addon disable beszel");

    await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(kinds(s.handler)).toEqual([]);
    await expect(stat(s.deps.paths.files.beszelSecrets)).rejects.toThrow();
    expect(s.deps.reporter.text()).toContain("Removed Beszel's agent token left on this computer");

    const on = await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(on.hostApplied).toBe(true);
  });

  it("a refused host plan's hint repeats the options given and the token's variable, never its value", async () => {
    const token = grafanaToken();
    const s = await cloudSetup({
      env: { OPSCREW_GRAFANA_CLOUD_TOKEN: token },
      answer: (request) => request.kind !== "host-apply",
    });
    const error = await failure(
      addonEnable(s.deps, await s.plan(), "grafana-cloud", {
        ...GRAFANA,
        logSampling: 50,
        services: s.services,
      }),
    );
    const hash = s.handler.requests[0]?.planHash;
    expect(error.hint).toContain(
      `OPSCREW_GRAFANA_CLOUD_TOKEN=<token> opscrew addon enable grafana-cloud --metrics-url ${GRAFANA.metricsUrl} --metrics-user ${GRAFANA.metricsUser} --logs-url ${GRAFANA.logsUrl} --logs-user ${GRAFANA.logsUser} --log-sampling 50 --approve ${hash}`,
    );
    expect(JSON.stringify(error)).not.toContain(token);
    // Not written before the apply: a later run needs it set again.
    await expect(stat(s.deps.paths.files.grafanaCloudToken)).rejects.toThrow();

    const agentToken = randomBytes(20).toString("hex");
    const beszel = await cloudSetup({
      env: { OPSCREW_BESZEL_TOKEN: agentToken },
      answer: (request) => request.kind !== "host-apply",
    });
    const refused = await failure(
      addonEnable(beszel.deps, await beszel.plan(), "beszel", {
        mode: "agent",
        hubUrl: "https://beszel.example.net",
        hubKey: USER_HUB_KEY,
        services: beszel.services,
      }),
    );
    expect(refused.hint).toContain(
      `OPSCREW_BESZEL_TOKEN=<token> opscrew addon enable beszel --mode agent --hub-url https://beszel.example.net --hub-key '${USER_HUB_KEY}' --approve ${beszel.handler.requests[0]?.planHash}`,
    );
    expect(JSON.stringify(refused)).not.toContain(agentToken);
  });
});

describe.skipIf(!hasGit)("Grafana Cloud on a cloud server", () => {
  it("enable: names the token's scopes, shows the estimate, and keeps the token as a secret", async () => {
    const token = grafanaToken();
    const s = await cloudSetup({ env: { OPSCREW_GRAFANA_CLOUD_TOKEN: token } });
    const result = await addonEnable(s.deps, await s.plan(), "grafana-cloud", {
      ...GRAFANA,
      services: s.services,
    });
    const text = s.deps.reporter.text();
    expect(text).toContain("metrics:write and logs:write scopes");
    expect(text).toContain("Cloud access policies");
    expect(text).toContain(
      "OpsCrew's estimate for this server: 17 series, and 1.2 GB of logs a month (30 times the app's last 24 hours).",
    );
    const request = s.handler.requests[0];
    expect(request?.title).toBe(
      "Run Grafana Alloy on the server, sending the app's logs and the server's metrics to Grafana Cloud",
    );
    expect(request?.details).toContain("Grafana Cloud's free tier keeps 10,000 metric series");
    expect(request?.details).toContain("Memory limits of Grafana Cloud's containers: Alloy 256 MB");
    const apply = s.server.applies[0];
    expect(apply?.plan.steps.map((step) => step.id)).toEqual(["alloy"]);
    expect(apply?.options.secrets).toEqual({ grafanaCloudToken: token });
    expect(s.server.commands).toContain(serverReadCommand("shop", true));
    expect((await s.plan()).observability?.grafanaCloud).toMatchObject({
      enabled: true,
      version: "1.21.2",
      metrics: { url: GRAFANA.metricsUrl, user: GRAFANA.metricsUser },
      logs: { url: GRAFANA.logsUrl, user: GRAFANA.logsUser },
      logSampling: 100,
    });
    expect((await readFile(s.deps.paths.files.grafanaCloudToken, "utf8")).trim()).toBe(token);
    expect(await everythingShown(s, result)).not.toContain(token);

    // Re-enable from this computer: the plan's stack and the kept token, the same host plan.
    const env = { ...s.deps.env };
    delete env.OPSCREW_GRAFANA_CLOUD_TOKEN;
    const again = await addonEnable({ ...s.deps, env }, await s.plan(), "grafana-cloud", {
      services: s.services,
    });
    expect(again.hostApplied).toBe(false);
    expect(again.hostPlanHashes).toEqual([hostPlanHash(apply?.plan as HostPlan)]);

    // Off: no typed name, everything goes, the token too.
    s.handler.requests.length = 0;
    await addonDisable(s.deps, await s.plan(), "grafana-cloud", { services: s.services });
    expect(s.handler.requests[0]).toMatchObject({ title: "Remove Grafana Alloy from the server" });
    expect(s.handler.requests[0]?.allowDestroy).toBeUndefined();
    expect(s.server.applies.at(-1)?.plan.steps[0]?.params).toMatchObject({ remove: true });
    await expect(stat(s.deps.paths.files.grafanaCloudToken)).rejects.toThrow();
    expect((await s.plan()).observability).toBeUndefined();
  });

  it("over the free tier: says so with the sampling that fits before the approval, and goes on", async () => {
    const token = grafanaToken();
    const s = await cloudSetup({ env: { OPSCREW_GRAFANA_CLOUD_TOKEN: token } });
    s.server.logBytes24h = 4_000_000_000; // 120 GB a month
    const over = await addonEnable(s.deps, await s.plan(), "grafana-cloud", {
      ...GRAFANA,
      services: s.services,
    });
    // Printed with the host plan, before its approval was asked, and part of the approval's text.
    const details = s.handler.requests[0]?.details ?? "";
    for (const text of [details, s.deps.reporter.text()]) {
      expect(text).toContain("120.0 GB of logs a month");
      expect(text).toContain("more than Grafana Cloud's free tier holds");
      expect(text).toContain("`--log-sampling 41`");
    }
    expect(over.hostApplied).toBe(true);
    expect((await s.plan()).observability?.grafanaCloud?.logSampling).toBe(100);

    // With the sampling given, it fits and the plan sends 40% of the lines.
    s.handler.requests.length = 0;
    const result = await addonEnable(s.deps, await s.plan(), "grafana-cloud", {
      ...GRAFANA,
      logSampling: 40,
      services: s.services,
    });
    expect(result.hostApplied).toBe(true);
    expect(s.handler.requests[0]?.details).toContain("48.0 GB of logs a month");
    expect(s.handler.requests[0]?.details).not.toContain("more than Grafana Cloud's free tier");
    expect((await s.plan()).observability?.grafanaCloud?.logSampling).toBe(40);
    expect(s.server.applies.at(-1)?.plan.steps[0]?.params["file:config.alloy"]).toContain(
      "stage.sampling",
    );
  });

  it("asks for the stack's values and the token in an interactive run, never echoing the token", async () => {
    const token = grafanaToken();
    const s = await cloudSetup({ interactive: true });
    const asked: { name: string; secret: boolean }[] = [];
    const answers: Record<string, string> = {
      "--metrics-url": GRAFANA.metricsUrl,
      "--metrics-user": GRAFANA.metricsUser,
      "--logs-url": GRAFANA.logsUrl,
      "--logs-user": GRAFANA.logsUser,
      OPSCREW_GRAFANA_CLOUD_TOKEN: token,
    };
    await addonEnable(s.deps, await s.plan(), "grafana-cloud", {
      services: {
        ...s.services,
        ask: async (question) => {
          asked.push({ name: question.name, secret: question.secret });
          return answers[question.name] as string;
        },
      },
    });
    expect(asked).toEqual([
      { name: "--metrics-url", secret: false },
      { name: "--metrics-user", secret: false },
      { name: "--logs-url", secret: false },
      { name: "--logs-user", secret: false },
      { name: "OPSCREW_GRAFANA_CLOUD_TOKEN", secret: true },
    ]);
    expect(s.server.applies[0]?.options.secrets).toEqual({ grafanaCloudToken: token });
    expect(s.deps.reporter.text()).not.toContain(token);
  });

  it("the estimate: series from the CPUs, logs as 30 days of the last one, against the free tier", () => {
    expect(grafanaSeries(8)).toBe(47);
    expect(grafanaEstimate({ cpus: 2, logBytes24h: 1_000_000_000 }, 100)).toEqual({
      series: 17,
      logBytesPerMonth: 30_000_000_000,
      over: false,
    });
    expect(grafanaEstimate({ cpus: 2, logBytes24h: 2_000_000_000 }, 100)).toEqual({
      series: 17,
      logBytesPerMonth: 60_000_000_000,
      fittingSampling: 83,
      over: true,
    });
    expect(grafanaEstimate({ cpus: 2, logBytes24h: 2_000_000_000 }, 80).over).toBe(false);
    // The read is fixed text and the checked app name only.
    expect(() => serverReadCommand("shop; rm -rf /", true)).toThrow();
  });
});

describe.skipIf(!hasGit)("Beszel's dashboard at a subdomain (Hetzner)", () => {
  const SUBDOMAIN = {
    access: "subdomain" as const,
    hostname: "beszel",
    allowEmails: ["owner@example.com"],
  };

  it("tunnel and Access through iac-apply, then the connector and Beszel in one host plan", async () => {
    const s = await cloudSetup();
    const result = await addonEnable(s.deps, await s.plan(), "beszel", {
      ...SUBDOMAIN,
      services: s.services,
    });
    expect(kinds(s.handler)).toEqual(["cloudflare-apply", "repo-write", "iac-apply", "host-apply"]);
    expect(s.handler.requests[2]?.title).toBe(
      "Serve Beszel's dashboard on beszel.example.com behind Cloudflare Access (Cloudflare Tunnel and Access)",
    );
    const tfvars = JSON.parse(
      await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(tfvars).toMatchObject({
      beszel_hostname: "beszel.example.com",
      beszel_allowed_emails: ["owner@example.com"],
      one_time_pin_identity_provider_id: "pin-existing",
    });
    const apply = s.server.applies[0];
    expect(apply?.plan.steps.map((step) => step.id)).toEqual(["tunnel-connector", "beszel"]);
    expect(apply?.plan.steps[0]?.params).toMatchObject({ tunnelId: TUNNEL_ID, runAs: "login" });
    expect(apply?.options.secrets?.tunnelToken).toBe(s.tunnelToken);
    expect(await everythingShown(s, result)).not.toContain(s.tunnelToken);
    expect(result.status.addons[0]?.url).toBe("https://beszel.example.com");
  });

  it("in a fresh account, sets up the Zero Trust organization and one-time PIN login for Beszel alone", async () => {
    const s = await cloudSetup({ freshAccount: true });
    await addonEnable(s.deps, await s.plan(), "beszel", { ...SUBDOMAIN, services: s.services });
    expect(kinds(s.handler)).toEqual(["cloudflare-apply", "repo-write", "iac-apply", "host-apply"]);
    const pin = s.zone.providers.find((provider) => provider.type === "onetimepin");
    expect(s.zone.organization).toBeDefined();
    expect(pin).toBeDefined();
    const tfvars = JSON.parse(
      await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(tfvars).toMatchObject({
      beszel_hostname: "beszel.example.com",
      one_time_pin_identity_provider_id: pin?.id,
    });
    expect(s.server.applies[0]?.plan.steps.map((step) => step.id)).toEqual([
      "tunnel-connector",
      "beszel",
    ]);
  });

  it("--plan-only then --approve: the planned hashes apply exactly that change", async () => {
    const s = await cloudSetup();
    const planned = await addonEnable(s.deps, await s.plan(), "beszel", {
      ...SUBDOMAIN,
      planOnly: true,
      services: s.services,
    });
    // Only the files are written; nothing in Cloudflare or on the server changes.
    expect(kinds(s.handler)).toEqual(["repo-write"]);
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned.cloudflarePlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(planned.hostPlanHashes).toEqual([]);
    expect(s.server.applies).toEqual([]);
    expect((await s.plan()).observability).toBeUndefined();

    s.handler.requests.length = 0;
    const result = await addonEnable(s.deps, await s.plan(), "beszel", {
      ...SUBDOMAIN,
      approvePlanHashes: [planned.cloudflarePlanHash as string, planned.planHash as string],
      services: s.services,
    });
    // The saved plans are applied as approved (no files written again), then the host plan.
    expect(kinds(s.handler)).toEqual(["cloudflare-apply", "iac-apply", "host-apply"]);
    expect(s.handler.requests[0]?.planHash).toBe(planned.cloudflarePlanHash);
    expect(result.planHash).toBe(planned.planHash);
    expect(s.engine.applied.at(-1)?.approval.approvedPlanHash).toBe(planned.planHash);
    expect(result.hostPlanHashes).toEqual([s.handler.requests[2]?.planHash]);
    expect(s.server.applies[0]?.plan.steps.map((step) => step.id)).toEqual([
      "tunnel-connector",
      "beszel",
    ]);
    expect((await s.plan()).observability?.beszel?.hostname).toBe("beszel.example.com");
  });

  it("Portainer's subdomain off keeps the connector while Beszel's remains, and the reverse", async () => {
    const s = await cloudSetup();
    await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      services: s.services,
    });
    await addonEnable(s.deps, await s.plan(), "beszel", { ...SUBDOMAIN, services: s.services });
    expect(s.server.running.has("tunnel-connector")).toBe(true);

    await portainerDisable(s.deps, { services: s.services });
    expect(s.server.applies.at(-1)?.plan.steps.map((step) => step.id)).toEqual(["portainer"]);
    expect(s.server.running.has("tunnel-connector")).toBe(true);

    // Beszel's subdomain alone: turning it off removes the connector.
    await addonDisable(s.deps, await s.plan(), "beszel", { keepData: true, services: s.services });
    expect(s.server.applies.at(-1)?.plan.steps.map((step) => step.id)).toEqual([
      "tunnel-connector",
      "beszel",
    ]);
    expect(s.server.running.has("tunnel-connector")).toBe(false);

    // The reverse: both on, Beszel's off keeps the connector Portainer's subdomain still uses.
    await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      services: s.services,
    });
    await addonEnable(s.deps, await s.plan(), "beszel", { ...SUBDOMAIN, services: s.services });
    await addonDisable(s.deps, await s.plan(), "beszel", { keepData: true, services: s.services });
    expect(s.server.applies.at(-1)?.plan.steps.map((step) => step.id)).toEqual(["beszel"]);
    expect(s.server.running.has("tunnel-connector")).toBe(true);
  });
});

describe.skipIf(!hasGit)("status and open", () => {
  it("status: each add-on's state, its containers' state and memory, and how to open it", async () => {
    const token = grafanaToken();
    const s = await cloudSetup({ env: { OPSCREW_GRAFANA_CLOUD_TOKEN: token } });
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    await addonEnable(s.deps, await s.plan(), "grafana-cloud", {
      ...GRAFANA,
      services: s.services,
    });
    s.deps.reporter.lines.length = 0;
    const status = await addonStatus(s.deps, await s.plan(), { services: s.services });
    expect(status.addons[0]?.containers).toEqual([
      { name: "opscrew-beszel-agent-1", running: true, memory: "6.5MiB / 64MiB" },
      { name: "opscrew-beszel-proxy-1", running: true },
    ]);
    expect(status.addons[1]?.containers).toEqual([
      { name: "opscrew-alloy-alloy-1", running: true, memory: "75.2MiB / 192MiB" },
      { name: "opscrew-alloy-proxy-1", running: false },
    ]);
    const text = s.deps.reporter.text();
    expect(text).toContain("opscrew-beszel-agent-1: running, memory 6.5MiB / 64MiB");
    expect(text).toContain(`log in as ${BESZEL_EMAIL}`);
    expect(text).toContain('the logs are labelled app="shop"');
    expect(text).not.toContain("shop-app-1");
    const secrets = JSON.parse(await readFile(s.deps.paths.files.beszelSecrets, "utf8"));
    expect(text).not.toContain(secrets.password);
    expect(text).not.toContain(token);
  });

  it("open: the SSH tunnel to 127.0.0.1:8090 as the deploy user, the address and the password's file", async () => {
    const s = await cloudSetup();
    await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    const runner = s.deps.runner as ReturnType<typeof projectRunner>;
    runner.calls.length = 0;
    await addonOpen(s.deps, await s.plan(), "beszel");
    const ssh = runner.calls.find((call) => call.command === "ssh");
    expect(ssh?.args).toEqual([
      "-i",
      s.deps.paths.files.deployKey,
      "-o",
      `UserKnownHostsFile=${s.deps.paths.files.knownHosts}`,
      "-N",
      "-L",
      "8090:127.0.0.1:8090",
      `deploy@${SERVER_IPV4}`,
    ]);
    expect(s.deps.reporter.text()).toContain("http://localhost:8090");
    expect(s.deps.reporter.text()).toContain(s.deps.paths.files.beszelSecrets);
    const grafana = await failure(addonOpen(s.deps, await s.plan(), "grafana-cloud"));
    expect(grafana.message).toContain("Grafana Cloud stack");
  });

  it("parses only the add-ons' containers", () => {
    const found = parseAddonContainers(
      "opscrew-beszel-hub-1|running\nshop-app-1|running\nopscrew-beszel-hub-1|10.8MiB / 128MiB\nshop-app-1|1GiB / 1GiB\n",
    );
    expect(found).toEqual({
      beszel: [{ name: "opscrew-beszel-hub-1", running: true, memory: "10.8MiB / 128MiB" }],
      "grafana-cloud": [],
    });
  });
});

async function ownSetup(answer: (request: ApprovalRequest) => boolean = () => true) {
  const project = await createProject(ownPlan());
  const engine = new OwnEngine(PUBLIC_CHANGES, publicOutputs());
  const host = new FakeHostServer(freshFacts());
  const handler = new ScriptedApprovalHandler(answer);
  // A fresh account: no Zero Trust organization and no one-time PIN login yet.
  const zone = new FakeZone();
  const home = await mkdtemp(join(tmpdir(), "opscrew-addons-home-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
  };
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: ownRunner(),
    approvalHandler: handler,
  });
  await recordOwnServer(deps.paths, {
    host: OWN_IPV4,
    port: 2222,
    user: "root",
    agent: true,
    reachable: true,
  });
  const server = new FakeAddonServer();
  // Setup plans go to the fake server; the add-on plans to the fake add-on server.
  const adapter = {
    inspect: (remote: RemoteExec) => host.inspect(remote),
    apply: (remote: RemoteExec, plan: HostPlan, options: ApplyOptions) =>
      plan.steps.some((step) => step.id === "app-record")
        ? host.apply(remote, plan, options)
        : server.apply(remote, plan, options),
  };
  const services: ProvisionServices & AddonServices = {
    engine: async () => engine,
    github: new FakeGitHub(),
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host: adapter, homeDir: home },
    sharedCloudflare: fakeSharedCloudflare(zone),
    deployRemote: server.shell,
  };
  await runProvision(deps, { services, hostKey: ED25519_FINGERPRINT });
  handler.requests.length = 0;
  const plan = () => readArtifact("plan", deps.paths.files.plan);
  return { ...project, deps, engine, host, server, handler, services, plan, zone };
}

describe.skipIf(!hasGit)("add-ons on a server the user owns", () => {
  it("Beszel: its own host plan as root with the server's facts, no price share", async () => {
    const s = await ownSetup();
    const result = await addonEnable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(kinds(s.handler)).toEqual(["host-apply"]);
    expect(s.handler.requests[0]?.title).toBe(
      "Run Beszel (its dashboard and agent) on your server",
    );
    expect(s.handler.requests[0]?.details).toContain(
      "the hub (dashboard) 128 MB, the agent 64 MB, the read-only Docker proxy 32 MB;",
    );
    const apply = s.server.applies[0];
    expect(apply?.plan.steps[0]?.params).toMatchObject({ runAs: "root", mode: "hub" });
    expect(result.status.addons[0]?.enabled).toBe(true);

    const off = await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(off.hostApplied).toBe(true);
    expect(s.handler.requests.at(-1)).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
  });

  it("Beszel at a subdomain in a fresh account: Zero Trust login, tunnel and Access, the connector, then Beszel", async () => {
    const s = await ownSetup();
    const token = `eyJ${fakeSecret("cloudflare-token", "own-beszel-tunnel")}`;
    s.engine.changes = tunnelCreate;
    s.engine.nextOutputs = { ...publicOutputs(), tunnel_id: TUNNEL_ID, tunnel_token: token };
    expect(s.zone.organization).toBeUndefined();
    const result = await addonEnable(s.deps, await s.plan(), "beszel", {
      access: "subdomain",
      hostname: "beszel",
      allowEmails: ["owner@example.com"],
      services: s.services,
    });
    // The account's Zero Trust organization and one-time PIN login come first, for Beszel alone.
    expect(kinds(s.handler)).toEqual([
      "cloudflare-apply",
      "repo-write",
      "iac-apply",
      "host-apply",
      "host-apply",
    ]);
    const pin = s.zone.providers.find((provider) => provider.type === "onetimepin");
    expect(s.zone.organization).toBeDefined();
    expect(pin).toBeDefined();
    const tfvars = JSON.parse(
      await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(tfvars).toMatchObject({
      beszel_hostname: "beszel.example.com",
      one_time_pin_identity_provider_id: pin?.id,
    });
    const connector = s.host.applies
      .at(-1)
      ?.plan.steps.find((step) => step.id === "tunnel-connector");
    expect(connector?.params).toMatchObject({ tunnelId: TUNNEL_ID });
    expect(s.host.applies.at(-1)?.options.secrets?.tunnelToken).toBe(token);
    expect(s.server.applies[0]?.plan.steps.map((step) => step.id)).toEqual(["beszel"]);
    expect(result.hostPlanHashes).toHaveLength(2);
    expect(s.deps.reporter.text()).not.toContain(token);
    expect((await s.plan()).observability?.beszel?.hostname).toBe("beszel.example.com");
  });

  it("a refused Beszel plan after the connector's names Beszel's hash, not the connector plan's", async () => {
    const s = await ownSetup((request) => !request.title.startsWith("Run Beszel"));
    const token = `eyJ${fakeSecret("cloudflare-token", "own-beszel-refused")}`;
    s.engine.changes = tunnelCreate;
    s.engine.nextOutputs = { ...publicOutputs(), tunnel_id: TUNNEL_ID, tunnel_token: token };
    const error = await failure(
      addonEnable(s.deps, await s.plan(), "beszel", {
        access: "subdomain",
        hostname: "beszel",
        allowEmails: ["owner@example.com"],
        services: s.services,
      }),
    );
    const hostRequests = s.handler.requests.filter((request) => request.kind === "host-apply");
    expect(hostRequests).toHaveLength(2);
    const [connectorHash, beszelHash] = hostRequests.map((request) => request.planHash);
    expect(error.hint).toContain(
      `opscrew addon enable beszel --access subdomain --hostname beszel --allow-email owner@example.com --approve ${beszelHash}`,
    );
    expect(error.hint).not.toContain(connectorHash as string);
  });

  it("disable deletes a history the host record shows, though this computer has no secrets", async () => {
    const s = await ownSetup();
    const record = s.host.facts.record;
    if (record === null) throw new Error("provision wrote no host record");
    s.host.facts = { ...s.host.facts, record: { ...record, addons: { beszel: "shop" } } };
    await addonDisable(s.deps, await s.plan(), "beszel", { services: s.services });
    expect(s.handler.requests[0]).toMatchObject({
      title: "Delete Beszel's kept history on your server",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(s.server.applies[0]?.plan.deleteData).toBe(true);
    expect(s.server.applies[0]?.plan.steps[0]?.params).toMatchObject({ runAs: "root" });
  });

  it("refuses an add-on another app on the server has, naming it, before anything changes", async () => {
    const s = await ownSetup();
    // "blog" is set up on the server too, and turned Beszel on there.
    const other = withOtherApp({ facts: s.host.facts });
    const record = other.record;
    expect(record?.apps).toContain("blog");
    if (record === null) return;
    s.host.facts = { ...other, record: { ...record, addons: { beszel: "blog" } } };
    const before = await readFile(s.deps.paths.files.plan, "utf8");
    const error = await failure(
      addonEnable(s.deps, await s.plan(), "beszel", { services: s.services }),
    );
    expect(error.message).toContain('already on this server for the app "blog"');
    expect(kinds(s.handler)).toEqual([]);
    expect(s.server.applies).toEqual([]);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(before);
  });
});
