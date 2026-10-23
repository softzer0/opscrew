/**
 * The snapshot serializer of this package's tests (`snapshotSerializers` in vitest.config.ts): it
 * writes each value pins.ts exports as a placeholder naming its pin, such as `<pin:IMAGES.caddy>`
 * or `<pin:TOOLS.pack.sha256.amd64>`, so a pin refresh changes no snapshot while the snapshots
 * still show which pin lands where. The values are read from pins.ts's exports at run time.
 */
import type { SnapshotSerializer } from "vitest";
import { ACTIONS, IMAGES, LOCAL_TOOLS, PACKAGE_MANAGERS, PYPI_PACKAGES, TOOLS } from "./pins";

/** The tables of pins.ts whose values are pins (not the runtime defaults or Buildpacks offers). */
const PIN_TABLES = { IMAGES, ACTIONS, TOOLS, LOCAL_TOOLS, PACKAGE_MANAGERS, PYPI_PACKAGES };

/** Keys of a pin that describe it rather than pin it (a local tool's name and env override). */
const NOT_PINNED = new Set(["name", "envOverride"]);

/** Each pinned value with its placeholder, longest value first. */
export function pinnedValues(): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  const walk = (path: string, value: unknown): void => {
    if (typeof value === "string") {
      if (!found.has(value)) found.set(value, `<pin:${path}>`);
    } else if (typeof value === "object" && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        // An image is named by its key alone: `IMAGES.caddy`, not `IMAGES.caddy.ref`.
        if (!NOT_PINNED.has(key)) walk(key === "ref" ? path : `${path}.${key}`, inner);
      }
    }
  };
  for (const [table, values] of Object.entries(PIN_TABLES)) walk(table, values);
  return new Map([...found].sort(([a], [b]) => b.length - a.length));
}

const PLACEHOLDERS = pinnedValues();

/** A pinned value standing on its own: not part of a longer name, version or digest. */
const PINNED = new RegExp(
  `(?<![\\w.-])(?:${[...PLACEHOLDERS.keys()].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\w-]|\\.\\w)`,
  "g",
);

/** `text` with every pinned value replaced by its placeholder. */
export function withPinPlaceholders(text: string): string {
  return text.replace(PINNED, (value) => PLACEHOLDERS.get(value) as string);
}

const serializer: SnapshotSerializer = {
  test: (value) => typeof value === "string" && withPinPlaceholders(value) !== value,
  serialize: (value, config, indentation, depth, refs, printer) =>
    printer(withPinPlaceholders(value as string), config, indentation, depth, refs),
};

export default serializer;
