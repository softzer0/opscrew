import * as nodeModule from "node:module";
import type { ProjectFacts } from "@opscrew/plan-schema";
import type { PlaybookId } from "../../playbooks";
import { scanPy } from "../py";
import type { HealthEdit, HealthRepo, HealthRouteInput } from "../types";

/** A repository held in memory: repo-relative path → text. */
export function memoryRepo(files: Record<string, string>): HealthRepo {
  const paths = Object.keys(files).sort();
  return {
    files: async () => paths,
    read: async (path) => files[path],
    exists: async (path) => paths.some((file) => file === path || file.startsWith(`${path}/`)),
    folders: async (path) => {
      const names = new Set<string>();
      for (const file of paths) {
        if (!file.startsWith(`${path}/`)) continue;
        const rest = file.slice(path.length + 1).split("/");
        if (rest.length > 1) names.add(rest[0] as string);
      }
      return [...names];
    },
  };
}

/** Facts for a small app; `frameworks` are names at the app folder. */
export function appFacts(options: {
  languages: ProjectFacts["languages"];
  frameworks?: string[];
  appKind?: ProjectFacts["appKind"];
  appDir?: string;
}): ProjectFacts {
  const dir = options.appDir ?? ".";
  return {
    name: "app",
    languages: options.languages,
    packageManager: options.languages.includes("python") ? "pip" : "npm",
    frameworks: (options.frameworks ?? []).map((name) => ({ name, path: dir })),
    appKind: options.appKind ?? "api",
    platformExport: { platform: "none", evidence: [] },
    build: {},
    runtimeVersions: {},
    envVars: [],
    services: [],
    docker: {},
    monorepo: dir !== ".",
    appDir: dir,
    git: {},
  };
}

/** The input for `healthRouteEdit` over an in-memory repository. */
export function healthInput(
  stack: PlaybookId,
  facts: ProjectFacts,
  files: Record<string, string>,
  healthPath = "/health",
): HealthRouteInput {
  return { facts, stack, path: ".", healthPath, repo: memoryRepo(files) };
}

/** The content written to `path` by a write edit (fails the test when there is none). */
export function written(edit: HealthEdit, path: string): string {
  if (edit.action !== "write") {
    throw new Error(`expected a write, got ${JSON.stringify(edit)}`);
  }
  const file = edit.files.find((f) => f.path === path);
  if (file === undefined) {
    throw new Error(`${path} was not written; got ${edit.files.map((f) => f.path).join(", ")}`);
  }
  return file.content;
}

const strip = (
  nodeModule as {
    stripTypeScriptTypes?: (code: string, options?: { mode?: "strip" | "transform" }) => string;
  }
).stripTypeScriptTypes;

/** Why `stripTypeScriptTypes` is unavailable (tests skip the parse check then), if it is. */
export const NO_TS_PARSER =
  strip === undefined
    ? "node:module stripTypeScriptTypes is not available in this Node.js version"
    : undefined;
if (NO_TS_PARSER !== undefined) console.warn(`Skipping TypeScript parse checks: ${NO_TS_PARSER}.`);

/**
 * The syntax error in a JavaScript or TypeScript file, or undefined when it parses (or when no
 * parser is available). Uses Node.js's own TypeScript parser (`stripTypeScriptTypes`).
 */
export function syntaxError(code: string): string | undefined {
  if (strip === undefined) return undefined;
  const emit = process.emitWarning;
  // stripTypeScriptTypes is experimental and warns on first use; that warning is noise here.
  process.emitWarning = () => {};
  try {
    strip(code, { mode: "transform" });
    return undefined;
  } catch (error) {
    return (error as Error).message;
  } finally {
    process.emitWarning = emit;
  }
}

/**
 * What is wrong with a Python file's indentation, or undefined when it is consistent: one kind of
 * indentation character, a deeper block only after a line ending in `:`, every header followed by
 * a deeper block, and every dedent back to an earlier level (Python's own INDENT/DEDENT rules).
 */
export function indentationError(text: string): string | undefined {
  const src = scanPy(text);
  const stack = [0];
  let header = false;
  let kind: string | undefined;
  for (const statement of src.statements) {
    const width = statement.indent.length;
    const chars = new Set(statement.indent);
    if (chars.size > 1) return `line ${statement.first + 1} mixes tabs and spaces`;
    const char = [...chars][0];
    if (char !== undefined) {
      if (kind !== undefined && kind !== char) return `line ${statement.first + 1} changes the indentation character`;
      kind = char;
    }
    const top = stack.at(-1) as number;
    if (header) {
      if (width <= top) return `line ${statement.first + 1} should start an indented block`;
      stack.push(width);
    } else if (width > top) {
      return `line ${statement.first + 1} is indented without a block header`;
    } else {
      while ((stack.at(-1) as number) > width) stack.pop();
      if (stack.at(-1) !== width) return `line ${statement.first + 1} dedents to an unknown level`;
    }
    const code = statement.code.trimEnd();
    header = code.endsWith(":") && !/^\s*@/.test(code);
  }
  return header ? "the file ends with a block header" : undefined;
}
