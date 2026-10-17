import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  applyStackPlan,
  fetchCertificateFingerprint,
  inspectPortainer,
  opscrewNames,
  opscrewStackNames,
  PORTAINER_TOKEN_STEPS,
  planStacks,
  planStackTeardown,
  portainerClient,
  stackPlanHash,
  valueFingerprint,
  valueFingerprints,
} from "./index";
import { composeVariables } from "./plan";

describe("@opscrew/connector-portainer", () => {
  it("exports the contract's functions from the package root", () => {
    for (const fn of [
      fetchCertificateFingerprint,
      portainerClient,
      valueFingerprint,
      valueFingerprints,
      inspectPortainer,
      planStacks,
      planStackTeardown,
      stackPlanHash,
      applyStackPlan,
    ]) {
      expect(typeof fn).toBe("function");
    }
  });

  it("says where the access token is created, for callers to say where it goes", () => {
    expect(PORTAINER_TOKEN_STEPS).toBe(
      "In Portainer, open your user menu → My account → Access tokens and add a token (for an administrator, or for a user who may manage stacks on the environment)",
    );
  });

  it("names everything OpsCrew creates opscrew-<app>…", () => {
    expect(opscrewNames("shop")).toEqual({
      app: "opscrew-shop",
      updater: "opscrew-shop-updater",
      tunnelConnector: "opscrew-shop-portainer-tunnel",
      registry: "opscrew-shop",
    });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation under test.
    const compose = "a: ${A}\nb: $${NOT}\nc: ${C:-x}\nd: $D\n";
    expect(composeVariables(compose)).toEqual(["A", "C", "D"]);
  });

  it("accepts plan-schema's app names: 41 characters, a trailing dash", () => {
    const long = "a".repeat(41);
    expect(opscrewNames(long).tunnelConnector).toBe(`opscrew-${long}-portainer-tunnel`);
    expect(opscrewNames("shop-").updater).toBe("opscrew-shop--updater");
    // The longest name is still one inspectPortainer accepts.
    expect(opscrewStackNames(long)).toHaveLength(3);
    for (const bad of ["a".repeat(42), "Shop", "-shop", ""]) {
      let error: unknown;
      try {
        opscrewNames(bad);
      } catch (caught) {
        error = caught;
      }
      expect(error, bad).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
      expect((error as OpsCrewError).hint).toMatch(/1 to 41 lower-case letters/);
    }
  });
});
