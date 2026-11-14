import { readFile } from "node:fs/promises";
import type { DeployPlan } from "@opscrew/plan-schema";
import { writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import { createTestPhaseDeps, type TestPhaseDeps, testPlan } from "../testing";
import { publishRotatedKey } from "./addons";
import { rotateBeszel } from "./addons-beszel";
import { rotateMonitoring } from "./addons-monitoring";
import { rotatePortainerPassword } from "./addons-portainer";
import { rotateSiteAppSecrets } from "./app-site";
import { rotateAccessToken, rotateStatePassphrase, rotateTunnelToken } from "./infra";
import { rotateSshKey } from "./keys";
import { rotateLocalServices } from "./localhost";
import { rotateDevice, rotateNetwork } from "./network";
import { rotateGrant } from "./network-grant";
import { rotatePortainerServices } from "./portainer";
import { rotateDeviceLogin, rotateServices } from "./server";
import { replaceToken } from "./tokens";

/** Nothing a rotation reaches: each refuses before it uses any. */
const none = {} as never;

/** Every rotation's entry point, called as `opscrew rotate` calls it. */
const ROTATIONS: [string, (deps: TestPhaseDeps, plan: DeployPlan) => Promise<unknown>][] = [
  [
    "recovery-key",
    (d, plan) => publishRotatedKey(d, { git: none, github: none, plan, keyOut: "" }),
  ],
  ["beszel", (d, plan) => rotateBeszel(d, plan)],
  ["monitoring", (d, plan) => rotateMonitoring(d, plan)],
  ["portainer", (d, plan) => rotatePortainerPassword(d, plan)],
  ["a site's app secrets", (d, plan) => rotateSiteAppSecrets(d, plan, ["app"], none)],
  ["access-token", (d, plan) => rotateAccessToken(d, plan, none)],
  ["tunnel-token", (d, plan) => rotateTunnelToken(d, plan, none)],
  ["state-passphrase", (d, plan) => rotateStatePassphrase(d, plan)],
  ["deploy-key", (d, plan) => rotateSshKey(d, plan, "deploy-key", none)],
  ["services on this computer", (d, plan) => rotateLocalServices(d, plan, ["db"])],
  ["device", (d, plan) => rotateDevice(d, plan, "laptop")],
  ["network", (d, plan) => rotateNetwork(d, plan)],
  ["grant", (d, plan) => rotateGrant(d, plan, "laptop", "db", none)],
  ["services on Portainer", (d, plan) => rotatePortainerServices(d, plan, ["db"])],
  ["services on servers", (d, plan) => rotateServices(d, plan, ["db"], none)],
  ["a device's login", (d, plan) => rotateDeviceLogin(d, plan, none, none)],
  ["a user token", (d, plan) => replaceToken(d, plan, "cloudflare")],
];

describe("every rotation during a move to another Cloudflare account", () => {
  it.each(ROTATIONS)("refuses %s at its entry point, before any change", async (_name, rotate) => {
    const accounts = twoAccounts();
    const deps = await createTestPhaseDeps();
    Object.assign(deps.env, accounts.env);
    const plan = withCloudflareMove(testPlan({ deployed: true }), accounts, "prepared");
    await writeArtifact("plan", deps.paths.files.plan, plan);
    const before = await readFile(deps.paths.files.plan, "utf8");
    const error = await rotate(deps, plan).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A move of example.com to another Cloudflare account is in progress. Nothing was changed.",
      hint: expect.stringContaining("`opscrew cloudflare move --switch`"),
    });
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(before);
    expect(deps.audit.entries).toEqual([]);
    expect(deps.runner).toMatchObject({ calls: [] });
    expect(accounts.cloudflare.calls).toEqual([]);
    const { message, hint } = error as Error & { hint: string };
    expect(leaksToken(accounts, message, hint, deps.reporter.text())).toBe(false);
  });
});
