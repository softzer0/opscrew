import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IacApplyResult, IacEngine, PlanSummary } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { BUSY_TUNNEL_LOG } from "./__fixtures__/tunnel";
import { PlanRefusedError } from "./approvals";
import {
  connectorFirst,
  deletedTunnels,
  isTunnelBusyText,
  onlyTunnelBusy,
  requireTunnelClosed,
  SERVER_GOES_FIRST,
  TUNNEL_RESOURCE_TYPE,
  tunnelBusyError,
  tunnelChange,
  tunnelSafeEngine,
  waitForTunnelToClose,
} from "./tunnel-connections";

const TUNNEL = { accountId: "acct-0001", tunnelId: "6f1f3a2e-7b1c-4d2e-9f00-112233445566" };
/** The tunnel in front of Portainer's webhook, which a Portainer root deletes as well. */
const WEBHOOK_TUNNEL = { accountId: "acct-0001", tunnelId: "0b5e8c1d-2f3a-4b5c-8d9e-aabbccddeeff" };

/** A plan JSON resource change that deletes `tunnel`. */
function tunnelDeletion(tunnel: typeof TUNNEL) {
  return {
    type: TUNNEL_RESOURCE_TYPE,
    mode: "managed",
    change: { actions: ["delete"], before: { id: tunnel.tunnelId, account_id: tunnel.accountId } },
  };
}
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
    const changes = [
      { type: TUNNEL_RESOURCE_TYPE, action: "delete" },
      { type: "x", action: "create" },
    ] as const;
    expect(tunnelChange(changes, "delete")).toBe(true);
    expect(tunnelChange(changes, "create", "replace")).toBe(false);
    expect(tunnelChange(changes)).toBe(true);
    expect(tunnelChange([{ type: TUNNEL_RESOURCE_TYPE, action: "create" }], "delete")).toBe(false);
    expect(
      tunnelChange([{ type: `${TUNNEL_RESOURCE_TYPE}_config`, action: "delete" }], "delete"),
    ).toBe(false);
    expect(tunnelChange([{ type: "cloudflare_dns_record", action: "update" }])).toBe(false);
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
    expect(deletedTunnels(planJson)).toEqual([TUNNEL]);
    // A replacement creates a new tunnel; a plan JSON without resource changes names none.
    const replaced = structuredClone(planJson);
    (replaced.resource_changes[1] as { change: { actions: string[] } }).change.actions = [
      "delete",
      "create",
    ];
    expect(deletedTunnels(replaced)).toEqual([]);
    expect(deletedTunnels({ format_version: "1.2" })).toEqual([]);
    expect(deletedTunnels(null)).toEqual([]);
  });

  it("finds every tunnel a plan deletes (a Portainer root can delete two)", () => {
    expect(
      deletedTunnels({
        resource_changes: [
          tunnelDeletion(TUNNEL),
          { type: "cloudflare_dns_record" },
          tunnelDeletion(WEBHOOK_TUNNEL),
        ],
      }),
    ).toEqual([TUNNEL, WEBHOOK_TUNNEL]);
  });
});

describe("waitForTunnelToClose", () => {
  it("asks Cloudflare's client read-only for the tunnel, with the token", async () => {
    const f = scriptedFetch([json(tunnelBody("down"))]);
    const d = await deps(f.fetch);
    expect(await waitForTunnelToClose(d, TUNNEL, { sleep: async () => undefined })).toEqual({
      closed: true,
    });
    expect(f.calls[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${TUNNEL.accountId}/cfd_tunnel/${TUNNEL.tunnelId}`,
    );
    expect(f.calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(f.calls[0]?.init?.headers).toMatchObject({ Authorization: `Bearer ${d.token}` });
  });

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
      scriptedFetch([
        json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403),
      ]).fetch,
    );
    expect(
      await waitForTunnelToClose(d, TUNNEL, { sleep: async () => undefined, timeoutMs: 10_000 }),
    ).toEqual({
      closed: false,
      problem: "Cloudflare refused the request to read the tunnel: Authentication error.",
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

  it("requireTunnelClosed waits for every tunnel the plan deletes and stops at the first still open", async () => {
    const planJson = {
      resource_changes: [tunnelDeletion(TUNNEL), tunnelDeletion(WEBHOOK_TUNNEL)],
    };
    const options = { command: "opscrew destroy", options: { sleep: async () => undefined } };

    const closed = scriptedFetch([json(tunnelBody("down"))]);
    await requireTunnelClosed(await deps(closed.fetch), { planJson }, options);
    expect(closed.calls.map((call) => call.url)).toEqual([
      expect.stringContaining(`/cfd_tunnel/${TUNNEL.tunnelId}`),
      expect.stringContaining(`/cfd_tunnel/${WEBHOOK_TUNNEL.tunnelId}`),
    ]);

    // The first closes, the second keeps its connections until the wait times out.
    const open = scriptedFetch([json(tunnelBody("down")), json(tunnelBody("healthy", 1))]);
    await expect(
      requireTunnelClosed(await deps(open.fetch), { planJson }, options),
    ).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("Nothing in Cloudflare was deleted."),
    });
    const webhookReads = open.calls.filter((call) => call.url.includes(WEBHOOK_TUNNEL.tunnelId));
    expect(webhookReads.length).toBeGreaterThan(1);
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

  it("tunnelSafeEngine passes every call through and notes a 1022", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opscrew-tunnel-engine-"));
    const order: string[] = [];
    let result: IacApplyResult = { ok: true, outputs: {}, log: "Apply complete!" };
    const inner: IacEngine = {
      info: { name: "tofu", version: "1.13.1", binary: "/fake/tofu" },
      init: async () => undefined,
      validate: async () => ({ valid: true, diagnostics: [] }),
      output: async () => ({}),
      providerSchemas: async () => {
        order.push("providers schema");
        return {};
      },
      stateResources: async () => {
        order.push("state list");
        return [];
      },
      untaint: async () => {
        order.push("untaint");
      },
      importResource: async () => {
        order.push("import");
      },
      plan: async (_dir, planFile) => {
        order.push("plan");
        await writeFile(planFile, "plan");
        return {
          engine: { name: "tofu", version: "1.13.1", binary: "/fake/tofu" },
          dir,
          planFile,
          planHash: "0".repeat(64),
          createdAt: "2026-10-14T12:00:00.000Z",
          changes: TUNNEL_CHANGES,
          counts: { create: 0, update: 0, delete: 1, replace: 0 },
          hasDestroy: true,
          planJson: {},
        } satisfies PlanSummary;
      },
      apply: async () => {
        order.push("apply");
        return result;
      },
    };
    const engine = tunnelSafeEngine(inner);
    const approval = { approvedPlanHash: "0".repeat(64), allowDestroy: true };
    await engine.providerSchemas(dir);
    await engine.stateResources(join(dir, "prod.tfstate"));
    await engine.plan(dir, join(dir, "a.tfplan"));
    await engine.apply(dir, join(dir, "a.tfplan"), approval);
    expect(order).toEqual(["providers schema", "state list", "plan", "apply"]);
    expect(engine.refusedBusyTunnel).toBe(false);
    result = { ok: false, outputs: {}, log };
    await engine.apply(dir, join(dir, "a.tfplan"), approval);
    expect(engine.refusedBusyTunnel).toBe(true);
    expect(engine.onlyBusyTunnel).toBe(true);
  });
});

const TUNNEL_CHANGES: PlanSummary["changes"] = [
  {
    address: "module.tunnel.x.this",
    type: TUNNEL_RESOURCE_TYPE,
    name: "this",
    provider: "cf",
    action: "delete",
  },
];

const DNS_CHANGES: PlanSummary["changes"] = [
  {
    address: "module.dns.cloudflare_dns_record.a",
    type: "cloudflare_dns_record",
    name: "a",
    provider: "cf",
    action: "delete",
  },
];

describe("connectorFirst hooks", () => {
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
  const tunnelPlan = { planHash: "a".repeat(64), changes: TUNNEL_CHANGES, planJson };
  const dnsPlan = { planHash: "b".repeat(64), changes: DNS_CHANGES, planJson: {} };

  async function setup(answers: (() => Response)[], hostChange?: () => Promise<never>) {
    const order: string[] = [];
    const f = scriptedFetch(answers);
    const d = await deps(async (input, init) => {
      order.push("poll");
      return f.fetch(input, init);
    });
    const first = connectorFirst(d, {
      command: "opscrew portainer disable",
      app: "shop",
      where: "on the server",
      hostChange:
        hostChange ??
        (async () => {
          order.push("host");
          return { hash: "c".repeat(64), applied: true };
        }),
      hostHash: () => "c".repeat(64),
      done: "The connector is removed.",
      sleep: async () => undefined,
      notes: ["Warning: given."],
    });
    return { d, first, order };
  }

  it("adds the note only for a plan that deletes the tunnel, after the given ones", async () => {
    const { first } = await setup([json(tunnelBody("down"))]);
    expect(first.hooks.approvalNotes(dnsPlan)).toEqual(["Warning: given."]);
    expect(first.hooks.approvalNotes(tunnelPlan)).toEqual([
      "Warning: given.",
      "The change on the server is shown next and applied first: Cloudflare deletes a tunnel only after its connector has stopped, so OpsCrew applies this plan after that.",
    ]);
    // Asking again adds nothing twice.
    expect(first.hooks.approvalNotes(tunnelPlan)).toHaveLength(2);
  });

  it("beforeApply: nothing for other plans; the host change, then the wait, for the tunnel's deletion", async () => {
    const { d, first, order } = await setup([
      json(tunnelBody("healthy", 1)),
      json(tunnelBody("down")),
    ]);
    await first.hooks.beforeApply(dnsPlan);
    expect(order).toEqual([]);
    expect(first.host).toBeUndefined();
    await first.hooks.beforeApply(tunnelPlan);
    expect(order).toEqual(["host", "poll", "poll"]);
    expect(first.host?.applied).toBe(true);
    expect(d.reporter.text()).toContain(SERVER_GOES_FIRST);
  });

  it("a refused host change names both hashes; a 1022 heard by applyFailed is said in plain words", async () => {
    const refusal = new PlanRefusedError({
      plan: "host plan",
      unchanged: "Nothing on the server was changed.",
      hint: "To apply it later without prompts, run: opscrew portainer disable --approve …",
    });
    expect(refusal.message).toBe(
      "The host plan was not approved. Nothing on the server was changed.",
    );
    const refused = await setup([json(tunnelBody("down"))], async () => {
      throw refusal;
    });
    const error = (await refused.first.hooks
      .beforeApply(tunnelPlan)
      .catch((e: unknown) => e)) as OpsCrewError;
    expect(error.message).toBe(
      "The host plan was not approved. Nothing on the server was changed and nothing in Cloudflare was deleted.",
    );
    expect(error.hint).toContain(
      `opscrew portainer disable --approve ${"a".repeat(64)} --approve ${"c".repeat(64)}`,
    );
    expect(refused.order).toEqual([]);

    const { first } = await setup([json(tunnelBody("down"))]);
    await first.hooks.beforeApply(tunnelPlan);
    const failed = new OpsCrewError("ENGINE_FAILED", "Applying the plan failed:\n…");
    // Another failure keeps its words and says what is done already.
    expect((first.stopped(failed) as OpsCrewError).message).toBe(
      "Applying the plan failed:\n…\nThe connector is removed.",
    );
    first.hooks.applyFailed("Error: something else");
    expect((first.stopped(failed) as OpsCrewError).code).toBe("ENGINE_FAILED");
    first.hooks.applyFailed(BUSY_TUNNEL_LOG);
    const plain = first.stopped(failed) as OpsCrewError;
    expect(plain.code).toBe("PROVIDER_ERROR");
    expect(plain.message).toBe(
      "Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there. The connector is removed.",
    );
  });
});
