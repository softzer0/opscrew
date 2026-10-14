/**
 * The deterministic health routes (FR-816): one edit per framework family, chosen from the app's
 * deploy stack and dependencies. Every edit adds `GET <plan's health path>` answering 200 with
 * `{"status":"ok"}` and touching no database, cache, session or auth, only where OpsCrew can tell
 * unambiguously where it goes; anything else is left to the Code-change agent with the reason.
 */
import { packageDependencies, SIMPLE_PATH } from "./common";
import { djangoHealthRoute } from "./django";
import { fileHealthRoute, fileRoutedFramework } from "./files";
import { adonisHealthRoute, nestHealthRoute } from "./nest";
import { nodeHealthRoute } from "./node";
import { pythonHealthRoute } from "./python";
import { type HealthEdit, type HealthRouteInput, manual } from "./types";

export type { HealthEdit, HealthFile, HealthRepo, HealthRouteInput } from "./types";

/** Frameworks whose app object OpsCrew finds in code, for the message when it finds none. */
const PYTHON_FRAMEWORKS =
  "FastAPI, Flask, Quart, Starlette, Litestar, Sanic, Falcon, aiohttp, Bottle, Tornado or Pyramid";
const NODE_FRAMEWORKS = "Express, Fastify, Hono, Koa, Elysia, Hapi or Restify";

/**
 * What OpsCrew does about the plan's health route: a new file for file-routed frameworks
 * (Next.js, Nuxt, SvelteKit, Astro, Remix, React Router, SolidStart), a `HealthController` for
 * NestJS, a route in `start/routes.ts` for AdonisJS, a view in the root URLconf for Django, and
 * for the other Python and Node.js frameworks a route right after the one app object is created.
 * `none` when a route for the path exists, `manual` (with the reason) when OpsCrew cannot tell.
 * It never throws: a file it cannot read leaves the route to the Code-change agent.
 */
export async function healthRouteEdit(input: HealthRouteInput): Promise<HealthEdit> {
  try {
    return await chooseEdit(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return manual(`OpsCrew could not read the app's code to add the route (${message}).`);
  }
}

async function chooseEdit(input: HealthRouteInput): Promise<HealthEdit> {
  const { stack, healthPath, facts } = input;
  if (stack === "nextjs") return fileHealthRoute(input, "next");
  if (stack === "static-spa") {
    return manual("the app is served as static files, so there is no server to add a route to.");
  }
  if (healthPath === "/" || !SIMPLE_PATH.test(healthPath)) {
    return manual(
      `the plan checks ${healthPath}, and OpsCrew only adds a plain path such as /health itself.`,
    );
  }
  const languages = new Set<string>(facts.languages);
  const names = new Set(facts.frameworks.map((framework) => framework.name));
  const javascript = languages.has("javascript") || languages.has("typescript");
  const python =
    stack === "fastapi" || stack === "django" || (stack === "generic" && languages.has("python"));
  const node = stack === "node-server" || (stack === "generic" && javascript);

  if (node) {
    const routed = await fileRoutedFramework(input);
    if (routed !== undefined && routed !== "next") return fileHealthRoute(input, routed);
    const deps = await packageDependencies(input.repo, facts);
    if (names.has("nestjs") || deps.has("@nestjs/core")) {
      const nest = await nestHealthRoute(input);
      if (nest !== undefined) return nest;
    }
    if (deps.has("@adonisjs/core")) return adonisHealthRoute(input);
  }
  if (stack === "django" || (python && names.has("django"))) return djangoHealthRoute(input);

  const found: HealthEdit[] = [];
  if (python) {
    const edit = await pythonHealthRoute(input);
    if (edit !== undefined) found.push(edit);
  }
  if (node) {
    const edit = await nodeHealthRoute(input);
    if (edit !== undefined) found.push(edit);
  }
  if (found.length === 1) return found[0] as HealthEdit;
  if (found.length > 1) {
    return manual(
      "OpsCrew found both a Python and a Node.js app object, so it cannot tell which one serves the app.",
    );
  }
  const known = [python ? PYTHON_FRAMEWORKS : "", node ? NODE_FRAMEWORKS : ""]
    .filter((list) => list !== "")
    .join(", or ");
  return manual(
    known === ""
      ? "OpsCrew adds health routes itself only for the Python and Node.js frameworks it knows."
      : `OpsCrew found no ${known} app object in the app's code (it may be created in another module or package), so it cannot tell where the route belongs.`,
  );
}
