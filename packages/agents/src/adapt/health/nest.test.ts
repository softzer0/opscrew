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

  const withPrefix = (call: string) =>
    MAIN.replace("  await app.listen", `  ${call}\n  await app.listen`);

  it("keeps the controller under a literal global prefix and moves the plan's path", async () => {
    const edit = await healthRouteEdit(
      healthInput(
        "node-server",
        nest,
        nestApp({ "src/main.ts": withPrefix('app.setGlobalPrefix("api");') }),
      ),
    );
    expect(edit).toMatchObject({ action: "write", healthPath: "/api/health" });
    expect(written(edit, "src/health.controller.ts")).toContain('@Controller("health")');
    expect(edit.action === "write" && edit.pathNote).toBe(
      'src/main.ts sets the global prefix "api", so the health route answers at /api/health; OpsCrew set app.healthPath in `opscrew/plan.yaml` to /api/health to match.',
    );
    // A plan that already names the prefixed path gets the same controller and no change.
    const named = await healthRouteEdit(
      healthInput(
        "node-server",
        nest,
        nestApp({ "src/main.ts": withPrefix('app.setGlobalPrefix("api");') }),
        "/api/health",
      ),
    );
    expect(written(named, "src/health.controller.ts")).toContain('@Controller("health")');
    expect(named.action === "write" && named.healthPath).toBeUndefined();
  });

  it("compares exclude entries exactly, and leaves an unreadable prefix to the agent", async () => {
    for (const call of [
      "app.setGlobalPrefix('api', { exclude: ['health'] });",
      "app.setGlobalPrefix('api', { exclude: ['/health'] });",
      "app.setGlobalPrefix('api', { exclude: [{ path: 'health', method: RequestMethod.GET }] });",
    ]) {
      const edit = await healthRouteEdit(
        healthInput("node-server", nest, nestApp({ "src/main.ts": withPrefix(call) })),
      );
      expect(edit, call).toMatchObject({ action: "write" });
      expect(edit.action === "write" && edit.healthPath, call).toBeUndefined();
    }
    const near = await healthRouteEdit(
      healthInput(
        "node-server",
        nest,
        nestApp({
          "src/main.ts": withPrefix("app.setGlobalPrefix('api', { exclude: ['healthz'] });"),
        }),
      ),
    );
    expect(near.action === "write" && near.healthPath).toBe("/api/health");
    expect(
      await healthRouteEdit(
        healthInput(
          "node-server",
          nest,
          nestApp({ "src/main.ts": withPrefix("app.setGlobalPrefix(config.prefix);") }),
        ),
      ),
    ).toEqual({
      action: "manual",
      reason:
        "src/main.ts sets a global prefix OpsCrew cannot read, so it cannot tell where a new route would answer.",
    });
  });

  it("moves the plan's path to an existing controller route under the prefix", async () => {
    const health = CONTROLLER.replace(
      "  @Get()",
      '  @Get("health")\n  health() {\n    return { status: "ok" };\n  }\n\n  @Get()',
    );
    const edit = await healthRouteEdit(
      healthInput(
        "node-server",
        nest,
        nestApp({
          "src/main.ts": withPrefix("app.setGlobalPrefix('api');"),
          "src/app.controller.ts": health,
        }),
      ),
    );
    expect(edit).toEqual({
      action: "none",
      reason: "src/app.controller.ts already answers /api/health; OpsCrew left it as it is.",
      healthPath: "/api/health",
      pathNote:
        'src/main.ts sets the global prefix "api", so the health route answers at /api/health; OpsCrew set app.healthPath in `opscrew/plan.yaml` to /api/health to match.',
    });
  });

  it("names global guards found anywhere in the app", async () => {
    const edit = await healthRouteEdit(
      healthInput(
        "node-server",
        nest,
        nestApp({
          "src/auth/auth.module.ts": lines(
            'import { APP_GUARD } from "@nestjs/core";',
            "export const guards = [{ provide: APP_GUARD, useClass: JwtGuard }];",
          ),
        }),
      ),
    );
    expect(edit.action === "write" && edit.checks).toEqual([
      "Check that the global guards in src/auth/auth.module.ts let GET /health through (mark HealthController with the decorator your guards use for public routes): the deploy health check calls it without a session.",
    ]);
  });

  it("marks the controller with the project's own public decorator", async () => {
    const edit = await healthRouteEdit(
      healthInput(
        "node-server",
        nest,
        nestApp({
          "src/main.ts": MAIN.replace(
            "  await app.listen",
            "  app.useGlobalGuards(new JwtAuthGuard(app.get(Reflector)));\n  await app.listen",
          ),
          "src/auth/public.decorator.ts": lines(
            'import { SetMetadata } from "@nestjs/common";',
            'export const IS_PUBLIC_KEY = "isPublic";',
            "export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);",
          ),
        }),
      ),
    );
    const controller = written(edit, "src/health.controller.ts");
    expect(controller).toContain(
      'import { Controller, Get } from "@nestjs/common";\nimport { Public } from "./auth/public.decorator";\n',
    );
    expect(controller).toContain('@Public()\n@Controller("health")\n');
    expect(syntaxError(controller)).toBeUndefined();
    expect(edit.action === "write" && edit.checks).toEqual([]);
    expect(edit.action === "write" && edit.note).toContain(
      "Marked @Public() (from src/auth/public.decorator.ts) so the global guards let it through.",
    );
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
