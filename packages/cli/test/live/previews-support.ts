/**
 * Pure helpers of feature 022's live test (`previews.test.ts`, docs/e2e.md "Previews"): the gate
 * and its variables, the files the throwaway copy of `examples/koa-knex` gets (a table, a seed, a
 * page that shows them and a marker each pull request changes), what the preview server and the
 * preview workflow answer (the page, the pull request's comment, `opscrew preview list --json`,
 * the workflow run's jobs, the pull request's deployment, the server command's last line), the
 * requests the restricted key must be refused, the shell commands that read a preview's leftovers
 * and the server's state, and the pull requests' image tags in GitHub Container Registry. No
 * network, no processes; unit-tested in `previews-support.test.ts`.
 */
import { posix } from "node:path";
import { APPS_DIR, EDGE_DIR, EDGE_PROJECT } from "@opscrew/iac-templates";
import { z } from "zod";
import { ENVIRONMENT_E2E_VARIABLES } from "./environments-support";
import { parseJsonOr } from "./support";

/** The test's gate. */
export const PREVIEWS_GATE = "OPSCREW_E2E_PREVIEWS";

/**
 * The variables of the test besides its gate: the environments test's, the classic
 * `read:packages` token the test lists the pull requests' images in GitHub Container Registry
 * with (GitHub's packages API refuses fine-grained tokens, research R5, S2), and the previews'
 * domain: a Cloudflare zone of the token's used only for previews (research R6).
 */
export const PREVIEWS_E2E_VARIABLES = [
  ...ENVIRONMENT_E2E_VARIABLES,
  "OPSCREW_E2E_GHCR_READ_TOKEN",
  "OPSCREW_E2E_PREVIEW_DOMAIN",
] as const;

/**
 * The address pull request `number`'s preview gets in the preview zone `zone`:
 * `https://pr-<n>-<random>.<zone>`, the random part 10 lower-case letters and digits.
 */
export function previewAddressPattern(number: number, zone: string): RegExp {
  return new RegExp(`^https://pr-${number}-[a-z0-9]{10}\\.${zone.replaceAll(".", "\\.")}$`);
}

/** The example: Koa with Postgres and Knex migrations (its release command), deployed live before. */
export const PREVIEWS_EXAMPLE = "koa-knex";

/** The preview environment's name. */
export const PREVIEW_ENV = "preview";

// ---------------------------------------------------------------------------------------------
// The throwaway copy's files.

/** The rows the seed writes; prod's database, never seeded, has none. */
export const SEED_ROWS = ["e2e-seeded-1", "e2e-seeded-2", "e2e-seeded-3"] as const;

/** The file each pull request changes, which the page shows: the commit a preview serves. */
export const MARKER_FILE = "e2e-marker.json";

/** The page that shows the marker and the seeded rows. */
export const E2E_PATH = "/e2e";

/**
 * The app's one own value for previews, which `.env.preview` gives (test values only) and the page
 * says it got; prod has none.
 */
export const PREVIEW_VALUE = "E2E_PREVIEW_VALUE";

/** `.env.preview`'s text, in the throwaway checkout only (gitignored, never committed). */
export function previewValues(value: string): string {
  return `${PREVIEW_VALUE}=${value}\n`;
}

/** The marker file's text for `marker`. */
export function markerJson(marker: string): string {
  return `${JSON.stringify({ marker })}\n`;
}

/** The line of the example's `index.js` the page's route goes before. */
const ROUTES_LINE = "app.use(router.routes()).use(router.allowedMethods());";

/**
 * The files the throwaway copy of `examples/koa-knex` gets on top of the example, by path: a Knex
 * migration creating `e2e_rows`, a seed in `seeds/` filling it with {@link SEED_ROWS} (so
 * detection finds `npx knex seed:run`), the marker `main`, and `index.js` (the example's
 * `exampleIndex`) with the route {@link E2E_PATH}, which answers the marker, the rows and whether
 * the app got {@link PREVIEW_VALUE}. Never
 * written into `examples/`. Throws when the example's routes line moved.
 */
export function e2eOverlay(exampleIndex: string): Record<string, string> {
  const at = exampleIndex.indexOf(ROUTES_LINE);
  if (at === -1 || exampleIndex.indexOf(ROUTES_LINE, at + 1) !== -1) {
    throw new Error(`examples/${PREVIEWS_EXAMPLE}/index.js no longer has one "${ROUTES_LINE}".`);
  }
  const route = [
    "// The live previews test: the marker of the commit this runs and the seeded rows.",
    `const e2eMarker = require("./${MARKER_FILE}");`,
    "",
    `router.get("${E2E_PATH}", async (ctx) => {`,
    '  const rows = await db("e2e_rows").orderBy("id").pluck("label");',
    '  ctx.set("Cache-Control", "no-store");',
    // Whether the app got the preview's value (never the value): OpsCrew asks every environment for
    // each value the app reads, so prod gets `prod` and a preview `preview-<random>`.
    `  const previewValue = (process.env.${PREVIEW_VALUE} ?? "").startsWith("preview-") ? "set" : "unset";`,
    "  ctx.body = { marker: e2eMarker.marker, rows, previewValue };",
    "});",
    "",
    "",
  ].join("\n");
  return {
    // The example ignores `.env` only; previews' values go in `.env.preview`, so every environment's
    // values file stays out of git, as the guide says.
    ".gitignore.fixture": "node_modules\n.env\n.env.*\n",
    "index.js": `${exampleIndex.slice(0, at)}${route}${exampleIndex.slice(at)}`,
    [MARKER_FILE]: markerJson("main"),
    "migrations/20261105000000_create_e2e_rows.js": [
      "// The live previews test's table, which only the seed fills.",
      "exports.up = function (knex) {",
      '  return knex.schema.createTable("e2e_rows", (table) => {',
      '    table.increments("id");',
      '    table.string("label").notNullable();',
      "  });",
      "};",
      "",
      "exports.down = function (knex) {",
      '  return knex.schema.dropTable("e2e_rows");',
      "};",
      "",
    ].join("\n"),
    "seeds/01_e2e_rows.js": [
      "// The live previews test's seed: each new preview runs it once.",
      "exports.seed = async function (knex) {",
      `  await knex("e2e_rows").insert(${JSON.stringify(SEED_ROWS.map((label) => ({ label })))});`,
      "};",
      "",
    ].join("\n"),
  };
}

const E2ePageSchema = z.object({
  marker: z.string(),
  rows: z.array(z.string()),
  previewValue: z.enum(["set", "unset"]),
});

/** What {@link E2E_PATH} answered: the marker and the seeded rows; throws on anything else. */
export function e2ePage(body: string): z.infer<typeof E2ePageSchema> {
  const json = parseJsonOr(body, () => {
    throw new Error(`${E2E_PATH} did not answer JSON.`);
  });
  const page = E2ePageSchema.safeParse(json);
  if (!page.success) throw new Error(`${E2E_PATH} answered JSON without a marker and rows.`);
  return page.data;
}

// ---------------------------------------------------------------------------------------------
// What `provision --env preview` says.

/** A fragment of the host plan's text where GitHub enforces no branch rules (GitHub Free, private). */
const NO_BRANCH_RULES = "can read every secret of the repository";

/**
 * Whether a `provision --env preview` output is the secrets check's refusal naming prod, with the
 * command that moves prod's secrets apart.
 */
export function refusedForProd(output: string): boolean {
  return (
    output.includes("A pull request could read the deploy key of prod") &&
    output.includes("opscrew provision --env prod")
  );
}

/**
 * What the previews host plan's text, in every output of `provision --env preview` with a cap of
 * 1, lacks or shouldn't have: the standing approval, the cap, the preview value's name; where
 * GitHub enforces no branch rules (`branchRules` false) the line saying any workflow can read every
 * secret, and only there; and no Workers token line (the app has no Workers site).
 */
export function previewsPlanProblems(output: string, branchRules: boolean): string[] {
  const wanted = [
    "GitHub Actions will create, update and delete previews of same-repository pull requests",
    "without asking again",
    "At most 1 preview at once",
    `(names only): ${PREVIEW_VALUE}`,
    ...(branchRules ? [] : [NO_BRANCH_RULES]),
  ];
  const unwanted = ["The Cloudflare token of", ...(branchRules ? [NO_BRANCH_RULES] : [])];
  return [
    ...wanted.filter((words) => !output.includes(words)).map((words) => `lacks "${words}"`),
    ...unwanted.filter((words) => output.includes(words)).map((words) => `has "${words}"`),
  ];
}

// ---------------------------------------------------------------------------------------------
// The preview workflow's comment, runs and deployment.

/** The marker the preview workflow starts its comment with (`<!-- opscrew-preview:<app> -->`). */
export function commentMarker(app: string): string {
  return `<!-- opscrew-preview:${app} -->`;
}

const CommentsSchema = z.array(
  z.object({ body: z.string().nullable().optional(), user: z.object({ login: z.string() }) }),
);

/**
 * The bodies of the preview workflow's comments for `app` among a pull request's comments
 * (`GET /repos/{r}/issues/{n}/comments`): written by `github-actions[bot]`, starting with
 * {@link commentMarker}.
 */
export function previewComments(json: unknown, app: string): string[] {
  const marker = commentMarker(app);
  return CommentsSchema.parse(json)
    .filter((comment) => comment.user.login === "github-actions[bot]")
    .map((comment) => comment.body ?? "")
    .filter((body) => body.startsWith(marker));
}

/** What a preview comment says, by the workflow's fixed texts. */
export type CommentState =
  | { state: "running" | "seed-failed"; address: string; commit: string }
  | { state: "cap"; count: number; cap: number }
  | { state: "removed" }
  | { state: "unknown" };

/** The state a preview comment's text gives (`unknown` for any other text). */
export function commentState(body: string): CommentState {
  const runs =
    /The preview of this pull request runs at (https:\/\/\S+) \(commit `([0-9a-f]{12}|unknown)`\)(\.|, but its seed command failed)/.exec(
      body,
    );
  if (runs?.[1] !== undefined && runs[2] !== undefined) {
    return {
      state: runs[3] === "." ? "running" : "seed-failed",
      address: runs[1],
      commit: runs[2],
    };
  }
  const cap =
    /No preview: the preview server already runs (\d+) previews, its limit of (\d+)\./.exec(body);
  if (cap?.[1] !== undefined && cap[2] !== undefined) {
    return { state: "cap", count: Number(cap[1]), cap: Number(cap[2]) };
  }
  if (body.includes("The preview was removed with its data")) return { state: "removed" };
  return { state: "unknown" };
}

/** The preview workflow's jobs, by the names it gives them. */
export const PREVIEW_JOBS = {
  build: "Build the image",
  deploy: "Start or update the preview",
  report: "Report on the pull request",
  remove: "Remove the preview",
} as const;

/** What a finished preview run must show: its conclusion and each named job's. */
export interface RunExpectation {
  conclusion: string;
  jobs: Partial<Record<keyof typeof PREVIEW_JOBS, string>>;
}

/** A preview run that creates or updates a preview. */
export const STARTED: RunExpectation = {
  conclusion: "success",
  jobs: { build: "success", deploy: "success", report: "success", remove: "skipped" },
};

/** A preview run of a new pull request while the cap is reached: the comment says so. */
export const CAPPED: RunExpectation = {
  conclusion: "failure",
  jobs: { build: "success", deploy: "failure", report: "success", remove: "skipped" },
};

/** A preview run of a closed pull request. */
export const REMOVED: RunExpectation = {
  conclusion: "success",
  jobs: { build: "skipped", deploy: "skipped", report: "skipped", remove: "success" },
};

/**
 * Why a finished preview run doesn't match `expected` (its conclusion, or a job's), naming
 * conclusions and job names only; `undefined` when it matches.
 */
export function previewRunProblem(
  run: { conclusion: string | null; jobs: readonly { name: string; conclusion: string | null }[] },
  expected: RunExpectation,
): string | undefined {
  const listed = run.jobs.map((job) => `${job.name}=${job.conclusion}`).join(", ");
  const wrong = Object.entries(expected.jobs).filter(([key, conclusion]) => {
    const name = PREVIEW_JOBS[key as keyof typeof PREVIEW_JOBS];
    return run.jobs.find((job) => job.name === name)?.conclusion !== conclusion;
  });
  if (run.conclusion === expected.conclusion && wrong.length === 0) return undefined;
  return `it ended ${run.conclusion} (expected ${expected.conclusion}); jobs: ${listed}`;
}

const StatusesSchema = z.array(
  z.object({ state: z.string(), environment_url: z.string().nullable().optional() }),
);

/**
 * The newest status of a deployment (`GET /repos/{r}/deployments/{id}/statuses`, newest first):
 * its state and the URL it gives ("View deployment"); `undefined` when it has none.
 */
export function deploymentStatus(json: unknown): { state: string; url: string } | undefined {
  const [newest] = StatusesSchema.parse(json);
  return newest === undefined
    ? undefined
    : { state: newest.state, url: newest.environment_url ?? "" };
}

// ---------------------------------------------------------------------------------------------
// `opscrew preview list --json`.

const PreviewListSchema = z.object({
  previews: z.array(
    z.object({
      number: z.number().int(),
      state: z.enum(["running", "seed-failed", "failed"]),
      commit: z.string().optional(),
      createdAt: z.string().optional(),
      updatedAt: z.string().optional(),
      digest: z.string().optional(),
      address: z.string(),
    }),
  ),
  count: z.number().int(),
  cap: z.number().int(),
});

/** The previews `opscrew preview list --json` printed; throws when it printed anything else. */
export function previewList(stdout: string): z.infer<typeof PreviewListSchema> {
  const json = parseJsonOr(stdout, () => {
    throw new Error("opscrew preview list --json did not print JSON.");
  });
  return PreviewListSchema.parse(json);
}

// ---------------------------------------------------------------------------------------------
// The restricted key.

/** The server command's last line, `opscrew-preview: <state> <detail>`, from its output. */
export function serverReply(stdout: string): { state: string; detail: string } | undefined {
  const lines = stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line !== "");
  const match = /^opscrew-preview: (\S+) (\S+)$/.exec(lines.at(-1) ?? "");
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { state: match[1], detail: match[2] };
}

/** One request the restricted key must be refused, and the refusal's detail. */
export interface KeyRefusal {
  what: string;
  /** The request (SSH's command); none: a terminal (`ssh -tt` without a command). */
  request?: string;
  detail: "request" | "number" | "image" | "command";
}

/**
 * The requests outside the contract (contracts/opscrew-preview.md) the restricted key sends in
 * the pass, each with the refusal's detail; `number` is a pull request's without a preview while
 * the cap is reached, so even a request that got past its check would change nothing.
 */
export function keyRefusals(number: number): KeyRefusal[] {
  const digest = "0".repeat(64);
  const commit = "0".repeat(40);
  return [
    { what: "a shell command", request: "cat /etc/passwd", detail: "command" },
    { what: "a shell command after a separator", request: "list; id", detail: "request" },
    { what: "gc, which only cron runs", request: "gc", detail: "command" },
    { what: "logs, never through the preview key", request: `logs ${number}`, detail: "command" },
    { what: "the number 0", request: "down 0", detail: "number" },
    { what: "a number with a letter", request: `down ${number}a`, detail: "number" },
    {
      what: "another image name",
      request: `up ${number} ghcr.io/opscrew-e2e/not-the-app@sha256:${digest} ${commit}`,
      detail: "image",
    },
    { what: "a terminal", detail: "request" },
  ];
}

// ---------------------------------------------------------------------------------------------
// The server, read with the deploy key.

/** The server's data folder (`/srv/data`), beside the apps' folders. */
const DATA_DIR = `${posix.dirname(APPS_DIR)}/data`;

/** Preview `<app>-pr-<n>`'s folder on the server. */
export function previewDir(app: string, number: number): string {
  return `${APPS_DIR}/${app}-pr-${number}`;
}

/**
 * A shell command printing one line per kind of what is left of preview `<app>-pr-<n>` on the
 * server: `container`, `volume` and `network` (one line each, by its Compose project's label),
 * `folder`, `data`, `site` (its Caddy site), `route` (kamal-proxy's), or `route-unreadable`. Prints
 * nothing when nothing is left; never a value.
 */
export function leftoversCommand(app: string, number: number): string {
  const name = `${app}-pr-${number}`;
  const label = `label=com.docker.compose.project=${name}`;
  return [
    `docker ps -aq --filter ${label} | sed 's/^.*$/container/'`,
    `docker volume ls -q --filter ${label} | sed 's/^.*$/volume/'`,
    `docker network ls -q --filter ${label} | sed 's/^.*$/network/'`,
    `if [ -e ${previewDir(app, number)} ]; then echo folder; fi`,
    `if [ -e ${DATA_DIR}/${name} ]; then echo data; fi`,
    `if [ -e ${EDGE_DIR}/sites/${name}.caddy ]; then echo site; fi`,
    `if routes="$(docker compose -p ${EDGE_PROJECT} -f ${EDGE_DIR}/compose.yaml exec -T kamal-proxy kamal-proxy list < /dev/null 2> /dev/null)"; then`,
    `  if printf '%s\\n' "$routes" | grep -qw -- ${name}; then echo route; fi`,
    "else",
    "  echo route-unreadable",
    "fi",
  ].join("\n");
}

/** The kinds {@link leftoversCommand} printed, each once, in order. */
export function leftovers(output: string): string[] {
  return [
    ...new Set(
      output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    ),
  ];
}

/**
 * A shell command printing what the restricted key's refusals must leave as it was: the apps'
 * folders, the number of lines in `previews.log`, every preview's `.preview` record, every
 * container (id, name, image, state), every volume, and the SHA-256 of every preview's
 * `secrets.env` (never its values).
 */
export function serverStateCommand(app: string): string {
  const recipe = `${APPS_DIR}/${app}`;
  return [
    `ls -1 ${APPS_DIR}`,
    `cat ${recipe}/previews.log 2> /dev/null | wc -l`,
    `for f in ${recipe}-pr-*/.preview; do if [ -f "$f" ]; then echo "$f"; cat "$f"; fi; done`,
    "docker ps -a --format '{{.ID}} {{.Names}} {{.Image}} {{.State}}' | sort",
    "docker volume ls -q | sort",
    `for f in ${recipe}-pr-*/secrets.env; do if [ -f "$f" ]; then sha256sum "$f"; fi; done`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// GitHub Container Registry.

const VersionsSchema = z.array(
  z.object({
    metadata: z
      .object({ container: z.object({ tags: z.array(z.string()) }).optional() })
      .optional(),
  }),
);

/**
 * The tags of pull requests `numbers` (`pr-<n>-<commit>` and `build-pr-<n>-<commit>`) among a
 * container package's versions (`GET /{users|orgs}/{owner}/packages/container/{name}/versions`).
 */
export function pullImageTags(json: unknown, numbers: readonly number[]): string[] {
  return VersionsSchema.parse(json).flatMap((version) =>
    (version.metadata?.container?.tags ?? []).filter((tag) => {
      const number = /^(?:build-)?pr-([1-9][0-9]{0,5})-[0-9a-f]{40}$/.exec(tag)?.[1];
      return number !== undefined && numbers.includes(Number(number));
    }),
  );
}
