import { describe, expect, it } from "vitest";
import { testPlan } from "./__fixtures__/plans";
import * as templates from "./index";
import { portainerTestPlan } from "./portainer-target/__fixtures__/plans";

const BUG = "This is a bug in OpsCrew: please report it with the command you ran.";

describe("target guards and move layouts (package root)", () => {
  const hetzner = testPlan().target;
  const droplet = testPlan({ provider: "digitalocean" }).target;
  const own = testPlan({ provider: "own" }).target;
  const portainer = portainerTestPlan().target;

  it("narrow a target to the one a step handles", () => {
    expect(templates.cloudTarget(hetzner)).toBe(hetzner);
    expect(templates.cloudTarget({ provider: "digitalocean" }).provider).toBe("digitalocean");
    expect(templates.portainerTarget(portainer)).toBe(portainer);
  });

  it("stop with one plain bug-in-OpsCrew error for any other target", () => {
    expect(() => templates.cloudTarget(own)).toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        message:
          "This step only applies to servers OpsCrew creates on Hetzner Cloud or DigitalOcean, not to a server you already own.",
        hint: BUG,
      }),
    );
    expect(() => templates.cloudTarget(portainer)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("not to an app in your existing Portainer"),
        hint: BUG,
      }),
    );
    expect(() => templates.portainerTarget(droplet)).toThrow(
      expect.objectContaining({
        code: "PHASE_PRECONDITION",
        message: "This step only applies to an app OpsCrew deploys into your existing Portainer.",
        hint: BUG,
      }),
    );
  });

  it("give every move layout both providers, in the order a move uses them", () => {
    expect(templates.MOVE_LAYOUTS).toEqual([
      "rename",
      "both",
      "switched",
      "finish",
      "abort-remove",
      "abort-rename",
    ]);
    for (const name of templates.MOVE_LAYOUTS) {
      expect(templates.moveLayout(name, hetzner, droplet).providers).toEqual([
        "hetzner",
        "digitalocean",
      ]);
    }
    expect(templates.moveLayout("both", hetzner, droplet)).toEqual({
      server: droplet,
      previous: hetzner,
      live: "server_previous",
      providers: ["hetzner", "digitalocean"],
    });
  });
});
