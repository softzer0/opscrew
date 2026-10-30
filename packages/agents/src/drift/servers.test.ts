import {
  type HostFacts,
  networkFileHashes,
  networkFilterFileHashes,
  networkUfwRules,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import { renderServerCompose } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { networkSteps, serverNetworkInputs } from "../network";
import { APP_HOST, DATA_HOST, splitWorld } from "../status/__fixtures__/split";
import { freshFacts } from "../testing";
import { serversDrift } from "./servers";

const NO_NETWORK: NonNullable<HostFacts["network"]> = {
  dropIn: null,
  interfaces: [],
  filterUnit: null,
  filters: [],
};

/** A server OpsCrew created as inspection reports it, through Docker, with the app's folder. */
function serverFacts(extra: Partial<HostFacts> = {}): HostFacts {
  return {
    ...freshFacts({ user: "deploy", privilege: "docker" }),
    dirs: [{ path: "/srv/apps/shop", kind: "dir", owner: "deploy", group: "deploy", mode: "750" }],
    network: NO_NETWORK,
    ...extra,
  };
}

describe("serversDrift: every server of a split app (US2 #4)", () => {
  it("names the server of each difference: the network's steps, the Compose file, env files and containers", async () => {
    const world = await splitWorld();
    const compose = renderServerCompose(world.plan, "data");
    const inspected: { host: string; rootImage?: string }[] = [];
    const facts: Record<string, HostFacts> = {
      [APP_HOST]: serverFacts(),
      [DATA_HOST]: serverFacts({
        runtimeFiles: [
          { app: "shop", name: "compose.yaml", kind: "file", sha256: sha256Hex("edited") },
          {
            app: "shop",
            name: "db.env",
            kind: "file",
            owner: "deploy",
            group: "deploy",
            mode: "644",
            sha256: null,
          },
        ],
        containers: [{ name: "shop-db-1", project: "shop", ports: "", running: false }],
      }),
    };
    const notes: string[] = [];
    const differences = await serversDrift(world.deps, world.plan, notes, {
      services: { remote: world.remote },
      inspect: async (remote: RemoteExec, options) => {
        inspected.push({ host: remote.host, ...options });
        return facts[remote.host] as HostFacts;
      },
    });
    expect(notes).toEqual([]);
    // Both servers OpsCrew created are read as root through Docker, with the pinned image.
    expect(inspected.map((i) => i.host)).toEqual([APP_HOST, DATA_HOST]);
    expect(inspected.every((i) => i.rootImage !== undefined)).toBe(true);
    const lines = differences.map((d) => `${d.title}: ${d.detail}`);
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^Server app: The private network \(WireGuard\): The WireGuard interface wg-opscrew\d+ is missing/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^Server data: The private network \(WireGuard\): The WireGuard interface wg-opscrew\d+ is missing/,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^Server data: The private network's filter .*: The private network's filter on wg-opscrew\d+ is missing/,
      ),
    );
    expect(lines).toContainEqual(
      "Server data: OpsCrew's runtime files of the app: /srv/apps/shop/compose.yaml differs from what OpsCrew renders from opscrew/plan.yaml now: it was edited on the server, or the deploy workflow has not copied the current version yet. Re-run the latest run of the deploy workflow in GitHub Actions (or push a commit): it copies OpsCrew's version to the server.",
    );
    expect(
      lines.some((l) => l.startsWith("Server data:") && l.includes("db.env holds secrets")),
    ).toBe(true);
    expect(lines).toContain("Server data: The app's containers: shop-db-1 is stopped.");
    // Nothing about the app's own components on the extra server.
    expect(lines.some((l) => l.startsWith("Server data:") && l.includes("(web)"))).toBe(false);
    expect(differences.every((d) => /^Server (app|data): /.test(d.title))).toBe(true);
    expect(JSON.stringify(differences)).not.toContain(DATA_HOST);
    expect(compose.path).toContain("data");
  });

  it("finds nothing on an extra server whose Compose file and containers are OpsCrew's", async () => {
    const world = await splitWorld();
    const compose = renderServerCompose(world.plan, "data");
    const differences = await serversDrift(world.deps, world.plan, [], {
      services: { remote: world.remote },
      inspect: async (remote) =>
        remote.host === DATA_HOST
          ? serverFacts({
              network: null,
              runtimeFiles: [
                {
                  app: "shop",
                  name: "compose.yaml",
                  kind: "file",
                  sha256: sha256Hex(compose.content),
                },
                {
                  app: "shop",
                  name: "db.env",
                  kind: "file",
                  owner: "deploy",
                  group: "deploy",
                  mode: "600",
                  sha256: null,
                },
              ],
              containers: [{ name: "shop-db-1", project: "shop", ports: "", running: true }],
            })
          : serverFacts({ network: null }),
    });
    expect(differences).toEqual([]);
  });

  it("says when a server's network state could not be read, and when a server is unreachable", async () => {
    const world = await splitWorld();
    const notes: string[] = [];
    const differences = await serversDrift(world.deps, world.plan, notes, {
      services: { remote: world.remote },
      inspect: async (remote) => {
        if (remote.host === DATA_HOST) {
          throw new OpsCrewError("COMMAND_FAILED", "OpsCrew could not read the server's state.");
        }
        return serverFacts({ network: null });
      },
    });
    expect(differences).toEqual([]);
    expect(notes[0]).toContain("could not read the private network's state on server app");
    expect(notes[1]).toMatch(/^OpsCrew could not compare server data\./);
  });

  it("reads no server for a plan without a private network", async () => {
    const world = await splitWorld();
    const { network: _none, servers: _servers, ...rest } = world.plan;
    const services = rest.services.map(({ server: _s, ...s }) => s);
    const differences = await serversDrift(
      world.deps,
      { ...rest, services } as typeof world.plan,
      [],
      {
        services: { remote: world.remote },
        inspect: async () => {
          throw new Error("no inspection");
        },
      },
    );
    expect(differences).toEqual([]);
    expect(world.commands).toEqual([]);
  });

  it("finds no difference when every server's network and filter are as the plan wants", async () => {
    const world = await splitWorld();
    const plan = world.plan;
    /** `facts` with the server's network, filter and ufw rules exactly as provision plans them. */
    const inPlace = (name: string, facts: HostFacts): HostFacts => {
      const { published, localPorts } = serverNetworkInputs(plan, name, true);
      const steps = networkSteps(plan, name, {
        endpoints: { app: APP_HOST, data: DATA_HOST },
        wireguardInterfaces: facts.wireguardInterfaces,
        published,
        sshPort: 22,
      });
      const network = { ...steps.network, localPorts };
      const files = networkFileHashes(network);
      const filter = networkFilterFileHashes(steps.filter);
      return {
        ...facts,
        webFilter: { ...facts.webFilter, backend: "iptables" },
        firewall: { ...facts.firewall, ufw: "active", ufwRules: networkUfwRules(network) },
        network: {
          dropIn: files.dropIn,
          interfaces: [
            {
              name: network.interface,
              config: files.config,
              publicKey: network.publicKey,
              enabled: true,
              active: true,
              addresses: [network.address],
              peers: network.peers.map((peer) => peer.publicKey),
            },
          ],
          filterUnit: filter.unit,
          filters:
            steps.filter.rules.length === 0
              ? []
              : [
                  {
                    name: network.interface,
                    script: filter.script,
                    dropIn: filter.dropIn,
                    enabled: true,
                    active: true,
                    jump: true,
                    rules: steps.filter.rules,
                  },
                ],
        },
      };
    };
    const compose = renderServerCompose(plan, "data");
    const notes: string[] = [];
    const differences = await serversDrift(world.deps, plan, notes, {
      services: { remote: world.remote },
      inspect: async (remote) =>
        remote.host === DATA_HOST
          ? inPlace(
              "data",
              serverFacts({
                runtimeFiles: [
                  {
                    app: "shop",
                    name: "compose.yaml",
                    kind: "file",
                    sha256: sha256Hex(compose.content),
                  },
                  {
                    app: "shop",
                    name: "db.env",
                    kind: "file",
                    owner: "deploy",
                    group: "deploy",
                    mode: "600",
                    sha256: null,
                  },
                ],
                containers: [{ name: "shop-db-1", project: "shop", ports: "", running: true }],
              }),
            )
          : inPlace("app", serverFacts()),
    });
    expect(notes).toEqual([]);
    expect(differences).toEqual([]);
  });
});
