/**
 * Small text helpers shared by the health-route edits. "Code" text is the source with string
 * contents, comments (and JavaScript regex bodies) replaced by spaces, so offsets match the
 * original and plain regular expressions only see code.
 */

/** The file's line ending. */
export function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Offsets where each line starts. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** Zero-based line of an offset. */
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The text of every line, without line endings. */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Leading whitespace of a line. */
export function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? "";
}

/** True when a line holds only whitespace (or is missing). */
export function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

/**
 * The offset just after the bracket that closes the one at `open` in code text (`(`, `[` or `{`),
 * or undefined when it is not closed.
 */
export function closingBracket(code: string, open: number): number | undefined {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const char = code[i] as string;
    if (char in pairs) stack.push(pairs[char] as string);
    else if (char === ")" || char === "]" || char === "}") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return i + 1;
    }
  }
  return undefined;
}

/** One argument of a call (or element of a list) in code text: offsets of its trimmed text. */
export interface Part {
  start: number;
  end: number;
  /** For a `name=value` / `name: value` part, the name and where the value starts. */
  name?: string;
  valueStart?: number;
}

/**
 * The comma-separated parts between the bracket at `open` and its closing bracket (top level
 * only), with `name=` (Python keyword arguments) or `name:` (object properties) split off.
 */
export function partsOf(code: string, open: number, assign: "=" | ":"): Part[] | undefined {
  const close = closingBracket(code, open);
  if (close === undefined) return undefined;
  const parts: Part[] = [];
  let depth = 0;
  let start = open + 1;
  const push = (end: number) => {
    const raw = code.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text === "") return;
    const part: Part = { start: start + lead, end: start + lead + text.length };
    const named =
      assign === "="
        ? /^(\*{0,2}[A-Za-z_]\w*)\s*=(?!=)\s*/.exec(text)
        : /^([A-Za-z_$][\w$]*|["'][^"']*["'])\s*:\s*/.exec(text);
    if (named?.[1] !== undefined) {
      part.name = named[1].replace(/^["']|["']$/g, "");
      part.valueStart = part.start + named[0].length;
    }
    parts.push(part);
  };
  for (let i = open + 1; i < close - 1; i++) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(close - 1);
  return parts;
}

/** A text insertion. */
export interface Insertion {
  offset: number;
  text: string;
}

/** Applies insertions; at the same offset they keep their listed order. */
export function applyInsertions(text: string, insertions: readonly Insertion[]): string {
  const ordered = insertions
    .map((insertion, order) => ({ ...insertion, order }))
    .sort((a, b) => b.offset - a.offset || b.order - a.order);
  let result = text;
  for (const { offset, text: added } of ordered) {
    result = `${result.slice(0, offset)}${added}${result.slice(offset)}`;
  }
  return result;
}

/**
 * Adds `entry` as the first element of the list (or call arguments) whose opening bracket is at
 * `open`: on its own line when the list spans several lines, inline otherwise.
 */
export function prependElement(
  text: string,
  code: string,
  open: number,
  entry: string,
): Insertion | undefined {
  const close = closingBracket(code, open);
  if (close === undefined) return undefined;
  const inner = code.slice(open + 1, close - 1);
  if (inner.trim() === "") return { offset: open + 1, text: entry };
  const newline = /^[ \t]*\r?\n/.exec(inner);
  if (newline === null) {
    const lead = inner.length - inner.trimStart().length;
    return { offset: open + 1 + lead, text: `${entry}, ` };
  }
  // Multi-line: a new line with the indentation of the first element.
  const firstLineStart = open + 1 + newline[0].length;
  const indent = indentOf(text.slice(firstLineStart));
  return { offset: firstLineStart, text: `${indent}${entry},${eolOf(text)}` };
}

/**
 * Adds `entry` as the last element of the list whose opening bracket is at `open`, with the comma
 * the previous last element needs; the new element keeps the list's trailing-comma style.
 */
export function appendElement(
  text: string,
  code: string,
  open: number,
  entry: string,
): Insertion[] | undefined {
  const close = closingBracket(code, open);
  if (close === undefined) return undefined;
  const bracket = close - 1;
  const inner = code.slice(open + 1, bracket);
  if (inner.trim() === "") return [{ offset: open + 1, text: entry }];
  const lastCode = open + 1 + inner.trimEnd().length;
  const hasComma = code[lastCode - 1] === ",";
  if (!/\n/.test(inner)) {
    return [{ offset: lastCode, text: `${hasComma ? " " : ", "}${entry}` }];
  }
  // Multi-line: after the last element's line, with that element's indentation.
  const lineStart = text.lastIndexOf("\n", lastCode - 1) + 1;
  const indent = indentOf(text.slice(lineStart));
  const eol = eolOf(text);
  const lineEnd = text.indexOf("\n", lastCode);
  const comma = hasComma ? "" : ",";
  const trailing = hasComma ? "," : "";
  if (lineEnd === -1 || lineEnd > bracket) {
    return [{ offset: lastCode, text: `${comma}${eol}${indent}${entry}${trailing}` }];
  }
  return [
    ...(comma === "" ? [] : [{ offset: lastCode, text: comma }]),
    { offset: lineEnd + 1, text: `${indent}${entry}${trailing}${eol}` },
  ];
}

/** The most common indentation step between a line and a more indented next line. */
export function indentUnit(lines: readonly string[], fallback: string): string {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < lines.length; i++) {
    const line = lines[i] as string;
    const next = lines[i + 1] as string;
    if (isBlank(line) || isBlank(next)) continue;
    const a = indentOf(line);
    const b = indentOf(next);
    if (b.length > a.length && b.startsWith(a)) {
      const step = b.slice(a.length);
      if (/^(?:\t| {2,8})$/.test(step)) counts.set(step, (counts.get(step) ?? 0) + 1);
    }
  }
  let best = fallback;
  let max = 0;
  for (const [step, count] of counts) {
    if (count > max) {
      best = step;
      max = count;
    }
  }
  return best;
}

/** Escapes a string for a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** `a`, `a and b`, `a, b and c`. */
export function listing(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
