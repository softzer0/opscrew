import type { IacEngine, ResourceDrift } from "@opscrew/contracts";
import { readsProviderSchemas } from "@opscrew/iac-engine";
import { z } from "zod";

/** Attribute names per resource type, for example `{ hcloud_server: ["status"] }`. */
export type AttributesByType = Readonly<Record<string, readonly string[]>>;

/** Shown in the drift report when the provider schemas could not be read. */
export const SCHEMA_UNREADABLE_NOTE =
  "OpsCrew could not read the provider schemas, so values the cloud maintains itself may show as changes.";

const AttributeSchema = z.looseObject({
  computed: z.boolean().optional(),
  optional: z.boolean().optional(),
  required: z.boolean().optional(),
});

/** Just the part of `providers schema -json` drift needs: top-level resource attributes. */
const ProviderSchemasSchema = z.looseObject({
  provider_schemas: z
    .record(
      z.string(),
      z.looseObject({
        resource_schemas: z
          .record(
            z.string(),
            z.looseObject({
              block: z.looseObject({
                attributes: z.record(z.string(), AttributeSchema).optional(),
              }),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

/**
 * Read-only attributes per resource type from a `providers schema -json` document: computed and
 * neither optional nor required, so only the cloud sets them (`status`, `modified_on`,
 * `droplets_count`, …). Returns `undefined` when the document does not have the expected shape.
 */
export function readOnlyAttributes(document: unknown): Record<string, string[]> | undefined {
  const parsed = ProviderSchemasSchema.safeParse(document);
  if (!parsed.success) return undefined;
  const readOnly: Record<string, string[]> = {};
  for (const provider of Object.values(parsed.data.provider_schemas ?? {})) {
    for (const [type, resource] of Object.entries(provider.resource_schemas ?? {})) {
      const names = Object.entries(resource.block.attributes ?? {})
        .filter(([, a]) => a.computed === true && a.optional !== true && a.required !== true)
        .map(([name]) => name);
      if (names.length > 0) readOnly[type] = [...new Set([...(readOnly[type] ?? []), ...names])];
    }
  }
  for (const names of Object.values(readOnly)) names.sort();
  return readOnly;
}

/**
 * Read-only attributes of the providers installed in `dir` (after `init`), or `undefined` when the
 * engine cannot read provider schemas or prints something unreadable.
 */
export async function providerReadOnlyAttributes(
  engine: IacEngine,
  dir: string,
  env: Record<string, string | undefined>,
): Promise<Record<string, string[]> | undefined> {
  if (!readsProviderSchemas(engine)) return undefined;
  let document: unknown;
  try {
    document = await engine.providerSchemas(dir, { env });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return undefined;
  }
  return readOnlyAttributes(document);
}

/** Union of attribute lists per resource type. */
export function mergeAttributes(...lists: AttributesByType[]): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const list of lists) {
    for (const [type, names] of Object.entries(list)) {
      merged[type] = [...new Set([...(merged[type] ?? []), ...names])].sort();
    }
  }
  return merged;
}

/**
 * Drift without the attributes nobody changed by hand: values the cloud maintains itself
 * (read-only in the provider schema) and those a provider mirrors from a relationship OpsCrew
 * manages elsewhere (`ProviderProfile.mirroredAttributes`). Deletes, and updates the engine named
 * no attributes for, are always kept; an update left with no attributes is dropped.
 */
export function withoutIgnored(
  drift: readonly ResourceDrift[],
  ignored: AttributesByType,
): ResourceDrift[] {
  return drift.flatMap((entry) => {
    const names = ignored[entry.type];
    if (entry.action !== "update" || names === undefined || entry.attributes.length === 0) {
      return [entry];
    }
    const attributes = entry.attributes.filter((name) => !names.includes(name));
    return attributes.length === 0 ? [] : [{ ...entry, attributes }];
  });
}
