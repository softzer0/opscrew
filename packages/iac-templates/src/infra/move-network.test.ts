// Feature 023 (T2313): the layouts of a move of an app with a private network and extra servers.
// Only the app server moves: the old one keeps its WireGuard port until `--finish`, and the extra
// servers keep the deploy key (and DigitalOcean's app tag) they use in every layout, so no plan
// creates a second key or deletes one from under them.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { detectEngines } from "@opscrew/iac-engine";
import { APP_SERVER, type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testCloudflare, testContext } from "../__fixtures__/plans";
import type { RenderedFile } from "../types";
import { splitPlan, type TestExtraServer, testWireGuardKey } from "./__fixtures__/servers";
import { sideTarget } from "./__fixtures__/sides";
import { MOVE_LAYOUTS, type MoveLayoutName, moveLayout, renderInfra } from "./index";

type Side = "hetzner" | "digitalocean" | "own";

/**
 * `shop` with Postgres on extra servers `servers`, its app server moving from `from` to `to`: the
 * new app member at `.3` (on port 51821 on the user's own server), the old one kept by the move.
 */
function moving(from: Side, to: Side, servers: readonly TestExtraServer[]) {
  const before = splitPlan({
    app: { provider: from, domain: "example.com" },
    servers,
  });
  const network = before.network;
  const old = network?.members.find((m) => m.name === APP_SERVER);
  if (network === undefined || old === undefined) throw new Error("no network");
  const fresh = {
    name: APP_SERVER,
    address: "10.200.4.9",
    port: to === "own" ? 51821 : 51820,
    publicKey: testWireGuardKey(9),
  };
  const plan = DeployPlanSchema.parse({
    ...before,
    target: sideTarget(to),
    network: { ...network, members: network.members.map((m) => (m === old ? fresh : m)) },
    retarget: {
      from: { target: before.target, deploy: before.deploy, member: old },
      step: "created",
      startedAt: "2026-11-06T10:00:00.000Z",
    },
  });
  /** The final plan after `--finish`: no move, the new member. */
  const { retarget: _done, ...final } = plan;
  return { before, plan, final: final as DeployPlan };
}

function render(plan: DeployPlan, layout?: MoveLayoutName): RenderedFile[] {
  const from = plan.retarget?.from.target;
  return renderInfra(
    plan,
    testContext({
      cloudflare: testCloudflare(),
      ...(layout === undefined || from === undefined
        ? {}
        : { layout: moveLayout(layout, from as never, plan.target) }),
    }),
  );
}

const mainOf = (files: readonly RenderedFile[]) =>
  files.find((f) => f.path.endsWith("/prod/main.tf"))?.content ?? "";

/** The `module "<name>" { … }` block of a root `main.tf`, or undefined. */
function moduleOf(main: string, name: string): string | undefined {
  return main.match(new RegExp(`^module "${name}" \\{$[\\s\\S]*?^\\}$`, "m"))?.[0];
}

/** The root's own resources (`resource "<type>" "<name>"`). */
function resources(main: string): string[] {
  return [...main.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`);
}

/** The root's `moved` blocks as `from -> to`. */
function moves(main: string): string[] {
  return [...main.matchAll(/^moved \{\n {2}from = (\S+)\n {2}to {3}= (\S+)\n\}$/gm)].map(
    (m) => `${m[1]} -> ${m[2]}`,
  );
}

/** An argument's value in a module block. */
function argument(block: string | undefined, name: string): string | undefined {
  return block?.match(new RegExp(`^ {2}${name} += (.+)$`, "m"))?.[1];
}

describe("the old app server's WireGuard port", () => {
  it("stays the old member's on server_previous while the new own server takes another", () => {
    const { plan } = moving("hetzner", "own", [{ name: "db", provider: "hetzner" }]);
    for (const layout of ["rename", "both", "switched", "abort-remove"] as const) {
      const previous = moduleOf(mainOf(render(plan, layout)), "server_previous");
      expect(argument(previous, "wireguard_port"), layout).toBe("51820");
    }
    // The abort renames it back to module.server, still with its own port.
    const back = moduleOf(mainOf(render(plan, "abort-rename")), "server");
    expect(argument(back, "wireguard_port")).toBe("51820");
  });

  it("gives the new cloud server the new member's port", () => {
    const { plan } = moving("digitalocean", "hetzner", [{ name: "db", provider: "digitalocean" }]);
    const network = plan.network;
    if (network === undefined) throw new Error("no network");
    const moved = DeployPlanSchema.parse({
      ...plan,
      network: {
        ...network,
        members: network.members.map((m) => (m.name === APP_SERVER ? { ...m, port: 51822 } : m)),
      },
    });
    const main = mainOf(render(moved, "both"));
    expect(argument(moduleOf(main, "server"), "wireguard_port")).toBe("51822");
    expect(argument(moduleOf(main, "server_previous"), "wireguard_port")).toBe("51820");
  });
});

describe("extra servers on the old side's provider (Hetzner app plus Hetzner db, to DigitalOcean)", () => {
  const { before, plan, final } = moving("hetzner", "digitalocean", [
    { name: "db", provider: "hetzner" },
  ]);

  it("before the move: db uses the app server's key, and the root has none", () => {
    const main = mainOf(render(before));
    expect(argument(moduleOf(main, "server_db"), "ssh_key_id")).toBe("module.server.ssh_key_id");
    expect(resources(main)).toEqual([]);
  });

  it.each(["rename", "both", "switched", "abort-remove"] as const)(
    "%s: db uses the old server's key, and the root creates none",
    (layout) => {
      const main = mainOf(render(plan, layout));
      expect(argument(moduleOf(main, "server_db"), "ssh_key_id")).toBe(
        "module.server_previous.ssh_key_id",
      );
      expect(resources(main)).toEqual([]);
      // The new DigitalOcean server keeps its own key and tag: no extra server shares them.
      expect(argument(moduleOf(main, "server"), "ssh_key_id")).toBeUndefined();
    },
  );

  it("rename: only the moved block of the app server", () => {
    expect(moves(mainOf(render(plan, "rename")))).toEqual([
      "module.server -> module.server_previous",
    ]);
  });

  it("finish: the old server's key goes to the root for db, and the root is the final one", () => {
    const main = mainOf(render(plan, "finish"));
    expect(moves(main)).toEqual([
      "module.server_previous.hcloud_ssh_key.deploy[0] -> hcloud_ssh_key.deploy",
    ]);
    expect(resources(main)).toEqual(["hcloud_ssh_key.deploy"]);
    const finalMain = mainOf(render(final));
    expect(resources(finalMain)).toEqual(resources(main));
    expect(moduleOf(main, "server_db")).toBe(moduleOf(finalMain, "server_db"));
    expect(moduleOf(main, "server")).toBe(moduleOf(finalMain, "server"));
  });

  it("abort-rename: db uses the app server's key again, as before the move", () => {
    const main = mainOf(render(plan, "abort-rename"));
    expect(moduleOf(main, "server_db")).toBe(moduleOf(mainOf(render(before)), "server_db"));
    expect(resources(main)).toEqual([]);
    expect(moves(main)).toEqual(["module.server_previous -> module.server"]);
  });
});

describe("extra servers on the new side's provider (Hetzner app plus DigitalOcean db, to DigitalOcean)", () => {
  const { before, plan, final } = moving("hetzner", "digitalocean", [
    { name: "db", provider: "digitalocean" },
  ]);
  const ROOT = ["digitalocean_ssh_key.deploy", "digitalocean_tag.app"];

  it.each(["rename", "both", "switched", "abort-remove", "abort-rename"] as const)(
    "%s: db keeps the root's key and tag, which the root still holds",
    (layout) => {
      const main = mainOf(render(plan, layout));
      expect(resources(main)).toEqual(ROOT);
      expect(moduleOf(main, "server_db")).toBe(moduleOf(mainOf(render(before)), "server_db"));
    },
  );

  it("both: the new Droplet takes the root's key and tag instead of making a second key", () => {
    const server = moduleOf(mainOf(render(plan, "both")), "server");
    expect(argument(server, "ssh_key_id")).toBe("coalesce(digitalocean_ssh_key.deploy.id)");
    expect(argument(server, "shared_tags")).toBe(
      '[digitalocean_tag.app.name, "managed-by:opscrew"]',
    );
    expect(argument(server, "app_tag")).toBeUndefined();
  });

  it("finish: the root's key and tag go to the new Droplet, and the root is the final one", () => {
    const main = mainOf(render(plan, "finish"));
    expect(moves(main)).toEqual([
      "digitalocean_ssh_key.deploy -> module.server.digitalocean_ssh_key.deploy[0]",
      "digitalocean_tag.app -> module.server.digitalocean_tag.app[0]",
    ]);
    expect(resources(main)).toEqual([]);
    const finalMain = mainOf(render(final));
    expect(moduleOf(main, "server_db")).toBe(moduleOf(finalMain, "server_db"));
    expect(moduleOf(main, "server")).toBe(moduleOf(finalMain, "server"));
  });
});

describe("a DigitalOcean app plus a DigitalOcean db, to Hetzner", () => {
  const { plan } = moving("digitalocean", "hetzner", [{ name: "db", provider: "digitalocean" }]);

  it("both: db keeps the old Droplet's key and tag, so neither is deleted nor made twice", () => {
    const db = moduleOf(mainOf(render(plan, "both")), "server_db");
    expect(argument(db, "ssh_key_id")).toBe("module.server_previous.ssh_key_id");
    expect(argument(db, "shared_tags")).toBe(
      '[module.server_previous.app_tag_name, "managed-by:opscrew"]',
    );
    expect(resources(mainOf(render(plan, "both")))).toEqual([]);
  });

  it("finish: the old Droplet's key and tag go to the root, never deleted", () => {
    expect(moves(mainOf(render(plan, "finish")))).toEqual([
      "module.server_previous.digitalocean_ssh_key.deploy[0] -> digitalocean_ssh_key.deploy",
      "module.server_previous.digitalocean_tag.app[0] -> digitalocean_tag.app",
    ]);
  });
});

describe("a move to the user's own server with a Hetzner db", () => {
  const { plan, final } = moving("hetzner", "own", [{ name: "db", provider: "hetzner" }]);

  it("finish: the old server's key goes to the root for db, as the own root holds it", () => {
    const main = mainOf(render(plan, "finish"));
    expect(moves(main)).toEqual([
      "module.server_previous.hcloud_ssh_key.deploy[0] -> hcloud_ssh_key.deploy",
    ]);
    expect(moduleOf(main, "server_db")).toBe(moduleOf(mainOf(render(final)), "server_db"));
  });
});

// Downloads the hcloud, digitalocean and cloudflare providers, so only with OPSCREW_IT=1.
const runIt = process.env.OPSCREW_IT === "1";
const detected = runIt ? await detectEngines() : [];

describe.skipIf(!runIt)("the move layouts with extra servers validate (integration)", () => {
  const cases = [
    moving("hetzner", "digitalocean", [{ name: "db", provider: "hetzner" }]),
    moving("hetzner", "digitalocean", [{ name: "db", provider: "digitalocean" }]),
    moving("hetzner", "own", [{ name: "db", provider: "hetzner" }]),
  ];
  for (const name of ["tofu", "terraform"] as const) {
    const engine = detected.find((d) => d.name === name && d.supported);
    it.skipIf(!engine)(
      `validates every layout with ${name}`,
      async () => {
        const runner = new NodeCommandRunner();
        for (const [i, { plan }] of cases.entries()) {
          for (const layout of MOVE_LAYOUTS) {
            const root = await mkdtemp(join(tmpdir(), `opscrew-move-net-${name}-`));
            const files = render(plan, layout);
            for (const file of files) {
              await mkdir(dirname(join(root, file.path)), { recursive: true });
              await writeFile(join(root, file.path), file.content);
            }
            const cwd = join(root, "opscrew/infra/prod");
            const bin = engine?.binary ?? name;
            const init = await runner.run(bin, ["init", "-backend=false", "-no-color"], { cwd });
            expect(init.exitCode, `${i} ${layout}: ${init.stderr}`).toBe(0);
            const valid = await runner.run(bin, ["validate", "-no-color"], { cwd });
            expect(valid.exitCode, `${i} ${layout}: ${valid.stdout}${valid.stderr}`).toBe(0);
          }
        }
      },
      900_000,
    );
  }
});
