import { cloudTarget, MOVE_LAYOUTS, moveLayout, renderDeployment } from "@opscrew/iac-templates";
import type { CloudProvider } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../testing";
import { previousTarget, protectionVariable } from "./layouts";

const DIRECTIONS: [CloudProvider, CloudProvider][] = [
  ["hetzner", "digitalocean"],
  ["digitalocean", "hetzner"],
];

function rendered(from: CloudProvider, to: CloudProvider, name: (typeof MOVE_LAYOUTS)[number]) {
  const plan = testPlan({ provider: to });
  const files = renderDeployment(plan, {
    opscrewVersion: "0.0.0-test",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyOnly opscrew-test",
    layout: moveLayout(name, testPlan({ provider: from }).target, plan.target),
  });
  const text = (path: string) => files.find((f) => f.path.endsWith(path))?.content ?? "";
  return { main: text("prod/main.tf"), variables: text("prod/variables.tf") };
}

describe("move layouts", () => {
  it.each(DIRECTIONS)("render the modules each step of a move %s → %s needs", (from, to) => {
    const modules = (name: (typeof MOVE_LAYOUTS)[number]) =>
      [...rendered(from, to, name).main.matchAll(/module "(server\w*)"/g)].map((m) => m[1]);
    expect(modules("rename")).toEqual(["server_previous"]);
    expect(modules("both")).toEqual(["server", "server_previous"]);
    expect(modules("switched")).toEqual(["server", "server_previous"]);
    expect(modules("finish")).toEqual(["server"]);
    expect(modules("abort-remove")).toEqual(["server_previous"]);
    expect(modules("abort-rename")).toEqual(["server"]);
    expect(rendered(from, to, "rename").main).toContain("from = module.server\n");
    expect(rendered(from, to, "abort-rename").main).toContain("from = module.server_previous\n");
  });

  it.each(
    DIRECTIONS.flatMap(([from, to]) => MOVE_LAYOUTS.map((name) => [from, to, name] as const)),
  )("%s → %s, %s: only declared protection variables are ever passed", (from, to, name) => {
    const layout = moveLayout(
      name,
      testPlan({ provider: from }).target,
      testPlan({ provider: to }).target,
    );
    const { variables } = rendered(from, to, name);
    for (const module of ["server", "server_previous"] as const) {
      const variable = protectionVariable(layout, module);
      const expected = module === "server" ? "delete_protection" : "previous_delete_protection";
      expect(variables.includes(`variable "${expected}"`)).toBe(variable !== undefined);
      if (variable !== undefined) expect(variable).toBe(expected);
    }
  });

  it("protection variables exist only for Hetzner servers", () => {
    const hetzner = testPlan({ provider: "hetzner" }).target;
    const droplet = testPlan({ provider: "digitalocean" }).target;
    expect(protectionVariable(moveLayout("switched", hetzner, droplet), "server_previous")).toBe(
      "previous_delete_protection",
    );
    expect(protectionVariable(moveLayout("switched", hetzner, droplet), "server")).toBeUndefined();
    expect(protectionVariable(moveLayout("both", droplet, hetzner), "server")).toBe(
      "delete_protection",
    );
    expect(
      protectionVariable(moveLayout("finish", hetzner, droplet), "server_previous"),
    ).toBeUndefined();
  });

  it("fills the old server's image when the plan omits it", () => {
    const { image: _image, ...target } = cloudTarget(testPlan({ provider: "digitalocean" }).target);
    expect(previousTarget({ from: { target } }).image).toBe("ubuntu-24-04-x64");
  });
});
