/**
 * The package.json script that applies an app's migrations, chosen so a deploy never runs one that
 * changes or deletes data in other ways (reset, drop, rollback, schema sync, seed) or one that only
 * starts a migration CLI without a subcommand.
 */

/** Package scripts that run the app's migrations, in order of preference. */
export const MIGRATE_SCRIPTS = ["migrate", "db:migrate", "migrate:deploy", "migrate:prod"] as const;

/**
 * Script bodies that do something other than apply pending migrations: create or generate
 * migrations, reset, drop, roll back, sync, push or seed a schema, or watch for changes.
 */
export const NOT_A_DEPLOY_MIGRATION = new RegExp(
  [
    String.raw`(?:\bmigrat\w*:|\bdb:|\bschema:|\bmigrate\s+)(?:fresh|refresh|reset|rollback|undo|revert|down|drop|sync)\b`,
    String.raw`\bschema:(?:update|create)\b`,
    String.raw`\bmigrate\s+dev\b`,
    String.raw`\bmigration:(?:generate|create)\b`,
    String.raw`\bmake:?migrations?\b`,
    String.raw`\bdrizzle-kit\s+(?:generate|push|drop)\b`,
    String.raw`\bdb\s+push\b`,
    String.raw`--force-reset\b`,
    String.raw`\bdb:seed\b`,
    String.raw`--seed\b`,
    String.raw`--watch\b`,
  ].join("|"),
);

/** Script names that, when another script runs them, mean more than applying migrations. */
const UNSAFE_SCRIPT_NAME = /(?:push|reset|fresh|drop|sync|seed|rollback|undo|revert|down)\b/;

/** A body that only starts a migration CLI, which then waits for a subcommand (or fails). */
const BARE_CLI =
  /^(?:npx\s+)?(node-pg-migrate|knex|db-migrate|sequelize(?:-cli)?|typeorm(?:-ts-node-\w+)?|mikro-orm|kysely|drizzle-kit|prisma)$/;

/** Names of other package scripts a body runs (`npm run x`, `pnpm x`, `yarn x`, `bun run x`). */
function referencedScripts(body: string, scripts: Readonly<Record<string, string>>): string[] {
  const names: string[] = [];
  for (const match of body.matchAll(
    /\b(?:npm|bun)\s+run\s+([\w:.-]+)|\bpnpm\s+(?:run\s+)?([\w:.-]+)|\byarn\s+(?:run\s+)?([\w:.-]+)/g,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name && (name in scripts || UNSAFE_SCRIPT_NAME.test(name))) names.push(name);
  }
  return names;
}

/** Why a script body must not run on every deploy, or undefined when it may. */
function rejection(body: string, scripts: Readonly<Record<string, string>>): string | undefined {
  const trimmed = body.trim();
  const cli = BARE_CLI.exec(trimmed)?.[1];
  if (cli) return `it only starts \`${cli}\` without saying what to run`;
  const unsafe = NOT_A_DEPLOY_MIGRATION.exec(trimmed)?.[0];
  if (unsafe) return `it does more than apply pending migrations (\`${unsafe.trim()}\`)`;
  for (const name of referencedScripts(trimmed, scripts)) {
    if (UNSAFE_SCRIPT_NAME.test(name)) {
      return `it runs the script \`${name}\`, which does more than apply pending migrations`;
    }
    const inner = scripts[name] ?? "";
    const innerUnsafe = NOT_A_DEPLOY_MIGRATION.exec(inner)?.[0];
    if (innerUnsafe) {
      return `it runs the script \`${name}\`, which does more than apply pending migrations (\`${innerUnsafe.trim()}\`)`;
    }
    const innerCli = BARE_CLI.exec(inner.trim())?.[1];
    if (innerCli) {
      return `it runs the script \`${name}\`, which only starts \`${innerCli}\` without saying what to run`;
    }
  }
  return undefined;
}

/** A migrate script that was not used, and why. */
export interface RejectedScript {
  name: string;
  reason: string;
}

/**
 * The first of {@link MIGRATE_SCRIPTS} that only applies migrations (judging scripts it runs one
 * level deep too), and the ones skipped before it with the reason.
 */
export function pickMigrateScript(scripts: Readonly<Record<string, string>>): {
  script?: string;
  rejected: RejectedScript[];
} {
  const rejected: RejectedScript[] = [];
  for (const name of MIGRATE_SCRIPTS) {
    const body = scripts[name];
    if (body === undefined || body.trim() === "") continue;
    const reason = rejection(body, scripts);
    if (reason === undefined) return { script: name, rejected };
    rejected.push({ name, reason });
  }
  return { rejected };
}

/** The plain-English note for skipped scripts (they are never run). */
export function rejectedScriptsNote(
  rejected: readonly RejectedScript[],
  hasCommand: boolean,
): string {
  const which = rejected
    .map((script) => `\`${script.name}\` because ${script.reason}`)
    .join("; and ");
  const instead = hasCommand
    ? "Deploys run the detected migration command instead."
    : "Deploys run no migrations.";
  return `OpsCrew did not use the package.json script ${which}. ${instead} To have deploys run a script, make it only apply pending migrations and run \`opscrew analyze\` again, or set \`app.releaseCommand\` in opscrew/plan.yaml.`;
}
