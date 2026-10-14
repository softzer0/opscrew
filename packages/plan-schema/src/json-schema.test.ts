import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ARTIFACT_KINDS, renderJsonSchemaFiles, toJsonSchemas } from "./index";

const SCHEMAS_DIR = new URL("../schemas/", import.meta.url);

describe("JSON Schema export", () => {
  it("produces draft-07 strict object schemas for every artefact", () => {
    const schemas = toJsonSchemas();
    expect(Object.keys(schemas)).toEqual([...ARTIFACT_KINDS]);
    for (const kind of ARTIFACT_KINDS) {
      expect(schemas[kind]).toMatchObject({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
      });
    }
    expect(schemas.plan).toMatchObject({
      properties: {
        target: {
          oneOf: [
            { properties: { serverType: { type: "string" } } },
            { properties: { provider: { const: "own" }, arch: { enum: ["amd64", "arm64"] } } },
          ],
        },
        portainer: { properties: { access: { enum: ["local", "subdomain"] } } },
      },
    });
  });

  it("renders deterministic 2-space JSON with a trailing newline", () => {
    const first = renderJsonSchemaFiles();
    expect(renderJsonSchemaFiles()).toEqual(first);
    for (const content of Object.values(first)) {
      expect(content.startsWith('{\n  "$schema": ')).toBe(true);
      expect(content.endsWith("}\n")).toBe(true);
    }
  });

  // The committed files are Biome-formatted (the generator runs `biome format`), so compare the
  // parsed content; `pnpm lint` guards the formatting itself.
  it.each(ARTIFACT_KINDS)(
    "schemas/%s.schema.json matches the zod schema (regenerate with `pnpm --filter @opscrew/plan-schema gen:schemas`)",
    async (kind) => {
      const committed = await readFile(new URL(`${kind}.schema.json`, SCHEMAS_DIR), "utf8");
      expect(committed.endsWith("}\n")).toBe(true);
      expect(JSON.parse(committed)).toEqual(toJsonSchemas()[kind]);
    },
  );
});
