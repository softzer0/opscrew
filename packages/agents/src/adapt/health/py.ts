/**
 * A light Python reader for the health-route edits: blanks strings and comments (keeping offsets),
 * groups physical lines into statements, reads imports and finds calls that create an app object.
 */
import {
  closingBracket,
  eolOf,
  type Insertion,
  indentOf,
  indentUnit,
  isBlank,
  lineStarts,
  splitLines,
} from "./text";

export { applyInsertions, type Insertion } from "./text";

/** One logical statement (its physical lines, continuation lines included). */
export interface PyStatement {
  index: number;
  first: number;
  last: number;
  indent: string;
  /** Offset of the statement's first character. */
  start: number;
  /** Code text of the statement's lines (joined with `\n`). */
  code: string;
}

/** A scanned Python file. */
export interface PySource {
  text: string;
  code: string;
  lines: string[];
  starts: number[];
  statements: PyStatement[];
  /** The quote most string literals use. */
  quote: string;
  /** One indentation step. */
  unit: string;
  eol: string;
}

/** Scans a Python file. */
export function scanPy(text: string): PySource {
  const out = text.split("");
  const n = text.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
  };
  /** Per line: whether it starts inside a statement (brackets, strings, backslash). */
  const inside: boolean[] = [false];
  let depth = 0;
  let double = 0;
  let single = 0;
  let i = 0;
  while (i < n) {
    const char = text[i] as string;
    if (char === "#") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      if (char === '"') double++;
      else single++;
      const triple = text.startsWith(char.repeat(3), i);
      const open = triple ? 3 : 1;
      let k = i + open;
      while (k < n) {
        const c = text[k];
        if (c === "\\") {
          // An escaped line ending continues the string on the next line.
          if (text[k + 1] === "\n") inside.push(true);
          k += 2;
          continue;
        }
        if (triple && text.startsWith(char.repeat(3), k)) break;
        if (!triple && (c === char || c === "\n")) break;
        if (c === "\n") inside.push(true);
        k++;
      }
      blank(i + open, Math.min(k, n));
      i = !triple && text[k] === "\n" ? k : Math.min(k + open, n);
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1);
    else if (char === "\n") {
      const previous = text[i - 1] === "\r" ? text[i - 2] : text[i - 1];
      inside.push(depth > 0 || previous === "\\");
    }
    i++;
  }
  const code = out.join("");
  const lines = splitLines(text);
  const codeLines = splitLines(code);
  const starts = lineStarts(text);
  const statements: PyStatement[] = [];
  for (let line = 0; line < codeLines.length; line++) {
    if (inside[line] === true || isBlank(codeLines[line])) continue;
    let last = line;
    while (inside[last + 1] === true) last++;
    const indent = indentOf(codeLines[line] as string);
    statements.push({
      index: statements.length,
      first: line,
      last,
      indent,
      start: (starts[line] as number) + indent.length,
      code: codeLines.slice(line, last + 1).join("\n"),
    });
    line = last;
  }
  return {
    text,
    code,
    lines,
    starts,
    statements,
    quote: single > double ? "'" : '"',
    unit: indentUnit(
      statements.map((s) => lines[s.first] as string),
      "    ",
    ),
    eol: eolOf(text),
  };
}

/** The statement that holds an offset. */
export function statementAt(src: PySource, offset: number): PyStatement | undefined {
  let found: PyStatement | undefined;
  for (const statement of src.statements) {
    if (statement.start > offset) break;
    found = statement;
  }
  if (found === undefined) return undefined;
  const end = src.starts[found.last + 1] ?? src.text.length;
  return offset < end ? found : undefined;
}

/** The headers (`def`, `class`, `if` …) a statement is nested in, innermost first. */
export function enclosing(src: PySource, statement: PyStatement): PyStatement[] {
  const headers: PyStatement[] = [];
  let indent = statement.indent.length;
  for (let k = statement.index - 1; k >= 0 && indent > 0; k--) {
    const candidate = src.statements[k] as PyStatement;
    if (candidate.indent.length < indent) {
      headers.push(candidate);
      indent = candidate.indent.length;
    }
  }
  return headers;
}

/** An import statement and the names it binds (local name → dotted target). */
export interface PyImport {
  statement: PyStatement;
  bindings: Map<string, string>;
}

/** Every absolute import of a file. */
export function pyImports(src: PySource): PyImport[] {
  const imports: PyImport[] = [];
  for (const statement of src.statements) {
    const code = statement.code.replace(/[\\()\n]/g, " ").trim();
    const bindings = new Map<string, string>();
    const plain = /^import\s+(.+)$/.exec(code);
    const from = /^from\s+([A-Za-z_][\w.]*)\s+import\s+(.+)$/.exec(code);
    if (plain?.[1] !== undefined) {
      for (const item of plain[1].split(",")) {
        const parts = item.trim().split(/\s+/);
        const target = parts[0];
        if (target === undefined || target === "") continue;
        if (parts[1] === "as" && parts[2]) bindings.set(parts[2], target);
        else bindings.set(target.split(".")[0] as string, target.split(".")[0] as string);
      }
    } else if (from?.[1] !== undefined && from[2] !== undefined) {
      for (const item of from[2].split(",")) {
        const parts = item.trim().split(/\s+/);
        const name = parts[0];
        if (name === undefined || name === "" || name === "*") continue;
        bindings.set(parts[1] === "as" && parts[2] ? parts[2] : name, `${from[1]}.${name}`);
      }
    } else continue;
    imports.push({ statement, bindings });
  }
  return imports;
}

/** What a dotted name refers to through the file's imports (`web.Application` → `aiohttp.web.Application`). */
function pyResolve(imports: readonly PyImport[], dotted: string): string | undefined {
  const [head, ...rest] = dotted.split(".");
  if (head === undefined) return undefined;
  for (const entry of imports) {
    const target = entry.bindings.get(head);
    if (target !== undefined) return [target, ...rest].join(".");
  }
  return undefined;
}

/** How the file can refer to a dotted target through its imports, if it can. */
export function pyReference(imports: readonly PyImport[], target: string): string | undefined {
  let best: string | undefined;
  for (const entry of imports) {
    for (const [local, bound] of entry.bindings) {
      let reference: string | undefined;
      if (bound === target) reference = local;
      else if (target.startsWith(`${bound}.`)) reference = `${local}${target.slice(bound.length)}`;
      if (reference !== undefined && (best === undefined || reference.length < best.length)) {
        best = reference;
      }
    }
  }
  return best;
}

/** True when the file binds `name` at any level (def, class, assignment, import, loop). */
export function pyBinds(src: PySource, name: string): boolean {
  const n = name.replace(/[^\w]/g, "");
  return new RegExp(
    `^[ \\t]*(?:(?:async[ \\t]+)?def[ \\t]+${n}\\b|class[ \\t]+${n}\\b|${n}[ \\t]*(?::[^=\\n]*)?=(?!=)|for[ \\t]+${n}\\b)|\\bimport\\b[^\\n]*\\b${n}\\b|\\bas[ \\t]+${n}\\b`,
    "m",
  ).test(src.code);
}

/** A call of one of the targets. */
export interface PyCall {
  target: string;
  /** Offset of the callee. */
  start: number;
  open: number;
  close: number;
  statement: PyStatement;
  /** The variable the call is assigned to (`app = Flask(…)`, `with Configurator() as config:`). */
  name?: string;
  form: "assign" | "with" | "other";
}

const PY_CALL = /(?<![\w.])([A-Za-z_]\w*(?:[ \t]*\.[ \t]*[A-Za-z_]\w*)*)[ \t]*\(/g;

/** Every call of one of `targets` in the file. */
export function pyCalls(
  src: PySource,
  imports: readonly PyImport[],
  targets: ReadonlySet<string>,
): PyCall[] {
  const calls: PyCall[] = [];
  for (const match of src.code.matchAll(PY_CALL)) {
    const callee = (match[1] ?? "").replace(/\s+/g, "");
    const target = pyResolve(imports, callee);
    if (target === undefined || !targets.has(target)) continue;
    const open = match.index + match[0].length - 1;
    const close = closingBracket(src.code, open);
    const statement = statementAt(src, match.index);
    if (close === undefined || statement === undefined) continue;
    const before = src.code.slice(statement.start, match.index);
    const assigned = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=[ \t]*$/.exec(before);
    const withItem = /^(?:async\s+)?with\s+$/.exec(before);
    let name: string | undefined;
    let form: PyCall["form"] = "other";
    if (assigned?.[1] !== undefined) {
      name = assigned[1];
      form = "assign";
    } else if (withItem !== null) {
      const alias = /^\s*as\s+([A-Za-z_]\w*)\s*:\s*$/.exec(
        src.code.slice(close, statementEnd(src, statement)),
      );
      if (alias?.[1] !== undefined) {
        name = alias[1];
        form = "with";
      }
    }
    calls.push({
      target,
      start: match.index,
      open,
      close,
      statement,
      ...(name === undefined ? {} : { name }),
      form,
    });
  }
  return calls;
}

/** Offset just after a statement's last line (before its line ending). */
export function statementEnd(src: PySource, statement: PyStatement): number {
  const next = src.starts[statement.last + 1];
  if (next === undefined) return src.text.length;
  return src.text[next - 2] === "\r" ? next - 2 : next - 1;
}

/** Lines inserted after line `line` (zero-based), as an insertion. */
export function linesAfter(src: PySource, line: number, block: readonly string[]): Insertion {
  const next = src.starts[line + 1];
  if (next === undefined) {
    return { offset: src.text.length, text: block.map((l) => `${src.eol}${l}`).join("") };
  }
  return { offset: next, text: block.map((l) => `${l}${src.eol}`).join("") };
}

/** Lines inserted before line `line`, as an insertion. */
function linesBefore(src: PySource, line: number, block: readonly string[]): Insertion {
  return {
    offset: src.starts[line] ?? src.text.length,
    text: block.map((l) => `${l}${src.eol}`).join(""),
  };
}

/** Blank lines PEP 8 puts around a definition at this indentation. */
export function gapFor(indent: string): number {
  return indent === "" ? 2 : 1;
}

/**
 * The block after statement `statement`, separated from its neighbours by blank lines (two at
 * module level, one inside a function).
 */
export function blockAfter(
  src: PySource,
  statement: PyStatement,
  block: readonly string[],
): Insertion {
  const gap = gapFor(statement.indent);
  const next = statement.last + 1;
  const atEnd = src.lines.slice(next).every((line) => isBlank(line));
  // Blank lines already below the statement count towards the gap after the block.
  let blanks = 0;
  while (next + blanks < src.lines.length && isBlank(src.lines[next + blanks])) blanks++;
  const after = atEnd ? [] : Array<string>(Math.max(0, gap - blanks)).fill("");
  return linesAfter(src, statement.last, [...Array<string>(gap).fill(""), ...block, ...after]);
}

/**
 * The block before statement `statement` (and the decorators and comments directly above it),
 * followed by blank lines; blank lines are added above it only when the line before is not blank.
 */
export function blockBefore(
  src: PySource,
  statement: PyStatement,
  block: readonly string[],
): Insertion {
  const gap = gapFor(statement.indent);
  const codeLines = splitLines(src.code);
  let target = statement;
  for (;;) {
    const previous = src.statements[target.index - 1];
    if (
      previous === undefined ||
      previous.indent !== target.indent ||
      !previous.code.trim().startsWith("@") ||
      previous.last + 1 !== target.first
    ) {
      break;
    }
    target = previous;
  }
  let line = target.first;
  while (line > 0 && isBlank(codeLines[line - 1]) && !isBlank(src.lines[line - 1])) line--;
  // Blank lines already above count towards the gap (none is needed at the top of the file).
  let blanks = 0;
  while (line - blanks > 0 && isBlank(src.lines[line - blanks - 1])) blanks++;
  const top = line - blanks === 0;
  const above = top ? [] : Array<string>(Math.max(0, gap - blanks)).fill("");
  return linesBefore(src, line, [...above, ...block, ...Array<string>(gap).fill("")]);
}

/**
 * How to refer to `module.name` in the file: through an existing import, or with a new
 * `from module import name` (aliased when the name is taken) after `anchor` or the file's imports.
 */
export function pyImportName(
  src: PySource,
  imports: readonly PyImport[],
  module: string,
  name: string,
  alias: string,
  anchor?: PyStatement,
): { local: string; insertion?: Insertion } {
  const existing = pyReference(imports, `${module}.${name}`);
  if (existing !== undefined) return { local: existing };
  const local = pyBinds(src, name) ? alias : name;
  const line = `from ${module} import ${name}${local === name ? "" : ` as ${local}`}`;
  const topLevel = imports.filter((entry) => entry.statement.indent === "");
  // Next to the framework's import, else the last import of the same package, else the last one.
  const root = module.split(".")[0] as string;
  const samePackage = topLevel.filter((entry) =>
    [...entry.bindings.values()].some((target) => target.split(".")[0] === root),
  );
  const after =
    anchor?.indent === "" ? anchor : (samePackage.at(-1)?.statement ?? topLevel.at(-1)?.statement);
  if (after !== undefined) return { local, insertion: linesAfter(src, after.last, [line]) };
  // No import yet: after the module docstring, when there is one.
  const first = src.statements[0];
  const docstring = first !== undefined && /^[rRuU]?("""|''')/.test(first.code.trim());
  if (first !== undefined && docstring) {
    return { local, insertion: linesAfter(src, first.last, ["", line]) };
  }
  return { local, insertion: linesBefore(src, 0, [line, ""]) };
}
