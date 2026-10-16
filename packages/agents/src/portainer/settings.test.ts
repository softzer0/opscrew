import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { testPlan } from "../testing";
import { PORTAINER_VERSION, portainerSettings, withPortainer } from "./settings";

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof OpsCrewError) return error.code;
    throw error;
  }
  return undefined;
}

const cloudflare = () => {
  const plan = testPlan({ domain: "shop.example.com", deployed: true });
  return { ...plan, dns: { ...plan.dns, zone: "example.com" } };
};

describe("portainerSettings", () => {
  it("is local-only and pinned by default", () => {
    expect(portainerSettings(testPlan(), {}, undefined)).toEqual({
      enabled: true,
      version: PORTAINER_VERSION,
      access: "local",
    });
    expect(PORTAINER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("expands a bare label to the zone and keeps the allowed emails", () => {
    expect(
      portainerSettings(
        cloudflare(),
        { subdomain: "Portainer", allowEmails: ["owner@example.com", " owner@example.com "] },
        "example.com",
      ),
    ).toEqual({
      enabled: true,
      version: PORTAINER_VERSION,
      access: "subdomain",
      hostname: "portainer.example.com",
      allowedEmails: ["owner@example.com"],
    });
  });

  it("needs at least one valid email for a subdomain", () => {
    expect(code(() => portainerSettings(cloudflare(), { subdomain: "p" }, "example.com"))).toBe(
      "INVALID_INPUT",
    );
    expect(
      code(() =>
        portainerSettings(cloudflare(), { subdomain: "p", allowEmails: ["nope"] }, "example.com"),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("refuses emails without a subdomain", () => {
    expect(
      code(() => portainerSettings(cloudflare(), { allowEmails: ["a@example.com"] }, "x")),
    ).toBe("INVALID_INPUT");
  });

  it("refuses a subdomain two levels below the zone, and suggests a one-level name", () => {
    let caught: unknown;
    try {
      portainerSettings(
        cloudflare(),
        { subdomain: "portainer.shop.example.com", allowEmails: ["a@example.com"] },
        "example.com",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpsCrewError);
    const error = caught as OpsCrewError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe(
      "Cloudflare's free certificate covers only example.com and *.example.com, so portainer.shop.example.com would fail HTTPS at Cloudflare's edge. Nothing was changed.",
    );
    expect(error.hint).toBe(
      "Use a name one level below example.com, for example `--subdomain portainer-shop.example.com`.",
    );
    for (const subdomain of ["portainer-shop", "portainer-shop.example.com"]) {
      expect(
        portainerSettings(
          cloudflare(),
          { subdomain, allowEmails: ["a@example.com"] },
          "example.com",
        ).hostname,
      ).toBe("portainer-shop.example.com");
    }
  });

  it("needs a Cloudflare domain for a subdomain", () => {
    expect(
      code(() =>
        portainerSettings(
          testPlan(),
          { subdomain: "p.example.com", allowEmails: ["a@b.co"] },
          undefined,
        ),
      ),
    ).toBe("PHASE_PRECONDITION");
  });
});

describe("withPortainer", () => {
  it("refuses the app's own domain or a host outside the zone", () => {
    const plan = cloudflare();
    for (const hostname of ["shop.example.com", "portainer.other.org"]) {
      const settings = {
        enabled: true,
        version: PORTAINER_VERSION,
        access: "subdomain" as const,
        hostname,
        allowedEmails: ["a@example.com"],
      };
      expect(code(() => withPortainer(plan, settings))).toBe("INVALID_INPUT");
    }
  });

  it("refuses a hostname two levels below the zone with the same reason", () => {
    const settings = {
      enabled: true,
      version: PORTAINER_VERSION,
      access: "subdomain" as const,
      hostname: "portainer.shop.example.com",
      allowedEmails: ["a@example.com"],
    };
    expect(() => withPortainer(cloudflare(), settings)).toThrow(
      "so portainer.shop.example.com would fail HTTPS at Cloudflare's edge",
    );
  });

  it("sets and removes the settings", () => {
    const on = withPortainer(cloudflare(), portainerSettings(cloudflare(), {}, "example.com"));
    expect(on.portainer?.enabled).toBe(true);
    expect(withPortainer(on, undefined).portainer).toBeUndefined();
  });
});
