import { describe, expect, it } from "vitest";
import { healthRouteFromPath, scanSource } from "./sources";

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
