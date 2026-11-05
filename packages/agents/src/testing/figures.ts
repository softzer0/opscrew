/**
 * A server's figures as `status`'s fixed figures command prints them, for the tests of `status`'s
 * readers and `advise`. No real server.
 */
import type { RemoteExec } from "@opscrew/contracts";

const MB = 1024 ** 2;
const GB = 1024 ** 3;

/** A container as the figures command reads it: its memory now, its limit, its restarts. */
export interface FakeContainer {
  service: string;
  usedMb: number;
  limitMb?: number;
  restarts?: number;
}

/** A server's figures: memory and disk in use as shares, CPUs, the 15-minute load. */
export interface FakeFigures {
  memory?: number;
  totalGb?: number;
  disk?: number;
  diskGb?: number;
  cpus?: number;
  load15?: number;
  containers?: FakeContainer[];
}

/** The output of the fixed figures command (`serverFiguresCommand`) for the Compose project `app`. */
export function figuresOutput(app: string, f: FakeFigures = {}): string {
  const total = Math.round((f.totalGb ?? 4) * GB);
  const available = Math.round(total * (1 - (f.memory ?? 0.4)));
  const disk = Math.round((f.diskGb ?? 40) * GB);
  const used = Math.round(disk * (f.disk ?? 0.3));
  const containers = f.containers ?? [{ service: "app", usedMb: 120, limitMb: 512 }];
  return [
    "==opscrew-figures:cpus",
    String(f.cpus ?? 2),
    "==opscrew-figures:load",
    `0.30 0.30 ${(f.load15 ?? 0.3).toFixed(2)} 1/123 4567`,
    "==opscrew-figures:memory",
    "               total        used        free      shared  buff/cache   available",
    `Mem:      ${total}  ${total - available}   1000     1000  1000  ${available}`,
    "==opscrew-figures:disk",
    "Filesystem        1-blocks        Used   Available Capacity Mounted on",
    `/dev/sda1      ${disk} ${used}  ${disk - used}      30% /`,
    "==opscrew-figures:stats",
    ...containers.map((c) =>
      JSON.stringify({
        Name: `${app}-${c.service}-1`,
        CPUPerc: "1.50%",
        MemUsage: `${c.usedMb}MiB / ${c.limitMb ?? 4096}MiB`,
      }),
    ),
    "==opscrew-figures:inspect",
    ...containers.map((c) =>
      JSON.stringify({
        name: `/${app}-${c.service}-1`,
        restarts: c.restarts ?? 0,
        startedAt: "2026-11-03T08:00:00Z",
        memoryLimit: c.limitMb === undefined ? 0 : c.limitMb * MB,
      }),
    ),
    "",
  ].join("\n");
}

/**
 * A server's shell, by address, that answers the figures command with `figures` and fails every
 * other command as ssh does, with a message naming the address.
 */
export function figuresRemote(figures: string): (host: string) => RemoteExec {
  return (host) => ({
    host,
    run: async (command) =>
      command.includes("==opscrew-figures:")
        ? { exitCode: 0, stdout: figures, stderr: "" }
        : {
            exitCode: 255,
            stdout: "",
            stderr: `ssh: connect to host ${host} port 22: Connection timed out`,
          },
  });
}
