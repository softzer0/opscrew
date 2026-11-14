/**
 * `opscrew rotate recovery-key` (025 plan.md 10., US8, FR-2511): what `opscrew secrets rotate`
 * did, moved here. A new age key for the recovery copy, written only to the file the user names;
 * the copy encrypted again to it; the copy, `opscrew/.sops.yaml` and the rotation's record
 * proposed in a pull request.
 */
import { readFile, rm } from "node:fs/promises";
import type { GitClient } from "@opscrew/connector-github";
import { readTextIfExists, toPosixRelative, writeFileAtomic } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubSetup } from "../provision/credentials";
import { requireNoCloudflareMove } from "../provision/guard";
import { chooseDeployBranch, commitAndPropose } from "../provision/publish";
import { oldCommitsNote, rotateRecoveryKey } from "../secrets/copy";
import { copyPath } from "../secrets/files";
import { type KeyHandover, SOPS_CONFIG_PATH } from "../secrets/store";
import { generatedValuesFile } from "../shared/app-secrets";
import { credentialsRecordFile, recordRotation } from "./record";

/** What {@link publishRotatedKey} did: the key file, the branch, and the pull request if opened. */
export interface RotatedKeyResult {
  handover: KeyHandover;
  /** What to tell the user (the key file, the copy, the old-commit sentence of FR-1414). */
  message: string;
  branch: string;
  pushed: boolean;
  prUrl?: string;
}

const TITLE = "Rotate the recovery copy's key";

/**
 * The pull request's body: what changed in which file (`copy` is the copy's path, `record` the
 * rotation record's), and the old-commit sentence.
 */
function body(
  copy: string,
  record: string,
  paths: readonly string[],
  backup: string | null | undefined,
  version: string,
) {
  const backupLine =
    backup === null
      ? "The backup key is dropped."
      : backup === undefined
        ? "The backup key, if there is one, is kept."
        : "The backup key is replaced.";
  return [
    "This pull request moves the encrypted recovery copy of this app's secrets to a new age key.",
    "",
    ...paths.map((path) =>
      path === copy
        ? `- \`${copy}\`: the copy, encrypted again to the new key.`
        : path === SOPS_CONFIG_PATH
          ? `- \`${SOPS_CONFIG_PATH}\`: the keys that open the copy from now on. ${backupLine}`
          : path === record
            ? `- \`${record}\`: when the key was rotated (no value).`
            : `- \`${path}\`: keeps the copy's line endings as they are.`,
    ),
    "",
    oldCommitsNote(copy),
    "",
    `Opened by OpsCrew ${version}.`,
  ].join("\n");
}

/** `file` with `text` again (mode `mode`), or without it when it did not exist. */
async function putBack(file: string, text: string | undefined, mode: number): Promise<void> {
  if (text === undefined) await rm(file, { force: true });
  else await writeFileAtomic(file, text, { mode });
}

/**
 * `opscrew rotate recovery-key`: chooses the deploy branch first (a branch check stops before any
 * key is made), records the rotation (`recordRotation`, so the copy holds the generation the record
 * names; the record and the generations are put back as they were when no new key is made), makes
 * the new key with `rotateRecoveryKey` (written only to `keyOut`), then commits the
 * copy, `opscrew/.sops.yaml` and the record on that branch, pushes it and opens a pull request
 * titled "Rotate the recovery copy's key", each after its own approval (`commitAndPropose`). A
 * refused push leaves the commit on the local branch and says how to finish.
 */
export async function publishRotatedKey(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    github: GitHubSetup;
    plan: DeployPlan;
    keyOut: string;
    backup?: string | null;
  },
): Promise<RotatedKeyResult> {
  const { git, github, plan } = input;
  requireNoCloudflareMove(plan);
  const chosen = await chooseDeployBranch(deps, git, github, plan);
  const recordFile = credentialsRecordFile(deps.paths);
  // The copy must hold the generation the record names, so the rotation is recorded first, and
  // both files are put back as they were when no new key was made.
  const before = {
    record: await readTextIfExists(recordFile),
    generated: await readTextIfExists(generatedValuesFile(deps)),
  };
  await recordRotation(deps, ["recovery-key"]);
  let rotated: Awaited<ReturnType<typeof rotateRecoveryKey>>;
  try {
    rotated = await rotateRecoveryKey(deps, {
      keyOut: input.keyOut,
      ...(input.backup !== undefined ? { backup: input.backup } : {}),
      repositoryPrivate: async () => (await github.api.getRepo(github.owner, github.repo)).private,
    });
  } catch (error) {
    await putBack(recordFile, before.record, 0o644);
    await putBack(generatedValuesFile(deps), before.generated, 0o600);
    throw error;
  }
  const record = toPosixRelative(deps.paths.root, recordFile);
  const files = [
    ...rotated.files,
    { path: record, content: await readFile(recordFile, "utf8"), kind: "doc" as const },
  ];
  const paths = files.map((file) => file.path);
  const published = await commitAndPropose(deps, {
    git,
    github,
    plan,
    chosen,
    files,
    paths,
    commitMessage: `chore(opscrew): rotate the recovery copy's key for ${plan.app.name}\n\nGenerated by OpsCrew ${deps.version}.`,
    what: "the recovery copy with its new key",
    title: TITLE,
    body: body(copyPath(deps.paths), record, paths, input.backup, deps.version),
    push: true,
  });
  return {
    handover: rotated.handover,
    message: rotated.message,
    branch: published.branch,
    pushed: published.pushed,
    ...(published.prUrl !== undefined ? { prUrl: published.prUrl } : {}),
  };
}
