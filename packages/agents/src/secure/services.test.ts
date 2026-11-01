import { serviceSpec } from "@opscrew/iac-templates";
import { DeployPlanSchema, type SelfHostedServiceKind } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../verify/__fixtures__/plan";
import { serviceCheckInputs } from "./services";

/** The app's plan with one service of `kind` named `name`, with `options`. */
function planWith(kind: SelfHostedServiceKind, name: string, options: object) {
  const spec = serviceSpec(kind);
  const base = testPlan();
  return DeployPlanSchema.parse({
    ...base,
    services: [
      ...base.services,
      {
        name,
        kind,
        version: spec.defaultVersion,
        memoryMb: spec.memory.defaultMb,
        options,
        reason: "The app uses it.",
        licence: spec.licence.id,
      },
    ],
  });
}

describe("serviceCheckInputs: the login variables follow the service's login", () => {
  it("checks the login of a Kafka or Redpanda that has one, and of OpenSearch", () => {
    const login = (kind: SelfHostedServiceKind, options: object) =>
      serviceCheckInputs(planWith(kind, "data", options)).find((s) => s.name === "data")?.login;
    expect(login("kafka", {})).toEqual([]);
    expect(login("redpanda", {})).toEqual([]);
    expect(login("kafka", { login: true })).toEqual(["SASL_PASSWORD"]);
    expect(login("redpanda", { login: true })).toEqual(["RPK_PASS"]);
    expect(login("opensearch", {})).toEqual(["OPENSEARCH_PASSWORD"]);
  });
});
