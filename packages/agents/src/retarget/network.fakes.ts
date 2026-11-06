/**
 * Test fakes for a move of an app with a private network and self-hosted monitoring: the deploy
 * user's host adapter on the servers OpsCrew created, which remembers what each apply set up
 * (WireGuard's interface, the monitoring stack, Alloy, the monitoring login), so a host plan
 * applied once is as planned on the next run.
 */
import {
  type ApplyOptions,
  type ApplyResult,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  type HostStep,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { sha256Hex } from "@opscrew/core";
import { freshFacts, readyRemote } from "../testing";

/** What deploy reads on a server OpsCrew created: root only through Docker, maybe its interface. */
export function cloudFacts(
  o: { publicKey?: string; projects?: readonly string[] } = {},
): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({ user: "deploy", privilege: "docker" }),
    containers: (o.projects ?? []).map((project) => ({
      name: `${project}-main-1`,
      project,
      ports: "",
      running: true,
    })),
    network:
      o.publicKey === undefined
        ? null
        : {
            dropIn: null,
            interfaces: [
              {
                name: "wg-opscrew0",
                config: "0".repeat(64),
                publicKey: o.publicKey,
                enabled: true,
                active: true,
                addresses: [],
                peers: [],
              },
            ],
            filterUnit: null,
            filters: [],
          },
  });
}

/** One host apply on a server OpsCrew created. */
export interface CloudApply {
  host: string;
  plan: HostPlan;
  options: ApplyOptions;
}

/** A step's rendered files (`file:<name>` parameters), each as its SHA-256. */
function fileHashes(step: HostStep): Record<string, string> {
  return Object.fromEntries(
    Object.entries(step.params).flatMap(([key, text]) =>
      key.startsWith("file:") ? [[key.slice("file:".length), sha256Hex(String(text))]] : [],
    ),
  );
}

/**
 * The deploy user's host adapter on the servers OpsCrew created, by address: `inspect` reports
 * `facts`; `apply` refuses a plan whose hash is not the approved one and leaves the monitoring's
 * steps in place (the stack's and Alloy's files, the login), which `remote` answers the login's
 * check with.
 */
export function cloudHosts(facts: Record<string, HostFacts>) {
  const applies: CloudApply[] = [];
  const granted = new Set<string>();
  const changed = (host: string, change: Partial<HostFacts>) => {
    facts[host] = HostFactsSchema.parse({ ...(facts[host] ?? cloudFacts()), ...change });
  };
  const running = (host: string, project: string) => {
    const others = (facts[host] ?? cloudFacts()).containers.filter((c) => c.project !== project);
    const container = { name: `${project}-main-1`, project, ports: "", running: true };
    changed(host, { containers: [...others, container] });
  };
  return {
    applies,
    facts,
    /** The deploy user's shell: `ready`, and the monitoring login's state on its check. */
    remote(host: string): RemoteExec {
      const ready = readyRemote(host);
      return {
        host,
        run: async (command, options) =>
          (options?.input ?? "").includes("grant.check")
            ? {
                exitCode: 0,
                stdout: `state=${granted.has(host) ? "in-place" : "change"}\n`,
                stderr: "",
              }
            : ready.run(command, options),
      };
    },
    adapter: {
      async inspect(remote: RemoteExec) {
        return facts[remote.host] ?? cloudFacts();
      },
      async apply(remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
        if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
        applies.push({ host: remote.host, plan, options });
        const host = remote.host;
        for (const step of plan.steps.filter((s) => s.state === "change")) {
          if (step.id === "grant") granted.add(host);
          else if (step.id === "monitoring") {
            running(host, "opscrew-monitoring");
            const containers = [{ name: "opscrew-monitoring-main-1", running: true }];
            changed(host, {
              monitoring: { containers, files: fileHashes(step), credential: true },
            });
          } else if (step.id === "alloy") {
            running(host, "opscrew-alloy");
            const destinations = String(step.params.destinations ?? "monitoring").split(" ");
            const postgres = step.params.postgresHost;
            changed(host, {
              alloy: {
                destinations: destinations as ("grafanaCloud" | "monitoring")[],
                files: fileHashes(step),
                ...(typeof postgres === "string" ? { postgresHost: postgres } : {}),
              },
            });
          }
        }
        return {
          applied: plan.steps.filter((s) => s.state === "change").map((s) => s.id),
          skipped: plan.steps.filter((s) => s.state !== "change").map((s) => s.id),
        };
      },
    },
  };
}

/** The applies on `host` of host plans with a step `id`. */
export function appliesOf(
  hosts: ReturnType<typeof cloudHosts>,
  id: string,
  host: string,
): CloudApply[] {
  return hosts.applies.filter(
    (a) => a.host === host && a.plan.steps.some((s) => s.id === id && s.state === "change"),
  );
}

/** The peers of a host plan's `network` step, by name. */
export function peersOf(plan: HostPlan): { name: string; publicKey: string; endpoint?: string }[] {
  const params = plan.steps.find((s) => s.id === "network")?.params;
  return JSON.parse(String(params?.peers ?? "[]"));
}
