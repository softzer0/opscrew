import {
  type HostFacts,
  inspectHost,
  readableRecords,
  tunnelOf,
} from "@opscrew/connector-ssh-host";
import { IMAGES } from "@opscrew/iac-templates";
import { readOptionalArtifact } from "@opscrew/plan-schema";
import type { OwnServerDesignInput } from "../design";
import { onAppServer } from "../design/placement";
import { hostDeployLogin, type PreviewServer, previewServer } from "../previews/host";
import type { OwnServerServices } from "../provision";
import { appMemoryMb } from "./memory";
import {
  connectOwnServer,
  inspectOwnServer,
  type OwnServerDeps,
  ownServerFacts,
} from "./own-server";
import { appServerShell } from "./server-address";

/** Options of {@link inspectOwnServerForDesign}. */
interface DesignInspectOptions {
  hostKey?: string;
  services?: OwnServerServices;
}

/**
 * What design needs from the user's own server: connects with the login the interview recorded
 * (confirming and pinning the host key on the first connection, see {@link connectOwnServer}) and
 * inspects the server read-only: its size, whether its CPU has AVX, the OpsCrew apps set up there
 * with their memory limits, and its WireGuard interfaces and UDP ports in use (the port of the
 * app's private network there). A preview environment on another environment's server
 * (`previews.server`) gets that server's ({@link sharedServerDesign}). Design itself never
 * connects.
 */
export async function inspectOwnServerForDesign(
  deps: OwnServerDeps,
  options: DesignInspectOptions = {},
): Promise<OwnServerDesignInput> {
  const plan = await readOptionalArtifact("plan", deps.paths.files.plan);
  if (plan?.environment?.previews?.server !== undefined) {
    return sharedServerDesign(await previewServer(deps, plan), options);
  }
  const host = options.services?.host;
  deps.reporter.step("Connecting to your server to read its size (read-only)");
  const session = await connectOwnServer(deps, options);
  const inspected = await inspectOwnServer(
    session,
    host === undefined ? {} : { inspect: (shell) => host.inspect(shell) },
  );
  const { facts } = inspected;
  return {
    facts: inspected.server,
    apps: activeApps(facts),
    avx: facts.avx,
    network: { udpPortsInUse: facts.udpPortsInUse, wireguardInterfaces: facts.wireguardInterfaces },
  };
}

/** The OpsCrew apps set up on a server, with their memory limits, from its inspected facts. */
function activeApps(
  facts: Pick<HostFacts, "apps" | "tunnels">,
): NonNullable<OwnServerDesignInput["apps"]> {
  return readableRecords(facts.apps)
    .filter((record) => record.state === "active")
    .map((record) => ({
      name: record.app,
      memoryMb: record.memoryMb,
      tunnel: tunnelOf(facts, record.app).installed,
    }));
}

/**
 * What design needs from the server previews share with another environment (spec.md US9), reached
 * as `server` reaches it: inspected read-only (the user's own through the host's recorded admin
 * login, as {@link inspectOwnServerForDesign} does; one OpsCrew created as the host's `deploy`,
 * root through Docker in the pinned image), served behind Cloudflare's proxy, and the host
 * environment's own needs (its plan's memory limits on its server) in place of its record among
 * the apps, so design fits the previews into what is left.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no deploy login there.
 */
export async function sharedServerDesign(
  server: PreviewServer<OwnServerDeps>,
  options: DesignInspectOptions = {},
): Promise<OwnServerDesignInput> {
  const { deps, plan, host } = server;
  let input: OwnServerDesignInput;
  if (plan.target.provider === "own") {
    input = await inspectOwnServerForDesign(deps, options);
  } else {
    deps.reporter.step(`Connecting to ${host}'s server to read its size (read-only)`);
    const remote = await appServerShell(deps, plan, await hostDeployLogin(server));
    const adapter = options.services?.host;
    const facts =
      adapter === undefined
        ? await inspectHost(remote, { rootImage: IMAGES.caddy.ref })
        : await adapter.inspect(remote);
    input = { facts: ownServerFacts(facts), apps: activeApps(facts), avx: facts.avx };
  }
  const app = plan.app.name;
  return {
    ...input,
    apps: [
      { name: app, memoryMb: appMemoryMb(onAppServer(plan)), tunnel: false },
      ...(input.apps ?? []).filter((other) => other.name !== app),
    ],
    access: "public",
    serving: "proxy",
  };
}
