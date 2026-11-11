/**
 * The providers' snapshots of a whole server (024 plan.md 5., T2403) in `snapshot list` and
 * `snapshot delete`: those OpsCrew took of the app's servers at Hetzner and DigitalOcean, read and
 * deleted through the connectors. Taking one is `opscrew snapshot --server`'s (T2409).
 */
import type { ServerSnapshotApi } from "@opscrew/contracts";
import { listText } from "@opscrew/core";
import { type CloudProvider, isCloudProvider } from "@opscrew/plan-schema";
import { providerCredentials, providerProfile, tokenNotSet, vpsConnector } from "../providers";
import { extraCloudProviders } from "../shared/servers";
import type { SnapshotRun } from "./run";
import type { SnapshotEntry } from "./types";

/** The cloud providers of the app's servers OpsCrew created: the app's, then its extra servers'. */
export function cloudProviders(run: SnapshotRun): CloudProvider[] {
  const { plan } = run;
  const app = plan.target.provider;
  return [...(isCloudProvider(app) ? [app] : []), ...extraCloudProviders(plan, app)];
}

/** `provider`'s server API with its token, or `undefined` when none is set. */
export function serverApi(
  run: SnapshotRun,
  provider: CloudProvider,
): ServerSnapshotApi | undefined {
  const { deps, services } = run;
  return services.serverSnapshots === undefined
    ? vpsConnector(provider, deps).servers
    : services.serverSnapshots(provider);
}

/** A whole-server snapshot `api` holds of one of the app's servers, with where it is. */
export interface ProviderSnapshot {
  entry: SnapshotEntry;
  api: ServerSnapshotApi;
}

/**
 * The whole-server snapshots OpsCrew took of the app's servers at each of their providers, oldest
 * first per server. A provider whose token is not set is said in a warning and left out.
 */
export async function providerSnapshots(run: SnapshotRun): Promise<ProviderSnapshot[]> {
  const { deps, plan } = run;
  const found: ProviderSnapshot[] = [];
  for (const provider of cloudProviders(run)) {
    const profile = providerProfile(provider);
    const api = serverApi(run, provider);
    if (api === undefined) {
      deps.reporter.warn(
        profile.tokenMode === "all"
          ? `The whole-server snapshots at ${profile.displayName} are not listed: set all of ${listText(profile.tokenVars)} to list them (${tokenNotSet(providerCredentials(profile, deps.env).missing)}).`
          : `The whole-server snapshots at ${profile.displayName} are not listed: set ${profile.tokenVars.join(" or ")} to list them.`,
      );
      continue;
    }
    for (const server of await api.findAppServers(plan.app.name)) {
      for (const snapshot of await api.listSnapshots(server.id)) {
        found.push({
          api,
          entry: {
            id: snapshot.id,
            kind: "server",
            taken: snapshot.createdAt,
            version: "",
            ...(snapshot.sizeGb === undefined
              ? {}
              : { size: Math.round(snapshot.sizeGb * 1024 ** 3) }),
            services: [],
            where: `at ${profile.displayName} (${profile.serverNoun} ${server.name})`,
            offsite: false,
            server: { provider, id: server.id, name: server.name },
          },
        });
      }
    }
  }
  return found;
}
