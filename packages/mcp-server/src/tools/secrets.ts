import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  COPY_PATH,
  type ProvisionServices,
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
import { z } from "zod";
import type { ResolvedMcpDeps } from "../deps";
import { type CallExtra, dialogHandler, REQUIRES_USER, requireDialogs } from "./elicitation";
import {
  environmentInput,
  IDEMPOTENT_WRITE,
  projectDirInput,
  runTool,
  toolEnvironment,
} from "./shared";

/** Test-only collaborators for the secrets tools. */
export interface SecretsToolOptions {
  /** The GitHub fake `opscrew_secrets_rotate` opens its pull request with. */
  provisionServices?: Pick<ProvisionServices, "github">;
}

/** A full path the user chose, refused plainly otherwise (the model never invents one). */
function fullPath(file: string, what: string): string {
  if (path.isAbsolute(file)) return file;
  throw new OpsCrewError("INVALID_INPUT", `${what} must be a full path, not ${file}.`, {
    hint: "Ask the user for the full path of the file, then call the tool again.",
  });
}

/**
 * The recovery copy's tools: `opscrew_secrets_status`, `opscrew_secrets_restore` (reads only the
 * user's key file), `opscrew_secrets_rotate` (writes the new key only to `keyOut`) and
 * `opscrew_secrets_folder`. No result ever contains a key. `options` is for tests only.
 */
export function registerSecretsTools(
  server: McpServer,
  deps: ResolvedMcpDeps,
  options: SecretsToolOptions = {},
): void {
  server.registerTool(
    "opscrew_secrets_status",
    {
      title: "Recovery copy status",
      description: `Show the encrypted recovery copy of what OpsCrew keeps on the user's computer for the app (its generated secrets, the deploy key, the infrastructure state and its records) in ${COPY_PATH}: when it was last updated, how many age keys open it, whether it is behind the files on this computer, and the folder it is also written to. Writes nothing.`,
      inputSchema: { ...projectDirInput, ...environmentInput },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ projectDir, environment }) =>
      runTool(deps, "opscrew_secrets_status", projectDir, async (call) => {
        const { name } = await toolEnvironment(call.projectDir, environment);
        const copy = await recoveryStatus(await call.phaseDeps({ environment: name }));
        return { text: recoveryStatusLines(copy).join("\n"), data: { ...copy } };
      }),
  );

  server.registerTool(
    "opscrew_secrets_restore",
    {
      title: "Restore from the recovery copy",
      description: `Rebuild OpsCrew's files on the user's computer (generated secrets, deploy key, infrastructure state, records) from the encrypted recovery copy (${COPY_PATH}, or the folder copy passed as from), with the user's age key read from keyFile, a file the user names. Never read that file yourself, and never ask the user to paste the key into the chat. When files on this computer differ from the copy, nothing is written and the result lists their paths and the names of the generated values that differ (never values); ask the user which side to keep, then call again with onConflict. A wrong key changes nothing. The next provision reuses the restored files.`,
      inputSchema: {
        ...projectDirInput,
        ...environmentInput,
        keyFile: z
          .string()
          .min(1)
          .describe("Full path of the user's age key file. Only the user names it."),
        from: z
          .string()
          .optional()
          .describe(
            `Full path of another copy to restore from, such as the folder copy (default ${COPY_PATH}).`,
          ),
        onConflict: z
          .enum(["use-copy", "keep-local"])
          .optional()
          .describe(
            "Only after the user chose: use-copy writes the copy's version of each differing file, keep-local keeps this computer's and restores the rest.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, environment, keyFile, from, onConflict }) =>
      runTool(deps, "opscrew_secrets_restore", projectDir, async (call) => {
        const { name } = await toolEnvironment(call.projectDir, environment);
        const file = fullPath(keyFile, "keyFile");
        let identity: string;
        try {
          identity = await readFile(file, "utf8");
        } catch (error) {
          throw new OpsCrewError("INVALID_INPUT", `OpsCrew could not read the key file ${file}.`, {
            hint: `Ask the user to check the path of their age key file (${errorText(error)}).`,
          });
        }
        const result = await restoreRecoveryCopy(await call.phaseDeps({ environment: name }), {
          identity,
          ...(from !== undefined ? { from: fullPath(from, "from") } : {}),
          ...(onConflict !== undefined ? { onConflict } : {}),
        });
        if (result.conflicts !== undefined) {
          return {
            text: `${restoreConflictText(result.conflicts)} Ask the user which side to keep, then call opscrew_secrets_restore again with onConflict use-copy or keep-local.`,
            data: { restored: [], conflicts: result.conflicts },
          };
        }
        return {
          text:
            result.restored.length === 0
              ? "This computer already has every file in the recovery copy; nothing was written."
              : `Restored ${plural(result.restored.length, "file")}: ${listText(result.restored)}. The next provision reuses them, so nothing is generated again.`,
          data: { restored: result.restored },
        };
      }),
  );

  server.registerTool(
    "opscrew_secrets_rotate",
    {
      title: "New key for the recovery copy",
      description: `Make a new age key for the encrypted recovery copy, write it once to keyOut (a full path outside the repository that the user chose; never read that file), encrypt the copy to it (keeping, replacing or dropping the backup key) and propose ${COPY_PATH} and opscrew/.sops.yaml in a pull request, each step approved by the user in a dialog. The key is never returned. Older commits stay readable with the old key; the result says when to change the secrets themselves. Refuses when the client cannot show dialogs.`,
      inputSchema: {
        ...projectDirInput,
        ...environmentInput,
        keyOut: z
          .string()
          .min(1)
          .describe("Full path of a new file for the new age key, outside the repository."),
        backup: z
          .string()
          .nullable()
          .optional()
          .describe(
            "The backup key's public key (age1…) to use instead of the current one; null drops the backup key; leave it out to keep it.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: REQUIRES_USER,
    },
    ({ projectDir, environment, keyOut, backup }, extra: CallExtra) =>
      runTool(deps, "opscrew_secrets_rotate", projectDir, async (call) => {
        const { name, flag } = await toolEnvironment(call.projectDir, environment);
        const file = fullPath(keyOut, "keyOut");
        requireDialogs(server, `npx opscrew secrets rotate${flag} --key-out ${file}`);
        const phase = await call.phaseDeps({
          approvalHandler: dialogHandler(server, deps, extra),
          environment: name,
        });
        const plan = await readArtifact("plan", phase.paths.files.plan);
        const git = await requireGitRepo(phase);
        const github = await setupGitHub(phase, git, options.provisionServices ?? {});
        const rotated = await publishRotatedKey(phase, {
          git,
          github,
          plan,
          keyOut: file,
          ...(backup !== undefined ? { backup } : {}),
        });
        return {
          text: [
            rotated.message,
            ...(rotated.prUrl !== undefined ? [`Pull request: ${rotated.prUrl}`] : []),
          ].join("\n"),
          data: {
            keyFile: rotated.handover.path,
            branch: rotated.branch,
            pushed: rotated.pushed,
            ...(rotated.prUrl !== undefined ? { prUrl: rotated.prUrl } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "opscrew_secrets_folder",
    {
      title: "Folder for the recovery copy",
      description:
        "Set the folder OpsCrew also writes the encrypted recovery copy to each time it changes (a full path outside the repository that the user chose, for example a backup drive or a synced folder), or stop with folder null. The setting is this computer's.",
      inputSchema: {
        ...projectDirInput,
        ...environmentInput,
        folder: z
          .string()
          .min(1)
          .nullable()
          .describe("Full path of the folder, or null to stop writing the folder copy."),
      },
      annotations: IDEMPOTENT_WRITE,
    },
    ({ projectDir, environment, folder }) =>
      runTool(deps, "opscrew_secrets_folder", projectDir, async (call) => {
        const { name } = await toolEnvironment(call.projectDir, environment);
        await setRecoveryFolder(await call.phaseDeps({ environment: name }), folder ?? undefined);
        return {
          text:
            folder === null
              ? "OpsCrew no longer writes a folder copy of the recovery copy."
              : `OpsCrew writes the recovery copy to ${folder} as well, each time it changes.`,
          data: { folder },
        };
      }),
  );
}
