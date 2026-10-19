import { describe, expect, it } from "vitest";
import { autoBuild, euCatalog, makeFacts, makeRequirements, nextPostgresFacts } from "../testing";
import { buildDesignOptions } from "./options";
import { optionToPlan } from "./plan";
import { releaseCommandNote } from "./release";

const NOW = new Date("2026-10-11T12:00:00.000Z");

const djangoFacts = (releaseCommand?: string, appDir = ".") =>
  makeFacts({
    name: "mysite",
    languages: ["python"],
    packageManager: "pip",
    frameworks: [{ name: "django", path: appDir }],
    appKind: "fullstack",
    port: 8000,
    build: releaseCommand === undefined ? {} : { releaseCommand },
    services: [{ kind: "postgres", evidence: ["dependency:psycopg"] }],
    appDir,
  });

async function planFor(facts: ReturnType<typeof makeFacts>) {
  const requirements = makeRequirements();
  const [option] = await buildDesignOptions({ facts, requirements, catalog: euCatalog() });
  if (!option) throw new Error("no option");
  return optionToPlan(option, {
    facts,
    requirements,
    now: NOW,
    codeChanges: [],
    build: autoBuild(facts),
  });
}

describe("release command in the plan", () => {
  it("carries the detected command into app.releaseCommand", async () => {
    const plan = await planFor(djangoFacts("python manage.py migrate --noinput"));
    expect(plan.app.releaseCommand).toBe("python manage.py migrate --noinput");
  });

  it("runs it from the image's folder for a Python app in a subfolder", async () => {
    const plan = await planFor(
      djangoFacts("cd backend && python manage.py migrate --noinput", "backend"),
    );
    expect(plan.app.releaseCommand).toBe("python manage.py migrate --noinput");
  });

  it("leaves it out when detection found none", async () => {
    const plan = await planFor(djangoFacts());
    expect("releaseCommand" in plan.app).toBe(false);
  });
});

describe("releaseCommandNote", () => {
  it("says which command runs, when, what a failure does and how to change it", () => {
    const note = releaseCommandNote({
      app: { releaseCommand: "python manage.py migrate --noinput" } as never,
      services: { postgres: true, redis: false },
    });
    expect(note?.warning).toBe(false);
    expect(note?.text).toContain("`python manage.py migrate --noinput`");
    expect(note?.text).toContain("before it takes traffic");
    expect(note?.text).toContain("previous version keeps serving");
    expect(note?.text).toContain("`app.releaseCommand` in opscrew/plan.yaml");
  });

  it("points to app.releaseCommand when a database has no detected command", () => {
    const note = releaseCommandNote({
      app: {} as never,
      services: { postgres: true, redis: false },
    });
    expect(note?.warning).toBe(false);
    expect(note?.text).toContain("no database migration command");
    expect(note?.text).toContain("app.releaseCommand");
  });

  it("keeps Prisma migrations for a Next.js standalone image, which holds the Prisma CLI (012)", async () => {
    const facts = nextPostgresFacts({
      build: { buildCommand: "npm run build", releaseCommand: "npx prisma migrate deploy" },
    });
    const plan = await planFor(facts);
    expect(plan.app.releaseCommand).toBe("npx prisma migrate deploy");
    const note = releaseCommandNote(plan, facts);
    expect(note?.warning).toBe(false);
    expect(note?.text).toContain("Every deploy runs `npx prisma migrate deploy`");
  });

  it("keeps Drizzle migrations for a Next.js standalone image, which holds drizzle-kit (012)", async () => {
    const facts = nextPostgresFacts({
      build: { buildCommand: "npm run build", releaseCommand: "npx drizzle-kit migrate" },
    });
    const plan = await planFor(facts);
    expect(plan.app.releaseCommand).toBe("npx drizzle-kit migrate");
    const note = releaseCommandNote(plan, facts);
    expect(note?.warning).toBe(false);
    expect(note?.text).toContain("app.releaseCommand");
  });

  it("plans a Node.js server's migration tool as detected", async () => {
    const facts = makeFacts({
      frameworks: [{ name: "express", path: "." }],
      port: 3000,
      build: {
        startCommand: "npm start",
        releaseCommand: "npx typeorm migration:run -d dist/data-source.js",
      },
      services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
    });
    const plan = await planFor(facts);
    expect(plan.app.releaseCommand).toBe("npx typeorm migration:run -d dist/data-source.js");
    expect(releaseCommandNote(plan, facts)?.warning).toBe(false);
  });

  it("warns when the image cannot run another stack's migrations (Rails in a Node.js image)", async () => {
    const facts = makeFacts({
      languages: ["javascript", "ruby"],
      frameworks: [
        { name: "express", path: "." },
        { name: "rails", path: "." },
      ],
      port: 3000,
      build: { startCommand: "npm start", releaseCommand: "bin/rails db:migrate" },
      services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
    });
    const plan = await planFor(facts);
    expect("releaseCommand" in plan.app).toBe(false);
    const note = releaseCommandNote(plan, facts);
    expect(note?.warning).toBe(true);
    expect(note?.text).toContain("`bin/rails db:migrate`");
    expect(note?.text).toContain("Ruby");
  });

  it("shows detection's note on migrations the app runs when it starts (not a warning)", async () => {
    const text =
      "Strapi updates the database schema itself when it starts, so OpsCrew plans no separate release command.";
    const facts = makeFacts({
      frameworks: [{ name: "express", path: "." }],
      port: 1337,
      build: { startCommand: "npm start", releaseNote: { text, atStartup: true } },
      services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
    });
    const plan = await planFor(facts);
    expect("releaseCommand" in plan.app).toBe(false);
    expect(releaseCommandNote(plan, facts)).toEqual({ warning: false, text });
  });

  it("warns with detection's note when the migration tool would be missing", async () => {
    const text =
      "OpsCrew found Alembic migrations, but alembic is only a development dependency, so the app's image does not install it.";
    const facts = djangoFacts();
    const withNote = { ...facts, build: { releaseNote: { text, atStartup: false } } };
    const plan = await planFor(withNote);
    expect(releaseCommandNote(plan, withNote)).toEqual({ warning: true, text });
  });

  it("warns about a skipped package script next to the command that runs", async () => {
    const text =
      "OpsCrew did not use the package.json script `migrate` because it does more than apply pending migrations (`migrate reset`).";
    const facts = makeFacts({
      frameworks: [{ name: "express", path: "." }],
      port: 3000,
      build: {
        startCommand: "npm start",
        releaseCommand: "npx prisma migrate deploy",
        releaseNote: { text, atStartup: false },
      },
      services: [{ kind: "postgres", evidence: ["dependency:pg"] }],
    });
    const plan = await planFor(facts);
    const note = releaseCommandNote(plan, facts);
    expect(note?.warning).toBe(true);
    expect(note?.text).toContain("Every deploy runs `npx prisma migrate deploy`");
    expect(note?.text).toContain(text);
  });

  it("says nothing without a command or a database", () => {
    expect(
      releaseCommandNote({ app: {} as never, services: { postgres: false, redis: true } }),
    ).toBeUndefined();
  });
});
