import type { VpsConnector } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import type { FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CREDENTIALS_ENV, contaboFetch, LOGIN, page, param } from "./__fixtures__/fixtures";
import { StaticContaboCatalog } from "./catalog";
import { type ContaboConnector, contaboConnector } from "./connector";

// Type-level check: the Contabo connector satisfies the VPS connector contract.
const asVps = (c: ContaboConnector) => c satisfies VpsConnector;

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string> = CREDENTIALS_ENV,
  redactor?: Redactor,
) {
  const fake = contaboFetch(routes);
  return {
    connector: contaboConnector({
      env,
      fetch: fake.fetch,
      sleep: async () => {},
      ...(redactor ? { redactor } : {}),
    }),
    calls: fake.calls,
  };
}

describe("contaboConnector", () => {
  it("describes the four credentials, where to create them and that they reach the whole account", () => {
    const { connector: c } = connector({});
    expect(c.id).toBe("contabo");
    expect(c.displayName).toBe("Contabo");
    expect(c.credentials).toMatchObject({
      envVars: [
        "CNTB_OAUTH2_CLIENT_ID",
        "CNTB_OAUTH2_CLIENT_SECRET",
        "CNTB_OAUTH2_USER",
        "CNTB_OAUTH2_PASS",
      ],
      scopes: [],
      createUrl: "https://new.contabo.com/account/security",
    });
    expect(c.credentials.description).toContain("reach the whole account");
  });

  it("is configured, with a server API and firewalls, only with all four credentials", () => {
    expect(asVps(connector({}).connector).configured).toBe(true);
    expect(connector({}).connector.servers).toBeDefined();
    expect(connector({}).connector.firewalls).toBeDefined();
    const { CNTB_OAUTH2_PASS: _, ...three } = CREDENTIALS_ENV;
    const partial = connector({}, three).connector;
    expect(partial.configured).toBe(false);
    expect(partial.servers).toBeUndefined();
    expect(partial.firewalls).toBeUndefined();
  });

  it("names the missing credentials and calls nothing", async () => {
    const { calls, connector: c } = connector(
      {},
      { CNTB_OAUTH2_CLIENT_ID: CREDENTIALS_ENV.CNTB_OAUTH2_CLIENT_ID, CNTB_OAUTH2_USER: "" },
    );
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain(
      "CNTB_OAUTH2_CLIENT_SECRET, CNTB_OAUTH2_USER and CNTB_OAUTH2_PASS are not set",
    );
    expect(check.message).toContain("https://new.contabo.com/account/security");
    expect(calls).toEqual([]);
  });

  it("registers every credential with the redactor as it reads it", () => {
    const redactor = new Redactor();
    connector({}, CREDENTIALS_ENV, redactor);
    for (const value of Object.values(CREDENTIALS_ENV)) {
      expect(redactor.redact(`value ${value}`)).not.toContain(value);
    }
  });

  it("verifies the credentials with a token and one page of one instance", async () => {
    const { connector: c, calls } = connector({ "/v1/compute/instances?": page([]) });
    expect(await c.verifyCredentials()).toEqual({
      ok: true,
      message: "The Contabo API credentials work.",
    });
    expect(calls).toHaveLength(2);
    expect(param(calls[1], "size")).toBe("1");
  });

  it("reports refused credentials without any of them", async () => {
    const { connector: c } = connector({
      [LOGIN]: {
        status: 401,
        body: {
          error: "invalid_grant",
          error_description: `Invalid user credentials for ${CREDENTIALS_ENV.CNTB_OAUTH2_USER}`,
        },
      },
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("Contabo refused the API credentials");
    for (const value of Object.values(CREDENTIALS_ENV)) expect(check.message).not.toContain(value);
  });

  it("always prices from the dated static table, with or without credentials", () => {
    expect(connector({}).connector.catalog()).toBeInstanceOf(StaticContaboCatalog);
    expect(connector({}, {}).connector.catalog()).toBeInstanceOf(StaticContaboCatalog);
  });
});
