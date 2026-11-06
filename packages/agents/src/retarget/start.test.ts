import type { DesignOption } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { createTestPhaseDeps, testKeyMaker } from "../testing";
import { startMove, targetOf } from "./start";

/** A design option on `provider`, as design builds them. */
function option(provider: DesignOption["target"]["provider"]): DesignOption {
  return {
    id: `${provider}-option`,
    title: "An option",
    summary: "A server for the app.",
    target: {
      provider,
      location: "nbg1",
      serverType: "cpx22",
      vcpus: 2,
      memoryGb: 4,
      diskGb: 80,
      cpuType: "shared",
      architecture: "x86",
    },
    services: [],
    externalServices: [],
    backups: true,
    cost: {
      monthly: { amount: 7.99, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount: 7.99, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-10-23T00:00:00.000Z",
    },
    fitsBudget: true,
    recommended: true,
    tradeoffs: [],
  };
}

describe("targetOf: the new target of a move", () => {
  it("is the chosen server, with the provider's default image and the old proxy", () => {
    expect(targetOf(option("hetzner"), "nginx")).toEqual({
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cpx22",
      image: "ubuntu-24.04",
      backups: true,
      edge: "nginx",
    });
  });
});

describe("startMove: an app with a private network", () => {
  it("refuses while public SSH is closed, before any change or connection", async () => {
    const commands: string[] = [];
    const deps = await createTestPhaseDeps({
      runner: {
        async run(command) {
          commands.push(command);
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });
    const { servers: _none, ...base } = splitPlan();
    const single = {
      ...base,
      services: base.services.map(({ server: _s, ...service }) => service),
    };
    const { network } = allocateNetwork(single, {}, testKeyMaker());
    const plan = withNetwork(single, { ...network, publicSsh: false });
    const error = await startMove(deps, plan, {}).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("Public SSH is closed"),
      hint: expect.stringContaining("`opscrew secure --open-public-ssh`"),
    });
    expect(commands).toEqual([]);
  });
});
