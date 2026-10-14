import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { zeroTrustAuthDomain } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PortainerServices } from "../portainer";
import { createTestPhaseDeps, ScriptedApprovalHandler } from "../testing";
import {
  createProject,
  FakeEngine,
  FakeGitHub,
  projectRunner,
  readyRemote,
  testPlan,
} from "./__fixtures__/fakes";
import { ACCOUNT_ID, fakeZeroTrust, ownCloudflare } from "./__fixtures__/own";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";

const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };

/** A Hetzner plan with Portainer on a subdomain behind Cloudflare Access. */
function hetznerWithPortainer() {
  const plan = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...plan,
    dns: { ...plan.dns, zone: "example.com" },
    portainer: {
      enabled: true,
      version: "2.45.2",
      access: "subdomain",
      hostname: "portainer.example.com",
      allowedEmails: ["owner@example.com"],
    },
  });
}

async function setup(o: { organization?: string; pin?: string }) {
  const project = await createProject(hetznerWithPortainer());
  await writeFile(
    join(project.root, "production.env"),
    `STRIPE_SECRET_KEY=${fakeSecret("stripe-live-key")}\n`,
  );
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const zeroTrust = { authDomain: o.organization };
  const lookups: string[] = [];
  const services: PortainerServices = {
    engine: async () => new FakeEngine(),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    own: {
      zeroTrust: {
        organization: async (accountId) =>
          fakeZeroTrust(zeroTrust.authDomain).organization(accountId),
      },
    },
    accessLoginMethods: {
      oneTimePin: async (accountId) => {
        lookups.push(accountId);
        return o.pin;
      },
    },
  };
  const tfvars = async () =>
    JSON.parse(
      await readFile(join(project.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
  return { ...project, deps, github, handler, services, zeroTrust, lookups, tfvars };
}

describe.skipIf(!findExecutable("git"))(
  "runProvision: Cloudflare Access settings on Hetzner with a Portainer subdomain",
  () => {
    it("creates the Zero Trust organization and keeps creating it on a re-run, reusing the account's PIN method", async () => {
      const s = await setup({ pin: "pin-existing" });
      await runProvision(s.deps, { services: s.services });
      expect(await s.tfvars()).toMatchObject({
        cloudflare_account_id: ACCOUNT_ID,
        create_zero_trust_organization: true,
        zero_trust_auth_domain: zeroTrustAuthDomain("example.com"),
        one_time_pin_identity_provider_id: "pin-existing",
        portainer_hostname: "portainer.example.com",
      });
      expect(s.lookups).toEqual([ACCOUNT_ID]);

      // The apply created OpsCrew's organization; the re-run must neither delete it nor look again.
      s.zeroTrust.authDomain = zeroTrustAuthDomain("example.com");
      s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
      s.handler.requests.length = 0;
      const first = await s.tfvars();
      await runProvision(s.deps, { services: s.services });
      expect(await s.tfvars()).toEqual(first);
      expect(s.lookups).toEqual([ACCOUNT_ID]);
      expect(s.handler.requests.map((r) => r.kind)).not.toContain("repo-write");
    });

    it("leaves the PIN method unset on a re-run when OpsCrew created it (it is in the state)", async () => {
      const s = await setup({ organization: "team.cloudflareaccess.com" });
      await runProvision(s.deps, { services: s.services });
      const first = await s.tfvars();
      expect(first.create_zero_trust_organization).toBe(false);
      expect(first).not.toHaveProperty("one_time_pin_identity_provider_id");

      // Cloudflare now lists OpsCrew's own PIN method; naming it would make the plan destroy it.
      s.services.accessLoginMethods = { oneTimePin: async () => "pin-created-by-opscrew" };
      s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
      await runProvision(s.deps, { services: s.services });
      expect(await s.tfvars()).toEqual(first);
    });
  },
);
