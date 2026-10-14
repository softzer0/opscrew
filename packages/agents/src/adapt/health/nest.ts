/**
 * NestJS: a new `HealthController` next to the root module (the module `NestFactory.create`
 * starts), registered first in that module's `controllers`; and AdonisJS: a route first in
 * `start/routes.ts`.
 */
import { posix } from "node:path";
import { nestGlobalPrefix, nestRoutePath } from "@opscrew/detect";
import {
  appCodeFiles,
  appFolder,
  pathTaken,
  pathVariants,
  readSource,
  routeUses,
  under,
} from "./common";
import { findCalls, type JsSource, jsImports, jsStyle, scanJs, usesSemicolons } from "./js";
import { jsBlockAfter } from "./node";
import {
  applyInsertions,
  type Insertion,
  lineAt,
  lineStarts,
  partsOf,
  prependElement,
} from "./text";
import {
  createdNote,
  existsReason,
  type HealthEdit,
  type HealthRouteInput,
  manual,
  PLAN_PATH_FIX,
  planPathNote,
} from "./types";

const NEST_CREATE = "@nestjs/core.NestFactory.create";
const NEST_DECORATORS = /@(?:Controller|Get|All|Head)\(\s*(["'`])\/?([^"'`]*)\1/g;

/**
 * The file a relative import specifier names (`./app.module`, or `./app.module.js` for the
 * TypeScript source of an ESM build), if it exists.
 */
async function resolveModule(
  input: HealthRouteInput,
  from: string,
  specifier: string,
): Promise<string | undefined> {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = base.replace(/\.[cm]?js$/, "");
  const candidates = [
    ...(/\.[cm]?[jt]s$/.test(base) ? [base] : []),
    ...["ts", "mts", "js", "mjs"].map((ext) => `${stem}.${ext}`),
    `${stem}/index.ts`,
    `${stem}/index.js`,
  ];
  for (const candidate of candidates) {
    if ((await input.repo.read(candidate)) !== undefined) return candidate;
  }
  return undefined;
}

/** Health paths NestJS controllers in a file already declare (controller prefix + method path). */
function declaredPaths(src: JsSource): string[] {
  const paths: string[] = [];
  let prefix = "";
  for (const match of src.text.matchAll(NEST_DECORATORS)) {
    if (src.code[match.index] !== "@") continue;
    const value = (match[2] ?? "").replace(/\/+$/, "");
    if (match[0].startsWith("@Controller")) {
      prefix = value;
      continue;
    }
    paths.push(`/${[prefix, value].filter((part) => part !== "").join("/")}`);
  }
  return paths;
}

/** A decorator the project defines to mark routes public for its guards (`SetMetadata`). */
const PUBLIC_DECORATOR =
  /export\s+const\s+(Public|IsPublic|AllowAnonymous|SkipAuth|NoAuth)\s*=\s*\([^)]*\)\s*(?::\s*[\w<>.]+\s*)?=>\s*SetMetadata\s*\(/;

/** A module specifier from `from` to `to` (both repo-relative), `./x` style, `.js` optional. */
function specifier(from: string, to: string, js: boolean): string {
  const relative = posix
    .relative(posix.dirname(from), to)
    .replace(/\.[cm]?[jt]s$/, js ? ".js" : "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** The NestJS health route, or undefined when the app has no `NestFactory.create` call. */
export async function nestHealthRoute(input: HealthRouteInput): Promise<HealthEdit | undefined> {
  const files = await appCodeFiles(input.repo, input.facts, /\.[cm]?[jt]s$/);
  const sources = new Map<string, JsSource>();
  const calls: { file: string; src: JsSource; open: number }[] = [];
  /** Files that guard every route (`APP_GUARD`, `app.useGlobalGuards`). */
  const guarded: string[] = [];
  const publicDecorators: { file: string; name: string }[] = [];
  for (const file of files) {
    const text = await readSource(input.repo, file);
    if (text === undefined) continue;
    if (
      !/@(?:Controller|Get|All|Head)\(|NestFactory|APP_GUARD|useGlobalGuards|SetMetadata/.test(text)
    ) {
      continue;
    }
    const src = scanJs(text);
    sources.set(file, src);
    if (/\buseGlobalGuards\s*\(|\bAPP_GUARD\b/.test(src.code)) guarded.push(file);
    const decorator = PUBLIC_DECORATOR.exec(src.code)?.[1];
    if (decorator !== undefined) publicDecorators.push({ file, name: decorator });
    if (!text.includes("NestFactory")) continue;
    for (const call of findCalls(src, jsImports(src), new Set([NEST_CREATE]))) {
      calls.push({ file, src, open: call.open });
    }
  }
  if (calls.length === 0) return undefined;
  if (calls.length > 1) {
    return manual(
      `OpsCrew found ${calls.length} NestFactory.create calls (${calls.map((c) => c.file).join(", ")}), so it cannot tell which module serves the app.`,
    );
  }
  const { file: main, src: mainSrc, open } = calls[0] as (typeof calls)[number];
  const prefix = nestGlobalPrefix(mainSrc.text);
  const prefixSource =
    prefix?.kind === "literal" ? `${main} sets the global prefix "${prefix.prefix}"` : "";
  const planned = input.healthPath.length > 1 ? input.healthPath.replace(/\/+$/, "") : "/";
  // The controller's own path: the plan's path without the global prefix when it starts with it.
  let route = planned.replace(/^\/+/, "");
  if (prefix?.kind === "literal" && route.startsWith(`${prefix.prefix}/`)) {
    route = route.slice(prefix.prefix.length + 1);
  }
  const moved = (actual: string) =>
    actual === planned ? {} : { healthPath: actual, pathNote: planPathNote(prefixSource, actual) };

  // A controller that already answers the path (under the prefix, when there is one).
  for (const [file, src] of sources) {
    for (const declared of declaredPaths(src)) {
      if (declared !== `/${route}` && declared !== planned) continue;
      const actual = nestRoutePath(declared, prefix);
      if (actual === undefined) {
        return {
          action: "none",
          reason: existsReason(file, declared),
          pathNote: unknownPrefixNote(main, declared),
        };
      }
      if (actual !== planned && declared !== `/${route}`) continue;
      return { action: "none", reason: existsReason(file, actual), ...moved(actual) };
    }
  }
  if (prefix?.kind === "unknown") {
    return manual(
      `${main} sets a global prefix OpsCrew cannot read, so it cannot tell where a new route would answer.`,
    );
  }
  const actual = nestRoutePath(`/${route}`, prefix) as string;

  const first = (partsOf(mainSrc.code, open, ":") ?? [])[0];
  const moduleName = first === undefined ? "" : mainSrc.code.slice(first.start, first.end).trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(moduleName)) {
    return manual(`${main} does not pass the root module to NestFactory.create by name.`);
  }
  const imported = jsImports(mainSrc).find(
    (entry) => entry.bindings.get(moduleName) === moduleName,
  );
  const moduleFile =
    imported === undefined ? undefined : await resolveModule(input, main, imported.module);
  if (moduleFile === undefined) {
    return manual(`OpsCrew could not find the file of ${moduleName}, the module ${main} starts.`);
  }
  if (!/\.[cm]?ts$/.test(moduleFile)) {
    return manual(
      `${moduleFile} is not TypeScript, so OpsCrew did not add a decorated controller to it.`,
    );
  }
  const moduleText = (await readSource(input.repo, moduleFile)) as string;
  const moduleSrc = scanJs(moduleText);
  if (/\bHealthController\b/.test(moduleSrc.code)) {
    return manual(`${moduleFile} already uses the name HealthController.`);
  }
  const controller = posix.join(posix.dirname(moduleFile), "health.controller.ts");
  if (await input.repo.exists(controller)) {
    return manual(`${controller} already exists but is not registered in ${moduleName}.`);
  }
  const decorator = /@Module\s*\(\s*\{/.exec(moduleSrc.code);
  if (decorator === null) return manual(`${moduleFile} has no @Module({ … }) OpsCrew can read.`);
  const objectOpen = decorator.index + decorator[0].length - 1;
  const properties = partsOf(moduleSrc.code, objectOpen, ":") ?? [];
  const controllers = properties.find((part) => part.name === "controllers");
  const imports = jsImports(moduleSrc);
  const common = imports.find((entry) => entry.module === "@nestjs/common");
  const style = jsStyle(moduleSrc, usesSemicolons(moduleSrc), common?.quote);
  const { quote: q, semi: s, unit: u } = style;
  const insertions: Insertion[] = [];
  if (controllers !== undefined) {
    const at = controllers.valueStart ?? controllers.start;
    if (moduleSrc.code[at] !== "[") {
      return manual(`the controllers of ${moduleName} in ${moduleFile} are not a plain list.`);
    }
    const entry = prependElement(moduleText, moduleSrc.code, at, "HealthController");
    if (entry === undefined) return manual(`the controllers list in ${moduleFile} is not closed.`);
    insertions.push(entry);
  } else {
    const entry = prependElement(
      moduleText,
      moduleSrc.code,
      objectOpen,
      "controllers: [HealthController]",
    );
    if (entry === undefined) return manual(`@Module in ${moduleFile} is not closed.`);
    insertions.push(entry);
  }
  const js = imports.some((entry) => /^\.{1,2}\/.*\.js$/.test(entry.module));
  const importLine = `import { HealthController } from ${q}./health.controller${js ? ".js" : ""}${q}${s}`;
  const last = imports.at(-1);
  if (last === undefined) {
    insertions.push({ offset: 0, text: `${importLine}${style.eol}${style.eol}` });
  } else {
    const line = lineAt(lineStarts(moduleText), last.end - 1);
    insertions.push(afterLineInsertion(moduleText, line, importLine, style.eol));
  }
  // Global guards: the project's own "public" decorator when it has exactly one, else a check.
  const checks: string[] = [];
  const marker =
    guarded.length > 0 && publicDecorators.length === 1 ? publicDecorators[0] : undefined;
  const content = [
    `import { Controller, Get } from ${q}@nestjs/common${q}${s}`,
    ...(marker === undefined
      ? []
      : [`import { ${marker.name} } from ${q}${specifier(controller, marker.file, js)}${q}${s}`]),
    "",
    "/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */",
    ...(marker === undefined ? [] : [`@${marker.name}()`]),
    `@Controller(${q}${route}${q})`,
    "export class HealthController {",
    `${u}@Get()`,
    `${u}check() {`,
    `${u}${u}return { status: ${q}ok${q} }${s}`,
    `${u}}`,
    "}",
    "",
  ].join(style.eol);
  if (guarded.length > 0 && marker === undefined) {
    checks.push(
      `Check that the global guards in ${guarded.join(" and ")} let GET ${actual} through (mark HealthController with the decorator your guards use for public routes): the deploy health check calls it without a session.`,
    );
  }
  if (/\.enableVersioning\(/.test(mainSrc.code)) {
    checks.push(
      `${main} enables API versioning: if it sets a default version, mark HealthController with @Version(VERSION_NEUTRAL) so it still answers ${actual}.`,
    );
  }
  const marked =
    marker === undefined
      ? ""
      : ` Marked @${marker.name}() (from ${marker.file}) so the global guards let it through.`;
  return {
    action: "write",
    framework: "NestJS",
    files: [
      { path: controller, content, created: true },
      { path: moduleFile, content: applyInsertions(moduleText, insertions), created: false },
    ],
    path: controller,
    note: `${createdNote(controller, actual)} Registered in ${moduleFile}.${marked}`,
    checks,
    ...moved(actual),
  };
}

/** The note for an existing controller route under a global prefix OpsCrew cannot read. */
function unknownPrefixNote(main: string, route: string): string {
  return `${main} sets a global prefix OpsCrew cannot read: the health route answers at /<prefix>${route}, and the plan's health check path must be that (${PLAN_PATH_FIX}), or every deploy fails its health check.`;
}

/** One line inserted after line `line`. */
function afterLineInsertion(text: string, line: number, added: string, eol: string): Insertion {
  const next = lineStarts(text)[line + 1];
  return next === undefined
    ? { offset: text.length, text: `${eol}${added}` }
    : { offset: next, text: `${added}${eol}` };
}

const ADONIS_ROUTERS = new Set(["@adonisjs/core/services/router", "@ioc:Adonis/Core/Route"]);

/** AdonisJS: a route first in `start/routes.ts`, right after the imports. */
export async function adonisHealthRoute(input: HealthRouteInput): Promise<HealthEdit> {
  const dir = appFolder(input.facts);
  let file: string | undefined;
  let text: string | undefined;
  for (const name of ["start/routes.ts", "start/routes.js"]) {
    const candidate = under(dir, name);
    text = await readSource(input.repo, candidate);
    if (text !== undefined) {
      file = candidate;
      break;
    }
  }
  if (file === undefined || text === undefined) {
    return manual("the AdonisJS app has no start/routes.ts OpsCrew can add the route to.");
  }
  const src = scanJs(text);
  const taken = pathTaken(
    routeUses(file, text, src.code, pathVariants(input.healthPath)),
    input.healthPath,
  );
  if (taken !== undefined) return taken;
  const imports = jsImports(src);
  const router = imports.find((entry) => ADONIS_ROUTERS.has(entry.module));
  const local =
    router === undefined
      ? undefined
      : [...router.bindings.entries()].find(([, what]) => what === "default")?.[0];
  if (router === undefined || local === undefined) {
    return manual(
      `${file} does not import the AdonisJS router, so OpsCrew cannot tell how it registers routes.`,
    );
  }
  const style = jsStyle(src, router.semicolon || usesSemicolons(src), router.quote);
  const q = (value: string) => `${style.quote}${value}${style.quote}`;
  const last = imports.at(-1) ?? router;
  const line = lineAt(lineStarts(text), last.end - 1);
  const insertion = jsBlockAfter(text, line, [
    `${local}.get(${q(input.healthPath)}, () => ({ status: ${q("ok")} }))${style.semi}`,
  ]);
  return {
    action: "write",
    framework: "AdonisJS",
    files: [{ path: file, content: applyInsertions(text, [insertion]), created: false }],
    path: file,
    note: `Added GET ${input.healthPath} to ${file} by OpsCrew, before the app's other routes: answers {"status":"ok"} for the deploy health check.`,
    checks: [],
  };
}
