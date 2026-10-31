import { mkdir, writeFile } from "node:fs/promises";
import { type HostPlan, hostPlanHash } from "@opscrew/connector-ssh-host";
import { describe, expect, it } from "vitest";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { hostPlanFile, keepServerSetup, updateServerAddresses, writeKnownHost } from "../shared";
import { createTestPhaseDeps, HOST_KEY, ScriptedRunner, testKeyMaker } from "../testing";
import { moveShell } from "./shells";

const DATA_IPV4 = "203.0.113.20";

/**
 * A split plan with public SSH closed, whose extra server `data` is the user's own: its router
 * forwards the public port 2222 to sshd's 22, as its last setup found. Its host key is pinned at
 * its public address; `thisDevice` makes this computer a device on the network.
 */
async function closedWorld(runner: ScriptedRunner, thisDevice?: string) {
  const base = splitPlan({ data: "own" });
  const { network } = allocateNetwork(
    base,
    { data: { udpPortsInUse: [], wireguardInterfaces: [] } },
    testKeyMaker(),
  );
  const plan = withNetwork(base, { ...network, publicSsh: false });
  const prefix = network.range.split(".").slice(0, 3).join(".");
  const deps = await createTestPhaseDeps({ runner });
  await updateServerAddresses(deps.paths, () => ({
    schemaVersion: 1,
    deployment: { ipv4: "203.0.113.10" },
    servers: { data: { ipv4: DATA_IPV4 } },
    ownServers: { data: { host: DATA_IPV4, port: 2222, user: "admin", agent: true } },
    ...(thisDevice !== undefined ? { thisDevice } : {}),
  }));
  const [type = "", key = ""] = HOST_KEY.split(" ");
  await writeKnownHost(deps.paths.files.knownHosts, `[${DATA_IPV4}]:2222`, [{ type, key }]);
  const setup: HostPlan = {
    schemaVersion: 1,
    purpose: "setup",
    app: plan.app.name,
    steps: [
      {
        id: "ufw",
        title: "Firewall",
        state: "in-place",
        scope: "shared",
        params: { sshPorts: "22" },
      },
    ],
    findings: [],
  };
  await mkdir(deps.paths.files.plansDir, { recursive: true });
  await writeFile(hostPlanFile(deps.paths, hostPlanHash(setup)), JSON.stringify(setup));
  await keepServerSetup(deps, "data", hostPlanHash(setup));
  return { plan, deps, prefix };
}

describe("moveShell", () => {
  it("reaches deploy on an own server at its private address and sshd's port once public SSH is closed", async () => {
    const runner = new ScriptedRunner();
    const { plan, deps, prefix } = await closedWorld(runner);
    const shell = await moveShell(deps, plan, {}, "data");
    await shell.remote.run("true");
    const args = runner.calls.at(-1)?.args ?? [];
    expect(args).toContain(`deploy@${prefix}.2`);
    expect(args[args.indexOf("-p") + 1]).toBe("22");
    expect(args[args.indexOf("-i") + 1]).toBe(deps.paths.files.deployKey);
    // The copy of a dump (`scp -3`) goes to the same address and port.
    expect(shell.remote.host).toBe(`${prefix}.2`);
    expect(shell.port).toBe(22);
  });

  it("says this computer's tunnel looks down when the server does not answer over it", async () => {
    const offline = new ScriptedRunner(() => ({
      exitCode: 255,
      stdout: "",
      stderr: "ssh: connect to host 10.200.0.2 port 22: Connection timed out\r\n",
    }));
    const { plan, deps } = await closedWorld(offline, "laptop");
    const shell = await moveShell(deps, plan, {}, "data");
    await expect(shell.remote.run("true")).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: expect.stringContaining("this computer's tunnel (device laptop) looks down"),
    });
  });
});
