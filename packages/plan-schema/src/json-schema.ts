import { z } from "zod";
import { ARTIFACT_FILES, ARTIFACT_KINDS, ARTIFACT_SCHEMAS, type ArtifactKind } from "./io";

const TITLES: Record<ArtifactKind, string> = {
  architecture: "OpsCrew architecture (opscrew/architecture.json)",
  requirements: "OpsCrew requirements (opscrew/requirements.yaml)",
  plan: "OpsCrew deploy plan (opscrew/plan.yaml)",
};

/**
 * Draft-07 JSON Schemas for the three artefacts, for editors and external tools.
 * Generated in `input` mode: they describe what OpsCrew accepts when reading a file, so fields
 * that have defaults are optional. Cross-field rules are enforced by zod only.
 */
export function toJsonSchemas(): Record<ArtifactKind, object> {
  const out = {} as Record<ArtifactKind, object>;
  for (const kind of ARTIFACT_KINDS) {
    const { $schema, ...rest } = z.toJSONSchema(ARTIFACT_SCHEMAS[kind], {
      target: "draft-7",
      io: "input",
    });
    out[kind] = {
      $schema,
      title: TITLES[kind],
      description: `Schema v1 of ${ARTIFACT_FILES[kind]}. Generated from @opscrew/plan-schema; do not edit.`,
      ...rest,
    };
  }
  return out;
}

/** File name and exact contents (2-space JSON, trailing newline) of every generated schema file. */
export function renderJsonSchemaFiles(): Record<`${ArtifactKind}.schema.json`, string> {
  const schemas = toJsonSchemas();
  const files = {} as Record<`${ArtifactKind}.schema.json`, string>;
  for (const kind of ARTIFACT_KINDS) {
    files[`${kind}.schema.json`] = `${JSON.stringify(schemas[kind], null, 2)}\n`;
  }
  return files;
}
