import { readFile, writeFile } from "node:fs/promises";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { fakeSharedCloudflare } from "../testing";
import { ownProject, provisionOwn } from "./__fixtures__/own-project";
import { renderDriftReport } from "./render";
import { runDrift } from "./run";
import type { CloudflareRuleDifference } from "./types";

const WAF = "http_request_firewall_custom";
const CONFIG = "http_config_settings";
const BLOCK = "Block probes for secrets and admin panels";
const TLS = "Verify the origin certificate (Full (strict) TLS)";

/** A provisioned own-server app (shop.example.com) whose OpsCrew rules are in a fake zone. */
async function deployed() {
  const zone = new FakeZone();
  const s = await ownProject();
  s.services.sharedCloudflare = fakeSharedCloudflare(zone);
  await provisionOwn(s);
  return { s, zone };
}

/** OpsCrew's rule of `phase` in the fake zone, to edit as someone in the dashboard would. */
function rule(zone: FakeZone, phase: string): Record<string, unknown> {
  const found = zone.opscrewRule(phase);
  if (found === undefined) throw new Error(`no OpsCrew rule in ${phase}`);
  return found;
}

describe.skipIf(!findExecutable("git"))(
  "opscrew drift and OpsCrew's shared Cloudflare rules",
  () => {
    it("is clean when OpsCrew's rules list this app's hostnames as recorded", async () => {
      const { s, zone } = await deployed();
      const writes = zone.writes().length;
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.cloudflareRules).toEqual([]);
      expect(report.clean).toBe(true);
      expect(zone.writes()).toHaveLength(writes);
    });

    it.each<[string, (zone: FakeZone) => void, CloudflareRuleDifference]>([
      [
        "a missing OpsCrew rule",
        (zone) => {
          zone.entrypoints.delete(CONFIG);
        },
        {
          title: `OpsCrew's rule "${TLS}" is missing from the zone's configuration rules`,
          detail:
            "`opscrew provision` creates it again with this app's hostnames (it shows the Cloudflare plan first); other OpsCrew apps in the zone add theirs on their next provision.",
        },
      ],
      [
        "a missing OpsCrew rule in a ruleset that is still there",
        (zone) => {
          const ruleset = zone.entrypoints.get(WAF);
          if (ruleset) ruleset.rules = [];
        },
        {
          title: `OpsCrew's rule "${BLOCK}" is missing from the zone's WAF custom rules`,
          detail:
            "`opscrew provision` creates it again with this app's hostnames (it shows the Cloudflare plan first); other OpsCrew apps in the zone add theirs on their next provision.",
        },
      ],
      [
        "a hostname of this app missing from a rule",
        (zone) => {
          const tls = rule(zone, CONFIG);
          tls.expression = String(tls.expression).replace("shop.example.com", "other.example.com");
        },
        {
          title: `shop.example.com is missing from OpsCrew's rule "${TLS}" in the zone's configuration rules`,
          detail:
            "This app added it there (its record says so). `opscrew provision` adds it back (it shows the Cloudflare plan first).",
        },
      ],
      [
        "a rule whose action was changed",
        (zone) => {
          rule(zone, WAF).action = "log";
        },
        {
          title:
            'OpsCrew\'s shared rule "OpsCrew: block probes for secrets and admin panels" in the zone\'s WAF custom rules was changed outside OpsCrew: its action is "log" instead of "block". OpsCrew does not overwrite it.',
          detail: expect.stringContaining("set it back to the action Block, turned on"),
        },
      ],
      [
        "a rule that was turned off",
        (zone) => {
          rule(zone, CONFIG).enabled = false;
        },
        {
          title:
            "OpsCrew's shared rule \"OpsCrew: verify the origin certificate (Full (strict) TLS)\" in the zone's configuration rules was changed outside OpsCrew: it is turned off. OpsCrew does not overwrite it.",
          detail: expect.stringContaining("set it back to turned on"),
        },
      ],
      [
        "a rule whose paths were changed",
        (zone) => {
          const block = rule(zone, WAF);
          block.expression = String(block.expression).replace(
            ' or http.request.uri.path contains "/phpmyadmin"',
            "",
          );
        },
        {
          title:
            "OpsCrew's shared rule \"OpsCrew: block probes for secrets and admin panels\" in the zone's WAF custom rules was changed outside OpsCrew: its expression is not the one OpsCrew writes. OpsCrew does not overwrite it.",
          detail: expect.stringContaining("or delete the rule so OpsCrew creates it again"),
        },
      ],
    ])("reports %s, read-only", async (_case, change, expected) => {
      const { s, zone } = await deployed();
      change(zone);
      const writes = zone.writes().length;

      const report = await runDrift(s.deps, { services: s.services });

      expect(report.cloudflareRules).toEqual([expected]);
      expect(report.clean).toBe(false);
      expect(zone.writes()).toHaveLength(writes);
      expect(s.handler.requests).toEqual([]);
      const text = renderDriftReport(report);
      expect(text).toContain(
        "OpsCrew's shared rules or the app's origin TLS in the Cloudflare zone differ from what this app's record lists (1):",
      );
      expect(text).toContain(`  ~ ${expected.title}`);
      expect(s.deps.audit.entries.at(-1)?.detail).toContain(
        "1 differences in OpsCrew's shared Cloudflare rules",
      );
    });

    const RUN_PROVISION =
      "`opscrew provision` puts it back (it shows the Cloudflare plan first, and the deploy brings the server what it needs).";

    it.each<[string, (zone: FakeZone) => void, CloudflareRuleDifference]>([
      [
        "a hostname's origin pull setting turned off",
        (zone) => {
          const setting = zone.hostnameAop.get("shop.example.com");
          if (setting) setting.enabled = null;
        },
        {
          title: "Authenticated Origin Pulls was turned off for shop.example.com outside OpsCrew",
          detail: `Cloudflare no longer presents the app's client certificate for shop.example.com, so the server refuses its requests and visitors get errors. ${RUN_PROVISION}`,
        },
      ],
      [
        "a hostname's origin pull setting using another certificate",
        (zone) => {
          const setting = zone.hostnameAop.get("shop.example.com");
          if (setting) setting.cert_id = "f".repeat(32);
        },
        {
          title:
            "Authenticated Origin Pulls for shop.example.com uses another client certificate than the app's",
          detail:
            "The server trusts only the app's own, so it refuses Cloudflare's requests for shop.example.com. Run `opscrew provision`: OpsCrew never takes a hostname from another certificate, so it stops and says how to free the hostname.",
        },
      ],
      [
        "an origin certificate revoked at Cloudflare",
        (zone) => {
          for (const certificate of zone.originCertificates) {
            certificate.revoked_at = "2026-10-21T10:00:00Z";
          }
        },
        {
          title:
            "The app's Cloudflare origin certificate for shop.example.com was revoked or deleted outside OpsCrew",
          detail: `Cloudflare no longer trusts the certificate the server presents, so visitors get errors. ${RUN_PROVISION}`,
        },
      ],
      [
        "the client certificate deleted at Cloudflare",
        (zone) => {
          zone.clientCertificates.splice(0);
        },
        {
          title:
            "The app's client certificate for Cloudflare's origin pulls was deleted outside OpsCrew",
          detail: `Cloudflare cannot present it, so the server refuses Cloudflare's requests and visitors get errors. ${RUN_PROVISION}`,
        },
      ],
    ])("reports %s, with how to put it back (FR-1408)", async (_case, change, expected) => {
      const { s, zone } = await deployed();
      const record = JSON.parse(await readFile(s.deps.paths.files.cloudflareRecord, "utf8"));
      expect(record.tls.client.enabled).toEqual(["shop.example.com"]);
      change(zone);
      const writes = zone.writes().length;

      const report = await runDrift(s.deps, { services: s.services });

      expect(report.cloudflareRules).toEqual([expected]);
      expect(report.clean).toBe(false);
      expect(zone.writes()).toHaveLength(writes);
      expect(renderDriftReport(report)).toContain(`  ~ ${expected.title}`);
    });

    it("does not report another app's hostnames in the zone, whatever their setting", async () => {
      const { s, zone } = await deployed();
      zone.hostnameAop.set("blog.example.com", {
        hostname: "blog.example.com",
        cert_id: "e".repeat(32),
        enabled: null,
      });
      zone.hostnameAop.set("api.example.com", {
        hostname: "api.example.com",
        cert_id: "f".repeat(32),
        enabled: true,
      });
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.cloudflareRules).toEqual([]);
      expect(report.clean).toBe(true);
    });

    it("says when the token may not read the app's origin TLS", async () => {
      const { s, zone } = await deployed();
      zone.denied.add("ssl");
      const report = await runDrift(s.deps, { services: s.services });
      expect(report.cloudflareRules).toEqual([
        {
          title: "OpsCrew could not read the app's origin TLS at Cloudflare",
          detail:
            "The Cloudflare token lacks Zone → SSL and Certificates → Edit for this zone. Give it that permission, then run `opscrew drift` again.",
        },
      ]);
    });

    it("stops on a damaged record", async () => {
      const { s } = await deployed();
      await writeFile(s.deps.paths.files.cloudflareRecord, '{"zoneId":"nope"}');
      const error = await runDrift(s.deps, { services: s.services }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).message).toContain("is damaged");
    });
  },
);
