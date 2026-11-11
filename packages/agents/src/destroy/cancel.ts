/**
 * Removal by cancellation (feature 026, US2, FR-2608, FR-2609). At a provider whose definition
 * says `removal: cancel-at-term-end` (Contabo), the destroy plan's deletion of a server is the
 * provider's cancel: it ends the server's contract at the end of its current term and bills it
 * until then. For every server of the app at such a provider (the extra servers too), OpsCrew says
 * so before the typed names and in the destroy plan's approval, shuts the server down after that
 * approval and before the apply, and reads its end date back afterwards. Each server is worded by
 * its own provider's definition; servers at Hetzner and DigitalOcean are deleted at once and never
 * reach this module.
 */
import type { ResourceChange } from "@opscrew/contracts";
import { listText, OpsCrewError, plural, upperFirst } from "@opscrew/core";
import {
  APP_SERVER,
  type CloudProvider,
  type DeployPlan,
  servicesOn,
  snapshotOffsiteOf,
} from "@opscrew/plan-schema";
import { deletesServer, serverData } from "./checks";
import { type DeletionScope, failureReason, type ServerApiInput, serverApi } from "./deletion";
import type { ServerSnapshot } from "./servers";
import { cancelTerm, destroyTexts, snapshotsOutlive } from "./texts";

/**
 * What cancelling a server needs of it: its provider, its module's address prefix, its ids as the
 * state records them and, for an extra server, its name at the provider.
 */
export type CancelledServer = Pick<ServerSnapshot, "provider" | "module" | "ids" | "name">;

/** The server's name at its provider: an extra server's `<app>-<name>`, else the app's name. */
function nameOf(server: CancelledServer, app: string): string {
  return server.name ?? app;
}

/** `the Droplet shop` or `the Droplets shop and shop-data`. */
function serversText(noun: string, names: readonly string[]): string {
  return names.length === 1 ? `the ${noun} ${names[0]}` : `the ${noun}s ${listText(names)}`;
}

/** `servers` grouped by provider, in order of first appearance. */
export function byProvider<S extends CancelledServer>(
  servers: readonly S[],
): [CloudProvider, S[]][] {
  const groups = new Map<CloudProvider, S[]>();
  for (const server of servers) {
    groups.set(server.provider, [...(groups.get(server.provider) ?? []), server]);
  }
  return [...groups];
}

/** The servers the teardown deletes (`inState`) at a provider that cancels them instead. */
export function cancelledServers<S extends CancelledServer & Pick<ServerSnapshot, "inState">>(
  snapshots: readonly S[],
): S[] {
  return snapshots.filter((s) => s.inState && cancelTerm(s.provider) !== undefined);
}

/** Those of `servers` whose cancel `changes` (a destroy plan's) still holds. */
export function cancelledIn<S extends CancelledServer>(
  servers: readonly S[],
  changes: readonly ResourceChange[],
): S[] {
  return servers.filter((server) =>
    deletesServer(
      changes.filter((change) => change.address.startsWith(server.module)),
      server.provider,
    ),
  );
}

/** `the Droplet shop` and `the Contabo server shop-data`, for titles and steps. */
export function cancelledText(servers: readonly CancelledServer[], app: string): string {
  return listText(
    byProvider(servers).map(([provider, group]) =>
      serversText(
        destroyTexts(provider).noun,
        group.map((server) => nameOf(server, app)),
      ),
    ),
  );
}

/**
 * What the teardown does to the servers the provider cancels, said before the typed names and in
 * the destroy plan's approval, per provider: billed to the end of the term (at least its minimum),
 * shut down now with the app's other resources deleted at once, and their disks (and, unless they
 * outlive them, their provider snapshots) gone when the term ends. `others` words what else goes
 * at once (a move names the server's own resources: its DNS records follow the app).
 */
export function cancelNotes(
  servers: readonly CancelledServer[],
  app: string,
  others = "the app's other resources (such as its DNS records, firewall and SSH key)",
): string[] {
  return byProvider(servers).flatMap(([provider, group]) => {
    const texts = destroyTexts(provider);
    const { company, noun } = texts;
    const one = group.length === 1;
    const them = one ? "it" : "them";
    const its = one ? "its" : "their";
    const disks = one ? "disk" : "disks";
    const gone = snapshotsOutlive(provider)
      ? `${upperFirst(its)} ${disks} go${one ? "es" : ""} when the term ends`
      : `${upperFirst(its)} ${disks} and ${its} ${company} snapshots go when the term ends`;
    const which = serversText(
      noun,
      group.map((server) => nameOf(server, app)),
    );
    return [
      `${company} does not delete ${which} at once: it ends ${its} contract at the end of ${its} current term (${plural(cancelTerm(provider) ?? 1, "month")} at least) and bills ${them} until then.`,
      `OpsCrew shuts ${them} down now and deletes ${others} at once.`,
      `${gone}; until then you can start ${them} again in ${texts.console}.`,
    ];
  });
}

/** A cancelled server stays billed, so removing it saves nothing on it before its term ends. */
export function nothingSavedLine(servers: readonly CancelledServer[], app: string): string {
  return `Nothing is saved on ${cancelledText(servers, app)} until ${servers.length === 1 ? "its term ends" : "their terms end"}.`;
}

/** The approval's lines for the shutdowns that come before the destroy plan's apply. */
export function shutdownLines(servers: readonly CancelledServer[], app: string): string[] {
  return servers.map((server) => {
    const { company, noun } = destroyTexts(server.provider);
    return `First OpsCrew shuts the ${noun} ${nameOf(server, app)} (id ${server.ids.join(", ")}) down through ${company}'s API; this plan's deletion of it is ${company}'s cancel.`;
  });
}

/**
 * The offer of OpsCrew's own data snapshot (024) before a teardown that deletes `servers`, whose
 * data would otherwise go with them along with their provider snapshots: the commands to run
 * first, with the off-server copy turned on when it is off. `flag` is the environment's flag
 * (` --env staging`) or "".
 */
export function dataSnapshotOffer(
  plan: DeployPlan,
  servers: readonly ServerSnapshot[],
  flag: string,
): string {
  const data = listText([
    ...new Set(
      servers.flatMap((server) =>
        serverData({
          services: servicesOn(plan, server.server),
          storage: server.server === APP_SERVER ? plan.storage : undefined,
        }),
      ),
    ),
  ]);
  const offsite = snapshotOffsiteOf(plan);
  const take = `\`opscrew snapshot${flag}\``;
  const first =
    offsite === undefined
      ? `turn on the encrypted copy off the server (\`opscrew snapshot offsite on --to r2${flag}\`, or \`opscrew snapshot offsite on --to hetzner --region <region>${flag}\` (or \`--to digitalocean\`), then \`opscrew provision${flag}\`) and run ${take}`
      : `run ${take}, which also puts its encrypted copy in the bucket ${offsite.bucket} for ${plural(offsite.days, "day")}`;
  const providerSnapshots = listText(
    byProvider(servers).map(([provider]) => {
      const { company, noun } = destroyTexts(provider);
      return `a ${company} snapshot would go with the ${noun}`;
    }),
  );
  return `To keep ${data}, type anything else now, ${first}, then run \`opscrew destroy${flag}\` again. That is OpsCrew's own snapshot of the data, and its copy off the server stays after the teardown; ${providerSnapshots}.`;
}

/** An audit entry of a provider call on `server`'s id `id`. */
function audit(
  scope: DeletionScope,
  server: CancelledServer,
  id: string,
  action: string,
  detail: string,
) {
  const { deps } = scope;
  return deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action,
    phase: scope.phase,
    target: `${server.provider} server ${id}`,
    detail: deps.redactor.redact(detail),
  });
}

/**
 * Shuts each of `servers` down through its provider's API, after the destroy plan's approval and
 * before its apply; each call is audited before and after. A failure stops the run before anything
 * is cancelled or deleted.
 */
export async function shutDown(
  scope: DeletionScope,
  servers: readonly CancelledServer[],
  input: ServerApiInput,
): Promise<void> {
  const { deps } = scope;
  for (const server of servers) {
    const texts = destroyTexts(server.provider);
    const name = nameOf(server, scope.app);
    const api = serverApi({ ...scope, provider: server.provider }, input);
    for (const id of server.ids) {
      deps.reporter.step(`Shutting the ${texts.noun} ${name} down`);
      await audit(scope, server, id, "power off", `shut ${name} down before its cancellation`);
      try {
        await api.powerOff(id);
      } catch (error) {
        await audit(scope, server, id, "power off failed", `${name}: ${failureReason(error)}`);
        throw new OpsCrewError(
          "PROVIDER_ERROR",
          deps.redactor.redact(
            `OpsCrew could not shut the ${texts.noun} ${name} down: ${failureReason(error)}. Nothing was cancelled or deleted.`,
          ),
          {
            hint: `Check the ${texts.noun} in ${texts.console}, then run \`${scope.command}\` again.`,
          },
        );
      }
      await audit(scope, server, id, "powered off", `${name} is off`);
    }
  }
}

/** `2026-12-31` as `31 December 2026`; a value that is no date as it is. */
function dayText(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * After the apply, reads the cancelled `servers` back (`findAppServers` of the app, once per
 * provider) and returns, for each, when its contract ends in plain English, or that the provider
 * did not say (never a guess). Each answer is audited; a failed lookup is said and audited too,
 * since the cancel itself was applied.
 */
export async function cancelDates(
  scope: DeletionScope,
  servers: readonly CancelledServer[],
  input: ServerApiInput,
): Promise<string[]> {
  const { deps, app } = scope;
  const lines: string[] = [];
  for (const [provider, group] of byProvider(servers)) {
    const texts = destroyTexts(provider);
    const { company, noun, console } = texts;
    let found: Awaited<ReturnType<ReturnType<typeof serverApi>["findAppServers"]>>;
    try {
      found = await serverApi({ ...scope, provider }, input).findAppServers(app);
    } catch (error) {
      const reason = failureReason(error);
      for (const server of group) {
        for (const id of server.ids) {
          await audit(scope, server, id, "cancel date", `end date not read: ${reason}`);
        }
      }
      const names = group.map((server) => nameOf(server, app));
      lines.push(
        deps.redactor.redact(
          `OpsCrew could not read when the contract of ${serversText(noun, names)} ends (${reason}); see the date in ${console}.`,
        ),
      );
      continue;
    }
    for (const server of group) {
      const name = nameOf(server, app);
      for (const id of server.ids) {
        const until = found.find((s) => s.id === id)?.cancelledUntil;
        await audit(
          scope,
          server,
          id,
          "cancel date",
          until === undefined ? "no end date answered" : `contract ends ${until}`,
        );
        lines.push(
          until === undefined
            ? `${company} did not say when the contract of the ${noun} ${name} ends, so OpsCrew cannot tell you the date; see it in ${console}.`
            : `The ${company} ${noun} ${name} is cancelled: its contract ends on ${dayText(until)}, and ${company} bills it until then. Its disk goes then; until then you can start it again in ${console}.`,
        );
      }
    }
  }
  return lines;
}

/**
 * The hint when the destroy plan's apply fails with cancelled `servers` in it: a provider may have
 * refused the cancel (Contabo refuses one for a server not created through its API), whose reason
 * the log above shows. The servers were shut down before the apply. Without `command` it leaves out
 * what to do otherwise, for a caller whose own hint says it (provision's).
 */
export function cancelFailedHint(
  servers: readonly CancelledServer[],
  app: string,
  command?: string,
): string {
  const groups = byProvider(servers).map(([provider, group]) => ({
    texts: destroyTexts(provider),
    names: group.map((server) => nameOf(server, app)),
  }));
  const refused = groups.map(
    ({ texts, names }) =>
      `If ${texts.company} refused to cancel ${serversText(texts.noun, names)} (its reason is in the log above; it refuses one not created through its API, for example), cancel ${names.length === 1 ? "it" : "them"} by hand in ${texts.console}.`,
  );
  const off = groups.map(
    ({ texts, names }) =>
      `${upperFirst(serversText(texts.noun, names))} ${names.length === 1 ? "is" : "are"} shut down; you can start ${names.length === 1 ? "it" : "them"} again in ${texts.console}.`,
  );
  return [
    ...refused,
    ...(command !== undefined
      ? [
          `Otherwise fix the cause shown above and run \`${command}\` again; it continues with what is left.`,
        ]
      : []),
    ...off,
  ].join(" ");
}
