import type { IacRunOptions } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import {
  portainerPlan,
  portainerProject,
  provisionPortainerProject,
} from "../drift/__fixtures__/portainer-project";
import { updateServerAddresses } from "../shared";

/** The Portainer host's public address, as a move recorded it (an example address). */
const HOST = { ipv4: "203.0.113.40", ipv6: "2001:db8:40::1" };

describe.skipIf(!findExecutable("git"))(
  "provision of a Portainer whose records OpsCrew manages",
  () => {
    it("gives the engine the Portainer host's recorded address as TF_VAR, never a file", async () => {
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
      const seen: Record<string, string | undefined>[] = [];
      const plan = s.engine.plan.bind(s.engine);
      Object.assign(s.engine, {
        plan: async (dir: string, file: string, options?: IacRunOptions) => {
          seen.push({
            ipv4: options?.env?.TF_VAR_server_ipv4,
            ipv6: options?.env?.TF_VAR_server_ipv6,
          });
          return plan(dir, file);
        },
      });
      await provisionPortainerProject(s);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen).toContainEqual(HOST);
    });
  },
);
