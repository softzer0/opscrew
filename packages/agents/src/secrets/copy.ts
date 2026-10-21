/**
 * The recovery copy (FR-1410–FR-1417): an encrypted copy, made with sops to the user's age keys,
 * of what OpsCrew keeps on this computer for the app. Updating it needs no private key; only a
 * restore does.
 */
import {
  errorText,
  generateAgeIdentity,
  isAgeRecipient,
  OpsCrewError,
  readTextIfExists,
  sha256Hex,
  sopsEncrypt,
  writeFileAtomic,
} from "@opscrew/core";
import type { RenderedFile } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { COPY_PATH, readLocalFiles } from "./files";
import {
  copyFile,
  folderCopyPath,
  gitattributesFile,
  type KeyHandover,
  keyFilePath,
  keyHandoverNote,
  type RecoveryRecord,
  readFolder,
  readRecipients,
  readRecord,
  readRepositoryCopy,
  requireOwnCopy,
  SOPS_CONFIG_PATH,
  sopsBinary,
  sopsConfigFile,
  writeKeyFile,
  writeRecord,
} from "./store";

/** What {@link refreshRecoveryCopy} asks its caller, each only when it is needed. */
export interface RefreshRecoveryOptions {
  /**
   * Whether the GitHub repository is private (the GitHub connector); asked only before the copy's
   * first commit. Without it the repository counts as public.
   */
  repositoryPrivate?: () => Promise<boolean>;
  /**
   * The user's own age key (its recipient, `age1…`) to encrypt the first copy to instead of a new
   * key; asked first, only when the first copy is made. `undefined`: OpsCrew makes the key.
   */
  recipient?: () => Promise<string | undefined>;
  /**
   * The file to write a new key to (a prompt, `--key-out` or MCP `keyOut`); asked only when the
   * first key is made. `undefined`: no file, so no key and no copy yet.
   */
  keyOut?: () => Promise<string | undefined>;
  /** A backup recipient (`age1…`) offered with the first key; `undefined` for none. */
  backup?: () => Promise<string | undefined>;
}

export type RefreshRecoveryResult =
  | { changed: false; warning?: string }
  | {
      changed: true;
      /** The files for the caller's pull request (the copy, `.sops.yaml`, `.gitattributes`). */
      repositoryFiles: RenderedFile[];
      /** The folder copy written, when the user named a folder. */
      folderCopy?: string;
      /** The file the first key was written to. */
      firstKey?: KeyHandover;
      /** The user's own recipient the first copy is encrypted to (no key file is written then). */
      recipient?: string;
      warning?: string;
    };

/** The same files with the same hashes. */
function sameHashes(a: Record<string, string>, b: Record<string, string> | undefined): boolean {
  if (b === undefined) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function hashesOf(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256Hex(text)]));
}

const PUBLIC_WARNING =
  "Anyone can keep a copy of the encrypted file and try to open it later, and the names of the files it holds are readable, though not their contents.";

/**
 * Whether the copy goes into the repository: always once it is there or the repository is private;
 * for a public repository (or one whose visibility is unknown) only after the user agreed, which
 * an interactive run asks once and records (FR-1415).
 */
async function mayCommit(
  deps: PhaseDeps,
  record: RecoveryRecord,
  options: Pick<RefreshRecoveryOptions, "repositoryPrivate">,
  hasCopy: boolean,
): Promise<{ commit: boolean; record: RecoveryRecord }> {
  if (hasCopy || record.publicConfirmed === true) return { commit: true, record };
  if ((await options.repositoryPrivate?.()) === true) return { commit: true, record };
  if (record.publicConfirmed === false || !deps.interactive) return { commit: false, record };
  const decision = await deps.approvals.request({
    kind: "repo-write",
    title: `Commit the encrypted recovery copy of this app's secrets (${COPY_PATH}) to this public repository`,
    details: `${PUBLIC_WARNING} Only your age key opens it.`,
  });
  const answered = { ...record, publicConfirmed: decision.approved };
  await writeRecord(deps.paths, answered);
  return { commit: decision.approved, record: answered };
}

/**
 * Why the copy is not committed, where it was written instead, and how to commit it. `command` is
 * what to run in a terminal to be asked when no folder is set.
 */
function notCommittedWarning(
  record: RecoveryRecord,
  folderCopy: string | undefined,
  command: string,
): string {
  const declined = record.publicConfirmed === false;
  const why = declined
    ? "The repository is public and you chose not to commit the encrypted recovery copy of this app's secrets, so OpsCrew does not ask again."
    : `The repository is public, so OpsCrew does not commit the encrypted recovery copy of this app's secrets without asking. ${PUBLIC_WARNING}`;
  if (folderCopy === undefined) {
    return `${why} No folder is set for the copy either, so OpsCrew made none. Set one with \`opscrew secrets folder <path>\`${declined ? "." : `, or run \`${command}\` in a terminal to be asked.`}`;
  }
  const commit = declined
    ? `To commit it after all, copy that file to ${COPY_PATH} and commit it.`
    : `To commit it, run \`opscrew provision\` in a terminal, which asks first, or copy that file to ${COPY_PATH} and commit it.`;
  return `${why} It wrote the copy only to ${folderCopy}. ${commit}`;
}

const NO_KEY_FILE =
  "OpsCrew has made no encrypted recovery copy of this app's secrets yet: it needs a file to write your new age key to, outside the repository, or your own age key (age1…). Run `opscrew provision` in a terminal, which asks for them, or name the file with `--key-out <path>`.";

const OLD_COMMITS = `Older commits of ${COPY_PATH} can still be opened with the old key. If the old key may have leaked, change the secrets themselves too (the generated passwords, the deploy key and the state passphrase), because anyone with the old key and an old commit can read them.`;

/** A new age key, registered with the redactor at once. */
function newKey(deps: PhaseDeps): { identity: string; recipient: string } {
  const key = generateAgeIdentity();
  deps.redactor.addLiteral(key.identity, "age-identity");
  return key;
}

/** An age recipient the user gave (`what` names it), refused when it is not one. */
function checkRecipient(text: string, what: "backup key" | "age key"): string {
  const recipient = text.trim();
  if (!isAgeRecipient(recipient)) {
    throw new OpsCrewError("INVALID_INPUT", `The ${what} is not an age recipient.`, {
      hint: "An age recipient is one line that starts with age1: the public half of an age key, which `age-keygen -y <key file>` prints.",
    });
  }
  return recipient;
}

/** A new copy to write: its files, recipients and destinations. */
interface CopyPlan {
  files: Record<string, string>;
  recipients: string[];
  record: RecoveryRecord;
  /** Whether the copy goes into the repository; otherwise only the folder copy is written. */
  commit: boolean;
  folderCopy: string | undefined;
  /** What to run in a terminal to be asked about a public repository. */
  command: string;
}

/** Encrypts the plan's files through pipes to its recipients, and returns sops's JSON. */
function encryptCopy(deps: PhaseDeps, bin: string, plan: CopyPlan): Promise<string> {
  return sopsEncrypt(
    bin,
    {
      plaintext: JSON.stringify({ files: plan.files }),
      recipients: plan.recipients,
      filename: COPY_PATH,
    },
    { exec: deps.runner, redactor: deps.redactor, env: deps.env },
  );
}

/**
 * Writes the folder copy (a failure is a warning), records what was written (the copy's SHA-256,
 * and its files' hashes for the repository and for the folder) and returns the repository's files:
 * the copy when committed, the creation rule for new recipients, and `.gitattributes` when its
 * lines are missing.
 */
async function placeCopy(
  deps: PhaseDeps,
  plan: CopyPlan,
  copy: string,
  newRule: boolean,
): Promise<{ repositoryFiles: RenderedFile[]; folderCopy?: string; warnings: string[] }> {
  const warnings: string[] = [];
  let folderCopy: string | undefined;
  if (plan.folderCopy !== undefined) {
    try {
      await writeFileAtomic(plan.folderCopy, copy, { mode: 0o600 });
      folderCopy = plan.folderCopy;
    } catch (error) {
      warnings.push(
        `OpsCrew could not write the folder copy to ${plan.folderCopy} (${errorText(error)}).`,
      );
    }
  }
  if (!plan.commit) {
    warnings.push(
      folderCopy !== undefined
        ? notCommittedWarning(plan.record, folderCopy, plan.command)
        : "The repository is public and the copy is not committed there either, so this computer's secrets have no copy yet.",
    );
  }
  if (plan.commit || folderCopy !== undefined) {
    const now = deps.clock.now().toISOString();
    const hashes = hashesOf(plan.files);
    await writeRecord(deps.paths, {
      ...plan.record,
      ...(plan.commit ? { hashes, repositoryCopyAt: now } : {}),
      ...(folderCopy !== undefined ? { folderHashes: hashes } : {}),
      copySha256: sha256Hex(copy),
      copiedAt: now,
    });
  }
  const gitattributes = await gitattributesFile(deps.paths);
  return {
    repositoryFiles: [
      ...(plan.commit ? [copyFile(copy)] : []),
      ...(newRule ? [sopsConfigFile(plan.recipients)] : []),
      ...(gitattributes !== undefined ? [gitattributes] : []),
    ],
    ...(folderCopy !== undefined ? { folderCopy } : {}),
    warnings,
  };
}

/** The folder copy's path for the app, when the user named a folder. */
async function folderCopyFor(deps: PhaseDeps, app: () => Promise<string>) {
  const folder = await readFolder(deps.paths);
  return folder === undefined ? undefined : folderCopyPath(folder, await app());
}

/** The app's name from `opscrew/plan.yaml`. */
async function planApp(deps: PhaseDeps): Promise<string> {
  return (await readArtifact("plan", deps.paths.files.plan)).app.name;
}

/**
 * Brings the recovery copy up to date with this computer's files, comparing their SHA-256 hashes
 * with `.opscrew/recovery.json`. On a change it encrypts them with sops to the recipients in
 * `opscrew/.sops.yaml` (no private key needed), writes the folder copy at once and returns the
 * files for the caller's pull request. The first time it encrypts to the user's own recipient
 * (`options.recipient`), or makes a key: written once to the file `options.keyOut` names (0600,
 * outside the repository and OpsCrew's folder, never over a file), never printed, and returned
 * only as that path; either way with an optional backup recipient. A public repository gets the
 * copy only after the user agreed; otherwise only the folder copy is written, and only when its
 * files changed. Stops with `SECRETS_COPY_CHANGED_ELSEWHERE` when the repository's copy is not the
 * one this computer last wrote. When sops cannot be fetched it returns `{ changed: false, warning }`
 * and the local secrets stay as they are (FR-1416).
 */
export async function refreshRecoveryCopy(
  deps: PhaseDeps,
  plan: { app: Pick<DeployPlan["app"], "name"> },
  options: RefreshRecoveryOptions = {},
): Promise<RefreshRecoveryResult> {
  const repositoryCopy = await readRepositoryCopy(deps.paths);
  const record = await readRecord(deps.paths);
  requireOwnCopy(repositoryCopy, record);
  const files = await readLocalFiles(deps.paths, deps.redactor);
  if (Object.keys(files).length === 0) return { changed: false };
  const hashes = hashesOf(files);
  // The repository's copy is up to date when it is in this checkout and holds these files.
  if (repositoryCopy !== undefined && sameHashes(hashes, record.hashes)) return { changed: false };

  let recipients = await readRecipients(deps.paths);
  if (recipients === undefined && record.copySha256 !== undefined) {
    return {
      changed: false,
      warning: `OpsCrew made the recovery copy of this app's secrets before, but ${SOPS_CONFIG_PATH}, which names the keys that open it, is not in this checkout, so the copy was not updated. Merge the pull request that adds it (or switch to its branch), then run the command again.`,
    };
  }
  // The first copy's key first, so a run without one asks nothing else.
  const newRule = recipients === undefined;
  let own: string | undefined;
  let key: { file: string; identity: string; recipient: string } | undefined;
  if (recipients === undefined) {
    const given = await options.recipient?.();
    let main: string;
    if (given !== undefined) {
      own = checkRecipient(given, "age key");
      main = own;
    } else {
      const keyOut = await options.keyOut?.();
      if (keyOut === undefined) return { changed: false, warning: NO_KEY_FILE };
      key = { file: await keyFilePath(deps.paths, keyOut), ...newKey(deps) };
      main = key.recipient;
    }
    const backup = await options.backup?.();
    recipients = [main, ...(backup !== undefined ? [checkRecipient(backup, "backup key")] : [])];
  }

  const folderCopy = await folderCopyFor(deps, async () => plan.app.name);
  const decided = await mayCommit(deps, record, options, repositoryCopy !== undefined);
  const command = "opscrew provision";
  if (!decided.commit && folderCopy === undefined) {
    return { changed: false, warning: notCommittedWarning(decided.record, undefined, command) };
  }
  // Only the folder copy is written, and it already holds these files.
  if (!decided.commit && sameHashes(hashes, record.folderHashes)) return { changed: false };

  let bin: string;
  try {
    bin = await sopsBinary(deps);
  } catch (error) {
    return {
      changed: false,
      warning: `OpsCrew could not get sops, which encrypts the recovery copy of this app's secrets, so the copy was not updated; the secrets on this computer stay as they are. ${errorText(error)}`,
    };
  }
  const copyPlan: CopyPlan = {
    files,
    recipients,
    record: decided.record,
    commit: decided.commit,
    folderCopy,
    command,
  };
  const copy = await encryptCopy(deps, bin, copyPlan);
  const firstKey = key === undefined ? undefined : await writeKeyFile(deps, key.file, key);
  const placed = await placeCopy(deps, copyPlan, copy, newRule);
  return {
    changed: true,
    repositoryFiles: placed.repositoryFiles,
    ...(placed.folderCopy !== undefined ? { folderCopy: placed.folderCopy } : {}),
    ...(firstKey !== undefined ? { firstKey } : {}),
    ...(own !== undefined ? { recipient: own } : {}),
    ...(placed.warnings.length > 0 ? { warning: placed.warnings.join(" ") } : {}),
  };
}

/**
 * A new age key for the recovery copy (FR-1414): written once to `keyOut` like the first key, with
 * the backup recipient kept (`undefined`, read from `opscrew/.sops.yaml`), replaced (`age1…`) or
 * dropped (`null`); the last two work when `.sops.yaml` is damaged. This computer's files are
 * encrypted again to the new recipients, the folder copy is rewritten, and the copy and
 * `opscrew/.sops.yaml` are returned for a pull request. A public repository follows the first
 * copy's rule (`repositoryPrivate`): until the user agreed, only the folder copy is written and the
 * message says why. The message says that older commits stay readable with the old key.
 */
export async function rotateRecoveryKey(
  deps: PhaseDeps,
  input: Pick<RefreshRecoveryOptions, "repositoryPrivate"> & {
    keyOut: string;
    backup?: string | null;
  },
): Promise<{ handover: KeyHandover; files: RenderedFile[]; message: string }> {
  const file = await keyFilePath(deps.paths, input.keyOut);
  const repositoryCopy = await readRepositoryCopy(deps.paths);
  const record = await readRecord(deps.paths);
  requireOwnCopy(repositoryCopy, record);
  const files = await readLocalFiles(deps.paths, deps.redactor);
  if (Object.keys(files).length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew keeps nothing for this app on this computer yet, so there is nothing to encrypt to a new key.",
      {
        hint: "Run `opscrew secrets restore` with your current key first, or `opscrew provision`.",
      },
    );
  }
  const backup =
    input.backup === null
      ? undefined
      : input.backup !== undefined
        ? checkRecipient(input.backup, "backup key")
        : (await readRecipients(deps.paths))?.[1];
  const folderCopy = await folderCopyFor(deps, () => planApp(deps));
  const decided = await mayCommit(deps, record, input, repositoryCopy !== undefined);
  const command = "opscrew secrets rotate";
  if (!decided.commit && folderCopy === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      notCommittedWarning(decided.record, undefined, command),
    );
  }

  const key = { file, ...newKey(deps) };
  const copyPlan: CopyPlan = {
    files,
    recipients: [key.recipient, ...(backup !== undefined ? [backup] : [])],
    record: decided.record,
    commit: decided.commit,
    folderCopy,
    command,
  };
  const copy = await encryptCopy(deps, await sopsBinary(deps), copyPlan);
  const handover = await writeKeyFile(deps, key.file, key);
  const placed = await placeCopy(deps, copyPlan, copy, true);
  return {
    handover,
    files: placed.repositoryFiles,
    message: [
      keyHandoverNote(handover),
      `The copy is encrypted again to the new key${backup !== undefined ? " and the backup key" : ""}.`,
      decided.commit
        ? `Merge the pull request with ${COPY_PATH} and ${SOPS_CONFIG_PATH} to put it in the repository.`
        : `Merge the pull request with ${SOPS_CONFIG_PATH}, which names the new key.`,
      ...placed.warnings,
      OLD_COMMITS,
    ].join(" "),
  };
}

const CopyMetadataSchema = z.looseObject({
  sops: z.looseObject({
    lastmodified: z.string().optional(),
    age: z.array(z.unknown()).optional(),
  }),
});

/** What `opscrew status` and `opscrew secrets status` show of the recovery copy. */
export interface RecoveryStatus {
  /** A copy exists: the repository's, or else the folder's. */
  exists: boolean;
  /** When sops last wrote it (`sops.lastmodified`). */
  lastModified?: string;
  /** How many age keys open it (`sops.age`). */
  recipients: number;
  /** A file on this computer changed since the repository's copy was made. */
  behind: boolean;
  /** The folder the copy is also written to. */
  folder?: string;
}

/**
 * The copy's last update and recipient count (from its sops metadata: the repository's copy, or
 * else the folder's), whether this computer's files changed since the repository's copy was made,
 * and the folder.
 */
export async function recoveryStatus(deps: PhaseDeps): Promise<RecoveryStatus> {
  const folder = await readFolder(deps.paths);
  const record = await readRecord(deps.paths);
  const files = await readLocalFiles(deps.paths, deps.redactor);
  const behind = Object.keys(files).length > 0 && !sameHashes(hashesOf(files), record.hashes);
  let copy = await readRepositoryCopy(deps.paths);
  if (copy === undefined && folder !== undefined) {
    copy = await readTextIfExists(folderCopyPath(folder, await planApp(deps)));
  }
  const status = { behind, ...(folder !== undefined ? { folder } : {}) };
  if (copy === undefined) return { exists: false, recipients: 0, ...status };
  let metadata: z.infer<typeof CopyMetadataSchema>["sops"] | undefined;
  try {
    metadata = CopyMetadataSchema.safeParse(JSON.parse(copy)).data?.sops;
  } catch {
    metadata = undefined;
  }
  if (metadata === undefined) {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `The recovery copy is not a sops file OpsCrew can read (${COPY_PATH}, or the folder copy).`,
      { hint: `Put back the copy OpsCrew wrote (git restore ${COPY_PATH}).` },
    );
  }
  return {
    exists: true,
    ...(metadata.lastmodified !== undefined ? { lastModified: metadata.lastmodified } : {}),
    recipients: metadata.age?.length ?? 0,
    ...status,
  };
}
