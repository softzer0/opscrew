import { describe, expect, it } from "vitest";
import { nextChanges } from "./__fixtures__/repo";
import { PULL_REQUEST_FOOTER, renderPullRequestBody } from "./pr";

describe("renderPullRequestBody", () => {
  const changes = nextChanges().map((change, i) => ({
    ...change,
    status: i === 0 ? ("applied" as const) : i === 1 ? ("skipped" as const) : ("pending" as const),
  }));

  it("lists every change, the reports, scan counts and a checklist, ending with the footer", () => {
    const body = renderPullRequestBody({
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
    expect(body.trimEnd().endsWith(PULL_REQUEST_FOOTER)).toBe(true);
    expect(PULL_REQUEST_FOOTER).toBe("Opened by OpsCrew");
  });

  it("explains a missing scan and plain report paths without a repository", () => {
    const body = renderPullRequestBody({
      changes: [{ ...changes[0], status: "applied" } as (typeof changes)[number]],
      reports: ["opscrew/plan.yaml"],
    });
    expect(body).toContain("No scan report was found. Run `opscrew scan`");
    expect(body).toContain("- `opscrew/plan.yaml`");
    expect(body).not.toContain("Rotate every secret");
    expect(body).not.toContain('marked "to do"');
    expect(body.trimEnd().endsWith(PULL_REQUEST_FOOTER)).toBe(true);
  });

  it("marks the changes OpsCrew made itself", () => {
    const applied = changes.map((change) => ({ ...change, status: "applied" as const }));
    const body = renderPullRequestBody({
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

  it("is deterministic", () => {
    const input = { changes, reports: [], scanCounts: {} };
    expect(renderPullRequestBody(input)).toBe(renderPullRequestBody(input));
  });
});
