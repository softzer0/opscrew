import type { FetchLike } from "@opscrew/contracts";
import { findExecutable, type OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { zeroTrustAuthDomain } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared";
import { createTestPhaseDeps } from "../testing";
import { createProject, FakeGitHub, opscrewRecord } from "./__fixtures__/fakes";
import {
  ACCOUNT_ID,
  ED25519_FINGERPRINT,
  FakeHostServer,
  fakeZeroTrust,
  freshFacts,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  TUNNEL_CHANGES,
  tunnelOutputs,
} from "./__fixtures__/own";
import { checkProvider, OWN_SERVER_CONNECT_HINT, setupCloudflare } from "./credentials";
import { describeHostPlan, requireNoBlockers } from "./own";
import { deploySetupPullRequestBody } from "./publish";
import { previewDeploymentFiles } from "./render";
import { runProvision } from "./run";
import { deploySecrets } from "./secrets";
import { cloudflareZeroTrust, createZeroTrustOrganization } from "./zero-trust";

const TOKEN = fakeSecret("cloudflare-token", "zero-trust");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function zeroTrustDeps(answer: (url: string) => Response) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    return answer(url);
  };
  const deps = await createTestPhaseDeps({ env: { CLOUDFLARE_API_TOKEN: TOKEN }, fetch });
  return { deps, calls };
}

describe("Zero Trust organization", () => {
  it("reads the account's organization with the token, read-only", async () => {
    const { deps, calls } = await zeroTrustDeps(() =>
      json(200, {
        success: true,
        errors: [],
        result: { auth_domain: "team.cloudflareaccess.com" },
      }),
    );
    const org = await cloudflareZeroTrust(deps).organization(ACCOUNT_ID);
    expect(org).toEqual({ authDomain: "team.cloudflareaccess.com" });
    expect(calls).toEqual([
      {
        url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/organizations`,
        auth: `Bearer ${TOKEN}`,
      },
    ]);
  });

  it("reads no organization from a 404 or Cloudflare's not-found answer", async () => {
    const missing = await zeroTrustDeps(() => json(404, { success: false, errors: [] }));
    expect(await cloudflareZeroTrust(missing.deps).organization(ACCOUNT_ID)).toBeUndefined();
    const notFound = await zeroTrustDeps(() =>
      json(400, { success: false, errors: [{ code: 12106, message: "organization not found" }] }),
    );
    expect(await cloudflareZeroTrust(notFound.deps).organization(ACCOUNT_ID)).toBeUndefined();
  });

  it("names the missing permissions on a refusal and never shows the token", async () => {
    const { deps } = await zeroTrustDeps(() =>
      json(403, {
        success: false,
        errors: [{ code: 10000, message: `Authentication error ${TOKEN}` }],
      }),
    );
    const error = (await cloudflareZeroTrust(deps)
      .organization(ACCOUNT_ID)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Access: Organizations, Identity Providers, and Groups → Edit");
    expect(`${error.message} ${error.hint}`).not.toContain(TOKEN);
  });

  it("creates the organization when there is none, keeps OpsCrew's own and leaves the user's alone", async () => {
    const zone = "example.com";
    const ask = (authDomain?: string, previous?: boolean) =>
      createZeroTrustOrganization({
        api: fakeZeroTrust(authDomain),
        accountId: ACCOUNT_ID,
        zone,
        ...(previous !== undefined ? { previous } : {}),
      });
    expect(await ask()).toBe(true);
    expect(await ask(zeroTrustAuthDomain(zone))).toBe(true);
    expect(await ask("my-team.cloudflareaccess.com")).toBe(false);
    // The last run's configuration created it: keep managing it (never plan to remove it).
    expect(await ask("my-team.cloudflareaccess.com", true)).toBe(true);
  });
});

describe("Cloudflare setup for a tunnel", () => {
  async function cloudflareDeps() {
    return createTestPhaseDeps({ env: { CLOUDFLARE_API_TOKEN: TOKEN } });
  }

  it("takes the zone's account, and stops on a record at the SSH hostname OpsCrew did not create", async () => {
    const deps = await cloudflareDeps();
    const plan = ownPlan({ access: "tunnel" });
    const setup = await setupCloudflare(deps, plan, { cloudflare: ownCloudflare() });
    expect(setup?.accountId).toBe(ACCOUNT_ID);

    const api = ownCloudflare();
    api.state.records.push({
      id: "x",
      type: "A",
      name: "ssh-shop.example.com",
      content: "198.51.100.9",
      ttl: 1,
    });
    await expect(setupCloudflare(deps, plan, { cloudflare: api })).rejects.toThrow(
      /ssh-shop\.example\.com/,
    );
    // OpsCrew's own tunnel records (from an earlier run) are fine.
    const own = ownCloudflare();
    own.state.records.push(
      opscrewRecord("ssh-shop.example.com", "CNAME", "x.cfargotunnel.com"),
      opscrewRecord("shop.example.com", "CNAME", "x.cfargotunnel.com"),
    );
    await expect(setupCloudflare(deps, plan, { cloudflare: own })).resolves.toBeDefined();
  });

  it("asks for the token's account when the zone does not name one", async () => {
    const deps = await cloudflareDeps();
    const plan = ownPlan({ access: "tunnel" });
    const base = ownCloudflare();
    const zone = { id: "zone-123", name: "example.com", status: "active", nameServers: [] };
    const one = {
      ...base,
      findZone: async () => zone,
      listAccounts: async () => [{ id: "a-1", name: "A" }],
    };
    expect((await setupCloudflare(deps, plan, { cloudflare: one }))?.accountId).toBe("a-1");
    const several = {
      ...one,
      listAccounts: async () => [
        { id: "a-1", name: "A" },
        { id: "a-2", name: "B" },
      ],
    };
    const error = (await setupCloudflare(deps, plan, { cloudflare: several }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.hint).toContain("Cloudflare Tunnel → Edit");
  });
});

describe("own-server texts", () => {
  it("the pull request names your server, the backups note and the host changes, never an address", () => {
    for (const access of ["public", "tunnel"] as const) {
      const body = deploySetupPullRequestBody(ownPlan({ access }), "1.2.3");
      expect(body).toContain("never creates, reinstalls or deletes your server");
      expect(body).toContain("backups are your responsibility");
      expect(body).toContain("The host changes OpsCrew showed before applying them");
      expect(body).toContain("Your server is prepared");
      expect(body).not.toContain("Your own server server");
      expect(body).not.toContain(OWN_IPV4);
      if (access === "tunnel") expect(body).toContain("Cloudflare Tunnel");
    }
  });

  it("the deploy secrets add the Access service token in tunnel mode", () => {
    const environment = {
      appEnv: "A=1\n",
      buildEnv: "",
      names: ["A"],
      generated: {},
      defaulted: [],
      unresolved: [],
    } as unknown as Parameters<typeof deploySecrets>[0]["environment"];
    const secret = fakeSecret("generic-password", "svc");
    const secrets = deploySecrets({
      host: "ssh-shop.example.com",
      privateKey: "k",
      knownHosts: "kh",
      environment,
      tunnel: { serviceTokenId: "id.access", serviceTokenSecret: secret },
    });
    expect(secrets.OPSCREW_TUNNEL_SERVICE_TOKEN_ID).toBe("id.access");
    expect(secrets.OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET).toBe(secret);
    expect(secrets.OPSCREW_HOST).toBe("ssh-shop.example.com");
  });

  it("the host plan lists every step, marks what is in place and ends with the hash", () => {
    const plan = {
      schemaVersion: 1 as const,
      purpose: "setup" as const,
      app: "shop",
      steps: [
        {
          id: "docker" as const,
          title: "Install Docker",
          state: "change" as const,
          reason: "Docker is not installed.",
          params: {},
        },
        {
          id: "unattended-upgrades" as const,
          title: "Automatic updates",
          state: "in-place" as const,
          reason: "Already on.",
          params: {},
        },
      ],
      findings: [],
    };
    const text = describeHostPlan(plan, "a".repeat(64));
    expect(text).toContain("1 to change, 1 already in place");
    expect(text).toContain("~ Install Docker");
    expect(text).toContain("Docker is not installed.");
    expect(text).toContain("✓ Automatic updates (already in place)");
    expect(text).toContain(`Host plan hash: ${"a".repeat(64)}`);
    expect(() => requireNoBlockers(plan)).not.toThrow();
    expect(() =>
      requireNoBlockers({
        ...plan,
        findings: [{ code: "other-firewall", message: "Another firewall.", hint: "Turn it off." }],
      }),
    ).toThrow(/cannot prepare your server/);
  });
});

describe("checkProvider for a server the user owns", () => {
  it("passes with a recorded login and never mentions a token", async () => {
    const deps = await createTestPhaseDeps();
    await recordOwnServer(deps.paths, { host: OWN_IPV4, port: 22, user: "root", agent: true });
    await expect(checkProvider(deps, "own", {})).resolves.toBeUndefined();
  });

  it("says how to connect when the check fails", async () => {
    const deps = await createTestPhaseDeps();
    const error = (await checkProvider(deps, "own", {
      provider: {
        configured: true,
        verify: async () => ({
          ok: false,
          message: "OpsCrew does not know how to reach your server yet.",
        }),
      },
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.hint).toBe(OWN_SERVER_CONNECT_HINT);
    expect(error.hint).toContain("host key");
    expect(error.hint).not.toMatch(/replace the token|create a new one/i);
  });
});

describe.skipIf(!findExecutable("git"))("previewDeploymentFiles for a server the user owns", () => {
  it("renders what provision wrote, without connecting to the server", async () => {
    const token = `eyJ${fakeSecret("cloudflare-token", "preview")}`;
    const project = await createProject(ownPlan({ access: "tunnel" }));
    const env = { ...process.env, OPSCREW_HOME: `${project.root}/.home-opscrew` };
    delete (env as Record<string, string | undefined>).TF_VAR_server_ipv4;
    const deps = await createTestPhaseDeps({ root: project.root, env, runner: ownRunner() });
    await recordOwnServer(deps.paths, {
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: false,
    });
    const host = new FakeHostServer(freshFacts({ sshPorts: [2200] }));
    const services = {
      engine: async () =>
        new OwnEngine(
          TUNNEL_CHANGES,
          tunnelOutputs({ token, clientId: "client-id", clientSecret: "client-secret-x" }),
        ),
      github: new FakeGitHub(),
      cloudflare: ownCloudflare(),
      own: { host, zeroTrust: fakeZeroTrust() },
    };
    await runProvision(deps, { services, hostKey: ED25519_FINGERPRINT, push: false });

    const inspections = host.inspections;
    const preview = await previewDeploymentFiles(deps, { services });
    expect(host.inspections).toBe(inspections);
    expect(preview.created).toEqual([]);
    expect(preview.changed).toEqual([]);
    expect(preview.unchanged).toContain("opscrew/runtime/cloudflared/compose.yaml");
  });
});
