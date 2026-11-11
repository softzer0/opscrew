// `opscrew init` for a provider whose credentials are a set (`credentials.mode: "all"`, as
// Contabo's four): here DigitalOcean's definition with four variables and a fake connector.
import type { CloudProviderDefinition, VpsConnector } from "@opscrew/contracts";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { testPlan } from "../verify/__fixtures__/plan";
import { type InitCheck, runInitChecks } from "./index";

const { SET, verified } = vi.hoisted(() => ({
  SET: ["SET_ID", "SET_SECRET", "SET_USER", "SET_PASS"],
  verified: [] as string[],
}));

vi.mock("@opscrew/providers", async (importActual) => {
  const actual = await importActual<typeof import("@opscrew/providers")>();
  const base = actual.cloudProvider("digitalocean");
  const set: CloudProviderDefinition = {
    ...base,
    credentials: { ...base.credentials, envVars: SET, mode: "all" },
    texts: {
      ...base.texts,
      init: {
        fix: "Create the four API credentials at https://set.example/api; they reach the whole account.",
        scopeNote: "",
      },
    },
    connector: (deps): VpsConnector => ({
      id: "digitalocean",
      displayName: base.displayName,
      credentials: { envVars: [...SET], description: "", scopes: [], createUrl: "" },
      configured: SET.every((name) => (deps.env[name] ?? "").trim() !== ""),
      servers: undefined,
      catalog: () => {
        throw new Error("no catalogue in this test");
      },
      async verifyCredentials() {
        verified.push(SET.map((name) => deps.env[name]).join(","));
        return { ok: true, message: "The API credentials work." };
      },
    }),
  };
  const CLOUD_PROVIDERS = actual.CLOUD_PROVIDERS.map((p) => (p.id === set.id ? set : p));
  return {
    ...actual,
    CLOUD_PROVIDERS,
    cloudProvider: (id: string) =>
      CLOUD_PROVIDERS.find((p) => p.id === id) ?? actual.cloudProvider(id),
  };
});

const ALL = Object.fromEntries(SET.map((name) => [name, `value-of-${name}`]));

/** The provider check of `opscrew init` with `env`, for a plan on the set's provider when `planned`. */
async function providerCheck(
  env: Record<string, string>,
  options: { planned?: boolean; offline?: boolean } = {},
): Promise<InitCheck> {
  verified.length = 0;
  const deps = await createTestPhaseDeps({ env });
  if (options.planned === true) {
    await writeArtifact("plan", deps.paths.files.plan, testPlan({ provider: "digitalocean" }));
  }
  const checks = await runInitChecks(deps, {
    ...(options.offline === true ? { offline: true } : {}),
    services: { which: () => undefined, nodeVersion: "22.12.0" },
  });
  const found = checks.find((check) => check.id === "provider");
  if (found === undefined) throw new Error("no provider check");
  return found;
}

describe("opscrew init with credentials as a set", () => {
  it("names the missing variables of the planned provider's set and calls nothing", async () => {
    const check = await providerCheck(
      { SET_ID: "a", SET_USER: "c", HCLOUD_TOKEN: "h" },
      { planned: true },
    );
    expect(check.status).toBe("fail");
    expect(check.message).toBe(
      "SET_SECRET and SET_PASS are not set (the plan deploys to DigitalOcean, so HCLOUD_TOKEN is not used).",
    );
    expect(check.fix).toContain("they reach the whole account");
    expect(verified).toEqual([]);
  });

  it("checks the set only once every variable is set, naming them all", async () => {
    const offline = await providerCheck(ALL, { planned: true, offline: true });
    expect(offline.status).toBe("pass");
    expect(offline.message).toMatch(/^SET_ID, SET_SECRET, SET_USER and SET_PASS are set \(/);
    expect(verified).toEqual([]);

    const online = await providerCheck(ALL, { planned: true });
    expect(online.status).toBe("pass");
    expect(online.message).toBe("SET_ID, SET_SECRET, SET_USER and SET_PASS work.");
    expect(verified).toEqual([SET.map((name) => `value-of-${name}`).join(",")]);
  });

  it("chooses the provider by its credentials only when the whole set is there", async () => {
    const { SET_PASS: _pass, ...three } = ALL;
    const partial = await providerCheck(three, { offline: true });
    expect(partial.status).toBe("warn");
    expect(partial.message).toContain(
      "HCLOUD_TOKEN for Hetzner Cloud, SET_PASS for DigitalOcean or CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER and CNTB_OAUTH2_PASS for Contabo",
    );

    const whole = await providerCheck(ALL, { offline: true });
    expect(whole.title).toBe("DigitalOcean credentials");
    expect(whole.status).toBe("pass");
    expect(whole.message).toContain("No provider is chosen yet.");

    const both = await providerCheck({ ...ALL, HCLOUD_TOKEN: "h" }, { offline: true });
    expect(both.message).toContain(
      "HCLOUD_TOKEN for Hetzner Cloud and SET_ID, SET_SECRET, SET_USER and SET_PASS for DigitalOcean are both set.",
    );
  });
});
