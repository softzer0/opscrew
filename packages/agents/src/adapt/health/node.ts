/**
 * Health routes for Node.js frameworks that register routes in code: the route goes right after
 * the one app object is created (Express, Fastify, Hono, Koa, Elysia, Hapi, Restify), so it comes
 * before any middleware the app adds later. Feathers registers routes as services and stays with
 * the Code-change agent.
 */
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
  scanJs,
} from "./js";
import {
  applyInsertions,
  eolOf,
  type Insertion,
  indentOf,
  isBlank,
  lineStarts,
  listing,
  partsOf,
  splitLines,
} from "./text";
import { addedNote, type HealthEdit, type HealthRouteInput, manual } from "./types";

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
}

const ok = (q: Snippet["q"]) => `{ status: ${q("ok")} }`;

const SPECS: readonly NodeSpec[] = [
  {
    name: "Express",
    targets: ["express"],
    modules: ["express"],
    lines: ({ app, path, q, s, u }) => [
      `${app}.get(${q(path)}, (_req, res) => {`,
      `${u}res.json(${ok(q)})${s}`,
      `})${s}`,
    ],
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
    // Koa has no router of its own: a first middleware answers the path.
    lines: ({ app, path, q, s, u }) => [
      `${app}.use(async (ctx, next) => {`,
      `${u}if (ctx.method === ${q("GET")} && ctx.path === ${q(path)}) {`,
      `${u}${u}ctx.body = ${ok(q)}${s}`,
      `${u}${u}return${s}`,
      `${u}}`,
      `${u}await next()${s}`,
      `})${s}`,
    ],
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
    lines: ({ app, path, q, s }) => [
      `${app}.route({ method: ${q("GET")}, path: ${q(path)}, handler: () => (${ok(q)}) })${s}`,
    ],
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
  },
  {
    name: "Feathers",
    targets: [
      "@feathersjs/feathers",
      "@feathersjs/feathers.feathers",
      "@feathersjs/feathers.default",
    ],
    modules: ["@feathersjs/feathers"],
    pending:
      "Feathers registers routes as services, and whether a new one answers over HTTP depends on how the app configures its transport, so OpsCrew leaves the health route to the Code-change agent",
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

/** Lines inserted after `line`, with one blank line on each side where there is none. */
export function jsBlockAfter(text: string, line: number, block: readonly string[]): Insertion {
  const lines = splitLines(text);
  const starts = lineStarts(text);
  const eol = eolOf(text);
  const rest = lines.slice(line + 1);
  const atEnd = rest.every((l) => isBlank(l));
  const body = [
    ...(isBlank(lines[line]) ? [] : [""]),
    ...block,
    ...(atEnd || isBlank(lines[line + 1]) ? [] : [""]),
  ];
  const next = starts[line + 1];
  if (next === undefined)
    return { offset: text.length, text: body.map((l) => `${eol}${l}`).join("") };
  return { offset: next, text: body.map((l) => `${l}${eol}`).join("") };
}

/**
 * The health route for a Node.js app that registers routes in code, or undefined when no app
 * object of a framework OpsCrew knows is found.
 */
export async function nodeHealthRoute(input: HealthRouteInput): Promise<HealthEdit | undefined> {
  const files = await appCodeFiles(input.repo, input.facts, /\.[cm]?[jt]s$/);
  const found: Found[] = [];
  const uses: PathUse[] = [];
  const paths = pathVariants(input.healthPath);
  for (const file of files) {
    const text = await readSource(input.repo, file);
    if (text === undefined) continue;
    const specs = SPECS.filter((spec) => spec.modules.some((module) => text.includes(module)));
    const quick = paths.some((path) => text.includes(path));
    if (specs.length === 0 && !quick) continue;
    const src = scanJs(text);
    if (quick) uses.push(...routeUses(file, text, src.code, paths));
    if (specs.length === 0) continue;
    const imports = jsImports(src);
    for (const spec of specs) {
      for (const call of findCalls(src, imports, new Set(spec.targets))) {
        found.push({ file, src, imports, call, spec });
      }
    }
  }
  const taken = pathTaken(uses, input.healthPath);
  if (taken !== undefined) return taken;
  if (found.length === 0) return undefined;
  const starts = new Map<string, number[]>();
  const lineOf = (f: Found) => {
    const s = starts.get(f.file) ?? lineStarts(f.src.text);
    starts.set(f.file, s);
    return s.filter((start) => start <= f.call.start).length;
  };
  if (found.length > 1) {
    const where = found.map((f) => `${f.spec.name} in ${f.file} line ${lineOf(f)}`);
    return manual(
      `OpsCrew found ${found.length} app objects (${listing(where)}), so it cannot tell which one serves the app.`,
    );
  }
  const only = found[0] as Found;
  const { file, src, imports, call, spec } = only;
  const line = lineOf(only);
  if (spec.pending !== undefined) return manual(`${spec.pending}.`);
  const creation = creationOf(src, call);
  if (creation === undefined) {
    return manual(
      `the ${spec.name} app in ${file} (line ${line}) is not assigned to a variable OpsCrew can add a route to.`,
    );
  }
  if (creation.inClass) {
    return manual(
      `the ${spec.name} app in ${file} (line ${line}) is created inside a class, so OpsCrew cannot tell where a route belongs.`,
    );
  }
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
  return {
    action: "write",
    framework: spec.name,
    files: [{ path: file, content: applyInsertions(src.text, [insertion]), created: false }],
    path: file,
    note: addedNote(file, input.healthPath, spec.name),
    checks: [],
  };
}
