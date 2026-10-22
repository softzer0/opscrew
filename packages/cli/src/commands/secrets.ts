import { readFile } from "node:fs/promises";
import {
  COPY_PATH,
  publishRotatedKey,
  recoveryStatus,
  recoveryStatusLines,
  requireGitRepo,
  restoreConflictText,
  restoreRecoveryCopy,
  setRecoveryFolder,
  setupGitHub,
} from "@opscrew/agents";
import { errorText, listText, OpsCrewError, plural } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { createPhaseDeps, promptsOf, servicesOf } from "../deps";
import { addEnvOption, chooseEnvironment } from "../ui/environment";
import { cancelled } from "../ui/prompts";
import { askKeyOut, userPath } from "../ui/recovery";

/** The age key for a restore: the key file's text, or (in a terminal only) a hidden prompt. */
async function readIdentity(ctx: CliContext, keyFile: string | undefined): Promise<string> {
  if (keyFile !== undefined) {
    const file = userPath(ctx, keyFile);
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      throw new OpsCrewError("INVALID_INPUT", `OpsCrew could not read the key file ${file}.`, {
        hint: `Check the path of your age key file (${errorText(error)}), then try again.`,
      });
    }
  }
  if (!ctx.isInteractive) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "Restoring the recovery copy needs your age key, and this run cannot ask for it.",
      {
        hint: "Run `opscrew secrets restore` in a terminal, which asks for the key without showing it, or pass the key file with `--key-file <path>`.",
      },
    );
  }
  const prompts = promptsOf(ctx);
  const answer = await prompts.password({
    message:
      "Paste your age key (AGE-SECRET-KEY-1…). It is not shown, and OpsCrew does not keep it.",
  });
  if (prompts.isCancel(answer)) throw cancelled("the restore", "opscrew secrets restore");
  return answer;
}

/** `--env <name>`, on every subcommand. */
interface EnvFlags {
  env?: string;
}

/** The phase deps of the environment `--env` names, and its ` --env <name>` for suggestions. */
async function environmentDeps(ctx: CliContext, flags: EnvFlags) {
  const { name, flag } = await chooseEnvironment(ctx, flags.env, "secrets");
  return { deps: createPhaseDeps(ctx, { ai: false, environment: name }), flag };
}

interface RestoreFlags extends EnvFlags {
  keyFile?: string;
  from?: string;
  useCopy?: boolean;
  keepLocal?: boolean;
}

async function restore(ctx: CliContext, flags: RestoreFlags): Promise<void> {
  if (flags.useCopy === true && flags.keepLocal === true) {
    throw new OpsCrewError("INVALID_INPUT", "Use either --use-copy or --keep-local.", {
      hint: "--use-copy writes the copy's version of each file that differs; --keep-local keeps this computer's.",
    });
  }
  const { deps, flag } = await environmentDeps(ctx, flags);
  const identity = await readIdentity(ctx, flags.keyFile);
  const result = await restoreRecoveryCopy(deps, {
    identity,
    ...(flags.from !== undefined ? { from: userPath(ctx, flags.from) } : {}),
    ...(flags.useCopy === true ? { onConflict: "use-copy" as const } : {}),
    ...(flags.keepLocal === true ? { onConflict: "keep-local" as const } : {}),
  });
  if (result.conflicts !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", restoreConflictText(result.conflicts), {
      hint: "Run the command again with --use-copy to take the copy's version of each, or with --keep-local to keep this computer's and restore only the rest.",
    });
  }
  ctx.stdout(
    result.restored.length === 0
      ? "This computer already has every file in the recovery copy; nothing was written.\n"
      : `Restored ${plural(result.restored.length, "file")} from the recovery copy: ${listText(result.restored)}.\nRun \`opscrew provision${flag}\` next: it reuses them, so nothing is generated again.\n`,
  );
}

interface RotateFlags extends EnvFlags {
  keyOut?: string;
  /** `--backup <age1…>`, or false with `--no-backup`. */
  backup?: string | false;
}

/**
 * A new key for the copy, written to `--key-out` (asked in a terminal), with the copy and
 * `opscrew/.sops.yaml` proposed in a pull request (`publishRotatedKey`). Without a terminal the
 * push is not approved, so the commit stays local and the run says how to finish.
 */
async function rotate(ctx: CliContext, flags: RotateFlags): Promise<void> {
  const keyOut =
    flags.keyOut !== undefined
      ? userPath(ctx, flags.keyOut)
      : ctx.isInteractive
        ? await askKeyOut(ctx)
        : undefined;
  if (keyOut === undefined && ctx.isInteractive) {
    throw cancelled("the key rotation", "opscrew secrets rotate");
  }
  if (keyOut === undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      "A new age key needs a file to be written to, and OpsCrew never prints a key.",
      {
        hint: "Name a file outside the repository with `--key-out <path>`, or run `opscrew secrets rotate` in a terminal, which asks for it.",
      },
    );
  }
  const { deps } = await environmentDeps(ctx, flags);
  const plan = await readArtifact("plan", deps.paths.files.plan);
  const git = await requireGitRepo(deps);
  const github = await setupGitHub(deps, git, servicesOf(ctx).provision ?? {});
  const rotated = await publishRotatedKey(deps, {
    git,
    github,
    plan,
    keyOut,
    ...(flags.backup === false ? { backup: null } : {}),
    ...(typeof flags.backup === "string" ? { backup: flags.backup } : {}),
  });
  ctx.stdout(`${rotated.message}\n`);
  if (rotated.prUrl !== undefined) ctx.stdout(`Pull request: ${rotated.prUrl}\n`);
}

/**
 * `opscrew secrets status|restore|rotate|folder`: the encrypted recovery copy of what OpsCrew
 * keeps on this computer for the app (generated secrets, the deploy key, the infrastructure state
 * and its records), in `opscrew/secrets.sops.json` and optionally a folder. No subcommand ever
 * prints a key: a new key goes to the file `--key-out` names (asked in a terminal), and a restore
 * reads `--key-file` or a hidden prompt.
 */
export function register(program: Command, ctx: CliContext): void {
  const secrets = program
    .command("secrets")
    .description(
      "Manage the encrypted recovery copy of the secrets and state OpsCrew keeps for this app on this computer",
    );
  const status = secrets
    .command("status")
    .description(
      "Show when the recovery copy was last updated, how many keys open it, whether it is behind and the folder copy",
    );
  addEnvOption(status).action(async (flags: EnvFlags) => {
    const { deps } = await environmentDeps(ctx, flags);
    const lines = recoveryStatusLines(await recoveryStatus(deps));
    ctx.stdout(`${lines.join("\n")}\n`);
  });
  const restoreCommand = secrets
    .command("restore")
    .description(
      "Rebuild OpsCrew's files on this computer from the recovery copy with your age key (asked without showing it, unless --key-file is given)",
    );
  addEnvOption(restoreCommand)
    .option("--key-file <path>", "The file with your age key")
    .option(
      "--from <file>",
      `Restore from this copy, such as the folder copy, instead of ${COPY_PATH}`,
    )
    .option("--use-copy", "Where a file on this computer differs, write the copy's version")
    .option("--keep-local", "Where a file on this computer differs, keep it and restore the rest")
    .action((flags: RestoreFlags) => restore(ctx, flags));
  const rotateCommand = secrets
    .command("rotate")
    .description(
      "Make a new age key, encrypt the copy to it and propose the copy in a pull request; the key goes only to a file",
    );
  addEnvOption(rotateCommand)
    .option("--key-out <path>", "The file to write the new key to, outside the repository")
    .option("--backup <recipient>", "Replace the backup key with this public key (age1…)")
    .option("--no-backup", "Drop the backup key")
    .action((flags: RotateFlags) => rotate(ctx, flags));
  const folderCommand = secrets
    .command("folder")
    .description("Also write the recovery copy to a folder of yours, or stop with --none")
    .argument("[path]", "The folder, outside the repository");
  addEnvOption(folderCommand)
    .option("--none", "Stop writing the folder copy")
    .action(async (folder: string | undefined, flags: EnvFlags & { none?: boolean }) => {
      if ((folder === undefined) === (flags.none !== true)) {
        throw new OpsCrewError("INVALID_INPUT", "Give either a folder or --none.", {
          hint: "Run `opscrew secrets folder <path>` to set the folder, or `opscrew secrets folder --none` to stop writing the folder copy.",
        });
      }
      const { deps } = await environmentDeps(ctx, flags);
      const full = folder === undefined ? undefined : userPath(ctx, folder);
      await setRecoveryFolder(deps, full);
      ctx.stdout(
        full === undefined
          ? "OpsCrew no longer writes a folder copy of the recovery copy.\n"
          : `OpsCrew writes the recovery copy to ${full} as well, each time it changes.\n`,
      );
    });
}
