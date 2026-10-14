import { describe, expect, it } from "vitest";
import { appFacts, healthInput, NO_TS_PARSER, syntaxError, written } from "./__fixtures__/repo";
import { healthRouteEdit } from "./index";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const node = appFacts({ languages: ["javascript"], frameworks: ["express"] });

/** Runs the registry for a Node.js app and returns the edited file (checked to still parse). */
async function edited(files: Record<string, string>, file: string) {
  const edit = await healthRouteEdit(healthInput("node-server", node, files));
  const content = written(edit, file);
  expect(syntaxError(content), content).toBeUndefined();
  return { edit, content };
}

/** The reason of a manual result. */
async function reason(files: Record<string, string>): Promise<string> {
  const edit = await healthRouteEdit(healthInput("node-server", node, files));
  if (edit.action !== "manual") throw new Error(`expected manual, got ${JSON.stringify(edit)}`);
  return edit.reason;
}

describe.skipIf(NO_TS_PARSER !== undefined)("the parse check used by these tests", () => {
  it("catches a broken file", () => {
    expect(syntaxError("const a = {;\n")).toBeDefined();
    expect(
      syntaxError('import x from "y";\nconst a: number = 1;\nexport default a;\n'),
    ).toBeUndefined();
  });
});

describe("Express", () => {
  it("adds the route right after `const app = express()` (ESM, before any middleware)", async () => {
    const { edit, content } = await edited(
      {
        "index.js": lines(
          'import express from "express";',
          'import pg from "pg";',
          "",
          "// The pool connects on the first query, so the server starts without the database.",
          "const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });",
          "",
          "const app = express();",
          "const port = process.env.PORT || 3000;",
          "",
          'app.get("/", async (_req, res) => {',
          '  const { rows } = await pool.query("SELECT now() AS now");',
          "  res.json({ now: rows[0].now });",
          "});",
          "",
          "app.listen(port);",
        ),
      },
      "index.js",
    );
    expect(edit).toMatchObject({ action: "write", framework: "Express", path: "index.js" });
    expect(content).toContain(
      lines(
        "const app = express();",
        "",
        'app.get("/health", (_req, res) => {',
        '  res.json({ status: "ok" });',
        "});",
        "",
        "const port = process.env.PORT || 3000;",
      ),
    );
  });

  it("keeps CommonJS, single quotes and no semicolons", async () => {
    const { content } = await edited(
      {
        "app.js": lines(
          "'use strict'",
          "",
          "const express = require('express')",
          "const helmet = require('helmet')",
          "",
          "const app = express()",
          "app.use(helmet())",
          "",
          "module.exports = app",
        ),
      },
      "app.js",
    );
    expect(content).toBe(
      lines(
        "'use strict'",
        "",
        "const express = require('express')",
        "const helmet = require('helmet')",
        "",
        "const app = express()",
        "",
        "app.get('/health', (_req, res) => {",
        "  res.json({ status: 'ok' })",
        "})",
        "",
        "app.use(helmet())",
        "",
        "module.exports = app",
      ),
    );
  });

  it("edits the module that creates the app, not the server or a router", async () => {
    const { edit, content } = await edited(
      {
        "src/server.ts": lines('import { app } from "./app";', "", "app.listen(3000);"),
        "src/routes/users.ts": lines(
          'import express from "express";',
          "export const users = express.Router();",
        ),
        "src/app.ts": lines(
          'import express, { type Express } from "express";',
          'import { users } from "./routes/users";',
          "",
          "export const app: Express = express();",
          'app.use("/users", users);',
        ),
      },
      "src/app.ts",
    );
    expect(edit.action === "write" && edit.path).toBe("src/app.ts");
    expect(content).toContain(
      'export const app: Express = express();\n\napp.get("/health", (_req, res) => {\n  res.json({ status: "ok" });\n});\n\napp.use("/users", users);\n',
    );
  });

  it("accepts require('express')() and an app made inside a function", async () => {
    const direct = await edited(
      { "server.js": lines('const app = require("express")();', "app.listen(3000);") },
      "server.js",
    );
    expect(direct.content).toContain('const app = require("express")();\n\napp.get("/health"');
    const factory = await edited(
      {
        "server.js": lines(
          'const express = require("express");',
          "",
          "function main() {",
          "    const server = express();",
          "    server.listen(3000);",
          "}",
          "",
          "main();",
        ),
      },
      "server.js",
    );
    expect(factory.content).toContain(
      lines(
        "    const server = express();",
        "",
        '    server.get("/health", (_req, res) => {',
        '        res.json({ status: "ok" });',
        "    });",
        "",
        "    server.listen(3000);",
      ),
    );
  });

  it("leaves two apps, an app made elsewhere and a taken path to the agent", async () => {
    expect(
      await reason({
        "server.js": lines('import express from "express";', "const app = express();"),
        "admin.js": lines('import express from "express";', "const admin = express();"),
      }),
    ).toBe(
      "OpsCrew found 2 app objects (Express in admin.js line 2 and Express in server.js line 2), so it cannot tell which one serves the app.",
    );
    expect(
      await reason({
        "server.js": lines('import { createApp } from "@acme/web";', "const app = createApp();"),
      }),
    ).toBe(
      "OpsCrew found no Express, Fastify, Hono, Koa, Elysia, Hapi or Restify app object in the app's code (it may be created in another module or package), so it cannot tell where the route belongs.",
    );
    expect(
      await reason({
        "server.js": lines(
          'import express from "express";',
          "const app = express();",
          'app.use("/health", healthRouter);',
        ),
      }),
    ).toBe("server.js already uses /health (line 3), so OpsCrew did not add a second route there.");
    expect(
      await reason({
        "server.js": lines('import express from "express";', "export default express();"),
      }),
    ).toContain("is not assigned to a variable");
    expect(
      await reason({
        "server.js": lines(
          'import express from "express";',
          "const app = express(); app.listen(1);",
        ),
      }),
    ).toContain("more code follows the Express app on line 2");
  });

  it("leaves an existing GET route as it is", async () => {
    const edit = await healthRouteEdit(
      healthInput("node-server", node, {
        "server.js": lines(
          'import express from "express";',
          "const app = express();",
          "app.get('/health', (req, res) => res.send('ok'));",
        ),
      }),
    );
    expect(edit).toEqual({
      action: "none",
      reason: "server.js (line 3) already answers /health; OpsCrew left it as it is.",
    });
  });
});

describe("Fastify", () => {
  it("adds the route right after the instance is created (examples/fastify-api)", async () => {
    const { content } = await edited(
      {
        "server.js": lines(
          'import Fastify from "fastify";',
          'import { Redis } from "ioredis";',
          "",
          "const fastify = Fastify({ logger: true });",
          "",
          "fastify.decorate(",
          '  "redis",',
          '  new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { lazyConnect: true }),',
          ");",
          "",
          "try {",
          '  await fastify.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });',
          "} catch (err) {",
          "  process.exit(1);",
          "}",
        ),
      },
      "server.js",
    );
    expect(content).toContain(
      lines(
        "const fastify = Fastify({ logger: true });",
        "",
        'fastify.get("/health", async () => {',
        '  return { status: "ok" };',
        "});",
        "",
        "fastify.decorate(",
      ),
    );
  });

  it("works in a CommonJS factory and with a type provider", async () => {
    const factory = await edited(
      {
        "app.js": lines(
          'const fastify = require("fastify");',
          "",
          "function build(opts = {}) {",
          "  const app = fastify(opts);",
          '  app.register(require("./routes"));',
          "  return app;",
          "}",
          "",
          "module.exports = build;",
        ),
      },
      "app.js",
    );
    expect(factory.content).toContain(
      '  const app = fastify(opts);\n\n  app.get("/health", async () => {\n    return { status: "ok" };\n  });\n\n  app.register',
    );
    const typed = await edited(
      {
        "src/app.ts": lines(
          'import Fastify from "fastify";',
          'import type { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";',
          "",
          "export const app = Fastify({ logger: true }).withTypeProvider<TypeBoxTypeProvider>();",
        ),
      },
      "src/app.ts",
    );
    expect(typed.content).toContain(
      '.withTypeProvider<TypeBoxTypeProvider>();\n\napp.get("/health"',
    );
  });
});

describe("Hono, Koa, Elysia, Hapi, Restify", () => {
  it("Hono: c.json on the app, but not under a basePath", async () => {
    const { content } = await edited(
      {
        "src/index.ts": lines(
          'import { serve } from "@hono/node-server";',
          'import { Hono } from "hono";',
          "",
          "const app = new Hono<{ Bindings: { TOKEN: string } }>();",
          "",
          'app.get("/", (c) => c.json({ message: "Hello from Hono" }));',
          "",
          "serve({ fetch: app.fetch, port: 3000 });",
        ),
      },
      "src/index.ts",
    );
    expect(content).toContain(
      'const app = new Hono<{ Bindings: { TOKEN: string } }>();\n\napp.get("/health", (c) => c.json({ status: "ok" }));\n\napp.get("/",',
    );
    expect(
      await reason({
        "src/index.ts": lines(
          'import { Hono } from "hono";',
          'const app = new Hono().basePath("/api");',
        ),
      }),
    ).toBe(
      "the Hono app in src/index.ts is created with .basePath(…), so a new route would not answer at /health.",
    );
  });

  it("Koa: a first middleware that answers the path", async () => {
    const { content } = await edited(
      {
        "server.js": lines(
          'const Koa = require("koa");',
          'const Router = require("@koa/router");',
          "",
          "const app = new Koa();",
          "const router = new Router();",
        ),
      },
      "server.js",
    );
    expect(content).toBe(
      lines(
        'const Koa = require("koa");',
        'const Router = require("@koa/router");',
        "",
        "const app = new Koa();",
        "",
        "app.use(async (ctx, next) => {",
        '  if (ctx.method === "GET" && ctx.path === "/health") {',
        '    ctx.body = { status: "ok" };',
        "    return;",
        "  }",
        "  await next();",
        "});",
        "",
        "const router = new Router();",
      ),
    );
  });

  it("Elysia: into the method chain, on its own line or inline", async () => {
    const multi = await edited(
      {
        "src/index.ts": lines(
          'import { Elysia } from "elysia";',
          "",
          "const app = new Elysia()",
          '  .get("/", () => "Hello Elysia")',
          "  .listen(3000);",
        ),
      },
      "src/index.ts",
    );
    expect(multi.content).toBe(
      lines(
        'import { Elysia } from "elysia";',
        "",
        "const app = new Elysia()",
        '  .get("/health", () => ({ status: "ok" }))',
        '  .get("/", () => "Hello Elysia")',
        "  .listen(3000);",
      ),
    );
    const inline = await edited(
      {
        "src/index.ts": lines(
          "import { Elysia } from 'elysia'",
          "const app = new Elysia().get('/', () => 'hi').listen(3000)",
        ),
      },
      "src/index.ts",
    );
    expect(inline.content).toContain(
      "const app = new Elysia().get('/health', () => ({ status: 'ok' })).get('/', () => 'hi').listen(3000)\n",
    );
    expect(
      await reason({
        "src/index.ts": lines(
          'import { Elysia } from "elysia";',
          'const app = new Elysia({ prefix: "/v1" });',
        ),
      }),
    ).toBe(
      "the Elysia app in src/index.ts is created with a prefix, so a new route would not answer at /health.",
    );
  });

  it("Hapi: server.route inside the init function", async () => {
    const { content } = await edited(
      {
        "server.js": lines(
          '"use strict";',
          "",
          'const Hapi = require("@hapi/hapi");',
          "",
          "const init = async () => {",
          "  const server = Hapi.server({",
          "    port: 3000,",
          '    host: "0.0.0.0",',
          "  });",
          "",
          "  await server.start();",
          "};",
          "",
          "init();",
        ),
      },
      "server.js",
    );
    expect(content).toContain(
      lines(
        "  });",
        "",
        '  server.route({ method: "GET", path: "/health", handler: () => ({ status: "ok" }) });',
        "",
        "  await server.start();",
      ),
    );
  });

  it("Restify: a GET handler that calls next", async () => {
    const { content } = await edited(
      {
        "server.js": lines(
          'const restify = require("restify");',
          "",
          'const server = restify.createServer({ name: "api" });',
          "server.use(restify.plugins.bodyParser());",
        ),
      },
      "server.js",
    );
    expect(content).toContain(
      lines(
        'const server = restify.createServer({ name: "api" });',
        "",
        'server.get("/health", (_req, res, next) => {',
        '  res.send({ status: "ok" });',
        "  return next();",
        "});",
        "",
        "server.use(restify.plugins.bodyParser());",
      ),
    );
  });

  it("Feathers stays with the Code-change agent", async () => {
    expect(
      await reason({
        "src/app.ts": lines(
          'import { feathers } from "@feathersjs/feathers";',
          'import { koa, rest } from "@feathersjs/koa";',
          "",
          "export const app = koa(feathers());",
        ),
      }),
    ).toContain("Feathers registers routes as services");
  });
});
