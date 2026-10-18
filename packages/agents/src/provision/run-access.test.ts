import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PortainerServices } from "../portainer";
import {
  ACCOUNT_ID,
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  ownCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";
import { zeroTrustAuthDomain } from "./shared-cloudflare";

const OPEN_PULL = { number: 7, url: "https://github.com/acme/shop/pull/7" };
const ORGANIZATIONS = `/accounts/${ACCOUNT_ID}/access/organizations`;
const PROVIDERS = `/accounts/${ACCOUNT_ID}/access/identity_providers`;

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

async function setup(zone: FakeZone) {
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
  // The engine records whether the account's Zero Trust pieces existed when it applied.
  const engine = new FakeEngine();
  const atApply: { organization: boolean; pins: number }[] = [];
  const apply = engine.apply.bind(engine);
  engine.apply = async (...args) => {
    atApply.push({ organization: zone.organization !== undefined, pins: zone.providers.length });
    return apply(...args);
  };
  const services: PortainerServices = {
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(zone),
  };
  const tfvars = async () =>
    JSON.parse(
      await readFile(join(project.root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
  return { ...project, deps, github, handler, services, tfvars, atApply };
}

const accountWrites = (zone: FakeZone) =>
  zone.writes().filter((call) => call.path.startsWith(`/accounts/${ACCOUNT_ID}/`));

describe.skipIf(!findExecutable("git"))(
  "runProvision: Cloudflare Access settings on Hetzner with a Portainer subdomain",
  () => {
    it("creates the Zero Trust organization and the one-time PIN login before the infrastructure, and a re-run changes nothing", async () => {
      const zone = new FakeZone();
      const s = await setup(zone);
      await runProvision(s.deps, { services: s.services });

      const kinds = s.handler.requests.map((r) => r.kind);
      expect(kinds.indexOf("cloudflare-apply")).toBeLessThan(kinds.indexOf("iac-apply"));
      expect(s.atApply).toEqual([{ organization: true, pins: 1 }]);
      const authDomain = zeroTrustAuthDomain("example.com");
      expect(zone.organization).toEqual({ name: authDomain, auth_domain: authDomain });
      expect(accountWrites(zone).map((call) => `${call.method} ${call.path}`)).toEqual([
        `POST ${ORGANIZATIONS}`,
        `POST ${PROVIDERS}`,
      ]);
      const pin = zone.providers.find((provider) => provider.type === "onetimepin");
      const first = await s.tfvars();
      expect(first).toMatchObject({
        cloudflare_account_id: ACCOUNT_ID,
        one_time_pin_identity_provider_id: pin?.id,
        portainer_hostname: "portainer.example.com",
      });
      expect(first).not.toHaveProperty("create_zero_trust_organization");
      expect(first).not.toHaveProperty("zero_trust_auth_domain");
      const request = s.handler.requests.find((r) => r.kind === "cloudflare-apply");
      expect(request?.details).toContain(
        `~ Create the account's Zero Trust organization (team domain ${authDomain})`,
      );
      expect(request?.details).toContain(
        "~ Add the one-time PIN login to the account's Zero Trust organization",
      );

      // Nothing changed: the re-run asks nothing and writes nothing in Cloudflare.
      s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
      s.handler.requests.length = 0;
      const writes = zone.writes().length;
      await runProvision(s.deps, { services: s.services });
      expect(await s.tfvars()).toEqual(first);
      expect(zone.writes()).toHaveLength(writes);
      const again = s.handler.requests.map((r) => r.kind);
      expect(again).not.toContain("cloudflare-apply");
      expect(again).not.toContain("repo-write");
    });

    it("reuses the organization and one-time PIN login the user set up, never changing or deleting them", async () => {
      const zone = new FakeZone();
      zone.organization = { name: "Acme", auth_domain: "acme.cloudflareaccess.com" };
      zone.providers.push({ id: "pin-existing", name: "One-time PIN", type: "onetimepin" });
      const s = await setup(zone);
      await runProvision(s.deps, { services: s.services });

      expect(zone.organization).toEqual({ name: "Acme", auth_domain: "acme.cloudflareaccess.com" });
      expect(zone.providers).toEqual([
        { id: "pin-existing", name: "One-time PIN", type: "onetimepin" },
      ]);
      expect(accountWrites(zone)).toEqual([]);
      const first = await s.tfvars();
      expect(first.one_time_pin_identity_provider_id).toBe("pin-existing");
      const request = s.handler.requests.find((r) => r.kind === "cloudflare-apply");
      expect(request?.details).toContain(
        "✓ The account's Zero Trust organization (team domain acme.cloudflareaccess.com) (already in place)",
      );
      expect(request?.details).toContain("✓ The account's one-time PIN login (already in place)");

      s.github.openPulls.set(DEPLOY_SETUP_BRANCH, OPEN_PULL);
      await runProvision(s.deps, { services: s.services });
      expect(await s.tfvars()).toEqual(first);
      expect(accountWrites(zone)).toEqual([]);
      expect(zone.calls.some((call) => call.method === "DELETE")).toBe(false);
    });
  },
);
