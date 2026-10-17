/**
 * Shared view of an app for the release-command detectors: its files (relative to the app folder),
 * a reader, its dependencies and helpers that build commands run from the repository root.
 */
import { type Dependency, findDependency, parseJson, type ReadText, type Unit } from "../manifests";
import { basenameRel, depthOf, dirnameRel, isWithin, joinRel, relativeTo } from "../paths";

/** Why no release command was recorded, for `design` to explain. */
export interface ReleaseNote {
  /** Plain-English explanation and what to do next. */
  text: string;
  /** True when the app runs its migrations itself when it starts (nothing is wrong). */
  atStartup: boolean;
}

/** What a detector found: a command, or a note saying why there is none. */
export interface ReleaseDetection {
  /** The command, run from the repository root like the start command. */
  command?: string;
  /** Why the app's migrations get no command (they run at startup, or the image lacks the tool). */
  note?: ReleaseNote;
}

/** A note for migrations the app runs itself when it starts (`what` says how). */
export function atStartup(what: string): ReleaseDetection {
  return {
    note: {
      atStartup: true,
      text: `${what}, so OpsCrew plans no separate release command for its database migrations. To run them before each new version starts instead, set \`app.releaseCommand\` in opscrew/plan.yaml.`,
    },
  };
}

/** How a note about migrations deploys cannot run ends, after the fix it names. */
export const ANALYZE_AGAIN =
  "run `opscrew analyze` again, or set `app.releaseCommand` in opscrew/plan.yaml.";

/** A note for migrations OpsCrew found but cannot run as planned (`text` says what to do). */
export function leftOut(text: string): ReleaseDetection {
  return { note: { atStartup: false, text } };
}

/** `cd <dir> && <command>`, or the command alone at the repository root. */
export function inFolder(dir: string, command: string): string {
  return dir === "." ? command : `cd ${dir} && ${command}`;
}

/** Sorts paths shallowest first, ties broken by path. */
export function byDepth(a: string, b: string): number {
  return depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** The shallowest file of `files` named `name`, ties broken by path. */
export function shallowest(files: readonly string[], name: string): string | undefined {
  return files.filter((file) => basenameRel(file) === name).sort(byDepth)[0];
}

/** Removes `//` and `/* *\/` comments and trailing commas from JSON-with-comments text. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parses JSON-with-comments (tsconfig.json); `undefined` when invalid. */
export function parseJsonc(text: string | undefined): unknown {
  return text === undefined ? undefined : parseJson(stripJsonComments(text));
}

/** Normalises a relative path written in a config (`./src/` → `src`, `.` stays `.`). */
export function cleanPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.length === 0 ? "." : parts.join("/");
}

/** Builds the detectors' view of an app. */
export class ReleaseContext {
  /** Repo-relative files inside the app folder. */
  readonly appFiles: string[];
  /** The same files relative to the app folder. */
  readonly rel: string[];

  constructor(
    readonly appDir: string,
    /** Repo-relative files detection may look at. */
    readonly files: readonly string[],
    readonly unit: Unit | undefined,
    private readonly readRepo: ReadText,
    /** The detected start command (repository-root form). */
    readonly startCommand: string | undefined,
  ) {
    this.appFiles = files.filter((file) => isWithin(appDir, file));
    this.rel = this.appFiles.map((file) => relativeTo(appDir, file));
  }

  /** True when a file relative to the app folder matches. */
  has(pattern: RegExp): boolean {
    return this.rel.some((file) => pattern.test(file));
  }

  /** App-relative files that match, shallowest first. */
  matching(pattern: RegExp): string[] {
    return this.rel.filter((file) => pattern.test(file)).sort(byDepth);
  }

  /** True when the app has this app-relative file. */
  exists(path: string): boolean {
    return this.rel.includes(path);
  }

  /** Reads an app-relative file. */
  read(path: string): Promise<string | undefined> {
    return this.readRepo(joinRel(this.appDir, path));
  }

  /** Reads up to `limit` app-relative files and returns the first whose text matches. */
  async firstMatching(
    files: readonly string[],
    pattern: RegExp,
    limit = 400,
  ): Promise<string | undefined> {
    for (const file of files.slice(0, limit)) {
      if (pattern.test((await this.read(file)) ?? "")) return file;
    }
    return undefined;
  }

  /** `cd <app-relative dir> && <command>` from the repository root. */
  at(dir: string, command: string): string {
    return inFolder(dir === "." ? this.appDir : joinRel(this.appDir, dir), command);
  }

  /** A declared dependency of the app. */
  dependency(ecosystem: Dependency["ecosystem"], name: string): Dependency | undefined {
    return this.unit === undefined ? undefined : findDependency(this.unit, ecosystem, name);
  }

  /** An npm dependency of the app (development dependencies count). */
  npm(name: string): boolean {
    return this.dependency("npm", name) !== undefined;
  }

  /** The app's package.json scripts. */
  get scripts(): Record<string, string> {
    return this.unit?.packageJson?.scripts ?? {};
  }

  /** Folder of an app-relative file. */
  dirOf(path: string): string {
    return dirnameRel(path);
  }
}
