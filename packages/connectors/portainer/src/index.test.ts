import { describe, expect, it } from "vitest";
import * as portainer from "./index";

describe("@opscrew/connector-portainer", () => {
  it("loads as a module (the adapter itself comes with T1002)", () => {
    expect(typeof portainer).toBe("object");
  });
});
