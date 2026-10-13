import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { domainProject, domainTestPlan, TOKEN, visibleText } from "./__fixtures__/fakes";
import { buyDomain } from "./buy";
import { defaultDomainServices, resolveDomainServices } from "./services";

const API = "https://api.cloudflare.com/client/v4";
const REG = "/accounts/acc-1/registrar";

type Answer = { status?: number; body: unknown };
const ok = (result: unknown, status = 200): Answer => ({
  status,
  body: { success: true, errors: [], messages: [], result },
});
const notFound = (message: string): Answer => ({
  status: 404,
  body: { success: false, errors: [{ code: 1404, message }], messages: [], result: null },
});

/** Fake Cloudflare API routed by "METHOD path"; a list answers in order (the last one repeats). */
function fakeApi(routes: Record<string, Answer | Answer[]>) {
  const calls: { method: string; path: string; auth?: string; body?: unknown }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const path = String(input).replace(API, "");
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      path,
      ...(headers.Authorization ? { auth: headers.Authorization } : {}),
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
    });
    const entry = routes[`${method} ${path}`];
    if (entry === undefined) throw new Error(`unrouted ${method} ${path}`);
    const answer = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (answer === undefined) throw new Error(`no answer for ${method} ${path}`);
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

const registration = {
  domain_name: "shopapp.com",
  created_at: "2026-10-11T12:00:05Z",
  expires_at: "2027-10-11T12:00:05Z",
  auto_renew: true,
  locked: true,
  privacy_mode: "redaction",
};

describe("defaultDomainServices", () => {
  it("talks to Cloudflare with the token, through the run's fetch", async () => {
    const api = fakeApi({
      "GET /accounts?page=1&per_page=50": ok([{ id: "acc-1", name: "Shop" }]),
      [`GET ${REG}/extensions/us`]: ok({ contact_extensions: [{ name: "nexus" }] }),
      [`GET ${REG}/extensions/zz`]: notFound("Extension not found"),
      [`POST ${REG}/domain-check`]: ok({
        domains: [
          {
            name: "shopapp.com",
            registrable: true,
            tier: "standard",
            pricing: { currency: "USD", registration_cost: "10.44", renewal_cost: "10.44" },
          },
        ],
      }),
      "POST /zones": ok({ id: "z1", name: "shopapp.com", status: "pending", name_servers: [] }),
      "GET /zones/z1/dnssec": [ok({ status: "disabled" }), ok({ status: "pending" })],
      "GET /zones?name=shopapp.com&per_page=1": ok([
        { id: "z1", name: "shopapp.com", status: "active", name_servers: [] },
      ]),
    });
    const deps = await createTestPhaseDeps({
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetch: api.fetch,
    });

    const services = defaultDomainServices(deps);

    expect(await services.accounts()).toEqual([{ id: "acc-1", name: "Shop" }]);
    expect(await services.extension("acc-1", "us")).toEqual({ contactExtensionsRequired: true });
    expect(await services.extension("acc-1", "zz")).toBeUndefined();
    const [check] = await services.registrar("acc-1").check(["shopapp.com"]);
    expect(check).toMatchObject({ registrable: true, firstYear: { amount: 10.44 } });
    expect(await services.zones.createZone("acc-1", "shopapp.com")).toEqual({
      id: "z1",
      name: "shopapp.com",
    });
    expect(api.calls.find((c) => c.path === "/zones")?.body).toEqual({
      name: "shopapp.com",
      account: { id: "acc-1" },
      type: "full",
    });
    expect(await services.zones.dnssecEnabled?.("z1")).toBe(false);
    expect(await services.zones.dnssecEnabled?.("z1")).toBe(true);
    expect(await services.zones.findZone("shopapp.com")).toEqual({ id: "z1", name: "shopapp.com" });
    expect(api.calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
    // the token is registered with the redactor
    expect(deps.redactor.redact(`token ${TOKEN}`)).not.toContain(TOKEN);
  });

  it("uses the registrar sandbox and never touches zones with OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1", async () => {
    const SANDBOX = "/accounts/acc-1/registrar-sandbox";
    const api = fakeApi({
      [`POST ${SANDBOX}/domain-check`]: ok({
        domains: [
          {
            name: "shopapp.com",
            registrable: true,
            tier: "standard",
            pricing: { currency: "USD", registration_cost: "10.44", renewal_cost: "10.44" },
          },
        ],
      }),
    });
    const deps = await createTestPhaseDeps({
      env: { CLOUDFLARE_API_TOKEN: TOKEN, OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX: "1" },
      fetch: api.fetch,
    });

    const services = defaultDomainServices(deps);

    const [check] = await services.registrar("acc-1").check(["shopapp.com"]);
    expect(check).toMatchObject({ registrable: true });
    expect(await services.zones.createZone("acc-1", "shopapp.com")).toEqual({
      id: "sandbox",
      name: "shopapp.com",
    });
    await services.zones.enableDnssec("sandbox");
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${SANDBOX}/domain-check`]);
  });

  it("is used when no collaborators are injected, and stops without a token", async () => {
    const deps = await createTestPhaseDeps({ env: {} });
    expect(() => resolveDomainServices(deps, {})).toThrow(/CLOUDFLARE_API_TOKEN/);
    const injected = resolveDomainServices(deps, {
      accounts: async () => [],
      registrar: () => {
        throw new Error("unused");
      },
      extension: async () => undefined,
      zones: {
        findZone: async () => undefined,
        createZone: async () => ({ id: "z", name: "z" }),
        enableDnssec: async () => undefined,
      },
    });
    expect(await injected.accounts()).toEqual([]);
  });

  it("buys a domain end to end through the Cloudflare adapter (fake API, no network)", async () => {
    const project = await domainProject({ plan: domainTestPlan() });
    const api = fakeApi({
      "GET /accounts?page=1&per_page=50": ok([{ id: "acc-1", name: "Shop" }]),
      [`GET ${REG}/registrations/shopapp.com/registration-status`]: [
        notFound("Registration not found"),
        notFound("Registration not found"),
        ok({ domain_name: "shopapp.com", state: "in_progress" }),
        ok({ domain_name: "shopapp.com", state: "succeeded" }),
      ],
      [`GET ${REG}/registrations/shopapp.com`]: [
        notFound("Registration not found"),
        ok(registration),
      ],
      [`GET ${REG}/extensions/com`]: ok({ contact_extensions: [] }),
      [`POST ${REG}/domain-check`]: ok({
        domains: [
          {
            name: "shopapp.com",
            registrable: true,
            tier: "standard",
            pricing: { currency: "USD", registration_cost: "10.44", renewal_cost: "10.44" },
          },
        ],
      }),
      [`POST ${REG}/registrations`]: ok({ domain_name: "shopapp.com", state: "pending" }, 202),
      "POST /zones": ok({ id: "z1", name: "shopapp.com", status: "pending", name_servers: [] }),
      "GET /zones/z1/dnssec": ok({ status: "disabled" }),
      "PATCH /zones/z1/dnssec": ok({ status: "pending" }),
    });
    const run = await createTestPhaseDeps({
      root: project.root,
      env: { OPSCREW_HOME: join(project.root, ".home-opscrew"), CLOUDFLARE_API_TOKEN: TOKEN },
      fetch: api.fetch,
      interactive: true,
    });
    let time = 0;

    const result = await buyDomain(run, {
      domain: "shopapp.com",
      services: {
        sleep: async (ms) => {
          time += ms;
        },
        now: () => time,
      },
    });

    expect(
      api.calls.filter((c) => c.method === "POST" && c.path === `${REG}/registrations`),
    ).toEqual([
      {
        method: "POST",
        path: `${REG}/registrations`,
        auth: `Bearer ${TOKEN}`,
        body: {
          domain_name: "shopapp.com",
          years: 1,
          auto_renew: true,
          privacy_mode: "redaction",
        },
      },
    ]);
    expect(result).toMatchObject({ zoneId: "z1", alreadyRegistered: false });
    const plan = await readArtifact("plan", join(project.root, "opscrew", "plan.yaml"));
    expect(plan.dns.registration).toMatchObject({ registrar: "cloudflare", dnssec: true });
    expect(visibleText(run)).not.toContain(TOKEN);
  });
});
