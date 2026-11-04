/**
 * Support for feature 020's Docker pass (`monitoring.test.ts`): the Compose files OpsCrew renders
 * for the monitoring stack, the shared edge and Grafana Alloy, adapted to this computer only where
 * it differs from a server; Grafana's API, through which the test reads what the dashboards show;
 * and the sweep of everything a run started.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EDGE_PROJECT, MONITORING_PUSH_NETWORK, renderDashboards } from "@opscrew/iac-templates";
import { MONITORING_GRAFANA_PORT, MONITORING_PUSH_PORT } from "@opscrew/plan-schema";
import { parse, stringify } from "yaml";
import { docker, tail } from "./docker-support";

/** A Compose file, with what the adaptations change. */
interface ComposeDoc {
  services: Record<
    string,
    { ports?: string[]; networks?: string[] | Record<string, object>; volumes?: string[] }
  >;
  networks?: Record<string, Record<string, unknown>>;
}

/** The private network in the adapted Compose files: the test's network standing in for it. */
const PRIVATE = "private";

/** Where Alloy reads the app's folder in this test (on a server `/rootfs/srv/apps/<app>`). */
const APP_FOLDER_IN_ALLOY = "/opscrew-test/app";

/** The folder beside Alloy's Compose file that stands in for the app's folder on the server. */
export const APP_FOLDER = "app-folder";

/** Writes each file under `dir`, its folders made first, with `mode`. */
export async function writeFiles(
  dir: string,
  files: readonly { path: string; content: string }[],
  mode = 0o644,
): Promise<void> {
  for (const file of files) {
    const target = path.join(dir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { mode });
  }
}

/** Fails when the rendered `what` is not `expected`: this test's adaptation would be wrong. */
function rendered(actual: unknown, expected: unknown, what: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `OpsCrew renders ${what} as ${JSON.stringify(actual)}, not ${JSON.stringify(expected)}: adapt the monitoring Docker pass.`,
    );
  }
}

function load(content: string): ComposeDoc {
  return parse(content) as ComposeDoc;
}

function dump(doc: ComposeDoc): string {
  return stringify(doc, { lineWidth: 0, aliasDuplicateObjects: false });
}

/** The service `name` of `doc`, which the rendered file must have. */
function service(doc: ComposeDoc, name: string) {
  const found = doc.services[name];
  if (found === undefined) throw new Error(`The rendered Compose file has no ${name} service.`);
  return found;
}

/** The network list of a service in its rendered (list) form. */
function networkList(networks: string[] | Record<string, object> | undefined): string[] {
  if (!Array.isArray(networks)) throw new Error("A rendered service lists no networks.");
  return networks;
}

/**
 * The stack's `compose.yaml` adapted to this computer:
 * - the front is not published on the monitoring server's private address (which this computer
 *   doesn't have) but joins the test's network `privateNetwork` at that `address`, as the servers
 *   reach it there;
 * - Grafana is published on `127.0.0.1:grafanaPort` instead of its fixed port;
 * - the push network has the run's name `pushNetwork` instead of {@link MONITORING_PUSH_NETWORK}.
 */
export function localStack(
  content: string,
  o: { address: string; privateNetwork: string; grafanaPort: number; pushNetwork: string },
): string {
  const doc = load(content);
  const front = service(doc, "front");
  rendered(
    front.ports,
    [`${o.address}:${MONITORING_PUSH_PORT}:${MONITORING_PUSH_PORT}`],
    "the front's port",
  );
  delete front.ports;
  front.networks = Object.fromEntries([
    ...networkList(front.networks).map((name) => [name, {}]),
    [PRIVATE, { ipv4_address: o.address }],
  ]);
  const grafana = service(doc, "grafana");
  const port = MONITORING_GRAFANA_PORT;
  rendered(grafana.ports, [`127.0.0.1:${port}:${port}`], "Grafana's port");
  grafana.ports = [`127.0.0.1:${o.grafanaPort}:${port}`];
  const push = doc.networks?.push;
  rendered(push?.name, MONITORING_PUSH_NETWORK, "the push network's name");
  doc.networks = {
    ...doc.networks,
    push: { ...push, name: o.pushNetwork },
    [PRIVATE]: { external: true, name: o.privateNetwork },
  };
  return dump(doc);
}

/**
 * The shared edge's `compose.yaml` adapted to this computer: its network is the run's
 * `edgeNetwork`, and Caddy publishes only HTTPS, on `127.0.0.1:httpsPort`.
 */
export function localEdge(content: string, o: { edgeNetwork: string; httpsPort: number }): string {
  const doc = load(content);
  const caddy = service(doc, "caddy");
  rendered(caddy.ports, ["80:80", "443:443", "443:443/udp"], "Caddy's ports");
  caddy.ports = [`127.0.0.1:${o.httpsPort}:443`];
  doc.networks = { ...doc.networks, [EDGE_PROJECT]: { external: true, name: o.edgeNetwork } };
  return dump(doc);
}

/**
 * The app's site on the edge with Caddy's own CA (`tls internal`) in place of Let's Encrypt with
 * `acmeEmail`, which can't reach this computer.
 */
export function internalTls(site: string, acmeEmail: string): string {
  const line = `\ttls ${acmeEmail}\n`;
  if (!site.includes(line)) throw new Error(`The rendered site has no "tls ${acmeEmail}" line.`);
  return site.replace(line, "\ttls internal\n");
}

/**
 * Alloy's `compose.yaml` adapted to this computer: the edge's network is the run's `edgeNetwork`,
 * Alloy also joins the test's network `privateNetwork` (on a server it reaches the monitoring
 * server's private address over WireGuard), and it sees {@link APP_FOLDER} as the app's folder.
 */
export function localAlloy(
  content: string,
  o: { edgeNetwork: string; privateNetwork: string },
): string {
  const doc = load(content);
  const alloy = service(doc, "alloy");
  alloy.networks = [...networkList(alloy.networks), PRIVATE];
  alloy.volumes = [...(alloy.volumes ?? []), `./${APP_FOLDER}:${APP_FOLDER_IN_ALLOY}:ro`];
  rendered(doc.networks?.[EDGE_PROJECT], { external: true }, "Alloy's edge network");
  doc.networks = {
    ...doc.networks,
    [EDGE_PROJECT]: { external: true, name: o.edgeNetwork },
    [PRIVATE]: { external: true, name: o.privateNetwork },
  };
  return dump(doc);
}

/**
 * Alloy's `config.alloy` reading the app's masking file from {@link APP_FOLDER} instead of the app's
 * folder on the server, `appDir`, under `/rootfs` (which here is not a server's root).
 */
export function localMaskFile(config: string, appDir: string): string {
  const onServer = JSON.stringify(`/rootfs${appDir}/mask.re`);
  if (!config.includes(onServer)) throw new Error(`config.alloy doesn't read ${onServer}.`);
  return config.replace(onServer, JSON.stringify(`${APP_FOLDER_IN_ALLOY}/mask.re`));
}

/** The most lines one Loki query gives: the stack's `max_entries_limit_per_query`. */
export const LOKI_MAX_LINES = 5000;

/** The stack's two data sources. */
export type Source = "prometheus" | "loki";

/** A data frame of Grafana's query API: one series, or the log lines. */
export interface Frame {
  schema?: { fields: { name: string }[] };
  data?: { values: unknown[][] };
}

/** The uids of the six dashboards the stack provisions. */
export const DASHBOARD_UIDS = renderDashboards({ caddy: true })
  .map((dashboard) => dashboard.uid)
  .sort();

/** Grafana's HTTP API on `127.0.0.1:port`, signed in as `admin` with `password`. */
export class GrafanaApi {
  constructor(
    readonly port: number,
    private readonly password: string,
  ) {}

  /** `path` with `init`, signed in as `admin` with `password` (`null`: without a login). */
  fetch(path: string, init: RequestInit = {}, password: string | null = this.password) {
    const headers = new Headers(init.headers);
    if (password !== null) {
      headers.set("authorization", `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`);
    }
    return fetch(`http://127.0.0.1:${this.port}${path}`, { ...init, headers });
  }

  /** `path`'s JSON answer; fails with Grafana's answer when it isn't a success. */
  async json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init);
    if (!response.ok)
      throw new Error(`Grafana ${path}: ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  /**
   * `expr` on the stack's data source `source`, as a panel sends it (`/api/ds/query`, where Grafana
   * fills in `$__rate_interval`, `$__interval` and `$__range`) over `from`–`to` (Grafana's time
   * strings, or milliseconds); an instant query when `instant`. Loki gives at most
   * {@link LOKI_MAX_LINES} lines.
   */
  async query(
    source: Source,
    expr: string,
    time: { from: string; to: string },
    instant = false,
  ): Promise<Frame[]> {
    const kind =
      source === "loki"
        ? { queryType: "range", maxLines: LOKI_MAX_LINES }
        : { range: !instant, instant };
    const { results } = await this.json<{ results: Record<string, { frames?: Frame[] }> }>(
      "/api/ds/query",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...time,
          queries: [
            {
              refId: "A",
              datasource: { type: source, uid: `opscrew-${source}` },
              expr,
              intervalMs: 15_000,
              maxDataPoints: 300,
              ...kind,
            },
          ],
        }),
      },
    );
    return results.A?.frames ?? [];
  }
}

/** True when a frame holds at least one point or line. */
export function hasData(frames: readonly Frame[]): boolean {
  return frames.some((frame) => (frame.data?.values[0]?.length ?? 0) > 0);
}

/** The log lines of a Loki query's frames (their `Line` field). */
export function logLines(frames: readonly Frame[]): string[] {
  return frames.flatMap((frame) => {
    const index = frame.schema?.fields.findIndex((field) => field.name === "Line") ?? -1;
    return index < 0 ? [] : ((frame.data?.values[index] ?? []) as string[]);
  });
}

/** The value of an instant query's one series, if it has one. */
export function instantValue(frames: readonly Frame[]): number | undefined {
  const value = frames[0]?.data?.values[1]?.[0];
  return typeof value === "number" ? value : undefined;
}

/**
 * Removes every container, volume and network that carries one of `labels`: the containers first,
 * so the networks they joined can go.
 */
export async function removeLabelled(labels: readonly string[]): Promise<void> {
  const ids = async (args: string[]) => {
    const found = await Promise.all(
      labels.map(async (label) => (await docker([...args, "--filter", `label=${label}`])).stdout),
    );
    return [
      ...new Set(
        found
          .join("\n")
          .split(/\s+/)
          .filter((id) => id !== ""),
      ),
    ];
  };
  for (const [list, remove] of [
    [
      ["ps", "-a", "-q"],
      ["rm", "-f", "-v"],
    ],
    [
      ["volume", "ls", "-q"],
      ["volume", "rm", "-f"],
    ],
    [
      ["network", "ls", "-q"],
      ["network", "rm"],
    ],
  ] as const) {
    const found = await ids([...list]);
    if (found.length === 0) continue;
    const removed = await docker([...remove, ...found]);
    if (removed.exitCode !== 0)
      console.warn(`docker ${remove.join(" ")}:\n${tail(removed.stderr)}`);
  }
}
