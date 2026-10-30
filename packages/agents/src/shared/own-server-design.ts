import { readableRecords, tunnelOf } from "@opscrew/connector-ssh-host";
import type { OwnServerDesignInput } from "../design";
import type { OwnServerServices } from "../provision";
import { connectOwnServer, inspectOwnServer, type OwnServerDeps } from "./own-server";

/**
 * What design needs from the user's own server: connects with the login the interview recorded
 * (confirming and pinning the host key on the first connection, see {@link connectOwnServer}) and
 * inspects the server read-only: its size, whether its CPU has AVX, the OpsCrew apps set up there
 * with their memory limits, and its WireGuard interfaces and UDP ports in use (the port of the
 * app's private network there). Design itself never connects.
 */
export async function inspectOwnServerForDesign(
  deps: OwnServerDeps,
  options: { hostKey?: string; services?: OwnServerServices } = {},
): Promise<OwnServerDesignInput> {
  const host = options.services?.host;
  deps.reporter.step("Connecting to your server to read its size (read-only)");
  const session = await connectOwnServer(deps, options);
  const inspected = await inspectOwnServer(
    session,
    host === undefined ? {} : { inspect: (shell) => host.inspect(shell) },
  );
  const { facts } = inspected;
  const apps = readableRecords(facts.apps)
    .filter((record) => record.state === "active")
    .map((record) => ({
      name: record.app,
      memoryMb: record.memoryMb,
      tunnel: tunnelOf(facts, record.app).installed,
    }));
  return {
    facts: inspected.server,
    apps,
    avx: facts.avx,
    network: { udpPortsInUse: facts.udpPortsInUse, wireguardInterfaces: facts.wireguardInterfaces },
  };
}
