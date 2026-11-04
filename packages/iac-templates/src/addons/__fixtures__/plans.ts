import { createHash } from "node:crypto";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { type TestPlanOptions, testPlan } from "../../__fixtures__/plans";

/** The hub's public key in agent mode (a fixed, fake key of the right shape). */
export const HUB_KEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5${"A".repeat(48)}`;

/** Beszel at a subdomain, behind Cloudflare Access. */
export const BESZEL_SUBDOMAIN = {
  enabled: true,
  version: "0.21.1",
  access: "subdomain",
  hostname: "beszel.example.com",
  allowedEmails: ["ops@example.com", "dev@example.com"],
} as const;

/** Grafana Cloud's endpoints, as a stack's details page gives them. */
export const GRAFANA_CLOUD = {
  enabled: true,
  version: "1.21.3",
  metrics: { url: "https://prometheus-prod-01-eu-west-0.grafana.net/api/prom/push", user: "123456" },
  logs: { url: "https://logs-prod-eu-west-0.grafana.net/loki/api/v1/push", user: "654321" },
} as const;

/** {@link testPlan} with `observability` (re-parsed, so its defaults are filled in). */
export function observabilityPlan(
  observability: Record<string, unknown>,
  o: TestPlanOptions = {},
): DeployPlan {
  return DeployPlanSchema.parse({ ...testPlan(o), observability });
}

/** Self-hosted monitoring with its stack on the extra server `monitoring`, at the pinned versions. */
export const MONITORING = {
  enabled: true,
  where: { kind: "server", server: "monitoring" },
  versions: { prometheus: "3.15.1", loki: "3.7.9", grafana: "13.3.0", alloy: "1.21.3" },
  retention: { metricsDays: 15, logsDays: 7, metricsMaxGb: 24 },
} as const;

/** A WireGuard public key made at runtime from `seed` (the base64 of its SHA-256), never a literal. */
function wireGuardKey(seed: string): string {
  return createHash("sha256").update(seed).digest("base64");
}

/** What {@link monitoredPlan} changes in `shop`. */
export interface MonitoredPlanOptions {
  /** The extra servers, on Hetzner (default `monitoring` alone). */
  servers?: string[];
  /** Service name → the extra server it runs on (Postgres is `db`). */
  placed?: Record<string, string>;
  /** More service entries, after `db`. */
  services?: Record<string, unknown>[];
  /** Fields over {@link MONITORING}. */
  monitoring?: Record<string, unknown>;
  /** `observability.grafanaCloud`, when Grafana Cloud is on too. */
  grafanaCloud?: Record<string, unknown>;
  /** The edge's proxy (default Caddy). */
  edge?: "caddy" | "nginx";
}

/**
 * `shop` ({@link testPlan}: Postgres `db` on the app's server, the Caddy edge) at `example.com`
 * and `www.example.com`, with monitoring on, and with extra servers the private network
 * `10.200.4.0/24`: the app's server `.1`, then each of `o.servers` from `.2` in order
 * (`monitoring` is `10.200.4.2` by default).
 */
export function monitoredPlan(o: MonitoredPlanOptions = {}): DeployPlan {
  const base = testPlan({ domain: "example.com", www: true });
  const servers = o.servers ?? ["monitoring"];
  return DeployPlanSchema.parse({
    ...base,
    ...(o.edge === undefined ? {} : { target: { ...base.target, edge: o.edge } }),
    ...(servers.length > 0
      ? {
          servers: servers.map((name) => ({
            name,
            target: {
              provider: "hetzner",
              mode: "vps-compose",
              location: "nbg1",
              serverType: "cx23",
              backups: false,
            },
          })),
          network: {
            range: "10.200.4.0/24",
            members: ["app", ...servers].map((name, i) => ({
              name,
              address: `10.200.4.${i + 1}`,
              port: 51820,
              publicKey: wireGuardKey(name),
            })),
          },
        }
      : {}),
    services: [
      ...base.services.map((service) => {
        const server = o.placed?.[service.name];
        return server === undefined ? service : { ...service, server };
      }),
      ...(o.services ?? []),
    ],
    observability: {
      monitoring: { ...MONITORING, ...o.monitoring },
      ...(o.grafanaCloud === undefined ? {} : { grafanaCloud: o.grafanaCloud }),
    },
  });
}
