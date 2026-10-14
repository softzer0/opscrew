/**
 * NestJS: a new `HealthController` next to the root module (the module `NestFactory.create`
 * starts), registered first in that module's `controllers`; and AdonisJS: a route first in
 * `start/routes.ts`.
 */
import { posix } from "node:path";
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
  type HealthEdit,
  type HealthRouteInput,
  manual,
  movedPathNote,
  PLAN_PATH_FIX,
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

/** The NestJS health route, or undefined when the app has no `NestFactory.create` call. */
export async function nestHealthRoute(input: HealthRouteInput): Promise<HealthEdit | undefined> {
  const files = await appCodeFiles(input.repo, input.facts, /\.[cm]?[jt]s$/);
  const calls: { file: string; src: JsSource; open: number }[] = [];
  const wanted = input.healthPath.replace(/\/+$/, "");
  for (const file of files) {
    const text = await readSource(input.repo, file);
    if (text === undefined) continue;
    if (/@(?:Controller|Get|All)\(/.test(text)) {
      const src = scanJs(text);
      if (declaredPaths(src).includes(wanted)) {
        return {
          action: "none",
          reason: `${file} already answers ${input.healthPath}; OpsCrew left it as it is.`,
        };
      }
    }
    if (!text.includes("NestFactory")) continue;
    const src = scanJs(text);
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
  const extension = imports.some((entry) => /^\.{1,2}\/.*\.js$/.test(entry.module)) ? ".js" : "";
  const importLine = `import { HealthController } from ${q}./health.controller${extension}${q}${s}`;
  const last = imports.at(-1);
  if (last === undefined) {
    insertions.push({ offset: 0, text: `${importLine}${style.eol}${style.eol}` });
  } else {
    const line = lineAt(lineStarts(moduleText), last.end - 1);
    insertions.push(afterLineInsertion(moduleText, line, importLine, style.eol));
  }
  const route = input.healthPath.replace(/^\/+|\/+$/g, "");
  const content = [
    `import { Controller, Get } from ${q}@nestjs/common${q}${s}`,
    "",
    "/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */",
    `@Controller(${q}${route}${q})`,
    "export class HealthController {",
    `${u}@Get()`,
    `${u}check() {`,
    `${u}${u}return { status: ${q}ok${q} }${s}`,
    `${u}}`,
    "}",
    "",
  ].join(style.eol);
  const checks: string[] = [];
  let pathNote: string | undefined;
  const prefix = /\.setGlobalPrefix\(\s*(["'`])([^"'`]*)\1/.exec(mainSrc.text);
  if (prefix?.[2] !== undefined && mainSrc.code[prefix.index] === ".") {
    const value = prefix[2].replace(/^\/+|\/+$/g, "");
    const args = mainSrc.text.slice(prefix.index, prefix.index + 300);
    const excluded = /exclude/.test(args) && args.includes(route);
    if (value !== "" && !excluded) {
      pathNote = movedPathNote(
        `${main} sets the global prefix "${value}"`,
        `/${value}${input.healthPath}`,
        input.healthPath,
      );
    }
  } else if (/\.setGlobalPrefix\(/.test(mainSrc.code)) {
    pathNote = `${main} sets a global prefix OpsCrew cannot read: the health route answers at /<prefix>${input.healthPath}, and the plan's health check path must be that (${PLAN_PATH_FIX}), or every deploy fails its health check.`;
  }
  if (/\.enableVersioning\(/.test(mainSrc.code)) {
    checks.push(
      `${main} enables API versioning: if it sets a default version, mark HealthController with @Version(VERSION_NEUTRAL) so it still answers ${input.healthPath}.`,
    );
  }
  return {
    action: "write",
    framework: "NestJS",
    files: [
      { path: controller, content, created: true },
      { path: moduleFile, content: applyInsertions(moduleText, insertions), created: false },
    ],
    path: controller,
    note: `${createdNote(controller, input.healthPath)} Registered in ${moduleFile}.`,
    checks,
    ...(pathNote === undefined ? {} : { pathNote }),
  };
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
