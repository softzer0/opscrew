import { describe, expect, it } from "vitest";
import { nextChanges } from "./__fixtures__/repo";
import { PULL_REQUEST_FOOTER, type PullRequestBodyInput, renderPullRequestBody } from "./pr";

describe("renderPullRequestBody", () => {
  const changes = nextChanges().map((change, i) => ({
    ...change,
    status: i === 0 ? ("applied" as const) : i === 1 ? ("skipped" as const) : ("pending" as const),
  }));
  /** A pull request body with the given fields over plain defaults. */
  const render = (input: Partial<PullRequestBodyInput>) =>
    renderPullRequestBody({
      changes,
      notes: {},
      reports: [],
      repo: { owner: "acme", repo: "shop" },
      branch: "opscrew/prepare-deploy",
      app: { name: "shop", port: 3000, healthPath: "/api/health" },
      addedDependencies: [],
      byOpsCrew: [],
      paths: {},
      ...input,
    });

  it("lists every change, the reports, scan counts and a checklist, ending with the footer", () => {
    const body = render({
      changes,
      notes: { dockerignore: "Already\n  had one." },
      scanCounts: { critical: 0, high: 2, low: 1 },
      reports: ["opscrew/ARCHITECTURE.md", "opscrew/plan.yaml"],
      repo: { owner: "acme", repo: "shop" },
      branch: "opscrew/prepare-deploy",
      app: { name: "shop", port: 3000, healthPath: "/api/health" },
      addedDependencies: ["zod@^4"],
    });

    for (const change of changes) expect(body).toContain(`\`${change.path}\``);
    expect(body).toContain("- [x] **Production Dockerfile** in `Dockerfile` (applied)");
    expect(body).toContain("(skipped)");
    expect(body).toContain("(to do)");
    expect(body).toContain("  - Notes: Already had one.");
    expect(body).toContain(
      "[`opscrew/plan.yaml`](https://github.com/acme/shop/blob/opscrew/prepare-deploy/opscrew/plan.yaml)",
    );
    expect(body).toContain("| Critical | High | Medium | Low | Info |");
    expect(body).toContain("| 0 | 2 | 0 | 1 | 0 |");
    expect(body).toContain("## Review checklist");
    expect(body).toContain("docker build -t shop .");
    expect(body).toContain("http://localhost:3000/api/health");
    expect(body).toContain("Rotate every secret");
    expect(body).toContain("`zod@^4`");
    expect(body).toContain('Finish the changes marked "to do"');
    // The health endpoint is still to do: say what that means for deploys.
    expect(body).toContain(
      "**Until GET /api/health answers 200, every deploy fails its health check and is rolled back.**",
    );
    expect(body.trimEnd().endsWith(PULL_REQUEST_FOOTER)).toBe(true);
    expect(PULL_REQUEST_FOOTER).toBe("Opened by OpsCrew");
  });

  it("says plainly that background jobs do not run yet, and only when there are some", () => {
    const note = "This app also runs background jobs with Celery. Run the worker yourself.";
    const body = render({ backgroundJobs: note });
    expect(body).toContain(`## Background jobs\n\n${note}`);
    expect(body.indexOf("## Background jobs")).toBeLessThan(body.indexOf("## Reports"));
    expect(render({})).not.toContain("Background jobs");
  });

  it("lists what detection noted about the app, and only when there is something", () => {
    const note = "Only the API side of this app is deployed; its web side is not served yet.";
    const body = render({ appNotes: [note] });
    expect(body).toContain(`## Notes

- ${note}`);
    expect(body.indexOf("## Notes")).toBeLessThan(body.indexOf("## Reports"));
    expect(render({})).not.toContain("## Notes");
  });

  it("says which migration command every deploy runs, and only when there is a note", () => {
    const note = "Every deploy runs `python manage.py migrate --noinput` (database migrations).";
    const body = render({ migrations: note });
    expect(body).toContain(`## Database migrations\n\n${note}`);
    expect(body.indexOf("## Database migrations")).toBeLessThan(body.indexOf("## Reports"));
    expect(render({})).not.toContain("migrations");
  });

  it("says nothing about failing deploys once the health endpoint is done", () => {
    const body = render({
      changes: changes.map((change) => ({ ...change, status: "applied" as const })),
      reports: [],
      app: { name: "shop", port: 3000, healthPath: "/api/health" },
    });
    expect(body).not.toContain("fails its health check");
  });

  it("explains a missing scan", () => {
    const body = render({
      changes: [{ ...changes[0], status: "applied" } as (typeof changes)[number]],
      reports: ["opscrew/plan.yaml"],
    });
    expect(body).toContain("No scan report was found. Run `opscrew scan`");
    expect(body).not.toContain("Rotate every secret");
    expect(body).not.toContain('marked "to do"');
    expect(body.trimEnd().endsWith(PULL_REQUEST_FOOTER)).toBe(true);
  });

  it("marks the changes OpsCrew made itself", () => {
    const applied = changes.map((change) => ({ ...change, status: "applied" as const }));
    const body = render({
      changes: applied,
      notes: { "build-config": 'OpsCrew set output: "standalone" in next.config.mjs.' },
      reports: [],
      byOpsCrew: ["dockerfile", "build-config"],
    });
    expect(body).toContain(
      "- [x] **Build configuration** in `next.config.mjs` (applied by OpsCrew): Reason for build-config.",
    );
    expect(body).toContain('  - Notes: OpsCrew set output: "standalone" in next.config.mjs.');
    expect(body).toContain("- [x] **Production Dockerfile** in `Dockerfile` (applied by OpsCrew)");
    expect(body).toContain("- [x] **Health endpoint** in `app/api/health/route.ts` (applied):");
  });

  it("names the file a change was really made in", () => {
    const applied = changes.map((change) => ({ ...change, status: "applied" as const }));
    const body = render({
      changes: applied,
      reports: [],
      byOpsCrew: ["health-endpoint"],
      paths: { "health-endpoint": "app/api/health/route.js" },
    });
    expect(body).toContain(
      "- [x] **Health endpoint** in `app/api/health/route.js` (applied by OpsCrew):",
    );
    expect(body).not.toContain("app/api/health/route.ts");
  });

  it("is deterministic", () => {
    expect(render({ scanCounts: {} })).toBe(render({ scanCounts: {} }));
  });
});
