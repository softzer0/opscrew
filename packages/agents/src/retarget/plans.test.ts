import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanSummary } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { SENSITIVE_VALUE } from "../provision";
import { savedPlanOf, writePlanSidecar } from "../provision/plan-apply";

describe("a move's saved plan sidecar", () => {
  it("never holds the prior state or a sensitive value in clear", async () => {
    const secret = fakeSecret("generic-password");
    const dir = await mkdtemp(join(tmpdir(), "opscrew-move-plan-"));
    const summary = {
      planHash: "a".repeat(64),
      planFile: join(dir, "x.tfplan"),
      dir,
      engine: "tofu",
      createdAt: "2026-10-14T00:00:00.000Z",
      changes: [],
      counts: { add: 0, change: 0, destroy: 1 },
      hasDestroy: true,
      planJson: {
        prior_state: { values: { outputs: { tunnel_token: { value: secret, sensitive: true } } } },
        resource_changes: [
          {
            address: "module.access.cloudflare_zero_trust_access_service_token.ssh",
            change: {
              actions: ["delete"],
              before: { client_secret: secret, name: "ssh" },
              after: null,
              before_sensitive: { client_secret: true },
              after_sensitive: false,
            },
          },
        ],
      },
    } as unknown as PlanSummary;
    await writePlanSidecar(new Redactor(), savedPlanOf(summary, []));
    const sidecar = await readFile(join(dir, "x.tfplan.json"), "utf8");
    expect(sidecar).not.toContain(secret);
    expect(sidecar).not.toContain("prior_state");
    expect(sidecar).toContain(SENSITIVE_VALUE);
  });
});
