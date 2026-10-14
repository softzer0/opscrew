import type {
  IacApplyResult,
  IacEngine,
  PlanSummary,
  ResourceChange,
} from "@opscrew/contracts";
import { TUNNEL_RESOURCE_TYPE } from "../tunnel-connections";

/** The app's tunnel as Cloudflare and the plan JSON name it (synthetic). */
export const FAKE_TUNNEL = {
  accountId: "acct-0001",
  tunnelId: "6f1f3a2e-7b1c-4d2e-9f00-112233445566",
};

/** An address Cloudflare reports as a connection's `origin_ip` (documentation range). */
export const ORIGIN_IP = "198.51.100.23";

const CF = "registry.opentofu.org/cloudflare/cloudflare";

/** What a plan that deletes the tunnel (with its config, record and Access) changes. */
export function tunnelDeletes(prefix = "module"): ResourceChange[] {
  return [
    [`${prefix}.tunnel`, TUNNEL_RESOURCE_TYPE, "this"],
    [`${prefix}.tunnel`, `${TUNNEL_RESOURCE_TYPE}_config`, "this"],
    [`${prefix}.tunnel`, "cloudflare_dns_record", "route"],
    [`${prefix}.access`, "cloudflare_zero_trust_access_application", "ssh"],
  ].map(([module, type, name]) => ({
    address: `${module}.${type}.${name}`,
    type: type as string,
    name: name as string,
    provider: CF,
    action: "delete" as const,
  }));
}

/** The plan JSON of such a plan: the tunnel's id and account in `before`, as tofu writes it. */
export function tunnelDeletePlanJson(changes: readonly ResourceChange[] = tunnelDeletes()) {
  return {
    format_version: "1.2",
    resource_changes: changes.map((change) => ({
      address: change.address,
      mode: "managed",
      type: change.type,
      name: change.name,
      change: {
        actions: [change.action],
        before:
          change.type === TUNNEL_RESOURCE_TYPE
            ? { id: FAKE_TUNNEL.tunnelId, account_id: FAKE_TUNNEL.accountId, name: "shop" }
            : { id: `${change.name}-id` },
        after: null,
      },
    })),
  };
}

/** Engine log of an apply Cloudflare refused with error 1022. */
export const BUSY_TUNNEL_LOG = [
  "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this: Destroying...",
  "╷",
  "│ Error: failed to make http request",
  "│",
  '│ DELETE "https://api.cloudflare.com/client/v4/accounts/acct-0001/cfd_tunnel/6f1f3a2e-7b1c-4d2e-9f00-112233445566": 400 Bad Request {"success":false,"errors":[{"code":1022,"message":"This tunnel has active connections. Please stop all cloudflared replicas, or wait a few minutes for connections to close, then try again."}],"messages":[],"result":null}',
  "╵",
].join("\n");

/**
 * Makes an engine's plans delete the tunnel: every plan for which `when` is true reports
 * {@link tunnelDeletes} with {@link tunnelDeletePlanJson}. `busy()` makes the next apply fail
 * with Cloudflare's 1022; every apply is logged in `events` as `iac-apply`.
 */
export function deleteTunnelIn<E extends IacEngine>(
  engine: E,
  events: string[],
  when: (options: { destroy?: boolean } | undefined, summary: PlanSummary) => boolean,
): E & { busy(): void } {
  const plan = engine.plan.bind(engine);
  const apply = engine.apply.bind(engine);
  let busy = false;
  engine.plan = async (dir, planFile, options) => {
    const summary = await plan(dir, planFile, options);
    if (!when(options, summary)) return summary;
    const changes = tunnelDeletes();
    return {
      ...summary,
      changes,
      counts: { create: 0, update: 0, delete: changes.length, replace: 0 },
      hasDestroy: true,
      planJson: tunnelDeletePlanJson(changes),
    };
  };
  engine.apply = async (dir, planFile, approval, options): Promise<IacApplyResult> => {
    events.push("iac-apply");
    if (busy) {
      busy = false;
      return { ok: false, outputs: {}, log: BUSY_TUNNEL_LOG };
    }
    return apply(dir, planFile, approval, options);
  };
  return Object.assign(engine, {
    busy: () => {
      busy = true;
    },
  });
}

/**
 * Cloudflare's tunnel API as a fake `fetch`: the tunnel is `healthy` (one connection) while
 * `connectorRunning()` is true and for `closeAfter` more polls after that, then `down`; `never`
 * keeps it connected. Each poll is logged in `events` as `poll`.
 */
export function fakeTunnelApi(input: {
  events: string[];
  connectorRunning: () => boolean;
  closeAfter?: number;
  never?: boolean;
}) {
  const calls: string[] = [];
  let pollsSinceStopped = 0;
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${String(url)}`);
    if (method !== "GET") throw new Error("the tunnel wait only reads");
    input.events.push("poll");
    const running = input.connectorRunning();
    if (!running) pollsSinceStopped++;
    const active = input.never === true || running || pollsSinceStopped <= (input.closeAfter ?? 0);
    return new Response(
      JSON.stringify({
        success: true,
        errors: [],
        result: {
          id: FAKE_TUNNEL.tunnelId,
          status: active ? "healthy" : "down",
          connections: active ? [{ id: "conn-1", origin_ip: ORIGIN_IP, colo_name: "fra" }] : [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch, calls };
}
