import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import type { OpsCrewError } from "@opscrew/core";
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
      "GET /zones/z1/dnssec": [
        ok({ status: "disabled" }),
        ok({ status: "pending" }),
        ok({
          status: "pending",
          key_tag: 2371,
          algorithm: 13,
          digest_type: 2,
          digest: "ABCDEF0123",
          ds: "shopapp.com. 3600 IN DS 2371 13 2 ABCDEF0123",
        }),
      ],
      "GET /zones?name=shopapp.com&per_page=1": ok([
        { id: "z1", name: "shopapp.com", status: "active", name_servers: [] },
      ]),
      "PUT /zones/z1/activation_check": ok({ id: "z1" }),
      "POST /zones/z1/dns_records/batch": ok({ posts: [{ id: "r1" }] }),
      "GET /zones/z1/dns_records?page=1&per_page=100": ok([
        {
          id: "r1",
          type: "MX",
          name: "shopapp.com",
          content: "mx.mail.example",
          ttl: 1,
          priority: 10,
        },
        { id: "r2", type: "A", name: "shopapp.com", content: "203.0.113.5", ttl: 1, proxied: true },
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
      status: "pending",
      nameServers: [],
    });
    expect(api.calls.find((c) => c.path === "/zones")?.body).toEqual({
      name: "shopapp.com",
      account: { id: "acc-1" },
      type: "full",
    });
    expect(await services.zones.dnssecEnabled?.("z1")).toBe(false);
    expect(await services.zones.dnssecEnabled?.("z1")).toBe(true);
    expect(await services.zones.dsRecord?.("z1")).toEqual({
      keyTag: 2371,
      algorithm: 13,
      digestType: 2,
      digest: "ABCDEF0123",
      ds: "shopapp.com. 3600 IN DS 2371 13 2 ABCDEF0123",
    });
    expect(await services.zones.findZone("shopapp.com")).toEqual({
      id: "z1",
      name: "shopapp.com",
      status: "active",
      nameServers: [],
    });
    expect(await services.zones.activationCheck?.("z1")).toEqual({ requested: true });
    const mx = { type: "MX", name: "shopapp.com", content: "mx.mail.example", priority: 10 };
    expect(await services.zones.createRecords?.("z1", [{ ...mx, ttl: 1, proxied: false }])).toBe(1);
    expect(await services.zones.listRecords?.("z1")).toEqual([
      { type: "MX", name: "shopapp.com", content: "mx.mail.example", priority: 10 },
      { type: "A", name: "shopapp.com", content: "203.0.113.5", proxied: true },
    ]);
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
    expect(await services.zones.createZone("acc-1", "shopapp.com")).toMatchObject({
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

describe("buyDomain through the Cloudflare adapter: refusals (fake API, no network)", () => {
  const checkAnswer = ok({
    domains: [
      {
        name: "shopapp.com",
        registrable: true,
        tier: "standard",
        pricing: { currency: "USD", registration_cost: "10.44", renewal_cost: "10.44" },
      },
    ],
  });
  const refused = (status: number, code: number, message: string): Answer => ({
    status,
    body: { success: false, errors: [{ code, message }], messages: [], result: null },
  });

  async function runWith(routes: Record<string, Answer | Answer[]>, sandbox = false) {
    const project = await domainProject({ plan: domainTestPlan() });
    const api = fakeApi(routes);
    const deps = await createTestPhaseDeps({
      root: project.root,
      env: {
        OPSCREW_HOME: join(project.root, ".home-opscrew"),
        CLOUDFLARE_API_TOKEN: TOKEN,
        ...(sandbox ? { OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX: "1" } : {}),
      },
      fetch: api.fetch,
      interactive: true,
    });
    let time = 0;
    const services = {
      sleep: async (ms: number) => {
        time += ms;
      },
      now: () => time,
    };
    const outcome = await buyDomain(deps, { domain: "shopapp.com", services }).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error: error as OpsCrewError }),
    );
    const record = join(deps.paths.projectHomeDir, "domain-purchase.json");
    return { ...outcome, api, deps, project, record };
  }

  it("stops with the dashboard link when Cloudflare refuses for a missing contact or payment method, after re-checking the status", async () => {
    for (const reason of [
      "The account has no default registrant contact.",
      "No default payment method on file.",
    ]) {
      const { error, api, deps, record } = await runWith({
        "GET /accounts?page=1&per_page=50": ok([{ id: "acc-1", name: "Shop" }]),
        [`GET ${REG}/registrations/shopapp.com/registration-status`]:
          notFound("Registration not found"),
        [`GET ${REG}/registrations/shopapp.com`]: notFound("Registration not found"),
        [`GET ${REG}/extensions/com`]: ok({ contact_extensions: [] }),
        [`POST ${REG}/domain-check`]: checkAnswer,
        [`POST ${REG}/registrations`]: refused(400, 1001, reason),
      });

      expect(error?.code).toBe("PHASE_PRECONDITION");
      expect(error?.message).toContain(reason.replace(/\.$/, ""));
      expect(error?.message).toContain("Nothing was bought.");
      expect(error?.hint).toContain("https://dash.cloudflare.com (Domain Registration)");
      expect(error?.hint).toMatch(/payment method.*registrant contact/);
      const posts = api.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/registrations"),
      );
      expect(posts).toHaveLength(1);
      // the status was read again after the refusal (before, right before buying, and after)
      const statusReads = api.calls.filter((c) => c.path.endsWith("/registration-status"));
      expect(statusReads).toHaveLength(3);
      expect(api.calls.indexOf(statusReads[2] as (typeof api.calls)[number])).toBeGreaterThan(
        api.calls.indexOf(posts[0] as (typeof api.calls)[number]),
      );
      expect(
        await stat(record).then(
          () => true,
          () => false,
        ),
      ).toBe(false);
      expect(visibleText(deps, error)).not.toContain(TOKEN);
    }
  });

  it("explains a token with DNS access but no Registrar access, naming the optional permission; nothing bought", async () => {
    const { error, api, deps, record } = await runWith({
      "GET /accounts?page=1&per_page=50": ok([{ id: "acc-1", name: "Shop" }]),
      [`GET ${REG}/registrations/shopapp.com/registration-status`]: refused(
        403,
        10000,
        "Authentication error",
      ),
    });

    expect(error?.code).toBe("CREDENTIALS_INVALID");
    expect(error?.message).toBe(
      "This Cloudflare token cannot use Cloudflare Registrar on the account Shop (acc-1), so OpsCrew cannot buy shopapp.com with it. Nothing was bought.",
    );
    expect(error?.hint).toContain("Buying domains is optional");
    expect(error?.hint).toContain("Account → Registrar (edit)");
    expect(error?.hint).toContain("https://dash.cloudflare.com/profile/api-tokens");
    expect(error?.hint).toContain("DNS and deployments keep working without them");
    expect(error?.hint).not.toContain("CLOUDFLARE_API_TOKEN:");
    expect(api.calls.some((c) => c.method === "POST")).toBe(false);
    expect(
      await stat(record).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(visibleText(deps, error)).not.toContain(TOKEN);
  });

  it("blames the token, not registrar billing, when the accounts cannot be listed", async () => {
    const { error } = await runWith({
      "GET /accounts?page=1&per_page=50": refused(400, 6003, "Invalid request headers"),
    });
    expect(error?.hint).toContain("may be mistyped, expired or revoked");
    expect(error?.hint).not.toMatch(/payment method|registrant contact/);
  });

  it("records DNSSEC as off in the registrar sandbox and says the project files are updated", async () => {
    const SANDBOX = "/accounts/acc-1/registrar-sandbox";
    const { result, error, api, deps, project } = await runWith(
      {
        "GET /accounts?page=1&per_page=50": ok([{ id: "acc-1", name: "Shop" }]),
        [`GET ${SANDBOX}/registrations/shopapp.com/registration-status`]: [
          notFound("Registration not found"),
          notFound("Registration not found"),
          ok({ domain_name: "shopapp.com", state: "succeeded" }),
        ],
        [`GET ${SANDBOX}/registrations/shopapp.com`]: [
          notFound("Registration not found"),
          ok(registration),
        ],
        [`GET ${SANDBOX}/extensions/com`]: ok({ contact_extensions: [] }),
        [`POST ${SANDBOX}/domain-check`]: checkAnswer,
        [`POST ${SANDBOX}/registrations`]: ok(
          { domain_name: "shopapp.com", state: "pending" },
          202,
        ),
      },
      true,
    );

    expect(error).toBeUndefined();
    expect(result?.outcome).toBe("set-up");
    expect(api.calls.some((c) => c.path.startsWith("/zones"))).toBe(false);
    const text = deps.reporter.text();
    expect(text).toContain("OpsCrew still records the domain in the project files");
    expect(text).not.toContain("DNSSEC on");
    expect(deps.audit.entries.some((e) => e.action === "enable DNSSEC")).toBe(false);
    const plan = await readArtifact("plan", join(project.root, "opscrew", "plan.yaml"));
    expect(plan.dns.registration).toMatchObject({ registrar: "cloudflare", dnssec: false });
  });
});
