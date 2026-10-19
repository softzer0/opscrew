import { readdir } from "node:fs/promises";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  everythingPrinted,
  LAN_IPV4,
  OWN_IPV4,
  type OwnProject,
  ownProject,
  provisionOwn,
} from "../drift/__fixtures__/own-project";
import { deleteTunnelIn, fakeTunnelApi, ORIGIN_IP } from "../shared/__fixtures__/tunnel";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

type Answer = (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };

/**
 * A deployed own-server project whose teardown plan deletes the tunnel (tunnel mode), or only DNS
 * records (public mode). `events` lists approvals, host applies, polls of Cloudflare's tunnel API
 * and engine applies in the order they happened.
 */
async function deployed(o: { access: "public" | "tunnel"; closeAfter?: number; never?: boolean }) {
  const events: string[] = [];
  let answer: Answer = () => true;
  const s = await ownProject({
    access: o.access,
    answer: (request) => {
      const decision = answer(request);
      events.push(`approve:${request.kind}`);
      return decision;
    },
  });
  await provisionOwn(s);
  events.length = 0;
  const engine =
    o.access === "tunnel"
      ? deleteTunnelIn(
          s.engine,
          events,
          (options, summary) => options?.destroy === true && summary.changes.length > 0,
        )
      : deleteTunnelIn(s.engine, events, () => false);
  const apply = s.host.apply.bind(s.host);
  s.host.apply = async (remote, plan, options) => {
    events.push(`host:${plan.purpose}`);
    return apply(remote, plan, options);
  };
  const api = fakeTunnelApi({
    events,
    connectorRunning: () => s.host.facts.tunnel.running,
    ...(o.closeAfter !== undefined ? { closeAfter: o.closeAfter } : {}),
    ...(o.never !== undefined ? { never: o.never } : {}),
  });
  const token = fakeSecret("cloudflare-token", "destroy-tunnel");
  if (o.access === "tunnel") {
    s.deps.fetch = api.fetch;
    s.deps.env.CLOUDFLARE_API_TOKEN = token;
  }
  return Object.assign(s, {
    events,
    api,
    token,
    engineFake: engine,
    answer: (next: Answer) => {
      answer = next;
    },
  });
}

function services(s: OwnProject): DestroyServices {
  return {
    engine: s.services.engine,
    github: s.github,
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    sleep: async () => undefined,
    ...(s.services.own !== undefined ? { own: s.services.own } : {}),
  };
}

async function expectError(promise: Promise<unknown>, code: string): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).code).toBe(code);
  return error as OpsCrewError;
}

const leftPlans = async (s: OwnProject) =>
  (await readdir(s.deps.paths.files.plansDir)).filter((name) => name.endsWith("-destroy.tfplan"));

const TIMEOUT_MESSAGE =
  "Cloudflare still reports active connections for the app's Cloudflare Tunnel after 3 minutes, so OpsCrew stopped before deleting it. Nothing in Cloudflare was deleted. The app is removed from your server; its Cloudflare resources are still there.";
const AGAIN_HINT =
  "Run `opscrew destroy` again in a few minutes (the connections close on their own once the connector is gone); it continues with what is left.";

describe.skipIf(!findExecutable("git"))(
  "opscrew destroy when the teardown deletes the tunnel",
  () => {
    it("approves both plans first, removes the connector, waits for the connections, then deletes the tunnel", async () => {
      const s = await deployed({ access: "tunnel", closeAfter: 5 });
      expect(s.host.facts.tunnel.running).toBe(true);
      const result = await runDestroy(s.deps, { services: services(s) });

      // Both approvals before any change; the server first; Cloudflare once the connections closed.
      expect(s.events).toEqual([
        "approve:iac-apply",
        "approve:host-apply",
        "host:teardown",
        ...Array.from({ length: 6 }, () => "poll"),
        "iac-apply",
        "approve:cloudflare-apply",
        "approve:github-secrets",
      ]);
      expect(
        s.api.calls.every((call) =>
          call.startsWith(
            "GET https://api.cloudflare.com/client/v4/accounts/acct-0001/cfd_tunnel/",
          ),
        ),
      ).toBe(true);
      const [iac, host] = s.handler.requests;
      expect(iac?.details).toContain(
        "Your server is not part of this plan. Cloudflare deletes a tunnel only after its connector on your server has stopped, so OpsCrew removes the app from your server first (the next approval) and applies this plan after that.",
      );
      expect(host?.details).toContain(
        "Cloudflare deletes a tunnel only after its connector on your server has stopped, so this goes first; the approved Cloudflare plan follows once Cloudflare reports no active connections for the tunnel.",
      );
      // The summary before the typed confirmation lists the server first.
      const text = s.deps.reporter.text();
      expect(text.indexOf("The teardown removes from your server:")).toBeLessThan(
        text.indexOf("and then deletes these Cloudflare resources ("),
      );
      expect(text).toContain(
        "Still waiting for Cloudflare to close the tunnel's connections (20 s so far",
      );
      expect(result.destroyed.map((c) => c.type)).toContain(
        "cloudflare_zero_trust_tunnel_cloudflared",
      );
      expect(s.engine.applies.at(-1)?.approval.approvedPlanHash).toBe(iac?.planHash);
      const plan = await readArtifact("plan", s.deps.paths.files.plan);
      expect(plan.deployment.destroyedAt).toBeDefined();
      expect(plan.approvals.slice(-3).map((a) => a.kind)).toEqual([
        "iac-apply",
        "host-apply",
        "cloudflare-apply",
      ]);
      expect(await leftPlans(s)).toEqual([]);
      expect(result.remaining).toContain(
        "The Cloudflare account's Zero Trust organization: OpsCrew never deletes it, because every OpsCrew app in the account uses it for Cloudflare Access, and it costs nothing.",
      );
      const everything = `${everythingPrinted(s)}\n${JSON.stringify(result)}`;
      for (const hidden of [ORIGIN_IP, LAN_IPV4, s.token]) expect(everything).not.toContain(hidden);
    });

    it("connections that never close: stops before the deletion, and a rerun finishes", async () => {
      const s = await deployed({ access: "tunnel", never: true });
      const applies = s.engine.applies.length;
      const error = await expectError(
        runDestroy(s.deps, { services: services(s) }),
        "PROVIDER_ERROR",
      );
      expect(error.message).toBe(TIMEOUT_MESSAGE);
      expect(error.hint).toBe(AGAIN_HINT);
      expect(s.events.filter((e) => e === "poll")).toHaveLength(37);
      expect(s.events).not.toContain("iac-apply");
      expect(s.engine.applies).toHaveLength(applies);
      expect(s.host.facts.record?.apps).toEqual([]);
      expect(
        (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
      ).toBeUndefined();
      expect(await leftPlans(s)).toEqual([]);
      expect(s.github.deleted).toEqual([]);

      // The connections closed meanwhile: the rerun deletes what is left on Cloudflare.
      s.events.length = 0;
      s.handler.requests.length = 0;
      const api = fakeTunnelApi({ events: s.events, connectorRunning: () => false });
      s.deps.fetch = api.fetch;
      await runDestroy(s.deps, { services: services(s) });
      expect(s.events).toEqual([
        "approve:iac-apply",
        "poll",
        "iac-apply",
        "approve:cloudflare-apply",
        "approve:github-secrets",
      ]);
      expect(s.handler.requests[0]?.details).toContain(
        "so OpsCrew applies this plan once Cloudflare reports no active connections for the tunnel.",
      );
      expect(
        (await readArtifact("plan", s.deps.paths.files.plan)).deployment.destroyedAt,
      ).toBeDefined();
    });

    it("turns Cloudflare's error 1022 during the apply into the plain message, and a rerun finishes", async () => {
      const s = await deployed({ access: "tunnel" });
      s.engineFake.busy();
      const error = await expectError(
        runDestroy(s.deps, { services: services(s) }),
        "PROVIDER_ERROR",
      );
      expect(error.message).toBe(
        "Cloudflare refused to delete the app's Cloudflare Tunnel because it still has active connections, so the tunnel is still there. The app is removed from your server; its Cloudflare resources are still there.",
      );
      expect(error.message).not.toContain("1022");
      expect(error.hint).toBe(AGAIN_HINT);
      expect(await leftPlans(s)).toEqual([]);

      s.events.length = 0;
      await runDestroy(s.deps, { services: services(s) });
      expect(s.events).toEqual([
        "approve:iac-apply",
        "poll",
        "iac-apply",
        "approve:cloudflare-apply",
        "approve:github-secrets",
      ]);
    });

    it("a refused teardown changes nothing on the server and deletes nothing in Cloudflare", async () => {
      const s = await deployed({ access: "tunnel" });
      s.answer((request) => request.kind !== "host-apply");
      const error = await expectError(
        runDestroy(s.deps, { services: services(s) }),
        "APPROVAL_REFUSED",
      );
      expect(error.message).toBe(
        "The removal of shop from your server was not approved, so nothing on your server was changed and nothing in Cloudflare was deleted.",
      );
      expect(s.events).toEqual(["approve:iac-apply", "approve:host-apply"]);
      expect(s.host.facts.tunnel.running).toBe(true);
      expect(await leftPlans(s)).toEqual([]);
    });

    it("a failed teardown says nothing in Cloudflare was deleted yet, and a rerun finishes", async () => {
      const s = await deployed({ access: "tunnel" });
      s.host.fail = new OpsCrewError("COMMAND_FAILED", "Removing the app's containers failed.", {
        hint: "Check Docker on the server.",
      });
      const error = await expectError(
        runDestroy(s.deps, { services: services(s) }),
        "COMMAND_FAILED",
      );
      expect(error.hint).toBe(
        "Check Docker on the server. Nothing in Cloudflare was deleted yet (the tunnel goes only after the app is off your server). Run `opscrew destroy` again to finish.",
      );
      expect(s.events).not.toContain("iac-apply");
      expect(s.events).not.toContain("poll");

      s.events.length = 0;
      await runDestroy(s.deps, { services: services(s) });
      expect(s.events.slice(0, 3)).toEqual([
        "approve:iac-apply",
        "approve:host-apply",
        "host:teardown",
      ]);
      expect(s.events.slice(-3)).toEqual([
        "iac-apply",
        "approve:cloudflare-apply",
        "approve:github-secrets",
      ]);
    });

    it("no tunnel deleted (public mode): Cloudflare first as before, no polls", async () => {
      const s = await deployed({ access: "public" });
      await runDestroy(s.deps, { services: services(s) });
      expect(s.events).toEqual([
        "approve:iac-apply",
        "iac-apply",
        "approve:host-apply",
        "host:teardown",
        "approve:cloudflare-apply",
        "approve:github-secrets",
      ]);
      const [iac, host] = s.handler.requests;
      expect(iac?.details).toContain(
        "Your server is not part of this plan; the app is removed from it in the next step.",
      );
      expect(host?.details).not.toContain("so this goes first");
      const text = s.deps.reporter.text();
      expect(text.indexOf("The teardown deletes these Cloudflare resources:")).toBeLessThan(
        text.indexOf("and removes from your server:"),
      );
      expect(text).not.toContain("Waiting until Cloudflare reports");
      expect(`${everythingPrinted(s)}`).not.toContain(OWN_IPV4);
    });
  },
);
