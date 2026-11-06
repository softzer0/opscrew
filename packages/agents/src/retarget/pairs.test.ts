import { readFile } from "node:fs/promises";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { OLD_IPV4, PORTAINER_URL } from "../testing";
import {
  DB_PASSWORD,
  NEW_IPV4,
  type PairHarness,
  type PairSide,
  PORTAINER,
  PORTAINER_TOKEN,
  pairHarness,
} from "./__fixtures__/pairs";
import { maintenanceWindow } from "./window";

/** Every pair of sides a move goes between, and the move between two clouds. */
const PAIRS: readonly [PairSide, PairSide][] = [
  ["hetzner", "own"],
  ["own", "hetzner"],
  ["own", "own"],
  ["hetzner", "portainer"],
  ["portainer", "hetzner"],
  ["own", "portainer"],
  ["portainer", "own"],
  ["hetzner", "digitalocean"],
];

const DUMP_VOLUME = "opscrew-move-dump-shop";

/** The containers of `service` on a side's Docker, by their state. */
function states(h: PairHarness, host: string, service: string): string[] {
  return [...h.hosts.docker(host).containers.values()]
    .filter((c) => c.labels["com.docker.compose.service"] === service)
    .map((c) => c.state);
}

/** The cache's files on a side: a folder on a server, a volume in Portainer. */
function cacheFiles(h: PairHarness, host: string): string[] {
  const docker = h.hosts.docker(host);
  const files =
    host === PORTAINER
      ? docker.volumes.get("opscrew-shop_cache_data")?.files
      : docker.folders.get("/srv/data/shop/cache")?.files;
  return [...(files?.keys() ?? [])].sort();
}

/** Everything a run showed, audited or asked for approval. */
function shown(h: PairHarness, error?: unknown): string {
  return [
    h.reporter.text(),
    JSON.stringify(h.audit.entries),
    JSON.stringify(h.handler.requests),
    error instanceof OpsCrewError ? `${error.message} ${error.hint ?? ""}` : "",
  ].join("\n");
}

describe.skipIf(!findExecutable("git"))("the maintenance window, for every pair of sides", () => {
  it.each(PAIRS)(
    "%s to %s: copies each mount and the database, checked on both sides, then the app starts there",
    async (from, to) => {
      const h = await pairHarness(from, to, { cache: true });
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
      expect(h.session.plan.retarget?.step).toBe("migrated");
      expect(h.session.plan.retarget?.oldAppStoppedAt).toBeDefined();
      // The database by its dump, the cache by its files.
      expect(h.hosts.host(h.newHost).db).toBe("orders before the move");
      expect(cacheFiles(h, h.newHost)).toEqual(cacheFiles(h, h.oldHost));
      expect(cacheFiles(h, h.newHost)).toContain("dump.rdb");
      for (const host of [h.oldHost, h.newHost]) {
        expect(h.hosts.docker(host).volumes.has(DUMP_VOLUME)).toBe(false);
      }
      // The old side's services stopped cleanly and stay stopped with its app.
      expect(states(h, h.oldHost, "db")).toEqual(["exited"]);
      const window = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
      expect(window?.details).toContain("cache's data at /var/lib/postgresql/data");
      expect(window?.details).toContain("the database dump");
      expect(shown(h)).not.toContain(OLD_IPV4);
      expect(shown(h)).not.toContain(NEW_IPV4);
    },
  );

  it("SC-2302: a copy that fails leaves the old side serving with its data unchanged, and empties what it wrote", async () => {
    const h = await pairHarness("own", "portainer", { cache: true });
    const oldCache = cacheFiles(h, h.oldHost);
    // The new side's Docker refuses the write of the cache's files.
    h.hosts.docker(PORTAINER).fail("PUT", /\/archive/, 500, "no space left on device");
    const error = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toContain("The maintenance window failed");
    expect((error as OpsCrewError).message).toContain(
      "The app on your old server runs again with its data unchanged",
    );
    expect(h.session.plan.retarget?.step).toBe("deployed");
    expect(h.session.plan.retarget?.oldAppStoppedAt).toBeUndefined();
    // The old side serves again, its data as it was.
    expect(h.hosts.host(OLD_IPV4)).toMatchObject({ app: true, db: "orders before the move" });
    expect(states(h, OLD_IPV4, "db")).toEqual(["running"]);
    expect(states(h, OLD_IPV4, "cache")).toEqual(["running"]);
    expect(cacheFiles(h, h.oldHost)).toEqual(oldCache);
    // The new side's mount the copy wrote to is empty again; no dump volume is left.
    expect(cacheFiles(h, PORTAINER)).toEqual([""]);
    for (const host of [OLD_IPV4, PORTAINER]) {
      expect(h.hosts.docker(host).volumes.has(DUMP_VOLUME)).toBe(false);
    }
    expect(h.audit.entries).toContainEqual(
      expect.objectContaining({ action: "maintenance window", decision: "refused" }),
    );

    // The next window copies everything again.
    expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
    expect(cacheFiles(h, PORTAINER)).toEqual(oldCache);
  });

  it("T2306: a database Docker killed when it stopped in Portainer fails the window, nothing copied", async () => {
    const h = await pairHarness("portainer", "own");
    for (const container of h.hosts.docker(PORTAINER).containers.values()) {
      if (container.labels["com.docker.compose.service"] === "db") container.exitCode = 137;
    }
    const error = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
      (e: unknown) => e,
    );
    expect((error as OpsCrewError).message).toContain("db did not stop cleanly on your Portainer");
    expect(h.hosts.host(NEW_IPV4).db).not.toBe("orders before the move");
    expect(h.session.plan.retarget?.step).toBe("deployed");
  });

  it("stops before any change when the new side has no place for a mount of the old side's", async () => {
    const h = await pairHarness("hetzner", "own", { cache: true });
    // The new side's deploy has no cache yet.
    const fresh = h.hosts.docker(NEW_IPV4);
    for (const [id, container] of fresh.containers) {
      if (container.labels["com.docker.compose.service"] === "cache") fresh.containers.delete(id);
    }
    const error = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("Your new server has no place for cache's data"),
    });
    expect(h.handler.requests.some((r) => r.title.startsWith("Maintenance"))).toBe(false);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });

  it("leaks no token, password, key or address, also when the window fails", async () => {
    for (const [from, to] of [
      ["own", "portainer"],
      ["portainer", "own"],
    ] as const) {
      const h = await pairHarness(from, to, { cache: true });
      await maintenanceWindow(h.session, { allowDowntime: true });
      const failed = await pairHarness(from, to, { cache: true });
      failed.hosts.docker(failed.newHost).fail("PUT", /\/archive/, 500, "disk full");
      const error = await maintenanceWindow(failed.session, { allowDowntime: true }).catch(
        (e: unknown) => e,
      );
      const key = (await readFile(h.session.deployKey.privateKeyFile, "utf8")).trim();
      for (const text of [shown(h), shown(failed, error)]) {
        for (const secret of [
          OLD_IPV4,
          NEW_IPV4,
          DB_PASSWORD,
          PORTAINER_TOKEN,
          key,
          new URL(PORTAINER_URL).hostname,
        ]) {
          expect(text).not.toContain(secret);
        }
      }
    }
  });
});
