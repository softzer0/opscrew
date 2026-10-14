/**
 * A light JavaScript/TypeScript reader for the health-route edits: blanks strings, comments,
 * template text and regular expressions (keeping offsets), reads imports and `require` calls, and
 * finds the statements that create an app object.
 */
import {
  closingBracket,
  eolOf,
  indentOf,
  indentUnit,
  lineAt,
  lineStarts,
  splitLines,
} from "./text";

/** A string literal: offsets of the opening quote and just after the closing one. */
export interface JsString {
  start: number;
  end: number;
  quote: string;
}

/** A scanned source file. */
export interface JsSource {
  text: string;
  /** The text with string contents, comments, template text and regex bodies as spaces. */
  code: string;
  strings: JsString[];
}

const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
]);

/** Scans a JavaScript or TypeScript file. */
export function scanJs(text: string): JsSource {
  const out = text.split("");
  const strings: JsString[] = [];
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  /** `{` for a block, `t` for a `${` inside a template literal. */
  const stack: string[] = [];
  let prev = "";
  let word = "";
  let i = 0;
  const n = text.length;

  const template = (from: number): number => {
    // From just after a backtick or a closing `}` of `${…}`: template text until `${` or "`".
    let k = from;
    while (k < n) {
      const char = text[k];
      if (char === "\\") {
        k += 2;
        continue;
      }
      if (char === "`") {
        blank(from, k);
        return k + 1;
      }
      if (char === "$" && text[k + 1] === "{") {
        blank(from, k);
        stack.push("t");
        return k + 2;
      }
      k++;
    }
    blank(from, n);
    return n;
  };

  while (i < n) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      let k = i + 1;
      while (k < n && text[k] !== char && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      const end = Math.min(k + 1, n);
      blank(i + 1, Math.min(k, n));
      strings.push({ start: i, end, quote: char });
      i = end;
      prev = '"';
      word = "";
      continue;
    }
    if (char === "`") {
      const after = template(i + 1);
      // Only a template without `${…}` has a plain value.
      strings.push({ start: i, end: text[after - 1] === "`" ? after : i + 1, quote: "`" });
      i = after;
      prev = '"';
      word = "";
      continue;
    }
    if (char === "/") {
      const regex =
        prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || KEYWORDS_BEFORE_REGEX.has(word);
      if (regex) {
        let k = i + 1;
        let inClass = false;
        while (k < n && text[k] !== "\n") {
          const c = text[k];
          if (c === "\\") {
            k += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          else if (c === "/" && !inClass) break;
          k++;
        }
        blank(i + 1, Math.min(k, n));
        i = k + 1;
        while (i < n && /[a-z]/i.test(text[i] as string)) i++;
        prev = ")";
        word = "";
        continue;
      }
    }
    if (char === "{") stack.push("{");
    if (char === "}") {
      const top = stack.pop();
      if (top === "t") {
        i = template(i + 1);
        prev = '"';
        word = "";
        continue;
      }
    }
    if (/[\w$]/.test(char)) {
      let k = i;
      while (k < n && /[\w$]/.test(text[k] as string)) k++;
      word = text.slice(i, k);
      prev = KEYWORDS_BEFORE_REGEX.has(word) ? "(" : "a";
      i = k;
      continue;
    }
    if (!/\s/.test(char)) {
      prev = char;
      word = "";
    }
    i++;
  }
  return { text, code: out.join(""), strings };
}

/** The string literal starting at `offset` (its opening quote), if any. */
export function stringAt(src: JsSource, offset: number): JsString | undefined {
  return src.strings.find((s) => s.start === offset);
}

/** The value of the string literal starting at `offset`. */
export function stringValue(src: JsSource, offset: number): string | undefined {
  const literal = stringAt(src, offset);
  if (literal === undefined || literal.quote === "`") return undefined;
  return src.text.slice(literal.start + 1, literal.end - 1);
}

/** An import (ESM, TypeScript `import =` or a top-level `require`). */
export interface JsImport {
  module: string;
  /** Offset just after the statement (after its `;` when it has one). */
  end: number;
  /** The quote around the module name. */
  quote: string;
  semicolon: boolean;
  /** Local name → what it is: `default`, `*` or the imported name. */
  bindings: Map<string, string>;
  /** Offsets of `{` and `}` of an ESM named-import list. */
  named?: { open: number; close: number };
  kind: "esm" | "require";
}

const ESM_IMPORT =
  /(^|[\n;])[ \t]*import\s+(type\s+)?([\w$*{}\s,]+?)\s*from\s*(["'])|(^|[\n;])[ \t]*import\s*(["'])/g;
const IMPORT_EQUALS = /(^|[\n;])[ \t]*(?:export\s+)?import\s+([\w$]+)\s*=\s*require\(\s*(["'])/g;
const REQUIRE = /(^|[\n;])[ \t]*(?:const|let|var)\s+([\w$]+|\{[^}]*\})\s*=\s*require\(\s*(["'])/g;

/** Reads the end of an import statement whose module string starts at `quoteAt`. */
function statementEnd(src: JsSource, quoteAt: number): { end: number; semicolon: boolean } {
  const literal = stringAt(src, quoteAt);
  let end = literal?.end ?? quoteAt + 1;
  const rest = /^[ \t]*\)?/.exec(src.code.slice(end))?.[0] ?? "";
  end += rest.length;
  const tail = /^[ \t]*(?:(?:with|assert)\s*\{[^}]*\}[ \t]*)?;/.exec(src.code.slice(end));
  return tail === null ? { end, semicolon: false } : { end: end + tail[0].length, semicolon: true };
}

/** Every import of a file. */
export function jsImports(src: JsSource): JsImport[] {
  const imports: JsImport[] = [];
  for (const match of src.code.matchAll(ESM_IMPORT)) {
    const quoteAt = match.index + match[0].length - 1;
    const module = stringValue(src, quoteAt);
    if (module === undefined) continue;
    const bindings = new Map<string, string>();
    let named: JsImport["named"];
    const clause = match[3];
    if (clause !== undefined && match[2] === undefined) {
      const clauseStart = match.index + match[0].indexOf(clause, (match[1] ?? "").length);
      const braceOpen = clause.indexOf("{");
      if (braceOpen !== -1) {
        const braceClose = clause.indexOf("}", braceOpen);
        named = { open: clauseStart + braceOpen, close: clauseStart + braceClose };
        for (const spec of clause.slice(braceOpen + 1, braceClose).split(",")) {
          const parts = spec.trim().split(/\s+/);
          if (parts[0] === "" || parts[0] === undefined || parts[0] === "type") continue;
          const imported = parts[0];
          const local = parts[1] === "as" ? parts[2] : imported;
          if (local) bindings.set(local, imported);
        }
      }
      const outside = (braceOpen === -1 ? clause : clause.slice(0, braceOpen)).split(",");
      for (const piece of outside) {
        const text = piece.trim();
        const star = /^\*\s*as\s+([\w$]+)$/.exec(text);
        if (star?.[1]) bindings.set(star[1], "*");
        else if (/^[\w$]+$/.test(text)) bindings.set(text, "default");
      }
    }
    const { end, semicolon } = statementEnd(src, quoteAt);
    imports.push({
      module,
      end,
      quote: src.text[quoteAt] as string,
      semicolon,
      bindings,
      ...(named === undefined ? {} : { named }),
      kind: "esm",
    });
  }
  for (const match of src.code.matchAll(IMPORT_EQUALS)) {
    const quoteAt = match.index + match[0].length - 1;
    const module = stringValue(src, quoteAt);
    if (module === undefined || match[2] === undefined) continue;
    const { end, semicolon } = statementEnd(src, quoteAt);
    imports.push({
      module,
      end,
      quote: src.text[quoteAt] as string,
      semicolon,
      bindings: new Map([[match[2], "default"]]),
      kind: "esm",
    });
  }
  for (const match of src.code.matchAll(REQUIRE)) {
    const quoteAt = match.index + match[0].length - 1;
    const module = stringValue(src, quoteAt);
    const target = match[2];
    if (module === undefined || target === undefined) continue;
    const bindings = new Map<string, string>();
    if (target.startsWith("{")) {
      for (const spec of target.slice(1, -1).split(",")) {
        const [imported, local] = spec.split(":").map((part) => part.trim());
        if (imported && /^[\w$]+$/.test(imported)) bindings.set(local || imported, imported);
      }
    } else {
      bindings.set(target, "default");
    }
    const { end, semicolon } = statementEnd(src, quoteAt);
    imports.push({
      module,
      end,
      quote: src.text[quoteAt] as string,
      semicolon,
      bindings,
      kind: "require",
    });
  }
  return imports.sort((a, b) => a.end - b.end);
}

/**
 * What a callee such as `express`, `Hapi.server` or `require("koa")` refers to: the module name,
 * followed by `.name` for a named import and by the member path (`@hapi/hapi.server`).
 */
export function resolveCallee(
  src: JsSource,
  imports: readonly JsImport[],
  callee: string,
  calleeAt: number,
): string | undefined {
  const required = /^require\(\s*["']/.exec(callee);
  if (required) return stringValue(src, calleeAt + required[0].length - 1);
  const [head, ...rest] = callee.split(".").map((part) => part.trim());
  if (rest.some((part) => !/^[\w$]+$/.test(part))) return undefined;
  if (head === undefined) return undefined;
  for (const entry of imports) {
    const what = entry.bindings.get(head);
    if (what === undefined) continue;
    const base = what === "default" || what === "*" ? entry.module : `${entry.module}.${what}`;
    return [base, ...rest].join(".");
  }
  return undefined;
}

/** A call that creates an app object. */
export interface JsCall {
  /** Resolved callee, e.g. `express` or `hono.Hono`. */
  target: string;
  /** Offset of the call expression (`new` included). */
  start: number;
  /** Offset of the call's `(`. */
  open: number;
  /** Offset just after the call's `)`. */
  close: number;
  isNew: boolean;
}

const CALL =
  /(?<![\w$.])(new\s+)?(require\(\s*["'][^"'\n]*["']\s*\)|[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*(?:<[^()]*?>)?\s*\(/g;

/** Every call (or `new`) of one of `targets` in the file. */
export function findCalls(
  src: JsSource,
  imports: readonly JsImport[],
  targets: ReadonlySet<string>,
): JsCall[] {
  const calls: JsCall[] = [];
  for (const match of src.code.matchAll(CALL)) {
    const raw = match[2] ?? "";
    const callee = raw.startsWith("require") ? raw : raw.replace(/\s+/g, "");
    if (/^(?:function|if|for|while|switch|catch|return|typeof)$/.test(callee)) continue;
    const calleeAt = match.index + (match[1]?.length ?? 0);
    const target = resolveCallee(src, imports, callee, calleeAt);
    if (target === undefined || !targets.has(target)) continue;
    const open = match.index + match[0].length - 1;
    const close = closingBracket(src.code, open);
    if (close === undefined) continue;
    calls.push({ target, start: match.index, open, close, isNew: match[1] !== undefined });
  }
  return calls;
}

/** The statement `const <name> = <call>` that holds a call, with what follows the call. */
export interface JsCreation {
  call: JsCall;
  /** Variable the app is assigned to. */
  name: string;
  /** Offset where the declaration starts (its `export`, `const`, `let` or `var`). */
  start: number;
  /** Zero-based lines of the statement. */
  firstLine: number;
  lastLine: number;
  /** Methods called on the result in the same statement (`new Hono().basePath(…)`). */
  chain: { name: string; start: number; end: number }[];
  semicolon: boolean;
  /** The declaration's indentation. */
  indent: string;
  /** True when the statement is inside a class body. */
  inClass: boolean;
  /** Text after the statement on its last line is not blank (another statement follows). */
  crowded: boolean;
}

const DECLARATION =
  /(?:^|[\n;{}])[ \t]*((?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*(?:await\s+)?)$/;
const CHAIN = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^()]*?>)?\s*\(/;

/** True when `offset` is inside a class body. */
function insideClass(code: string, offset: number): boolean {
  let depth = 0;
  for (let k = offset - 1; k >= 0; k--) {
    const char = code[k];
    if (char === "}") depth++;
    else if (char === "{") {
      if (depth === 0) {
        const head = code.slice(0, k);
        const cut = Math.max(head.lastIndexOf(";"), head.lastIndexOf("{"), head.lastIndexOf("}"));
        if (/\bclass\b/.test(head.slice(cut + 1))) return true;
      } else depth--;
    }
  }
  return false;
}

/** The declaration holding `call`, or undefined when the call is not assigned to a variable. */
export function creationOf(src: JsSource, call: JsCall): JsCreation | undefined {
  const { code } = src;
  const window = code.slice(Math.max(0, call.start - 400), call.start);
  const declaration = DECLARATION.exec(window);
  if (declaration?.[1] === undefined || declaration[2] === undefined) return undefined;
  const start = call.start - declaration[1].length;
  const chain: JsCreation["chain"] = [];
  let end = call.close;
  for (;;) {
    const link = CHAIN.exec(code.slice(end));
    if (link?.[1] === undefined) break;
    const open = end + link[0].length - 1;
    const close = closingBracket(code, open);
    if (close === undefined) break;
    chain.push({ name: link[1], start: end, end: close });
    end = close;
  }
  const semi = /^[ \t]*;/.exec(code.slice(end));
  const statementEnd = semi === null ? end : end + semi[0].length;
  const starts = lineStarts(src.text);
  const firstLine = lineAt(starts, start);
  const lastLine = lineAt(starts, Math.max(statementEnd - 1, start));
  const lineEnd = code.indexOf("\n", statementEnd);
  const rest = code.slice(statementEnd, lineEnd === -1 ? code.length : lineEnd);
  return {
    call,
    name: declaration[2],
    start,
    firstLine,
    lastLine,
    chain,
    semicolon: semi !== null,
    indent: indentOf(src.text.slice(starts[firstLine])),
    inClass: insideClass(code, start),
    crowded: rest.trim() !== "",
  };
}

/** How the file writes code: quotes, semicolons, indentation and line endings. */
export interface JsStyle {
  quote: string;
  semi: string;
  unit: string;
  eol: string;
}

/** The style of a file: `quote` from its imports (else its strings), semicolons as given. */
export function jsStyle(src: JsSource, semicolon: boolean, preferredQuote?: string): JsStyle {
  let quote = preferredQuote;
  if (quote === undefined) {
    let double = 0;
    let single = 0;
    for (const literal of src.strings) {
      if (literal.quote === '"') double++;
      else if (literal.quote === "'") single++;
    }
    quote = single > double ? "'" : '"';
  }
  return {
    quote,
    semi: semicolon ? ";" : "",
    unit: indentUnit(splitLines(src.text), "  "),
    eol: eolOf(src.text),
  };
}

/** Whether most statement lines of a file end with a semicolon. */
export function usesSemicolons(src: JsSource): boolean {
  let withSemi = 0;
  let without = 0;
  for (const line of splitLines(src.code)) {
    const text = line.trimEnd();
    if (text === "" || /[{(,[]$/.test(text) || /^\s*[}\])]/.test(text)) continue;
    if (text.endsWith(";")) withSemi++;
    else if (/[\w)"'`\]]$/.test(text)) without++;
  }
  return withSemi >= without;
}

/** Quoted path literals in a file, each with the code just before it on its line. */
export function pathLiterals(
  src: JsSource,
  paths: readonly string[],
): { offset: number; before: string; after: string }[] {
  const found: { offset: number; before: string; after: string }[] = [];
  for (const literal of src.strings) {
    if (literal.end - literal.start < 2) continue;
    if (!paths.includes(src.text.slice(literal.start + 1, literal.end - 1))) continue;
    const lineStart = src.code.lastIndexOf("\n", literal.start) + 1;
    found.push({
      offset: literal.start,
      before: src.code.slice(Math.max(lineStart, literal.start - 200), literal.start),
      after: src.code.slice(literal.end, literal.end + 60),
    });
  }
  return found;
}
