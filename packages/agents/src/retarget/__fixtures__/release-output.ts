import { fakeSecret } from "@opscrew/core/testing";

/** A user's email in the copied rows (synthetic). */
export const ROW_EMAIL = "someone@example.com";
/** A token stored in the copied rows (synthetic). */
export const ROW_TOKEN = fakeSecret("generic-password", "row");

/** What `prisma migrate deploy` prints when a migration fails on existing rows (P3018). */
export const PRISMA_P3018 = [
  "Error: P3018",
  "",
  "A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve",
  "",
  "Migration name: 20261001000000_unique_email",
  "",
  "Database error code: 23505",
  "",
  "Database error:",
  'ERROR: could not create unique index "User_email_key"',
  `DETAIL: Key (email)=(${ROW_EMAIL}) is duplicated.`,
  "",
  `DbError { severity: "ERROR", parsed_severity: Some(Error), code: SqlState(E23505), message: "could not create unique index \\"User_email_key\\"", detail: Some("Key (email)=(${ROW_EMAIL}) is duplicated."), hint: None, position: None, where_: None, schema: Some("public"), table: Some("User"), column: None, datatype: None, constraint: Some("User_email_key"), file: Some("tuplesort.c"), line: Some(4297), routine: Some("comparetup_index_btree") }`,
].join("\n");

/** What an Alembic / SQLAlchemy migration prints when a data step fails. */
export const SQLALCHEMY_ERROR = [
  "Traceback (most recent call last):",
  '  File "/app/.venv/bin/alembic", line 8, in <module>',
  "    sys.exit(main())",
  `sqlalchemy.exc.IntegrityError: (psycopg2.errors.UniqueViolation) duplicate key value violates unique constraint "users_email_key"`,
  `DETAIL:  Key (email)=(${ROW_EMAIL}) already exists.`,
  "",
  "[SQL: INSERT INTO users (email, api_token) VALUES (%(email)s, %(api_token)s)]",
  `[parameters: {'email': '${ROW_EMAIL}', 'api_token': '${ROW_TOKEN}'}]`,
  "(Background on this error at: https://sqlalche.me/e/20/gkpj)",
].join("\n");

/** Fragments of the outputs above that must never be shown or audited. */
export const RELEASE_OUTPUT_FRAGMENTS = [
  ROW_EMAIL,
  ROW_TOKEN,
  "P3018",
  "DbError",
  "User_email_key",
  "users_email_key",
  "INSERT INTO",
  "parameters",
  "UniqueViolation",
];
