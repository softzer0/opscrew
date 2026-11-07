/**
 * The free disk a snapshot needs, the rollback's rule (019 plan.md 12.3): 1 GiB and 10% of the
 * disk that holds the snapshots, checked before anything is copied.
 */
import { OpsCrewError } from "@opscrew/core";
import { sizeText } from "../retarget/texts";

/** A disk's size and free space in KiB, as `df -Pk` gives them. */
export interface Disk {
  totalKb: number;
  freeKb: number;
}

/** The command that prints `disk <size> <free>` (KiB) of the disk that holds the current folder. */
export const DISK_COMMAND = `df -Pk . | awk 'NR == 2 { print "disk", $2, $4 }'`;

/** The `disk <size> <free>` line of a probe; `undefined` without one. */
export function readDisk(stdout: string): Disk | undefined {
  const match = /^disk (\d+) (\d+)$/m.exec(stdout);
  if (match === null) return undefined;
  return { totalKb: Number(match[1]), freeKb: Number(match[2]) };
}

/** 1 GiB in KiB. */
const GIB_KB = 1024 * 1024;

/**
 * The refusal when `disk` has less than 1 GiB or 10% free, saying how much is needed, or
 * `undefined` when it has enough. `where` names the disk's machine (`on the app's server`).
 */
export function lowDisk(disk: Disk, where: string): OpsCrewError | undefined {
  const needed = Math.max(GIB_KB, Math.ceil(disk.totalKb / 10));
  if (disk.freeKb >= needed) return undefined;
  const kb = (value: number) => sizeText(value * 1024);
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `The disk that holds the snapshots ${where} has ${kb(disk.freeKb)} free of ${kb(disk.totalKb)}: a snapshot needs ${kb(needed)} free (1 GiB and 10% of the disk), so OpsCrew took no snapshot. Nothing was changed.`,
    {
      hint: `Free ${kb(needed - disk.freeKb)} there, or delete snapshots you no longer need (\`opscrew snapshot list\`, then \`opscrew snapshot delete <id>\`), then try again.`,
    },
  );
}
