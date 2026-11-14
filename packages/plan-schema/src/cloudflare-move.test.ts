// Feature 028: the move's record, `plan.cloudflareMove`, while an app's zone moves to another
// Cloudflare account (T2803, ADR 0032).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, expectTypeOf, it } from "vitest";
import { previewPlanOf } from "./__fixtures__/preview-plan";
import {
  CloudflareIdSchema,
  type CloudflareMove,
  DeployPlanSchema,
  parseArtifact,
  serializeArtifact,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);

/** A Cloudflare account or zone id, made up at runtime. */
const id = () => randomBytes(16).toString("hex");

/** The fixture's plan (zone `example.com`), with `extra` in its move's record. */
async function moving(extra: Record<string, unknown> = {}) {
  const text = await readFile(new URL("plan.yaml", FIXTURES), "utf8");
  const plan = parseArtifact("plan", text, "fixture");
  return {
    ...plan,
    cloudflareMove: {
      zone: "example.com",
      from: { accountId: id(), zoneId: id() },
      to: { accountId: id() },
      dsAtStart: false,
      step: "started",
      startedAt: plan.createdAt,
      ...extra,
    },
  };
}

function issues(result: ReturnType<typeof DeployPlanSchema.safeParse>) {
  expect(result.success).toBe(false);
  return result.error?.issues.map((i) => ({ path: i.path.join("."), message: i.message })) ?? [];
}

describe("plan.cloudflareMove", () => {
  it("parses every step of the record and round-trips it", async () => {
    const started = DeployPlanSchema.parse(await moving());
    expectTypeOf(started.cloudflareMove).toEqualTypeOf<CloudflareMove | undefined>();
    expect(started.cloudflareMove?.to.zoneId).toBeUndefined();
    expect(parseArtifact("plan", serializeArtifact("plan", started), "plan.yaml")).toEqual(started);
    const adopted = DeployPlanSchema.parse(
      await moving({
        to: { accountId: id(), zoneId: id() },
        dsAtStart: true,
        step: "adopted",
        preparedAt: "2026-11-20T10:40:00Z",
        adoptedAt: "2026-11-21T09:10:00Z",
      }),
    );
    expect(adopted.cloudflareMove?.step).toBe("adopted");
    expect(parseArtifact("plan", serializeArtifact("plan", adopted), "plan.yaml")).toEqual(adopted);
    for (const step of ["started", "prepared"] as const) {
      for (const abortStep of ["started", "removed"] as const) {
        const parsed = DeployPlanSchema.parse(await moving({ step, abort: { step: abortStep } }));
        expect(parsed.cloudflareMove?.abort).toEqual({ step: abortStep });
      }
    }
  });

  it("takes only 32 lower-case hex characters as an id", () => {
    expect(CloudflareIdSchema.safeParse(id()).success).toBe(true);
    for (const bad of [id().toUpperCase(), id().slice(1), `${id()}0`, "z".repeat(32)]) {
      expect(CloudflareIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("is strict: no other field, such as a token, in the record", async () => {
    const parsed = DeployPlanSchema.safeParse(await moving({ token: "x" }));
    expect(issues(parsed).map((i) => i.path)).toEqual(["cloudflareMove"]);
    const nested = DeployPlanSchema.safeParse(
      await moving({ to: { accountId: id(), apiToken: "x" } }),
    );
    expect(issues(nested).map((i) => i.path)).toEqual(["cloudflareMove.to"]);
  });

  it("refuses the same account on both sides", async () => {
    const accountId = id();
    const parsed = DeployPlanSchema.safeParse(
      await moving({ from: { accountId, zoneId: id() }, to: { accountId } }),
    );
    expect(issues(parsed)).toEqual([
      {
        path: "cloudflareMove.to.accountId",
        message:
          "must differ from cloudflareMove.from.accountId: the zone moves to another Cloudflare account",
      },
    ]);
  });

  it("refuses an abort once the environment is adopted", async () => {
    const parsed = DeployPlanSchema.safeParse(
      await moving({ step: "adopted", abort: { step: "started" } }),
    );
    expect(issues(parsed)).toEqual([
      {
        path: "cloudflareMove.abort",
        message:
          'can be present only while cloudflareMove.step is "started" or "prepared": once the new account has taken the app over, the move can only be finished',
      },
    ]);
  });

  it("refuses a zone other than dns.zone, and takes any zone when the plan names none", async () => {
    const parsed = DeployPlanSchema.safeParse(await moving({ zone: "example.org" }));
    expect(issues(parsed)).toEqual([
      {
        path: "cloudflareMove.zone",
        message:
          "must be example.com, the plan's dns.zone: only the app's own Cloudflare zone moves",
      },
    ]);
    const plan = await moving({ zone: "example.com" });
    const { zone: _zone, ...dns } = plan.dns;
    expect(DeployPlanSchema.safeParse({ ...plan, dns }).error?.issues).toBeUndefined();
  });

  it("refuses the record beside a move to another target", async () => {
    const plan = await moving();
    const parsed = DeployPlanSchema.safeParse({
      ...plan,
      retarget: { from: { target: plan.target }, step: "started", startedAt: plan.createdAt },
    });
    expect(issues(parsed)).toEqual([
      {
        path: "cloudflareMove",
        message:
          "can't be present beside retarget: finish or abort the move to another target first (opscrew retarget --finish or --abort), then move the app's zone",
      },
    ]);
  });

  it("refuses the record in a preview environment's plan", async () => {
    const plan = DeployPlanSchema.parse(await moving());
    const preview = previewPlanOf(plan);
    const parsed = DeployPlanSchema.safeParse({
      ...preview,
      cloudflareMove: { ...plan.cloudflareMove, zone: preview.dns.zone },
    });
    expect(issues(parsed)).toEqual([
      {
        path: "cloudflareMove",
        message:
          "can't be present in a preview environment's plan: previews don't move with the zone; turn previews off before the move, and on again after it",
      },
    ]);
  });
});
