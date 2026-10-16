/**
 * An own server served directly behind Cloudflare's proxy: the web filter lets only Cloudflare's
 * current IP ranges reach the web ports, read at the start of provision (never falling back to
 * every address); every other mode has no filter, and ufw is as before.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type HostFacts, hostPlanHash, webFilterFacts } from "@opscrew/connector-ssh-host";
import type { FetchLike } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import { CF_V4, CF_V6, createProject, FakeGitHub } from "./__fixtures__/fakes";
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
  TUNNEL_CHANGES,
  tunnelOutputs,
} from "./__fixtures__/own";
import { ownWebFromCloudflare, ownWebSources, SWITCH_TO_FILTER_NOTE } from "./own";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

/** The plan with the site served directly, not behind Cloudflare's proxy. */
function unproxied(plan: DeployPlan): DeployPlan {
  return {
    ...plan,
    dns: { ...plan.dns, proxied: false },
    security: { ...plan.security, httpAllowedFrom: "any" },
  };
}

/** Cloudflare's ranges as the planner stores them: IPv4 sorted, then IPv6 sorted. */
const sorted = (list: readonly string[]) => [...list].sort();

describe("ownWebFromCloudflare", () => {
  it("is true only in public mode behind Cloudflare's proxy with web traffic limited to it", () => {
    expect(ownWebFromCloudflare(ownPlan())).toBe(true);
    expect(ownWebFromCloudflare(ownPlan({ access: "tunnel" }))).toBe(false);
    expect(ownWebFromCloudflare(ownPlan({ domain: null }))).toBe(false);
    expect(ownWebFromCloudflare(unproxied(ownPlan()))).toBe(false);
    const any = ownPlan();
    expect(
      ownWebFromCloudflare({ ...any, security: { ...any.security, httpAllowedFrom: "any" } }),
    ).toBe(false);
  });
});

describe("ownWebSources", () => {
  async function deps(fetch?: FetchLike) {
    return createTestPhaseDeps(fetch ? { fetch } : {});
  }

  it("reads Cloudflare's ranges for a proxied own server, and nothing otherwise", async () => {
    let calls = 0;
    const api = {
      getIpRanges: async () => {
        calls++;
        return { ipv4: CF_V4, ipv6: CF_V6 };
      },
    };
    const d = await deps();
    expect(await ownWebSources(d, ownPlan(), api)).toEqual({ ipv4: CF_V4 });
    expect(await ownWebSources(d, unproxied(ownPlan()), api)).toBeUndefined();
    expect(await ownWebSources(d, ownPlan({ access: "tunnel" }), api)).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("reads Cloudflare's public endpoint without a token when there is no client", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetch: FetchLike = async (input, init) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: { ipv4_cidrs: CF_V4, ipv6_cidrs: CF_V6 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    expect(await ownWebSources(await deps(fetch), ownPlan(), null)).toEqual({
      ipv4: CF_V4,
    });
    expect(seen).toEqual([{ url: "https://api.cloudflare.com/client/v4/ips", auth: null }]);
  });

  it("stops in plain English when the ranges cannot be read, never opening the ports to everyone", async () => {
    const d = await deps();
    for (const api of [
      {
        getIpRanges: async (): Promise<{ ipv4: string[]; ipv6: string[] }> => {
          throw new Error("getaddrinfo ENOTFOUND api.cloudflare.com");
        },
      },
      { getIpRanges: async () => ({ ipv4: [], ipv6: CF_V6 }) },
    ]) {
      const error = (await ownWebSources(d, ownPlan(), api).catch(
        (e: unknown) => e,
      )) as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        "OpsCrew could not read Cloudflare's IP ranges, which your server's web filter needs so that only Cloudflare can reach the app's web ports. Nothing was changed.",
      );
      expect(error.hint).toContain("never opens the web ports to every address");
    }
  });
});

interface Setup {
  plan?: DeployPlan;
  facts?: HostFacts;
  engine?: OwnEngine;
  cloudflare?: ProvisionServices["cloudflare"];
}

async function setup(o: Setup = {}) {
  const project = await createProject(o.plan ?? ownPlan());
  const engine = o.engine ?? new OwnEngine(PUBLIC_CHANGES, publicOutputs());
  const host = new FakeHostServer(o.facts ?? freshFacts());
  const handler = new ScriptedApprovalHandler(() => true);
  const home = await mkdtemp(join(tmpdir(), "opscrew-own-web-home-"));
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
    interactive: false,
  });
  await recordOwnServer(deps.paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
  });
  const services: ProvisionServices = {
    engine: async () => engine,
    github: new FakeGitHub(),
    cloudflare: o.cloudflare === undefined ? ownCloudflare() : o.cloudflare,
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, homeDir: home },
    zeroTrust: fakeZeroTrust(),
  };
  return { deps, engine, host, handler, services };
}

const stepOf = (s: Awaited<ReturnType<typeof setup>>, id: string) =>
  s.host.applies[0]?.plan.steps.find((step) => step.id === id);

describe.skipIf(!findExecutable("git"))("runProvision: web ports of an own server", () => {
  it("behind Cloudflare's proxy: the web filter with Cloudflare's ranges, ufw as before", async () => {
    const s = await setup();
    const result = await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
    });
    // IPv4 only: the site is not published on IPv6 in this mode.
    expect(stepOf(s, "web-filter")?.params).toEqual({ ipv4: sorted(CF_V4).join(" ") });
    expect(stepOf(s, "ufw")?.params).toMatchObject({
      webRules: "80/tcp 443/tcp 443/udp",
      web: true,
    });
    expect(stepOf(s, "ufw")?.params).not.toHaveProperty("webFrom");
    // The ranges are part of the approved plan, so its hash covers them.
    const approved = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(approved?.planHash).toBe(result.hostPlanHash);
    expect(approved?.details).toContain("only Cloudflare's 2 IPv4 ranges");
    expect(approved?.details).toContain("Docker does not start (fail closed)");
    expect(hostPlanHash(s.host.applies[0]?.plan as never)).toBe(result.hostPlanHash);
  });

  it("refuses Docker's nftables backend plainly before any change", async () => {
    const facts = freshFacts();
    const s = await setup({
      facts: { ...facts, webFilter: { ...webFilterFacts(facts), backend: "nftables" } },
    });
    const error = (await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("nftables firewall backend");
    expect(error.hint).toContain("Cloudflare Tunnel");
    expect(s.engine.plans).toHaveLength(0);
    expect(s.host.applies).toHaveLength(0);
  });

  it("stops before connecting to the server when Cloudflare's ranges cannot be read", async () => {
    let reads = 0;
    const cloudflare = {
      ...ownCloudflare(),
      // Provision's Cloudflare check reads them first; the server's firewall reads them again.
      getIpRanges: async () => {
        reads++;
        if (reads > 1) throw new Error("connect ETIMEDOUT");
        return { ipv4: CF_V4, ipv6: CF_V6 };
      },
    };
    const s = await setup({ cloudflare });
    const error = (await runProvision(s.deps, {
      services: s.services,
      hostKey: ED25519_FINGERPRINT,
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("Nothing was changed");
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.plans).toHaveLength(0);
    expect(s.host.inspections).toBe(0);
    expect(s.host.applies).toHaveLength(0);
  });

  it("not proxied: the web ports stay open to every address and the ranges are not read", async () => {
    let reads = 0;
    const cloudflare = {
      ...ownCloudflare(),
      getIpRanges: async () => {
        reads++;
        return { ipv4: CF_V4, ipv6: CF_V6 };
      },
    };
    const s = await setup({ plan: unproxied(ownPlan()), cloudflare });
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    expect(reads).toBe(0);
    expect(stepOf(s, "web-filter")).toBeUndefined();
    expect(stepOf(s, "ufw")?.params).toEqual({
      sshPorts: "22",
      sshRulePorts: "22",
      webRules: "80/tcp 443/tcp 443/udp",
      web: true,
      enable: true,
      install: false,
    });
  });

  it("tunnel mode: no web rules at all", async () => {
    const secrets = {
      token: `eyJ${fakeSecret("cloudflare-token", "own-web")}`,
      clientId: `${fakeSecret("generic-password", "own-web-id")}.access`,
      clientSecret: fakeSecret("generic-password", "own-web-secret"),
    };
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      engine: new OwnEngine(TUNNEL_CHANGES, tunnelOutputs(secrets)),
    });
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    expect(stepOf(s, "ufw")?.params).toMatchObject({ webRules: "", web: false });
    expect(stepOf(s, "web-filter")).toBeUndefined();
  });

  it("a running app switched from DNS only to the filter: the next deploy drops its IPv6 listeners", async () => {
    // First provision: DNS only, and the app runs (Caddy still listens on IPv6 80/443).
    const s = await setup({ plan: unproxied(ownPlan()) });
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    expect(s.deps.reporter.text()).not.toContain(SWITCH_TO_FILTER_NOTE);
    s.host.facts = {
      ...s.host.facts,
      // Docker runs, so its DOCKER-USER chain exists; no OpsCrew filter yet.
      webFilter: {
        ...webFilterFacts(s.host.facts),
        rules4: { chain: null, dockerUser: { exists: true, leading: [], jumps: 0 } },
      },
      containers: [
        { name: "shop-caddy-1", project: "shop", ports: "0.0.0.0:443->443/tcp", running: true },
      ],
    };
    s.engine.changes = [];
    // The deploy pull request of the first run is still open: the second run updates its branch.
    (s.services.github as FakeGitHub).openPull = {
      number: 7,
      url: "https://github.com/acme/shop/pull/7",
    };

    // The switch to the web filter: the server changes now, Caddy only with the next deploy.
    await writeArtifact("plan", s.deps.paths.files.plan, ownPlan());
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    const switched = s.host.applies.at(-1)?.plan.steps.find((step) => step.id === "web-filter");
    expect(switched?.state).toBe("change");
    expect(s.deps.reporter.text()).toContain(SWITCH_TO_FILTER_NOTE);
    expect(SWITCH_TO_FILTER_NOTE).toMatch(
      /stops answering on the server's IPv6 address only after the next deploy re-creates Caddy.*merge the deploy pull request, or re-run the deploy workflow now/,
    );
  });

  it("a first provision with the filter (no app running yet) says nothing about IPv6", async () => {
    const s = await setup();
    await runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });
    expect(stepOf(s, "web-filter")?.state).toBe("change");
    expect(s.deps.reporter.text()).not.toContain(SWITCH_TO_FILTER_NOTE);
  });
});
