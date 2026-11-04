/**
 * Pure helpers of feature 020's live test (`monitoring.test.ts`, docs/e2e.md "Self-hosted
 * monitoring"): its variables, the servers a plan's stack watches, the ones `opscrew addon status
 * --json` shows without figures or logs, the HTTP status a probe printed, Grafana's password in the
 * generated values, and the app's secret values in its `app.env`. No network, no processes;
 * unit-tested in `monitoring-support.test.ts`.
 */
import { parseDotenv } from "@opscrew/agents";
import {
  type DeployPlan,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
} from "@opscrew/plan-schema";
import { z } from "zod";

/** The test's gate. */
export const MONITORING_GATE = "OPSCREW_E2E_MONITORING";

/** What the pass needs besides its gate (the domain: the app is behind Cloudflare). */
export const MONITORING_VARIABLES = [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_DOMAIN",
] as const;

/** SC-2001: every server's data is in the stack within 2 minutes of the last step. */
export const SC_2001_MS = 2 * 60_000;

/**
 * The monitoring server's TCP ports that must not answer from the internet: the web's, Grafana's,
 * the front's, Prometheus's, Loki's, Alloy's own and Postgres's.
 */
export const CLOSED_PORTS = [
  80,
  443,
  MONITORING_GRAFANA_PORT,
  MONITORING_PUSH_PORT,
  9090,
  3100,
  12345,
  5432,
] as const;

/** A server by the labels its figures and lines carry in the stack. */
export interface ServerLabels {
  app: string;
  env: string;
  server: string;
}

/** Every server of `plan`'s environment by its labels: the app's server, then each extra one. */
export function planServers(
  plan: Pick<DeployPlan, "app" | "environment" | "servers">,
): ServerLabels[] {
  const env = plan.environment?.name ?? "prod";
  return ["app", ...(plan.servers ?? []).map((server) => server.name)].map((server) => ({
    app: plan.app.name,
    env,
    server,
  }));
}

/** The part of `opscrew addon status --json` the test reads. */
const StatusSchema = z.object({
  monitoring: z
    .object({
      reading: z
        .object({
          servers: z.array(
            z.object({
              app: z.string(),
              env: z.string(),
              server: z.string(),
              lastFigures: z.string().optional(),
              lastLog: z.string().optional(),
              silent: z.boolean(),
            }),
          ),
        })
        .optional(),
    })
    .optional(),
});

/** `<app>/<env>/<server>`. */
export function serverKey(labels: ServerLabels): string {
  return `${labels.app}/${labels.env}/${labels.server}`;
}

/**
 * The servers of `expected` whose figures or logs the stack has not received (or that it flags
 * silent), in `stdout`, the output of `opscrew addon status --json`; each as {@link serverKey}.
 * All of them when the status holds no reading of the stack.
 */
export function withoutData(stdout: string, expected: readonly ServerLabels[]): string[] {
  const servers = StatusSchema.parse(JSON.parse(stdout)).monitoring?.reading?.servers ?? [];
  const received = new Set(
    servers
      .filter((s) => s.lastFigures !== undefined && s.lastLog !== undefined && !s.silent)
      .map(serverKey),
  );
  return expected.map(serverKey).filter((key) => !received.has(key));
}

/**
 * The HTTP status a probe printed on its last line (curl's `%{http_code}`, or the device's
 * script); `undefined` when nothing answered (`000`, `0`).
 */
export function httpStatus(stdout: string): number | undefined {
  const status = Number(stdout.trim().split(/\r?\n/).at(-1));
  return Number.isInteger(status) && status >= 100 ? status : undefined;
}

/** Grafana's admin password in OpsCrew's generated values (`generated_values.json`, parsed). */
export function grafanaAdminPassword(generated: unknown): string {
  return z
    .object({ monitoring: z.object({ grafanaAdminPassword: z.string().min(1) }) })
    .parse(generated).monitoring.grafanaAdminPassword;
}

/**
 * The app's secret settings in `text`, its `app.env` on the server: each value of 8 characters or
 * more whose name `plan` marks secret, with that name.
 */
export function secretEnvValues(
  text: string,
  plan: Pick<DeployPlan, "app">,
): { name: string; value: string }[] {
  const secret = new Set(plan.app.env.filter((v) => v.secret).map((v) => v.name));
  return [...parseDotenv(text)]
    .filter(([name, value]) => secret.has(name) && value.length >= 8)
    .map(([name, value]) => ({ name, value }));
}
