import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ACTIONS, IMAGES, PACKAGE_MANAGERS, TOOLS } from "./index";
import { pinnedValues, withPinPlaceholders } from "./pin-snapshots";

const SRC = new URL("./", import.meta.url);

describe("the pin snapshot serializer", () => {
  it("names each pin by its place in pins.ts", () => {
    const values = pinnedValues();
    expect(values.get(IMAGES.caddy.ref)).toBe("<pin:IMAGES.caddy>");
    expect(values.get(ACTIONS.checkout)).toBe("<pin:ACTIONS.checkout>");
    expect(values.get(TOOLS.pack.sha256.arm64)).toBe("<pin:TOOLS.pack.sha256.arm64>");
    expect(values.get(TOOLS.hugo.url)).toBe("<pin:TOOLS.hugo.url>");
    expect(values.get(PACKAGE_MANAGERS.pnpm)).toBe("<pin:PACKAGE_MANAGERS.pnpm>");
    expect(values.has("sops")).toBe(false);
  });

  it("replaces whole pinned values only", () => {
    const { pnpm } = PACKAGE_MANAGERS;
    expect(withPinPlaceholders(`FROM ${IMAGES.nodeAlpine.ref} AS build`)).toBe(
      "FROM <pin:IMAGES.nodeAlpine> AS build",
    );
    expect(withPinPlaceholders(`npm install -g pnpm@${pnpm}.`)).toBe(
      "npm install -g pnpm@<pin:PACKAGE_MANAGERS.pnpm>.",
    );
    expect(withPinPlaceholders(`v1${pnpm}`)).toBe(`v1${pnpm}`);
    expect(withPinPlaceholders(`${pnpm}.1`)).toBe(`${pnpm}.1`);
  });

  it("leaves no pinned value in any snapshot file", async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith(".snap"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = await readFile(new URL(file.replaceAll("\\", "/"), SRC), "utf8");
      const lines = text.split("\n");
      const changed = withPinPlaceholders(text)
        .split("\n")
        .filter((line, i) => line !== lines[i]);
      expect(changed, file).toEqual([]);
    }
  });
});
