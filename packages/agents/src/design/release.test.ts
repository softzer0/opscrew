import { describe, expect, it } from "vitest";
import { euCatalog, makeFacts, makeRequirements, nextPostgresFacts } from "./__fixtures__/catalog";
import { buildDesignOptions, optionToPlan, releaseCommandNote } from "./index";

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
  return optionToPlan(option, { facts, requirements, now: NOW, codeChanges: [] });
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

  it("warns that a Next.js standalone image cannot run Prisma migrations", async () => {
    const facts = nextPostgresFacts({
      build: { buildCommand: "npm run build", releaseCommand: "npx prisma migrate deploy" },
    });
    const plan = await planFor(facts);
    expect("releaseCommand" in plan.app).toBe(false);
    const note = releaseCommandNote(plan, facts);
    expect(note?.warning).toBe(true);
    expect(note?.text).toContain("Prisma migrations");
    expect(note?.text).not.toContain("no database migration command");
  });

  it("says nothing without a command or a database", () => {
    expect(
      releaseCommandNote({ app: {} as never, services: { postgres: false, redis: true } }),
    ).toBeUndefined();
  });
});
