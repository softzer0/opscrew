import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpsCrewError, type ProjectPaths } from "@opscrew/core";

/** How long a deploy waits for another one on this computer, in 2-second tries (10 minutes). */
const TRIES = 300;

/** `<OpsCrew home>/local/deploy.lock`: held while a local deploy or teardown runs. */
function lockFile(paths: Pick<ProjectPaths, "homeDir">): string {
  return join(paths.homeDir, "local", "deploy.lock");
}

/** True when the lock names a process that no longer runs (a deploy that was killed). */
async function stale(file: string): Promise<boolean> {
  const pid = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Runs `fn` while this computer's local deploy lock is held, so two deploys or teardowns never
 * change the shared edge at once (the scripts' own `flock` is missing on Git for Windows and
 * macOS). Waits for another holder, takes over a lock its process left behind, and gives up after
 * 10 minutes with what to do.
 */
export async function withLocalLock<T>(
  paths: Pick<ProjectPaths, "homeDir">,
  sleep: (ms: number) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const file = lockFile(paths);
  await mkdir(dirname(file), { recursive: true });
  for (let tries = 0; ; tries += 1) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(`${process.pid}\n`);
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await stale(file)) {
        await rm(file, { force: true });
        continue;
      }
      if (tries >= TRIES) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          "Another OpsCrew deploy on this computer has held the local stack for over 10 minutes, so this one did not start. Nothing was changed.",
          {
            hint: `Wait for it to finish. If no other OpsCrew command runs, delete ${file}, then run the command again.`,
          },
        );
      }
      await sleep(2000);
    }
  }
  try {
    return await fn();
  } finally {
    await rm(file, { force: true });
  }
}
