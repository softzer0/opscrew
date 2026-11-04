/** `opscrew retarget` with self-hosted monitoring on (feature 020, US7 #4, FR-2026). */
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { monitoredPlan, networked, senderPlan } from "../network/__fixtures__/plans";
import { createTestPhaseDeps } from "../testing";
import { startMove } from "./start";

/** The app alone on its server, with the stack there too (`--on app`). */
function onAppAlone() {
  const { servers: _none, ...base } = monitoredPlan({ on: "app" });
  return DeployPlanSchema.parse({
    ...base,
    services: base.services.map(({ server: _s, ...service }) => service),
  });
}

describe("startMove: an app with self-hosted monitoring on", () => {
  it.each([
    ["on its own monitoring server", () => networked(monitoredPlan()).plan],
    ["on the app's server, alone", onAppAlone],
    [
      "sending to another environment's",
      () => {
        const facts = {
          monitoring: { udpPortsInUse: [51820], wireguardInterfaces: ["wg-opscrew0"] },
        };
        return networked(senderPlan(), facts).plan;
      },
    ],
  ])(
    "refuses %s before any change or connection, with the commands that turn it off",
    async (_where, plan) => {
      const commands: string[] = [];
      const deps = await createTestPhaseDeps({
        runner: {
          async run(command) {
            commands.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      });

      const error = await startMove(deps, plan(), {}).catch((e: unknown) => e);

      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringMatching(
          /^Self-hosted monitoring is on for shop(-staging)?, .*retarget anywhere\. Nothing was changed\.$/,
        ),
        hint: "Turn it off first: run `opscrew addon disable monitoring` and then `opscrew provision`, then run `opscrew retarget` again. Turn monitoring on again once the move is finished.",
      });
      expect(commands).toEqual([]);
    },
  );
});
