import { describe, expect, it } from "vitest";
import { appFacts, healthInput, syntaxError, written } from "./__fixtures__/repo";
import { healthRouteEdit } from "./index";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const nest = appFacts({ languages: ["typescript"], frameworks: ["nestjs"] });

const MAIN = lines(
  'import { NestFactory } from "@nestjs/core";',
  'import { AppModule } from "./app.module";',
  "",
  "async function bootstrap() {",
  "  const app = await NestFactory.create(AppModule);",
  "  await app.listen(process.env.PORT ?? 3000);",
  "}",
  "bootstrap();",
);

const MODULE = lines(
  'import { Module } from "@nestjs/common";',
  'import { AppController } from "./app.controller";',
  'import { AppService } from "./app.service";',
  "",
  "@Module({",
  "  imports: [],",
  "  controllers: [AppController],",
  "  providers: [AppService],",
  "})",
  "export class AppModule {}",
);

const CONTROLLER = lines(
  'import { Controller, Get } from "@nestjs/common";',
  'import { AppService } from "./app.service";',
  "",
  "@Controller()",
  "export class AppController {",
  "  constructor(private readonly appService: AppService) {}",
  "",
  "  @Get()",
  "  getHello(): string {",
  "    return this.appService.getHello();",
  "  }",
  "}",
);

/** examples/nestjs-api without its health route. */
function nestApp(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "package.json": JSON.stringify({ dependencies: { "@nestjs/core": "11.0.0" } }),
    "src/main.ts": MAIN,
    "src/app.module.ts": MODULE,
    "src/app.controller.ts": CONTROLLER,
    "src/app.service.ts": "export class AppService {}\n",
    ...overrides,
  };
}

describe("NestJS", () => {
  it("creates a HealthController and registers it first in the root module", async () => {
    const edit = await healthRouteEdit(healthInput("node-server", nest, nestApp()));
    expect(edit).toMatchObject({
      action: "write",
      framework: "NestJS",
      path: "src/health.controller.ts",
    });
    const controller = written(edit, "src/health.controller.ts");
    expect(controller).toBe(
      lines(
        'import { Controller, Get } from "@nestjs/common";',
        "",
        "/** Health check for the OpsCrew deploy workflow: answers 200 while the app is up. */",
        '@Controller("health")',
        "export class HealthController {",
        "  @Get()",
        "  check() {",
        '    return { status: "ok" };',
        "  }",
        "}",
      ),
    );
    const module = written(edit, "src/app.module.ts");
    expect(module).toBe(
      lines(
        'import { Module } from "@nestjs/common";',
        'import { AppController } from "./app.controller";',
        'import { AppService } from "./app.service";',
        'import { HealthController } from "./health.controller";',
        "",
        "@Module({",
        "  imports: [],",
        "  controllers: [HealthController, AppController],",
        "  providers: [AppService],",
        "})",
        "export class AppModule {}",
      ),
    );
    expect(syntaxError(controller)).toBeUndefined();
    expect(syntaxError(module)).toBeUndefined();
    if (edit.action === "write") {
      expect(edit.files.map((f) => [f.path, f.created])).toEqual([
        ["src/health.controller.ts", true],
        ["src/app.module.ts", false],
      ]);
      expect(edit.note).toBe(
        'Created src/health.controller.ts by OpsCrew: answers GET /health with {"status":"ok"} for the deploy health check. Registered in src/app.module.ts.',
      );
      expect(edit.pathNote).toBeUndefined();
    }
  });

  it("says where the route answers under a global prefix", async () => {
    const main = MAIN.replace(
      "  await app.listen",
      '  app.setGlobalPrefix("api");\n  await app.listen',
    );
    const edit = await healthRouteEdit(
      healthInput("node-server", nest, nestApp({ "src/main.ts": main })),
    );
    expect(edit.action === "write" && edit.pathNote).toBe(
      'src/main.ts sets the global prefix "api", so the health route answers at /api/health, not /health: the plan\'s health check path must be /api/health (run `opscrew design` and set it, or edit app.healthPath in `opscrew/plan.yaml`), or every deploy fails its health check.',
    );
  });

  it("names global guards the user should check", async () => {
    const module = MODULE.replace(
      "  providers: [AppService],",
      "  providers: [AppService, { provide: APP_GUARD, useClass: AuthGuard }],",
    );
    const edit = await healthRouteEdit(
      healthInput("node-server", nest, nestApp({ "src/app.module.ts": module })),
    );
    expect(edit.action === "write" && edit.checks).toEqual([
      "Check that the global guards in src/app.module.ts let GET /health through (mark HealthController with the decorator your guards use for public routes): the deploy health check calls it without a session.",
    ]);
  });

  it("keeps .js import specifiers and adds a controllers list when the module has none", async () => {
    const module = lines(
      "import { Module } from '@nestjs/common'",
      "import { ConfigModule } from '@nestjs/config'",
      "import { UsersModule } from './users/users.module.js'",
      "",
      "@Module({",
      "  imports: [ConfigModule.forRoot(), UsersModule],",
      "})",
      "export class AppModule {}",
    );
    const main = MAIN.replace('"./app.module"', '"./app.module.js"');
    const edit = await healthRouteEdit(
      healthInput(
        "node-server",
        nest,
        nestApp({ "src/main.ts": main, "src/app.module.ts": module }),
      ),
    );
    const edited = written(edit, "src/app.module.ts");
    expect(edited).toBe(
      lines(
        "import { Module } from '@nestjs/common'",
        "import { ConfigModule } from '@nestjs/config'",
        "import { UsersModule } from './users/users.module.js'",
        "import { HealthController } from './health.controller.js'",
        "",
        "@Module({",
        "  controllers: [HealthController],",
        "  imports: [ConfigModule.forRoot(), UsersModule],",
        "})",
        "export class AppModule {}",
      ),
    );
    expect(syntaxError(edited)).toBeUndefined();
    expect(written(edit, "src/health.controller.ts")).toContain(
      "@Controller('health')\nexport class HealthController {\n  @Get()\n  check() {\n    return { status: 'ok' }\n  }\n}\n",
    );
  });

  it("leaves an existing route as it is, and an unclear root module to the agent", async () => {
    const withHealth = CONTROLLER.replace(
      "  @Get()",
      '  @Get("health")\n  health() {\n    return { status: "ok" };\n  }\n\n  @Get()',
    );
    expect(
      await healthRouteEdit(
        healthInput("node-server", nest, nestApp({ "src/app.controller.ts": withHealth })),
      ),
    ).toEqual({
      action: "none",
      reason: "src/app.controller.ts already answers /health; OpsCrew left it as it is.",
    });
    const external = MAIN.replace('"./app.module"', '"@acme/core"');
    const edit = await healthRouteEdit(
      healthInput("node-server", nest, nestApp({ "src/main.ts": external })),
    );
    expect(edit).toEqual({
      action: "manual",
      reason: "OpsCrew could not find the file of AppModule, the module src/main.ts starts.",
    });
  });
});

describe("AdonisJS", () => {
  it("adds the route right after the imports of start/routes.ts", async () => {
    const routes = lines(
      "/*",
      "| Routes file",
      "*/",
      "",
      "import router from '@adonisjs/core/services/router'",
      "const PostsController = () => import('#controllers/posts_controller')",
      "",
      "router.on('/').render('pages/home')",
      "router.get('/posts', [PostsController, 'index'])",
    );
    const edit = await healthRouteEdit(
      healthInput("node-server", appFacts({ languages: ["typescript"] }), {
        "package.json": JSON.stringify({ dependencies: { "@adonisjs/core": "6.17.0" } }),
        "start/routes.ts": routes,
      }),
    );
    expect(edit).toMatchObject({ action: "write", framework: "AdonisJS", path: "start/routes.ts" });
    const content = written(edit, "start/routes.ts");
    expect(content).toBe(
      lines(
        "/*",
        "| Routes file",
        "*/",
        "",
        "import router from '@adonisjs/core/services/router'",
        "",
        "router.get('/health', () => ({ status: 'ok' }))",
        "",
        "const PostsController = () => import('#controllers/posts_controller')",
        "",
        "router.on('/').render('pages/home')",
        "router.get('/posts', [PostsController, 'index'])",
      ),
    );
    expect(syntaxError(content)).toBeUndefined();
  });
});
