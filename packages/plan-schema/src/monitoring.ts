/**
 * Self-hosted monitoring's helpers over a plan (`observability.monitoring`): its settings when on,
 * the server its stack runs on, and the network's outside member.
 */
import { APP_SERVER } from "./components";
import type { NetworkMember } from "./placement";
import type { MonitoringSettings } from "./plan";

/** What the monitoring helpers read of a plan (a parsed plan, or one inside its own rules). */
interface MonitoringFields {
  readonly servers?: readonly { readonly name: string }[] | undefined;
  readonly observability?: { readonly monitoring?: MonitoringSettings | undefined } | undefined;
}

/** The plan's monitoring settings when monitoring is on, else `undefined`. */
export function monitoringOf(plan: MonitoringFields): MonitoringSettings | undefined {
  const monitoring = plan.observability?.monitoring;
  return monitoring?.enabled === true ? monitoring : undefined;
}

/**
 * The server the stack runs on, when monitoring is on: `app`, this plan's extra server, or the
 * owner's server for a shared one.
 */
export function monitoringServerName(plan: MonitoringFields): string | undefined {
  const where = monitoringOf(plan)?.where;
  switch (where?.kind) {
    case undefined:
      return undefined;
    case "app":
      return APP_SERVER;
    case "server":
      return where.server;
    case "shared":
      return where.owner.server;
  }
}

/**
 * True for the network's outside member: the monitoring server of another plan this one sends to
 * (`where.kind` "shared"), named `owner.server` and neither the app nor one of `servers`.
 */
export function isOutsideMember(plan: MonitoringFields, member: NetworkMember): boolean {
  const where = monitoringOf(plan)?.where;
  return (
    where?.kind === "shared" &&
    member.name === where.owner.server &&
    member.name !== APP_SERVER &&
    !(plan.servers ?? []).some((server) => server.name === member.name)
  );
}
