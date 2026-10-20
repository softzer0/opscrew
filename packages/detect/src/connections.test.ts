/**
 * Connection settings under the app's own names (T832, FR-814): Redis planned from the libraries
 * and Celery brokers that use it, and Flask's prefixed config names found in committed env files.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  composeRedisEngines,
  composeUsesRedis,
  envFileSchemes,
  isCommittedEnvFile,
  prefixedConfigNames,
} from "./connections";
import { extractEnvReads } from "./env";
import { detectProject } from "./index";
import { scanSource } from "./sources";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "connections");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

const redisEvidence = async (root: string) =>
  (await detectProject(root)).services.find((s) => s.kind === "redis")?.evidence;

describe("committed env files", () => {
  it.each([
    [".env.example", true],
    ["app/.env.sample", true],
    [".env.template", true],
    ["docker/dev/.env", true],
    ["docker/.env.prod", true],
    ["deploy/docker/.env", true],
    ["config/prod.env", true],
    ["app.env", true],
    [".env", false],
    [".env.local", false],
    [".flaskenv", false],
    ["src/environment.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(isCommittedEnvFile(path)).toBe(expected);
  });

  it("reports the kind of URL each variable holds, never the values", () => {
    const text = [
      "# CELERY_BROKER_URL=amqp://commented",
      "CELERY_BROKER_URI=redis://redis:6379/0",
      "export CACHE='rediss://cache:6380'",
      'DATABASE_URI="postgresql+psycopg2://user@db/app"',
      "CELERY_RESULT_BACKEND=rpc://",
      "RESULTS=db+postgresql://db/app",
      "BROKER_URL=amqp://guest@rabbit//",
      "DB_URL=mysql://db/app",
      "SITE_URL=https://example.com",
      "PLAIN=hello",
    ].join("\n");
    expect(Object.fromEntries(envFileSchemes(text))).toEqual({
      CELERY_BROKER_URI: "redis",
      CACHE: "redis",
      DATABASE_URI: "postgres",
      CELERY_RESULT_BACKEND: "other",
      RESULTS: "other",
      BROKER_URL: "amqp",
      DB_URL: "mysql",
    });
  });

  it("sees a Redis service or a Redis URL in a compose file", () => {
    expect(composeUsesRedis("services:\n  web:\n    image: x\n  redis:\n    image: other\n")).toBe(
      true,
    );
    expect(composeUsesRedis("services:\n  cache:\n    image: redis:7-alpine\n")).toBe(true);
    expect(composeUsesRedis('services:\n  cache:\n    image: "bitnami/redis:7.2"\n')).toBe(true);
    expect(
      composeUsesRedis("services:\n  web:\n    environment:\n      - BROKER=redis://cache\n"),
    ).toBe(true);
    expect(composeUsesRedis("services:\n  db:\n    image: postgres:16\n")).toBe(false);
    expect(composeUsesRedis("services:\n  web:\n    image: myredisproxy:1\n")).toBe(false);
    // Dragonfly and KeyDB speak Redis's protocol.
    expect(composeUsesRedis("services:\n  kv:\n    image: eqalpha/keydb:latest\n")).toBe(true);
    expect(
      composeUsesRedis(
        "services:\n  kv:\n    image: docker.dragonflydb.io/dragonflydb/dragonfly\n",
      ),
    ).toBe(true);
  });

  it("names the Redis-protocol engines a compose file runs, by their images", () => {
    const engines = (image: string) =>
      composeRedisEngines(`services:\n  kv:\n    image: ${image}\n`);
    expect(engines("redis:8-alpine")).toEqual(["redis"]);
    expect(engines('"docker.io/library/redis:7.2"')).toEqual(["redis"]);
    expect(engines("redis@sha256:abc")).toEqual(["redis"]);
    expect(engines("dragonflydb/dragonfly:v1.30")).toEqual(["dragonfly"]);
    expect(engines("docker.dragonflydb.io/dragonflydb/dragonfly")).toEqual(["dragonfly"]);
    expect(engines("eqalpha/keydb:x86_64_v6.3.4")).toEqual(["keydb"]);
    // Bitnami's Redis and Redis Stack are Redis too, from any registry; Valkey and others are not.
    expect(engines("bitnami/redis:7.2")).toEqual(["redis"]);
    expect(engines("docker.io/bitnami/redis:7.2")).toEqual(["redis"]);
    expect(engines("redis/redis-stack:7.4.0-v1")).toEqual(["redis"]);
    expect(engines("redis/redis-stack-server:latest")).toEqual(["redis"]);
    expect(engines("registry.example.com:5000/redis:7")).toEqual(["redis"]);
    expect(engines("redis/redis-insight:2")).toEqual([]);
    expect(engines("bitnami/redis-sentinel:7")).toEqual([]);
    expect(engines("valkey/valkey:8")).toEqual([]);
    expect(engines("myredisproxy:1")).toEqual([]);
    expect(
      composeRedisEngines(
        "services:\n  a:\n    image: eqalpha/keydb\n  b:\n    image: redis:7\n  # image: dragonflydb/dragonfly\n",
      ),
    ).toEqual(["keydb", "redis"]);
  });

  it("keeps names with the prefix, minus Flask's own CLI settings", () => {
    const names = [
      "FLASK_APP",
      "FLASK_DEBUG",
      "FLASK_ENV",
      "FLASK_RUN_PORT",
      "FLASK_SECRET_KEY",
      "FLASK_MAIL_SERVER",
      "FLASKY",
      "MYAPP_TOKEN",
      "OTHER",
    ];
    expect(prefixedConfigNames(names, ["FLASK"])).toEqual([
      "FLASK_MAIL_SERVER",
      "FLASK_SECRET_KEY",
    ]);
    expect(prefixedConfigNames(names, ["MYAPP"])).toEqual(["MYAPP_TOKEN"]);
    expect(prefixedConfigNames(names, [])).toEqual([]);
  });
});

describe("source signals", () => {
  it("finds from_prefixed_env calls and their prefix", () => {
    expect(scanSource("app.config.from_prefixed_env()\n").configPrefixes).toEqual(["FLASK"]);
    expect(scanSource('app.config.from_prefixed_env("MYAPP")\n').configPrefixes).toEqual(["MYAPP"]);
    expect(
      scanSource("app.config.from_prefixed_env(prefix='SHOP', loads=json.loads)\n").configPrefixes,
    ).toEqual(["SHOP"]);
    expect(scanSource("app.config.from_prefixed_env(loads=str)\n").configPrefixes).toEqual([
      "FLASK",
    ]);
    // A computed prefix cannot be resolved: nothing is guessed.
    expect(scanSource("app.config.from_prefixed_env(PREFIX)\n").configPrefixes).toEqual([]);
    expect(scanSource("app.config.from_prefixed_env(prefix=name)\n").configPrefixes).toEqual([]);
    expect(scanSource("app.config.from_object(Config)\n").configPrefixes).toEqual([]);
  });

  it("finds the prefix keyword anywhere in the arguments", () => {
    const prefixes = (call: string) => scanSource(`app.config.${call}\n`).configPrefixes;
    expect(prefixes('from_prefixed_env(loads=json.loads, prefix="APP")')).toEqual(["APP"]);
    expect(
      prefixes("from_prefixed_env(\n    loads=partial(parse, strict=True),\n    prefix='SHOP',\n)"),
    ).toEqual(["SHOP"]);
    expect(prefixes("from_prefixed_env(loads=partial(parse, strict=True))")).toEqual(["FLASK"]);
    expect(prefixes('from_prefixed_env("APP", loads=json.loads)')).toEqual(["APP"]);
  });

  it("treats a None default compared with a literal as safe to leave unset", () => {
    expect(
      extractEnvReads("x = 'Dev' if environ.get('FLASK_ENV', None) == 'development' else 'P'"),
    ).toEqual([{ name: "FLASK_ENV", hasDefault: true }]);
    expect(extractEnvReads('x = os.getenv("MODE_FLAG", None) or "a"')).toEqual([
      { name: "MODE_FLAG", hasDefault: true },
    ]);
    expect(extractEnvReads('x = os.environ.get("TOKEN_X", None)\n')).toEqual([
      { name: "TOKEN_X", hasDefault: false },
    ]);
  });
});

describe("Redis planned from the libraries that use it", () => {
  it.each([
    ["flask-redis==0.4.0", "dependency:flask-redis"],
    ["django-redis>=5", "dependency:django-redis"],
    ["rq", "dependency:rq"],
  ])("%s", async (requirement, evidence) => {
    const root = await tree({ "requirements.txt": `flask==3.1.0\n${requirement}\n` });
    expect(await redisEvidence(root)).toEqual([evidence]);
  });

  it("plans Redis for redis-om on npm and PyPI, which needs Redis's own data types", async () => {
    const npm = await tree({
      "package.json": JSON.stringify({ name: "x", dependencies: { "redis-om": "^0.4" } }),
    });
    const evidence = ["dependency:redis-om", "redis-modules:redis-om"];
    expect(await redisEvidence(npm)).toEqual(evidence);
    const pypi = await tree({ "requirements.txt": "flask==3.1.0\nredis-om\n" });
    expect(await redisEvidence(pypi)).toEqual(evidence);
  });

  it("plans Redis for Celery with a Redis broker in a committed env file", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\ncelery==5.4.0\n",
      "app/tasks.py": "import os\nbroker = os.environ['CELERY_BROKER_URI']\n",
      "docker/dev/.env": "CELERY_BROKER_URI=redis://redis:6379/0\n",
    });
    expect(await redisEvidence(root)).toEqual(["config:redis-broker"]);
  });

  it("plans Redis for Celery with a Redis service in a committed compose file", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\ncelery==5.4.0\n",
      "docker-compose.yml": "services:\n  web:\n    build: .\n  redis:\n    image: redis:7\n",
    });
    // The image is Redis's own, so design runs Redis 8.
    expect(await redisEvidence(root)).toEqual(["compose-image:redis", "compose:redis"]);
  });

  it("does not plan Redis for Celery with another broker", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\ncelery==5.4.0\n",
      ".env.example": "CELERY_BROKER_URL=amqp://guest@rabbit//\n",
      "docker-compose.yml": "services:\n  rabbit:\n    image: rabbitmq:4\n",
    });
    expect(await redisEvidence(root)).toBeUndefined();
    // The example's scheme is kept (never the value), so `design` leaves the broker alone.
    const facts = await detectProject(root);
    expect(facts.envVars).toEqual([
      {
        name: "CELERY_BROKER_URL",
        files: [".env.example"],
        clientExposed: false,
        secretLikely: false,
        urlScheme: "amqp",
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain("rabbit//");
  });

  it("marks a variable whose committed files disagree on the URL kind as other", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\n",
      ".env.example": "BROKER_URL=redis://cache\n",
      "docker/.env": "BROKER_URL=amqp://rabbit\n",
      "app.py": "import os\nos.environ['BROKER_URL']\n",
    });
    expect((await detectProject(root)).envVars[0]?.urlScheme).toBe("other");
  });

  it("ignores a compose Redis service when nothing in the app uses Redis", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\n",
      "docker-compose.yml": "services:\n  redis:\n    image: redis:7\n",
    });
    expect(await redisEvidence(root)).toBeUndefined();
  });
});

describe("Flask prefixed config", () => {
  const app = (call: string) =>
    [
      "from flask import Flask",
      "def create_app():",
      "    app = Flask(__name__)",
      `    app.config.${call}`,
      "    return app",
    ].join("\n");

  it("adds the prefixed names listed in committed env files, by name only", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\n",
      "app/__init__.py": app("from_prefixed_env()"),
      "docker/dev/.env": [
        "POSTGRES_USER=app",
        "FLASK_APP=app",
        "FLASK_SECRET_KEY=changeme",
        "FLASK_MAIL_SERVER=smtp.example.com",
        "FLASK_MAIL_PASSWORD=",
        "FLASK_REDIS_URL=redis://redis:6379/0",
      ].join("\n"),
      ".env.example": "FLASK_FRONTEND_URL=http://localhost:3000\n",
    });
    const facts = await detectProject(root);
    expect(facts.envVars).toEqual([
      {
        name: "FLASK_FRONTEND_URL",
        files: [".env.example"],
        clientExposed: false,
        secretLikely: false,
      },
      {
        name: "FLASK_MAIL_PASSWORD",
        files: ["docker/dev/.env"],
        clientExposed: false,
        secretLikely: true,
      },
      {
        name: "FLASK_MAIL_SERVER",
        files: ["docker/dev/.env"],
        clientExposed: false,
        secretLikely: false,
      },
      {
        name: "FLASK_REDIS_URL",
        files: ["docker/dev/.env"],
        clientExposed: false,
        secretLikely: false,
        urlScheme: "redis",
      },
      {
        name: "FLASK_SECRET_KEY",
        files: ["docker/dev/.env"],
        clientExposed: false,
        secretLikely: true,
      },
    ]);
    expect(JSON.stringify(facts)).not.toContain("changeme");
    expect(JSON.stringify(facts)).not.toContain("smtp.example.com");
  });

  it("uses a custom prefix", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\n",
      "app.py": app('from_prefixed_env(prefix="SHOP")'),
      "config/prod.env": "SHOP_API_TOKEN=\nFLASK_SECRET_KEY=\n",
    });
    expect((await detectProject(root)).envVars.map((v) => v.name)).toEqual(["SHOP_API_TOKEN"]);
  });

  it("adds nothing from env files without from_prefixed_env", async () => {
    const root = await tree({
      "requirements.txt": "flask==3.1.0\n",
      "app.py": app("from_object('config')"),
      "docker/dev/.env": "FLASK_SECRET_KEY=\n",
    });
    expect((await detectProject(root)).envVars).toEqual([]);
  });
});
