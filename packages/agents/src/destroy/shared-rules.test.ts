import { writeFile } from "node:fs/promises";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { FetchLike } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type OwnProject, ownProject, provisionOwn } from "../drift/__fixtures__/own-project";
import { readCloudflareRecord } from "../provision/shared-cloudflare";
import { fakeSharedCloudflare, ownPlan } from "../testing";
import { runDestroy } from "./run";
import type { DestroyPreview, DestroyServices } from "./types";

const WAF = "http_request_firewall_custom";
const CONFIG = "http_config_settings";
const USER_RULE = { description: "user", expression: "(cf.client.bot)", action: "block" };

/** A provisioned own-server app whose OpsCrew rules are in `zone`. */
async function deployed(zone: FakeZone, domain = "shop.example.com"): Promise<OwnProject> {
  const s = await ownProject({ plan: ownPlan({ domain }) });
  s.services.sharedCloudflare = fakeSharedCloudflare(zone);
  await provisionOwn(s);
  return s;
}

function services(s: OwnProject): DestroyServices {
  return {
    engine: s.services.engine,
    github: s.github,
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    ...(s.services.own !== undefined ? { own: s.services.own } : {}),
  };
}

/** The hostnames OpsCrew's rule of `phase` lists (none when there is no such rule). */
function listed(zone: FakeZone, phase: string): string[] {
  const expression = String(zone.opscrewRule(phase)?.expression ?? "");
  return [...expression.matchAll(/"([a-z0-9.-]+\.[a-z]+)"/g)]
    .map((match) => match[1] as string)
    .filter((host) => host.endsWith(".example.com"));
}

async function expectError(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

describe.skipIf(!findExecutable("git"))(
  "opscrew destroy and OpsCrew's shared Cloudflare rules",
  () => {
    it("two apps in one zone: the first destroy keeps the other's hostnames, the last deletes OpsCrew's rules and leaves the user's rule as it was", async () => {
      const zone = new FakeZone();
      zone.seedRule(WAF, USER_RULE);
      const userRules = zone.userRulesText(WAF);
      const a = await deployed(zone);
      const b = await deployed(zone, "api.example.com");
      expect(listed(zone, WAF)).toEqual(["api.example.com", "shop.example.com"]);
      expect(listed(zone, CONFIG)).toEqual(["api.example.com", "shop.example.com"]);

      const previews: DestroyPreview[] = [];
      const confirm = async (preview: DestroyPreview) => {
        previews.push(preview);
        return true;
      };
      const writes = zone.writes().length;
      await runDestroy(a.deps, { services: services(a), confirm });

      // The removal is shown before the typed name and approved as its own Cloudflare plan.
      expect(previews[0]?.cloudflarePlan).toContain(
        "Cloudflare plan for the zone of shop.example.com",
      );
      expect(previews[0]?.cloudflarePlan).toContain(
        "Block probes for secrets and admin panels: remove shop.example.com",
      );
      expect(previews[0]?.cloudflarePlan).toContain(
        "OpsCrew's rule keeps the 1 hostname of other OpsCrew apps there.",
      );
      const request = a.handler.requests.find((r) => r.kind === "cloudflare-apply");
      expect(request).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
      // Printed once, with the preview: the approval has it, the apply does not print it again.
      expect(request?.details).toBe(previews[0]?.cloudflarePlan);
      expect(a.deps.reporter.text().split("Cloudflare plan for the zone of")).toHaveLength(2);
      // After the app is removed from the server and its DNS records are deleted.
      expect(a.handler.requests.map((r) => r.kind)).toEqual([
        "iac-apply",
        "host-apply",
        "cloudflare-apply",
        "github-secrets",
      ]);
      expect(
        zone
          .writes()
          .slice(writes)
          .map((c) => c.method),
      ).toEqual(["PATCH", "PATCH"]);
      expect(listed(zone, WAF)).toEqual(["api.example.com"]);
      expect(listed(zone, CONFIG)).toEqual(["api.example.com"]);
      expect(await readCloudflareRecord(a.deps.paths)).toMatchObject({ hostnames: {} });
      const recorded = await readArtifact("plan", a.deps.paths.files.plan);
      expect(recorded.approvals.at(-1)?.kind).toBe("cloudflare-apply");

      await runDestroy(b.deps, { services: services(b), confirm });
      expect(previews[1]?.cloudflarePlan).toContain(
        "No other OpsCrew app is in OpsCrew's rule, so OpsCrew deletes it, and the zone's configuration rules, which then hold no rule.",
      );
      expect(b.handler.requests.find((r) => r.kind === "cloudflare-apply")).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "shop",
      });
      expect(zone.opscrewRule(WAF)).toBeUndefined();
      expect(zone.userRulesText(WAF)).toBe(userRules);
      expect(zone.entrypoints.has(CONFIG)).toBe(false);
      expect(await readCloudflareRecord(b.deps.paths)).toEqual({
        zoneId: expect.any(String),
        hostnames: {},
        createdEntrypoints: [],
      });
    });

    it("a damaged record stops destroy before anything changes", async () => {
      const zone = new FakeZone();
      const s = await deployed(zone);
      await writeFile(s.deps.paths.files.cloudflareRecord, "{ not json");
      const before = { writes: zone.writes().length, host: s.host.applies.length };
      const engineApplies = s.engine.applies.length;

      const error = await expectError(
        runDestroy(s.deps, { services: services(s), confirm: async () => true }),
        "PHASE_PRECONDITION",
      );
      expect(error.message).toContain(".opscrew/cloudflare.json");
      expect(error.message).toContain("is damaged");
      expect(error.message).toContain("Nothing was changed.");
      expect(s.handler.requests).toEqual([]);
      expect(zone.writes()).toHaveLength(before.writes);
      expect(s.host.applies).toHaveLength(before.host);
      expect(s.engine.applies).toHaveLength(engineApplies);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.deployment.destroyedAt).toBeUndefined();
    });

    it("deletes an empty ruleset this app created that an interrupted destroy left behind", async () => {
      const zone = new FakeZone();
      const s = await deployed(zone);
      expect((await readCloudflareRecord(s.deps.paths))?.createdEntrypoints).toEqual([WAF, CONFIG]);
      const waf = zone.entrypoints.get(WAF)?.id;
      // OpsCrew's rule goes, but deleting the ruleset that then holds no rule fails.
      const failing: FetchLike = async (input, init) =>
        init?.method === "DELETE" && String(input).endsWith(`/rulesets/${waf}`)
          ? new Response("Bad Gateway", { status: 502 })
          : zone.fetch(input, init);
      s.services.sharedCloudflare = new CloudflareClient({
        token: fakeSecret("cloudflare-token", "shared"),
        fetch: failing,
        sleep: async () => undefined,
      });
      await expectError(
        runDestroy(s.deps, { services: services(s), confirm: async () => true }),
        "PROVIDER_ERROR",
      );
      expect(zone.entrypoints.get(WAF)?.rules).toEqual([]);
      expect(await readCloudflareRecord(s.deps.paths)).toMatchObject({
        hostnames: { "opscrew-strict-tls": ["shop.example.com"] },
        createdEntrypoints: [WAF, CONFIG],
      });

      // The rerun finishes: the empty ruleset goes, and so does the rest.
      s.services.sharedCloudflare = fakeSharedCloudflare(zone);
      s.handler.requests.length = 0;
      const previews: DestroyPreview[] = [];
      await runDestroy(s.deps, {
        services: services(s),
        confirm: async (preview) => {
          previews.push(preview);
          return true;
        },
      });
      expect(previews[0]?.cloudflarePlan).toContain(
        "Block probes for secrets and admin panels: delete the zone's WAF custom rules, which hold no rule",
      );
      expect(s.handler.requests.find((r) => r.kind === "cloudflare-apply")).toMatchObject({
        allowDestroy: true,
        confirmPhrase: "shop",
      });
      expect(zone.entrypoints.size).toBe(0);
      expect(await readCloudflareRecord(s.deps.paths)).toMatchObject({
        hostnames: {},
        createdEntrypoints: [],
      });
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.deployment.destroyedAt).toBeDefined();
    });

    it("an unconfirmed name changes nothing in OpsCrew's rules", async () => {
      const zone = new FakeZone();
      const s = await deployed(zone);
      const writes = zone.writes().length;
      await expectError(
        runDestroy(s.deps, { services: services(s), confirm: async () => false }),
        "APPROVAL_REFUSED",
      );
      expect(zone.writes()).toHaveLength(writes);
      expect(listed(zone, WAF)).toEqual(["shop.example.com"]);
    });
  },
);
