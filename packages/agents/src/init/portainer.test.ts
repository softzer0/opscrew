import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type PinnedRequest,
  PORTAINER_TOKEN_STEPS,
  PortainerCertificateError,
  portainerClient,
} from "@opscrew/connector-portainer";
import type { CommandResult, FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type Requirements, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { REGISTRY_TOKEN_HINT } from "../provision/stack-plan";
import {
  type PortainerConnectionInput,
  recordPortainerConnection,
  serverAddressesFile,
} from "../shared";
import {
  createTestPhaseDeps,
  fakeCertificate,
  fakePortainer,
  PORTAINER_HOST,
  PORTAINER_URL,
  portainerPlan,
  ScriptedRunner,
} from "../testing";
import { type InitCheck, runInitChecks } from "./index";

const GITHUB = fakeSecret("github-token", "init-portainer");
const CLOUDFLARE = fakeSecret("cloudflare-token", "init-portainer");
const HETZNER = fakeSecret("generic-password", "init-portainer hetzner");
const PORTAINER_TOKEN = fakeSecret("generic-password", "init-portainer token");
const REGISTRY_TOKEN = fakeSecret("github-token", "init-portainer ghcr");
const REPOSITORY_TOKEN = fakeSecret("github-pat", "init-portainer repo");

const CERT = fakeCertificate("init portainer certificate");
const OTHER_CERT = fakeCertificate("someone else's certificate");

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function repoRunner(): ScriptedRunner {
  return new ScriptedRunner((command, args) => {
    if (command.endsWith("git")) {
      const sub = args.slice(2);
      if (sub[0] === "rev-parse") return ok("true\n");
      if (sub[0] === "remote") return ok("git@github.com:acme/shop.git\n");
    }
    if (command.endsWith("tofu") && args[0] === "version") {
      return ok(JSON.stringify({ terraform_version: "1.10.6" }));
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected command ${command}` };
  });
}

/** Records which hosts were called; Cloudflare and GitHub answer like working tokens. */
function fakeNet(repoPrivate: boolean): { fetch: FetchLike; hosts: string[] } {
  const hosts: string[] = [];
  const fetch: FetchLike = async (input) => {
    const url = new URL(String(input));
    hosts.push(url.hostname);
    const body = (value: unknown) =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.hostname === "api.cloudflare.com") {
      if (url.pathname.endsWith("/user/tokens/verify")) {
        return body({ success: true, errors: [], result: { status: "active" } });
      }
      if (url.pathname.endsWith("/zones")) {
        return body({
          success: true,
          errors: [],
          result: [{ id: "zone-1", name: "example.com", status: "active", name_servers: [] }],
        });
      }
      return body({ success: true, errors: [], result: [] });
    }
    if (url.hostname === "api.github.com") {
      return body({ default_branch: "main", private: repoPrivate, permissions: { push: true } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, hosts };
}

const TOOLS = ["git", "tofu", "ssh", "ssh-keyscan"];

interface Setup {
  /** The recorded connection, or `null` for none. */
  connection?: PortainerConnectionInput | null;
  /** Write the Portainer plan as well as the interview's answers. */
  plan?: boolean;
  /** Environment besides GitHub and Cloudflare (default: the Portainer token). */
  env?: Record<string, string | undefined>;
  /** The token the fake Portainer accepts (default: the one in the environment). */
  accepts?: string;
  /** Replaces the fake Portainer's requests (for example a changed certificate). */
  request?: PinnedRequest;
  repoPrivate?: boolean;
  offline?: boolean;
  /** Write this text as `.opscrew/server.json` instead of a record. */
  serverJson?: string;
  /** Programs on PATH (default {@link TOOLS}). */
  tools?: string[];
}

const CONNECTION: PortainerConnectionInput = {
  url: PORTAINER_URL,
  certFingerprint: CERT.fingerprint,
  environmentId: 3,
  environmentName: "local",
  arch: "amd64",
  redeploy: "updater",
  web: { mode: "tunnel" },
};

async function checks(o: Setup = {}) {
  const { fetch, hosts } = fakeNet(o.repoPrivate ?? true);
  const portainer = fakePortainer({ token: o.accepts ?? PORTAINER_TOKEN });
  const deps = await createTestPhaseDeps({
    env: {
      GITHUB_TOKEN: GITHUB,
      CLOUDFLARE_API_TOKEN: CLOUDFLARE,
      ...(o.env ?? { PORTAINER_API_KEY: PORTAINER_TOKEN }),
    },
    runner: repoRunner(),
    fetch,
  });
  await writeFile(join(deps.paths.root, ".gitignore"), ".opscrew/\n.terraform/\n");
  const requirements: Requirements = {
    schemaVersion: 1,
    answeredAt: "2026-10-15T12:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 10, currency: "EUR" },
    provider: "portainer",
    uptime: "standard",
    dataCriticality: "important",
    dnsProvider: "cloudflare",
    domain: "shop.example.com",
    keepExternalServices: [],
  };
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  if (o.plan) await writeArtifact("plan", deps.paths.files.plan, portainerPlan());
  if (o.serverJson !== undefined) {
    await recordPortainerConnection(deps.paths, CONNECTION);
    await writeFile(serverAddressesFile(deps.paths), o.serverJson);
  } else if (o.connection !== null) {
    await recordPortainerConnection(deps.paths, o.connection ?? CONNECTION);
  }
  const tools = o.tools ?? TOOLS;
  const result = await runInitChecks(deps, {
    ...(o.offline ? { offline: true } : {}),
    services: {
      which: (name) => (tools.includes(name) ? `/usr/bin/${name}` : undefined),
      nodeVersion: "22.12.0",
      portainerClient: (endpoint, token, clientDeps) =>
        portainerClient(endpoint, token, {
          ...clientDeps,
          request: o.request ?? portainer.request,
        }),
    },
  });
  return { checks: result, hosts, portainer };
}

function find(list: InitCheck[], id: InitCheck["id"]): InitCheck {
  const found = list.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

/** Nothing any check says shows Portainer's address or a token. */
function expectNothingLeaks(list: InitCheck[]): void {
  const text = JSON.stringify(list);
  for (const secret of [PORTAINER_HOST, PORTAINER_TOKEN, REGISTRY_TOKEN, REPOSITORY_TOKEN]) {
    expect(text).not.toContain(secret);
  }
}

describe("opscrew init for a Portainer target", () => {
  it("checks your Portainer from the interview's answers with one read-only call", async () => {
    const {
      checks: list,
      hosts,
      portainer,
    } = await checks({
      env: {
        PORTAINER_API_KEY: PORTAINER_TOKEN,
        HCLOUD_TOKEN: HETZNER,
        OPSCREW_GHCR_READ_TOKEN: REGISTRY_TOKEN,
        OPSCREW_REPO_READ_TOKEN: REPOSITORY_TOKEN,
      },
    });
    const provider = find(list, "provider");
    expect(provider.title).toBe("Your Portainer");
    expect(provider.status).toBe("pass");
    expect(provider.message).toContain("PORTAINER_API_KEY works");
    expect(provider.message).toContain("administrator");
    expect(provider.message).toContain("certificate");
    expect(portainer.calls).toEqual(["GET /api/users/me"]);
    expect(portainer.mutations()).toEqual([]);
    // No cloud provider is checked, even with its token set.
    expect(hosts).not.toContain("api.hetzner.cloud");
    expect(hosts).not.toContain("api.digitalocean.com");
    expect(find(list, "portainer-tokens").status).toBe("pass");
    expect(list.every((check) => check.status !== "fail")).toBe(true);
    expectNothingLeaks(list);
  });

  it("recognises a Portainer plan", async () => {
    const { checks: list } = await checks({ plan: true });
    const provider = find(list, "provider");
    expect(provider.title).toBe("Your Portainer");
    expect(provider.status).toBe("pass");
    expectNothingLeaks(list);
  });

  it("fails plainly without a recorded connection and says to run the interview", async () => {
    const { checks: list, portainer } = await checks({ connection: null, plan: true });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain("does not know how to reach your Portainer");
    expect(provider.fix).toContain("opscrew interview");
    expect(portainer.calls).toEqual([]);
  });

  it("fails when the certificate was never confirmed", async () => {
    const { certFingerprint: _pin, ...unpinned } = CONNECTION;
    const { checks: list, portainer } = await checks({ connection: unpinned });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain("certificate");
    expect(provider.fix).toContain("opscrew interview");
    expect(portainer.calls).toEqual([]);
    expectNothingLeaks(list);
  });

  it("fails on a damaged record with how to repair it", async () => {
    const { checks: list } = await checks({ serverJson: "{ not json" });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain(".opscrew/server.json");
    expect(provider.fix).toContain("opscrew interview");
  });

  it("fails when PORTAINER_API_KEY is not set and says how to create one", async () => {
    const { checks: list, portainer } = await checks({ env: {} });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain("PORTAINER_API_KEY is not set");
    expect(provider.fix).toBe(
      `${PORTAINER_TOKEN_STEPS}, then set PORTAINER_API_KEY to it. OpsCrew reads it only from this environment variable and never saves it.`,
    );
    expect(portainer.calls).toEqual([]);
    expectNothingLeaks(list);
  });

  it("fails plainly when Portainer rejects the token", async () => {
    const { checks: list } = await checks({ accepts: fakeSecret("generic-password", "other") });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain("rejected");
    expect(provider.message).toContain("PORTAINER_API_KEY");
    expect(provider.fix).toContain("Access tokens");
    expectNothingLeaks(list);
  });

  it("fails plainly when Portainer's certificate changed", async () => {
    const changed: PinnedRequest = async () => {
      throw new PortainerCertificateError(CERT.fingerprint, OTHER_CERT.fingerprint);
    };
    const { checks: list } = await checks({ request: changed });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain("certificate has changed");
    expect(provider.fix).toContain("opscrew interview");
    expectNothingLeaks(list);
  });

  it("does not call Portainer offline", async () => {
    const { checks: list, portainer } = await checks({ offline: true });
    const provider = find(list, "provider");
    expect(provider.status).toBe("pass");
    expect(provider.message).toContain("offline");
    expect(portainer.calls).toEqual([]);
  });

  it("warns about the missing read tokens of a private image and repository", async () => {
    const { checks: list } = await checks();
    const tokens = find(list, "portainer-tokens");
    expect(tokens.status).toBe("warn");
    expect(tokens.message).toContain("OPSCREW_GHCR_READ_TOKEN");
    expect(tokens.message).toContain("OPSCREW_REPO_READ_TOKEN");
    // The registry token's help is the stack plan's, word for word.
    expect(tokens.fix).toContain(REGISTRY_TOKEN_HINT);
    expect(tokens.fix).toContain("Contents: Read-only");
    // Warnings never fail init.
    expect(find(list, "provider").status).toBe("pass");
  });

  it("needs no registry token for a public image and no repository token for a public repository", async () => {
    const { checks: list } = await checks({
      connection: { ...CONNECTION, publicImage: true },
      repoPrivate: false,
    });
    const tokens = find(list, "portainer-tokens");
    expect(tokens.status).toBe("pass");
    expect(tokens.message).not.toContain("not set");
  });

  it("names the repository token only when the repository is known to be private", async () => {
    const { checks: list } = await checks({ offline: true });
    const tokens = find(list, "portainer-tokens");
    expect(tokens.status).toBe("warn");
    expect(tokens.message).toContain("OPSCREW_GHCR_READ_TOKEN");
    expect(tokens.fix ?? "").not.toContain("Contents: Read-only");
  });

  it("skips the ssh check, since a Portainer target never uses SSH", async () => {
    const { checks: list } = await checks({ tools: ["git", "tofu"] });
    const ssh = find(list, "ssh");
    expect(ssh.status).toBe("skip");
    expect(ssh.message).toContain("never connects over SSH");
    expect(list.every((check) => check.status !== "fail")).toBe(true);
  });

  it("lists no Portainer tokens check for other targets and still needs ssh there", async () => {
    const deps = await createTestPhaseDeps({ env: { GITHUB_TOKEN: GITHUB }, runner: repoRunner() });
    const list = await runInitChecks(deps, {
      offline: true,
      services: {
        which: (name) => (["git", "tofu"].includes(name) ? `/usr/bin/${name}` : undefined),
        nodeVersion: "22.12.0",
      },
    });
    expect(list.some((check) => check.id === "portainer-tokens")).toBe(false);
    expect(find(list, "provider").title).toBe("Cloud provider token");
    expect(find(list, "ssh").status).toBe("fail");
  });
});
