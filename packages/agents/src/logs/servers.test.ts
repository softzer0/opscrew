import type { RemoteExec } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { DATA_HOST, splitWorld } from "../status/__fixtures__/split";
import { FakeDocker } from "../testing";
import type { LogLine, LogRead } from "./lines";
import { readLogs } from "./read";

async function collect(read: LogRead): Promise<LogLine[]> {
  const lines: LogLine[] = [];
  for await (const line of read) lines.push(line);
  return lines;
}

/** The split app with a Docker on each server. */
async function split(dataServer: "cloud" | "own" = "cloud") {
  const w = await splitWorld({ data: dataServer });
  const app = new FakeDocker([
    {
      name: "shop-app-1",
      project: "shop",
      service: "app",
      lines: [{ time: "2026-10-30T11:00:00.000000001Z", stream: "stdout", text: "GET / 200" }],
    },
  ]);
  const data = new FakeDocker([
    {
      name: "shop-db-1",
      project: "shop",
      service: "db",
      lines: [
        {
          time: "2026-10-30T11:01:00.000000001Z",
          stream: "stderr",
          text: "LOG:  checkpoint complete",
        },
      ],
    },
  ]);
  const remote = (host: string): RemoteExec => (host === DATA_HOST ? data : app).remote(host);
  return { ...w, app, data, services: { remote } };
}

describe("readLogs of an app on two servers", () => {
  it("reads a service placed on another server from that server, and says which", async () => {
    const s = await split();
    const steps: string[] = [];
    s.deps.reporter.step = (text: string) => {
      steps.push(text);
    };
    const read = await readLogs(s.deps, s.plan, { service: "db", services: s.services });
    expect(read.first).toBe(
      "The oldest line here is from 2026-10-30 11:01 UTC. Each deploy starts new containers, and each keeps up to 30 MB of logs. These lines are from server data.",
    );
    expect((await collect(read)).map((l) => l.text)).toEqual(["LOG:  checkpoint complete"]);
    expect(steps).toContain("Reading the lines of PostgreSQL (db) on server data (read-only)");
    expect(s.app.commands).toEqual([]);
    expect(s.data.commands).toEqual([
      "docker ps -a --filter label=com.docker.compose.project=shop --filter label=com.docker.compose.service=db --filter label=com.docker.compose.oneoff=False --format '{{.Names}}'",
      "docker logs --timestamps --tail 200 shop-db-1",
    ]);
    expect(s.deps.audit.entries.at(-1)).toMatchObject({ target: "server data", detail: "db" });
  });

  it("reads the web process on the app's server, named too", async () => {
    const s = await split();
    const read = await readLogs(s.deps, s.plan, { services: s.services });
    expect(read.first).toContain("These lines are from server app.");
    expect((await collect(read)).map((l) => l.text)).toEqual(["GET / 200"]);
    expect(s.data.commands).toEqual([]);
  });

  it("reads Docker through sudo on the user's own server when its probe says so", async () => {
    const s = await split("own");
    const probes: string[] = [];
    const remote = (host: string): RemoteExec => {
      const shell = s.services.remote(host);
      return {
        host,
        run: async (command, options) => {
          if (!command.includes("echo sudo-password")) return shell.run(command, options);
          probes.push(host);
          return { exitCode: 0, stdout: "sudo\n", stderr: "" };
        },
      };
    };
    const read = await readLogs(s.deps, s.plan, { service: "db", services: { remote } });
    expect((await collect(read)).map((l) => l.text)).toEqual(["LOG:  checkpoint complete"]);
    expect(probes).toEqual([DATA_HOST]);
    expect(s.data.commands[0]).toMatch(/^sudo -n docker ps /);
  });

  it("names the other server when it does not answer", async () => {
    const s = await split();
    s.data.unreachable = true;
    await expect(
      readLogs(s.deps, s.plan, { service: "db", services: s.services }),
    ).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "Server data did not answer over SSH, so OpsCrew could not read the app's logs.",
    });
  });
});
