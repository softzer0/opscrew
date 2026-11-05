import { FAKE_ZONE_ID, FakeZone } from "@opscrew/connector-cloudflare/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { appZoneDrift } from "../drift/previews";
import {
  appZonePreviewTestPlan,
  BELOW_ZONE,
  certificateCloudflare,
  createTestPhaseDeps,
  type FakeCertificates,
  PREVIEW_ZONE,
  previewTestPlan,
} from "../testing";
import {
  acmStaysOn,
  appZoneChecks,
  appZoneDomain,
  appZoneWarning,
  PACK_WAIT_MS,
  waitForPreviewsPack,
} from "./app-zone";

/** A clock that only `sleep` moves, and the sleeps it was asked for. */
function fakeTime() {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
  };
}

const PROVISION = "opscrew provision --env preview";

describe("previews below the app's zone", () => {
  it("are the previews whose domain is a name below the plan's zone", () => {
    expect(appZoneDomain(appZonePreviewTestPlan())).toBe(BELOW_ZONE);
    expect(appZoneDomain(previewTestPlan())).toBeUndefined();
  });

  it("warns of ACM's cost, with no price, and of the cookies previews share", () => {
    const warning = appZoneWarning(BELOW_ZONE, PREVIEW_ZONE);
    expect(warning).toContain("Advanced Certificate Manager");
    expect(warning).toContain("a paid add-on");
    expect(warning).not.toMatch(/[$€]\s?\d/);
    expect(warning).toContain(`Domain=${PREVIEW_ZONE}`);
    expect(warning).toContain("a pull request's code can read it");
    expect(acmStaysOn(PREVIEW_ZONE)).toContain(
      `Advanced Certificate Manager stays on for ${PREVIEW_ZONE}`,
    );
  });

  describe("provision's wait for the previews' pack", () => {
    it("polls, read-only, until the pack is active", async () => {
      const deps = await createTestPhaseDeps();
      const { client, reads } = certificateCloudflare(new FakeZone(), {
        statuses: [undefined, "pending_validation", "pending_issuance", "active"],
      });
      const time = fakeTime();
      const active = await waitForPreviewsPack(
        deps,
        client,
        { zoneId: FAKE_ZONE_ID, domain: BELOW_ZONE, verifyCommand: "opscrew verify --env preview" },
        time,
      );
      expect(active).toBe(true);
      expect(reads.packs).toBe(4);
      expect(time.slept).toEqual([15_000, 15_000, 15_000]);
      const said = deps.reporter.text();
      expect(said).toContain(
        `Waiting for Cloudflare to issue the previews' certificate for *.${BELOW_ZONE} (up to 10 minutes)`,
      );
      expect(said).toContain(`Cloudflare's certificate for *.${BELOW_ZONE} is active.`);
    });

    it("stops after 10 minutes on its clock, saying previews answer once it is issued and verify shows when", async () => {
      const deps = await createTestPhaseDeps();
      const { client } = certificateCloudflare(new FakeZone(), { statuses: ["pending_issuance"] });
      const time = fakeTime();
      const active = await waitForPreviewsPack(
        deps,
        client,
        {
          zoneId: FAKE_ZONE_ID,
          domain: BELOW_ZONE,
          verifyCommand: "opscrew verify --env preview",
        },
        time,
      );
      expect(active).toBe(false);
      expect(time.now()).toBe(PACK_WAIT_MS);
      expect(deps.reporter.text()).toContain(
        `Cloudflare has not issued the previews' certificate for *.${BELOW_ZONE} yet (pending_issuance): previews answer once Cloudflare issues it, and \`opscrew verify --env preview\` shows when.`,
      );
    });

    it("says so and returns when Cloudflare refuses the read, the apply being done", async () => {
      const deps = await createTestPhaseDeps();
      const { client, reads } = certificateCloudflare(new FakeZone(), {
        packsFail: { status: 403, message: "Authentication error" },
      });
      const time = fakeTime();
      const active = await waitForPreviewsPack(
        deps,
        client,
        { zoneId: FAKE_ZONE_ID, domain: BELOW_ZONE, verifyCommand: "opscrew verify --env preview" },
        time,
      );
      expect(active).toBe(false);
      expect(reads.packs).toBe(1);
      expect(time.slept).toEqual([]);
      const said = deps.reporter.text();
      expect(said).toContain(
        `OpsCrew could not read the previews' certificate for *.${BELOW_ZONE} at Cloudflare (`,
      );
      expect(said).toContain(
        "previews answer once Cloudflare issues it, and `opscrew verify --env preview` shows when.",
      );
      expect(said).not.toContain(fakeSecret("cloudflare-token", "certificates"));
    });

    it("asks nothing more when the pack is active already", async () => {
      const deps = await createTestPhaseDeps();
      const { client, reads } = certificateCloudflare(new FakeZone());
      const time = fakeTime();
      await waitForPreviewsPack(
        deps,
        client,
        {
          zoneId: FAKE_ZONE_ID,
          domain: BELOW_ZONE,
          verifyCommand: "opscrew verify --env preview",
        },
        time,
      );
      expect(reads.packs).toBe(1);
      expect(time.slept).toEqual([]);
      expect(deps.reporter.text()).not.toContain("Waiting for Cloudflare");
    });
  });

  describe("verify's and drift's checks", () => {
    it("pass with the pack active and Total TLS off", async () => {
      const { client } = certificateCloudflare(new FakeZone());
      const checks = await appZoneChecks(client, appZonePreviewTestPlan(), PROVISION);
      expect(checks.map((c) => [c.id, c.status])).toEqual([
        ["previews-certificate", "pass"],
        ["previews-total-tls", "pass"],
      ]);
    });

    type Case = [string, FakeCertificates, string, string, string | undefined];
    const WAIT = "Check again in a few minutes.";
    /** The fix of a pack that ended: delete it in the dashboard, then provision orders a new one. */
    const DELETE_IT = `Delete it in the Cloudflare dashboard (${PREVIEW_ZONE} → SSL/TLS → Edge Certificates), then run \`${PROVISION}\`: it orders a new one (it shows the plan first).`;
    const notYet = (status: string) =>
      `Cloudflare has not issued the certificate for *.${BELOW_ZONE} yet (${status}): previews answer once it does.`;
    const ended = (status: string) =>
      `The certificate for *.${BELOW_ZONE} is ${status}, so Cloudflare can't serve previews.`;
    it.each<Case>([
      ...[
        "initializing",
        "pending_validation",
        "pending_issuance",
        "pending_deployment",
        "holding_deployment",
        "staging_deployment",
      ].map(
        (status): Case => [
          `a pack ${status}`,
          { statuses: [status] },
          "warn",
          notYet(status),
          WAIT,
        ],
      ),
      [
        "no pack",
        { statuses: [undefined] },
        "fail",
        `${PREVIEW_ZONE} has no advanced certificate for *.${BELOW_ZONE}, so Cloudflare can't serve previews.`,
        `Run \`${PROVISION}\`: it orders the certificate again (it shows the plan first).`,
      ],
      ...["validation_timed_out", "issuance_timed_out", "expired", "deleted"].map(
        (status): Case => [
          `a pack ${status}`,
          { statuses: [status] },
          "fail",
          ended(status),
          DELETE_IT,
        ],
      ),
      [
        "a deleted old pack beside a new one pending validation",
        { older: ["deleted"], statuses: ["pending_validation"] },
        "warn",
        notYet("pending_validation"),
        WAIT,
      ],
      [
        "an active pack beside a new one pending issuance",
        { older: ["active"], statuses: ["pending_issuance"] },
        "pass",
        `Cloudflare serves previews with the advanced certificate for *.${BELOW_ZONE}.`,
        undefined,
      ],
    ])("report %s with its fix", async (_case, certificates, status, message, remediation) => {
      const { client } = certificateCloudflare(new FakeZone(), certificates);
      const [pack] = await appZoneChecks(client, appZonePreviewTestPlan(), PROVISION);
      expect(pack).toMatchObject({ id: "previews-certificate", status, message });
      expect(pack?.remediation).toBe(remediation);
    });

    it("fail with Total TLS on, with the dashboard's steps", async () => {
      const { client } = certificateCloudflare(new FakeZone(), { totalTls: true });
      const [, tls] = await appZoneChecks(client, appZonePreviewTestPlan(), PROVISION);
      expect(tls).toMatchObject({
        id: "previews-total-tls",
        status: "fail",
        remediation: `Turn Total TLS off in the Cloudflare dashboard (${PREVIEW_ZONE} → SSL/TLS → Edge Certificates).`,
      });
    });

    it("drift lists what is not as set up, and nothing for previews in a zone of their own", async () => {
      const deps = await createTestPhaseDeps({ environment: "preview" });
      const zone = new FakeZone();
      const { client } = certificateCloudflare(zone, { totalTls: true, statuses: ["expired"] });
      const plan = appZonePreviewTestPlan();
      const differences = await appZoneDrift(deps, plan, { sharedCloudflare: client });
      expect(differences).toEqual([
        {
          title: `The certificate for *.${BELOW_ZONE} is expired, so Cloudflare can't serve previews.`,
          detail: expect.stringContaining("then run `opscrew provision"),
        },
        expect.objectContaining({ title: expect.stringContaining("Total TLS is on") }),
      ]);
      const own = await appZoneDrift(deps, previewTestPlan(), { sharedCloudflare: client });
      expect(own).toEqual([]);
      // Read-only: only GETs reached Cloudflare.
      expect(zone.calls.filter((call) => call.method !== "GET")).toEqual([]);
    });
  });
});
