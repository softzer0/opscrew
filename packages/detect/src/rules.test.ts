import { describe, expect, it } from "vitest";
import { matchesWorkspace, parseRequirement, parseRequirementsFile } from "./manifests";
import { healthRouteFromPath, portsInCommand, pythonModule, scanSource } from "./sources";

describe("manifest helpers", () => {
  it("parses PEP 508 requirements", () => {
    expect(parseRequirement("Flask==3.1.0")).toEqual({
      name: "flask",
      version: "3.1.0",
      extras: [],
    });
    expect(parseRequirement("celery[redis,msgpack]>=5 ; python_version > '3'")).toEqual({
      name: "celery",
      version: ">=5",
      extras: ["redis", "msgpack"],
    });
    expect(parseRequirement("Django_REST.framework")).toEqual({
      name: "django-rest-framework",
      extras: [],
    });
  });

  it("skips options, includes and URLs in requirements files", () => {
    const text = "-r base.txt\n--hash x\nhttps://example.org/pkg.whl\n# c\nredis>=5  # cache\r\n";
    expect(parseRequirementsFile(text)).toEqual([{ name: "redis", version: ">=5", extras: [] }]);
  });

  it("matches workspace globs with negation", () => {
    expect(matchesWorkspace("apps/web", ["apps/*"])).toBe(true);
    expect(matchesWorkspace("apps/web/sub", ["apps/*"])).toBe(false);
    expect(matchesWorkspace("packages/a/b", ["packages/**"])).toBe(true);
    expect(matchesWorkspace("apps/legacy", ["apps/*", "!apps/legacy"])).toBe(false);
    expect(matchesWorkspace("web", ["./web/"])).toBe(true);
  });
});

describe("source signals", () => {
  it("finds ports in commands", () => {
    expect(portsInCommand("next start --port 4000")).toEqual([4000]);
    expect(portsInCommand("next start -p 4100")).toEqual([4100]);
    expect(portsInCommand("PORT=8081 node server.js")).toEqual([8081]);
    expect(portsInCommand("gunicorn app:app --bind 0.0.0.0:9000")).toEqual([9000]);
    expect(portsInCommand("node server.js")).toEqual([]);
  });

  it("finds ports, health routes, app objects and URL schemes in source", () => {
    const js = scanSource(
      'const port = Number(process.env.PORT) || 4321;\nfastify.listen({ host: "0.0.0.0", port: 3001 });\nrouter.get("/api/healthz", h);\nconst u = "postgresql://localhost/db";',
    );
    expect(js.ports).toEqual([3001, 4321]);
    expect(js.healthPaths).toEqual(["/api/healthz"]);
    expect(js.urlSchemes).toEqual(["postgres"]);
    expect(js.envNames).toEqual(["PORT"]);

    const py = scanSource(
      'api: FastAPI = FastAPI()\nserver = Flask(__name__)\nuvicorn.run(api, port=8001)\nb = "rediss://cache"',
    );
    expect(py.appObjects).toEqual([
      { variable: "api", framework: "fastapi" },
      { variable: "server", framework: "flask" },
    ]);
    expect(py.ports).toEqual([8001]);
    expect(py.urlSchemes).toEqual(["redis"]);
  });

  it("maps file-system routes and Python modules", () => {
    expect(healthRouteFromPath("src/app/api/health/route.ts")).toBe("/api/health");
    expect(healthRouteFromPath("pages/api/ping.js")).toBe("/api/ping");
    expect(healthRouteFromPath("app/health/route.js")).toBe("/health");
    expect(healthRouteFromPath("app/users/route.ts")).toBeUndefined();
    expect(pythonModule("app/main.py")).toBe("app.main");
    expect(pythonModule("pkg/__init__.py")).toBe("pkg");
  });
});
