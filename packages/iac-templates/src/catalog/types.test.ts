import type { SelfHostedServiceKind } from "@opscrew/plan-schema";
import { describe, expectTypeOf, it } from "vitest";
import {
  type DatabaseSettings,
  type GeneratedSecret,
  type ImagePinKey,
  type ServiceContext,
  type ServiceSpec,
  splitDatabaseSettings,
} from "../index";

describe("the service catalog's types", () => {
  it("describe a service as the contract does, from the package root", () => {
    expectTypeOf<ServiceSpec["kind"]>().toEqualTypeOf<SelfHostedServiceKind>();
    expectTypeOf<ServiceSpec["image"]>().toEqualTypeOf<ImagePinKey>();
    expectTypeOf<"valkey">().toExtend<ImagePinKey>();
    expectTypeOf<ServiceSpec["secrets"]>().toEqualTypeOf<GeneratedSecret[]>();
    expectTypeOf<ServiceSpec["targets"]>().toEqualTypeOf<("server" | "portainer")[]>();
    expectTypeOf<ServiceContext["service"]["name"]>().toEqualTypeOf<string>();
    expectTypeOf<ServiceSpec["address"]>().parameter(0).toEqualTypeOf<ServiceContext>();
    expectTypeOf<ServiceSpec["conventionalVariables"]>()
      .parameter(0)
      .toEqualTypeOf<ServiceContext>();
  });

  it("give agents a SQL database's split settings from the package root", () => {
    expectTypeOf(splitDatabaseSettings).parameter(0).toEqualTypeOf<ServiceContext>();
    expectTypeOf(splitDatabaseSettings).returns.toEqualTypeOf<DatabaseSettings | undefined>();
    expectTypeOf<keyof DatabaseSettings>().toEqualTypeOf<
      "host" | "port" | "database" | "user" | "password"
    >();
  });
});
