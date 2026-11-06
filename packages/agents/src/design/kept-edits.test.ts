import type { DeployPlan, Migrations } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { sitePlan, testPlan } from "../testing";
import { keptEdits } from "./kept-edits";

const DJANGO = "python manage.py migrate --noinput";
const FOUND: Migrations = {
  tool: "django",
  status: "python manage.py showmigrations --plan",
  down: "python manage.py migrate {app} {name} --noinput",
};
const OWN: Migrations = { ...FOUND, status: "python manage.py showmigrations --plan -v 0" };

/** A server plan with this release command and down migrations. */
function plan(releaseCommand?: string, migrations?: Migrations): DeployPlan {
  const base = testPlan();
  return {
    ...base,
    app: {
      ...base.app,
      ...(releaseCommand === undefined ? {} : { releaseCommand }),
      ...(migrations === undefined ? {} : { migrations }),
    },
  };
}

describe("keptEdits: app.migrations", () => {
  it("keeps the user's own and names what analyze found", () => {
    const { plan: kept, lines } = keptEdits(plan(DJANGO, FOUND), undefined, plan(DJANGO, OWN));
    expect(kept.app.migrations).toEqual(OWN);
    expect(lines).toEqual([
      "Kept app.migrations (django: `python manage.py showmigrations --plan -v 0`, `python manage.py migrate {app} {name} --noinput`) from opscrew/plan.yaml; analyze found (django: `python manage.py showmigrations --plan`, `python manage.py migrate {app} {name} --noinput`). To use it, set app.migrations to that in opscrew/plan.yaml.",
    ]);

    const none = keptEdits(plan(DJANGO), undefined, plan(DJANGO, OWN));
    expect(none.plan.app.migrations).toEqual(OWN);
    expect(none.lines.join("\n")).toContain(
      "from opscrew/plan.yaml; analyze found none. To have rollbacks undo no migrations, remove app.migrations in opscrew/plan.yaml.",
    );
  });

  it("sets what analyze found when the plan had none, and says nothing when they agree", () => {
    const set = keptEdits(plan(DJANGO, FOUND), undefined, plan(DJANGO));
    expect(set.plan.app.migrations).toEqual(FOUND);
    expect(set.lines).toEqual([
      "Set app.migrations to (django: `python manage.py showmigrations --plan`, `python manage.py migrate {app} {name} --noinput`), which analyze found; opscrew/plan.yaml had none.",
    ]);
    expect(keptEdits(plan(DJANGO, FOUND), undefined, plan(DJANGO, FOUND)).lines).toEqual([]);
  });

  it("is removed with the release command on a site without a server", () => {
    const { plan: site, lines } = keptEdits(sitePlan(), undefined, plan(DJANGO, FOUND));
    expect(site.app.releaseCommand).toBeUndefined();
    expect(site.app.migrations).toBeUndefined();
    expect(lines).toEqual([
      `Left out app.releaseCommand \`${DJANGO}\` and app.migrations from opscrew/plan.yaml: a site without a server has no image to run it in before a deploy.`,
    ]);
  });

  it("follows the plan that holds the shared parts in another environment", () => {
    const shared = plan(DJANGO, FOUND);
    const staging = { ...plan(DJANGO, OWN), environment: undefined };
    const { plan: kept, lines } = keptEdits(plan(DJANGO, FOUND), staging, shared);
    expect(kept.app.migrations).toEqual(FOUND);
    expect(lines.join("\n")).toContain(
      "Set app.migrations to (django: `python manage.py showmigrations --plan`, `python manage.py migrate {app} {name} --noinput`) as in opscrew/plan.yaml: the environments built from the same code share it",
    );
  });
});
