import { homedir } from "node:os";
import path from "node:path";
import type { ProvisionOptions } from "@opscrew/agents";
import { isAgeRecipient } from "@opscrew/core";
import type { CliContext } from "../context";
import { promptsOf } from "../deps";

/** A path the user typed, relative to the project directory unless it is a full path. */
export function userPath(ctx: Pick<CliContext, "cwd">, file: string): string {
  return path.resolve(ctx.cwd, file.trim());
}

/**
 * Asks where to write a new age key: a full path, which OpsCrew writes once and never shows.
 * `undefined` when the user cancels.
 */
export async function askKeyOut(ctx: CliContext): Promise<string | undefined> {
  const prompts = promptsOf(ctx);
  const answer = await prompts.text({
    message:
      "Where should OpsCrew write your new age key, which opens the recovery copy of this app's secrets? Give a full path outside this repository. OpsCrew writes the file once and never shows the key.",
    placeholder: path.join(homedir(), "opscrew-age-key.txt"),
    validate: (value) =>
      path.isAbsolute((value ?? "").trim())
        ? undefined
        : "Give a full path, for example in your home folder.",
  });
  return prompts.isCancel(answer) ? undefined : answer.trim();
}

/** Asks for an optional age recipient (`age1…`); `undefined` when left empty or cancelled. */
async function askRecipient(ctx: CliContext, message: string): Promise<string | undefined> {
  const prompts = promptsOf(ctx);
  const answer = await prompts.text({
    message,
    placeholder: "age1…",
    validate: (value) => {
      const text = (value ?? "").trim();
      return text === "" || isAgeRecipient(text)
        ? undefined
        : "Paste the public key, one line starting with age1 (`age-keygen -y <key file>` prints it), or leave it empty.";
    },
  });
  if (prompts.isCancel(answer)) return undefined;
  const text = answer.trim();
  return text === "" ? undefined : text;
}

/**
 * What the recovery copy's first key needs, for `opscrew provision`: with `--key-out`, the new key
 * goes to that file; in a terminal, OpsCrew asks for the user's own age key, else where to write a
 * new one, and offers a backup key. A script without `--key-out` makes no copy yet, and says so.
 */
export function recoveryOptions(
  ctx: CliContext,
  keyOut: string | undefined,
): Pick<ProvisionOptions, "recovery"> {
  const backup = () =>
    askRecipient(
      ctx,
      "Add a second, offline backup key for the recovery copy? Paste its public key (age1…), or leave this empty for none.",
    );
  if (keyOut !== undefined) {
    return {
      recovery: {
        keyOut: async () => userPath(ctx, keyOut),
        ...(ctx.isInteractive ? { backup } : {}),
      },
    };
  }
  if (!ctx.isInteractive) return {};
  return {
    recovery: {
      recipient: () =>
        askRecipient(
          ctx,
          "OpsCrew keeps an encrypted recovery copy of this app's secrets in the repository. Do you already have an age key for it? Paste its public key (age1…), or leave this empty and OpsCrew makes a new key.",
        ),
      keyOut: () => askKeyOut(ctx),
      backup,
    },
  };
}
