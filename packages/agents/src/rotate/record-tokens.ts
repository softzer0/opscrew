/**
 * When OpsCrew first saw each of the user's own tokens (`~/.opscrew/token-dates.json`, 0600, never
 * committed): Hetzner and DigitalOcean show no date of their own. Only a SHA-256 fingerprint of a
 * token is kept, never the token.
 */
import { join } from "node:path";
import { type ProjectPaths, sha256Hex, writeFileAtomic } from "@opscrew/core";
import { IsoDateTimeSchema } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readValidJson } from "../shared/files";

/**
 * Per token name, per fingerprint, the date it was first seen: a computer that uses two tokens of
 * one name (two Hetzner projects) keeps both dates.
 */
const TokenDatesSchema = z.record(
  z.string(),
  z.record(z.string().regex(/^[0-9a-f]{64}$/), IsoDateTimeSchema),
);

/** The token dates' file in OpsCrew's home, for every project of this computer's user. */
export function tokenDatesFile(paths: Pick<ProjectPaths, "homeDir">): string {
  return join(paths.homeDir, "token-dates.json");
}

async function readTokenDates(deps: Pick<PhaseDeps, "paths">) {
  return (await readValidJson(tokenDatesFile(deps.paths), TokenDatesSchema)) ?? {};
}

/** When the token `name` with `value` was first seen on this computer; `undefined` if never. */
export async function tokenSeenAt(
  deps: Pick<PhaseDeps, "paths">,
  name: string,
  value: string,
): Promise<string | undefined> {
  return (await readTokenDates(deps))[name]?.[sha256Hex(value)];
}

/**
 * When the token `name` with `value` was first seen on this computer: recorded now (by its
 * fingerprint, 0600) the first time, and returned as an ISO date. A damaged file is started again.
 */
export async function tokenFirstSeen(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  name: string,
  value: string,
): Promise<string> {
  const dates = await readTokenDates(deps);
  const fingerprint = sha256Hex(value);
  const seen = dates[name]?.[fingerprint];
  if (seen !== undefined) return seen;
  const now = deps.clock.now().toISOString();
  const next = { ...dates, [name]: { ...dates[name], [fingerprint]: now } };
  await writeFileAtomic(
    tokenDatesFile(deps.paths),
    `${JSON.stringify(next, null, 2)}
`,
  );
  return now;
}
