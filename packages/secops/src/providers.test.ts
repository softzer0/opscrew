import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL(".", import.meta.url));
/** Cloud server provider facts that belong in the provider definitions (ADR 0029), not here. */
const PROVIDER_FACT = /"hetzner"|"digitalocean"|hcloud_|digitalocean_/i;

/** Source files outside tests, fixtures and snapshots. */
function sourceFiles(): string[] {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .map((file) => file.replace(/\\/g, "/"))
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .filter((file) => !/(?:^|\/)(?:__fixtures__|__snapshots__|fixtures)\//.test(file));
}

describe("cloud server provider facts", () => {
  it("come from the provider registry, never from secops's own source", () => {
    const found = sourceFiles().flatMap((file) =>
      readFileSync(`${SRC}${file}`, "utf8")
        .split("\n")
        .flatMap((line, index) => (PROVIDER_FACT.test(line) ? [`${file}:${index + 1}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
