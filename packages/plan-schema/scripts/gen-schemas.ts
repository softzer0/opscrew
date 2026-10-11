/**
 * Writes `schemas/<kind>.schema.json` from the zod schemas, then formats them with the repo's
 * Biome config so `pnpm lint` stays clean. Run `pnpm --filter @opscrew/plan-schema gen:schemas`
 * and commit the result; `src/json-schema.test.ts` fails when the committed files are out of date.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderJsonSchemaFiles } from "../src/json-schema";

const outDir = fileURLToPath(new URL("../schemas/", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

await mkdir(outDir, { recursive: true });
const written: string[] = [];
for (const [name, content] of Object.entries(renderJsonSchemaFiles())) {
  const file = join(outDir, name);
  await writeFile(file, content, "utf8");
  written.push(file);
  console.log(`wrote schemas/${name}`);
}

const biome = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
const result = spawnSync(process.execPath, [biome, "format", "--write", ...written], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("Biome could not format the generated schemas; run `pnpm format`.");
  process.exitCode = 1;
}
