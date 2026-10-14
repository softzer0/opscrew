import { describe, expect, it } from "vitest";
import { appFacts, healthInput, indentationError, written } from "./__fixtures__/repo";
import { healthRouteEdit } from "./index";

const lines = (...text: string[]) => `${text.join("\n")}\n`;
const python = appFacts({ languages: ["python"] });
const fastapi = appFacts({ languages: ["python"], frameworks: ["fastapi"] });
const flask = appFacts({ languages: ["python"], frameworks: ["flask"] });

/** Runs the registry for a Python app and returns the edited file (checked for indentation). */
async function edited(files: Record<string, string>, file: string, stack = "generic" as const) {
  const edit = await healthRouteEdit(healthInput(stack, python, files));
  const content = written(edit, file);
  expect(indentationError(content), content).toBeUndefined();
  return { edit, content };
}

describe("the indentation check used by these tests", () => {
  it("accepts consistent blocks and catches broken ones", () => {
    expect(
      indentationError(lines("def f():", "    x = (", "  1)", "    return x")),
    ).toBeUndefined();
    expect(indentationError(lines("def f():", "return 1"))).toContain("indented block");
    expect(indentationError(lines("x = 1", "    y = 2"))).toContain("without a block header");
    expect(indentationError(lines("if x:", "        a", "    b"))).toContain("unknown level");
    expect(indentationError(lines("if x:", "\ta", "if y:", "    b"))).toContain("character");
  });
});

describe("FastAPI", () => {
  it("adds the route right after the app object (examples/fastapi-redis)", async () => {
    const main = lines(
      "import os",
      "",
      "import redis",
      "from fastapi import FastAPI",
      "",
      'app = FastAPI(title="Visit counter (OpsCrew example)")',
      'cache = redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))',
      "",
      "",
      '@app.get("/")',
      "def index() -> dict[str, int]:",
      '    return {"visits": int(cache.incr("visits"))}',
    );
    const edit = await healthRouteEdit(
      healthInput("fastapi", fastapi, { "main.py": main, "requirements.txt": "fastapi\n" }),
    );
    expect(edit).toMatchObject({ action: "write", framework: "FastAPI", path: "main.py" });
    expect(indentationError(written(edit, "main.py"))).toBeUndefined();
    expect(written(edit, "main.py")).toBe(
      lines(
        "import os",
        "",
        "import redis",
        "from fastapi import FastAPI",
        "",
        'app = FastAPI(title="Visit counter (OpsCrew example)")',
        "",
        "",
        '@app.get("/health")',
        "def health():",
        '    return {"status": "ok"}',
        "",
        "",
        'cache = redis.from_url(os.environ.get("REDIS_URL", "redis://localhost:6379/0"))',
        "",
        "",
        '@app.get("/")',
        "def index() -> dict[str, int]:",
        '    return {"visits": int(cache.incr("visits"))}',
      ),
    );
    if (edit.action === "write") {
      expect(edit.files[0]?.created).toBe(false);
      expect(edit.note).toBe(
        'Added GET /health to main.py by OpsCrew, right after the FastAPI app is created: answers {"status":"ok"} for the deploy health check.',
      );
    }
  });

  it("follows a module import, a multi-line call and async handlers", async () => {
    const { content } = await edited(
      {
        "src/api/app.py": lines(
          "import fastapi",
          "",
          "app = fastapi.FastAPI(",
          '    title="Shop",',
          '    version="1.0",',
          ")",
          "",
          "",
          '@app.get("/items")',
          "async def items():",
          "    return []",
        ),
      },
      "src/api/app.py",
    );
    expect(content).toContain(
      lines(
        ")",
        "",
        "",
        '@app.get("/health")',
        "async def health():",
        '    return {"status": "ok"}',
        "",
        "",
        '@app.get("/items")',
      ),
    );
  });

  it("leaves an existing route alone and another use of the path to the agent", async () => {
    const existing = await healthRouteEdit(
      healthInput("fastapi", fastapi, {
        "main.py": lines(
          "from fastapi import FastAPI",
          "app = FastAPI()",
          "",
          '@app.get("/health")',
          "def health():",
          '    return {"ok": True}',
        ),
      }),
    );
    expect(existing).toEqual({
      action: "none",
      reason: "main.py (line 4) already answers /health; OpsCrew left it as it is.",
    });
    const taken = await healthRouteEdit(
      healthInput("fastapi", fastapi, {
        "main.py": lines(
          "from fastapi import FastAPI",
          "app = FastAPI()",
          "",
          '@app.post("/health")',
          "def report():",
          "    return {}",
        ),
      }),
    );
    expect(taken).toEqual({
      action: "manual",
      reason: "main.py already uses /health (line 4), so OpsCrew did not add a second route there.",
    });
  });

  it("never edits a comment or a test that mentions the path", async () => {
    const { content } = await edited(
      {
        "main.py": lines(
          "from fastapi import FastAPI",
          "",
          '# TODO: @app.get("/health")',
          "app = FastAPI()",
        ),
        "tests/test_main.py": lines(
          "from fastapi import FastAPI",
          "app = FastAPI()",
          'client.post("/health")',
        ),
      },
      "main.py",
    );
    expect(content).toContain('@app.get("/health")\ndef health():');
  });

  it("leaves two app objects to the agent", async () => {
    const edit = await healthRouteEdit(
      healthInput("fastapi", fastapi, {
        "main.py": lines("from fastapi import FastAPI", "app = FastAPI()"),
        "admin/app.py": lines("from fastapi import FastAPI", "admin = FastAPI()"),
      }),
    );
    expect(edit).toEqual({
      action: "manual",
      reason:
        "OpsCrew found 2 app objects (FastAPI in admin/app.py line 2 and FastAPI in main.py line 2), so it cannot tell which one serves the app.",
    });
  });

  it("picks the app the start command serves when a sub-app is mounted", async () => {
    const files = {
      "main.py": lines(
        "from fastapi import FastAPI",
        "",
        "from v1.app import v1",
        "",
        "app = FastAPI()",
        'app.mount("/v1", v1)',
      ),
      "v1/app.py": lines("from fastapi import FastAPI", "", "v1 = FastAPI()"),
    };
    const started = {
      ...fastapi,
      build: { startCommand: "uvicorn main:app --host 0.0.0.0 --port 8000" },
    };
    const edit = await healthRouteEdit(healthInput("fastapi", started, files));
    expect(edit).toMatchObject({ action: "write", path: "main.py" });
    expect(written(edit, "main.py")).toContain('app = FastAPI()\n\n\n@app.get("/health")');
    const unknown = await healthRouteEdit(healthInput("fastapi", fastapi, files));
    expect(unknown.action === "manual" && unknown.reason).toContain("found 2 app objects");
  });

  it("leaves an app created in a class, or without a variable, to the agent", async () => {
    const inClass = await healthRouteEdit(
      healthInput("fastapi", fastapi, {
        "main.py": lines("from fastapi import FastAPI", "", "class Server:", "    app = FastAPI()"),
      }),
    );
    expect(inClass).toMatchObject({ action: "manual" });
    expect(inClass.action === "manual" && inClass.reason).toContain("inside a class");
    const bare = await healthRouteEdit(
      healthInput("fastapi", fastapi, {
        "main.py": lines("from fastapi import FastAPI", "", "serve(FastAPI())"),
      }),
    );
    expect(bare.action === "manual" && bare.reason).toContain("not assigned to a variable");
  });

  it("names the handler opscrew_health when health is taken", async () => {
    const { content } = await edited(
      {
        "main.py": lines(
          "from fastapi import FastAPI",
          "from .checks import health",
          "",
          "app = FastAPI()",
        ),
      },
      "main.py",
    );
    expect(content).toContain('@app.get("/health")\ndef opscrew_health():');
  });
});

describe("Flask", () => {
  it("adds the route inside an app factory, before the app is returned", async () => {
    const init = lines(
      "from flask import Flask",
      "",
      "from .db import db",
      "",
      "",
      "def create_app(config=None):",
      "    app = Flask(__name__)",
      "    app.config.from_mapping(config or {})",
      "    db.init_app(app)",
      "",
      "    from . import views",
      "",
      "    app.register_blueprint(views.bp)",
      "    return app",
    );
    const { edit, content } = await edited(
      {
        "myapp/__init__.py": init,
        "myapp/views.py": lines(
          "from flask import Blueprint",
          "",
          'bp = Blueprint("views", __name__)',
          "",
          "",
          '@bp.route("/")',
          "def index():",
          '    return "hello"',
        ),
        "wsgi.py": lines("from myapp import create_app", "", "app = create_app()"),
      },
      "myapp/__init__.py",
    );
    expect(edit).toMatchObject({ framework: "Flask", path: "myapp/__init__.py" });
    expect(content).toBe(
      lines(
        "from flask import Flask",
        "",
        "from .db import db",
        "",
        "",
        "def create_app(config=None):",
        "    app = Flask(__name__)",
        "",
        '    @app.route("/health")',
        "    def health():",
        '        return {"status": "ok"}',
        "",
        "    app.config.from_mapping(config or {})",
        "    db.init_app(app)",
        "",
        "    from . import views",
        "",
        "    app.register_blueprint(views.bp)",
        "    return app",
      ),
    );
  });

  it("keeps the file's quotes, tabs and Windows line endings", async () => {
    const text = [
      "from flask import Flask",
      "",
      "def create_app():",
      "\tapp = Flask(__name__)",
      "\t@app.route('/')",
      "\tdef index():",
      "\t\treturn 'hi'",
      "\treturn app",
      "",
    ].join("\r\n");
    const { content } = await edited({ "app.py": text }, "app.py");
    expect(content).toBe(
      [
        "from flask import Flask",
        "",
        "def create_app():",
        "\tapp = Flask(__name__)",
        "",
        "\t@app.route('/health')",
        "\tdef health():",
        "\t\treturn {'status': 'ok'}",
        "",
        "\t@app.route('/')",
        "\tdef index():",
        "\t\treturn 'hi'",
        "\treturn app",
        "",
      ].join("\r\n"),
    );
  });

  it("does not take a blueprint for the app, and says so when the app is built elsewhere", async () => {
    const edit = await healthRouteEdit(
      healthInput("generic", flask, {
        "views.py": lines("from flask import Blueprint", "", 'bp = Blueprint("views", __name__)'),
        "wsgi.py": lines("from company_web import make_app", "", "app = make_app()"),
      }),
    );
    expect(edit).toMatchObject({ action: "manual" });
    expect(edit.action === "manual" && edit.reason).toContain(
      "OpsCrew found no FastAPI, Flask, Quart, Starlette, Litestar, Sanic, Falcon, aiohttp, Bottle, Tornado or Pyramid app object in the app's code (it may be created in another module or package)",
    );
  });
});

describe("other Python frameworks", () => {
  it("Quart: an async route", async () => {
    const { content } = await edited(
      { "app.py": lines("from quart import Quart", "", "app = Quart(__name__)") },
      "app.py",
    );
    expect(content).toBe(
      lines(
        "from quart import Quart",
        "",
        "app = Quart(__name__)",
        "",
        "",
        '@app.route("/health")',
        "async def health():",
        '    return {"status": "ok"}',
      ),
    );
  });

  it("Starlette: a Route first in the routes list, the handler above the app", async () => {
    const { content } = await edited(
      {
        "app.py": lines(
          "from starlette.applications import Starlette",
          "from starlette.responses import PlainTextResponse",
          "from starlette.routing import Route",
          "",
          "",
          "async def homepage(request):",
          '    return PlainTextResponse("Hello")',
          "",
          "",
          "app = Starlette(",
          "    debug=False,",
          "    routes=[",
          '        Route("/", homepage),',
          "    ],",
          ")",
        ),
      },
      "app.py",
    );
    expect(content).toBe(
      lines(
        "from starlette.applications import Starlette",
        "from starlette.responses import JSONResponse",
        "from starlette.responses import PlainTextResponse",
        "from starlette.routing import Route",
        "",
        "",
        "async def homepage(request):",
        '    return PlainTextResponse("Hello")',
        "",
        "",
        "async def health(request):",
        '    return JSONResponse({"status": "ok"})',
        "",
        "",
        "app = Starlette(",
        "    debug=False,",
        "    routes=[",
        '        Route("/health", health),',
        '        Route("/", homepage),',
        "    ],",
        ")",
      ),
    );
  });

  it("Starlette: a routes variable, and add_route when the app gets no list", async () => {
    const { content } = await edited(
      {
        "app.py": lines(
          "from starlette.applications import Starlette",
          "from starlette.responses import JSONResponse",
          "from starlette.routing import Mount, Route",
          "",
          "routes = [Route('/', home), Mount('/static', app=static)]",
          "",
          "app = Starlette(routes=routes)",
        ),
      },
      "app.py",
    );
    expect(content).toContain(
      lines(
        "async def health(request):",
        "    return JSONResponse({'status': 'ok'})",
        "",
        "",
        "routes = [Route('/health', health), Route('/', home), Mount('/static', app=static)]",
      ),
    );
    const bare = await edited(
      {
        "app.py": lines(
          "from starlette.applications import Starlette",
          "",
          "app = Starlette()",
          'app.add_route("/", home)',
        ),
      },
      "app.py",
    );
    expect(bare.content).toBe(
      lines(
        "from starlette.applications import Starlette",
        "from starlette.responses import JSONResponse",
        "",
        "app = Starlette()",
        "",
        "",
        "async def health(request):",
        '    return JSONResponse({"status": "ok"})',
        "",
        "",
        'app.add_route("/health", health, methods=["GET"])',
        "",
        "",
        'app.add_route("/", home)',
      ),
    );
  });

  it("Litestar: an annotated handler registered on the app", async () => {
    const { content } = await edited(
      {
        "app.py": lines(
          "from litestar import Litestar, get",
          "",
          "",
          '@get("/")',
          "async def index() -> str:",
          '    return "Hello"',
          "",
          "",
          "app = Litestar(route_handlers=[index])",
        ),
      },
      "app.py",
    );
    expect(content).toContain(
      lines(
        "app = Litestar(route_handlers=[index])",
        "",
        "",
        '@get("/health")',
        "async def health() -> dict[str, str]:",
        '    return {"status": "ok"}',
        "",
        "",
        "app.register(health)",
      ),
    );
  });

  it("Sanic: imports its json response under another name when json is taken", async () => {
    const { content } = await edited(
      {
        "server.py": lines(
          "import json",
          "",
          "from sanic import Sanic",
          "from sanic.response import text",
          "",
          'app = Sanic("MyApp")',
        ),
      },
      "server.py",
    );
    expect(content).toBe(
      lines(
        "import json",
        "",
        "from sanic import Sanic",
        "from sanic.response import json as sanic_json",
        "from sanic.response import text",
        "",
        'app = Sanic("MyApp")',
        "",
        "",
        '@app.get("/health")',
        "async def health(request):",
        '    return sanic_json({"status": "ok"})',
      ),
    );
  });

  it("Falcon: a resource class, async for the ASGI app", async () => {
    const { content } = await edited(
      {
        "app.py": lines(
          "import falcon",
          "",
          "",
          "class ThingsResource:",
          "    def on_get(self, req, resp):",
          '        resp.media = {"things": []}',
          "",
          "",
          "app = falcon.App()",
          'app.add_route("/things", ThingsResource())',
        ),
      },
      "app.py",
    );
    expect(content).toContain(
      lines(
        "app = falcon.App()",
        "",
        "",
        "class HealthResource:",
        "    def on_get(self, req, resp):",
        '        resp.media = {"status": "ok"}',
        "",
        "",
        'app.add_route("/health", HealthResource())',
      ),
    );
    const asgi = await edited(
      { "asgi.py": lines("import falcon.asgi", "", "app = falcon.asgi.App()") },
      "asgi.py",
    );
    expect(asgi.content).toContain("    async def on_get(self, req, resp):\n");
  });

  it("aiohttp: a handler inside the app factory, with web.json_response", async () => {
    const { content } = await edited(
      {
        "server.py": lines(
          "from aiohttp import web",
          "",
          "",
          "async def hello(request):",
          '    return web.Response(text="Hello")',
          "",
          "",
          "def create_app():",
          "    app = web.Application()",
          '    app.add_routes([web.get("/", hello)])',
          "    return app",
          "",
          "",
          'if __name__ == "__main__":',
          "    web.run_app(create_app())",
        ),
      },
      "server.py",
    );
    expect(content).toContain(
      lines(
        "def create_app():",
        "    app = web.Application()",
        "",
        "    async def health(request):",
        '        return web.json_response({"status": "ok"})',
        "",
        '    app.router.add_get("/health", health)',
        "",
        '    app.add_routes([web.get("/", hello)])',
        "    return app",
      ),
    );
  });

  it("Bottle: a route on the Bottle app", async () => {
    const { content } = await edited(
      {
        "app.py": lines(
          "from bottle import Bottle, run",
          "",
          "app = Bottle()",
          "",
          "",
          '@app.route("/hello")',
          "def hello():",
          '    return "Hello World!"',
        ),
      },
      "app.py",
    );
    expect(content).toContain(
      lines(
        "app = Bottle()",
        "",
        "",
        '@app.route("/health")',
        "def health():",
        '    return {"status": "ok"}',
        "",
        "",
        '@app.route("/hello")',
      ),
    );
  });

  it("Tornado: a handler class and the first entry of the Application's handlers", async () => {
    const { content } = await edited(
      {
        "app.py": lines(
          "import asyncio",
          "",
          "import tornado.web",
          "",
          "",
          "class MainHandler(tornado.web.RequestHandler):",
          "    def get(self):",
          '        self.write("Hello, world")',
          "",
          "",
          "def make_app():",
          "    return tornado.web.Application([",
          '        (r"/", MainHandler),',
          "    ])",
          "",
          "",
          "async def main():",
          "    app = make_app()",
          "    app.listen(8888)",
          "    await asyncio.Event().wait()",
        ),
      },
      "app.py",
    );
    expect(content).toContain(
      lines(
        '        self.write("Hello, world")',
        "",
        "",
        "class HealthHandler(tornado.web.RequestHandler):",
        "    def get(self):",
        '        self.write({"status": "ok"})',
        "",
        "",
        "def make_app():",
        "    return tornado.web.Application([",
        '        (r"/health", HealthHandler),',
        '        (r"/", MainHandler),',
        "    ])",
      ),
    );
  });

  it("Pyramid: a JSON view and its route right after the Configurator", async () => {
    const { content } = await edited(
      {
        "app.py": lines(
          "from wsgiref.simple_server import make_server",
          "",
          "from pyramid.config import Configurator",
          "from pyramid.response import Response",
          "",
          "",
          "def hello_world(request):",
          '    return Response("Hello World!")',
          "",
          "",
          'if __name__ == "__main__":',
          "    with Configurator() as config:",
          '        config.add_route("hello", "/")',
          '        config.add_view(hello_world, route_name="hello")',
          "        app = config.make_wsgi_app()",
          '    server = make_server("0.0.0.0", 6543, app)',
          "    server.serve_forever()",
        ),
      },
      "app.py",
    );
    expect(content).toContain(
      lines(
        "def health(request):",
        '    return {"status": "ok"}',
        "",
        "",
        'if __name__ == "__main__":',
        "    with Configurator() as config:",
        '        config.add_route("health", "/health")',
        '        config.add_view(health, route_name="health", renderer="json")',
        '        config.add_route("hello", "/")',
      ),
    );
    const factory = await edited(
      {
        "app/__init__.py": lines(
          "from pyramid.config import Configurator",
          "",
          "",
          "def main(global_config, **settings):",
          "    config = Configurator(settings=settings)",
          "    config.scan()",
          "    return config.make_wsgi_app()",
        ),
      },
      "app/__init__.py",
    );
    expect(factory.content).toBe(
      lines(
        "from pyramid.config import Configurator",
        "",
        "",
        "def health(request):",
        '    return {"status": "ok"}',
        "",
        "",
        "def main(global_config, **settings):",
        "    config = Configurator(settings=settings)",
        '    config.add_route("health", "/health")',
        '    config.add_view(health, route_name="health", renderer="json")',
        "    config.scan()",
        "    return config.make_wsgi_app()",
      ),
    );
  });

  it("names the middleware the user should check", async () => {
    const edit = await healthRouteEdit(
      healthInput("fastapi", fastapi, {
        "main.py": lines(
          "from fastapi import FastAPI",
          "app = FastAPI()",
          "app.add_middleware(AuthMiddleware)",
        ),
      }),
    );
    expect(edit.action === "write" && edit.checks).toEqual([
      "Check that the middleware or request hooks in main.py do not redirect or protect /health: FastAPI runs them for every route, and the deploy health check calls it without a session.",
    ]);
  });
});
