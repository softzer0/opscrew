import type { FetchLike, Registrar } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  capabilitiesOf,
  configuredRegistrars,
  parseRegistrarId,
  registrarFor,
  registrarLinks,
  registrarSandbox,
} from "./registrars";
import { resolveDomainServices, SANDBOX_ZONES } from "./services";
import type { DomainZoneApi } from "./types";

const PORKBUN_KEY = fakeSecret("porkbun-api-key");
const PORKBUN_SECRET = fakeSecret("porkbun-secret-key");
const NAMECHEAP_KEY = fakeSecret("namecheap-api-key");
const GODADDY_TOKEN = fakeSecret("godaddy-token");
const CLOUDFLARE_TOKEN = fakeSecret("cloudflare-token");

const ALL_ENV = {
  CLOUDFLARE_API_TOKEN: CLOUDFLARE_TOKEN,
  PORKBUN_API_KEY: PORKBUN_KEY,
  PORKBUN_SECRET_API_KEY: PORKBUN_SECRET,
  NAMECHEAP_API_USER: "testuser",
  NAMECHEAP_API_KEY: NAMECHEAP_KEY,
  GODADDY_API_TOKEN: GODADDY_TOKEN,
};

/** Records every request and answers Namecheap with an API error and the trace page with an IP. */
function recordingFetch() {
  const calls: { url: string; body?: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (url.includes("cdn-cgi/trace")) return new Response("fl=1\nip=203.0.113.9\nts=1\n");
    return new Response(
      '<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="ERROR"><Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error></Errors><Warnings /><RequestedCommand>domains.check</RequestedCommand></ApiResponse>',
      { headers: { "content-type": "text/xml" } },
    );
  };
  return { fetch, calls };
}

function fakeRegistrar(id: Registrar["id"]): Registrar {
  return {
    id,
    check: async () => [],
    suggest: async () => [],
    registrationStatus: async () => undefined,
    register: async () => ({ domain: "x.com", state: "succeeded" }),
    getDomain: async () => undefined,
    setAutoRenew: async () => ({ domain: "x.com", registrar: id, autoRenew: true }),
  };
}

describe("parseRegistrarId", () => {
  it("accepts the four registrars in any case", () => {
    expect(parseRegistrarId("Porkbun")).toBe("porkbun");
    expect(parseRegistrarId(" GODADDY ")).toBe("godaddy");
  });

  it("names the known registrars for anything else", () => {
    expect(() => parseRegistrarId("dynadot")).toThrow(OpsCrewError);
    try {
      parseRegistrarId("dynadot");
    } catch (error) {
      expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
      expect((error as OpsCrewError).hint).toContain("cloudflare, porkbun, namecheap, godaddy");
    }
  });
});

describe("configuredRegistrars", () => {
  it("lists registrars whose variables are all set, Cloudflare first", () => {
    expect(configuredRegistrars(ALL_ENV)).toEqual([
      "cloudflare",
      "porkbun",
      "namecheap",
      "godaddy",
    ]);
    expect(
      configuredRegistrars({ PORKBUN_API_KEY: PORKBUN_KEY, NAMECHEAP_API_KEY: NAMECHEAP_KEY }),
    ).toEqual([]);
    expect(configuredRegistrars({ GODADDY_API_TOKEN: "  " })).toEqual([]);
  });
});

describe("registrarSandbox", () => {
  it("follows each registrar's sandbox switch", () => {
    expect(registrarSandbox("cloudflare", { OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX: "1" })).toBe(
      true,
    );
    expect(registrarSandbox("porkbun", { PORKBUN_API_KEY: PORKBUN_KEY })).toBe(false);
    expect(registrarSandbox("porkbun", { PORKBUN_API_KEY: `pk1_sb_${"0".repeat(8)}` })).toBe(true);
    expect(registrarSandbox("namecheap", { NAMECHEAP_SANDBOX: "1" })).toBe(true);
    expect(registrarSandbox("godaddy", ALL_ENV)).toBe(false);
  });
});

describe("registrarLinks", () => {
  it("gives every registrar a domain page and an API page", () => {
    for (const id of ["cloudflare", "porkbun", "namecheap", "godaddy"] as const) {
      const links = registrarLinks(id);
      expect(links.domains).toMatch(/https:\/\//);
      expect(links.api).toMatch(/https:\/\//);
    }
    expect(registrarLinks("namecheap").contacts).toMatch(/namecheap/);
    expect(registrarLinks("namecheap", { NAMECHEAP_SANDBOX: "1" }).domains).toMatch(/sandbox/);
  });
});

describe("registrarFor", () => {
  it("builds Porkbun from its keys and registers both with the redactor", async () => {
    const deps = await createTestPhaseDeps({ env: ALL_ENV });
    const registrar = registrarFor("porkbun", deps);
    expect(registrar.id).toBe("porkbun");
    expect(capabilitiesOf(registrar).chooseYears).toBe(false);
    const text = deps.redactor.redact(`${PORKBUN_KEY} ${PORKBUN_SECRET}`);
    expect(text).not.toContain(PORKBUN_KEY);
    expect(text).not.toContain(PORKBUN_SECRET);
    expect(deps.reporter.text()).not.toMatch(/sandbox/i);
  });

  it("warns when Porkbun sandbox keys are used", async () => {
    const deps = await createTestPhaseDeps({
      env: { ...ALL_ENV, PORKBUN_API_KEY: `pk1_sb_${"0".repeat(64)}` },
    });
    registrarFor("porkbun", deps);
    expect(deps.reporter.text()).toMatch(/warn: Using Porkbun's sandbox/);
  });

  it("stops with the missing variable names, never the values", async () => {
    const deps = await createTestPhaseDeps({ env: { PORKBUN_API_KEY: PORKBUN_KEY } });
    let caught: unknown;
    try {
      registrarFor("porkbun", deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpsCrewError);
    const error = caught as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("PORKBUN_SECRET_API_KEY");
    expect(`${error.message} ${error.hint}`).not.toContain(PORKBUN_KEY);
  });

  it("builds Namecheap with NAMECHEAP_CLIENT_IP and without detecting the address", async () => {
    const { fetch, calls } = recordingFetch();
    const deps = await createTestPhaseDeps({
      env: { ...ALL_ENV, NAMECHEAP_CLIENT_IP: "198.51.100.4" },
      fetch,
    });
    const registrar = registrarFor("namecheap", deps);
    expect(registrar.id).toBe("namecheap");
    await expect(registrar.check(["shopapp.com"])).rejects.toThrow(OpsCrewError);
    expect(calls.some((c) => c.url.includes("cdn-cgi/trace"))).toBe(false);
    const body = new URLSearchParams(calls[0]?.body ?? "");
    expect(calls[0]?.url).toBe("https://api.namecheap.com/xml.response");
    expect(body.get("ClientIp")).toBe("198.51.100.4");
    expect(body.get("UserName")).toBe("testuser");
    expect(deps.redactor.redact(NAMECHEAP_KEY)).not.toContain(NAMECHEAP_KEY);
  });

  it("detects Namecheap's ClientIp through Cloudflare's trace page and honours the sandbox", async () => {
    const { fetch, calls } = recordingFetch();
    const deps = await createTestPhaseDeps({
      env: { ...ALL_ENV, NAMECHEAP_SANDBOX: "1", NAMECHEAP_USERNAME: "owner" },
      fetch,
    });
    const registrar = registrarFor("namecheap", deps);
    await expect(registrar.check(["shopapp.com"])).rejects.toThrow(OpsCrewError);
    expect(calls[0]?.url).toBe("https://www.cloudflare.com/cdn-cgi/trace");
    const api = calls.find((c) => c.url.includes("namecheap"));
    expect(api?.url).toBe("https://api.sandbox.namecheap.com/xml.response");
    const body = new URLSearchParams(api?.body ?? "");
    expect(body.get("ClientIp")).toBe("203.0.113.9");
    expect(body.get("UserName")).toBe("owner");
    expect(deps.reporter.text()).toMatch(/warn: Using Namecheap's sandbox/);
  });

  it("builds GoDaddy from its token and registers it with the redactor", async () => {
    const deps = await createTestPhaseDeps({ env: { ...ALL_ENV, GODADDY_PROFILE_ID: "12345" } });
    const registrar = registrarFor("godaddy", deps);
    expect(registrar.id).toBe("godaddy");
    expect(deps.redactor.redact(GODADDY_TOKEN)).not.toContain(GODADDY_TOKEN);
  });
});

describe("resolveDomainServices: other registrars and sandbox zones", () => {
  const zones: DomainZoneApi = {
    findZone: async () => undefined,
    createZone: async (_a, name) => ({ id: "z1", name }),
    enableDnssec: async () => {},
  };
  const cloudflare = {
    accounts: async () => [{ id: "acc-1", name: "Main" }],
    registrar: () => fakeRegistrar("cloudflare"),
    extension: async () => undefined,
    zones,
  };

  it("uses only the given registrars when tests pass them", async () => {
    const deps = await createTestPhaseDeps({ env: ALL_ENV });
    const porkbun = fakeRegistrar("porkbun");
    const services = resolveDomainServices(deps, { ...cloudflare, registrars: { porkbun } });
    expect(services.otherRegistrar("porkbun")).toBe(porkbun);
    expect(services.configuredRegistrars()).toEqual(["cloudflare", "porkbun"]);
    expect(() => services.otherRegistrar("godaddy")).toThrow(/GoDaddy is not set up/);
  });

  it("builds each other registrar once per run from the environment", async () => {
    const deps = await createTestPhaseDeps({ env: ALL_ENV });
    const services = resolveDomainServices(deps, cloudflare);
    expect(services.configuredRegistrars()).toEqual([
      "cloudflare",
      "porkbun",
      "namecheap",
      "godaddy",
    ]);
    const first = services.otherRegistrar("namecheap");
    expect(services.otherRegistrar("namecheap")).toBe(first);
  });

  it("uses stand-in zones for a registrar in its sandbox, unless zones are given", async () => {
    const sandboxEnv = { ...ALL_ENV, NAMECHEAP_SANDBOX: "1" };
    const deps = await createTestPhaseDeps({ env: sandboxEnv });
    const real = resolveDomainServices(deps, {});
    expect(real.zonesFor("namecheap")).toBe(SANDBOX_ZONES);
    expect(real.zonesFor("porkbun")).toBe(real.zones);
    expect(real.zonesFor("cloudflare")).toBe(real.zones);
    const given = resolveDomainServices(deps, cloudflare);
    expect(given.zonesFor("namecheap")).toBe(zones);
    const zone = await SANDBOX_ZONES.createZone("acc-1", "shopapp.com");
    expect(zone.nameServers).toHaveLength(2);
  });
});
