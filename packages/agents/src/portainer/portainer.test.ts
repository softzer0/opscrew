import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApplyOptions,
  type ApplyResult,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, RemoteExec } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  createProject,
  FakeEngine,
  FakeGitHub,
  projectRunner,
  SERVER_IPV4,
  testPlan,
} from "../provision/__fixtures__/fakes";
import {
  ED25519_FINGERPRINT,
  FakeHostServer,
  fakeZeroTrust,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  publicOutputs,
  TUNNEL_ID,
} from "../provision/__fixtures__/own";
import { portainerPasswordFile } from "../provision/own";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import { hostPlanFile, recordOwnServer } from "../shared";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { pendingPortainerFile } from "./pending";
import { type PortainerServices, portainerDisable, portainerEnable } from "./run";
import { CLOUD_PORTAINER_DIR, CLOUD_TUNNEL_DIR, PORTAINER_VERSION } from "./settings";
import { portainerStatus } from "./status";

const hasGit = findExecutable("git") !== undefined;

/** The host adapter's apply as a fake: checks the hash binding and records what it got. */
class FakeApply {
  readonly calls: { plan: HostPlan; options: ApplyOptions }[] = [];
  readonly apply = async (
    _remote: RemoteExec,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> => {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    this.calls.push({ plan, options });
    const changes = plan.steps.filter((step) => step.state === "change").map((step) => step.id);
    return { applied: changes, skipped: [] };
  };
}

/**
 * The deploy user's shell: answers only the read-only Docker version query (`docker` is what the
 * server reports, `null` for a failing command); the fake apply does everything else.
 */
function deployShell(docker: string | null, server: { volume: boolean }, commands: string[]) {
  return (host: string): RemoteExec => ({
    host,
    run: async (command: string) => {
      commands.push(command);
      if (command === "docker version --format '{{.Server.Version}}'") {
        return docker === null
          ? { exitCode: 1, stdout: "", stderr: "permission denied" }
          : { exitCode: 0, stdout: `${docker}\n`, stderr: "" };
      }
      if (
        command === "docker volume inspect --format '{{.Name}}' opscrew-portainer_portainer_data"
      ) {
        return server.volume
          ? { exitCode: 0, stdout: "opscrew-portainer_portainer_data\n", stderr: "" }
          : {
              exitCode: 1,
              stdout: "",
              stderr:
                "Error response from daemon: get opscrew-portainer_portainer_data: no such volume\n",
            };
      }
      throw new Error("the fake apply should have handled this");
    },
  });
}

function tunnelSecrets() {
  return { token: `eyJ${fakeSecret("cloudflare-token", "portainer-tunnel")}` };
}

async function cloudSetup(
  o: {
    plan?: DeployPlan;
    answer?: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };
    engine?: FakeEngine;
    docker?: string | null;
    /** Portainer's data volume is already on the server. */
    volume?: boolean;
  } = {},
) {
  const commands: string[] = [];
  const server = { volume: o.volume === true };
  const project = await createProject(
    o.plan ?? testPlan({ domain: "shop.example.com", deployed: true }),
  );
  const handler = new ScriptedApprovalHandler(o.answer ?? (() => true));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: fakeSecret("cloudflare-token"),
  };
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const host = new FakeApply();
  const pins: string[] = [];
  const services: PortainerServices = {
    deployRemote: deployShell(o.docker === undefined ? "28.5.1" : o.docker, server, commands),
    applyHost: host.apply,
    cloudflare: ownCloudflare(),
    ...(o.engine !== undefined ? { engine: async () => o.engine as FakeEngine } : {}),
    zeroTrust: {
      ...fakeZeroTrust("someone-else.cloudflareaccess.com"),
      accessIdentityProviders: async (accountId) => {
        pins.push(accountId);
        return [{ id: "pin-existing", type: "onetimepin" }];
      },
    },
  };
  return { ...project, deps, handler, host, services, pins, commands, server };
}

const kinds = (handler: ScriptedApprovalHandler) => handler.requests.map((r) => r.kind);

function printed(deps: Awaited<ReturnType<typeof cloudSetup>>["deps"]): string {
  return `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
}

describe.skipIf(!hasGit)("Portainer on Hetzner and DigitalOcean (as the deploy user)", () => {
  it("enable: one host plan as the deploy user, approved by its hash, with the password only at apply", async () => {
    const s = await cloudSetup();
    const result = await portainerEnable(s.deps, { services: s.services });

    expect(kinds(s.handler)).toEqual(["host-apply"]);
    const request = s.handler.requests[0];
    expect(request?.planHash).toBe(result.hostPlanHash);
    expect(request?.allowDestroy).toBeUndefined();
    expect(s.host.calls).toHaveLength(1);
    const call = s.host.calls[0];
    expect(call?.plan.steps.map((step) => step.id)).toEqual(["portainer"]);
    expect(call?.plan.steps[0]?.params).toMatchObject({
      version: PORTAINER_VERSION,
      dir: CLOUD_PORTAINER_DIR,
      runAs: "login",
      needsPassword: true,
    });
    expect(call?.options.approvedHash).toBe(result.hostPlanHash);

    // The password: generated here (0600), supplied at apply, nowhere else.
    const passwordFile = portainerPasswordFile(s.deps.paths);
    const password = (await readFile(passwordFile, "utf8")).trim();
    expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
    if (process.platform !== "win32") expect((await stat(passwordFile)).mode & 0o777).toBe(0o600);
    expect(call?.options.secrets).toEqual({ portainerPassword: password });
    const planYaml = await readFile(s.deps.paths.files.plan, "utf8");
    const hostPlanJson = await readFile(
      hostPlanFile(s.deps.paths, result.hostPlanHash as string),
      "utf8",
    );
    for (const text of [printed(s.deps), planYaml, hostPlanJson, JSON.stringify(result)]) {
      expect(text).not.toContain(password);
    }

    // plan.yaml: on, pinned, local; the apply and approval are recorded.
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.portainer).toEqual({ enabled: true, version: PORTAINER_VERSION, access: "local" });
    expect(plan.approvals.map((a) => a.kind)).toEqual(["host-apply"]);
    // No infrastructure change: no engine, no Cloudflare render.
    expect(result.planHash).toBeUndefined();
    expect(result.files).toEqual([]);

    // The status: tunnel command (port 22), local URL and the password file's path.
    expect(result.status.tunnelCommand).toContain(`deploy@${SERVER_IPV4}`);
    expect(result.status.tunnelCommand).toContain("-L 9443:127.0.0.1:9443");
    expect(result.status.tunnelCommand).not.toContain(" -p ");
    expect(result.status.passwordFile).toBe(passwordFile);
    expect(s.deps.reporter.text()).toContain(passwordFile);
    expect(s.deps.audit.entries.map((e) => e.action)).toContain("host step portainer");
  });

  it("enable --subdomain: tunnel and Access through iac-apply, then the connector and Portainer as the deploy user", async () => {
    const { token } = tunnelSecrets();
    const engine = new FakeEngine({
      changes: [
        {
          address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
          type: "cloudflare_zero_trust_tunnel_cloudflared",
          name: "this",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          action: "create",
        },
      ],
      outputs: {
        server_ipv4: SERVER_IPV4,
        tunnel_id: TUNNEL_ID,
        tunnel_token: token,
        portainer_url: "https://portainer.example.com",
      },
    });
    const s = await cloudSetup({ engine });
    const result = await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      services: s.services,
    });

    expect(kinds(s.handler)).toEqual(["repo-write", "iac-apply", "host-apply"]);
    expect(result.applied).toBe(true);
    const iac = s.handler.requests[1];
    expect(iac?.planHash).toBe(result.planHash);
    expect(iac?.costDelta).toBeUndefined();
    const tfvars = JSON.parse(
      await readFile(join(s.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(tfvars).toMatchObject({
      portainer_hostname: "portainer.example.com",
      portainer_allowed_emails: ["owner@example.com"],
      one_time_pin_identity_provider_id: "pin-existing",
      create_zero_trust_organization: false,
    });
    expect(result.files).toContain("opscrew/infra/prod/terraform.tfvars.json");

    const call = s.host.calls[0];
    expect(call?.plan.steps.map((step) => step.id)).toEqual(["tunnel-connector", "portainer"]);
    expect(call?.plan.steps[0]?.params).toMatchObject({
      tunnelId: TUNNEL_ID,
      dir: CLOUD_TUNNEL_DIR,
      runAs: "login",
    });
    expect(call?.options.secrets?.tunnelToken).toBe(token);
    expect(JSON.stringify(call?.plan)).not.toContain(token);
    expect(printed(s.deps)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toMatchObject({
      access: "subdomain",
      hostname: "portainer.example.com",
    });
    expect(result.status.url).toBe("https://portainer.example.com");
  });

  it("refuses a subdomain without an email or without a Cloudflare domain, changing nothing", async () => {
    const s = await cloudSetup();
    const before = await readFile(s.deps.paths.files.plan, "utf8");
    const noEmail = await portainerEnable(s.deps, {
      subdomain: "portainer.example.com",
      services: s.services,
    }).catch((e: unknown) => e);
    expect((noEmail as OpsCrewError).code).toBe("INVALID_INPUT");

    const bare = await cloudSetup({ plan: testPlan({ deployed: true }) });
    const noDomain = await portainerEnable(bare.deps, {
      subdomain: "portainer.example.com",
      allowEmails: ["a@example.com"],
      services: bare.services,
    }).catch((e: unknown) => e);
    expect((noDomain as OpsCrewError).code).toBe("PHASE_PRECONDITION");
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(before);
    expect(s.handler.requests).toHaveLength(0);
    expect(bare.handler.requests).toHaveLength(0);
  });

  it("refuses before any change when the server's Docker is older than 28", async () => {
    const engine = new FakeEngine();
    const s = await cloudSetup({ docker: "27.5.1", engine });
    const before = await readFile(s.deps.paths.files.plan, "utf8");
    const error = (await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      services: s.services,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain(
      "This server runs Docker 27.5.1; Portainer needs Docker 28 or newer, which keeps its local-only port truly local.",
    );
    expect(error.hint).toBe(
      "Upgrade Docker (OpsCrew-created servers get it from Docker's repository from now on), then run the command again.",
    );
    expect(s.commands).toEqual(["docker version --format '{{.Server.Version}}'"]);
    expect(s.handler.requests).toHaveLength(0);
    expect(engine.calls).toEqual([]);
    expect(s.host.calls).toHaveLength(0);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(before);
    expect(s.deps.audit.entries.map((e) => e.action)).toContain("read Docker version (read-only)");
  });

  it("refuses when the Docker version cannot be read, and disabling needs no check", async () => {
    const s = await cloudSetup({ docker: null });
    const error = (await portainerEnable(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("COMMAND_FAILED");
    expect(s.handler.requests).toHaveLength(0);

    await portainerDisable(s.deps, { deleteData: true, services: s.services });
    expect(s.commands).toHaveLength(1);
    expect(s.host.calls).toHaveLength(1);
  });

  it("enable --plan-only changes nothing; --approve then applies exactly that plan and records it", async () => {
    const s = await cloudSetup();
    const before = await readFile(s.deps.paths.files.plan, "utf8");
    const planned = await portainerEnable(s.deps, { planOnly: true, services: s.services });
    expect(planned.hostPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.handler.requests).toHaveLength(0);
    expect(s.host.calls).toHaveLength(0);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(before);
    expect(planned.status.enabled).toBe(false);

    const result = await portainerEnable(s.deps, {
      approvePlanHashes: [planned.hostPlanHash as string],
      services: s.services,
    });
    expect(result.hostPlanHash).toBe(planned.hostPlanHash);
    expect(s.host.calls[0]?.options.approvedHash).toBe(planned.hostPlanHash);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer?.enabled).toBe(true);
    expect(existsSync(pendingPortainerFile(s.deps.paths))).toBe(false);
  });

  it("disable --plan-only then --approve removes Portainer with the planned options", async () => {
    const s = await cloudSetup();
    await portainerEnable(s.deps, { services: s.services });
    const enabled = await readFile(s.deps.paths.files.plan, "utf8");
    const planned = await portainerDisable(s.deps, {
      deleteData: true,
      planOnly: true,
      services: s.services,
    });
    expect(s.host.calls).toHaveLength(1);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(enabled);

    // Approving with other options is refused; without options it applies the planned removal.
    const other = (await portainerDisable(s.deps, {
      deleteData: false,
      approvePlanHashes: [planned.hostPlanHash as string],
      services: s.services,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(other.code).toBe("PLAN_HASH_MISMATCH");
    expect(other.message).toContain("The options differ from the plan you approved");
    expect(s.host.calls).toHaveLength(1);

    await portainerDisable(s.deps, {
      approvePlanHashes: [planned.hostPlanHash as string],
      services: s.services,
    });
    const removal = s.host.calls[1];
    expect(removal?.options.approvedHash).toBe(planned.hostPlanHash);
    expect(removal?.plan.steps[0]?.params).toMatchObject({ remove: true, deleteData: true });
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toBeUndefined();

    // Approving again when Portainer is already off still runs the (no-op) removal plan.
    await portainerDisable(s.deps, {
      deleteData: true,
      approvePlanHashes: [planned.hostPlanHash as string],
      services: s.services,
    });
    expect(s.host.calls).toHaveLength(3);
  });

  it("a refused host-apply leaves plan.yaml as it was, for enable and for disable", async () => {
    const s = await cloudSetup({ answer: (r) => r.kind !== "host-apply" });
    const original = await readFile(s.deps.paths.files.plan, "utf8");
    const refused = (await portainerEnable(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(refused.code).toBe("APPROVAL_REFUSED");
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(original);

    const on = await cloudSetup({
      answer: (r) => r.kind !== "host-apply" || r.title.startsWith("Run"),
    });
    await portainerEnable(on.deps, { services: on.services });
    const enabled = await readFile(on.deps.paths.files.plan, "utf8");
    const off = (await portainerDisable(on.deps, { services: on.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(off.code).toBe("APPROVAL_REFUSED");
    expect(await readFile(on.deps.paths.files.plan, "utf8")).toBe(enabled);
  });

  it("--approve with other emails than planned is refused; without options it applies the plan", async () => {
    const { token } = tunnelSecrets();
    const engine = new FakeEngine({
      changes: [
        {
          address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
          type: "cloudflare_zero_trust_tunnel_cloudflared",
          name: "this",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          action: "create",
        },
      ],
      outputs: { server_ipv4: SERVER_IPV4, tunnel_id: TUNNEL_ID, tunnel_token: token },
    });
    const s = await cloudSetup({ engine });
    const original = await readFile(s.deps.paths.files.plan, "utf8");
    const planned = await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      planOnly: true,
      services: s.services,
    });
    expect(planned.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(engine.applied).toHaveLength(0);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(original);

    const mismatch = (await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["someone-else@example.com"],
      approvePlanHashes: [planned.planHash as string],
      services: s.services,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(mismatch.code).toBe("PLAN_HASH_MISMATCH");
    expect(mismatch.hint).toBe("Run with the same options, or make a new plan with --plan-only.");
    expect(engine.applied).toHaveLength(0);
    expect(s.host.calls).toHaveLength(0);

    const result = await portainerEnable(s.deps, {
      approvePlanHashes: [planned.planHash as string],
      services: s.services,
    });
    expect(result.applied).toBe(true);
    expect(engine.applied[0]?.approval.approvedPlanHash).toBe(planned.planHash);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toMatchObject({
      access: "subdomain",
      hostname: "portainer.example.com",
      allowedEmails: ["owner@example.com"],
    });
  });

  it("sends the local password even when data exists, so an admin missing after a stopped first start is made", async () => {
    const s = await cloudSetup({ volume: true });
    const password = fakeSecret("generic-password", "portainer-earlier");
    await mkdir(s.deps.paths.projectHomeDir, { recursive: true });
    await writeFile(portainerPasswordFile(s.deps.paths), `${password}\n`, { mode: 0o600 });
    await portainerEnable(s.deps, { services: s.services });
    const call = s.host.calls[0];
    // Not required (an admin may exist), but sent: Portainer ignores it when an admin exists.
    expect(call?.plan.steps[0]?.params).toMatchObject({ needsPassword: false });
    expect(call?.options.secrets).toEqual({ portainerPassword: password });
    expect((await readFile(portainerPasswordFile(s.deps.paths), "utf8")).trim()).toBe(password);
    expect(s.deps.reporter.lines.some((line) => line.level === "warn")).toBe(false);
    expect(s.deps.reporter.text()).not.toContain(password);
  });

  it("Cloudflare applied but the host step refused: the error says so, and --approve <host hash> finishes it", async () => {
    const { token } = tunnelSecrets();
    const engine = new FakeEngine({
      changes: [
        {
          address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
          type: "cloudflare_zero_trust_tunnel_cloudflared",
          name: "this",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          action: "create",
        },
      ],
      outputs: { server_ipv4: SERVER_IPV4, tunnel_id: TUNNEL_ID, tunnel_token: token },
    });
    let refuseHost = true;
    const s = await cloudSetup({
      engine,
      answer: (r) => !(refuseHost && r.kind === "host-apply"),
    });
    const error = (await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      services: s.services,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain(
      "The Cloudflare changes for portainer.example.com (tunnel, Access, DNS) are applied; Portainer on the server is not.",
    );
    expect(error.message).toContain("opscrew/infra/prod/terraform.tfvars.json");
    expect(error.message).not.toContain(SERVER_IPV4);
    const hostHash = /--approve ([0-9a-f]{64})/.exec(error.hint ?? "")?.[1];
    expect(hostHash).toMatch(/^[0-9a-f]{64}$/);
    expect(error.hint).toContain("or `opscrew provision` to remove them.");
    expect(engine.applied).toHaveLength(1);
    expect(s.host.calls).toHaveLength(0);
    const halfway = await readArtifact("plan", s.deps.paths.files.plan);
    expect(halfway.portainer).toBeUndefined();
    expect(halfway.deployment.lastPlanHash).toBe(engine.applied[0]?.approval.approvedPlanHash);

    // The Cloudflare side is done; approving the host plan without options finishes the change.
    refuseHost = false;
    engine.scenario.changes = [];
    const result = await portainerEnable(s.deps, {
      approvePlanHashes: [hostHash as string],
      services: s.services,
    });
    expect(result.hostPlanHash).toBe(hostHash);
    expect(s.host.calls[0]?.options.approvedHash).toBe(hostHash);
    expect(s.host.calls[0]?.options.secrets?.tunnelToken).toBe(token);
    expect(engine.applied).toHaveLength(1);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toMatchObject({
      access: "subdomain",
      hostname: "portainer.example.com",
      allowedEmails: ["owner@example.com"],
    });
    expect(existsSync(pendingPortainerFile(s.deps.paths))).toBe(false);
  });

  it("a refused iac-apply after the files were written: the error lists them, and --approve <plan hash> applies that plan", async () => {
    const { token } = tunnelSecrets();
    const engine = new FakeEngine({
      changes: [
        {
          address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
          type: "cloudflare_zero_trust_tunnel_cloudflared",
          name: "this",
          provider: "registry.opentofu.org/cloudflare/cloudflare",
          action: "create",
        },
      ],
      outputs: { server_ipv4: SERVER_IPV4, tunnel_id: TUNNEL_ID, tunnel_token: token },
    });
    let refuseIac = true;
    const s = await cloudSetup({ engine, answer: (r) => !(refuseIac && r.kind === "iac-apply") });
    const original = await readFile(s.deps.paths.files.plan, "utf8");
    const error = (await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      services: s.services,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.message).toContain("The repository files were written (");
    expect(error.message).toContain("opscrew/infra/prod/terraform.tfvars.json");
    expect(error.message).toContain("nothing in Cloudflare or on the server changed.");
    expect(error.message).not.toContain("Nothing was changed.");
    const iacHash = /--approve ([0-9a-f]{64})/.exec(error.hint ?? "")?.[1];
    expect(iacHash).toMatch(/^[0-9a-f]{64}$/);
    expect(error.hint).toContain("opscrew portainer enable --approve");
    expect(existsSync(pendingPortainerFile(s.deps.paths))).toBe(true);
    expect(engine.applied).toHaveLength(0);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(original);

    refuseIac = false;
    const result = await portainerEnable(s.deps, {
      approvePlanHashes: [iacHash as string],
      services: s.services,
    });
    expect(engine.applied[0]?.approval.approvedPlanHash).toBe(iacHash);
    expect(result.applied).toBe(true);
    expect(s.host.calls).toHaveLength(1);
    expect(s.host.calls[0]?.plan.steps.map((step) => step.id)).toEqual([
      "tunnel-connector",
      "portainer",
    ]);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toMatchObject({
      hostname: "portainer.example.com",
      allowedEmails: ["owner@example.com"],
    });
  });

  it("keeps the admin account when Portainer's data is already on the server", async () => {
    const s = await cloudSetup({ volume: true });
    await portainerEnable(s.deps, { services: s.services });
    const call = s.host.calls[0];
    expect(call?.plan.steps[0]?.params).toMatchObject({ needsPassword: false });
    expect(call?.options.secrets).toEqual({});
    expect(existsSync(portainerPasswordFile(s.deps.paths))).toBe(false);
    const warning = s.deps.reporter.lines.find((line) => line.level === "warn")?.message;
    expect(warning).toContain("Copy the file from the computer that turned Portainer on");
    expect(warning).toContain("opscrew portainer disable --delete-data");
    expect(s.commands).toContain(
      "docker volume inspect --format '{{.Name}}' opscrew-portainer_portainer_data",
    );
  });

  it("needs a deployment first", async () => {
    const s = await cloudSetup({ plan: testPlan({ domain: "shop.example.com" }) });
    const error = await portainerEnable(s.deps, { services: s.services }).catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
  });

  it("disable keeps the data; deleting it needs allowDestroy and the typed app name", async () => {
    const s = await cloudSetup();
    await portainerEnable(s.deps, { services: s.services });
    const kept = await portainerDisable(s.deps, { services: s.services });
    const keep = s.host.calls[1];
    expect(keep?.plan.steps.map((step) => step.params)).toEqual([
      { remove: true, deleteData: false, dir: CLOUD_PORTAINER_DIR, runAs: "login" },
    ]);
    expect(s.handler.requests[1]?.allowDestroy).toBeUndefined();
    expect(kept.hostApplied).toBe(true);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toBeUndefined();

    // Deleting data: the typed confirmation must match the app's name.
    const wrong = await cloudSetup({
      answer: (r) => (r.allowDestroy ? { approved: true, confirmation: "not-the-app" } : true),
    });
    await portainerEnable(wrong.deps, { services: wrong.services });
    const refused = await portainerDisable(wrong.deps, {
      deleteData: true,
      services: wrong.services,
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OpsCrewError);
    expect(wrong.host.calls).toHaveLength(1);
    const ask = wrong.handler.requests.at(-1);
    expect(ask).toMatchObject({ kind: "host-apply", allowDestroy: true, confirmPhrase: "shop" });

    const ok = await cloudSetup();
    await portainerEnable(ok.deps, { services: ok.services });
    await portainerDisable(ok.deps, { deleteData: true, services: ok.services });
    expect(ok.host.calls[1]?.plan.steps[0]?.params).toMatchObject({ deleteData: true });
  });

  it("status prints the tunnel command, the local URL and the password path, never the password", async () => {
    const s = await cloudSetup();
    await portainerEnable(s.deps, { services: s.services });
    const password = (await readFile(portainerPasswordFile(s.deps.paths), "utf8")).trim();
    const status = await portainerStatus(s.deps);
    expect(status).toMatchObject({
      enabled: true,
      version: PORTAINER_VERSION,
      access: "local",
      localUrl: "https://localhost:9443",
      passwordFileExists: true,
    });
    expect(JSON.stringify(status)).not.toContain(password);
    expect(s.deps.reporter.text()).not.toContain(password);
  });
});

async function ownSetup(o: { engine?: OwnEngine; port?: number } = {}) {
  const project = await createProject(ownPlan());
  const engine = o.engine ?? new OwnEngine(PUBLIC_CHANGES, publicOutputs());
  const host = new FakeHostServer(freshFacts(o.port !== undefined ? { sshPorts: [o.port] } : {}));
  const handler = new ScriptedApprovalHandler(() => true);
  const home = await mkdtemp(join(tmpdir(), "opscrew-portainer-home-"));
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
    port: o.port ?? 22,
    user: "root",
    agent: true,
    reachable: true,
  });
  // Setup plans go to the fake server; the add-on plan that deletes Portainer's data is recorded.
  const addonApplies: { plan: HostPlan; options: ApplyOptions }[] = [];
  const adapter = {
    inspect: (remote: RemoteExec) => host.inspect(remote),
    apply: async (remote: RemoteExec, plan: HostPlan, options: ApplyOptions) => {
      if (plan.steps.some((step) => step.id === "app-marker")) {
        return host.apply(remote, plan, options);
      }
      if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
      addonApplies.push({ plan, options });
      return { applied: plan.steps.map((step) => step.id), skipped: [] };
    },
  };
  const services: ProvisionServices & PortainerServices = {
    engine: async () => engine,
    github: new FakeGitHub(),
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host: adapter, homeDir: home },
    zeroTrust: fakeZeroTrust(),
  };
  await runProvision(deps, { services, hostKey: ED25519_FINGERPRINT });
  handler.requests.length = 0;
  return { ...project, deps, engine, host, handler, services, addonApplies };
}

describe.skipIf(!hasGit)("Portainer on a server the user owns (host plan)", () => {
  it("enable: the host plan adds the Portainer step and nothing else changes", async () => {
    const s = await ownSetup();
    const plans = s.engine.plans.length;
    const result = await portainerEnable(s.deps, { services: s.services });
    expect(kinds(s.handler)).toEqual(["host-apply"]);
    expect(result.files).toEqual([]);
    // No tunnel is involved, so no infrastructure plan.
    expect(s.engine.plans).toHaveLength(plans);
    const apply = s.host.applies.at(-1);
    const step = apply?.plan.steps.find((item) => item.id === "portainer");
    expect(step).toMatchObject({ state: "change" });
    expect(step?.params).toMatchObject({ runAs: "root", needsPassword: true });
    const password = (await readFile(portainerPasswordFile(s.deps.paths), "utf8")).trim();
    expect(apply?.options.secrets).toEqual({ portainerPassword: password });
    expect(s.deps.reporter.text()).not.toContain(password);
    expect(JSON.stringify(s.deps.audit.entries)).not.toContain(password);
    expect(result.status.tunnelCommand).toContain(`deploy@${OWN_IPV4}`);
  });

  it("enable --subdomain in public mode: tunnel and Access, then the connector stays in the host plan", async () => {
    const { token } = tunnelSecrets();
    const s = await ownSetup();
    s.engine.changes = [
      {
        address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
        type: "cloudflare_zero_trust_tunnel_cloudflared",
        name: "this",
        provider: "registry.opentofu.org/cloudflare/cloudflare",
        action: "create",
      },
    ];
    s.engine.nextOutputs = { ...publicOutputs(), tunnel_id: TUNNEL_ID, tunnel_token: token };
    const result = await portainerEnable(s.deps, {
      subdomain: "portainer",
      allowEmails: ["owner@example.com"],
      services: s.services,
    });
    expect(kinds(s.handler)).toEqual(["repo-write", "iac-apply", "host-apply"]);
    expect(result.applied).toBe(true);
    const apply = s.host.applies.at(-1);
    const connector = apply?.plan.steps.find((item) => item.id === "tunnel-connector");
    expect(connector).toMatchObject({ state: "change" });
    expect(connector?.params).toMatchObject({ tunnelId: TUNNEL_ID });
    expect(apply?.options.secrets?.tunnelToken).toBe(token);
    expect(s.deps.reporter.text()).not.toContain(token);
  });

  it("disable --delete-data: the host plan removes Portainer, then the data with its own typed approval", async () => {
    const s = await ownSetup();
    await portainerEnable(s.deps, { services: s.services });
    // What the next inspection finds: Portainer running with its data volume.
    s.host.facts = {
      ...s.host.facts,
      portainer: {
        installed: true,
        composeSha256: "0".repeat(64),
        running: true,
        secretFile: false,
        dataVolume: true,
        tunnelId: null,
      },
    };
    s.handler.requests.length = 0;
    const result = await portainerDisable(s.deps, { deleteData: true, services: s.services });
    const hostRequests = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(hostRequests).toHaveLength(2);
    expect(hostRequests[1]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(hostRequests[1]?.planHash).toBe(result.dataPlanHash);
    // The host plan removed Portainer (data kept); then the data plan alone, as root.
    const removal = s.host.applies.at(-1)?.plan.steps.find((step) => step.id === "portainer");
    expect(removal?.params).toMatchObject({ remove: true, deleteData: false });
    expect(s.addonApplies).toHaveLength(1);
    const data = s.addonApplies[0];
    expect(data?.options.approvedHash).toBe(result.dataPlanHash);
    expect(data?.plan.steps).toEqual([
      expect.objectContaining({
        id: "portainer",
        params: { remove: true, deleteData: true, dir: "/srv/opscrew/portainer", runAs: "root" },
      }),
    ]);
    expect((await readArtifact("plan", s.deps.paths.files.plan)).portainer).toBeUndefined();
  });

  it("sends the local password when Portainer's data is already there (no admin yet is possible)", async () => {
    const s = await ownSetup();
    const password = fakeSecret("generic-password", "portainer-own-earlier");
    await mkdir(s.deps.paths.projectHomeDir, { recursive: true });
    await writeFile(portainerPasswordFile(s.deps.paths), `${password}\n`, { mode: 0o600 });
    s.host.facts = {
      ...s.host.facts,
      portainer: {
        installed: true,
        composeSha256: "0".repeat(64),
        running: false,
        secretFile: false,
        dataVolume: true,
        tunnelId: null,
      },
    };
    await portainerEnable(s.deps, { services: s.services });
    const apply = s.host.applies.at(-1);
    const step = apply?.plan.steps.find((item) => item.id === "portainer");
    expect(step?.params).toMatchObject({ needsPassword: false });
    expect(apply?.options.secrets).toEqual({ portainerPassword: password });
  });

  it("status uses the server's SSH port", async () => {
    const s = await ownSetup({ port: 2222 });
    await portainerEnable(s.deps, { services: s.services });
    const status = await portainerStatus(s.deps);
    expect(status.tunnelCommand).toMatch(/^ssh -p 2222 -i /);
    expect(status.tunnelCommand).toContain(`deploy@${OWN_IPV4}`);
  });
});
