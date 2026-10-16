/** Joins items as plain English: `a`, `a and b`, `a, b and c` (`""` for none). */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** `1 server`, `2 servers`, `0 servers`: the count and the word, with an `s` unless it is 1. */
export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A host or domain name for comparison: trimmed, lower case, without a trailing dot. */
export function normalizeHostName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}
