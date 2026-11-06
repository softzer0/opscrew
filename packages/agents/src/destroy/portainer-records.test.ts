import { rm } from "node:fs/promises";
import type { IacEngine, IacRunOptions, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  deployImage,
  type PortainerProject,
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
} from "../drift/__fixtures__/portainer-project";
import { updateServerAddresses } from "../shared";
import { tunnelDeletePlanJson } from "../shared/__fixtures__/tunnel";
import { writeFakeState } from "../testing";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

/** The Portainer host's public address, as a move recorded it (an example address). */
const HOST = { ipv4: "203.0.113.40", ipv6: "2001:db8:40::1" };

/** What the destroy plan of the root's `module "dns"` deletes: the app's records. */
const RECORDS: ResourceChange[] = ["apex_a", "apex_aaaa"].map((name) => ({
  address: `module.dns.cloudflare_dns_record.${name}`,
  type: "cloudflare_dns_record",
  name,
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action: "delete",
}));

/**
 * A deployed Portainer project whose Cloudflare root manages the app's records. `events` lists the
 * typed confirmation, approvals, and the engine's destroy plans and applies in order; `seen` the
 * address each destroy plan was given.
 */
async function deployed() {
  const events: string[] = [];
  const s = await portainerProject({
    plan: portainerPlan({ web: { mode: "caddy", records: true } }),
    answer: (request) => {
      events.push(`approve:${request.kind}`);
      return true;
    },
  });
  await updateServerAddresses(s.deps.paths, (current) => ({ ...current, deployment: HOST }));
  // A public resolver finds the records pointing at the host, which Caddy's certificates need.
  const fetch = s.deps.fetch;
  s.deps.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (`${parsed.origin}${parsed.pathname}` !== "https://cloudflare-dns.com/dns-query") {
      return fetch(url, init);
    }
    const name = parsed.searchParams.get("name") ?? "";
    const type = parsed.searchParams.get("type") === "AAAA" ? 28 : 1;
    const data = type === 28 ? HOST.ipv6 : HOST.ipv4;
    return new Response(JSON.stringify({ Status: 0, Answer: [{ name, type, TTL: 60, data }] }));
  };
  await provisionPortainerProject(s);
  await deployImage(s);
  // The root's state holds the records (the move adopted them).
  await writeFakeState(s.deps.paths);
  const seen: Record<string, string | undefined>[] = [];
  const engine: IacEngine = s.engine;
  const plan = engine.plan.bind(engine);
  const apply = s.engine.apply.bind(s.engine);
  Object.assign(s.engine, {
    plan: async (dir: string, file: string, options?: IacRunOptions & { destroy?: boolean }) => {
      const summary = await plan(dir, file, options);
      if (options?.destroy !== true) return summary;
      events.push("iac-plan:destroy");
      seen.push({ ipv4: options.env?.TF_VAR_server_ipv4, ipv6: options.env?.TF_VAR_server_ipv6 });
      return {
        ...summary,
        changes: RECORDS,
        hasDestroy: true,
        planJson: tunnelDeletePlanJson(RECORDS),
      };
    },
    apply: async (...args: Parameters<typeof apply>) => {
      events.push("iac-apply");
      return apply(...args);
    },
  });
  s.deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "destroy");
  events.length = 0;
  return Object.assign(s, { events, seen });
}

function services(s: PortainerProject): DestroyServices {
  return {
    engine: s.services.engine,
    github: s.github,
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    sleep: async () => undefined,
    portainer: {
      ...(s.services.portainer?.client !== undefined
        ? { client: s.services.portainer.client }
        : {}),
      wait: { now: () => 0, sleep: async () => undefined },
    },
  };
}

describe.skipIf(!findExecutable("git"))(
  "opscrew destroy for a Portainer whose records OpsCrew manages",
  () => {
    it("deletes the app's records with the rest, after the typed name, under the plan's approval", async () => {
      const s = await deployed();
      const result = await runDestroy(s.deps, {
        services: services(s),
        confirm: async (preview) => {
          s.events.push("confirm");
          expect(preview.resources.map((change) => change.address)).toEqual(
            RECORDS.map((change) => change.address),
          );
          return true;
        },
      });
      // The host's address reached the engine only as TF_VAR, as in provision.
      expect(s.seen.length).toBeGreaterThan(0);
      for (const address of s.seen) expect(address).toEqual(HOST);
      const confirm = s.events.indexOf("confirm");
      expect(confirm).toBeGreaterThan(s.events.indexOf("iac-plan:destroy"));
      expect(s.events.indexOf("approve:iac-apply")).toBeGreaterThan(confirm);
      expect(s.events.indexOf("iac-apply")).toBeGreaterThan(s.events.indexOf("approve:iac-apply"));
      const approval = s.handler.requests.find((request) => request.kind === "iac-apply");
      expect(approval).toMatchObject({ allowDestroy: true });
      expect(result.destroyed.map((change) => change.address)).toEqual(
        RECORDS.map((change) => change.address),
      );
    });

    it("stops before any change when the state for the records is missing", async () => {
      const s = await deployed();
      await rm(s.deps.paths.files.tfstateDir, { recursive: true, force: true });
      const mutations = s.fake.mutations().length;
      const error = await runDestroy(s.deps, { services: services(s) }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).code).toBe("PHASE_PRECONDITION");
      expect(s.fake.mutations()).toHaveLength(mutations);
      expect(s.events).toEqual([]);
    });
  },
);
