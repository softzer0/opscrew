// `opscrew rotate` with a provider whose credentials are a set (`credentials.mode: "all"`, as
// Contabo's four): here DigitalOcean's definition with four variables and a fake connector.
import type { CloudProviderDefinition, VpsConnector } from "@opscrew/contracts";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { createTestPhaseDeps, type TestPhaseDeps, testPlan } from "../testing";
import { credentialInventory, credentialListLines, listedCredentials } from "./inventory";
import { tokenFirstSeen, tokenSeenAt } from "./record-tokens";
import { replaceToken, tokenExpiries } from "./tokens";

const { SET } = vi.hoisted(() => ({ SET: ["SET_ID", "SET_SECRET", "SET_USER", "SET_PASS"] }));

vi.mock("@opscrew/providers", async (importActual) => {
  const actual = await importActual<typeof import("@opscrew/providers")>();
  const base = actual.cloudProvider("digitalocean");
  const set: CloudProviderDefinition = {
    ...base,
    credentials: { ...base.credentials, envVars: SET, mode: "all" },
    texts: { ...base.texts, rotate: { deleteToken: "https://set.example/api" } },
    connector: (deps): VpsConnector => ({
      id: "digitalocean",
      displayName: base.displayName,
      credentials: { envVars: [...SET], description: "", scopes: [], createUrl: "" },
      configured: SET.every((name) => (deps.env[name] ?? "").trim() !== ""),
      servers: undefined,
      catalog: () => {
        throw new Error("no catalogue in this test");
      },
      verifyCredentials: async () => ({ ok: true, message: "The API credentials work." }),
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

const VALUES = SET.map((name) => `value-of-${name}`);
const ALL = Object.fromEntries(SET.map((name, i) => [name, VALUES[i] as string]));
const NAMES = "SET_ID, SET_SECRET, SET_USER and SET_PASS";
const plan = testPlan({ provider: "digitalocean" });

async function setup(env: Record<string, string>): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps();
  Object.assign(deps.env, env);
  await writeArtifact("plan", deps.paths.files.plan, plan);
  return deps;
}

/** No credential value in anything the run showed or audited. */
function expectNoValue(deps: TestPhaseDeps, ...more: unknown[]): void {
  const text = [deps.reporter.text(), JSON.stringify(deps.audit.entries), JSON.stringify(more)];
  for (const value of VALUES) expect(text.join("\n")).not.toContain(value);
}

describe("the user's tokens with credentials as a set", () => {
  it("lists the set under every variable and names the missing ones", async () => {
    const { SET_SECRET: _secret, SET_PASS: _pass, ...two } = ALL;
    const deps = await setup(two);
    const [listed] = (await tokenExpiries(deps, plan)).filter((t) => t.name === "digitalocean");
    expect(listed).toEqual({
      name: "digitalocean",
      variable: NAMES,
      notRead: "SET_SECRET and SET_PASS are not set.",
    });
    expectNoValue(deps, listed);
  });

  it("dates the whole set by its fingerprint, which a new value of any of them changes", async () => {
    const deps = await setup(ALL);
    const seen = await tokenFirstSeen(
      { ...deps, clock: { now: () => new Date("2026-03-01T08:00:00.000Z") } },
      "digitalocean",
      VALUES.join("\n"),
    );
    const inventory = await credentialInventory(deps, plan);
    const expiries = await tokenExpiries(deps, plan);
    expect(expiries.find((t) => t.name === "digitalocean")).toEqual({
      name: "digitalocean",
      variable: NAMES,
      firstSeen: seen,
    });
    const lines = credentialListLines(
      listedCredentials(inventory, expiries),
      { app: "shop", environment: "prod", flag: "", opscrew: "opscrew" },
      new Date("2026-03-11T08:00:00.000Z"),
    );
    expect(lines).toContain(
      `- digitalocean (${NAMES}): first seen on this computer 2026-03-01, 10 days ago.`,
    );
    expect(await tokenSeenAt(deps, "digitalocean", [...VALUES.slice(0, 3), "new"].join("\n"))).toBe(
      undefined,
    );
    expectNoValue(deps, inventory, expiries, lines);
  });

  it("puts a new set in place only when every variable is set", async () => {
    const { SET_PASS: _pass, ...three } = ALL;
    const partial = await setup(three);
    const error = await replaceToken(partial, plan, "digitalocean").catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "CREDENTIALS_MISSING",
      message:
        "SET_PASS is not set, so there are no new DigitalOcean credentials to put in place. Nothing was changed.",
      hint: `Make the new credentials at https://set.example/api, set them in ${NAMES} first, then run \`opscrew rotate digitalocean\` again.`,
    });

    const deps = await setup(ALL);
    const replaced = await replaceToken(deps, plan, "digitalocean", {
      init: { which: () => undefined, nodeVersion: "22.12.0" },
    });
    expect(replaced).toEqual({
      name: "digitalocean",
      copies: [],
      deletePage: "https://set.example/api",
    });
    const text = deps.reporter.text();
    expect(text).toContain(
      `OpsCrew made no copy of the DigitalOcean credentials: it reads them from ${NAMES} on this computer.`,
    );
    expect(text).toContain(
      "Delete the old DigitalOcean credentials at https://set.example/api: OpsCrew no longer uses them.",
    );
    expect(await tokenSeenAt(deps, "digitalocean", VALUES.join("\n"))).toBeDefined();
    expectNoValue(deps, replaced);

    const again = await replaceToken(deps, plan, "digitalocean").catch((e: unknown) => e);
    expect(again).toMatchObject({
      code: "INVALID_INPUT",
      message: `${NAMES} hold the DigitalOcean credentials OpsCrew already knows, not new ones. Nothing was changed.`,
    });
  });
});
