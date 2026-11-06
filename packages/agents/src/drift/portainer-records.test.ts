import type { IacEngine, IacRunOptions, ResourceDrift } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { updateServerAddresses } from "../shared";
import { writeFakeState } from "../testing";
import {
  deployImage,
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
} from "./__fixtures__/portainer-project";
import { runDrift } from "./run";

/** The Portainer host's public address, as a move recorded it (an example address). */
const HOST = { ipv4: "203.0.113.40", ipv6: "2001:db8:40::1" };

/** The app's record, changed by hand in Cloudflare. */
const CHANGED: ResourceDrift = {
  address: "module.dns.cloudflare_dns_record.apex_a",
  type: "cloudflare_dns_record",
  name: "apex_a",
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action: "update",
  attributes: ["content"],
};

describe.skipIf(!findExecutable("git"))(
  "opscrew drift for a Portainer whose records OpsCrew manages",
  () => {
    it("compares the app's records, with the host's address only as TF_VAR", async () => {
      const s = await portainerProject({
        plan: portainerPlan({ web: { mode: "caddy", records: true } }),
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
      Object.assign(s.engine, {
        plan: async (
          dir: string,
          file: string,
          options?: IacRunOptions & { refreshOnly?: boolean },
        ) => {
          seen.push({
            ipv4: options?.env?.TF_VAR_server_ipv4,
            ipv6: options?.env?.TF_VAR_server_ipv6,
          });
          const summary = await plan(dir, file, options);
          return options?.refreshOnly === true ? { ...summary, drift: [CHANGED] } : summary;
        },
      });

      const report = await runDrift(s.deps, { services: s.services });
      expect(seen.length).toBeGreaterThan(0);
      for (const address of seen) expect(address).toEqual(HOST);
      expect(report.drift).toEqual([CHANGED]);
      // The records are this setup's, not an earlier setup's left in the state.
      expect(JSON.stringify(report)).not.toContain("an earlier setup");
    });
  },
);
