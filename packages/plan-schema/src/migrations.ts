import { z } from "zod";
import { CommandLineSchema } from "./enums";

/**
 * The migration tools whose down migrations a rollback runs (research R9), with what each records
 * of the database's state and `down`'s placeholders:
 * - `version`: the version or revision; `down` goes back to `{version}`;
 * - `apps`: Django's last migration per app; `down` runs once per app with `{app}` and `{name}`;
 * - `count`: the number applied; `down` undoes `{count}` at once;
 * - `each`: the number applied; `down` undoes the newest and runs once per migration.
 */
export const MIGRATION_TOOLS = {
  rails: { unit: "version", placeholders: ["version"] },
  django: { unit: "apps", placeholders: ["app", "name"] },
  alembic: { unit: "version", placeholders: ["version"] },
  "flask-migrate": { unit: "version", placeholders: ["version"] },
  knex: { unit: "each", placeholders: [] },
  sequelize: { unit: "each", placeholders: [] },
  typeorm: { unit: "each", placeholders: [] },
  laravel: { unit: "count", placeholders: ["count"] },
} as const satisfies Record<
  string,
  { unit: "version" | "apps" | "count" | "each"; placeholders: readonly string[] }
>;

export type MigrationTool = keyof typeof MIGRATION_TOOLS;

const MigrationToolSchema = z.enum(Object.keys(MIGRATION_TOOLS) as [MigrationTool]);

/** What each placeholder stands for, in a refusal. */
const PLACEHOLDER_MEANINGS: Record<string, string> = {
  version: "the version the database goes back to",
  app: "the Django app",
  name: "its migration to go back to",
  count: "how many migrations to undo",
};

/**
 * `app.migrations`: how a rollback reads the database's migrations and undoes them, run like the
 * release command (same folder and options). `status` prints the applied migrations; `down` undoes
 * them with its tool's placeholders ({@link MIGRATION_TOOLS}). Requires `app.releaseCommand`.
 */
export const MigrationsSchema = z
  .strictObject({
    tool: MigrationToolSchema,
    status: CommandLineSchema,
    down: CommandLineSchema,
  })
  .superRefine((migrations, ctx) => {
    const { tool, down } = migrations;
    const expected: readonly string[] = MIGRATION_TOOLS[tool].placeholders;
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["down"], message });
    const found = [...down.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1] as string);
    const other = found.filter((name) => !expected.includes(name));
    if (other.length > 0) {
      const names = other.map((name) => `{${name}}`).join(", ");
      issue(
        expected.length === 0
          ? `must have no placeholder with tool "${tool}": it runs once per migration, undoing the newest; found ${names}`
          : `must use only ${expected.map((name) => `{${name}}`).join(" and ")} with tool "${tool}"; found ${names}`,
      );
    }
    for (const name of expected) {
      if (!found.includes(name)) {
        issue(`must contain {${name}} with tool "${tool}": ${PLACEHOLDER_MEANINGS[name]}`);
      }
    }
  });
export type Migrations = z.output<typeof MigrationsSchema>;
