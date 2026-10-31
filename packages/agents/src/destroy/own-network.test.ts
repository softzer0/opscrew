import { rm } from "node:fs/promises";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, CommandResult, RemoteExec } from "@opscrew/contracts";
import { findExecutable, type OpsCrewError, tfstateFile } from "@opscrew/core";
import { networkInterface, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ownProject, provisionOwn } from "../drift/__fixtures__/own-project";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { readServerAddresses, updateServerAddresses } from "../shared/server-record";
import { FakeServers, serverAttributes, testKeyMaker } from "../testing";
import { runDestroy } from "./run";
import type { DestroyServices } from "./types";

/** A shell whose privilege probe says root; every other command succeeds quietly. */
function rootShell(host: string): RemoteExec {
  return {
    host,
    async run(command): Promise<CommandResult> {
      const stdout = command.includes("echo sudo-password") ? "root\n" : "";
      return { exitCode: 0, stdout, stderr: "" };
    },
  };
}

describe.skipIf(!findExecutable("git"))(
  "runDestroy on the user's own server with a private network",
  () => {
    it("reopens public SSH first, then removes the network and its filter with the rest of the app", async () => {
      const s = await ownProject();
      await provisionOwn(s);
      const provisioned = await readArtifact("plan", s.deps.paths.files.plan);
      const keys = testKeyMaker();
      const network = allocateNetwork(
        provisioned,
        { app: { udpPortsInUse: [], wireguardInterfaces: [] } },
        keys,
      ).network;
      const prefix = network.range.split(".").slice(0, 3).join(".");
      const plan = {
        ...provisioned,
        security: { ...provisioned.security, sshAllowedCidrs: [] },
        network: {
          ...network,
          devices: [
            {
              name: "laptop",
              address: `${prefix}.100`,
              publicKey: keys().publicKey,
              addedAt: "2026-10-30T10:00:00.000Z",
            },
          ],
          publicSsh: false,
          publicSshAllowedCidrs: ["198.51.100.0/24"],
        },
      };
      await writeArtifact("plan", s.deps.paths.files.plan, plan);
      const iface = networkInterface(network.members[0] ?? { port: 51820 });
      const facts = structuredClone(s.host.facts);
      if (facts.record !== null) facts.record.networks = { [iface]: "shop" };
      // Public SSH is closed: only the rule on the network's interface lets SSH in.
      facts.firewall.ufw = "active";
      facts.firewall.ufwRules = [
        ...facts.firewall.ufwRules.filter((rule) => !/22\/tcp|port 22 /.test(rule.rule)),
        { rule: `allow in on ${iface} to any port 22 proto tcp`, comment: "opscrew-network-ssh" },
      ];
      s.host.facts = HostFactsSchema.parse(facts);
      const before = s.host.applies.length;

      await runDestroy(s.deps, {
        services: {
          engine: s.services.engine,
          github: s.github,
          cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
          ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
          own: { ...s.services.own, verifyLogin: async () => true },
          remote: rootShell,
        },
        confirm: async () => true,
      });

      const applied = s.host.applies.slice(before).map((a) => ({
        purpose: a.plan.purpose,
        steps: a.plan.steps.filter((step) => step.state === "change").map((step) => step.id),
      }));
      // Public SSH first (the network's removal deletes the SSH rule on its interface), then the
      // teardown, which removes the network's filter and interface with the app.
      expect(applied[0]).toEqual({ purpose: "setup", steps: ["public-ssh"] });
      // Opened to the allow-list the plan held before public SSH closed.
      expect(s.host.applies[before]?.plan.steps[0]?.params.allowedCidrs).toBe("198.51.100.0/24");
      expect(applied[1]?.purpose).toBe("teardown");
      expect(applied[1]?.steps).toEqual(expect.arrayContaining(["network-filter", "network"]));
      const removal = s.host.applies[before + 1]?.plan.steps.filter(
        (step) => step.id === "network",
      );
      expect(removal?.map((step) => step.params.interface)).toEqual([iface]);
      const after = await readArtifact("plan", s.deps.paths.files.plan);
      expect(after.network?.publicSsh).toBe(true);
      expect(after.security.sshAllowedCidrs).toEqual(["198.51.100.0/24"]);
      expect(after.network?.publicSshAllowedCidrs).toBeUndefined();
      expect(after.deployment.destroyedAt).toBeDefined();
    });

    it("deletes an extra Hetzner server in the same root after its typed name, its snapshot taken and its protection lifted first", async () => {
      const w = await splitOwnProject();
      const asked: string[] = [];
      const result = await runDestroy(w.s.deps, {
        services: w.services,
        confirm: async (preview) => {
          asked.push(preview.name);
          return true;
        },
      });
      expect(asked).toEqual(["shop", "shop-data"]);
      expect(
        w.plans.every((vars) => vars === JSON.stringify({ data_delete_protection: "false" })),
      ).toBe(true);
      const titles = w.s.handler.requests.map((r) => r.title);
      expect(titles).toContain("Lift delete protection on shop-data");
      expect(titles).toContainEqual(
        expect.stringContaining("DNS records on Cloudflare and the server shop-data"),
      );
      // The database's server gets its snapshot first (auto: Postgres is on it).
      expect(w.snapshots.snapshots.map((snapshot) => snapshot.name)).toEqual([
        expect.stringMatching(/^opscrew-shop-data-before-destroy-/),
      ]);
      expect(result.remaining.join("\n")).toContain("The snapshot of shop-data");
      expect((await readServerAddresses(w.s.deps.paths)).servers).toBeUndefined();
    });

    it("says the protection is lifted when the teardown stops before the server goes", async () => {
      const w = await splitOwnProject();
      w.answer((request) => !request.title.startsWith("Delete the DNS records"));
      const error = await runDestroy(w.s.deps, {
        services: w.services,
        snapshot: false,
        confirm: async () => true,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
      expect((error as OpsCrewError).message).toContain(
        "Nothing was deleted. Delete protection on shop-data is already lifted, so it is not protected against deletion now.",
      );
      expect((error as OpsCrewError).hint).toMatch(
        /^Run `opscrew provision` to turn delete protection back on, or run `opscrew destroy` again/,
      );
    });

    it("refuses without the infrastructure state here, before anything changes", async () => {
      const w = await splitOwnProject();
      await rm(tfstateFile(w.s.deps.paths), { force: true });
      const applies = w.s.host.applies.length;
      const error = await runDestroy(w.s.deps, {
        services: w.services,
        confirm: async () => true,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION" });
      expect(w.s.host.applies).toHaveLength(applies);
      expect(w.s.handler.requests).toEqual([]);
      expect((await readServerAddresses(w.s.deps.paths)).servers?.data?.ipv4).toBe(DATA_HOST);
    });
  },
);

const DATA_HOST = "203.0.113.20";

/**
 * A provisioned project on the user's own server whose Postgres then moved to a Hetzner server
 * `data` in the same root module: the engine plans its protection, then its deletion with the
 * DNS record; `plans` lists each plan's `-var`s.
 */
async function splitOwnProject() {
  let answer: (request: ApprovalRequest) => boolean = () => true;
  const s = await ownProject({ answer: (request) => answer(request) });
  await provisionOwn(s);
  const provisioned = await readArtifact("plan", s.deps.paths.files.plan);
  const base = {
    ...provisioned,
    servers: splitPlan({ app: "own" }).servers,
    services: provisioned.services.map((service) =>
      service.name === "db" ? { ...service, server: "data" } : service,
    ),
  };
  const plan = withNetwork(
    base,
    allocateNetwork(base, { app: { udpPortsInUse: [], wireguardInterfaces: [] } }, testKeyMaker())
      .network,
  );
  await writeArtifact("plan", s.deps.paths.files.plan, plan);
  await updateServerAddresses(s.deps.paths, (current) => ({
    ...current,
    servers: { data: { ipv4: DATA_HOST } },
  }));
  const engine = s.engine;
  const data = (type: string, action: "update" | "delete") => ({
    address: `module.server_data.${type}.this`,
    type,
    name: "this",
    provider: "registry.opentofu.org/hetznercloud/hcloud",
    action,
  });
  engine.changes = [data("hcloud_server", "update")];
  const plans: string[] = [];
  const plan0 = engine.plan.bind(engine);
  engine.plan = async (dir, file, options) => {
    const summary = await plan0(dir, file, options);
    plans.push(JSON.stringify(options?.vars ?? {}));
    if (options?.destroy === true && summary.changes.length > 0) {
      const changes = [
        ...summary.changes,
        data("hcloud_firewall", "delete"),
        data("hcloud_server", "delete"),
      ];
      const server = {
        address: "module.server_data.hcloud_server.this",
        type: "hcloud_server",
        change: { actions: ["delete"], before: { id: "4711", name: "shop-data" }, after: null },
      };
      return { ...summary, changes, planJson: { resource_changes: [server] } };
    }
    if (options?.destroy !== true && summary.changes.length > 0) {
      const before = serverAttributes({ name: "shop-data" });
      const after = { ...before, delete_protection: false, rebuild_protection: false };
      return {
        ...summary,
        planJson: {
          resource_changes: [
            {
              address: "module.server_data.hcloud_server.this",
              type: "hcloud_server",
              change: { actions: ["update"], before, after, after_unknown: {} },
            },
          ],
        },
      };
    }
    return summary;
  };
  const apply0 = engine.apply.bind(engine);
  engine.apply = async (dir, file, approval, options) => {
    const result = await apply0(dir, file, approval, options);
    engine.changes = [];
    return result;
  };
  const snapshots = new FakeServers();
  const services: DestroyServices = {
    engine: s.services.engine,
    github: s.github,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    cloudflare: { verifyToken: async () => ({ ok: true, message: "ok" }) },
    servers: snapshots,
    sleep: async () => undefined,
    ...(s.services.sharedCloudflare ? { sharedCloudflare: s.services.sharedCloudflare } : {}),
    ...(s.services.own !== undefined ? { own: s.services.own } : {}),
  };
  return {
    s,
    plans,
    services,
    snapshots,
    answer: (next: (request: ApprovalRequest) => boolean) => {
      answer = next;
    },
  };
}
