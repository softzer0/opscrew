/**
 * OpsCrew's record of a hosting account (feature 027, ADR 0030 D1, D3): `.opscrew/hosting.json`,
 * on this computer only. It holds how OpsCrew reaches the account (the panel's address and user,
 * or the SFTP host and the host key the user confirmed; never the token) and every object OpsCrew
 * made there with the panel's key for it, so later commands change and remove only those.
 */
import { join } from "node:path";
import {
  ensureStateDir,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  stripBom,
  writeFileAtomic,
} from "@opscrew/core";
import { z } from "zod";
import { HOST_KEY_FINGERPRINT } from "../shared";

/** How OpsCrew reaches the account's control panel; the token stays in the environment. */
const PanelSchema = z.strictObject({
  kind: z.enum(["cpanel", "plesk", "directadmin"]),
  /** The address the panel answered on, `https://<host>:<port>`. */
  url: z.url({ protocol: /^https$/ }),
  user: z.string().min(1),
});

/** An SFTP-only host: its login (the key stays in the environment) and the app's folder. */
const SftpSchema = z.strictObject({
  host: z.string().min(1),
  port: z.int().min(1).max(65535),
  user: z.string().min(1),
  /** The host key the user confirmed, as its SHA-256 fingerprint. */
  hostKey: z.string().regex(HOST_KEY_FINGERPRINT),
  /** The folder OpsCrew deploys into, as SFTP shows it. */
  folder: z.string().min(1),
  /** The same folder as the host's PHP sees it, an absolute path. */
  phpPath: z.string().regex(/^\//),
});

/** An object OpsCrew made on the account, with the panel's key for it. */
const HostingObjectSchema = z.strictObject({
  kind: z.enum(["hostname", "database", "cron", "folder", "file", "certificate", "php"]),
  /**
   * The panel's key: the hostname, the database's full name, the cron line's key, the path below
   * the home folder, the certificate's id.
   */
  key: z.string().min(1),
});

export const HostingRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  panel: PanelSchema.optional(),
  sftp: SftpSchema.optional(),
  objects: z.array(HostingObjectSchema).default(() => []),
});

/** `.opscrew/hosting.json` (see the module's comment). */
export type HostingRecord = z.infer<typeof HostingRecordSchema>;
export type HostingPanelRecord = NonNullable<HostingRecord["panel"]>;
export type SftpRecord = NonNullable<HostingRecord["sftp"]>;
export type HostingObject = HostingRecord["objects"][number];

/** Path of `.opscrew/hosting.json` (another environment's in its own state folder). */
export function hostingRecordFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "hosting.json");
}

/** A record that exists but can't be used: never read as empty, since it lists what OpsCrew made. */
function damaged(reason: string): OpsCrewError {
  return new OpsCrewError(
    "ARTIFACT_INVALID",
    `OpsCrew's record of your hosting account (.opscrew/hosting.json) is damaged (${reason}), so OpsCrew stopped.`,
    {
      hint: "Fix the JSON in .opscrew/hosting.json and run the command again. Don't delete it: it lists what OpsCrew made on the account, which only this record lets OpsCrew change or remove.",
    },
  );
}

/** Reads `.opscrew/hosting.json`; `undefined` when there is none, `ARTIFACT_INVALID` when damaged. */
export async function readHostingRecord(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<HostingRecord | undefined> {
  let text: string | undefined;
  try {
    text = await readTextIfExists(hostingRecordFile(paths));
  } catch {
    throw damaged("it cannot be read");
  }
  if (text === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(stripBom(text));
  } catch {
    throw damaged("it is not valid JSON");
  }
  const parsed = HostingRecordSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  const where = parsed.error.issues[0]?.path.map(String).join(".") ?? "";
  throw damaged(where === "" ? "it is not a hosting record" : `${where} is not valid`);
}

/**
 * Rewrites `.opscrew/hosting.json` atomically (0600, inside the gitignored `.opscrew/`) with
 * `update` applied to the current record (an empty one when there is none), and returns it.
 */
export async function updateHostingRecord(
  paths: ProjectPaths,
  update: (current: HostingRecord) => z.input<typeof HostingRecordSchema>,
): Promise<HostingRecord> {
  const current = (await readHostingRecord(paths)) ?? { schemaVersion: 1, objects: [] };
  const next = HostingRecordSchema.parse(update(current));
  await ensureStateDir(paths);
  await writeFileAtomic(hostingRecordFile(paths), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
