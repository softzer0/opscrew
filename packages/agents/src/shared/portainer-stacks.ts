import {
  inspectPortainer,
  opscrewStackNames,
  type PortainerClient,
  type PortainerClientDeps,
  type PortainerEndpoint,
  type PortainerFacts,
  type PortainerStackFacts,
  portainerClient,
} from "@opscrew/connector-portainer";
import type { PhaseName } from "@opscrew/contracts";
import type { DeployPlan, PortainerDeployTarget } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { PortainerConnection } from "./server-record";

/** The host ports the app's stack publishes in the plan's web mode (none through the tunnel). */
export function publishedPorts(target: PortainerDeployTarget): number[] {
  if (target.web.mode === "proxy") return [target.web.port];
  return target.web.mode === "caddy" ? [80, 443] : [];
}

/** OpsCrew's stack of `role` as Portainer reports it, found by the id OpsCrew recorded for it. */
export function recordedStack(
  connection: Pick<PortainerConnection, "created">,
  facts: Pick<PortainerFacts, "stacks">,
  role: "app" | "updater" | "tunnel-connector",
): PortainerStackFacts | undefined {
  const recorded = connection.created.stacks.find((stack) => stack.role === role);
  return recorded === undefined
    ? undefined
    : facts.stacks.find((stack) => stack.id === recorded.id);
}

/**
 * Reads the user's Portainer read-only for the app's stacks, through the client pinned to the
 * confirmed certificate (`client`, a fake in tests; the value key, when given, lets it fingerprint
 * the stacks' values), and audits the reading without Portainer's address (`detail` says for
 * what; `phase` when the command has one).
 */
export async function inspectRecordedPortainer(
  deps: Pick<PhaseDeps, "redactor" | "audit" | "reporter">,
  input: {
    plan: Pick<DeployPlan, "app">;
    target: PortainerDeployTarget;
    connection: PortainerConnection;
    token: string;
    /** Makes the client (default `portainerClient`). */
    client:
      | ((endpoint: PortainerEndpoint, token: string, deps: PortainerClientDeps) => PortainerClient)
      | undefined;
    valueKey?: Uint8Array;
    /** What the reporter says while it reads. */
    step: string;
    phase?: PhaseName;
    detail: string;
  },
): Promise<{ client: PortainerClient; facts: PortainerFacts }> {
  const { connection, target } = input;
  const client = (input.client ?? portainerClient)(
    {
      url: connection.url,
      ...(connection.certFingerprint !== undefined
        ? { certFingerprint: connection.certFingerprint }
        : {}),
    },
    input.token,
    {
      redactor: deps.redactor,
      ...(input.valueKey !== undefined ? { valueKey: input.valueKey } : {}),
    },
  );
  deps.reporter.step(input.step);
  const facts = await inspectPortainer(client, {
    environmentId: target.environmentId,
    names: opscrewStackNames(input.plan.app.name),
  });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "inspect Portainer (read-only)",
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    target: `portainer environment ${target.environmentId}`,
    decision: "allow",
    detail: input.detail,
  });
  return { client, facts };
}
