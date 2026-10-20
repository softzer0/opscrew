/**
 * Running sops on JSON through pipes: the plaintext travels only on stdin and stdout, and the age
 * identity only in the child's `SOPS_AGE_KEY`, so neither touches the disk or a command line.
 */
import type { CommandResult, CommandRunner } from "@opscrew/contracts";
import { OpsCrewError } from "../errors";
import type { Redactor } from "../redact";

/** What the sops runner needs: a command runner, the redactor and the environment to start from. */
export interface SopsDeps {
  exec: CommandRunner;
  redactor: Redactor;
  env: Record<string, string | undefined>;
}

/** sops's exit code when no key could decrypt the data key (`codes.CouldNotRetrieveKey`). */
const COULD_NOT_RETRIEVE_KEY = 128;

function jsonArgs(command: "encrypt" | "decrypt", filename: string): string[] {
  return [
    command,
    "--input-type",
    "json",
    "--output-type",
    "json",
    "--filename-override",
    filename,
  ];
}

/**
 * `env` without any `SOPS_*` variable: sops reads keys and key sources from them as defaults
 * (`SOPS_PGP_FP`, `SOPS_AGE_KEY_FILE`, …), which must never add to or replace OpsCrew's own.
 */
function childEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/^SOPS_/i.test(name)));
}

function failed(action: string, result: CommandResult, redactor: Redactor): OpsCrewError {
  const detail = redactor.redact(result.stderr.trim()) || `exit code ${result.exitCode}`;
  return new OpsCrewError("COMMAND_FAILED", `sops could not ${action} (${detail}).`, {
    hint: "Check that the file is a sops file OpsCrew wrote, then try again.",
  });
}

/**
 * Encrypts the JSON `plaintext` to the age `recipients` and returns sops's encrypted JSON.
 * `filename` is the path sops records and matches `.sops.yaml` rules against.
 */
export async function sopsEncrypt(
  bin: string,
  input: { plaintext: string; recipients: string[]; filename: string },
  deps: SopsDeps,
): Promise<string> {
  const args = [...jsonArgs("encrypt", input.filename), "--age", input.recipients.join(",")];
  const result = await deps.exec.run(bin, args, {
    input: input.plaintext,
    env: childEnv(deps.env),
  });
  if (result.exitCode !== 0) throw failed(`encrypt ${input.filename}`, result, deps.redactor);
  return result.stdout;
}

/** Every string inside a parsed JSON value. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

/**
 * Decrypts sops's encrypted JSON with the age `identity` and returns the plaintext JSON. The
 * identity and every decrypted value are registered with the redactor first; an identity sops
 * rejects is `SECRETS_KEY_REJECTED`.
 */
export async function sopsDecrypt(
  bin: string,
  input: { encrypted: string; identity: string; filename: string },
  deps: SopsDeps,
): Promise<string> {
  const identity = input.identity.trim();
  deps.redactor.addLiteral(identity, "age-identity");
  const result = await deps.exec.run(bin, jsonArgs("decrypt", input.filename), {
    input: input.encrypted,
    env: { ...childEnv(deps.env), SOPS_AGE_KEY: identity },
  });
  if (result.exitCode === COULD_NOT_RETRIEVE_KEY) {
    throw new OpsCrewError(
      "SECRETS_KEY_REJECTED",
      `The age key cannot open ${input.filename}: it is not one of the keys the file was encrypted to.`,
      { hint: "Use the key OpsCrew wrote when it made the copy, or the backup key." },
    );
  }
  if (result.exitCode !== 0) throw failed(`decrypt ${input.filename}`, result, deps.redactor);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new OpsCrewError("COMMAND_FAILED", `sops did not return JSON for ${input.filename}.`, {
      hint: "Check that the file is a sops file OpsCrew wrote, then try again.",
    });
  }
  for (const value of strings(parsed)) deps.redactor.addLiteral(value, "secrets-copy");
  return result.stdout;
}
