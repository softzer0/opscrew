import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IacApplyResult, IacEngine, PlanSummary } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import {
  deletedTunnel,
  deletesTunnel,
  isTunnelBusyText,
  onlyTunnelBusy,
  readTunnelConnections,
  requireTunnelClosed,
  TUNNEL_RESOURCE_TYPE,
  tunnelBusyError,
  tunnelSafeEngine,
  waitForTunnelToClose,
} from "./tunnel-connections";

const TUNNEL = { accountId: "acct-0001", tunnelId: "6f1f3a2e-7b1c-4d2e-9f00-112233445566" };
/** An address Cloudflare returns as `origin_ip` (documentation range); never printed. */
const ORIGIN_IP = "198.51.100.23";

/** Cloudflare's answer for the tunnel: `status` and how many connections it lists. */
function tunnelBody(status: string, connections = 0) {
  return {
    success: true,
    errors: [],
    result: {
      id: TUNNEL.tunnelId,
      status,
      connections: Array.from({ length: connections }, (_, i) => ({
        id: `conn-${i}`,
        origin_ip: ORIGIN_IP,
        colo_name: "fra",
      })),
      conns_active_at: "2026-10-14T10:00:00Z",
      conns_inactive_at: status === "down" ? "2026-10-14T12:00:00Z" : null,
    },
  };
}

/** A fetch that answers each call with the next answer (the last one repeats), recording URLs. */
function scriptedFetch(answers: (() => Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init !== undefined ? { init } : {}) });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return (answer as () => Response)();
  };
  return { fetch, calls };
}

const json =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function deps(fetch: (input: string | URL, init?: RequestInit) => Promise<Response>) {
  const token = fakeSecret("cloudflare-token", "tunnel-wait");
  const d = await createTestPhaseDeps({ fetch, env: { CLOUDFLARE_API_TOKEN: token } });
  return Object.assign(d, { token });
}

/** A sleep that records each wait. */
function sleeper() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("tunnel deletion in a plan", () => {
  it("finds a deleted tunnel by its type and action, and its id and account in the plan JSON", () => {
    expect(
      deletesTunnel([
        { type: TUNNEL_RESOURCE_TYPE, action: "delete" },
        { type: "x", action: "create" },
      ]),
    ).toBe(true);
    expect(deletesTunnel([{ type: TUNNEL_RESOURCE_TYPE, action: "create" }])).toBe(false);
    expect(deletesTunnel([{ type: `${TUNNEL_RESOURCE_TYPE}_config`, action: "delete" }])).toBe(
      false,
    );
    const planJson = {
      resource_changes: [
        {
          address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared_config.this",
          type: `${TUNNEL_RESOURCE_TYPE}_config`,
          mode: "managed",
          change: { actions: ["delete"], before: { id: "cfg", account_id: "a" } },
        },
        {
          address: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
          type: TUNNEL_RESOURCE_TYPE,
          mode: "managed",
          change: {
            actions: ["delete"],
            before: { id: TUNNEL.tunnelId, account_id: TUNNEL.accountId, name: "shop" },
          },
        },
      ],
    };
    expect(deletedTunnel(planJson)).toEqual(TUNNEL);
    // A replacement creates a new tunnel; a plan JSON without resource changes names none.
    const replaced = structuredClone(planJson);
    (replaced.resource_changes[1] as { change: { actions: string[] } }).change.actions = [
      "delete",
      "create",
    ];
    expect(deletedTunnel(replaced)).toBeUndefined();
    expect(deletedTunnel({ format_version: "1.2" })).toBeUndefined();
    expect(deletedTunnel(null)).toBeUndefined();
  });
});

describe("readTunnelConnections", () => {
  it("asks Cloudflare read-only for the tunnel and keeps only the state", async () => {
    const f = scriptedFetch([json(tunnelBody("healthy", 2))]);
    const d = await deps(f.fetch);
    expect(await readTunnelConnections(d, TUNNEL, d.token)).toEqual({ state: "active" });
    expect(f.calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${TUNNEL.accountId}/cfd_tunnel/${TUNNEL.tunnelId}`,
    );
    expect(f.calls[0]?.init?.method).toBe("GET");
    expect(f.calls[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${d.token}` });
  });

  it("tells active, closed, gone and unknown apart", async () => {
    const cases: [() => Response, string][] = [
      [json(tunnelBody("degraded")), "active"],
      [json(tunnelBody("down", 1)), "active"],
      [json(tunnelBody("down")), "closed"],
      [json(tunnelBody("inactive")), "closed"],
      [json({ result: { conns_active_at: null } }), "closed"],
      [json({ result: { conns_active_at: "2026-10-14T10:00:00Z" } }), "active"],
      [json({ result: { deleted_at: "2026-10-14T10:00:00Z", status: "down" } }), "gone"],
      [json({ success: false, errors: [{ code: 1003, message: "not found" }] }, 404), "gone"],
      [
        json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403),
        "unknown",
      ],
      [() => new Response("<html>", { status: 200 }), "unknown"],
    ];
    for (const [answer, state] of cases) {
      const d = await deps(scriptedFetch([answer]).fetch);
      expect((await readTunnelConnections(d, TUNNEL, d.token)).state).toBe(state);
    }
    const d = await deps(async () => {
      throw new Error("network down");
    });
    expect(await readTunnelConnections(d, TUNNEL, d.token)).toEqual({
      state: "unknown",
      problem: "the request failed: network down",
    });
  });
});

describe("waitForTunnelToClose", () => {
  it("returns once the connections close after a delay, with progress about every 20 seconds", async () => {
    // Active for 9 reads (45 s), then down.
    const answers = [
      ...Array.from({ length: 9 }, () => json(tunnelBody("healthy", 1))),
      json(tunnelBody("down")),
    ];
    const f = scriptedFetch(answers);
    const d = await deps(f.fetch);
    const s = sleeper();
    const result = await waitForTunnelToClose(d, TUNNEL, { sleep: s.sleep });
    expect(result).toEqual({ closed: true });
    expect(f.calls).toHaveLength(10);
    expect(s.waits.every((ms) => ms === 5_000)).toBe(true);
    const text = d.reporter.text();
    expect(text).toContain(
      "Waiting until Cloudflare reports no active connections for the app's Cloudflare Tunnel (up to 3 minutes)",
    );
    expect(text).toContain(
      "Still waiting for Cloudflare to close the tunnel's connections (20 s so far, up to 3 minutes).",
    );
    expect(text).toContain("(40 s so far");
    expect(text).toContain("Cloudflare reports no active connections for the tunnel.");
    expect(text).not.toContain(ORIGIN_IP);
    expect(text).not.toContain(d.token);
  });

  it("gives up after 3 minutes when the connections never close", async () => {
    const f = scriptedFetch([json(tunnelBody("healthy", 1))]);
    const d = await deps(f.fetch);
    const s = sleeper();
    expect(await waitForTunnelToClose(d, TUNNEL, { sleep: s.sleep })).toEqual({ closed: false });
    expect(s.waits.reduce((a, b) => a + b, 0)).toBe(180_000);
    expect(f.calls).toHaveLength(37);
    // Progress lines, not one per read.
    const progress = d.reporter.lines.filter((l) => l.message.startsWith("Still waiting"));
    expect(progress).toHaveLength(8);
  });

  it("says why when no read worked, and needs no fetch without a token", async () => {
    const d = await deps(
      scriptedFetch([json({ errors: [{ message: "Authentication error" }] }, 403)]).fetch,
    );
    expect(
      await waitForTunnelToClose(d, TUNNEL, { sleep: async () => undefined, timeoutMs: 10_000 }),
    ).toEqual({
      closed: false,
      problem: "HTTP 403: Authentication error",
    });
    const none = await createTestPhaseDeps();
    expect(await waitForTunnelToClose(none, TUNNEL)).toEqual({ closed: true });
  });

  it("requireTunnelClosed throws the plain message on a timeout and skips a plan that names no tunnel", async () => {
    const d = await deps(scriptedFetch([json(tunnelBody("healthy", 1))]).fetch);
    const planJson = {
      resource_changes: [
        {
          type: TUNNEL_RESOURCE_TYPE,
          mode: "managed",
          change: {
            actions: ["delete"],
            before: { id: TUNNEL.tunnelId, account_id: TUNNEL.accountId },
          },
        },
      ],
    };
    const error = (await requireTunnelClosed(
      d,
      { planJson },
      {
        command: "opscrew destroy",
        already: "The app is removed from your server; its Cloudflare resources are still there.",
        options: { sleep: async () => undefined },
      },
    ).catch((e: unknown) => e)) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.message).toBe(
      "Cloudflare still reports active connections for the app's Cloudflare Tunnel after 3 minutes, so OpsCrew stopped before deleting it. Nothing in Cloudflare was deleted. The app is removed from your server; its Cloudflare resources are still there.",
    );
    expect(error.hint).toBe(
      "Run `opscrew destroy` again in a few minutes (the connections close on their own once the connector is gone); it continues with what is left.",
    );
    await expect(
      requireTunnelClosed(d, { planJson: {} }, { command: "x" }),
    ).resolves.toBeUndefined();
  });
});

describe("Cloudflare's error 1022", () => {
  const log = [
    "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this: Destroying...",
    "Error: failed to make http request",
    '400 Bad Request {"success":false,"errors":[{"code":1022,"message":"This tunnel has active connections. Please stop all cloudflared replicas, or wait a few minutes for connections to close, then try again."}]}',
  ].join("\n");

  it("is recognised and turned into a plain message", () => {
    expect(isTunnelBusyText(log)).toBe(true);
    expect(isTunnelBusyText("Error: 400 Bad Request port 1022 is in use")).toBe(false);
    // Only the 1022, or something else failed as well.
    expect(onlyTunnelBusy(log)).toBe(true);
    expect(onlyTunnelBusy(`${log}\nError: deleting server: server is locked`)).toBe(false);
    expect(onlyTunnelBusy("Apply complete!")).toBe(false);
    const error = tunnelBusyError({ command: "opscrew portainer disable", reason: "refused" });
    expect(error.message).toBe(
      "Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there.",
    );
    expect(error.message).not.toContain("1022");
    expect(error.hint).toContain("Run `opscrew portainer disable` again in a few minutes");
  });

  it("tunnelSafeEngine runs the step before a tunnel deletion only, and notes a 1022", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-tunnel-engine-"));
    const order: string[] = [];
    let changes: PlanSummary["changes"] = [];
    let result: IacApplyResult = { ok: true, outputs: {}, log: "Apply complete!" };
    const inner: IacEngine = {
      info: { name: "tofu", version: "1.13.1", binary: "/fake/tofu" },
      init: async () => undefined,
      validate: async () => ({ valid: true, diagnostics: [] }),
      output: async () => ({}),
      plan: async (_dir, planFile) => {
        await writeFile(planFile, "plan");
        return {
          engine: { name: "tofu", version: "1.13.1", binary: "/fake/tofu" },
          dir,
          planFile,
          planHash: "0".repeat(64),
          createdAt: "2026-10-14T12:00:00.000Z",
          changes,
          counts: { create: 0, update: 0, delete: changes.length, replace: 0 },
          hasDestroy: changes.length > 0,
          planJson: {},
        };
      },
      apply: async () => {
        order.push("apply");
        return result;
      },
    };
    const engine = tunnelSafeEngine(inner, async () => void order.push("before"));
    const approval = { approvedPlanHash: "0".repeat(64), allowDestroy: true };

    // No tunnel deleted: straight to the apply.
    changes = [
      {
        address: "module.dns.cloudflare_dns_record.a",
        type: "cloudflare_dns_record",
        name: "a",
        provider: "cf",
        action: "delete",
      },
    ];
    await engine.plan(dir, join(dir, "a.tfplan"));
    await engine.apply(dir, join(dir, "a.tfplan"), approval);
    expect(order).toEqual(["apply"]);

    // A tunnel deleted: the step first; a 1022 is noted.
    changes = [
      {
        address: "module.tunnel.x.this",
        type: TUNNEL_RESOURCE_TYPE,
        name: "this",
        provider: "cf",
        action: "delete",
      },
    ];
    await engine.plan(dir, join(dir, "b.tfplan"));
    result = { ok: false, outputs: {}, log };
    await engine.apply(dir, join(dir, "b.tfplan"), approval);
    expect(order).toEqual(["apply", "before", "apply"]);
    expect(engine.refusedBusyTunnel).toBe(true);

    // A plan saved by an earlier --plan-only run is read from its sidecar.
    await writeFile(join(dir, "c.tfplan"), "plan");
    await writeFile(join(dir, "c.tfplan.json"), JSON.stringify({ changes, planJson: {} }));
    await engine.apply(dir, join(dir, "c.tfplan"), approval);
    expect(order).toEqual(["apply", "before", "apply", "before", "apply"]);
  });
});
