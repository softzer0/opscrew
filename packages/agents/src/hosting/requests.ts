/**
 * One-time requests to the agent on a hosting account (027 plan 6, ADR 0030 D5): what the user
 * starts from this computer (a rollback, a settings change, a snapshot, a restore, a Node.js or
 * Python app made in or removed from CloudLinux's selector), written through
 * the panel's API after the approval and carried out once by the agent, which answers in a result
 * file. Only the holder of the panel's token can write one; CI never can.
 */
import type { HostingFiles } from "@opscrew/contracts";
import { OpsCrewError, sha256Hex } from "@opscrew/core";
import { z } from "zod";

/** The requests the agent carries out (`AGENT_SH`), each with the fields of its kind. */
export type HostingRequest =
  /** Back to a kept release (`<run id>-<attempt>`), restoring the dump filed under it or not. */
  | { kind: "rollback"; release: string; restore: boolean }
  /** `shared/.env.next` renamed into place, Laravel's config cache made again, the restart. */
  | { kind: "env" }
  /** A snapshot into `dumps/`: the database's dump, and the shared files but the settings. */
  | { kind: "snapshot" }
  /**
   * The snapshot `<id>` in `dumps/` put back (its database dump and its shared files, whichever it
   * holds), the current ones copied first into a new snapshot.
   */
  | { kind: "restore"; snapshot: string }
  /** A Node.js or Python app made in CloudLinux's selector, or removed from it (`apps.ts`). */
  | { kind: "app"; action: "create" | "destroy" };

/** How long a request stays valid after it is written: 30 minutes. */
export const REQUEST_TTL_SECONDS = 30 * 60;

/**
 * How long OpsCrew waits for the agent's answer: 5 minutes. They cover cron's next run of the
 * agent (up to 60 s), more while a run is still busy (the next one finds the lock held and stops),
 * then the request itself: a rollback's carry and PHP restart, and its check, which counts a PHP
 * app's answer on Apache only from 130 s after the switch and gives up at 135 s (research R16).
 */
export const REQUEST_WAIT_MS = 5 * 60 * 1000;

/** How often the answer is looked for. */
const POLL_MS = 5000;

/** A value the agent accepts: letters, digits, `.`, `_` and `-`. */
const VALUE = /^[A-Za-z0-9._-]+$/;

/** What the agent takes for each field (`AGENT_SH`'s `read_request`), and how a message names it. */
const FIELDS: Readonly<Record<string, { pattern: RegExp; what: string }>> = {
  hash: { pattern: /^[0-9a-f]{64}$/, what: "a plan's SHA-256 hash" },
  release: { pattern: /^[1-9][0-9]*-[1-9][0-9]*$/, what: "a release's id, <run id>-<attempt>" },
  snapshot: {
    pattern: /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    what: "a snapshot's id in dumps/, such as snapshot-20261112T120000Z",
  },
};

/**
 * The request's bytes: `kind`, `hash` (the approved plan's), `expires` (UTC epoch seconds, 30
 * minutes after `now`), then its kind's fields, one `key=value` line each.
 * @throws OpsCrewError `INVALID_INPUT` for a value the agent would refuse, before anything is written.
 */
export function requestText(request: HostingRequest, hash: string, now: Date): string {
  const fields: [string, string][] = [
    ["kind", request.kind],
    ["hash", hash.toLowerCase()],
    ["expires", String(Math.floor(now.getTime() / 1000) + REQUEST_TTL_SECONDS)],
  ];
  if (request.kind === "rollback") {
    fields.push(["release", request.release], ["restore", request.restore ? "yes" : "no"]);
  } else if (request.kind === "restore") {
    fields.push(["snapshot", request.snapshot]);
  } else if (request.kind === "app") {
    fields.push(["action", request.action]);
  }
  for (const [key, value] of fields) {
    const field = FIELDS[key];
    if (VALUE.test(value) && (field === undefined || field.pattern.test(value))) continue;
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew can't ask the agent for that: ${JSON.stringify(value)} isn't ${field?.what ?? "a value the agent takes (letters, digits, ., _ and -)"}. Nothing was written to the account.`,
      {
        hint: "Check the value you gave, such as a release id that `opscrew status` lists, and try again.",
      },
    );
  }
  return fields.map(([key, value]) => `${key}=${value}\n`).join("");
}

/** The agent's answer to a request (`state/<name>.result`). */
export const RequestResultSchema = z.strictObject({
  result: z.enum(["done", "refused", "failed"]),
  reason: z.string().min(1).optional(),
  /** A snapshot's dump of the database, in `dumps/`; none for an app without one. */
  dump: z.string().min(1).optional(),
  /** A snapshot's copy of the shared files but the settings, in `dumps/`; none when there are none. */
  shared: z.string().min(1).optional(),
  /** The id of the snapshot a restore took first; none when there was nothing to copy. */
  saved: z.string().min(1).optional(),
  /** What an app's removal left as it was, and why. */
  note: z.string().min(1).optional(),
});

export type RequestResult = z.infer<typeof RequestResultSchema>;

/** The `key=value` lines of a file the agent wrote, as an object (a later key wins). */
export function keyValues(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_.-]+)=(.*)$/.exec(line);
    if (match?.[1] !== undefined) values[match[1]] = match[2] ?? "";
  }
  return values;
}

/** How a wait sleeps (injected, so tests don't wait). */
export interface WaitOptions {
  sleep: (ms: number) => Promise<void>;
}

/**
 * Writes `request` into `<folder>/requests/<SHA-256 of its bytes>.req` (the panel writes it under a
 * temporary name first, so the agent never reads half of it) and answers its name.
 */
export async function writeRequest(
  files: HostingFiles,
  folder: string,
  request: HostingRequest,
  input: { hash: string; now: Date },
): Promise<string> {
  const text = requestText(request, input.hash, input.now);
  const name = sha256Hex(text);
  await files.writeFile(`${folder}/requests/${name}.req`, new TextEncoder().encode(text), 0o600);
  return name;
}

/**
 * The agent's answer to request `name`, waited for up to 5 minutes. The agent writes `failed`
 * before it starts and removes the request once it is carried out, so an answer counts once the
 * request is gone.
 * @throws OpsCrewError `PROVIDER_ERROR` when no answer came, or one OpsCrew can't read.
 */
export async function waitForResult(
  files: HostingFiles,
  folder: string,
  name: string,
  { sleep }: WaitOptions,
): Promise<RequestResult> {
  for (let attempt = 0; attempt * POLL_MS <= REQUEST_WAIT_MS; attempt++) {
    if (attempt > 0) await sleep(POLL_MS);
    const text = await files.readFile(`${folder}/state/${name}.result`);
    if (text === undefined) continue;
    if ((await files.readFile(`${folder}/requests/${name}.req`)) !== undefined) continue;
    const parsed = RequestResultSchema.safeParse(keyValues(text));
    if (parsed.success) return parsed.data;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `OpsCrew can't read the agent's answer to its request (${folder}/state/${name}.result).`,
      { hint: "Run `opscrew logs` to see what the agent did, then try again." },
    );
  }
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    `The agent on the hosting account didn't carry out OpsCrew's request within 5 minutes. Its cron line may be missing, or cron may be off for the account. The request stays valid for 30 minutes.`,
    {
      hint: `Check in the panel's cron jobs that the line running ~/${folder}/agent.sh every minute is there; \`opscrew logs\` shows the agent's last lines. Then run the command again.`,
    },
  );
}

/** {@link writeRequest}, then {@link waitForResult}. */
export async function sendRequest(
  files: HostingFiles,
  folder: string,
  request: HostingRequest,
  input: { hash: string; now: Date } & WaitOptions,
): Promise<RequestResult & { name: string }> {
  const name = await writeRequest(files, folder, request, input);
  return { name, ...(await waitForResult(files, folder, name, input)) };
}
