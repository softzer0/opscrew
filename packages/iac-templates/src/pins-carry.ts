/**
 * Carrying pins over from the committed copy of a file OpsCrew renders again, so a pin the user or
 * Dependabot updated is not reverted (FR-1222).
 */
import { NO_MAJOR_UPDATES, NO_MINOR_UPDATES } from "./dependabot";

/** `repo:tag@sha256:<hex>`, on any registry. */
const IMAGE_PIN =
  /(?<![\w./:@-])([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*):(\w[\w.-]*)@(sha256:[0-9a-f]{64})/g;
/** `owner/name[/path]@<commit> # <tag>`, the form OpsCrew and Dependabot write. */
const ACTION_PIN = /(?<![\w./-])([\w.-]+\/[\w.-]+(?:\/[\w.-]+)*)@([0-9a-f]{40}) # (\S+)/g;

interface Pin {
  tag: string;
  text: string;
}

/** A tag's version numbers and the rest (`24-alpine` → [24] and `-alpine`). */
function version(tag: string): { numbers: number[]; variant: string } | undefined {
  const match = /^v?(\d+(?:\.\d+)*)(.*)$/.exec(tag);
  if (!match) return undefined;
  return { numbers: (match[1] as string).split(".").map(Number), variant: match[2] as string };
}

/** Positive when tag `a` is a higher version than `b` of the same variant; undefined if not comparable. */
function compareTags(a: string, b: string): number | undefined {
  const [va, vb] = [version(a), version(b)];
  if (va === undefined || vb === undefined || va.variant !== vb.variant) return undefined;
  for (let i = 0; i < Math.max(va.numbers.length, vb.numbers.length); i++) {
    const diff = (va.numbers[i] ?? 0) - (vb.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * What a pin is matched by: the image or action and the tag's variant (`node -alpine`), or the
 * whole tag when it has no version (`node:latest`), so variants never hide each other.
 */
function keyOf(name: string, tag: string): string {
  const variant = version(tag)?.variant;
  return variant === undefined ? `${name}:${tag}` : `${name} ${variant}`;
}

/** The highest pin per image or action and variant in `text`; `tagGroup` is the tag's group. */
function pinsOf(text: string, pattern: RegExp, tagGroup: number): Map<string, Pin> {
  const pins = new Map<string, Pin>();
  for (const match of text.matchAll(pattern)) {
    const pin = { tag: match[tagGroup] as string, text: match[0] };
    const key = keyOf(match[1] as string, pin.tag);
    const known = pins.get(key);
    if (known === undefined || (compareTags(pin.tag, known.tag) ?? 0) > 0) pins.set(key, pin);
  }
  return pins;
}

/**
 * The committed pin when its tag is higher, or the same tag (keeping its digest or commit), or,
 * with `keepMajor`, another major version, or, with `keepMinor` too, another minor version.
 */
function newer(
  committed: Pin | undefined,
  rendered: Pin,
  keepMajor = false,
  keepMinor = false,
): string {
  if (committed === undefined) return rendered.text;
  if (committed.tag === rendered.tag) return committed.text;
  const [a, b] = [version(committed.tag)?.numbers, version(rendered.tag)?.numbers];
  if (keepMajor && a?.[0] !== b?.[0]) return committed.text;
  if (keepMinor && (a?.[0] !== b?.[0] || a?.[1] !== b?.[1])) return committed.text;
  return (compareTags(committed.tag, rendered.tag) ?? 0) > 0 ? committed.text : rendered.text;
}

/**
 * `rendered` with each image (`repo:tag@sha256:…`) and action (`owner/name@<commit> # <tag>`) pin
 * replaced by the committed one when that has a higher tag of the same variant, or the same tag
 * (its digest or commit wins). An older or incomparable committed pin gives way to the rendered
 * one, except for the images Dependabot keeps on their major ({@link NO_MAJOR_UPDATES}): their
 * committed major version stays, so a new OpsCrew pin never moves Postgres from 17 to 18, and
 * those it keeps on their minor too ({@link NO_MINOR_UPDATES}: Meilisearch) keep their minor.
 */
export function keepNewerPins(committed: string, rendered: string): string {
  const images = pinsOf(committed, IMAGE_PIN, 2);
  const actions = pinsOf(committed, ACTION_PIN, 3);
  return rendered
    .replace(IMAGE_PIN, (text, repo: string, tag: string) =>
      newer(
        images.get(keyOf(repo, tag)),
        { tag, text },
        NO_MAJOR_UPDATES.includes(repo),
        NO_MINOR_UPDATES.includes(repo),
      ),
    )
    .replace(ACTION_PIN, (text, action: string, _commit: string, tag: string) =>
      newer(actions.get(keyOf(action, tag)), { tag, text }),
    );
}
