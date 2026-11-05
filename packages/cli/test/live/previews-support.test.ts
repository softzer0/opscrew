/** Offline checks of the previews live test's pure helpers (`previews-support.ts`). No network. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { EXAMPLES } from "./harness";
import {
  CAPPED,
  commentMarker,
  commentState,
  deploymentStatus,
  e2eOverlay,
  e2ePage,
  keyRefusals,
  leftovers,
  leftoversCommand,
  MARKER_FILE,
  markerJson,
  PREVIEW_JOBS,
  PREVIEW_VALUE,
  PREVIEWS_E2E_VARIABLES,
  PREVIEWS_EXAMPLE,
  PREVIEWS_GATE,
  previewAddressPattern,
  previewComments,
  previewList,
  previewRunProblem,
  previewsPlanProblems,
  previewValues,
  pullImageTags,
  REMOVED,
  refusedForProd,
  SEED_ROWS,
  STARTED,
  serverReply,
  serverStateCommand,
} from "./previews-support";
import { missingVariables } from "./support";

const APP = "koa-knex-demo-preview";
const MARKER = commentMarker(APP);
const SHA = "a".repeat(40);

/** The example's own `index.js`. */
const exampleIndex = () => readFile(join(EXAMPLES, PREVIEWS_EXAMPLE, "index.js"), "utf8");

/** A preview run's jobs with these conclusions, in the workflow's order. */
function previewRun(conclusion: string, jobs: [string, string][]) {
  return { conclusion, jobs: jobs.map(([name, result]) => ({ name, conclusion: result })) };
}

describe("the gate", () => {
  it("needs the gate, the environments test's variables, the GHCR read token and the preview domain", () => {
    expect(missingVariables({}, PREVIEWS_GATE, PREVIEWS_E2E_VARIABLES)).toEqual([
      "OPSCREW_E2E_PREVIEWS=1",
      "OPSCREW_E2E_HCLOUD_TOKEN",
      "OPSCREW_E2E_GITHUB_REPO",
      "OPSCREW_E2E_GITHUB_TOKEN",
      "OPSCREW_E2E_CLOUDFLARE_TOKEN",
      "OPSCREW_E2E_DOMAIN",
      "OPSCREW_E2E_GHCR_READ_TOKEN",
      "OPSCREW_E2E_PREVIEW_DOMAIN",
    ]);
  });
});

describe("previewAddressPattern", () => {
  it("takes the pull request's number, 10 random lower-case letters and digits, in the zone", () => {
    const pattern = previewAddressPattern(7, "example.net");
    expect(pattern.test("https://pr-7-a1b2c3d4e5.example.net")).toBe(true);
    for (const address of [
      "https://pr-7.example.net",
      "https://pr-7-a1b2c3d4e.example.net",
      "https://pr-7-A1B2C3D4E5.example.net",
      "https://pr-17-a1b2c3d4e5.example.net",
      "https://pr-7-a1b2c3d4e5.shop.example.net",
      "https://pr-7-a1b2c3d4e5.exampleXnet",
      "http://pr-7-a1b2c3d4e5.example.net",
    ]) {
      expect(pattern.test(address), address).toBe(false);
    }
  });
});

describe("e2eOverlay", () => {
  it("adds the page's route once, before the example's routes are mounted", async () => {
    const index = await exampleIndex();
    const files = e2eOverlay(index);
    const changed = files["index.js"] as string;
    expect(changed.match(/router\.get\("\/e2e"/g)).toHaveLength(1);
    expect(changed.indexOf('router.get("/e2e"')).toBeLessThan(
      changed.indexOf("app.use(router.routes())"),
    );
    expect(changed.replace(/\/\/ The live previews test[\s\S]*?\}\);\n\n/, "")).toBe(index);
  });

  it("writes JavaScript that compiles, a seed of the rows, a migration and the marker", async () => {
    const files = e2eOverlay(await exampleIndex());
    expect(Object.keys(files).sort()).toEqual([
      ".gitignore.fixture",
      MARKER_FILE,
      "index.js",
      "migrations/20261105000000_create_e2e_rows.js",
      "seeds/01_e2e_rows.js",
    ]);
    for (const [path, text] of Object.entries(files)) {
      if (path.endsWith(".js")) expect(() => new Script(text), path).not.toThrow();
    }
    for (const row of SEED_ROWS) expect(files["seeds/01_e2e_rows.js"]).toContain(row);
    expect(files["migrations/20261105000000_create_e2e_rows.js"]).toContain(
      'createTable("e2e_rows"',
    );
    expect(JSON.parse(files[MARKER_FILE] as string)).toEqual({ marker: "main" });
    // The page reads the preview value with a default, so detection makes it optional for prod.
    expect(files["index.js"]).toContain(`process.env.${PREVIEW_VALUE} ?? ""`);
    expect(previewValues("v".repeat(32))).toBe(`${PREVIEW_VALUE}=${"v".repeat(32)}\n`);
  });

  it("refuses an index.js without the routes line", () => {
    expect(() => e2eOverlay("const app = 1;\n")).toThrow("no longer has one");
  });
});

describe("e2ePage", () => {
  it("reads the marker and the rows", () => {
    expect(e2ePage('{"marker":"a-1","rows":["e2e-seeded-1"],"previewValue":"set"}')).toEqual({
      marker: "a-1",
      rows: ["e2e-seeded-1"],
      previewValue: "set",
    });
    expect(JSON.parse(markerJson("b-2"))).toEqual({ marker: "b-2" });
  });

  it("refuses anything else without quoting it", () => {
    expect(() => e2ePage("<html>not found</html>")).toThrow("did not answer JSON");
    expect(() => e2ePage('{"visits":3}')).toThrow("without a marker and rows");
  });
});

describe("what provision --env preview says", () => {
  // T2209's text (packages/agents/src/provision/previews.test.ts, previews/setup.ts).
  const refusal = [
    "✗ A pull request could read the deploy key of prod: its deploy secrets are repository secrets, which every workflow in you/e2e can read, a pull request's included. Nothing was changed.",
    "  Run `opscrew provision --env prod` first, which moves its secrets into a GitHub environment only its branch can use, then run `opscrew provision --env preview` again.",
  ].join("\n");
  const plan = (extra: string) =>
    [
      "The standing approval: GitHub Actions will create, update and delete previews of same-repository pull requests within these bounds without asking again; each preview's data is deleted when it ends.",
      "  At most 1 preview at once; a preview with no push for 1 day is removed.",
      `  Preview values from .env.preview (names only): ${PREVIEW_VALUE}.`,
      extra,
    ].join("\n");
  const free =
    "GitHub enforces no branch rules on the environments of you/e2e (GitHub Free has none in private repositories), so any workflow, a pull request's included, can read every secret of the repository.";

  it("recognises the secrets check's refusal naming prod", () => {
    expect(refusedForProd(refusal)).toBe(true);
    expect(refusedForProd("A pull request could read the deploy key of staging")).toBe(false);
    expect(refusedForProd(plan(""))).toBe(false);
  });

  it("wants the standing approval and its bounds, and the Free line only where it applies", () => {
    expect(previewsPlanProblems(plan(""), true)).toEqual([]);
    expect(previewsPlanProblems(plan(free), false)).toEqual([]);
    expect(previewsPlanProblems(plan(free), true)).toEqual([
      'has "can read every secret of the repository"',
    ]);
    expect(previewsPlanProblems(plan(""), false)).toEqual([
      'lacks "can read every secret of the repository"',
    ]);
    expect(
      previewsPlanProblems(
        `${plan("")}\nThe Cloudflare token of site is a repository secret`,
        true,
      ),
    ).toEqual(['has "The Cloudflare token of"']);
    expect(previewsPlanProblems("", true)).toHaveLength(4);
  });
});

describe("previewComments and commentState", () => {
  const comment = (login: string, body: string) => ({ user: { login }, body });

  it("keeps the workflow's own comments for the app, by their marker", () => {
    const json = [
      comment("someone", `${MARKER}\n\nnot the bot`),
      comment("github-actions[bot]", `${commentMarker("other-preview")}\n\nanother app`),
      comment("github-actions[bot]", "a comment of another workflow"),
      comment("github-actions[bot]", `${MARKER}\n\nThe preview was removed with its data.`),
    ];
    expect(previewComments(json, APP)).toEqual([
      `${MARKER}\n\nThe preview was removed with its data.`,
    ]);
  });

  it("reads each state the pass waits for", () => {
    expect(
      commentState(
        `${MARKER}\n\nThe preview of this pull request runs at https://pr-7-a1b2c3d4e5.example.net (commit \`${SHA.slice(0, 12)}\`).`,
      ),
    ).toEqual({
      state: "running",
      address: "https://pr-7-a1b2c3d4e5.example.net",
      commit: SHA.slice(0, 12),
    });
    expect(
      commentState(
        `${MARKER}\n\nThe preview of this pull request runs at https://pr-7-a1b2c3d4e5.example.net (commit \`unknown\`), but its seed command failed, so its data may be missing.`,
      ),
    ).toMatchObject({ state: "seed-failed", commit: "unknown" });
    expect(
      commentState(
        `${MARKER}\n\nNo preview: the preview server already runs 1 previews, its limit of 1. Close or merge another pull request that has one, or wait until one has had no push for 1 days, then push again. Nothing running was stopped.`,
      ),
    ).toEqual({ state: "cap", count: 1, cap: 1 });
    expect(
      commentState(
        `${MARKER}\n\nThe preview was removed with its data: the pull request was closed or merged.`,
      ),
    ).toEqual({ state: "removed" });
    expect(commentState(`${MARKER}\n\nThe preview failed at pulling the image.`)).toEqual({
      state: "unknown",
    });
  });
});

describe("previewRunProblem", () => {
  const { build, deploy, report, remove } = PREVIEW_JOBS;
  const skipped = "Say why there is no preview";

  it("accepts a started, a capped and a removing run", () => {
    const started = previewRun("success", [
      [skipped, "skipped"],
      [build, "success"],
      [deploy, "success"],
      [report, "success"],
      [remove, "skipped"],
    ]);
    expect(previewRunProblem(started, STARTED)).toBeUndefined();
    const capped = previewRun("failure", [
      [build, "success"],
      [deploy, "failure"],
      [report, "success"],
      [remove, "skipped"],
    ]);
    expect(previewRunProblem(capped, CAPPED)).toBeUndefined();
    const removing = previewRun("success", [
      [build, "skipped"],
      [deploy, "skipped"],
      [report, "skipped"],
      [remove, "success"],
    ]);
    expect(previewRunProblem(removing, REMOVED)).toBeUndefined();
  });

  it("names the conclusions when a job or the run differs", () => {
    const failed = previewRun("failure", [
      [build, "success"],
      [deploy, "failure"],
      [report, "success"],
      [remove, "skipped"],
    ]);
    expect(previewRunProblem(failed, STARTED)).toBe(
      `it ended failure (expected success); jobs: ${build}=success, ${deploy}=failure, ${report}=success, ${remove}=skipped`,
    );
    const missing = previewRun("success", [[build, "success"]]);
    expect(previewRunProblem(missing, STARTED)).toContain("expected success");
  });
});

describe("deploymentStatus", () => {
  it("reads the newest status and its URL", () => {
    expect(
      deploymentStatus([
        { state: "inactive", environment_url: "" },
        { state: "success", environment_url: "https://pr-7-a1b2c3d4e5.example.net" },
      ]),
    ).toEqual({ state: "inactive", url: "" });
    expect(
      deploymentStatus([
        { state: "success", environment_url: "https://pr-7-a1b2c3d4e5.example.net" },
      ]),
    ).toEqual({ state: "success", url: "https://pr-7-a1b2c3d4e5.example.net" });
    expect(deploymentStatus([])).toBeUndefined();
  });
});

describe("previewList", () => {
  it("reads opscrew preview list --json", () => {
    const list = {
      previews: [
        {
          number: 7,
          state: "running",
          commit: SHA,
          createdAt: "2026-11-05T10:00:00.000Z",
          updatedAt: "2026-11-05T10:05:00.000Z",
          digest: `sha256:${"b".repeat(64)}`,
          address: "https://pr-7-a1b2c3d4e5.example.net",
        },
      ],
      count: 1,
      cap: 1,
    };
    expect(previewList(JSON.stringify(list))).toEqual(list);
  });

  it("refuses anything else", () => {
    expect(() => previewList("Previews: 1 of at most 1.")).toThrow("did not print JSON");
    expect(() => previewList('{"previews":[{"number":"7"}]}')).toThrow();
  });
});

describe("the restricted key", () => {
  it("reads the server command's last line, without a terminal's carriage returns", () => {
    expect(serverReply("opscrew-preview: refused command\r\n")).toEqual({
      state: "refused",
      detail: "command",
    });
    expect(serverReply(`7 running ${SHA} 1 2 -\nopscrew-preview: listed 1/1\n`)).toEqual({
      state: "listed",
      detail: "1/1",
    });
    expect(serverReply("Permission denied (publickey).\n")).toBeUndefined();
    expect(serverReply("")).toBeUndefined();
  });

  it("lists requests each refused by the contract's first checks", () => {
    const refusals = keyRefusals(8);
    expect(refusals.map((r) => [r.request, r.detail])).toEqual([
      ["cat /etc/passwd", "command"],
      ["list; id", "request"],
      ["gc", "command"],
      ["logs 8", "command"],
      ["down 0", "number"],
      ["down 8a", "number"],
      [`up 8 ghcr.io/opscrew-e2e/not-the-app@sha256:${"0".repeat(64)} ${"0".repeat(40)}`, "image"],
      [undefined, "request"],
    ]);
    // Each but the separator's is made only of what the contract lets through to its next check.
    for (const { request } of refusals.filter((r) => r.request !== "list; id")) {
      expect(request ?? "", String(request)).toMatch(/^[a-z0-9._/@: -]*$/);
    }
  });
});

describe("the server's commands", () => {
  it("reads every kind of leftover of the preview's own name", () => {
    const command = leftoversCommand(APP, 7);
    for (const part of [
      `label=com.docker.compose.project=${APP}-pr-7`,
      `/srv/apps/${APP}-pr-7`,
      `/srv/data/${APP}-pr-7`,
      `/srv/edge/sites/${APP}-pr-7.caddy`,
      "kamal-proxy list",
      `grep -qw -- ${APP}-pr-7`,
    ]) {
      expect(command).toContain(part);
    }
    expect(leftovers("container\ncontainer\nvolume\n\nsite\n")).toEqual([
      "container",
      "volume",
      "site",
    ]);
    expect(leftovers("\n")).toEqual([]);
  });

  it("reads the server's state without a value: secrets.env only by its digest", () => {
    const command = serverStateCommand(APP);
    expect(command).toContain(`/srv/apps/${APP}/previews.log`);
    expect(command).toContain(`sha256sum "$f"`);
    expect(command).not.toMatch(/cat [^\n]*secrets\.env/);
    expect(command).not.toContain("values.env");
  });
});

describe("pullImageTags", () => {
  it("lists only the given pull requests' preview tags", () => {
    const versions = [
      { metadata: { container: { tags: [`pr-7-${SHA}`] } } },
      { metadata: { container: { tags: [`build-pr-7-${SHA}`, "buildcache-preview"] } } },
      { metadata: { container: { tags: [`pr-8-${SHA}`] } } },
      { metadata: { container: { tags: [`pr-70-${SHA}`, "sha-123", "latest"] } } },
      { metadata: { container: { tags: [] } } },
      { metadata: {} },
    ];
    expect(pullImageTags(versions, [7])).toEqual([`pr-7-${SHA}`, `build-pr-7-${SHA}`]);
    expect(pullImageTags(versions, [7, 8])).toHaveLength(3);
    expect(pullImageTags(versions, [9])).toEqual([]);
  });
});
