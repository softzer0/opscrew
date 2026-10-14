import { nextBasePath } from "./next-config";

/** Health path OpsCrew's plans use for Next.js apps (`healthRouteFor` in design). */
export const NEXT_HEALTH_PATH = "/api/health";

/** What OpsCrew does about the Next.js health route. */
export type HealthRouteEdit =
  | {
      action: "write";
      /** Repo-relative file to create (the plan's path with the project's extension). */
      path: string;
      content: string;
      note: string;
      /** Middleware (or Next.js 16 `proxy`) file that might redirect or protect the path. */
      middleware?: string;
      /** Set when the Next.js config sets `basePath`: what the plan's health path must become. */
      basePathNote?: string;
    }
  /** A route for the path already exists. */
  | { action: "none"; reason: string; basePathNote?: string }
  /** OpsCrew cannot tell safely where the route goes; the agent or the user adds it. */
  | { action: "manual"; reason: string };

export interface NextHealthRouteInput {
  /** The plan's health-endpoint path (repo-relative), e.g. `app/api/health/route.ts`. */
  path: string;
  /** The plan's health check path. */
  healthPath: string;
  /** Whether a repo-relative file or folder exists. */
  exists: (path: string) => Promise<boolean>;
  /**
   * Names of the sub-folders of a repo-relative folder (`[]` when it is missing), used to find a
   * route inside route groups such as `app/(api)/api/health/route.ts`. Without it, route groups
   * are not searched.
   */
  folders?: (path: string) => Promise<string[]>;
  /**
   * Content of a repo-relative file, or undefined when it is missing; used to read the Next.js
   * config's `basePath`. Without it, `basePath` is not checked.
   */
  read?: (path: string) => Promise<string | undefined>;
}

const NEXT_CONFIGS = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"];

/**
 * A note when the app's Next.js config sets `basePath`: the route then answers at
 * `<basePath>/api/health`, so the plan's `/api/health` check fails until the plan names that path.
 * OpsCrew does not edit the plan from adapt.
 */
async function basePathNote(
  read: NextHealthRouteInput["read"],
  at: (path: string) => string,
): Promise<string | undefined> {
  if (read === undefined) return undefined;
  const fix = "run `opscrew design` and set it, or edit app.healthPath in `opscrew/plan.yaml`";
  for (const name of NEXT_CONFIGS) {
    const file = at(name);
    const content = await read(file);
    if (content === undefined) continue;
    const scan = nextBasePath(file, content);
    if (scan.kind === "literal") {
      const path = `${scan.value.replace(/\/+$/, "")}${NEXT_HEALTH_PATH}`;
      return `${file} sets basePath "${scan.value}", so the health route answers at ${path}, not ${NEXT_HEALTH_PATH}: the plan's health check path must be ${path} (${fix}), or every deploy fails its health check.`;
    }
    if (scan.kind === "unknown") {
      return `${file} mentions basePath in a way OpsCrew cannot read: if it sets one, the health route answers at <basePath>${NEXT_HEALTH_PATH} and the plan's health check path must be that (${fix}), or every deploy fails its health check.`;
    }
  }
  return undefined;
}

/** How deep OpsCrew looks below `app/` for a route inside route groups. */
const MAX_GROUP_DEPTH = 8;

/** A route group folder, `(name)`: it organises routes without adding a URL segment. */
const ROUTE_GROUP = /^\([^()]+\)$/;

/**
 * The first `route.*` or `page.*` file under `appDir` that answers `/api/health` through route
 * groups (`(group)` folders are skipped in the URL), searched at most {@link MAX_GROUP_DEPTH}
 * folders deep, never inside `node_modules` or hidden folders.
 */
async function routeInGroups(
  input: NextHealthRouteInput,
  appDir: string,
): Promise<string | undefined> {
  const folders = input.folders;
  if (folders === undefined) return undefined;
  const walk = async (dir: string, rest: string[], depth: number): Promise<string | undefined> => {
    if (rest.length === 0) {
      for (const name of ["route", "page"]) {
        for (const ext of EXTENSIONS) {
          const file = `${dir}/${name}.${ext}`;
          if (await input.exists(file)) return file;
        }
      }
    }
    if (depth >= MAX_GROUP_DEPTH) return undefined;
    for (const child of await folders(dir)) {
      if (child === "node_modules" || child.startsWith(".")) continue;
      const next = ROUTE_GROUP.test(child) ? rest : child === rest[0] ? rest.slice(1) : undefined;
      if (next === undefined) continue;
      const found = await walk(`${dir}/${child}`, next, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return walk(appDir, ["api", "health"], 0);
}

/** `<appDir>/` + optional `src/` + router + the route file for `/api/health`. */
const ROUTE_PATH =
  /^(?:(?<dir>.+)\/)?(?<src>src\/)?(?:(?<app>app)\/api\/health\/route|(?<pages>pages)\/api\/health)\.[cm]?[jt]sx?$/;

/**
 * The `basePath` the Next.js config of the app at the plan's route path sets as a plain string,
 * with that config file; undefined when it sets none or one OpsCrew cannot read.
 */
export async function nextLiteralBasePath(
  path: string,
  read: (path: string) => Promise<string | undefined>,
): Promise<{ file: string; value: string } | undefined> {
  const match = ROUTE_PATH.exec(path);
  if (match?.groups === undefined) return undefined;
  let { dir, src = "" } = match.groups;
  if (src === "" && dir !== undefined && (dir === "src" || dir.endsWith("/src"))) {
    dir = dir === "src" ? undefined : dir.slice(0, -"/src".length);
  }
  for (const name of NEXT_CONFIGS) {
    const file = dir === undefined ? name : `${dir}/${name}`;
    const content = await read(file);
    if (content === undefined) continue;
    const scan = nextBasePath(file, content);
    if (scan.kind === "literal") return { file, value: scan.value };
    if (scan.kind === "unknown") return undefined;
  }
  return undefined;
}

const EXTENSIONS = ["ts", "tsx", "js", "jsx"];

/**
 * The app router route, the same in TypeScript and JavaScript. `NextResponse.json` type-checks on
 * every TypeScript version `next build` accepts (`Response.json` needs TypeScript 5.2), and no
 * `dynamic` export: it is a build error with `cacheComponents` (Next.js 16), and a static 200 from
 * the running server is all the health check needs.
 */
const APP_ROUTE = `import { NextResponse } from "next/server";

/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */
export function GET() {
  return NextResponse.json({ status: "ok" });
}
`;

const PAGES_ROUTE_TS = `import type { NextApiRequest, NextApiResponse } from "next";

/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.status(200).json({ status: "ok" });
}
`;

const PAGES_ROUTE_JS = `/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */
export default function handler(_req, res) {
  res.status(200).json({ status: "ok" });
}
`;

/**
 * The deterministic Next.js health route: a new file (never an edit), created only when the plan
 * checks `/api/health`, no route for that path exists in either router (nor inside app router
 * route groups, when `folders` is given), and the router the plan
 * names is the one Next.js uses (its folder exists, and `src/` is not shadowed by a root `app/` or
 * `pages/`). TypeScript when the app has `tsconfig.json`, JavaScript otherwise.
 */
export async function nextHealthRoute(input: NextHealthRouteInput): Promise<HealthRouteEdit> {
  if (input.healthPath !== NEXT_HEALTH_PATH) {
    return {
      action: "manual",
      reason: `the plan checks ${input.healthPath}, and OpsCrew only creates ${NEXT_HEALTH_PATH} itself.`,
    };
  }
  const match = ROUTE_PATH.exec(input.path);
  if (match?.groups === undefined) {
    return {
      action: "manual",
      reason: `OpsCrew only creates the route as app/api/health/route.ts or pages/api/health.ts, not ${input.path}.`,
    };
  }
  // `src/` belongs to the app (the Next.js src layout), never to the folder the app lives in.
  let { dir, src = "" } = match.groups;
  if (src === "" && dir !== undefined && (dir === "src" || dir.endsWith("/src"))) {
    src = "src/";
    dir = dir === "src" ? undefined : dir.slice(0, -"/src".length);
  }
  const app = match.groups.app;
  const at = (path: string) => (dir === undefined ? path : `${dir}/${path}`);
  const note = await basePathNote(input.read, at);
  const withNote = note === undefined ? {} : { basePathNote: note };

  for (const base of ["", "src/"]) {
    for (const ext of EXTENSIONS) {
      for (const file of [
        `app/api/health/route.${ext}`,
        `app/api/health/page.${ext}`,
        `pages/api/health.${ext}`,
        `pages/api/health/index.${ext}`,
      ]) {
        const existing = at(`${base}${file}`);
        if (await input.exists(existing)) {
          return {
            action: "none",
            reason: `${existing} already answers ${NEXT_HEALTH_PATH}; OpsCrew left it as it is.`,
            ...withNote,
          };
        }
      }
    }
    const grouped = await routeInGroups(input, at(`${base}app`));
    if (grouped !== undefined) {
      return {
        action: "none",
        reason: `${grouped} already answers ${NEXT_HEALTH_PATH}; OpsCrew left it as it is.`,
        ...withNote,
      };
    }
  }

  const router = app === undefined ? "pages" : "app";
  if (src !== "" && ((await input.exists(at("app"))) || (await input.exists(at("pages"))))) {
    return {
      action: "manual",
      reason: `the app has an app/ or pages/ folder next to src/, so Next.js ignores src/${router}/ and OpsCrew cannot tell where the route belongs.`,
    };
  }
  if (!(await input.exists(at(`${src}${router}`)))) {
    return {
      action: "manual",
      reason: `the app has no ${src}${router}/ folder, so OpsCrew cannot tell which Next.js router it uses.`,
    };
  }

  const ts = await input.exists(at("tsconfig.json"));
  const ext = ts ? "ts" : "js";
  const path = at(
    router === "app" ? `${src}app/api/health/route.${ext}` : `${src}pages/api/health.${ext}`,
  );
  const content = router === "app" ? APP_ROUTE : ts ? PAGES_ROUTE_TS : PAGES_ROUTE_JS;
  let middleware: string | undefined;
  for (const name of ["middleware", "proxy"]) {
    for (const ext of ["ts", "js", "mjs"]) {
      const file = at(`${src}${name}.${ext}`);
      if (middleware === undefined && (await input.exists(file))) middleware = file;
    }
  }
  return {
    action: "write",
    path,
    content,
    note: `Created ${path} by OpsCrew: answers GET ${NEXT_HEALTH_PATH} with {"status":"ok"} for the deploy health check.`,
    ...(middleware === undefined ? {} : { middleware }),
    ...withNote,
  };
}
