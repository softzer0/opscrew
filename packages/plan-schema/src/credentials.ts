import { z } from "zod";
import { IsoDateTimeSchema } from "./enums";
import { EnvironmentNameSchema } from "./plan";

/**
 * A credential's name, as `opscrew rotate` takes it: a lower-case name (`db`, `deploy-key`,
 * `hetzner`), optionally followed by `:` and a part (`app:SECRET_KEY_BASE`, `grant:laptop/cache`).
 */
export const CredentialNameSchema = z.string().regex(/^[a-z][a-z0-9-]*(?::[A-Za-z0-9_./-]+)?$/, {
  message:
    "must be a lower-case name such as `db` or `deploy-key`, optionally with `:` and a part such as `app:SECRET_KEY_BASE`",
});

/** When a credential was made or last rotated, and how many values it has had. Never a value. */
export const CredentialEntrySchema = z.strictObject({
  madeAt: IsoDateTimeSchema.optional(),
  rotatedAt: IsoDateTimeSchema.optional(),
  /** 1 for the first value, one more after each rotation. */
  generation: z.int().min(1),
});
export type CredentialEntry = z.infer<typeof CredentialEntrySchema>;

/**
 * `opscrew/credentials.yaml`: per environment name, per credential name, its dates and generation.
 * Committed; values never go in it. A credential with no entry dates from the first deploy.
 */
export const CredentialsRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  environments: z.record(
    EnvironmentNameSchema,
    z.record(CredentialNameSchema, CredentialEntrySchema),
  ),
});
export type CredentialsRecord = z.infer<typeof CredentialsRecordSchema>;
