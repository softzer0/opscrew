import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult, FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type Requirements, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type OwnServerConnectionInput, recordOwnServer, serverAddressesFile } from "../shared";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  OWN_IPV4,
  ownPlan,
  ScriptedRunner,
} from "../testing";
import { type InitCheck, runInitChecks } from "./index";

const GITHUB = fakeSecret("github-token", "init-own");
const CLOUDFLARE = fakeSecret("cloudflare-token", "init-own");

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
function fakeNet(): { fetch: FetchLike; hosts: string[] } {
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
      return body({ default_branch: "main", private: true, permissions: { push: true } });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetch, hosts };
}

const TOOLS = ["git", "tofu", "ssh", "ssh-keyscan"];

interface Setup {
  /** The recorded login, or `null` for none. */
  own?: OwnServerConnectionInput | null;
  /** Write a plan (tunnel or public) instead of only the interview's requirements. */
  plan?: "public" | "tunnel";
  tools?: string[];
  offline?: boolean;
}

async function checks(o: Setup = {}): Promise<{ checks: InitCheck[]; hosts: string[] }> {
  const { fetch, hosts } = fakeNet();
  const deps = await createTestPhaseDeps({
    env: { GITHUB_TOKEN: GITHUB, CLOUDFLARE_API_TOKEN: CLOUDFLARE },
    runner: repoRunner(),
    fetch,
  });
  await writeFile(join(deps.paths.root, ".gitignore"), ".opscrew/\n.terraform/\n");
  const requirements: Requirements = {
    schemaVersion: 1,
    answeredAt: "2026-10-14T12:00:00.000Z",
    expectedMonthlyUsers: "<1k",
    budgetMonthly: { amount: 20, currency: "EUR" },
    provider: "own",
    uptime: "standard",
    dataCriticality: "important",
    dnsProvider: "cloudflare",
    domain: "shop.example.com",
    keepExternalServices: [],
  };
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  if (o.plan !== undefined) {
    await writeArtifact("plan", deps.paths.files.plan, ownPlan({ access: o.plan }));
  }
  if (o.own !== null) {
    await recordOwnServer(
      deps.paths,
      o.own ?? { host: OWN_IPV4, port: 2222, user: "root", agent: true, reachable: true },
    );
  }
  const tools = o.tools ?? TOOLS;
  const result = await runInitChecks(deps, {
    ...(o.offline ? { offline: true } : {}),
    services: {
      which: (name) => (tools.includes(name) ? `/usr/bin/${name}` : undefined),
      nodeVersion: "22.12.0",
    },
  });
  return { checks: result, hosts };
}

function find(list: InitCheck[], id: InitCheck["id"]): InitCheck {
  const found = list.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe("opscrew init for a server the user owns", () => {
  it("checks the SSH login instead of a provider token and calls no cloud provider", async () => {
    const { checks: list, hosts } = await checks();
    const provider = find(list, "provider");
    expect(provider.title).toBe("Your own server (SSH login)");
    expect(provider.status).toBe("pass");
    expect(provider.message).toContain("No API token is needed");
    expect(provider.message).toContain("root");
    expect(provider.message).toContain("2222");
    expect(provider.message).toContain("--host-key");
    expect(provider.message).not.toContain(OWN_IPV4);
    expect(hosts).not.toContain("api.hetzner.cloud");
    expect(hosts).not.toContain("api.digitalocean.com");
    expect(find(list, "ssh").status).toBe("pass");
  });

  it("says the host key is pinned once it is", async () => {
    const { checks: list } = await checks({
      own: { host: OWN_IPV4, port: 22, user: "root", agent: true, hostKey: ED25519_FINGERPRINT },
    });
    expect(find(list, "provider").message).toContain(`${ED25519_FINGERPRINT} is pinned`);
  });

  it("works offline the same way", async () => {
    const { checks: list, hosts } = await checks({ offline: true });
    expect(find(list, "provider").status).toBe("pass");
    expect(hosts).toEqual([]);
  });

  it("fails without a recorded login and says to run the interview (never a token)", async () => {
    const { checks: list } = await checks({ own: null });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.fix).toContain("opscrew interview");
    expect(provider.fix).toContain("No API token is needed");
    expect(`${provider.message} ${provider.fix}`).not.toMatch(
      /HCLOUD_TOKEN|DIGITALOCEAN_TOKEN|replace the token/i,
    );
  });

  it("fails when the key file is not on this computer", async () => {
    const { checks: list } = await checks({
      own: { host: OWN_IPV4, port: 22, user: "root", agent: false, keyPath: "/nowhere/id_ed25519" },
    });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.message).toContain("/nowhere/id_ed25519");
    // The fix says what to do: give the key's path again (or the agent); never a passphrase.
    expect(provider.fix).toContain("opscrew interview");
    expect(provider.fix).toContain("`agent`");
    expect(provider.message).not.toContain(provider.fix as string);
  });

  it("never says to delete a damaged server.json", async () => {
    const { fetch } = fakeNet();
    const deps = await createTestPhaseDeps({
      env: { GITHUB_TOKEN: GITHUB },
      runner: repoRunner(),
      fetch,
    });
    await writeArtifact("plan", deps.paths.files.plan, ownPlan());
    await recordOwnServer(deps.paths, { host: OWN_IPV4, port: 22, user: "root", agent: true });
    await writeFile(serverAddressesFile(deps.paths), "{ broken");
    const list = await runInitChecks(deps, {
      offline: true,
      services: { which: () => "/usr/bin/x", nodeVersion: "22.12.0" },
    });
    const provider = find(list, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.fix).toContain("Keep the file");
    expect(provider.fix).not.toMatch(/\bdelete \.opscrew\/server\.json/i);
  });

  it("still needs ssh and ssh-keyscan", async () => {
    const { checks: list } = await checks({ tools: ["git", "tofu"] });
    expect(find(list, "ssh").status).toBe("fail");
  });

  it("names the tunnel's extra Cloudflare permissions for a tunnel plan", async () => {
    const { checks: list } = await checks({ plan: "tunnel" });
    const cloudflare = find(list, "cloudflare");
    expect(cloudflare.status).toBe("pass");
    expect(cloudflare.message).toContain("Cloudflare Tunnel → Edit");
    const publicPlan = await checks({ plan: "public" });
    expect(find(publicPlan.checks, "cloudflare").message).not.toContain("Cloudflare Tunnel");
  });

  it("mentions the own-server choice when no provider is chosen and no token is set", async () => {
    const { fetch } = fakeNet();
    const deps = await createTestPhaseDeps({
      env: { GITHUB_TOKEN: GITHUB },
      runner: repoRunner(),
      fetch,
    });
    const list = await runInitChecks(deps, {
      services: { which: () => "/usr/bin/x", nodeVersion: "22.12.0" },
    });
    expect(find(list, "provider").fix).toContain("server you already have");
  });
});
