import type { PortainerAccess } from "@opscrew/agents";
import { describe, expect, it } from "vitest";
import { createTestContext } from "../test-context";
import { withDeployServices } from "./deploy-services";
import { portainerAccessFor } from "./portainer";

const FINGERPRINT = `SHA256:${Array.from({ length: 32 }, () => "AB").join(":")}`;

/** A fake Portainer that prints what it is asked (through the context's redactor). */
function context() {
  const ctx = createTestContext();
  const access: PortainerAccess = {
    fetchCertificateFingerprint: async (url) => {
      ctx.stdout(`reading the certificate of ${url}`);
      return FINGERPRINT;
    },
    listEnvironments: async (url) => {
      ctx.stdout(`listing ${url}`);
      return [];
    },
  };
  return withDeployServices(ctx, { portainerAccess: access });
}

describe("portainerAccessFor", () => {
  it("with the host `nas`, hides the address before anything is sent", async () => {
    const ctx = context();
    const access = portainerAccessFor(ctx);
    await access.fetchCertificateFingerprint("https://nas:9443");
    await access.listEnvironments("https://nas:9443", "x".repeat(20), FINGERPRINT);
    ctx.stdout("Answer portainer.url; stack opscrew-shop-nas-tunnel on NAS:9000.");
    expect(ctx.out.join("\n")).toBe(
      [
        "reading the certificate of [REDACTED:portainer-address]",
        "listing [REDACTED:portainer-address]",
        "Answer portainer.url; stack opscrew-shop-nas-tunnel on [REDACTED:portainer-address]:9000.",
      ].join("\n"),
    );
  });

  it("with the host `portainer`, never garbles stack names, question ids or prose", async () => {
    const ctx = context();
    await portainerAccessFor(ctx).fetchCertificateFingerprint("https://portainer:9443");
    ctx.stdout(
      "Your Portainer at https://portainer:9443 runs opscrew-shop-portainer-tunnel; answer portainer.environment.",
    );
    expect(ctx.out.join("\n")).toBe(
      [
        "reading the certificate of [REDACTED:portainer-address]",
        "Your Portainer at [REDACTED:portainer-address] runs opscrew-shop-portainer-tunnel; answer portainer.environment.",
      ].join("\n"),
    );
  });
});
