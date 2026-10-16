import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  type AppKind,
  type EnvUrlScheme,
  type Language,
  type ProjectFacts,
  ProjectFactsSchema,
} from "@opscrew/plan-schema";
import { normalizeAppDir, unknownAppDirError } from "./app-dir";
import {
  composeUsesRedis,
  envFileSchemes,
  isCommittedEnvFile,
  isComposeFile,
  prefixedConfigNames,
} from "./connections";
import { isClientExposed, isEnvExampleFile, isSecretLikely, parseEnvExampleKeys } from "./env";
import { listProjectFiles } from "./files";
import {
  type AppKindHints,
  appKindOf,
  type DetectedFramework,
  defaultPort,
  detectFrameworks,
  effectiveRoles,
  type FrameworkRole,
  hasAstroAdapter,
  isServerUnit,
} from "./frameworks";
import { readGitInfo } from "./git";
import {
  findDependency,
  matchesWorkspace,
  parseJson,
  type ReadText,
  readUnits,
  stripBom,
  type Unit,
  workspacePatterns,
} from "./manifests";
import {
  basenameRel,
  depthOf,
  dirnameRel,
  isWithin,
  joinRel,
  relativeTo,
  sortStrings,
  toFsPath,
  uniqueSorted,
} from "./paths";
import { detectPlatform } from "./platform";
import { detectRelease } from "./release";
import { byDepth, inFolder } from "./release/context";
import {
  addDependencyServices,
  addDjangoServices,
  addEnvServices,
  addPrismaServices,
  ServiceCollector,
} from "./services";
import {
  BUILT_IN_HEALTH_FILES,
  builtInHealthEndpoint,
  healthRouteFromPath,
  isAppCodeFile,
  isSourceFile,
  nestRoutePath,
  nextBasePathLiteral,
  portsInCommand,
  pythonModule,
  type SourceSignals,
  scanSource,
} from "./sources";

/** Options for {@link detectProject}. */
export interface DetectOptions {
  /** Maximum number of files to inspect (default 20,000). */
  maxFiles?: number;
  /**
   * Repo-relative directory of the app to describe (a workspace member, a detected subdirectory
   * app, or `.` for the root). Trailing slashes, `./` prefixes and backslashes are accepted. When
   * set, `appCandidates` is empty and other deployable apps are left out of the facts. An unknown
   * directory throws an `OpsCrewError` (`INVALID_INPUT`) listing the candidates.
   */
  appDir?: string;
}

/** Full detection result: the facts plus context the caller may turn into warnings or risks. */
export interface ProjectDetection {
  facts: ProjectFacts;
  /** Repo-relative directory of the app the facts describe (`.` for the root). */
  appDir: string;
  /**
   * Directories of deployable apps when several qualify (monorepos); the facts then describe the
   * repository root and the interview should ask which one to deploy. Empty otherwise.
   */
  appCandidates: string[];
  /** True when the file walk stopped at `maxFiles`; detection may be incomplete. */
  truncated: boolean;
}

interface UnitInfo {
  unit: Unit;
  frameworks: DetectedFramework[];
  hints: AppKindHints;
  roles: Set<FrameworkRole>;
  appKind: AppKind;
  /** The unit's `next.config.*` text, read when it uses Next.js. */
  nextConfig: string | undefined;
  /** The unit's `astro.config.*` text, read when it uses Astro. */
  astroConfig: string | undefined;
}

const NEXT_CONFIG = /^next\.config\.[cm]?[jt]s$/;
const ASTRO_CONFIG = /^astro\.config\.[cm]?[jt]s$/;

type JsPackageManager = "npm" | "pnpm" | "yarn" | "bun";
type PyPackageManager = "pip" | "poetry" | "uv" | "pipenv";

const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  go: "go",
  rb: "ruby",
  php: "php",
  java: "java",
  rs: "rust",
  cs: "other",
  kt: "other",
  swift: "other",
  scala: "other",
  ex: "other",
  exs: "other",
  dart: "other",
};

const PYTHON_SERVER_FRAMEWORKS = new Set(["fastapi", "flask", "django"]);

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return line || undefined;
}

function detectLanguages(files: readonly string[], units: readonly Unit[]): Language[] {
  const languages = new Set<Language>();
  for (const file of files) {
    const name = basenameRel(file);
    // Tool configuration (vite.config.js, .eslintrc.cjs) does not define the app's language.
    if (/\.config\.[cm]?[jt]s$/.test(name) || /^\.[\w-]+rc\.[cm]?js$/.test(name)) continue;
    const dot = name.lastIndexOf(".");
    const language = dot > 0 ? LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] : undefined;
    if (language) languages.add(language);
  }
  for (const unit of units) {
    const names = new Set(unit.manifests.map(basenameRel));
    if (unit.packageJson && !languages.has("typescript")) languages.add("javascript");
    if (unit.python) languages.add("python");
    if (names.has("Gemfile")) languages.add("ruby");
    if (names.has("composer.json")) languages.add("php");
    if (names.has("go.mod")) languages.add("go");
    if (names.has("Cargo.toml")) languages.add("rust");
  }
  return sortStrings(languages) as Language[];
}

function jsInstallCommand(pm: JsPackageManager, locked: boolean, berry: boolean): string {
  switch (pm) {
    case "npm":
      return locked ? "npm ci" : "npm install";
    case "pnpm":
      return locked ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn":
      if (berry) return locked ? "yarn install --immutable" : "yarn install";
      return locked ? "yarn install --frozen-lockfile" : "yarn install";
    case "bun":
      return locked ? "bun install --frozen-lockfile" : "bun install";
  }
}

function jsExec(pm: JsPackageManager): string {
  return { npm: "npx", pnpm: "pnpm exec", yarn: "yarn", bun: "bunx" }[pm];
}

/** Scripts that start the built app for production, preferred over `start`. */
const PRODUCTION_SCRIPTS = ["start:prod", "start:production"] as const;

/**
 * A `start` script that compiles, watches or runs TypeScript at boot. Such a script fails in the
 * image (the non-root user cannot rewrite the build output) or needs dev dependencies.
 */
const DEV_RUNNER = /(?:^|[\s;&|])(?:nest\s+start|ts-node(?:-dev)?|tsx|nodemon)\b|--watch\b/;

/**
 * The built entry point to run instead of a dev-runner `start`: `node dist/main` for `nest start`
 * with a build script (Nest's default output), else `node <main>` when `main` names a JavaScript
 * file outside `src/`. Undefined when neither can be inferred.
 */
function builtEntryPoint(
  scripts: Record<string, string>,
  main: string | undefined,
): string | undefined {
  if (/\bnest\s+start\b/.test(scripts.start ?? "") && scripts.build) return "node dist/main";
  const entry = main?.replace(/^\.\//, "");
  if (entry && /\.[cm]?js$/.test(entry) && !entry.startsWith("src/")) return `node ${entry}`;
  return undefined;
}

/** `pm run <script>` (or the workspace-filtered form for a monorepo member). */
function jsRun(pm: JsPackageManager, script: string, member?: { name: string; dir: string }) {
  const start = script === "start";
  if (member) {
    switch (pm) {
      case "pnpm":
        return `pnpm --filter ${member.name} ${start ? "start" : `run ${script}`}`;
      case "npm":
        return `npm ${start ? "start" : `run ${script}`} --workspace=${member.dir}`;
      case "yarn":
        return `yarn workspace ${member.name} ${start ? "start" : `run ${script}`}`;
      case "bun":
        return `bun run --filter ${member.name} ${script}`;
    }
  }
  if (start) return pm === "bun" ? "bun run start" : `${pm} start`;
  return `${pm} run ${script}`;
}

/** Detects repository facts and returns them with the app directory and monorepo candidates. */
export async function detectProjectDetails(
  root: string,
  options: DetectOptions = {},
): Promise<ProjectDetection> {
  const absRoot = resolve(root);
  const listing = await listProjectFiles(
    absRoot,
    options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles },
  );
  const files = listing.files;
  const fileSet = new Set(files);
  // Only files that survived the walk (ignore rules, size limit) are ever read.
  const read: ReadText = async (path) => {
    if (!fileSet.has(path)) return undefined;
    try {
      return stripBom(await readFile(toFsPath(absRoot, path), "utf8"));
    } catch {
      return undefined;
    }
  };
  const filesIn = (dir: string, test: (name: string) => boolean) =>
    files.filter((file) => dirnameRel(file) === dir && test(basenameRel(file)));

  const [git, units] = await Promise.all([readGitInfo(absRoot), readUnits(files, read)]);

  // Per-unit frameworks and app kind.
  const infos: UnitInfo[] = [];
  for (const unit of units) {
    const frameworks = detectFrameworks(unit);
    const names = new Set(frameworks.map((f) => f.name));
    const nextConfig = names.has("next")
      ? await read(filesIn(unit.dir, (n) => NEXT_CONFIG.test(n))[0] ?? "")
      : undefined;
    const astroConfig = names.has("astro")
      ? await read(filesIn(unit.dir, (n) => ASTRO_CONFIG.test(n))[0] ?? "")
      : undefined;
    const hints: AppKindHints = {
      nextStaticExport: /\boutput\s*:\s*["'`]export["'`]/.test(nextConfig ?? ""),
      astroServer:
        hasAstroAdapter(unit) ||
        /\badapter\s*:|\boutput\s*:\s*["'`](?:server|hybrid)["'`]/.test(astroConfig ?? ""),
      djangoTemplates: files.some(
        (file) =>
          isWithin(unit.dir, file) &&
          /(?:^|\/)templates\/.+\.html?$/i.test(relativeTo(unit.dir, file)),
      ),
    };
    infos.push({
      unit,
      frameworks,
      hints,
      roles: effectiveRoles(unit, frameworks, hints),
      appKind: appKindOf(unit, frameworks, hints),
      nextConfig,
      astroConfig,
    });
  }
  const rootInfo = infos.find((info) => info.unit.dir === ".");
  const rootPackage = rootInfo?.unit.packageJson;

  // Monorepo layout and the deployable app.
  const monorepo =
    rootPackage?.workspaces !== undefined ||
    ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"].some((f) => fileSet.has(f));
  let patterns = workspacePatterns(
    rootPackage,
    await read("pnpm-workspace.yaml"),
    await read("lerna.json"),
  );
  if (monorepo && patterns.length === 0) patterns = ["apps/*", "packages/*"];
  const nested = infos.filter((info) => info.unit.dir !== ".");
  const members = monorepo
    ? nested.filter((info) => matchesWorkspace(info.unit.dir, patterns))
    : nested;
  let deployable = members.filter((info) => isServerUnit(info.unit, info.roles));
  if (deployable.length === 0) deployable = members.filter((info) => info.appKind !== "unknown");
  const deployableDirs = deployable.map((info) => info.unit.dir);

  let primary: UnitInfo | undefined;
  let appCandidates: string[] = [];
  // Other apps left out of the facts when the caller chose one app explicitly.
  let otherApps: string[] = [];
  if (options.appDir !== undefined) {
    const wanted = normalizeAppDir(options.appDir);
    if (wanted === ".") {
      primary = rootInfo;
    } else {
      primary = members.find((info) => info.unit.dir === wanted);
      if (!primary) throw unknownAppDirError(options.appDir, deployableDirs);
      otherApps = deployableDirs.filter((dir) => dir !== wanted && !isWithin(dir, wanted));
    }
  } else if (!monorepo && rootInfo) {
    primary = rootInfo;
  } else if (deployable.length === 1) {
    primary = deployable[0];
  } else {
    primary = rootInfo;
    appCandidates = deployableDirs;
  }
  const inScope = (path: string) => !otherApps.some((dir) => isWithin(dir, path));
  const scopedFiles = otherApps.length > 0 ? files.filter(inScope) : files;
  const scopedMembers = members.filter((info) => inScope(info.unit.dir));
  const relevant = rootInfo ? [rootInfo, ...scopedMembers] : scopedMembers;
  const appDir = primary?.unit.dir ?? ".";
  const appPackage = primary?.unit.packageJson;
  const appKind: AppKind = primary?.appKind ?? "unknown";
  const appFrameworkNames = new Set(primary?.frameworks.map((f) => f.name) ?? []);
  const searchDirs = uniqueSorted([appDir, "."]).sort((a, b) => depthOf(b) - depthOf(a));
  const findIn = (name: string) =>
    searchDirs.map((dir) => joinRel(dir, name)).find((p) => fileSet.has(p));

  // Source signals (env names, ports, health routes, Python app objects, URL schemes).
  const signals = new Map<string, SourceSignals>();
  await mapLimit(scopedFiles.filter(isSourceFile), 16, async (file) => {
    const text = await read(file);
    if (text !== undefined) signals.set(file, scanSource(text));
  });

  const { envVars, configUrlSchemes } = await collectEnvVars(
    signals,
    scopedFiles.filter(isCommittedEnvFile),
    read,
  );
  let composeRedis = false;
  for (const file of scopedFiles.filter(isComposeFile)) {
    if (composeUsesRedis((await read(file)) ?? "")) composeRedis = true;
  }

  // Services.
  const pythonUrlSchemes = new Set<string>();
  for (const [file, found] of signals) {
    if (file.endsWith(".py")) for (const scheme of found.urlSchemes) pythonUrlSchemes.add(scheme);
  }
  const services = new ServiceCollector();
  for (const info of relevant) {
    addDependencyServices(services, info.unit, {
      pythonUrlSchemes,
      configUrlSchemes,
      composeRedis,
    });
  }
  for (const file of scopedFiles.filter((f) => f.endsWith(".prisma"))) {
    addPrismaServices(
      services,
      (await read(file)) ?? "",
      relevant.map((info) => info.unit),
    );
  }
  const settingsFiles = scopedFiles.filter((f) => /(?:^|\/)settings(?:\.py|\/[^/]+\.py)$/.test(f));
  const settingsTexts = new Map<string, string>();
  for (const file of settingsFiles) {
    const text = (await read(file)) ?? "";
    settingsTexts.set(file, text);
    addDjangoServices(services, text);
  }
  addEnvServices(
    services,
    envVars.map((envVar) => envVar.name),
  );

  // Platform fingerprints.
  const platformUnits = [...new Set([rootInfo?.unit, primary?.unit])].filter(
    (unit): unit is Unit => unit !== undefined,
  );
  const readmePath = searchDirs
    .slice()
    .reverse()
    .map((dir) => filesIn(dir, (n) => /^readme(?:\.md|\.markdown|\.txt)?$/i.test(n))[0])
    .find(Boolean);
  const indexHtmlPath = findIn("index.html");
  const markers = new Set<string>();
  for (const marker of [".bolt", ".replit", "replit.nix"]) {
    if (await exists(toFsPath(absRoot, marker))) markers.add(marker);
  }
  if (findIn("components.json")) markers.add("components.json");
  const readmeText = readmePath ? await read(readmePath) : undefined;
  const indexHtmlText = indexHtmlPath ? await read(indexHtmlPath) : undefined;
  const platform = detectPlatform({
    dependencies: platformUnits.flatMap((unit) => unit.dependencies),
    packageNames: platformUnits.flatMap((unit) =>
      unit.packageJson?.name ? [unit.packageJson.name] : [],
    ),
    ...(readmePath && readmeText !== undefined
      ? { readme: { path: readmePath, text: readmeText } }
      : {}),
    ...(indexHtmlPath && indexHtmlText !== undefined
      ? { indexHtml: { path: indexHtmlPath, text: indexHtmlText } }
      : {}),
    markers,
  });

  // Docker files.
  const pickFile = (exact: string[], loose?: (name: string) => boolean): string | undefined => {
    for (const dir of searchDirs) {
      for (const name of exact) if (fileSet.has(joinRel(dir, name))) return joinRel(dir, name);
    }
    if (!loose) return undefined;
    return scopedFiles.filter((f) => loose(basenameRel(f))).sort(byDepth)[0];
  };
  const dockerfile = pickFile(
    ["Dockerfile"],
    (n) => /^dockerfile(?:\.[\w-]+)?$/i.test(n) || /\.dockerfile$/i.test(n),
  );
  const composeNames = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
  const compose = pickFile(composeNames, (n) => composeNames.includes(n));
  const dockerignore = pickFile([".dockerignore"]);

  // Package manager and install command.
  const usePython =
    [...appFrameworkNames].some((name) => PYTHON_SERVER_FRAMEWORKS.has(name)) ||
    (Boolean(primary?.unit.python) && !appPackage) ||
    (!primary && !rootPackage && infos.some((info) => info.unit.python));
  const hasJs = Boolean(appPackage ?? rootPackage);
  const ecosystem: "js" | "python" | "none" = usePython
    ? "python"
    : hasJs
      ? "js"
      : infos.some((info) => info.unit.python)
        ? "python"
        : "none";
  const cdPrefix = (command: string) => inFolder(appDir, command);

  let packageManager: ProjectFacts["packageManager"] = "none";
  const build: ProjectFacts["build"] = {};
  let jsPm: JsPackageManager | undefined;
  let member: { name: string; dir: string } | undefined;
  if (ecosystem === "js") {
    const declared = [appPackage?.packageManager, rootPackage?.packageManager]
      .map((value) => /^(npm|pnpm|yarn|bun)@(\d+)?/.exec(value ?? ""))
      .find(Boolean);
    const lockOf: Record<JsPackageManager, string[]> = {
      pnpm: ["pnpm-lock.yaml"],
      yarn: ["yarn.lock"],
      bun: ["bun.lock", "bun.lockb"],
      npm: ["package-lock.json", "npm-shrinkwrap.json"],
    };
    const hasLock = (pm: JsPackageManager) => lockOf[pm].some((name) => findIn(name));
    jsPm =
      (declared?.[1] as JsPackageManager | undefined) ??
      (["pnpm", "yarn", "bun", "npm"] as const).find(hasLock) ??
      "npm";
    const berry =
      jsPm === "yarn" && (Boolean(findIn(".yarnrc.yml")) || Number(declared?.[2] ?? 1) >= 2);
    packageManager = jsPm;
    const install = jsInstallCommand(jsPm, hasLock(jsPm), berry);
    if (monorepo && appDir !== ".") {
      member = { name: appPackage?.name ?? appDir, dir: appDir };
      build.installCommand = install;
    } else {
      build.installCommand = cdPrefix(install);
    }
  } else if (ecosystem === "python") {
    const python = primary?.unit.python ?? rootInfo?.unit.python;
    const pm: PyPackageManager = findIn("uv.lock")
      ? "uv"
      : findIn("poetry.lock") || python?.usesPoetry
        ? "poetry"
        : findIn("Pipfile")
          ? "pipenv"
          : "pip";
    packageManager = pm;
    const requirements = fileSet.has(joinRel(appDir, "requirements.txt"));
    const install = {
      uv: "uv sync --frozen",
      poetry: "poetry install --no-root",
      pipenv: findIn("Pipfile.lock") ? "pipenv install --deploy" : "pipenv install",
      pip: requirements
        ? "pip install -r requirements.txt"
        : fileSet.has(joinRel(appDir, "pyproject.toml"))
          ? "pip install ."
          : undefined,
    }[pm];
    if (install) build.installCommand = cdPrefix(install);
  }

  // Build command, start command and port.
  const scripts = appPackage?.scripts ?? {};
  if (jsPm && scripts.build) {
    const command = jsRun(jsPm, "build", member);
    build.buildCommand = member ? command : cdPrefix(command);
  }
  const procfile = await read(joinRel(appDir, "Procfile"));
  const procfileWeb = /^web:\s*(.+)$/m.exec(procfile ?? "")?.[1]?.trim();
  const appCode = scopedFiles.filter(
    (f) => isWithin(appDir, f) && isAppCodeFile(relativeTo(appDir, f)),
  );
  const dockerText = dockerfile ? await read(dockerfile) : undefined;
  const explicitPort = [
    scripts["start:prod"],
    scripts["start:production"],
    scripts.start,
    procfileWeb,
  ]
    .flatMap((command) => (command ? portsInCommand(command) : []))
    .at(0);
  const exposedPort = Number(/^\s*EXPOSE\s+(\d{1,5})\b/im.exec(dockerText ?? "")?.[1]) || undefined;
  const sourcePort = appCode.flatMap((f) => signals.get(f)?.ports ?? []).at(0);
  const servesHttp = appKind !== "static-spa" && appKind !== "worker";
  const port = servesHttp
    ? (explicitPort ??
      (exposedPort && exposedPort <= 65535 ? exposedPort : undefined) ??
      sourcePort ??
      defaultPort(primary?.frameworks ?? []))
    : undefined;

  const notes: string[] = [];
  if (appKind !== "static-spa") {
    let start: string | undefined;
    const hasNpmDependency = (name: string) =>
      Boolean(primary && findDependency(primary.unit, "npm", name));
    const prodScript = PRODUCTION_SCRIPTS.find((name) => scripts[name]);
    const builtEntry =
      scripts.start && DEV_RUNNER.test(scripts.start)
        ? builtEntryPoint(scripts, appPackage?.main)
        : undefined;
    if (jsPm && prodScript) {
      start = member ? jsRun(jsPm, prodScript, member) : cdPrefix(jsRun(jsPm, prodScript));
    } else if (jsPm && builtEntry) {
      start = cdPrefix(builtEntry);
    } else if (jsPm && scripts.start) {
      start = member ? jsRun(jsPm, "start", member) : cdPrefix(jsRun(jsPm, "start"));
    } else if (procfileWeb) {
      start = cdPrefix(procfileWeb);
    } else if (ecosystem === "python" && port) {
      start = pythonStartCommand(appFrameworkNames, appDir, appCode, signals, settingsTexts, port);
      if (start) start = cdPrefix(start);
    } else if (jsPm && appFrameworkNames.has("next")) {
      start = cdPrefix(`${jsExec(jsPm)} next start`);
    } else if (jsPm && appFrameworkNames.has("nuxt")) {
      start = cdPrefix("node .output/server/index.mjs");
    } else if (
      jsPm &&
      appFrameworkNames.has("sveltekit") &&
      hasNpmDependency("@sveltejs/adapter-node")
    ) {
      start = cdPrefix("node build");
    } else if (
      jsPm &&
      appFrameworkNames.has("astro") &&
      hasNpmDependency("@astrojs/node") &&
      !/\bmode\s*:\s*["'`]middleware["'`]/.test(primary?.astroConfig ?? "")
    ) {
      start = cdPrefix("node ./dist/server/entry.mjs");
    } else if (appPackage?.main && primary?.roles.has("server")) {
      start = cdPrefix(`node ${appPackage.main}`);
    }
    // Redwood: the api side is built and served with the Redwood CLI from the project root.
    const redwoodToml = appFrameworkNames.has("redwood")
      ? scopedFiles
          .filter((f) => basenameRel(f) === "redwood.toml" && isWithin(dirnameRel(f), appDir))
          .sort((a, b) => depthOf(b) - depthOf(a))[0]
      : undefined;
    if (redwoodToml) {
      const root = dirnameRel(redwoodToml);
      build.buildCommand ??= inFolder(root, "yarn rw build api");
      start ??= inFolder(root, `yarn rw serve api${port ? ` --port ${port}` : ""}`);
      // Redwood's own Docker setup serves the web side from a second server that proxies API
      // requests to this one; OpsCrew runs one app for now.
      notes.push(
        `This is a Redwood project: OpsCrew deploys only its api side (${appDir}) for now. The web side is not served yet, so the deployed app answers API requests only. Serving both sides arrives with support for apps made of several parts; meanwhile, host the web side's static build (\`yarn rw build web\`, in web/dist) elsewhere and point it at the deployed API.`,
      );
    }
    if (start) build.startCommand = start;
    const pm = jsPm;
    const release = await detectRelease({
      appDir,
      files: scopedFiles,
      procfile,
      flaskenv: await read(joinRel(appDir, ".flaskenv")),
      startCommand: start,
      unit: primary?.unit,
      frameworks: appFrameworkNames,
      ecosystem,
      read,
      ...(pm
        ? {
            runScript: (script: string) =>
              member ? jsRun(pm, script, member) : cdPrefix(jsRun(pm, script)),
          }
        : {}),
    });
    if (release.command) build.releaseCommand = release.command;
    if (release.note) build.releaseNote = release.note;
  } else {
    const output = await staticOutputDir(primary, read, filesIn);
    if (output) build.outputDir = joinRel(appDir, output);
  }

  // Health endpoint: file-system routes and literal route registrations in app code. NestJS
  // controllers answer under the app's global prefix and Next.js routes under its basePath.
  const nestPrefix = appCode
    .map((file) => signals.get(file)?.nestPrefix)
    .find((prefix) => prefix !== undefined);
  const nextBase = nextBasePathLiteral(primary?.nextConfig);
  let healthEndpoint: string | undefined;
  for (const file of appCode) {
    const found = signals.get(file);
    const fromPath = healthRouteFromPath(relativeTo(appDir, file));
    const route = fromPath ?? found?.healthPaths[0];
    if (!route) continue;
    if (fromPath !== undefined) healthEndpoint = `${nextBase ?? ""}${route}`;
    else if (found?.decoratorHealthPaths.includes(route)) {
      healthEndpoint = nestRoutePath(route, nestPrefix) ?? route;
    } else healthEndpoint = route;
    break;
  }
  // Endpoints the framework answers by itself (Rails /up, Laravel /up, Spring Boot Actuator).
  if (healthEndpoint === undefined) {
    const texts: Record<string, string> = {};
    for (const name of BUILT_IN_HEALTH_FILES) {
      const text = await read(joinRel(appDir, name));
      if (text !== undefined) texts[name] = text;
    }
    healthEndpoint = builtInHealthEndpoint(texts);
  }

  // Runtime versions.
  const runtimeVersions: ProjectFacts["runtimeVersions"] = {};
  const nodeVersion =
    firstLine(await read(findIn(".nvmrc") ?? "")) ??
    firstLine(await read(findIn(".node-version") ?? "")) ??
    appPackage?.voltaNode ??
    appPackage?.engineNode ??
    rootPackage?.voltaNode ??
    rootPackage?.engineNode;
  if (nodeVersion) runtimeVersions.node = nodeVersion;
  const python = primary?.unit.python ?? rootInfo?.unit.python;
  const pythonVersion =
    firstLine(await read(findIn(".python-version") ?? "")) ??
    /python-(\S+)/.exec((await read(findIn("runtime.txt") ?? "")) ?? "")?.[1] ??
    python?.requiresPython ??
    python?.pipfilePython;
  if (pythonVersion) runtimeVersions.python = pythonVersion;

  // Frameworks of every relevant unit, sorted by directory then name.
  const frameworks = relevant
    .flatMap((info) =>
      info.frameworks.map((f) => ({
        name: f.name,
        ...(f.version ? { version: f.version } : {}),
        path: info.unit.dir,
      })),
    )
    .sort((a, b) => (a.path === b.path ? (a.name < b.name ? -1 : 1) : a.path < b.path ? -1 : 1));

  const name = (
    rootPackage?.name ??
    rootInfo?.unit.python?.name ??
    appPackage?.name ??
    primary?.unit.python?.name ??
    basename(absRoot)
  ).slice(0, 100);

  const facts: ProjectFacts = {
    name: name || "project",
    languages: detectLanguages(
      scopedFiles,
      units.filter((unit) => inScope(unit.dir)),
    ),
    packageManager,
    frameworks,
    appKind,
    platformExport: platform,
    build,
    ...(port ? { port } : {}),
    runtimeVersions,
    envVars,
    services: services.toList(),
    docker: {
      ...(dockerfile ? { dockerfile } : {}),
      ...(compose ? { compose } : {}),
      ...(dockerignore ? { dockerignore } : {}),
    },
    ...(healthEndpoint ? { healthEndpoint } : {}),
    monorepo,
    // Always set: `.` when the facts describe the repository root.
    appDir,
    ...(notes.length > 0 ? { notes } : {}),
    git,
  };

  const parsed = ProjectFactsSchema.safeParse(facts);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Repository detection produced invalid project facts: ${issues}`);
  }
  return { facts: parsed.data, appDir, appCandidates, truncated: listing.truncated };
}

/**
 * Detects deterministic facts about the repository at `root` (frameworks, app kind, build/start
 * commands, port, environment variables, services, builder platform, Docker files, git). The
 * result is validated with `ProjectFactsSchema` before it is returned.
 */
export async function detectProject(
  root: string,
  options: DetectOptions = {},
): Promise<ProjectFacts> {
  return (await detectProjectDetails(root, options)).facts;
}

/**
 * The app's environment variables: the names the code reads, every name of an example env file,
 * and the names Flask loads by prefix (`app.config.from_prefixed_env()`) from the other committed
 * env files. Values are only looked at for their URL scheme (`configUrlSchemes`, and each
 * variable's `urlScheme`), never kept.
 */
async function collectEnvVars(
  signals: ReadonlyMap<string, SourceSignals>,
  committedEnvFiles: readonly string[],
  read: ReadText,
): Promise<{ envVars: ProjectFacts["envVars"]; configUrlSchemes: Set<string> }> {
  const envFiles = new Map<string, Set<string>>();
  const addEnv = (name: string, file: string) => {
    const set = envFiles.get(name) ?? new Set<string>();
    set.add(file);
    envFiles.set(name, set);
  };
  // A variable has a default only when every read in the code has one; names found only in
  // example env files stay required.
  const envDefaults = new Map<string, boolean>();
  for (const [file, found] of signals) {
    for (const envRead of found.envReads) {
      addEnv(envRead.name, file);
      envDefaults.set(envRead.name, (envDefaults.get(envRead.name) ?? true) && envRead.hasDefault);
    }
  }
  const configPrefixes = new Set<string>();
  for (const found of signals.values()) for (const p of found.configPrefixes) configPrefixes.add(p);
  const configUrlSchemes = new Set<string>();
  // URL kinds per variable; files that disagree make it `other` (the plan then leaves it alone).
  const envSchemes = new Map<string, EnvUrlScheme>();
  for (const file of committedEnvFiles) {
    const text = (await read(file)) ?? "";
    for (const [name, scheme] of envFileSchemes(text)) {
      configUrlSchemes.add(scheme);
      const known = envSchemes.get(name);
      envSchemes.set(name, known === undefined || known === scheme ? scheme : "other");
    }
    const names = parseEnvExampleKeys(text);
    const wanted = isEnvExampleFile(file) ? names : prefixedConfigNames(names, configPrefixes);
    for (const name of wanted) addEnv(name, file);
  }
  const envVars = sortStrings(envFiles.keys()).map((name) => ({
    name,
    files: sortStrings(envFiles.get(name) ?? []),
    clientExposed: isClientExposed(name),
    secretLikely: isSecretLikely(name),
    ...(envDefaults.get(name) === true ? { hasDefault: true } : {}),
    ...(envSchemes.has(name) ? { urlScheme: envSchemes.get(name) } : {}),
  }));
  return { envVars, configUrlSchemes };
}

function pythonStartCommand(
  frameworks: ReadonlySet<string>,
  appDir: string,
  appCode: readonly string[],
  signals: ReadonlyMap<string, SourceSignals>,
  settingsTexts: ReadonlyMap<string, string>,
  port: number,
): string | undefined {
  if (frameworks.has("django")) {
    let wsgi: string | undefined;
    for (const [file, text] of settingsTexts) {
      if (!isWithin(appDir, file)) continue;
      wsgi = /WSGI_APPLICATION\s*=\s*["']([\w.]+)\.application["']/.exec(text)?.[1];
      if (wsgi) break;
    }
    wsgi ??= appCode
      .filter((f) => basenameRel(f) === "wsgi.py")
      .sort(byDepth)
      .map((f) => pythonModule(relativeTo(appDir, f)))[0];
    return wsgi ? `gunicorn ${wsgi}:application --bind 0.0.0.0:${port}` : undefined;
  }
  for (const framework of ["fastapi", "flask"] as const) {
    if (!frameworks.has(framework)) continue;
    const file = appCode
      .filter(
        (f) =>
          f.endsWith(".py") && signals.get(f)?.appObjects.some((o) => o.framework === framework),
      )
      .sort(byDepth)[0];
    const variable = file
      ? signals.get(file)?.appObjects.find((o) => o.framework === framework)?.variable
      : undefined;
    if (!file || !variable) continue;
    const target = `${pythonModule(relativeTo(appDir, file))}:${variable}`;
    return framework === "fastapi"
      ? `uvicorn ${target} --host 0.0.0.0 --port ${port}`
      : `gunicorn ${target} --bind 0.0.0.0:${port}`;
  }
  return undefined;
}

async function staticOutputDir(
  info: UnitInfo | undefined,
  read: ReadText,
  filesIn: (dir: string, test: (name: string) => boolean) => string[],
): Promise<string | undefined> {
  if (!info) return undefined;
  const names = new Set(info.frameworks.map((f) => f.name));
  const dir = info.unit.dir;
  if (names.has("next") && info.hints.nextStaticExport) return "out";
  if (names.has("astro")) return "dist";
  if (names.has("angular")) return angularOutputDir(await read(joinRel(dir, "angular.json")));
  if (names.has("vite")) {
    const config = await read(filesIn(dir, (n) => /^vite\.config\.[cm]?[jt]s$/.test(n))[0] ?? "");
    return (
      /\boutDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(config ?? "")?.[1]?.replace(/^\.\//, "") ?? "dist"
    );
  }
  if (names.has("create-react-app")) return "build";
  return undefined;
}

function angularOutputDir(text: string | undefined): string {
  const data = parseJson(text) as
    | { defaultProject?: unknown; projects?: Record<string, unknown> }
    | undefined;
  const projects = data?.projects && typeof data.projects === "object" ? data.projects : {};
  const project =
    typeof data?.defaultProject === "string" ? data.defaultProject : Object.keys(projects)[0];
  if (!project) return "dist";
  const config = projects[project] as
    | { architect?: Record<string, unknown>; targets?: Record<string, unknown> }
    | undefined;
  const target = (config?.architect?.build ?? config?.targets?.build) as
    | { builder?: unknown; options?: { outputPath?: unknown } }
    | undefined;
  const outputPath = target?.options?.outputPath;
  const base =
    typeof outputPath === "string"
      ? outputPath
      : typeof outputPath === "object" && outputPath && "base" in outputPath
        ? String((outputPath as { base: unknown }).base)
        : `dist/${project}`;
  const builder = typeof target?.builder === "string" ? target.builder : "";
  return /:browser(?:-esbuild)?$/.test(builder) ? base : `${base.replace(/\/+$/, "")}/browser`;
}
