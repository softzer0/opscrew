import type { SelfHostedServiceKind } from "@opscrew/plan-schema";
import { describe, expectTypeOf, it } from "vitest";
import type { GeneratedSecret, ImagePinKey, ServiceContext, ServiceSpec } from "../index";

describe("the service catalog's types", () => {
  it("describe a service as the contract does, from the package root", () => {
    expectTypeOf<ServiceSpec["kind"]>().toEqualTypeOf<SelfHostedServiceKind>();
    expectTypeOf<ServiceSpec["auth"]>().toEqualTypeOf<
      "password" | "token" | "key" | "internal-only"
    >();
    expectTypeOf<ServiceSpec["image"]>().toEqualTypeOf<ImagePinKey>();
    expectTypeOf<"valkey">().toExtend<ImagePinKey>();
    expectTypeOf<ServiceSpec["secrets"]>().toEqualTypeOf<GeneratedSecret[]>();
    expectTypeOf<ServiceSpec["targets"]>().toEqualTypeOf<("server" | "portainer")[]>();
    expectTypeOf<ServiceContext["service"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<ServiceSpec["appVariables"]>().parameter(0).toEqualTypeOf<ServiceContext>();
  });
});
