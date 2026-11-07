import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandResult } from "@opscrew/contracts";
import { SNAPSHOT_SCRIPT, snapshotScript } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { appFolder, localRoots } from "../localhost/services";
import { runProvision } from "../provision";
import { SH_AVAILABLE } from "./__fixtures__/server";
import { listSnapshots } from "./list";
import { takeSnapshot } from "./take";

const ID = "20261011T120000Z";

/** `shop` on this computer with PostgreSQL, taking a snapshot before each release. */
function plan() {
  const local = localPlan();
  return DeployPlanSchema.parse({ ...local, deploy: { ...local.deploy, snapshots: true } });
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

describe.skipIf(!SH_AVAILABLE)("snapshots on this computer", () => {
  it("has snapshot.sh in the app's folder at each deploy, and takes and lists snapshots there", async () => {
    const computer = new FakeComputer();
    const { deps, root } = await localProject(plan(), computer);
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    const folder = appFolder(deps.paths, plan());
    const script = `${snapshotScript(plan()).join("\n")}\n`;
    let tag = "0123456789ab";
    const atStart: (string | undefined)[] = [];
    computer.script = (text) => {
      if (text.includes("docker build")) return ok(`opscrew-local/shop:${tag}\n`);
      if (text.includes("docker compose pull")) {
        const path = join(folder, SNAPSHOT_SCRIPT);
        atStart.push(existsSync(path) ? readFileSync(path, "utf8") : undefined);
      }
      return ok();
    };
    const provision = () => runProvision(deps, { services: { localhost: computer.services() } });

    // The first deploy, and what its start script leaves; then a second, of a new build, whose
    // start script reads snapshot.sh to take the snapshot before its release.
    await provision();
    computer.deployed();
    await writeFile(join(folder, ".env"), `APP_IMAGE=opscrew-local/shop:${tag}\n`);
    const tls = join(localRoots(deps.paths).edge, "tls", "shop");
    await rename(join(tls, "local.pem.new"), join(tls, "local.pem"));
    await rename(join(tls, "local.key.new"), join(tls, "local.key"));
    tag = "fedcba987654";
    await provision();
    expect(atStart).toEqual([script, script]);
    const start = computer.scripts.filter((run) => run.script.includes("docker compose pull"));
    expect(start.at(-1)?.script).toContain(`. ./${SNAPSHOT_SCRIPT}`);

    // `opscrew snapshot` and `snapshot list` run it in the app's folder: a take (its copies need
    // Docker, so its effect is played here), and the real script's list.
    const apps = localRoots(deps.paths).apps.replaceAll("\\", "/");
    computer.script = (text) => {
      if (text.includes("'take'")) {
        mkdirSync(join(folder, ".snapshots", ID), { recursive: true });
        writeFileSync(
          join(folder, ".snapshots", ID, "about.json"),
          `${JSON.stringify({
            id: ID,
            kind: "manual",
            taken: "2026-10-11T12:00:00Z",
            version: "",
            services: [{ name: "db", kind: "postgres", file: "db.dump", size: 42 }],
          })}\n`,
        );
        return ok(`${ID}\n`);
      }
      const df =
        "df() { printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/disk 41943040 0 20971520 50%% /\\n'; }";
      const run = spawnSync("sh", ["-c", `${df}\n${text}`], {
        encoding: "utf8",
        env: { ...process.env, OPSCREW_APPS_DIR: apps },
      });
      return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
    };
    const services = { localhost: computer.services() };
    const taken = await takeSnapshot(deps, { services });
    expect(taken).toEqual({
      id: ID,
      where: "on this computer",
      services: [{ name: "db", kind: "postgres", state: "copied", size: 42 }],
    });
    const listed = await listSnapshots(deps, { services });
    expect(listed.map((entry) => [entry.id, entry.where])).toEqual([[ID, "on this computer"]]);
  });
});
