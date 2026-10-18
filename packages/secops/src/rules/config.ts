import type { Finding, ScanContext, Scanner } from "@opscrew/contracts";
import { maskSecret } from "@opscrew/core";
import { CLIENT_EXPOSED_PREFIXES, isClientExposed, isSecretLikely } from "@opscrew/detect";
import { createFinding, type FindingInput } from "../scan/finding";
import {
  basename,
  isEnvFile,
  isPlaceholderValue,
  lineLocator,
  MAX_LINE_LENGTH,
  mapConcurrent,
  readText,
  splitLines,
} from "../scan/text";

const SOURCE = "opscrew-config";
const READ_CONCURRENCY = 16;

type ConfigFindingInput = Omit<FindingInput, "category" | "source">;

function configFinding(input: ConfigFindingInput): Finding {
  return createFinding({ ...input, category: "config", source: SOURCE });
}

// ---------------------------------------------------------------------------------------------
// File classification

const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|py)$/i;
const CLIENT_NAME_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|html?|ya?ml|toml|json)$/i;
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
]);
const TEST_FILE =
  /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:^|\/)test_[^/]*\.py$|_test\.py$|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

/** `Dockerfile`, `Dockerfile.prod`, `api.Dockerfile`, `Containerfile`. */
function isDockerfile(file: string): boolean {
  const name = basename(file);
  return /^(?:dockerfile|containerfile)(?:\..+)?$/i.test(name) || /\.dockerfile$/i.test(name);
}

function isCommentLine(line: string): boolean {
  return /^\s*(?:#|\/\/|\/?\*)/.test(line);
}

// ---------------------------------------------------------------------------------------------
// Dockerfile

interface Instruction {
  keyword: string;
  args: string;
  /** 1-based line of the instruction keyword. */
  line: number;
}

/** Dockerfile instructions with `\` continuations joined and comments removed. */
function parseDockerfile(text: string): Instruction[] {
  const instructions: Instruction[] = [];
  let current: Instruction | undefined;
  for (const [index, raw] of splitLines(text).entries()) {
    const trimmed = raw.trim();
    let rest = trimmed;
    if (current === undefined) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z]+)(?:\s+(.*))?$/.exec(trimmed);
      if (!match) continue;
      current = { keyword: (match[1] ?? "").toUpperCase(), args: "", line: index + 1 };
      rest = match[2] ?? "";
    } else if (trimmed.startsWith("#")) {
      continue;
    }
    const continues = /\\\s*$/.test(rest);
    const part = continues ? rest.replace(/\\\s*$/, "") : rest;
    current.args = `${current.args} ${part.trim()}`.trim();
    if (!continues) {
      instructions.push(current);
      current = undefined;
    }
  }
  if (current) instructions.push(current);
  return instructions;
}

/** Splits instruction arguments on whitespace, honouring quotes and backslash escapes. */
function shellWords(args: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | undefined;
  let inWord = false;
  for (let i = 0; i < args.length; i++) {
    const char = args[i] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && i + 1 < args.length) word += args[++i];
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < args.length) {
      word += args[++i];
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

/** `[name, value]` pairs of an `ENV` or `ARG` instruction (`value` undefined for a bare `ARG`). */
function envPairs(keyword: string, args: string): Array<[string, string | undefined]> {
  const words = shellWords(args);
  const first = words[0];
  if (first === undefined) return [];
  if (keyword === "ENV" && !first.includes("=")) {
    // Legacy form: `ENV NAME value with spaces`.
    return [[first, words.slice(1).join(" ")]];
  }
  return words.map((word) => {
    const eq = word.indexOf("=");
    return eq === -1 ? [word, undefined] : [word.slice(0, eq), word.slice(eq + 1)];
  });
}

const NON_SECRET_SUFFIX =
  /_(?:FILE|PATH|DIR|NAME|ID|TYPE|MODE|ENABLED|TTL|EXPIRY|EXPIRES(?:_IN)?|LENGTH|HEADER|PREFIX|HOST|PORT|USER(?:NAME)?)$/i;

function isSecretName(name: string): boolean {
  return isSecretLikely(name) && !NON_SECRET_SUFFIX.test(name);
}

/** True when an `ENV`/`ARG` value is a literal that could be a real secret. */
function isLiteralSecretValue(value: string): boolean {
  if (value === "" || value.includes("$")) return false;
  if (isPlaceholderValue(value, 4)) return false;
  if (/^(?:true|false|yes|no|on|off|none|null|\d+)$/i.test(value)) return false;
  if (/^(?:\/|\.\/|~\/)/.test(value)) return false;
  // URLs are secrets only when they carry a password (`scheme://user:password@host`).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return /^[^/]+:\/\/[^/@\s]*:[^/@\s]+@/.test(value);
  return true;
}

interface Stage {
  /** Lower-case stage alias (`FROM … AS name`). */
  name?: string;
  image: string;
  /** Image of the first non-stage ancestor. */
  baseImage: string;
  line: number;
  user?: string;
  userLine?: number;
}

const ROOT_USERS = new Set(["root", "0"]);

/**
 * The Dockerfile findings of the `opscrew-config` scanner for `text` (the file at repo-relative
 * `file`): the image baseline (a non-root user, base images pinned by version and digest, no
 * literal secret in `ENV`/`ARG`), each finding with its fix in `remediation`.
 */
export function scanDockerfile(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const stages: Stage[] = [];
  for (const instruction of parseDockerfile(text)) {
    const { keyword, args, line } = instruction;
    if (keyword === "FROM") {
      const words = shellWords(args).filter((word) => !word.startsWith("--"));
      const image = words[0];
      if (image === undefined) continue;
      const alias = words[1]?.toLowerCase() === "as" ? words[2]?.toLowerCase() : undefined;
      const parent = stages.find((stage) => stage.name === image.toLowerCase());
      const stage: Stage = { image, baseImage: parent?.baseImage ?? image, line };
      if (alias) stage.name = alias;
      if (parent?.user !== undefined) stage.user = parent.user;
      stages.push(stage);
      if (!parent) {
        const problem = imageTagProblem(image);
        if (problem) {
          findings.push(
            configFinding({
              ruleId: "config/dockerfile-latest-tag",
              title:
                problem === "latest"
                  ? "Base image uses the latest tag"
                  : "Base image has no version tag",
              severity: "low",
              file,
              line,
              evidence: `FROM ${image}`,
              description: `"${image}" ${problem === "latest" ? "uses the moving latest tag" : "has no tag, so Docker pulls latest"}. Builds can silently change or break when a new version is published.`,
              remediation:
                'Pin the base image to a specific version (for example "node:22-alpine" or "python:3.12-slim"), ideally with its @sha256 digest.',
              rawMatch: `FROM ${image}`,
            }),
          );
        } else if (isTagOnly(image)) {
          findings.push(
            configFinding({
              ruleId: "config/dockerfile-unpinned-digest",
              title: "Base image is not pinned by digest",
              severity: "low",
              file,
              line,
              evidence: `FROM ${image}`,
              description: `"${image}" is pinned by its tag only. A tag can be moved to another image, so a later build can run code you never tested.`,
              remediation: `Add the image's digest to the FROM line ("FROM ${image}@sha256:<digest>"; \`docker buildx imagetools inspect ${image}\` shows it). Dependabot keeps digests current.`,
              rawMatch: `FROM ${image}`,
            }),
          );
        }
      }
      continue;
    }
    const stage = stages.at(-1);
    if (keyword === "USER" && stage) {
      const user = shellWords(args)[0]?.split(":")[0];
      if (user !== undefined) {
        stage.user = user;
        stage.userLine = line;
      }
      continue;
    }
    if (keyword === "ENV" || keyword === "ARG") {
      for (const [name, value] of envPairs(keyword, args)) {
        if (value === undefined || !isSecretName(name) || !isLiteralSecretValue(value)) continue;
        findings.push(
          configFinding({
            ruleId: "config/dockerfile-secret-env",
            title: `Secret baked into the image in ${keyword} ${name}`,
            severity: "high",
            file,
            line,
            evidence: `${keyword} ${name}=${maskSecret(value)}`,
            description: `"${name}" gets a literal value in the Dockerfile. ${keyword === "ENV" ? "ENV values are stored in the image" : "ARG defaults are recorded in the image history"}, so anyone who can pull the image can read it.`,
            remediation: `Remove the value from the Dockerfile and pass "${name}" at runtime (environment variables or Docker secrets). For build-time secrets use "RUN --mount=type=secret". Rotate the value if the image was ever pushed.`,
            rawMatch: `${name}=${value}`,
          }),
        );
      }
    }
  }

  const final = stages.at(-1);
  if (final && !/nonroot/i.test(final.baseImage) && final.baseImage.toLowerCase() !== "scratch") {
    const user = final.user;
    if (user === undefined || ROOT_USERS.has(user.toLowerCase())) {
      const line = user === undefined ? final.line : (final.userLine ?? final.line);
      findings.push(
        configFinding({
          ruleId: "config/dockerfile-root",
          title: "Container runs as root",
          severity: "medium",
          file,
          line,
          evidence: user === undefined ? `FROM ${final.image} (no USER)` : `USER ${user}`,
          description:
            "The final image stage has no non-root USER, so the app runs as root inside the container. A bug in the app then gives an attacker root in the container, which makes escaping it much easier.",
          remediation:
            'Create an unprivileged user and switch to it before CMD, for example "RUN adduser -D app" and "USER app" (official Node images already ship a "node" user).',
          rawMatch: `${final.image}|${user ?? ""}`,
        }),
      );
    }
  }
  return findings;
}

/** `latest`, `untagged` or `undefined` when the image is pinned (or cannot be judged). */
function imageTagProblem(image: string): "latest" | "untagged" | undefined {
  if (image.includes("$") || image.toLowerCase() === "scratch" || image.includes("@")) {
    return undefined;
  }
  const lastSegment = image.slice(image.lastIndexOf("/") + 1);
  const colon = lastSegment.indexOf(":");
  if (colon === -1) return "untagged";
  return lastSegment.slice(colon + 1).toLowerCase() === "latest" ? "latest" : undefined;
}

/**
 * Of the images {@link imageTagProblem} accepts, true for one pinned by its tag only: no digest,
 * and neither `scratch` nor a variable.
 */
function isTagOnly(image: string): boolean {
  return !image.includes("$") && !image.includes("@") && image.toLowerCase() !== "scratch";
}

// ---------------------------------------------------------------------------------------------
// Django / Flask debug mode

const DEV_SETTINGS = /(?:^|[._-])(?:dev|develop|development|local|test|tests|testing)(?:[._-]|$)/i;

function isDjangoSettings(file: string, text: string): boolean {
  if (!file.endsWith(".py") || TEST_FILE.test(file)) return false;
  const name = basename(file);
  if (DEV_SETTINGS.test(name.replace(/\.py$/, ""))) return false;
  return /settings/i.test(file) || text.includes("INSTALLED_APPS");
}

function scanDjango(file: string, text: string): Finding[] {
  if (!isDjangoSettings(file, text)) return [];
  const findings: Finding[] = [];
  const lineAt = lineLocator(text);
  for (const match of text.matchAll(/^DEBUG\s*(?::\s*bool\s*)?=\s*True\b/gm)) {
    findings.push(
      configFinding({
        ruleId: "config/django-debug",
        title: "Django DEBUG is on",
        severity: "high",
        file,
        line: lineAt(match.index),
        evidence: "DEBUG = True",
        description:
          "Django runs with DEBUG = True. Error pages then show source code, settings and request data to anyone who triggers an error.",
        remediation:
          'Read DEBUG from the environment and default to off, for example DEBUG = os.environ.get("DJANGO_DEBUG") == "1", and never set it in production.',
        rawMatch: match[0],
      }),
    );
  }
  return findings;
}

const FLASK_DEBUG = [
  /\.run\(([^()]|\([^()]*\))*?\bdebug\s*=\s*True\b/g,
  /\.debug\s*=\s*True\b/g,
  /\.config\[\s*["']DEBUG["']\s*\]\s*=\s*True\b/g,
  /\.config\.update\(([^()]|\([^()]*\))*?\bDEBUG\s*=\s*True\b/g,
];

function scanFlask(file: string, text: string): Finding[] {
  if (!file.endsWith(".py") || TEST_FILE.test(file)) return [];
  if (!/^[ \t]*(?:from\s+flask\s+import|import\s+flask)\b/m.test(text)) return [];
  const findings: Finding[] = [];
  const lines = splitLines(text);
  const lineAt = lineLocator(text);
  const seen = new Set<number>();
  for (const pattern of FLASK_DEBUG) {
    for (const match of text.matchAll(pattern)) {
      const line = lineAt(match.index + match[0].length - 1);
      if (seen.has(line) || isCommentLine(lines[line - 1] ?? "")) continue;
      seen.add(line);
      findings.push(
        configFinding({
          ruleId: "config/flask-debug",
          title: "Flask debug mode is on",
          severity: "high",
          file,
          line,
          evidence: "debug=True",
          description:
            "Flask runs in debug mode. The interactive debugger lets anyone who can reach an error page run arbitrary Python code on the server.",
          remediation:
            "Remove debug=True (or read it from an environment variable that is off by default) and serve the app with a production server such as gunicorn.",
          rawMatch: match[0],
        }),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// CORS wildcard with credentials

const CORS_WILDCARD = [
  /\borigins?\s*:\s*["'`]\*["'`]/g,
  /\borigins?\s*=\s*["']\*["']/g,
  /\ballow_origins\s*=\s*\[\s*["']\*["']\s*\]/g,
  /["']?Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*["']/gi,
  /^[ \t]*CORS_(?:ORIGIN_ALLOW_ALL|ALLOW_ALL_ORIGINS)\s*=\s*True\b/gm,
];
const CORS_CREDENTIALS =
  /\bcredentials\s*:\s*true\b|\b(?:allow|supports)_credentials\s*=\s*True\b|Access-Control-Allow-Credentials["']?\s*[,:]\s*["']?true|^[ \t]*CORS_ALLOW_CREDENTIALS\s*=\s*True\b/im;
/** Lines around a wildcard origin searched for a credentials flag (Django settings: whole file). */
const CORS_WINDOW = 15;

function scanCors(file: string, text: string): Finding[] {
  if (!CODE_EXTENSION.test(file) || TEST_FILE.test(file)) return [];
  const lines = splitLines(text);
  const lineAt = lineLocator(text);
  const findings: Finding[] = [];
  const seen = new Set<number>();
  for (const pattern of CORS_WILDCARD) {
    for (const match of text.matchAll(pattern)) {
      const line = lineAt(match.index);
      const lineText = lines[line - 1] ?? "";
      if (seen.has(line) || isCommentLine(lineText) || lineText.length > MAX_LINE_LENGTH) continue;
      const django = match[0].includes("CORS_");
      const window = (
        django ? lines : lines.slice(Math.max(0, line - 1 - CORS_WINDOW), line + CORS_WINDOW)
      )
        .filter((candidate) => !isCommentLine(candidate))
        .join("\n");
      if (!CORS_CREDENTIALS.test(window)) continue;
      seen.add(line);
      findings.push(
        configFinding({
          ruleId: "config/cors-wildcard-credentials",
          title: "CORS allows any origin with credentials",
          severity: "medium",
          file,
          line,
          evidence: match[0].trim(),
          description:
            "CORS accepts requests from any origin while also allowing credentials. Several frameworks then echo the caller's origin back, so any website can make logged-in requests to your API on behalf of your users.",
          remediation:
            "List the exact origins of your frontend (for example https://app.example.com) instead of *, or turn credentials off for public endpoints.",
          rawMatch: match[0],
        }),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// Client-exposed secret names

const CLIENT_NAME = new RegExp(
  `(?<![A-Za-z0-9_])(?:${CLIENT_EXPOSED_PREFIXES.join("|")})[A-Z0-9_]+(?![A-Za-z0-9_])`,
  "g",
);

function isClientNameFile(file: string): boolean {
  const name = basename(file);
  if (LOCKFILES.has(name)) return false;
  return name.startsWith(".env") || isDockerfile(file) || CLIENT_NAME_FILE.test(name);
}

function scanClientExposed(file: string, text: string): Finding[] {
  if (!isClientNameFile(file)) return [];
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const [index, lineText] of splitLines(text).entries()) {
    if (lineText.length > MAX_LINE_LENGTH) continue;
    for (const match of lineText.matchAll(CLIENT_NAME)) {
      const name = match[0];
      if (seen.has(name) || !isClientExposed(name) || !isSecretLikely(name)) continue;
      seen.add(name);
      const supabase = name.includes("SERVICE_ROLE");
      findings.push(
        configFinding({
          ruleId: "config/client-exposed-secret",
          title: `Secret exposed to the browser via ${name}`,
          severity: "critical",
          file,
          line: index + 1,
          evidence: name,
          description: `"${name}" has a prefix that the bundler copies into the JavaScript sent to every visitor, but its name says it holds a secret${supabase ? " (a Supabase service-role key bypasses all row level security)" : ""}. Anyone can read it from the browser.`,
          remediation: `Rename the variable without the public prefix, use it only in server-side code, and rotate the value: it has probably shipped to browsers already.${supabase ? " Browser code should use the Supabase anon key." : ""}`,
          rawMatch: name,
        }),
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------------------------
// .env not ignored

function scanEnvIgnored(context: ScanContext): Finding[] {
  // `context.files` is gitignore-aware: a real dotenv file listed there is not ignored.
  const envFiles = context.files.filter(isEnvFile);
  if (envFiles.length === 0) return [];
  const hasGitignore = context.files.includes(".gitignore");
  const shown = envFiles.slice(0, 5).join(", ");
  const evidence = envFiles.length > 5 ? `${shown} (+${envFiles.length - 5} more)` : shown;
  const input: ConfigFindingInput = {
    ruleId: "config/env-not-gitignored",
    title: ".env files are not in .gitignore",
    severity: "medium",
    evidence,
    description: `${evidence} ${envFiles.length === 1 ? "exists" : "exist"} but ${hasGitignore ? ".gitignore does not exclude them" : "the project has no .gitignore"}, so a "git add ." will commit local secrets.`,
    remediation:
      'Add ".env*" and "!.env.example" to .gitignore, and keep only variable names (no values) in a committed .env.example.',
    rawMatch: envFiles.join("\n"),
  };
  if (hasGitignore) input.file = ".gitignore";
  return [configFinding(input)];
}

// ---------------------------------------------------------------------------------------------

async function scanFile(context: ScanContext, file: string): Promise<Finding[]> {
  const dockerfile = isDockerfile(file);
  if (!dockerfile && !CODE_EXTENSION.test(file) && !isClientNameFile(file)) return [];
  const text = await readText(context, file);
  if (text === undefined) return [];
  return [
    ...(dockerfile ? scanDockerfile(file, text) : []),
    ...scanDjango(file, text),
    ...scanFlask(file, text),
    ...scanCors(file, text),
    ...scanClientExposed(file, text),
  ];
}

/**
 * Built-in configuration scanner (`opscrew-config`): Dockerfiles running as root (medium),
 * `latest` or untagged base images (low), base images without a digest (low) and literal secrets
 * in `ENV`/`ARG` (high); Django
 * `DEBUG = True` and Flask debug mode (high); CORS `*` combined with credentials (medium);
 * client-exposed env names containing `SECRET`, `SERVICE_ROLE`, `PRIVATE` or `PASSWORD`
 * (critical); and `.env` files that `.gitignore` does not exclude (medium).
 */
export function createConfigScanner(): Scanner {
  return {
    id: SOURCE,
    kind: "builtin",
    isAvailable: async () => true,
    async scan(context) {
      const results = await mapConcurrent(context.files, READ_CONCURRENCY, (file) =>
        scanFile(context, file),
      );
      return [...results.flat(), ...scanEnvIgnored(context)];
    },
  };
}
