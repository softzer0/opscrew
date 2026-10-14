import { describe, expect, it } from "vitest";
import {
  builtInHealthEndpoint,
  healthRouteFromPath,
  type NestGlobalPrefix,
  nestGlobalPrefix,
  nestRoutePath,
  nextBasePathLiteral,
  scanSource,
} from "./sources";

describe("environment variables in a source file", () => {
  it("lists names and whether each read has a default", () => {
    const signals = scanSource('const a = process.env.API_URL ?? "x";\nprocess.env.TOKEN;\n');
    expect(signals.envNames).toEqual(["API_URL", "TOKEN"]);
    expect(signals.envReads).toEqual([
      { name: "API_URL", hasDefault: true },
      { name: "TOKEN", hasDefault: false },
    ]);
  });
});

describe("file-system health routes of SSR frameworks", () => {
  it.each([
    ["server/routes/health.ts", "/health"],
    ["server/routes/healthz.get.ts", "/healthz"],
    ["server/api/health.ts", "/api/health"],
    ["server/api/ping.js", "/api/ping"],
    ["src/routes/health/+server.ts", "/health"],
    ["src/routes/api/ready/+server.js", "/api/ready"],
    ["src/pages/health.ts", "/health"],
    ["src/pages/api/status.js", "/api/status"],
    ["app/api/health/route.ts", "/api/health"],
    ["pages/api/health.ts", "/api/health"],
    ["src/routes/health.ts", "/health"],
    ["src/routes/api/health/index.js", "/api/health"],
  ])("%s → %s", (path, route) => {
    expect(healthRouteFromPath(path)).toBe(route);
  });

  it.each([
    "server/routes/users.ts",
    "server/middleware/health.ts",
    "src/routes/health/+page.svelte",
    "src/routes/health/+page.server.ts",
    "src/routes/users/+server.ts",
    "src/pages/health.astro",
    "src/pages/about.ts",
    "src/routes/users.ts",
    "src/routes/health.tsx",
  ])("ignores %s", (path) => {
    expect(healthRouteFromPath(path)).toBeUndefined();
  });

  it("finds React Router framework-mode routes registered in app/routes.ts", () => {
    const text = [
      'import { type RouteConfig, index, route } from "@react-router/dev/routes";',
      "export default [",
      '  index("routes/home.tsx"),',
      '  route("users", "routes/users.tsx"),',
      '  route("health", "routes/health.ts"),',
      "] satisfies RouteConfig;",
    ].join("\n");
    expect(scanSource(text).healthPaths).toEqual(["/health"]);
    expect(scanSource("route('/api/healthz', 'routes/h.ts')").healthPaths).toEqual([
      "/api/healthz",
    ]);
    expect(scanSource('router.route("users")').healthPaths).toEqual([]);
  });
});

describe("decorator health routes (NestJS and similar)", () => {
  it("finds @Get with a health path in a controller without a prefix", () => {
    const text = [
      "@Controller()",
      "export class AppController {",
      "  @Get()",
      "  hello() {}",
      '  @Get("health")',
      "  health() {}",
      "}",
    ].join("\n");
    expect(scanSource(text).healthPaths).toEqual(["/health"]);
  });

  it("accepts single quotes and a leading slash", () => {
    expect(
      scanSource("@Controller()\nclass A {\n  @Get('/healthz')\n  h() {}\n}").healthPaths,
    ).toEqual(["/healthz"]);
  });

  it("joins the controller prefix with the method path", () => {
    const text =
      '@Controller("health")\nexport class HealthController {\n  @Get()\n  check() {}\n}';
    expect(scanSource(text).healthPaths).toEqual(["/health"]);
    const nested = "@Controller('/api/')\nclass A {\n  @Get('ready')\n  r() {}\n}";
    expect(scanSource(nested).healthPaths).toEqual(["/api/ready"]);
  });

  it("ignores non-health routes and routes under a prefix it cannot read", () => {
    expect(
      scanSource(
        '@Controller("users")\nclass U {\n  @Get()\n  list() {}\n  @Get(":id")\n  one() {}\n}',
      ).healthPaths,
    ).toEqual([]);
    expect(
      scanSource('@Controller("users")\nclass U {\n  @Get("health")\n  h() {}\n}').healthPaths,
    ).toEqual([]);
    expect(
      scanSource('@Controller({ path: "x" })\nclass U {\n  @Get("health")\n  h() {}\n}')
        .healthPaths,
    ).toEqual([]);
    expect(
      scanSource("@Controller()\nclass U {\n  @Post('health')\n  h() {}\n}").healthPaths,
    ).toEqual([]);
  });

  it("uses each controller's own prefix when a file declares several", () => {
    const text = [
      '@Controller("users")',
      "class U { @Get() list() {} }",
      '@Controller("status")',
      "class S { @Get() s() {} }",
    ].join("\n");
    expect(scanSource(text).healthPaths).toEqual(["/status"]);
  });
});

describe("health routes registered in code by other frameworks", () => {
  it.each([
    ["Starlette Route", 'routes = [Route("/health", health), Route("/", home)]', "/health"],
    ["Starlette add_route", 'app.add_route("/health", health, methods=["GET"])', "/health"],
    ["Litestar @get", '@get("/healthz")\nasync def h() -> dict[str, str]: ...', "/healthz"],
    ["Bottle @route", "@route('/ping')\ndef ping(): ...", "/ping"],
    ["Falcon add_route", 'app.add_route("/health", HealthResource())', "/health"],
    ["aiohttp add_get", 'app.router.add_get("/health", health)', "/health"],
    ["Tornado tuple", 'tornado.web.Application([\n    (r"/health", HealthHandler),\n])', "/health"],
    ["Tornado url", 'Application([url(r"/ready$", ReadyHandler)])', "/ready"],
    ["Pyramid", 'config.add_route("health", "/health")', "/health"],
    [
      "Hapi",
      'server.route({ method: "GET", path: "/health", handler: () => ({ status: "ok" }) });',
      "/health",
    ],
    ["Hapi over lines", 'server.route({\n  method: "GET",\n  path: "/healthz",\n})', "/healthz"],
    ["Fastify route", "fastify.route({ method: 'GET', url: '/health', handler })", "/health"],
    ["Koa middleware", 'if (ctx.method === "GET" && ctx.path === "/health") {', "/health"],
    ["Elysia chain", 'new Elysia()\n  .get("/health", () => ({ status: "ok" }))', "/health"],
    ["AdonisJS", "router.get('/health', () => ({ status: 'ok' }))", "/health"],
  ])("%s", (_name, text, route) => {
    expect(scanSource(text).healthPaths).toEqual([route]);
  });

  it("ignores other paths and look-alikes", () => {
    expect(scanSource('Route("/users", users)').healthPaths).toEqual([]);
    expect(scanSource('handlers = [(r"/", MainHandler)]').healthPaths).toEqual([]);
    expect(scanSource('pairs = [("/health", "GET")]').healthPaths).toEqual([]);
    expect(scanSource('config.add_route("health", "/users")').healthPaths).toEqual([]);
    expect(scanSource('router.route({ path: "/users" })').healthPaths).toEqual([]);
    expect(scanSource('if (ctx.path === "/users") {}').healthPaths).toEqual([]);
    expect(scanSource('MyRoute("/health")').healthPaths).toEqual([]);
  });
});

describe("health endpoints the framework answers by itself", () => {
  it("Rails 7.1+: /up from config/routes.rb", () => {
    const routes = [
      "Rails.application.routes.draw do",
      "  # Reveal health status on /up that returns 200 if the app boots with no exceptions.",
      '  get "up" => "rails/health#show", as: :rails_health_check',
      "end",
    ].join("\n");
    expect(builtInHealthEndpoint({ "config/routes.rb": routes })).toBe("/up");
    expect(
      builtInHealthEndpoint({ "config/routes.rb": "get '/healthz', to: 'rails/health#show'\n" }),
    ).toBe("/healthz");
    expect(
      builtInHealthEndpoint({
        "config/routes.rb": '  # get "up" => "rails/health#show", as: :rails_health_check\n',
      }),
    ).toBeUndefined();
  });

  it("Laravel 11+: the health option of withRouting in bootstrap/app.php", () => {
    const app = [
      "<?php",
      "return Application::configure(basePath: dirname(__DIR__))",
      "    ->withRouting(",
      "        web: __DIR__.'/../routes/web.php',",
      "        health: '/up',",
      "    )",
      "    ->create();",
    ].join("\n");
    expect(builtInHealthEndpoint({ "bootstrap/app.php": app })).toBe("/up");
    expect(
      builtInHealthEndpoint({
        "bootstrap/app.php": app.replace("        health", "        // health"),
      }),
    ).toBeUndefined();
  });

  it("Spring Boot Actuator: /actuator/health, under the configured paths", () => {
    const pom = [
      "<dependency>",
      "  <groupId>org.springframework.boot</groupId>",
      "  <artifactId>spring-boot-starter-actuator</artifactId>",
      "</dependency>",
    ].join("\n");
    expect(builtInHealthEndpoint({ "pom.xml": pom })).toBe("/actuator/health");
    expect(
      builtInHealthEndpoint({
        "build.gradle.kts":
          'implementation("org.springframework.boot:spring-boot-starter-actuator")\n',
        "src/main/resources/application.properties":
          "server.servlet.context-path=/api\nmanagement.endpoints.web.base-path=/manage\n",
      }),
    ).toBe("/api/manage/health");
    expect(
      builtInHealthEndpoint({
        "build.gradle": "implementation 'org.springframework.boot:spring-boot-starter-actuator'\n",
        "src/main/resources/application.yml":
          "management:\n  endpoints:\n    web:\n      base-path: /\n",
      }),
    ).toBe("/health");
  });

  it("Spring Boot: nothing without Actuator, or when health is off or on another port", () => {
    expect(
      builtInHealthEndpoint({ "pom.xml": "<!-- spring-boot-starter-actuator -->\n" }),
    ).toBeUndefined();
    const gradle = "implementation 'org.springframework.boot:spring-boot-starter-actuator'\n";
    for (const properties of [
      "management.server.port=8081",
      "management.endpoint.health.enabled=false",
      "management.endpoints.web.exposure.exclude=*",
      "management.endpoint.health.access=none",
    ]) {
      expect(
        builtInHealthEndpoint({
          "build.gradle": gradle,
          "src/main/resources/application.properties": `${properties}\n`,
        }),
        properties,
      ).toBeUndefined();
    }
    expect(builtInHealthEndpoint({})).toBeUndefined();
  });

  it("Spring Boot: an explicit exposure list must name health or *", () => {
    const build = { "build.gradle": "implementation 'spring-boot-starter-actuator'\n" };
    const props = (text: string) =>
      builtInHealthEndpoint({ ...build, "src/main/resources/application.properties": text });
    const yml = (text: string) =>
      builtInHealthEndpoint({ ...build, "src/main/resources/application.yml": text });
    expect(props("management.endpoints.web.exposure.include=info,metrics\n")).toBeUndefined();
    expect(props("management.endpoints.web.exposure.include=info, health\n")).toBe(
      "/actuator/health",
    );
    expect(props("management.endpoints.web.exposure.include=*\n")).toBe("/actuator/health");
    expect(
      props(
        "management.endpoints.web.exposure.include[0]=info\nmanagement.endpoints.web.exposure.include[1]=prometheus\n",
      ),
    ).toBeUndefined();
    expect(props("management.endpoints.web.exposure.include[0]=health\n")).toBe("/actuator/health");
    const exposure = (value: string) =>
      `management:\n  endpoints:\n    web:\n      exposure:\n        include: ${value}\n`;
    expect(yml(exposure("info"))).toBeUndefined();
    expect(yml(exposure('"*"'))).toBe("/actuator/health");
    expect(yml(exposure("[info, metrics]"))).toBeUndefined();
    expect(yml(exposure("\n          - info\n          - health"))).toBe("/actuator/health");
    expect(yml("management.endpoints.web.exposure.include: prometheus\n")).toBeUndefined();
  });
});

describe("NestJS global prefix and Next.js basePath", () => {
  it("reads the prefix and the exact paths it excludes", () => {
    expect(nestGlobalPrefix("app.setGlobalPrefix('api');")).toEqual({
      kind: "literal",
      prefix: "api",
      exclude: [],
    });
    expect(
      nestGlobalPrefix(
        "app.setGlobalPrefix(\"/v1/\", {\n  exclude: ['health', '/status/', { path: 'ready', method: RequestMethod.GET }],\n});",
      ),
    ).toEqual({ kind: "literal", prefix: "v1", exclude: ["health", "status", "ready"] });
    expect(nestGlobalPrefix("app.setGlobalPrefix(PREFIX);")).toEqual({ kind: "unknown" });
    expect(nestGlobalPrefix("// app.setGlobalPrefix('api');\nawait app.listen(3000);")).toBe(
      undefined,
    );
    expect(nestGlobalPrefix("app.setGlobalPrefix('');")).toBeUndefined();
  });

  it("places a controller route under the prefix unless it is excluded exactly", () => {
    const prefix: NestGlobalPrefix = { kind: "literal", prefix: "api", exclude: ["health"] };
    expect(nestRoutePath("/health", prefix)).toBe("/health");
    expect(nestRoutePath("/healthz", prefix)).toBe("/api/healthz");
    expect(nestRoutePath("/health", undefined)).toBe("/health");
    expect(nestRoutePath("/health", { kind: "unknown" })).toBeUndefined();
  });

  it("reads a literal basePath", () => {
    expect(nextBasePathLiteral('const nextConfig = { basePath: "/docs/" };')).toBe("/docs");
    expect(nextBasePathLiteral("export default { basePath: process.env.BASE };")).toBeUndefined();
    expect(nextBasePathLiteral('// basePath: "/old"\nexport default {};')).toBeUndefined();
    expect(nextBasePathLiteral(undefined)).toBeUndefined();
  });
});
