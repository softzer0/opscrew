/**
 * Health routes for Node.js frameworks that register routes in code: the route goes right after
 * the one app object is created (Express, Fastify, Hono, Koa, Elysia, Hapi, Restify, and Feathers
 * with its Express or Koa transport), so it comes before any middleware the app adds later.
 * Feathers without one of those transports stays with the Code-change agent.
 */
import { appDirOf, under } from "../../design/code-changes";
import {
  appCodeFiles,
  type PathUse,
  pathTaken,
  pathVariants,
  readSource,
  routeUses,
} from "./common";
import {
  creationOf,
  findCalls,
  type JsCall,
  type JsImport,
  type JsSource,
  jsImports,
  jsStyle,
  moduleCandidates,
  scanJs,
} from "./js";
import {
  applyInsertions,
  eolOf,
  escapeRegExp,
  type Insertion,
  indentOf,
  isBlank,
  lineStarts,
  linesAfter,
  partsOf,
  splitLines,
} from "./text";
import {
  addedNote,
  appInClass,
  type HealthEdit,
  type HealthRouteInput,
  manual,
  severalApps,
  unassignedApp,
} from "./types";

/** What a snippet gets: the app variable and the file's style. */
interface Snippet {
  app: string;
  path: string;
  /** `"x"` in the file's quote style. */
  q: (value: string) => string;
  /** `;` or nothing. */
  s: string;
  /** One indentation step. */
  u: string;
}

/** One Node.js framework. */
interface NodeSpec {
  name: string;
  /** Resolved callees that create the app (`express`, `hono.Hono`, `@hapi/hapi.server` …). */
  targets: readonly string[];
  /** Module names, for a quick text test before a file is read closely. */
  modules: readonly string[];
  /** Lines of the route (without the creation statement's indentation). */
  lines?: (snippet: Snippet) => string[];
  /** Chained calls on the new app that are harmless (types only). */
  harmlessChain?: readonly string[];
  /** Set when OpsCrew never edits this framework: the reason. */
  pending?: string;
  /** Elysia: the route goes into the app's method chain. */
  chain?: (snippet: Snippet) => string;
  /**
   * Code that runs for every route whatever its order (Fastify hooks, Restify `use`, Hapi
   * extensions), and what to call it in the check the user gets.
   */
  global?: { pattern: RegExp; what: string };
}

const ok = (q: Snippet["q"]) => `{ status: ${q("ok")} }`;

/** An Express GET route (also on a Feathers app with the Express transport). */
const expressLines = ({ app, path, q, s, u }: Snippet) => [
  `${app}.get(${q(path)}, (_req, res) => {`,
  `${u}res.json(${ok(q)})${s}`,
  `})${s}`,
];

/** Koa has no router of its own: a first middleware answers the path (also on Feathers' Koa). */
const koaLines = ({ app, path, q, s, u }: Snippet) => [
  `${app}.use(async (ctx, next) => {`,
  `${u}if (ctx.method === ${q("GET")} && ctx.path === ${q(path)}) {`,
  `${u}${u}ctx.body = ${ok(q)}${s}`,
  `${u}${u}return${s}`,
  `${u}}`,
  `${u}await next()${s}`,
  `})${s}`,
];

/** Feathers' own app object: what a transport wraps (`express(feathers())`). */
const FEATHERS_CORE = [
  "@feathersjs/feathers",
  "@feathersjs/feathers.feathers",
  "@feathersjs/feathers.default",
];

const SPECS: readonly NodeSpec[] = [
  {
    name: "Express",
    targets: ["express"],
    modules: ["express"],
    lines: expressLines,
  },
  {
    // Feathers 5 with the Express transport: `const app = express(feathers())` is an Express app.
    name: "Feathers (Express)",
    targets: ["@feathersjs/express", "@feathersjs/express.default", "@feathersjs/express.express"],
    modules: ["@feathersjs/express"],
    lines: expressLines,
  },
  {
    // Feathers 5 with the Koa transport: `const app = koa(feathers())` takes Koa middleware.
    name: "Feathers (Koa)",
    targets: ["@feathersjs/koa.koa", "@feathersjs/koa", "@feathersjs/koa.default"],
    modules: ["@feathersjs/koa"],
    lines: koaLines,
  },
  {
    name: "Fastify",
    targets: ["fastify", "fastify.fastify", "fastify.default"],
    modules: ["fastify"],
    harmlessChain: ["withTypeProvider", "setValidatorCompiler", "setSerializerCompiler"],
    lines: ({ app, path, q, s, u }) => [
      `${app}.get(${q(path)}, async () => {`,
      `${u}return ${ok(q)}${s}`,
      `})${s}`,
    ],
    global: {
      pattern: /\.addHook\(\s*["'](?:onRequest|preParsing|preValidation|preHandler)["']/,
      what: "the onRequest/preHandler hooks",
    },
  },
  {
    name: "Hono",
    targets: ["hono.Hono", "hono/tiny.Hono", "hono/quick.Hono"],
    modules: ["hono"],
    lines: ({ app, path, q, s }) => [`${app}.get(${q(path)}, (c) => c.json(${ok(q)}))${s}`],
  },
  {
    name: "Koa",
    targets: ["koa", "koa.default", "koa.Koa"],
    modules: ["koa"],
    lines: koaLines,
  },
  {
    name: "Elysia",
    targets: ["elysia.Elysia"],
    modules: ["elysia"],
    lines: ({ app, path, q, s }) => [`${app}.get(${q(path)}, () => (${ok(q)}))${s}`],
    chain: ({ path, q }) => `.get(${q(path)}, () => (${ok(q)}))`,
  },
  {
    name: "Hapi",
    targets: ["@hapi/hapi.server", "@hapi/hapi.Server", "hapi.server", "hapi.Server"],
    modules: ["hapi"],
    // `auth: false`: a default auth strategy set later must not protect the health check.
    lines: ({ app, path, q, s, u }) => [
      `${app}.route({`,
      `${u}method: ${q("GET")},`,
      `${u}path: ${q(path)},`,
      `${u}options: { auth: false },`,
      `${u}handler: () => (${ok(q)}),`,
      `})${s}`,
    ],
    global: { pattern: /\.ext\(\s*["']onRequest["']/, what: "the onRequest extensions" },
  },
  {
    name: "Restify",
    targets: ["restify.createServer"],
    modules: ["restify"],
    lines: ({ app, path, q, s, u }) => [
      `${app}.get(${q(path)}, (_req, res, next) => {`,
      `${u}res.send(${ok(q)})${s}`,
      `${u}return next()${s}`,
      `})${s}`,
    ],
    global: { pattern: /\.(?:use|pre)\(/, what: "the server.use() and server.pre() handlers" },
  },
  {
    // A Feathers app without the Express or Koa transport (or one built elsewhere).
    name: "Feathers",
    targets: FEATHERS_CORE,
    modules: ["@feathersjs/feathers"],
    pending:
      "the Feathers app is not wrapped in the Express or Koa transport here (`express(feathers())` or `koa(feathers())`), and Feathers registers routes as services, so OpsCrew leaves the health route to the Code-change agent",
  },
];

/** A file with an app object. */
interface Found {
  file: string;
  src: JsSource;
  imports: JsImport[];
  call: JsCall;
  spec: NodeSpec;
}

/** The quote of the import that brings in the framework, if the file has one. */
function importQuote(imports: readonly JsImport[], spec: NodeSpec): string | undefined {
  return imports.find((entry) =>
    spec.targets.some((target) => target === entry.module || target.startsWith(`${entry.module}.`)),
  )?.quote;
}

/** A scanned file that may serve an app: it calls `.listen`, `.fetch`, `serve(` or `createServer(`. */
interface Server {
  file: string;
  src: JsSource;
  imports: JsImport[];
}

const SERVES = /\.\s*(?:listen|fetch)\b|\b(?:serve|createServer)\s*\(/;

/** True when `code` serves the variable `name`: `name.listen(…)`, `name.fetch`, `serve(name)`. */
function servesName(code: string, name: string): boolean {
  const n = escapeRegExp(name);
  return new RegExp(
    `(?<![\\w$.])${n}\\s*\\.\\s*(?:fetch|listen)\\b|\\b(?:serve|createServer)\\s*\\(\\s*${n}\\b`,
  ).test(code);
}

/** The names a module exports the app variable under: `default` and/or named exports. */
function exportNames(src: JsSource, name: string, declaredExported: boolean): Set<string> {
  const names = new Set<string>(declaredExported ? [name] : []);
  const n = escapeRegExp(name);
  if (
    new RegExp(`\\bmodule\\.exports\\s*=\\s*${n}\\s*(?:;|$)`, "m").test(src.code) ||
    new RegExp(`\\bexport\\s+default\\s+${n}\\b`).test(src.code)
  ) {
    names.add("default");
  }
  for (const match of src.code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const item of (match[1] ?? "").split(",")) {
      const [local, as, exported] = item.trim().split(/\s+/);
      if (local === name) names.add(as === "as" && exported ? exported : local);
    }
  }
  for (const match of src.code.matchAll(
    new RegExp(`\\b(?:module\\.)?exports\\.([\\w$]+)\\s*=\\s*${n}\\b`, "g"),
  )) {
    if (match[1]) names.add(match[1]);
  }
  const object = /\bmodule\.exports\s*=\s*\{([^}]*)\}/.exec(src.code)?.[1];
  for (const item of object?.split(",") ?? []) {
    const [key, value] = item.split(":").map((part) => part.trim());
    if (key && (value ?? key) === name) names.add(key);
  }
  return names;
}

/**
 * The files that serve an app object: its own file (`app.listen(…)`, `app.fetch`, `serve(app)`,
 * `.listen(…)` at the end of its creation chain) and files that import its export and serve it.
 */
function servedBy(found: Found, servers: readonly Server[], files: ReadonlySet<string>): string[] {
  const creation = creationOf(found.src, found.call);
  if (creation === undefined) return [];
  const by: string[] = [];
  if (
    creation.chain.some((link) => link.name === "listen") ||
    servesName(found.src.code, creation.name)
  ) {
    by.push(found.file);
  }
  const exported = found.src.code.startsWith("export", creation.start);
  const names = exportNames(found.src, creation.name, exported);
  if (names.size === 0) return by;
  for (const server of servers) {
    if (server.file === found.file) continue;
    for (const entry of server.imports) {
      const resolved = moduleCandidates(server.file, entry.module).find((c) => files.has(c));
      if (resolved !== found.file) continue;
      for (const [local, imported] of entry.bindings) {
        if (names.has(imported) && servesName(server.src.code, local)) by.push(server.file);
      }
    }
  }
  return by;
}

/**
 * The app's entry file from its start command (`node index.js`, `npm start` → the `start`
 * script, `node dist/main` → `src/main.ts`) or `main` in package.json, if it is one of `files`.
 */
async function entryFile(
  input: HealthRouteInput,
  files: ReadonlySet<string>,
): Promise<string | undefined> {
  const dir = appDirOf(input.facts);
  let manifest: { scripts?: Record<string, string>; main?: string } = {};
  try {
    manifest = JSON.parse((await input.repo.read(under(dir, "package.json"))) ?? "{}");
  } catch {
    // An unreadable package.json names no entry.
  }
  let command = (input.facts.build.startCommand ?? "").replace(/^cd\s+\S+\s*&&\s*/, "");
  const script = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(command)?.[1];
  if (script !== undefined) command = manifest.scripts?.[script] ?? "";
  const tokens = command.split(/\s+/).filter((token) => token !== "");
  const runner = tokens.findIndex((token) =>
    /^(?:node|nodemon|tsx|ts-node|ts-node-dev|bun|deno)$/.test(token),
  );
  const candidates = [
    ...(runner === -1 ? [] : tokens.slice(runner + 1).filter((token) => !token.startsWith("-"))),
    ...(manifest.main === undefined ? [] : [manifest.main]),
  ];
  for (const raw of candidates) {
    const path = raw.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
    const stem = path.replace(/\.[cm]?[jt]s$/, "");
    const source = stem.replace(/^(?:dist|build|out)\//, "src/");
    for (const option of [
      path,
      ...["js", "ts", "mjs", "cjs", "mts"].map((ext) => `${stem}.${ext}`),
      `${stem}/index.js`,
      `${stem}/index.ts`,
      `${source}.ts`,
      `${source}.js`,
    ]) {
      const file = under(dir, option);
      if (files.has(file)) return file;
    }
  }
  return undefined;
}

/** Lines inserted after `line`, with one blank line on each side where there is none. */
export function jsBlockAfter(text: string, line: number, block: readonly string[]): Insertion {
  const lines = splitLines(text);
  const atEnd = lines.slice(line + 1).every((l) => isBlank(l));
  return linesAfter(text, line, [
    ...(isBlank(lines[line]) ? [] : [""]),
    ...block,
    ...(atEnd || isBlank(lines[line + 1]) ? [] : [""]),
  ]);
}

/**
 * The health route for a Node.js app that registers routes in code, or undefined when no app
 * object of a framework OpsCrew knows is found.
 */
export async function nodeHealthRoute(input: HealthRouteInput): Promise<HealthEdit | undefined> {
  const files = await appCodeFiles(input.repo, input.facts, /\.[cm]?[jt]s$/);
  const fileSet = new Set(await input.repo.files());
  const all: Found[] = [];
  const servers: Server[] = [];
  const uses: PathUse[] = [];
  const paths = pathVariants(input.healthPath);
  for (const file of files) {
    const text = await readSource(input.repo, file);
    if (text === undefined) continue;
    const specs = SPECS.filter((spec) => spec.modules.some((module) => text.includes(module)));
    const quick = paths.some((path) => text.includes(path));
    const serves = SERVES.test(text);
    if (specs.length === 0 && !quick && !serves) continue;
    const src = scanJs(text);
    if (quick) uses.push(...routeUses(file, text, src.code, paths));
    const imports = jsImports(src);
    if (serves) servers.push({ file, src, imports });
    for (const spec of specs) {
      for (const call of findCalls(src, imports, new Set(spec.targets))) {
        all.push({ file, src, imports, call, spec });
      }
    }
  }
  const taken = pathTaken(uses, input.healthPath);
  if (taken !== undefined) return taken;
  // `express(feathers())`: the Feathers app inside a transport is the same app.
  const found = all.filter(
    (f) =>
      f.spec.pending === undefined ||
      !all.some(
        (t) =>
          t !== f &&
          t.file === f.file &&
          t.spec.pending === undefined &&
          t.call.open < f.call.start &&
          f.call.start < t.call.close,
      ),
  );
  if (found.length === 0) return undefined;
  const starts = new Map<string, number[]>();
  const lineOf = (f: Found) => {
    const s = starts.get(f.file) ?? lineStarts(f.src.text);
    starts.set(f.file, s);
    return s.filter((start) => start <= f.call.start).length;
  };
  // Several apps (Hono and Elysia sub-apps, a metrics or admin app): the one that is served, in
  // its own file or by a file that imports it; else the one the start command's entry serves or
  // creates.
  let chosen = found;
  if (found.length > 1) {
    const served = found
      .map((f) => ({ f, by: servedBy(f, servers, fileSet) }))
      .filter((s) => s.by.length > 0);
    chosen = served.length === 1 ? served.map((s) => s.f) : [];
    if (chosen.length === 0) {
      const entry = await entryFile(input, fileSet);
      if (entry !== undefined) {
        chosen = served.filter((s) => s.by.includes(entry)).map((s) => s.f);
        if (chosen.length === 0) chosen = found.filter((f) => f.file === entry);
      }
    }
  }
  if (chosen.length !== 1) {
    return severalApps(found.map((f) => `${f.spec.name} in ${f.file} line ${lineOf(f)}`));
  }
  const only = chosen[0] as Found;
  const { file, src, imports, call, spec } = only;
  const line = lineOf(only);
  if (spec.pending !== undefined) return manual(`${spec.pending}.`);
  const creation = creationOf(src, call);
  if (creation === undefined) return unassignedApp(spec.name, file, line);
  if (creation.inClass) return appInClass(spec.name, file, line);
  if (creation.crowded) {
    return manual(
      `more code follows the ${spec.name} app on line ${creation.lastLine + 1} of ${file}, so OpsCrew did not edit it.`,
    );
  }
  const style = jsStyle(src, creation.semicolon, importQuote(imports, spec));
  const snippet: Snippet = {
    app: creation.name,
    path: input.healthPath,
    q: (value) => `${style.quote}${value}${style.quote}`,
    s: style.semi,
    u: style.unit,
  };
  const first = (partsOf(src.code, call.open, ":") ?? [])[0];
  const options =
    first !== undefined && src.code[first.start] === "{"
      ? (partsOf(src.code, first.start, ":") ?? [])
      : [];
  if (options.some((part) => part.name === "prefix")) {
    return manual(
      `the ${spec.name} app in ${file} is created with a prefix, so a new route would not answer at ${input.healthPath}.`,
    );
  }
  let insertion: Insertion;
  const chain = creation.chain.map((link) => link.name);
  if (spec.chain !== undefined && chain.length > 0) {
    // Elysia: into the method chain, right after `new Elysia(…)`; on its own line when the
    // chain continues on the next line.
    const dot = src.code.indexOf(".", call.close);
    if (/\n/.test(src.text.slice(call.close, dot))) {
      const lineStart = src.text.lastIndexOf("\n", dot) + 1;
      const indent = indentOf(src.text.slice(lineStart));
      insertion = { offset: lineStart, text: `${indent}${spec.chain(snippet)}${eolOf(src.text)}` };
    } else {
      insertion = { offset: call.close, text: spec.chain(snippet) };
    }
  } else {
    const harmful = chain.filter((name) => !(spec.harmlessChain ?? []).includes(name));
    if (harmful.length > 0) {
      const base = harmful.includes("basePath")
        ? `the ${spec.name} app in ${file} is created with .basePath(…), so a new route would not answer at ${input.healthPath}`
        : `the ${spec.name} app in ${file} is created with chained calls (.${harmful.join("(…), .")}(…)), so OpsCrew cannot add a route before them`;
      return manual(`${base}.`);
    }
    const lines = (spec.lines?.(snippet) ?? []).map((l) => `${creation.indent}${l}`);
    insertion = jsBlockAfter(src.text, creation.lastLine, lines);
  }
  const global = spec.global;
  const checks =
    global?.pattern.test(src.text) === true
      ? [
          `Check that ${global.what} in ${file} do not protect ${input.healthPath}: ${spec.name} runs them for every route, and the deploy health check calls it without a session.`,
        ]
      : [];
  return {
    action: "write",
    framework: spec.name,
    files: [{ path: file, content: applyInsertions(src.text, [insertion]), created: false }],
    path: file,
    note: addedNote(file, input.healthPath, spec.name),
    checks,
  };
}
