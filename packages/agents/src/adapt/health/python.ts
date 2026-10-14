/**
 * Health routes for Python web frameworks that register routes in code: the route goes right
 * after the one app object is created (at module level or inside an app factory).
 */
import {
  appCodeFiles,
  appFolder,
  type PathUse,
  pathTaken,
  pathVariants,
  readSource,
  routeUses,
  under,
} from "./common";
import {
  blockAfter,
  blockBefore,
  enclosing,
  gapFor,
  linesAfter,
  type PyCall,
  type PyImport,
  type PySource,
  type PyStatement,
  pyBinds,
  pyCalls,
  pyImportName,
  pyImports,
  scanPy,
} from "./py";
import { applyInsertions, type Insertion, listing, partsOf, prependElement } from "./text";
import { addedNote, type HealthEdit, type HealthRouteInput, manual } from "./types";

/** What a framework's edit gets. */
interface PyContext {
  file: string;
  src: PySource;
  imports: PyImport[];
  call: PyCall;
  healthPath: string;
  /** Name for the new handler function (`health`, or `opscrew_health` when that is taken). */
  handler: string;
  /** Every Python file of the app with its text (to find a free route name). */
  texts: ReadonlyMap<string, string>;
}

/** One Python framework. */
interface PySpec {
  name: string;
  /** Dotted names of the calls that create the app. */
  targets: readonly string[];
  /** A quick text test before a file is read closely. */
  mentions: RegExp;
  /** How the app object may be bound: `app = X()` (default), `with X() as config:`, or any call. */
  forms?: readonly PyCall["form"][];
  build(ctx: PyContext): Insertion[] | string;
}

/** `"value"` in the file's quote style. */
function lit(ctx: PyContext, value: string): string {
  return `${ctx.src.quote}${value}${ctx.src.quote}`;
}

/** `{"status": "ok"}` in the file's quote style. */
function okBody(ctx: PyContext): string {
  return `{${lit(ctx, "status")}: ${lit(ctx, "ok")}}`;
}

/** Lines indented by the creation statement's indentation plus `level` steps. */
function at(
  ctx: PyContext,
  level: number,
  line: string,
  indent = ctx.call.statement.indent,
): string {
  return `${indent}${ctx.src.unit.repeat(level)}${line}`;
}

/** The import statement that binds the framework (the anchor for new imports). */
function frameworkImport(ctx: PyContext): PyStatement | undefined {
  const head = ctx.src.code.slice(ctx.call.start, ctx.call.open).split(".")[0]?.trim();
  return ctx.imports.find((entry) => head !== undefined && entry.bindings.has(head))?.statement;
}

/** A decorated handler right after the app is created. */
function decorated(
  ctx: PyContext,
  decorator: string,
  signature: string,
  body: string,
): Insertion[] {
  return [
    blockAfter(ctx.src, ctx.call.statement, [
      at(ctx, 0, decorator),
      at(ctx, 0, signature),
      at(ctx, 1, body),
    ]),
  ];
}

/** A handler (or class) and the line that registers it, right after the app is created. */
function registered(ctx: PyContext, definition: string[], registration: string): Insertion[] {
  const gap = Array<string>(gapFor(ctx.call.statement.indent)).fill("");
  return [blockAfter(ctx.src, ctx.call.statement, [...definition, ...gap, registration])];
}

/** The outermost statement holding `statement` (itself at module level). */
function topLevel(src: PySource, statement: PyStatement): PyStatement {
  return enclosing(src, statement).at(-1) ?? statement;
}

/** A free class name in the file. */
function className(ctx: PyContext, name: string): string {
  return pyBinds(ctx.src, name) ? `OpsCrew${name}` : name;
}

/** The single module-level list assignment `name = [...]` in the file, as its `[` offset. */
function listAssignment(src: PySource, name: string, scope: string): number | undefined {
  const found: number[] = [];
  for (const statement of src.statements) {
    if (statement.indent !== scope) continue;
    const match = new RegExp(`^${name}[ \\t]*(?::[^=\\n]*)?=[ \\t]*\\[`).exec(
      statement.code.trimStart(),
    );
    if (match) found.push(statement.start + match[0].length - 1);
  }
  return found.length === 1 ? found[0] : undefined;
}

const SPECS: readonly PySpec[] = [
  {
    name: "FastAPI",
    targets: ["fastapi.FastAPI", "fastapi.applications.FastAPI"],
    mentions: /\bfastapi\b/,
    build: (ctx) =>
      decorated(
        ctx,
        `@${ctx.call.name}.get(${lit(ctx, ctx.healthPath)})`,
        `${/\basync[ \t]+def\b/.test(ctx.src.code) ? "async " : ""}def ${ctx.handler}():`,
        `return ${okBody(ctx)}`,
      ),
  },
  {
    name: "Flask",
    targets: ["flask.Flask", "flask.app.Flask"],
    mentions: /\bflask\b/,
    build: (ctx) =>
      decorated(
        ctx,
        `@${ctx.call.name}.route(${lit(ctx, ctx.healthPath)})`,
        `def ${ctx.handler}():`,
        `return ${okBody(ctx)}`,
      ),
  },
  {
    name: "Quart",
    targets: ["quart.Quart", "quart.app.Quart"],
    mentions: /\bquart\b/,
    build: (ctx) =>
      decorated(
        ctx,
        `@${ctx.call.name}.route(${lit(ctx, ctx.healthPath)})`,
        `async def ${ctx.handler}():`,
        `return ${okBody(ctx)}`,
      ),
  },
  {
    name: "Bottle",
    targets: ["bottle.Bottle"],
    mentions: /\bbottle\b/,
    build: (ctx) =>
      decorated(
        ctx,
        `@${ctx.call.name}.route(${lit(ctx, ctx.healthPath)})`,
        `def ${ctx.handler}():`,
        `return ${okBody(ctx)}`,
      ),
  },
  {
    name: "Sanic",
    targets: ["sanic.Sanic", "sanic.app.Sanic"],
    mentions: /\bsanic\b/,
    build: (ctx) => {
      const json = pyImportName(
        ctx.src,
        ctx.imports,
        "sanic.response",
        "json",
        "sanic_json",
        frameworkImport(ctx),
      );
      return [
        ...(json.insertion === undefined ? [] : [json.insertion]),
        ...decorated(
          ctx,
          `@${ctx.call.name}.get(${lit(ctx, ctx.healthPath)})`,
          `async def ${ctx.handler}(request):`,
          `return ${json.local}(${okBody(ctx)})`,
        ),
      ];
    },
  },
  {
    name: "Litestar",
    targets: ["litestar.Litestar", "litestar.app.Litestar"],
    mentions: /\blitestar\b/,
    build: (ctx) => {
      const get = pyImportName(
        ctx.src,
        ctx.imports,
        "litestar",
        "get",
        "litestar_get",
        frameworkImport(ctx),
      );
      // Litestar needs the return annotation on every handler.
      return [
        ...(get.insertion === undefined ? [] : [get.insertion]),
        ...registered(
          ctx,
          [
            at(ctx, 0, `@${get.local}(${lit(ctx, ctx.healthPath)})`),
            at(ctx, 0, `async def ${ctx.handler}() -> dict[str, str]:`),
            at(ctx, 1, `return ${okBody(ctx)}`),
          ],
          at(ctx, 0, `${ctx.call.name}.register(${ctx.handler})`),
        ),
      ];
    },
  },
  {
    name: "Falcon",
    targets: [
      "falcon.App",
      "falcon.API",
      "falcon.app.App",
      "falcon.asgi.App",
      "falcon.asgi.app.App",
    ],
    mentions: /\bfalcon\b/,
    build: (ctx) => {
      const resource = className(ctx, "HealthResource");
      const asgi = ctx.call.target.includes(".asgi.");
      return registered(
        ctx,
        [
          at(ctx, 0, `class ${resource}:`),
          at(ctx, 1, `${asgi ? "async " : ""}def on_get(self, req, resp):`),
          at(ctx, 2, `resp.media = ${okBody(ctx)}`),
        ],
        at(ctx, 0, `${ctx.call.name}.add_route(${lit(ctx, ctx.healthPath)}, ${resource}())`),
      );
    },
  },
  {
    name: "aiohttp",
    targets: ["aiohttp.web.Application", "aiohttp.web_app.Application"],
    mentions: /\baiohttp\b/,
    build: (ctx) => {
      const json = pyImportName(
        ctx.src,
        ctx.imports,
        "aiohttp.web",
        "json_response",
        "aiohttp_json_response",
        frameworkImport(ctx),
      );
      return [
        ...(json.insertion === undefined ? [] : [json.insertion]),
        ...registered(
          ctx,
          [
            at(ctx, 0, `async def ${ctx.handler}(request):`),
            at(ctx, 1, `return ${json.local}(${okBody(ctx)})`),
          ],
          at(
            ctx,
            0,
            `${ctx.call.name}.router.add_get(${lit(ctx, ctx.healthPath)}, ${ctx.handler})`,
          ),
        ),
      ];
    },
  },
  {
    name: "Starlette",
    targets: ["starlette.applications.Starlette"],
    mentions: /\bstarlette\b/,
    build: starletteEdit,
  },
  {
    name: "Tornado",
    targets: ["tornado.web.Application"],
    mentions: /\btornado\b/,
    forms: ["assign", "other"],
    build: tornadoEdit,
  },
  {
    name: "Pyramid",
    targets: ["pyramid.config.Configurator"],
    mentions: /\bpyramid\b/,
    forms: ["assign", "with"],
    build: pyramidEdit,
  },
];

/** The handler function and JSONResponse import shared by the Starlette layouts. */
function starletteHandler(
  ctx: PyContext,
  indent: string,
): { lines: string[]; imports: Insertion[] } {
  const response = pyImportName(
    ctx.src,
    ctx.imports,
    "starlette.responses",
    "JSONResponse",
    "StarletteJSONResponse",
    frameworkImport(ctx),
  );
  return {
    lines: [
      at(ctx, 0, `async def ${ctx.handler}(request):`, indent),
      at(ctx, 1, `return ${response.local}(${okBody(ctx)})`, indent),
    ],
    imports: response.insertion === undefined ? [] : [response.insertion],
  };
}

/**
 * Starlette: a `Route` first in the routes list given to `Starlette(routes=[...])` (inline or a
 * list variable in the same scope), or `app.add_route` when the app gets no routes list.
 */
function starletteEdit(ctx: PyContext): Insertion[] | string {
  const parts = partsOf(ctx.src.code, ctx.call.open, "=") ?? [];
  const routes = parts.find((part) => part.name === "routes");
  const statement = ctx.call.statement;
  if (routes === undefined) {
    const handler = starletteHandler(ctx, statement.indent);
    return [
      ...handler.imports,
      ...registered(
        ctx,
        handler.lines,
        at(
          ctx,
          0,
          `${ctx.call.name}.add_route(${lit(ctx, ctx.healthPath)}, ${ctx.handler}, methods=[${lit(ctx, "GET")}])`,
        ),
      ),
    ];
  }
  const value = ctx.src.code.slice(routes.valueStart ?? routes.start, routes.end).trim();
  let open: number | undefined;
  let holder = statement;
  if (value.startsWith("[")) {
    open = routes.valueStart;
  } else if (/^[A-Za-z_]\w*$/.test(value)) {
    open = listAssignment(ctx.src, value, statement.indent);
    const owner = ctx.src.statements.find(
      (s) =>
        open !== undefined && s.start <= open && open < (ctx.src.starts[s.last + 1] ?? Infinity),
    );
    if (owner !== undefined) holder = owner;
  }
  if (open === undefined) {
    return `the Starlette app gets its routes from \`${value}\`, which is not a list OpsCrew can find in ${ctx.file}`;
  }
  const route = pyImportName(
    ctx.src,
    ctx.imports,
    "starlette.routing",
    "Route",
    "StarletteRoute",
    frameworkImport(ctx),
  );
  const handler = starletteHandler(ctx, holder.indent);
  const entry = prependElement(
    ctx.src.text,
    ctx.src.code,
    open,
    `${route.local}(${lit(ctx, ctx.healthPath)}, ${ctx.handler})`,
  );
  if (entry === undefined) return `the routes list in ${ctx.file} is not closed`;
  return [
    ...(route.insertion === undefined ? [] : [route.insertion]),
    ...handler.imports,
    blockBefore(ctx.src, holder, handler.lines),
    entry,
  ];
}

/**
 * Tornado: a `(r"/health", HealthHandler)` first in the handlers list given to `Application`
 * (inline, or a list variable in the same scope), with the handler class above the statement.
 */
function tornadoEdit(ctx: PyContext): Insertion[] | string {
  const parts = partsOf(ctx.src.code, ctx.call.open, "=") ?? [];
  const handlers = parts.find((part) => part.name === "handlers") ?? parts.find((p) => !p.name);
  if (handlers === undefined) {
    return `the Tornado Application in ${ctx.file} gets no handlers list`;
  }
  const value = ctx.src.code.slice(handlers.valueStart ?? handlers.start, handlers.end).trim();
  let open: number | undefined;
  if (value.startsWith("[")) open = handlers.valueStart ?? handlers.start;
  else if (/^[A-Za-z_]\w*$/.test(value)) {
    open =
      listAssignment(ctx.src, value, ctx.call.statement.indent) ??
      listAssignment(ctx.src, value, "");
  }
  if (open === undefined) {
    return `the Tornado Application gets its handlers from \`${value}\`, which is not a list OpsCrew can find in ${ctx.file}`;
  }
  const base = pyImportName(
    ctx.src,
    ctx.imports,
    "tornado.web",
    "RequestHandler",
    "TornadoRequestHandler",
    frameworkImport(ctx),
  );
  const handler = className(ctx, "HealthHandler");
  const first = ctx.src.text.slice(open + 1, open + 80).trimStart();
  const raw = /^\(\s*r["']/.test(first) ? "r" : "";
  const top = topLevel(ctx.src, ctx.call.statement);
  const entry = prependElement(
    ctx.src.text,
    ctx.src.code,
    open,
    `(${raw}${lit(ctx, ctx.healthPath)}, ${handler})`,
  );
  if (entry === undefined) return `the handlers list in ${ctx.file} is not closed`;
  return [
    ...(base.insertion === undefined ? [] : [base.insertion]),
    blockBefore(ctx.src, top, [
      `class ${handler}(${base.local}):`,
      `${ctx.src.unit}def get(self):`,
      `${ctx.src.unit.repeat(2)}self.write(${okBody(ctx)})`,
    ]),
    entry,
  ];
}

/**
 * Pyramid: the view at module level above the code that builds the configuration, and
 * `config.add_route` + `config.add_view` right after the `Configurator` is created.
 */
function pyramidEdit(ctx: PyContext): Insertion[] | string {
  const statement = ctx.call.statement;
  const config = ctx.call.name as string;
  let routeName = "health";
  for (const text of ctx.texts.values()) {
    if (/\.add_route\(\s*["']health["']/.test(text)) routeName = "opscrew_health";
  }
  let indent = statement.indent;
  if (ctx.call.form === "with") {
    const body = ctx.src.statements[statement.index + 1];
    indent =
      body !== undefined && body.indent.length > statement.indent.length
        ? body.indent
        : `${statement.indent}${ctx.src.unit}`;
  }
  const top = topLevel(ctx.src, statement);
  return [
    blockBefore(ctx.src, top, [
      `def ${ctx.handler}(request):`,
      `${ctx.src.unit}return ${okBody(ctx)}`,
    ]),
    linesAfter(ctx.src, statement.last, [
      `${indent}${config}.add_route(${lit(ctx, routeName)}, ${lit(ctx, ctx.healthPath)})`,
      `${indent}${config}.add_view(${ctx.handler}, route_name=${lit(ctx, routeName)}, renderer=${lit(ctx, "json")})`,
    ]),
  ];
}

/** A Python file with what it creates. */
interface Found {
  file: string;
  src: PySource;
  imports: PyImport[];
  call: PyCall;
  spec: PySpec;
}

/**
 * The health route for a Python app that registers routes in code, or undefined when no app
 * object of a framework OpsCrew knows is found.
 */
export async function pythonHealthRoute(input: HealthRouteInput): Promise<HealthEdit | undefined> {
  const files = await appCodeFiles(input.repo, input.facts, /\.py$/);
  const texts = new Map<string, string>();
  const found: Found[] = [];
  const uses: PathUse[] = [];
  const paths = pathVariants(input.healthPath);
  for (const file of files) {
    const text = await readSource(input.repo, file);
    if (text === undefined) continue;
    texts.set(file, text);
    const specs = SPECS.filter((spec) => spec.mentions.test(text));
    const quick = paths.some((path) => text.includes(path));
    if (specs.length === 0 && !quick) continue;
    const src = scanPy(text);
    if (quick) uses.push(...routeUses(file, text, src.code, paths));
    if (specs.length === 0) continue;
    const imports = pyImports(src);
    for (const spec of specs) {
      for (const call of pyCalls(src, imports, new Set(spec.targets))) {
        found.push({ file, src, imports, call, spec });
      }
    }
  }
  const taken = pathTaken(uses, input.healthPath);
  if (taken !== undefined) return taken;
  return pythonEdit(input, found, texts);
}

/** The edit for the app objects found (exactly one is needed). */
function pythonEdit(
  input: HealthRouteInput,
  found: readonly Found[],
  texts: ReadonlyMap<string, string>,
): HealthEdit | undefined {
  if (found.length === 0) return undefined;
  // Several apps (a mounted sub-app): the one in the module the start command serves.
  const started = found.length > 1 ? startedBy(input, found) : found;
  if (started.length !== 1) {
    const where = found.map(
      (f) => `${f.spec.name} in ${f.file} line ${f.call.statement.first + 1}`,
    );
    return manual(
      `OpsCrew found ${found.length} app objects (${listing(where)}), so it cannot tell which one serves the app.`,
    );
  }
  const { file, src, imports, call, spec } = started[0] as Found;
  const forms = spec.forms ?? ["assign"];
  if (!forms.includes(call.form) || (call.form !== "other" && call.name === undefined)) {
    return manual(
      `the ${spec.name} app in ${file} (line ${call.statement.first + 1}) is not assigned to a variable OpsCrew can add a route to.`,
    );
  }
  if (enclosing(src, call.statement).some((header) => /^\s*class\b/.test(header.code))) {
    return manual(
      `the ${spec.name} app in ${file} (line ${call.statement.first + 1}) is created inside a class, so OpsCrew cannot tell where a route belongs.`,
    );
  }
  let handler = "health";
  const elsewhere = [...texts.entries()].some(
    ([other, text]) => other !== file && /^[ \t]*(?:async[ \t]+)?def[ \t]+health\b/m.test(text),
  );
  if (pyBinds(src, "health") || elsewhere) handler = "opscrew_health";
  if (handler !== "health" && pyBinds(src, handler)) {
    return manual(`${file} already defines both health and opscrew_health.`);
  }
  const ctx: PyContext = { file, src, imports, call, healthPath: input.healthPath, handler, texts };
  const insertions = spec.build(ctx);
  if (typeof insertions === "string") return manual(`${insertions}.`);
  const content = applyInsertions(src.text, insertions);
  return {
    action: "write",
    framework: spec.name,
    files: [{ path: file, content, created: false }],
    path: file,
    note: addedNote(file, input.healthPath, spec.name),
    checks: pythonChecks(spec.name, file, src.text, input.healthPath),
  };
}

/**
 * The app objects in the module the start command serves (`uvicorn main:app`,
 * `gunicorn "pkg:create_app()"`, `flask --app pkg run`), relative to the app folder.
 */
function startedBy(input: HealthRouteInput, found: readonly Found[]): Found[] {
  const command = input.facts.build.startCommand ?? "";
  const module =
    /(?:^|[\s'"=])([A-Za-z_][\w.]*):[A-Za-z_]\w*(?:\(\))?(?=['"\s]|$)/.exec(command)?.[1] ??
    /--app[=\s]+['"]?([A-Za-z_][\w.]*)/.exec(command)?.[1];
  if (module === undefined) return [];
  const dir = appFolder(input.facts);
  const base = module.split(".").join("/");
  const files = new Set([`${base}.py`, `${base}/__init__.py`].map((path) => under(dir, path)));
  return found.filter((f) => files.has(f.file));
}

/** Middleware or hooks that run for every route and might protect the health path. */
function pythonChecks(framework: string, file: string, text: string, healthPath: string): string[] {
  const hooks =
    /\.(?:add_middleware|before_request|before_serving|middleware)\b|\bmiddlewares?\s*=/.test(text);
  if (!hooks) return [];
  return [
    `Check that the middleware or request hooks in ${file} do not redirect or protect ${healthPath}: ${framework} runs them for every route, and the deploy health check calls it without a session.`,
  ];
}
