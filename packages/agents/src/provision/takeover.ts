/**
 * Servers the provider has and the infrastructure state lost (026 plan 4.3, FR-2607): a create
 * that stopped halfway leaves a server the state does not know, which the next provision takes
 * over in its plan instead of buying another. A provider that tags its servers after creating them
 * can leave one untagged (`nameOnly`), which OpsCrew takes over only when its own apply stopped
 * while creating that server, as the marker of an apply under way records.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppServer, IacEngine, ServerSnapshotApi } from "@opscrew/contracts";
import {
  exists,
  listText,
  OpsCrewError,
  type ProjectPaths,
  plural,
  tfstateFile,
  writeFileAtomic,
} from "@opscrew/core";
import { type ServerTakeover, serverResourceAddress } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type CloudProvider,
  type DeployPlan,
  isCloudProvider,
} from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { vpsConnector } from "../providers";
import { readValidJson } from "../shared/files";
import { appServers, cloudServerName, targetOf } from "../shared/servers";
import { plannedImports } from "./plan-json";
import type { ProvisionServices, SavedPlan } from "./types";

/**
 * The marker of an infrastructure apply under way in the environment (`.opscrew/…`, no secrets):
 * written before the apply and removed once a run finished it, so it is there after one that
 * stopped.
 */
export function applyMarkerFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "apply-started.json");
}

/** The marker's content: the plan applied, and the state addresses of the servers it creates. */
const ApplyMarkerSchema = z.object({
  planHash: z.string(),
  startedAt: z.string(),
  servers: z.array(z.string()),
});

/** One of the plan's servers OpsCrew creates: its name in the plan and its state address. */
interface PlannedServer {
  server: string;
  provider: CloudProvider;
  address: string;
}

/** The plan's servers OpsCrew creates (the app's and the extra ones), with their addresses. */
function plannedServers(plan: DeployPlan): PlannedServer[] {
  return appServers(plan).flatMap((server): PlannedServer[] => {
    const provider = targetOf(plan, server)?.provider;
    const address = serverResourceAddress(plan, server);
    return provider !== undefined && isCloudProvider(provider) && address !== undefined
      ? [{ server, provider, address }]
      : [];
  });
}

/**
 * Records that the infrastructure apply of `saved` starts now, with the servers it creates (or
 * replaces): the ones an apply that stops may leave at the provider untagged.
 */
export async function markApplyStarted(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  plan: DeployPlan,
  saved: Pick<SavedPlan, "planHash" | "changes">,
): Promise<void> {
  const addresses = new Set(plannedServers(plan).map((s) => s.address));
  const servers = saved.changes
    .filter((c) => (c.action === "create" || c.action === "replace") && addresses.has(c.address))
    .map((c) => c.address);
  const marker: z.infer<typeof ApplyMarkerSchema> = {
    planHash: saved.planHash,
    startedAt: deps.clock.now().toISOString(),
    servers,
  };
  await writeFileAtomic(applyMarkerFile(deps.paths), `${JSON.stringify(marker, null, 2)}\n`);
}

/** Removes the marker once a run finished the infrastructure apply (or found nothing to apply). */
export async function clearApplyMarker(deps: Pick<PhaseDeps, "paths">): Promise<void> {
  await rm(applyMarkerFile(deps.paths), { force: true });
}

/** What the plan does about the servers the state lost. */
export interface LostServers {
  /** The servers the plan imports. */
  takeovers: ServerTakeover[];
  /** What the plan says of them, and of each cancelled one it cannot take back. */
  notes: string[];
}

/** Nothing lost: no import, no note. */
export const NOTHING_LOST: LostServers = { takeovers: [], notes: [] };

/**
 * The server API `provider`'s servers are looked up with: the one given with its credential check
 * (`services.provider` for the plan's provider, else `services.providers`), else its connector's;
 * `undefined` when there is none (no credentials).
 */
function serverApi(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: Pick<ProvisionServices, "provider" | "providers">,
  provider: CloudProvider,
): ServerSnapshotApi | undefined {
  const given =
    provider === plan.target.provider ? services.provider : services.providers?.[provider];
  return given !== undefined ? given.servers : vpsConnector(provider, deps).servers;
}

/** `Hetzner Cloud`, its noun for a server and where the user manages them. */
function words(provider: CloudProvider) {
  const definition = cloudProvider(provider);
  return {
    displayName: definition.displayName,
    noun: definition.serverNoun,
    console: definition.texts.destroy.console,
    removal: definition.offering.removal,
  };
}

/** The server `server`'s name at its provider: the app's, or `<app>-<server>`. */
function serverName(plan: DeployPlan, server: string): string {
  return server === APP_SERVER ? plan.app.name : cloudServerName(plan, server);
}

const NONE_BOUGHT = (noun: string) => `OpsCrew stopped before planning, so no ${noun} was bought.`;

/**
 * The plan's servers the provider has and the state lacks, before provision's plan (026 plan
 * 4.3). Looked up only after an apply in this environment (its state file, or the marker of one
 * that stopped) and only at a provider whose servers can be listed: the app's servers there
 * (`findAppServers`), by the name of each of the plan's servers the state lacks. A server that is
 * not cancelled is taken over (`takeovers`, an `import` block in the plan); one whose tag was never
 * attached (`nameOnly`) only when OpsCrew's last apply here stopped while creating that server
 * ({@link applyMarkerFile} lists its address). A cancelled one (`cancelledUntil`) is never taken
 * over: the plan buys a new one, and its note says so (and that it starts another term, at a
 * provider that cancels at the end of the term).
 * @throws OpsCrewError `PHASE_PRECONDITION`, before any plan, for a `nameOnly` server the marker
 * does not list and for several servers with one name, naming them and what to do in the
 * provider's console.
 */
export async function lostServers(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    engine: IacEngine;
    /** The engine's environment (`TF_ENCRYPTION`). */
    env: Record<string, string | undefined>;
    services: Pick<ProvisionServices, "provider" | "providers">;
    command: string;
  },
): Promise<LostServers> {
  const { plan } = input;
  const planned = plannedServers(plan);
  if (planned.length === 0) return NOTHING_LOST;
  const statePath = tfstateFile(deps.paths);
  const markerFile = applyMarkerFile(deps.paths);
  const stopped = await exists(markerFile);
  const applied = await exists(statePath);
  if (!stopped && !applied) return NOTHING_LOST;

  const apis = new Map(
    [...new Set(planned.map((s) => s.provider))].map((provider) => [
      provider,
      serverApi(deps, plan, input.services, provider),
    ]),
  );
  const listable = planned.filter((s) => apis.get(s.provider) !== undefined);
  if (listable.length === 0) return NOTHING_LOST;
  const state = new Set(
    applied ? await input.engine.stateResources(statePath, { env: input.env }) : [],
  );
  const missing = listable.filter((s) => !state.has(s.address));
  if (missing.length === 0) return NOTHING_LOST;

  // The servers the stopped apply was creating; none when its marker cannot be read.
  const creating = new Set(
    stopped ? ((await readValidJson(markerFile, ApplyMarkerSchema))?.servers ?? []) : [],
  );
  const found = new Map<CloudProvider, AppServer[]>();
  for (const provider of new Set(missing.map((s) => s.provider))) {
    found.set(provider, (await apis.get(provider)?.findAppServers(plan.app.name)) ?? []);
  }
  const lost: LostServers = { takeovers: [], notes: [] };
  for (const { server, provider, address } of missing) {
    const name = serverName(plan, server);
    const said = words(provider);
    const named = (found.get(provider) ?? []).filter((s) => s.name === name);
    const live = named.filter((s) => s.cancelledUntil === undefined);
    const [taken] = live;
    if (live.length > 1) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${said.displayName} has ${live.length} ${said.noun}s named ${name} (ids ${listText(live.map((s) => s.id))}) that the infrastructure state lacks, so OpsCrew cannot tell which one to take over. ${NONE_BOUGHT(said.noun)}`,
        {
          hint: `Keep the app's ${said.noun} and rename or remove the others in ${said.console}, then run \`${input.command}\` again.`,
        },
      );
    }
    if (taken !== undefined) {
      if (taken.nameOnly === true && !creating.has(address)) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `${said.displayName} has a ${said.noun} named ${name} (id ${taken.id}) without OpsCrew's tag, which the infrastructure state lacks. OpsCrew takes such a ${said.noun} over only when its last provision of ${deps.paths.environment} stopped while creating it, and it did not, so it may not be the app's. ${NONE_BOUGHT(said.noun)}`,
          {
            hint: `Rename the ${said.noun} in ${said.console} if it is not the app's, or remove it there if it is a leftover; then run \`${input.command}\` again.`,
          },
        );
      }
      const why =
        taken.nameOnly === true
          ? ` without OpsCrew's tag, which the infrastructure state lacks: OpsCrew's last provision of ${deps.paths.environment} stopped while creating it`
          : ", which the infrastructure state lacks: an earlier apply created it but stopped before recording it";
      lost.takeovers.push({ server, id: taken.id });
      lost.notes.push(
        `${said.displayName} has the ${said.noun} ${name} (id ${taken.id}, ${taken.status})${why}. The plan takes it over with an import instead of buying another ${said.noun}; importing it changes nothing at ${said.displayName}.`,
      );
    } else if (named[0] !== undefined) {
      const { id, cancelledUntil = "" } = named[0];
      const term =
        said.removal.kind === "cancel-at-term-end"
          ? `, for another term of at least ${plural(said.removal.minimumTermMonths, "month")}`
          : "";
      lost.notes.push(
        `${said.displayName} has the ${said.noun} ${name} (id ${id}), which the infrastructure state lacks, cancelled until ${cancelledUntil.slice(0, 10)}. OpsCrew cannot take back a cancelled ${said.noun}, so the plan buys a new one${term}.`,
      );
    }
  }
  return lost;
}

/**
 * What a saved plan's approval says of the servers it takes over (`--approve <hash>`, which plans
 * nothing again): each of the plan's servers it imports, by name and why, from its plan JSON.
 */
export function takeoverNotes(plan: DeployPlan, saved: Pick<SavedPlan, "planJson">): string[] {
  const servers = plannedServers(plan);
  return plannedImports(saved.planJson).flatMap(({ address, id }) => {
    const planned = servers.find((s) => s.address === address);
    if (planned === undefined) return [];
    const said = words(planned.provider);
    const which = id === undefined ? "" : ` (id ${id})`;
    return [
      `${said.displayName} has the ${said.noun} ${serverName(plan, planned.server)}${which}, which the infrastructure state lacks: an earlier apply created it but stopped before recording it. The plan takes it over with an import instead of buying another ${said.noun}; importing it changes nothing at ${said.displayName}.`,
    ];
  });
}
