import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable, type OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

async function project() {
  const created = await createProject(testPlan({ domain: "shop.example.com" }));
  await writeFile(
    join(created.root, "production.env"),
    `STRIPE_SECRET_KEY=${fakeSecret("stripe-live-key")}\n`,
  );
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: created.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(created.root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const engine = new FakeEngine({ planJson: planJsonFor({ proxied: true }) });
  const zone = new FakeZone();
  const services: ProvisionServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github: new FakeGitHub(),
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(zone),
  };
  return { ...created, deps, handler, services, engine, zone };
}

describe.skipIf(!findExecutable("git"))("opscrew provision: the recovery copy", () => {
  it("stops before any plan or change when another computer updated the repository's copy", async () => {
    const s = await project();
    await mkdir(join(s.root, "opscrew"), { recursive: true });
    await writeFile(join(s.root, "opscrew/secrets.sops.json"), '{"files":{},"sops":{}}\n');
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("SECRETS_COPY_CHANGED_ELSEWHERE");
    expect(error.hint).toContain("opscrew secrets restore");
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
    expect(s.zone.calls).toEqual([]);
  });

  it("asks the first key's file through the run's recovery options when the first copy is made", async () => {
    const s = await project();
    const asked: string[] = [];
    await runProvision(s.deps, {
      services: s.services,
      recovery: {
        recipient: async () => {
          asked.push("recipient");
          return undefined;
        },
        keyOut: async () => {
          asked.push("keyOut");
          return undefined;
        },
      },
    });
    expect(asked).toEqual(["recipient", "keyOut"]);
  });
});
