/**
 * While a preview environment names dev's server (spec.md US9), no command of dev's puts anything
 * on that server's private network that a preview's containers could reach: `vpn add`, `vpn
 * grant`, an add-on or Portainer on. Removing a device stays allowed.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { addonEnable } from "../addons";
import { allocateNetwork } from "../network";
import { withNetwork } from "../network/__fixtures__/plans";
import { portainerEnable } from "../portainer";
import { createTestPhaseDeps, hostTestPlan, testKeyMaker, testKeyPair } from "../testing";
import { deviceConfigFile, vpnAdd, vpnGrant, vpnRemove } from "../vpn";
import { sharedPreviewProject } from "./__fixtures__/plan";

/** The refusal's words, as the previews' own refusal has them, for what dev's server would reach. */
const refusalOf = (reach: string, one = true) =>
  `dev's server is on a private network, and a preview's containers there could reach ${reach} without escaping anything: traffic within the server passes no firewall. Turn ${one ? "it" : "them"} off on dev first, or give the previews a server of their own. Nothing was changed.`;

/** dev's plan on its private network with the device laptop. */
function devWithLaptop(): DeployPlan {
  const plan = hostTestPlan();
  const { network } = allocateNetwork(plan, {}, testKeyMaker("shop-dev"));
  const prefix = network.range.split(".").slice(0, 3).join(".");
  const laptop = {
    name: "laptop",
    address: `${prefix}.100`,
    publicKey: testKeyPair("laptop").publicKey,
    addedAt: "2026-10-30T10:00:00.000Z",
  };
  return withNetwork(plan, { ...network, devices: [laptop] });
}

/** dev's plan on its private network, with no device. */
function devOnNetwork(): DeployPlan {
  const plan = hostTestPlan();
  return withNetwork(plan, allocateNetwork(plan, {}, testKeyMaker("shop-dev")).network);
}

/** The project with the previews on dev's server, dev's plan (`plan`), and deps for dev. */
async function devBesidePreviews(plan: DeployPlan = hostTestPlan()) {
  const project = await sharedPreviewProject();
  await writeArtifact("plan", project.host.files.plan, plan);
  const dev = await createTestPhaseDeps({
    root: project.root,
    environment: "dev",
    env: { OPSCREW_HOME: join(project.root, ".home-opscrew") },
  });
  const before = await readFile(dev.paths.files.plan, "utf8");
  /** True when dev's plan is as it was and nothing was asked to approve. */
  const unchanged = async () =>
    (await readFile(dev.paths.files.plan, "utf8")) === before &&
    (dev.approvalHandler as unknown as { requests: unknown[] }).requests.length === 0;
  return { dev, unchanged };
}

/** The services of a command that must never reach a server. */
const nowhere = {
  remote: async (): Promise<never> => {
    throw new Error("no server is reached in this test");
  },
};

/** The same for the commands whose shell comes synchronously. */
const nowhereNow = {
  remote: (): never => {
    throw new Error("no server is reached in this test");
  },
};

const HINT =
  "To put that on dev's server anyway, remove the previews of preview first with `opscrew destroy --env preview`;";

describe("dev's commands while previews run on its server (US9)", () => {
  it("vpn add refuses a device before any change", async () => {
    const { dev, unchanged } = await devBesidePreviews();
    const error = await vpnAdd(dev, "laptop", { services: nowhere }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: refusalOf("device laptop"),
      hint: expect.stringContaining(HINT),
    });
    expect(existsSync(deviceConfigFile(dev.paths, "laptop"))).toBe(false);
    expect(await unchanged()).toBe(true);
  });

  it("vpn grant refuses a service for a device before any change", async () => {
    const { dev, unchanged } = await devBesidePreviews(devWithLaptop());
    const error = await vpnGrant(dev, "laptop", "db", { services: nowhere }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: refusalOf("your device and db for device laptop", false),
      hint: expect.stringContaining("then run `opscrew vpn grant laptop db --env dev` again."),
    });
    expect(await unchanged()).toBe(true);
  });

  // Beszel's hub and Portainer's web UI go on the private address only for devices: on a network
  // without one, the command puts nothing there and goes on to the server.
  it.each([
    ["addon enable beszel", "Beszel's hub"],
    ["portainer enable", "Portainer's web UI"],
  ])(
    "%s refuses its dashboard beside a device before any change, and not on a network without one",
    async (command, dashboard) => {
      const run = async (plan: DeployPlan) => {
        const { dev, unchanged } = await devBesidePreviews(plan);
        const current = await readArtifact("plan", dev.paths.files.plan);
        const error = await (command === "portainer enable"
          ? portainerEnable(dev, { services: nowhereNow })
          : addonEnable(dev, current, "beszel", { services: nowhereNow })
        ).catch((e: unknown) => e);
        return { error, unchanged };
      };
      const beside = await run(devWithLaptop());
      expect(beside.error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: refusalOf(`your device and ${dashboard}`, false),
        hint: `${HINT} then run \`opscrew ${command} --env dev\` again.`,
      });
      expect(await beside.unchanged()).toBe(true);
      const alone = await run(devOnNetwork());
      expect(String((alone.error as Error | undefined)?.message)).not.toContain(
        "a preview's containers",
      );
    },
  );

  it("vpn remove is not refused: it takes the device off the network", async () => {
    const { dev } = await devBesidePreviews(devWithLaptop());
    const error = await vpnRemove(dev, "laptop", { services: nowhere }).catch((e: unknown) => e);
    // It goes on to the servers, which this test never reaches.
    expect(String((error as Error | undefined)?.message)).not.toContain("a preview's containers");
  });
});
