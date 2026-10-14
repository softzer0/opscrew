import type { ReadText, Unit } from "./manifests";
import { ReleaseContext, type ReleaseDetection } from "./release/context";
import { anyStackRelease, nativeRelease } from "./release/native";
import { nodeRelease } from "./release/node";
import { pythonRelease } from "./release/python";
import { pickMigrateScript, type RejectedScript, rejectedScriptsNote } from "./release/scripts";

export type { ReleaseDetection, ReleaseNote } from "./release/context";

/** What {@link detectRelease} looks at. */
export interface ReleaseInputs {
  /** Repo-relative directory of the app (`.` for the root). */
  appDir: string;
  /** Repo-relative files of the repository that detection may look at. */
  files: readonly string[];
  /** Text of the app folder's `Procfile`, when there is one. */
  procfile: string | undefined;
  /** Text of the app folder's `.flaskenv`, when there is one. */
  flaskenv?: string | undefined;
  /** The detected start command (repository-root form), when there is one. */
  startCommand?: string | undefined;
  /** The app's manifest unit (its dependencies). */
  unit: Unit | undefined;
  /** Frameworks detected for the app. */
  frameworks: ReadonlySet<string>;
  /** Which package ecosystem builds the app. */
  ecosystem: "js" | "python" | "none";
  /** Reads a repo-relative file of `files` (config files, migrations, code); none when absent. */
  read?: ReadText;
  /** `<pm> run <script>` for the app in repository-root form (Node.js apps). */
  runScript?: (script: string) => string;
}

/**
 * Finds what prepares the database before each new version takes traffic, run from the repository
 * root like the start command. In order: the Procfile `release:` line (the Heroku convention); a
 * package.json script named `migrate`, `db:migrate`, `migrate:deploy` or `migrate:prod` (run like
 * the start command; a script that resets, drops, rolls back, syncs, pushes or seeds a schema, runs
 * such a script, or only starts a migration CLI is never used, and a note says so); then the tool
 * of the app's stack, each only when the app has migrations for it (see `release/python.ts`,
 * `release/node.ts` and `release/native.ts`). Apps that migrate when they start, and migrations
 * whose tool the image would lack, get a note instead of a command. Whether the app's image can
 * run the command is decided when the plan is made.
 */
export async function detectRelease(inputs: ReleaseInputs): Promise<ReleaseDetection> {
  const { appDir, unit, ecosystem } = inputs;
  const procfileRelease = /^release:[ \t]*(\S.*)$/m.exec(inputs.procfile ?? "")?.[1]?.trim();
  const ctx = new ReleaseContext(
    appDir,
    inputs.files,
    unit,
    inputs.read ?? (async () => undefined),
    inputs.startCommand,
  );
  if (procfileRelease) return { command: ctx.at(".", procfileRelease) };

  let rejected: RejectedScript[] = [];
  if (ecosystem === "js" && inputs.runScript) {
    const picked = pickMigrateScript(ctx.scripts);
    if (picked.script) return { command: inputs.runScript(picked.script) };
    rejected = picked.rejected;
  }

  const found =
    (ecosystem === "python"
      ? await pythonRelease(ctx, { flaskenv: inputs.flaskenv, frameworks: inputs.frameworks })
      : undefined) ??
    (ecosystem === "js" ? await nodeRelease(ctx) : undefined) ??
    (await nativeRelease(ctx)) ??
    anyStackRelease(ctx) ??
    {};
  if (rejected.length === 0) return found;
  // A skipped script is worth a warning whatever else was found.
  const skipped = rejectedScriptsNote(rejected, found.command !== undefined);
  const text = found.note ? `${skipped} ${found.note.text}` : skipped;
  return { ...found, note: { text, atStartup: false } };
}
