/**
 * Deterministic `output: "standalone"` edit of a Next.js config (plan.md "Next.js without a
 * model"). A careful text transform, not a parser: it edits only the plain object literal shapes
 * `create-next-app` writes and returns `manual` whenever anything is unusual, so the change falls
 * back to the Code-change agent or to the user.
 */
import { join, posix } from "node:path";
import { exists, readTextIfExists } from "@opscrew/core";
import { NEXT_CONFIG_NAMES } from "../design/code-changes";

/** True for a Next.js config file (`next.config.{js,mjs,ts,cjs}`) in any folder. */
export function isNextConfigPath(path: string): boolean {
  return NEXT_CONFIG_NAMES.includes(posix.basename(path));
}

/**
 * The deterministic standalone edit for the Next.js config at `path` (repo-relative) under `root`.
 * A config in a subfolder also gets `outputFileTracingRoot` pointing back at the project root.
 * OpsCrew edits (or creates) the config only when no other `next.config.*` sits next to it:
 * Next.js reads just one of them, so editing the planned one could change nothing.
 */
export async function nextConfigEdit(root: string, path: string): Promise<StandaloneEdit> {
  const folders = posix
    .dirname(posix.normalize(path.replace(/\\/g, "/")))
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  const dir = folders.join("/");
  const planned = dir === "" ? posix.basename(path) : `${dir}/${posix.basename(path)}`;
  const content = await readTextIfExists(join(root, path));
  const others: string[] = [];
  for (const name of NEXT_CONFIG_NAMES) {
    const other = dir === "" ? name : `${dir}/${name}`;
    if (other !== planned && (await exists(join(root, other)))) others.push(other);
  }
  if (others.length > 0) {
    return manual(
      content === undefined
        ? `the plan expects ${path} but the app has ${others.join(" and ")}; run \`opscrew design\` again.`
        : `the app has ${[planned, ...others].join(" and ")}, and Next.js reads only one of them; delete the ones you do not use, then run \`opscrew design\` again.`,
    );
  }
  const tracingRoot = folders.length === 0 ? undefined : "../".repeat(folders.length);
  return standaloneConfigEdit({
    path,
    content,
    ...(tracingRoot === undefined ? {} : { tracingRoot }),
  });
}

export interface StandaloneEditInput {
  /** File name or repo-relative path of the config; its extension decides ESM, CommonJS or TS. */
  path: string;
  /** Current content, or undefined when the file does not exist (only `.mjs` is created). */
  content: string | undefined;
  /**
   * For an app in a monorepo folder: the relative path from the config's folder to the repository
   * root (for example `../../`), set as `outputFileTracingRoot`. Undefined at the root.
   */
  tracingRoot?: string;
}

/** What to do with the config: write it, nothing (already set), or leave it to the agent/user. */
export type StandaloneEdit =
  | { action: "write"; content: string; created: boolean; note: string }
  | { action: "none"; reason: string }
  | { action: "manual"; reason: string };

type Module = "esm" | "cjs";

const IDENT = /[A-Za-z_$]/;
const IDENT_PART = /[\w$]/;

const manual = (reason: string): StandaloneEdit => ({ action: "manual", reason });

/**
 * The edit that makes `next build` write standalone output: adds `output: "standalone"` (and
 * `outputFileTracingRoot` for a monorepo app) as the first properties of the exported object,
 * keeping the rest of the file as it is, or creates `next.config.mjs` when there is no config.
 */
export function standaloneConfigEdit(input: StandaloneEditInput): StandaloneEdit {
  const name = input.path.split("/").at(-1) ?? input.path;
  const ext = name.match(/\.(js|mjs|ts|cjs)$/)?.[1];
  if (ext === undefined) return manual(`${name} is not a Next.js config file OpsCrew can edit.`);
  if (input.content === undefined) {
    if (ext !== "mjs") {
      return manual(`${name} does not exist and OpsCrew only creates next.config.mjs.`);
    }
    return {
      action: "write",
      created: true,
      content: newConfig(input.tracingRoot),
      note: notes(name, true, input.tracingRoot !== undefined),
    };
  }

  const source = input.content;
  if (/\r(?!\n)/.test(source)) return manual(`${name} has unusual line endings.`);
  const crlf = source.includes("\r\n");
  const text = crlf ? source.replace(/\r\n/g, "\n") : source;

  const found = findExportedObject(text, ext);
  if (typeof found === "string") return manual(`${name} ${found}`);
  const scan = scanObject(text, found.open);
  if (typeof scan === "string") return manual(`${name} ${scan}`);
  const tail = text.slice(scan.close + 1).split("\n", 1)[0] ?? "";
  const tailPattern =
    ext === "ts" ? /^\s*(?:satisfies\s+NextConfig\s*)?;?\s*(?:\/\/.*)?$/ : /^\s*;?\s*(?:\/\/.*)?$/;
  if (!tailPattern.test(tail)) {
    return manual(`${name} has more code after the config object than OpsCrew expects.`);
  }
  if (found.exportAt !== undefined && found.exportAt < scan.close) {
    return manual(`${name} exports the config before it is complete.`);
  }

  const additions: string[] = [];
  const quote = preferredQuote(text.slice(found.open, scan.close));
  const output = scan.keys.get("output");
  if (output === undefined) {
    additions.push(`output: ${quote}standalone${quote}`);
  } else {
    const value = text.slice(output).match(/^\s*:\s*(["'`])([^"'`\n]*)\1\s*(?=[,}\n/])/)?.[2];
    if (value === undefined) {
      return manual(
        `${name} sets output from an expression, so OpsCrew did not change it. Set output: "standalone" so the image ships only the standalone server.`,
      );
    }
    if (value !== "standalone") {
      return manual(
        `${name} sets output to "${value}", which OpsCrew does not change automatically. Change it to "standalone" if the app should run as a server.`,
      );
    }
  }

  let imports = "";
  if (input.tracingRoot !== undefined && !scan.keys.has("outputFileTracingRoot")) {
    const root = JSON.stringify(input.tracingRoot);
    if (found.module === "cjs") {
      additions.push(`outputFileTracingRoot: require("node:path").join(__dirname, ${root})`);
    } else if (ext === "ts") {
      return manual(
        `${name} is TypeScript, so OpsCrew does not add outputFileTracingRoot (the repository root) to it automatically.`,
      );
    } else {
      const missing = esmImports(text);
      if (missing === undefined) {
        return manual(
          `${name} already uses the names path or fileURLToPath, so OpsCrew did not add outputFileTracingRoot (the repository root) itself.`,
        );
      }
      imports = missing;
      additions.push(
        `outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), ${root})`,
      );
    }
  }
  if (additions.length === 0) {
    return {
      action: "none",
      reason: `${name} already sets output: "standalone"${input.tracingRoot === undefined ? "" : " and outputFileTracingRoot"}.`,
    };
  }

  let edited = insertProperties(text, found.open, scan.close, additions);
  if (imports !== "") {
    const at = text.match(/^(?:\/\/[^\n]*\n)*/)?.[0].length ?? 0;
    const blank = /^import\s/.test(edited.slice(at)) ? "" : "\n";
    edited = `${edited.slice(0, at)}${imports}${blank}${edited.slice(at)}`;
  }
  return {
    action: "write",
    created: false,
    content: crlf ? edited.replace(/\n/g, "\r\n") : edited,
    note: notes(
      name,
      false,
      additions.some((line) => line.startsWith("outputFileTracingRoot")),
    ),
  };
}

/**
 * The config's `basePath`, read with the same careful scan as the standalone edit: `none` when the
 * exported object has no (or an empty) `basePath`, `literal` with its value when it is a plain
 * string, and `unknown` when the file mentions `basePath` but OpsCrew cannot read it with certainty.
 */
export type BasePathScan =
  | { kind: "none" }
  | { kind: "literal"; value: string }
  | { kind: "unknown" };

/** The `basePath` a Next.js config sets (see {@link BasePathScan}); `path` gives its extension. */
export function nextBasePath(path: string, content: string): BasePathScan {
  if (!/\bbasePath\b/.test(content)) return { kind: "none" };
  const ext = path.match(/\.(js|mjs|ts|cjs)$/)?.[1];
  if (ext === undefined || /\r(?!\n)/.test(content)) return { kind: "unknown" };
  const text = content.replace(/\r\n/g, "\n");
  const found = findExportedObject(text, ext);
  if (typeof found === "string") return { kind: "unknown" };
  const scan = scanObject(text, found.open);
  if (typeof scan === "string") return { kind: "unknown" };
  const key = scan.keys.get("basePath");
  if (key === undefined) return { kind: "none" };
  const value = text.slice(key).match(/^\s*:\s*(["'`])([^"'`\n\\]*)\1\s*(?=[,}\n/])/)?.[2];
  if (value === undefined) return { kind: "unknown" };
  return value === "" ? { kind: "none" } : { kind: "literal", value };
}

function notes(name: string, created: boolean, tracing: boolean): string {
  const what = tracing
    ? 'output: "standalone" and outputFileTracingRoot (the repository root)'
    : 'output: "standalone"';
  return created
    ? `OpsCrew created ${name} with ${what}, so the image ships only the standalone server.`
    : `OpsCrew set ${what} in ${name}, so the image ships only the standalone server; the other options are unchanged.`;
}

function newConfig(tracingRoot: string | undefined): string {
  const lines: string[] = [];
  if (tracingRoot !== undefined) {
    lines.push('import path from "node:path";', 'import { fileURLToPath } from "node:url";', "");
  }
  lines.push(
    "/** @type {import('next').NextConfig} */",
    "const nextConfig = {",
    '  output: "standalone",',
  );
  if (tracingRoot !== undefined) {
    lines.push(
      `  outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), ${JSON.stringify(tracingRoot)}),`,
    );
  }
  lines.push("};", "", "export default nextConfig;", "");
  return lines.join("\n");
}

/**
 * The import lines an ESM config still needs for `path` and `fileURLToPath`, or undefined when
 * either name is already used for something else.
 */
function esmImports(text: string): string | undefined {
  const pathImport = /^import\s+path\s+from\s+(["'])(?:node:)?path\1;?[ \t]*$/m;
  const urlImport = /^import\s*\{\s*fileURLToPath\s*\}\s*from\s+(["'])(?:node:)?url\1;?[ \t]*$/m;
  const rest = text.replace(pathImport, "").replace(urlImport, "");
  if (/\bpath\b/.test(rest) || /\bfileURLToPath\b/.test(rest)) return undefined;
  return [
    pathImport.test(text) ? "" : 'import path from "node:path";\n',
    urlImport.test(text) ? "" : 'import { fileURLToPath } from "node:url";\n',
  ].join("");
}

interface ExportedObject {
  /** Index of the object literal's `{`. */
  open: number;
  module: Module;
  /** Index of the separate export statement (variable shapes). */
  exportAt?: number;
}

const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

/** The single exported object literal, or the reason the file does not have one OpsCrew edits. */
function findExportedObject(text: string, ext: string): ExportedObject | string {
  const esm = count(text, /\bexport\s+default\b/g);
  const cjs = count(text, /\bmodule\.exports\b/g);
  if (esm + cjs !== 1 || /(?<![.\w$])exports\s*[.[]/.test(text)) {
    return "does not have exactly one `export default` or `module.exports`.";
  }
  const module: Module = esm === 1 ? "esm" : "cjs";
  if (
    (module === "esm" && ext === "cjs") ||
    (module === "cjs" && (ext === "mjs" || ext === "ts"))
  ) {
    return `uses ${module === "esm" ? "ES module" : "CommonJS"} syntax that does not match its file extension.`;
  }

  const direct =
    module === "esm"
      ? /^export\s+default\s*\{/m.exec(text)
      : /^module\.exports\s*=\s*\{/m.exec(text);
  if (direct !== null) return { open: direct.index + direct[0].length - 1, module };

  const exported =
    module === "esm"
      ? /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?[ \t]*$/m.exec(text)
      : /^module\.exports\s*=\s*([A-Za-z_$][\w$]*)\s*;?[ \t]*$/m.exec(text);
  const variable = exported?.[1];
  if (exported === null || variable === undefined) {
    return "does not export a plain object (for example it wraps the config in a function).";
  }
  const annotation = ext === "ts" ? String.raw`(?:\s*:\s*NextConfig)?` : "";
  const declaration = new RegExp(
    String.raw`^(?:const|let|var)\s+${variable.replace(/\$/g, "\\$")}${annotation}\s*=\s*\{`,
    "m",
  ).exec(text);
  if (declaration === null) {
    return `does not declare ${variable} as a plain object.`;
  }
  const uses = count(
    text,
    new RegExp(String.raw`(?<![\w$])${variable.replace(/\$/g, "\\$")}(?![\w$])`, "g"),
  );
  if (uses !== 2) {
    return `uses ${variable} outside its declaration and export, so OpsCrew cannot be sure what the final config is.`;
  }
  return {
    open: declaration.index + declaration[0].length - 1,
    module,
    exportAt: exported.index,
  };
}

interface ObjectScan {
  /** Index of the closing `}`. */
  close: number;
  /** Top-level keys, each with the index just after the key. */
  keys: Map<string, number>;
}

/** End index of the string starting at `start`, or -1 when it is unterminated or multi-line. */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (c === quote) return i;
    else if (c === "\n") return -1;
  }
  return -1;
}

/**
 * Walks the object literal starting at `open`, skipping strings and comments, and collects its
 * top-level keys. Returns the reason when it meets anything it cannot read with certainty.
 */
function scanObject(text: string, open: number): ObjectScan | string {
  const keys = new Map<string, number>();
  let depth = 0;
  let expectKey = false;
  let i = open;
  while (i < text.length) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return "has an unterminated comment.";
      i = end + 2;
      continue;
    }
    if (c === "/") return "uses a regular expression or a division in the config object.";
    if (c === '"' || c === "'") {
      const end = stringEnd(text, i);
      if (end < 0) return "has a string OpsCrew cannot read.";
      if (depth === 1 && expectKey) {
        keys.set(text.slice(i + 1, end), end + 1);
        expectKey = false;
      }
      i = end + 1;
      continue;
    }
    if (c === "`") {
      let end = i + 1;
      while (end < text.length && text[end] !== "`") {
        if (text[end] === "\\") end++;
        else if (text[end] === "$" && text[end + 1] === "{") {
          return "builds a value with a template literal.";
        }
        end++;
      }
      if (end >= text.length) return "has an unterminated template literal.";
      if (depth === 1 && expectKey) return "has a template literal key.";
      i = end + 1;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      if (depth === 1 && expectKey) return "has a computed key in the config object.";
      depth++;
      if (depth === 1) expectKey = true;
      i++;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth--;
      if (depth === 0) {
        return c === "}" ? { close: i, keys } : "has unbalanced brackets.";
      }
      if (depth < 0) return "has unbalanced brackets.";
      i++;
      continue;
    }
    if (depth === 1) {
      if (c === ",") {
        expectKey = true;
      } else if (expectKey && text.startsWith("...", i)) {
        return "spreads another object into the config.";
      } else if (expectKey && IDENT.test(c)) {
        let end = i;
        while (end < text.length && IDENT_PART.test(text[end] as string)) end++;
        let key = text.slice(i, end);
        if (key === "get" || key === "set" || key === "async") {
          let j = end;
          while (j < text.length && /\s/.test(text[j] as string)) j++;
          if (text[j] === "*") return "has a generator method in the config object.";
          if (IDENT.test(text[j] ?? "")) {
            end = j;
            while (end < text.length && IDENT_PART.test(text[end] as string)) end++;
            key = text.slice(j, end);
          }
        }
        keys.set(key, end);
        expectKey = false;
        i = end;
        continue;
      } else if (expectKey && !/\s/.test(c)) {
        return "has a config key OpsCrew cannot read.";
      }
    }
    i++;
  }
  return "has an object OpsCrew could not find the end of.";
}

/** Single quotes when every string in the object uses them, double quotes otherwise. */
function preferredQuote(body: string): string {
  return /'[^'\n]*'/.test(body) && !/"[^"\n]*"/.test(body) ? "'" : '"';
}

/** Leading whitespace of the line containing `index`. */
function lineIndent(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(start).match(/^[ \t]*/)?.[0] ?? "";
}

/** One indentation step used by the file (two spaces when it has no indented lines). */
function indentUnit(text: string): string {
  const indent = text.match(/^([ \t]+)\S/m)?.[1];
  if (indent === undefined) return "  ";
  return indent.startsWith("\t") ? "\t" : indent;
}

/** Inserts `additions` as the first properties of the object between `open` and `close`. */
function insertProperties(
  text: string,
  open: number,
  close: number,
  additions: readonly string[],
): string {
  const body = text.slice(open + 1, close);
  const base = lineIndent(text, open);
  if (body.trim() === "") {
    const indent = base + indentUnit(text);
    const props = additions.map((line) => `\n${indent}${line},`).join("");
    return `${text.slice(0, open + 1)}${props}\n${base}${text.slice(close)}`;
  }
  const lineEnd = text.indexOf("\n", open);
  const restOfLine = lineEnd < 0 || lineEnd > close ? undefined : text.slice(open + 1, lineEnd);
  if (restOfLine !== undefined && /^\s*(?:\/\/.*)?$/.test(restOfLine)) {
    // Multi-line object: new lines after the `{` line, indented like the first property.
    const firstLine = text
      .slice(lineEnd + 1, close)
      .split("\n")
      .find((line) => line.trim() !== "");
    const indent = firstLine?.match(/^[ \t]*/)?.[0] || base + indentUnit(text);
    const props = additions.map((line) => `\n${indent}${line},`).join("");
    return `${text.slice(0, lineEnd)}${props}${text.slice(lineEnd)}`;
  }
  // Properties on the `{` line: insert right after the `{` and its spacing.
  const spacing = body.match(/^[ \t]*/)?.[0] ?? "";
  const at = open + 1 + spacing.length;
  return `${text.slice(0, at)}${additions.join(", ")}, ${text.slice(at)}`;
}
