import type { DeployPlan } from "@opscrew/plan-schema";
import { shellQuote } from "../runtime/services";

/** The migration records' folder in the app's folder (plan.md 12.3). */
export const SCHEMA_DIR = ".schema";

/** Version `<hex>`'s migration record: `version=<v>`, `count=<n>`, or `app=<app> <name>` lines. */
export function schemaRecordPath(hex: string): string {
  return `${SCHEMA_DIR}/${hex}`;
}

/**
 * The start script's lines that record the database's migrations under the new version's digest
 * (`.schema/<hex>`), in `MODE` `deploy` right after the release command succeeded. None yet: the
 * record comes with the down migrations.
 */
export function migrationRecord(_plan: DeployPlan): string[] {
  return [];
}

/**
 * The rollback's down migrations: a script fragment that runs in a subshell of the start script's
 * database step, inside an `if` condition, so `set -e` doesn't apply there and every command that
 * can fail exits the fragment non-zero itself. A non-zero exit puts the database back as it was
 * before the rollback. Not available yet, so it always exits non-zero.
 */
export function migrationDown(_plan: DeployPlan): string[] {
  return [
    `echo ${shellQuote("::error::Down migrations aren't available for this app.")}`,
    "exit 1",
  ];
}
