import { afterEach, describe, expect, it } from "vitest";
import { detectProject } from "./index";
import { makeTree, removeTree } from "./test-helpers";

const roots: string[] = [];
async function tree(files: Record<string, string>): Promise<string> {
  const root = await makeTree(files, "release");
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTree));
});

async function releaseOf(files: Record<string, string>, appDir?: string) {
  const facts = await detectProject(await tree(files), appDir === undefined ? {} : { appDir });
  return facts.build.releaseCommand;
}

const DJANGO = {
  "requirements.txt": "Django==5.1\npsycopg[binary]\n",
  "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'mysite.settings')\n",
  "mysite/settings.py": "WSGI_APPLICATION = 'mysite.wsgi.application'\n",
  "mysite/wsgi.py": "application = get_wsgi_application()\n",
};

const FLASK_APP = "from flask import Flask\napp = Flask(__name__)\n";

describe("release command", () => {
  it("runs Django migrations", async () => {
    expect(await releaseOf(DJANGO)).toBe("python manage.py migrate --noinput");
  });

  it("prefers a Procfile release line over the framework's own", async () => {
    expect(
      await releaseOf({
        ...DJANGO,
        Procfile: "web: gunicorn mysite.wsgi\nrelease: python manage.py migrate && ./bin/seed\n",
      }),
    ).toBe("python manage.py migrate && ./bin/seed");
  });

  it("runs Django migrations from the folder that holds manage.py", async () => {
    const files = Object.fromEntries(
      Object.entries(DJANGO).map(([path, text]) =>
        path === "requirements.txt" ? [path, text] : [`src/${path}`, text],
      ),
    );
    expect(await releaseOf(files)).toBe("cd src && python manage.py migrate --noinput");
  });

  it("runs Django migrations in an app folder like the start command", async () => {
    const files = Object.fromEntries(
      Object.entries(DJANGO).map(([path, text]) => [`backend/${path}`, text]),
    );
    const facts = await detectProject(await tree({ ...files, "frontend/index.html": "<html>" }));
    expect(facts.appDir).toBe("backend");
    expect(facts.build.startCommand).toMatch(/^cd backend && gunicorn /);
    expect(facts.build.releaseCommand).toBe("cd backend && python manage.py migrate --noinput");
  });

  it("reads the Procfile release line of an app folder", async () => {
    const facts = await detectProject(
      await tree({
        "api/requirements.txt": "flask\ngunicorn\n",
        "api/app.py": FLASK_APP,
        "api/Procfile": "web: gunicorn app:app\nrelease: ./migrate.sh\n",
      }),
    );
    expect(facts.build.releaseCommand).toBe("cd api && ./migrate.sh");
  });

  it("upgrades Flask-Migrate apps that have a migrations folder", async () => {
    const base = { "requirements.txt": "Flask\nFlask-Migrate\n", "app.py": FLASK_APP };
    expect(await releaseOf({ ...base, "migrations/env.py": "" })).toBe("flask db upgrade");
    expect(await releaseOf(base)).toBeUndefined();
  });

  it("migrates Flask-DB apps that have a db folder", async () => {
    const base = { "requirements.txt": "Flask\nFlask-DB\n", "app.py": FLASK_APP };
    expect(await releaseOf({ ...base, "db/alembic.ini": "[alembic]\n" })).toBe("flask db migrate");
    expect(await releaseOf(base)).toBeUndefined();
  });

  it("names the Flask app from a committed .flaskenv (Flask-DB, like slog_cvrp_app)", async () => {
    expect(
      await releaseOf({
        "requirements.txt": "Flask==2.2.3\nFlask-DB==0.3.2\npython-dotenv\n",
        ".flaskenv": "FLASK_APP=app/project/__init__.py\nFLASK_DEBUG=0\n",
        "app/project/__init__.py":
          "from flask import Flask\n\ndef create_app():\n    return Flask(__name__)\n",
        "alembic.ini": "[alembic]\nscript_location = db/\n",
        "db/env.py": "",
      }),
    ).toBe("FLASK_APP=app/project/__init__.py flask db migrate");
  });

  it("names the Flask app from the gunicorn target of the start command", async () => {
    expect(
      await releaseOf({
        "requirements.txt": "Flask\nFlask-Migrate\ngunicorn\n",
        "run.py": FLASK_APP,
        Procfile: "web: gunicorn --workers 2 run:app --bind 0.0.0.0:$PORT\n",
        "migrations/env.py": "",
      }),
    ).toBe("FLASK_APP=run:app flask db upgrade");
    expect(
      await releaseOf({
        "requirements.txt": "Flask\nFlask-Migrate\ngunicorn\n",
        "myproject/__init__.py": "def create_app():\n    pass\n",
        Procfile: "web: gunicorn 'myproject:create_app()'\n",
        "migrations/env.py": "",
      }),
    ).toBe("FLASK_APP='myproject:create_app()' flask db upgrade");
  });

  it("lets Flask find an app.py app by itself", async () => {
    expect(
      await releaseOf({
        "requirements.txt": "Flask\nFlask-Migrate\n",
        "app.py": FLASK_APP,
        "migrations/env.py": "",
      }),
    ).toBe("flask db upgrade");
  });

  it("upgrades Alembic to head where alembic.ini lives", async () => {
    const api = {
      "requirements.txt": "fastapi\nuvicorn\nalembic\nsqlalchemy\n",
      "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
    };
    expect(await releaseOf({ ...api, "alembic.ini": "[alembic]\n" })).toBe("alembic upgrade head");
    expect(await releaseOf({ ...api, "db/alembic.ini": "[alembic]\n" })).toBe(
      "cd db && alembic upgrade head",
    );
    expect(await releaseOf(api)).toBeUndefined();
  });

  it("prefers Flask-Migrate over its own alembic.ini", async () => {
    expect(
      await releaseOf({
        "requirements.txt": "Flask\nFlask-Migrate\nalembic\n",
        "app.py": FLASK_APP,
        "migrations/env.py": "",
        "migrations/alembic.ini": "[alembic]\n",
      }),
    ).toBe("flask db upgrade");
  });

  it("deploys Prisma migrations of a Node server that keeps the Prisma CLI", async () => {
    const api = {
      "package.json": JSON.stringify({
        name: "api",
        scripts: { start: "node server.js" },
        dependencies: { express: "^5", "@prisma/client": "^6" },
        devDependencies: { prisma: "^6" },
      }),
      "package-lock.json": "{}",
      "server.js": "require('express')().listen(process.env.PORT)",
      "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n}\n',
    };
    expect(
      await releaseOf({ ...api, "prisma/migrations/0001_init/migration.sql": "CREATE TABLE a();" }),
    ).toBe("npx prisma migrate deploy");
    // No migrations folder: nothing to deploy.
    expect(await releaseOf(api)).toBeUndefined();
  });

  it("emits no Prisma command when the Prisma CLI is not a dependency", async () => {
    expect(
      await releaseOf({
        "package.json": JSON.stringify({
          name: "api",
          scripts: { start: "node server.js" },
          dependencies: { express: "^5", "@prisma/client": "^6" },
        }),
        "server.js": "require('express')().listen(3000)",
        "prisma/migrations/0001_init/migration.sql": "CREATE TABLE a();",
      }),
    ).toBeUndefined();
  });

  it("records Prisma migrations of a Next.js app (the plan decides whether the image runs them)", async () => {
    expect(
      await releaseOf({
        "package.json": JSON.stringify({
          name: "web",
          scripts: { build: "next build", start: "next start" },
          dependencies: { next: "^16", react: "^19", "@prisma/client": "^6" },
          devDependencies: { prisma: "^6" },
        }),
        "app/page.tsx": "export default function Page() { return null; }",
        "prisma/migrations/0001_init/migration.sql": "CREATE TABLE a();",
      }),
    ).toBe("npx prisma migrate deploy");
  });

  it("runs Prisma in a monorepo member's folder", async () => {
    const facts = await detectProject(
      await tree({
        "package.json": JSON.stringify({ name: "repo", private: true, workspaces: ["apps/*"] }),
        "package-lock.json": "{}",
        "apps/api/package.json": JSON.stringify({
          name: "api",
          scripts: { start: "node server.js" },
          dependencies: { express: "^5", "@prisma/client": "^6" },
          devDependencies: { prisma: "^6" },
        }),
        "apps/api/server.js": "require('express')().listen(3000)",
        "apps/api/prisma/migrations/0001_init/migration.sql": "CREATE TABLE a();",
      }),
    );
    expect(facts.appDir).toBe("apps/api");
    expect(facts.build.releaseCommand).toBe("cd apps/api && npx prisma migrate deploy");
  });

  it("emits no command for an app without migrations or a static site", async () => {
    expect(
      await releaseOf({
        "package.json": JSON.stringify({
          name: "api",
          scripts: { start: "node server.js" },
          dependencies: { express: "^5" },
        }),
        "server.js": "require('express')().listen(3000)",
      }),
    ).toBeUndefined();
    expect(
      await releaseOf({
        "package.json": JSON.stringify({
          name: "site",
          scripts: { build: "vite build" },
          devDependencies: { vite: "^7" },
        }),
        "index.html": "<html></html>",
        Procfile: "release: echo never\n",
      }),
    ).toBeUndefined();
  });
});
