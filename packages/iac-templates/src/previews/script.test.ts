import { spawnSync } from "node:child_process";
import { statSync, utimesSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { APP_ZONE_BASE, BASE, directPreview, IMAGE_NAME, previewPlan } from "./__fixtures__/plans";
import {
  commit,
  image,
  PreviewServer,
  type RunResult,
  shWorks,
  TOKEN,
  VALUES,
} from "./__fixtures__/server";

/*
 * opscrew-preview under sh against a fake preview server (shims for docker, kamal-proxy and flock):
 * one test per row of its contract. A full up runs the real start script, so a test can take tens
 * of seconds under Git for Windows on a busy machine.
 */

/** Postgres, a worker, cron, a release command and a seed. */
const FULL = previewPlan();
/** Only the app, its release command and a seed: fewer containers to start. */
const LEAN = previewPlan({ postgres: false, processes: false });

/** Preview `n`'s address on `s`, from the random part its `.preview` keeps. */
const HOST = (s: PreviewServer, n: number) => `pr-${n}-${s.previewFields(n).random}.${BASE}`;
/** The random part {@link existing} gives preview `n`. */
const RANDOM = (n: number) => `r${String(n).padStart(9, "0")}`;
/** An address's random part. */
const RANDOM_PART = /^[a-z0-9]{10}$/;
const DAY = 86_400;
const NOW = () => Math.floor(Date.now() / 1000);
const POSIX = process.platform !== "win32";

let servers: PreviewServer[] = [];
function server(plan = LEAN): PreviewServer {
  const made = new PreviewServer(plan);
  servers.push(made);
  return made;
}
afterEach(() => {
  for (const made of servers) made.remove();
  servers = [];
});

/** Only the script's last line, with the exit code. */
function only(result: RunResult, line: string, status: number): void {
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status,
    stdout: `opscrew-preview: ${line}\n`,
    stderr: "",
  });
}

/**
 * Preview `n` as an earlier up left it, without running one: its folder with `.preview` (unless
 * `preview` is false) and its random part (`random`, default {@link RANDOM}), its app container,
 * network and volume, its route and site, and its data.
 */
function existing(
  s: PreviewServer,
  n: number,
  o: {
    state?: string;
    updated?: number;
    created?: number;
    preview?: boolean;
    random?: string;
  } = {},
): void {
  const name = `${s.app}-pr-${n}`;
  const dir = s.preview(n);
  const host = `pr-${n}-${o.random ?? RANDOM(n)}.${BASE}`;
  s.write(`${dir}/compose.yaml`, `name: ${name}\n`);
  if (o.preview !== false) {
    s.write(
      `${dir}/.preview`,
      [
        `state=${o.state ?? "running"}`,
        `commit=${commit(String(n % 10))}`,
        `digest=sha256:${String(n % 10).repeat(64)}`,
        `created=${o.created ?? NOW() - DAY}`,
        `updated=${o.updated ?? NOW() - 60}`,
        `random=${o.random ?? RANDOM(n)}`,
        "",
      ].join("\n"),
    );
  }
  s.write(`${dir}/.lock`, "");
  s.write(`${dir}/.seeded`, "");
  s.write(`${dir}/secrets.env`, "db-password=00\n", 0o600);
  s.write(`${s.work}/srv/edge/sites/${name}.caddy`, `${host} {\n}\n`);
  s.write(`${s.work}/srv/edge/compose.yaml`, "name: opscrew-edge\n");
  s.write(`${s.work}/state/routes/${name}`, `${name}-app-${n}:3000 ${host}\n`);
  s.write(`${s.work}/srv/data/${name}/db/PG_VERSION`, "17\n");
  const state = (file: string, line: string) =>
    s.write(`${s.work}/state/${file}`, `${s.state(file)}${line}\n`);
  state("containers", `c${n} ${name} app ${image("a")} running ${name}-app-${n}`);
  state("containers", `c${n}0 ${name} db image-of-db running ${name}-db-${n}0`);
  state("networks", `${name}_internal ${name}`);
  state("volumes", `${name}_sqlite ${name}`);
}

/** Everything of preview `n` is gone: folder, data, site, route, containers, networks, volumes. */
function gone(s: PreviewServer, n: number): void {
  const name = `${s.app}-pr-${n}`;
  expect(s.read(`${s.preview(n)}/.preview`)).toBeUndefined();
  expect(() => statSync(s.preview(n))).toThrow();
  expect(() => statSync(`${s.work}/srv/data/${name}`)).toThrow();
  expect(s.read(`${s.work}/srv/edge/sites/${name}.caddy`)).toBeUndefined();
  expect(s.state(`routes/${name}`)).toBe("");
  for (const file of ["containers", "networks", "volumes"]) {
    expect(s.state(file)).not.toContain(name);
  }
}

/** The paths below `work` that `after` added, removed or changed since `before`, sorted. */
function changed(
  before: Record<string, string>,
  after: Record<string, string>,
  work: string,
): string[] {
  const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...paths]
    .filter((path) => before[path] !== after[path])
    .map((path) => path.slice(work.length + 1))
    .sort();
}

/** A previews.log line: the time, the command and number, the caller and the state. */
const logLine = (command: string, n: number, caller: string, state: string) =>
  new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ ${command} ${n} ${caller} ${state}$`);

/** No token, preview value or generated value in what the script printed or logged. */
function noLeak(s: PreviewServer, results: readonly RunResult[], extra: readonly string[] = []) {
  const generated = (s.read(`${s.preview(42)}/secrets.env`) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf("=") + 1));
  const secrets = [TOKEN, ...Object.values(VALUES), ...generated, ...extra];
  const outputs = [
    ...results.flatMap((result) => [result.stdout, result.stderr]),
    s.read(`${s.recipe}/previews.log`) ?? "",
    ...["docker.log", "kamal.log", "flock.log"].map((file) => s.state(file)),
  ].join("\n");
  for (const secret of secrets) expect(outputs).not.toContain(secret);
}

describe.skipIf(!shWorks())("opscrew-preview (sh)", { timeout: 300_000 }, () => {
  describe("up", () => {
    it("through the preview key creates the preview from the recipe and prints only where it runs", () => {
      const s = server(FULL);
      const result = s.up(42);
      const random = s.previewFields(42).random ?? "";
      expect(random).toMatch(RANDOM_PART);
      only(result, `running pr-42-${random}.${BASE}`, 0);

      // Its folder is the template filled in: what OpsCrew renders for shop-preview-pr-42 at its
      // address with the values generated for it, the app's env file after the user's preview
      // values.
      const secrets = Object.fromEntries(
        (s.read(`${s.preview(42)}/secrets.env`) ?? "")
          .split("\n")
          .filter(Boolean)
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      expect(Object.keys(secrets).sort()).toEqual([
        "APP_KEY",
        "SECRET_KEY_BASE",
        "db-password",
        "garage-key-id",
      ]);
      expect(secrets["db-password"]).toMatch(/^[0-9a-f]{64}$/);
      expect(secrets.SECRET_KEY_BASE).toMatch(/^[0-9a-f]{128}$/);
      expect(secrets.APP_KEY).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
      expect(secrets["garage-key-id"]).toMatch(/^GK[0-9a-f]{24}$/);
      const direct = directPreview(FULL, 42, random, (name) => secrets[name] ?? "");
      for (const [path, content] of Object.entries(direct)) {
        if (path === "env/app.env") {
          const values = Object.entries(VALUES).map(([name, value]) => `${name}=${value}`);
          expect(s.read(`${s.preview(42)}/app.env`)).toBe(`${values.join("\n")}\n${content}`);
        } else {
          expect(s.read(`${s.preview(42)}/${path.replace(/^env\//, "")}`), path).toBe(content);
        }
      }
      if (POSIX) {
        for (const file of ["secrets.env", "app.env", "db.env", "up.log"]) {
          expect(statSync(`${s.preview(42)}/${file}`).mode & 0o777, file).toBe(0o600);
        }
      }

      // Routed at its address, its site on the edge, seeded once, recorded.
      expect(s.state("routes/shop-preview-pr-42")).toMatch(
        new RegExp(`^shop-preview-pr-42-app-\\d+:3000 ${HOST(s, 42).replaceAll(".", "\\.")}\n$`),
      );
      const site = s.read(`${s.work}/srv/edge/sites/shop-preview-pr-42.caddy`);
      expect(site).toBe(direct["edge/sites/shop-preview-pr-42.caddy"]);
      expect(site).toContain(
        `\n${HOST(s, 42)} {\n\ttls /etc/caddy/tls/shop-preview/origin.pem /etc/caddy/tls/shop-preview/origin.key\n`,
      );
      expect(s.read(`${s.preview(42)}/app.env`)).toContain(`\nAPP_URL=https://${HOST(s, 42)}\n`);
      expect(s.read(`${s.preview(42)}/.seeded`)).toBe("");
      const fields = s.previewFields(42);
      expect(fields).toEqual({
        state: "running",
        commit: commit("1"),
        digest: `sha256:${"a".repeat(64)}`,
        created: expect.stringMatching(/^\d{10}$/),
        updated: expect.stringMatching(/^\d{10}$/),
        random,
      });
      expect(Number(fields.updated) - Number(fields.created)).toBeLessThan(600);
      expect(s.log()).toEqual([expect.stringMatching(logLine("up", 42, "key", "running"))]);

      // The steps' output is in up.log only; the registry login lived only while up ran.
      const upLog = s.read(`${s.preview(42)}/up.log`) ?? "";
      expect(upLog).toContain("Pulling shop-preview-pr-42 done");
      expect(upLog).toContain("The release command finished");
      expect(upLog).toContain("seed output of shop-preview-pr-42");
      expect(s.state("docker.log")).toContain(
        "docker login ghcr.io -u example-org --password-stdin",
      );
      expect(s.state("docker.log")).toContain("docker pulled-logged-in shop-preview-pr-42");
      expect(() => statSync(`${s.preview(42)}/.docker`)).toThrow();
      expect(s.read(`${s.preview(42)}/.fill.sed`)).toBeUndefined();
      // The recipe's lock to create it, then its own.
      expect(s.state("flock.log").split("\n").slice(0, 2)).toEqual([
        "flock -w 600 8",
        "flock -w 600 7",
      ]);
      noLeak(s, [result]);
    });

    it("updates a preview: the template filled again, generated values kept, new names generated", () => {
      const s = server();
      const first = s.up(42);
      const address = HOST(s, 42);
      only(first, `running ${address}`, 0);
      const secrets = s.read(`${s.preview(42)}/secrets.env`) ?? "";
      const created = s.previewFields(42).created;
      // A recipe changed since: another file content and a new generated value.
      s.write(
        `${s.recipe}/template/compose.yaml`,
        `${s.read(`${s.recipe}/template/compose.yaml`)}# changed for @N@\n`,
      );
      s.write(
        `${s.recipe}/template/env/app.env`,
        `${s.read(`${s.recipe}/template/env/app.env`)}WEBHOOK_SECRET=@SECRET:webhook:hex32@\n`,
      );
      s.write(
        `${s.preview(42)}/.preview`,
        (s.read(`${s.preview(42)}/.preview`) ?? "").replace(/updated=\d+/, "updated=1000"),
      );

      const second = s.up(42, { image: image("b"), commit: commit("2") });
      // At the address it was made with.
      only(second, `running ${address}`, 0);
      expect(s.state("routes/shop-preview-pr-42")).toContain(` ${address}\n`);
      expect(s.read(`${s.preview(42)}/compose.yaml`)).toMatch(/# changed for 42\n$/);
      const now = s.read(`${s.preview(42)}/secrets.env`) ?? "";
      expect(now.startsWith(secrets)).toBe(true);
      expect(now.slice(secrets.length)).toMatch(/^webhook=[0-9a-f]{64}\n$/);
      expect(s.read(`${s.preview(42)}/app.env`)).toContain(
        `WEBHOOK_SECRET=${now.slice(secrets.length + 8).trim()}\n`,
      );
      const fields = s.previewFields(42);
      expect(fields).toMatchObject({
        state: "running",
        commit: commit("2"),
        digest: `sha256:${"b".repeat(64)}`,
        created,
      });
      expect(Number(fields.updated)).toBeGreaterThan(1000);
      // The new image takes the route; an update needs no recipe lock; the seed ran once.
      const [target] = s.state("routes/shop-preview-pr-42").split(" ");
      expect(s.state("containers")).toContain(`${image("b")} running ${target?.split(":")[0]}`);
      expect(s.state("flock.log").match(/-w 600 8/g)).toHaveLength(1);
      expect(s.state("docker.log").match(/docker ran seed/g)).toHaveLength(1);
      expect(s.log()).toEqual([
        expect.stringMatching(logLine("up", 42, "key", "running")),
        expect.stringMatching(logLine("up", 42, "key", "running")),
      ]);
      noLeak(s, [first, second]);
    });

    it("runs the seed until it succeeds: a failed seed says seed-failed and the preview runs", () => {
      const s = server();
      const failed = s.up(42, { env: { SEED_FAIL: "1" } });
      expect(s.previewFields(42).random).toMatch(RANDOM_PART);
      only(failed, `seed-failed ${HOST(s, 42)}`, 5);
      expect(s.read(`${s.preview(42)}/.seeded`)).toBeUndefined();
      expect(s.state("routes/shop-preview-pr-42")).not.toBe("");
      expect(s.previewFields(42).state).toBe("seed-failed");
      expect(s.read(`${s.preview(42)}/up.log`)).toContain(
        "seed failed: relation users does not exist",
      );

      only(s.up(42), `running ${HOST(s, 42)}`, 0);
      expect(s.read(`${s.preview(42)}/.seeded`)).toBe("");
      expect(s.state("docker.log").match(/docker ran seed/g)).toHaveLength(2);
      expect(s.log()).toEqual([
        expect.stringMatching(logLine("up", 42, "key", "seed-failed")),
        expect.stringMatching(logLine("up", 42, "key", "running")),
      ]);
    });

    it("gives a preview below the app's zone its address several labels deep", () => {
      const s = server(
        previewPlan({
          postgres: false,
          processes: false,
          release: null,
          seed: null,
          appZone: true,
        }),
      );
      const result = s.up(42);
      const host = `pr-42-${s.previewFields(42).random}.${APP_ZONE_BASE}`;
      only(result, `running ${host}`, 0);
      expect(s.state("routes/shop-preview-pr-42")).toContain(` ${host}\n`);
      expect(s.read(`${s.work}/srv/edge/sites/shop-preview-pr-42.caddy`)).toContain(
        `\n${host} {\n`,
      );
    });

    it("gives each preview an address of its own, kept by its updates and forgotten by down", () => {
      const s = server(
        previewPlan({ postgres: false, processes: false, release: null, seed: null, cap: 5 }),
      );
      only(s.up(42), `running ${HOST(s, 42)}`, 0);
      only(s.up(43), `running ${HOST(s, 43)}`, 0);
      const [a, b] = [s.previewFields(42).random, s.previewFields(43).random];
      expect(a).toMatch(RANDOM_PART);
      expect(b).toMatch(RANDOM_PART);
      expect(a).not.toBe(b);
      expect(s.state("routes/shop-preview-pr-43")).toContain(` pr-43-${b}.${BASE}\n`);

      // An update keeps the random part its .preview holds; one that is not of the form is
      // drawn again.
      existing(s, 7);
      only(s.up(7), `running pr-7-${RANDOM(7)}.${BASE}`, 0);
      expect(s.read(`${s.work}/srv/edge/sites/shop-preview-pr-7.caddy`)).toContain(
        `\npr-7-${RANDOM(7)}.${BASE} {\n`,
      );
      existing(s, 8, { random: "r00000008;" });
      only(s.up(8), `running ${HOST(s, 8)}`, 0);
      expect(s.previewFields(8).random).toMatch(RANDOM_PART);

      // A preview made again after down gets a new one.
      only(s.run({ key: "down 42" }), "removed 42", 0);
      only(s.up(42), `running ${HOST(s, 42)}`, 0);
      expect(s.previewFields(42).random).toMatch(RANDOM_PART);
      expect(s.previewFields(42).random).not.toBe(a);
    });

    it.each([
      // The new copy never took traffic.
      ["rolling", "unchanged"],
      // The new copy had replaced the previous one: the rollback script puts that one back.
      ["recreate", "restored"],
    ] as const)(
      "keeps the previous image when an update fails its health check (%s)",
      (strategy, outcome) => {
        const s = server(previewPlan({ postgres: false, processes: false, strategy }));
        only(s.up(42), `running ${HOST(s, 42)}`, 0);
        const failed = s.up(42, {
          image: image("b"),
          commit: commit("2"),
          env: { UNHEALTHY: image("b") },
        });
        only(failed, "failed health", 4);
        const [target] = s.state("routes/shop-preview-pr-42").split(" ");
        expect(s.state("containers")).toContain(`${image("a")} running ${target?.split(":")[0]}`);
        expect(s.read(`${s.preview(42)}/.env`)).toBe(`APP_IMAGE=${image("a")}\n`);
        expect(s.read(`${s.preview(42)}/up.log`)).toMatch(new RegExp(`\n${outcome}\n`));
        expect(s.previewFields(42)).toMatchObject({ state: "failed", commit: commit("2") });
        expect(s.log().at(-1)).toMatch(logLine("up", 42, "key", "failed"));
        expect(() => statSync(`${s.preview(42)}/.docker`)).toThrow();
      },
    );

    it("names the step a creation failed at, and leaves nothing routed", () => {
      const cases: [string, Record<string, string>][] = [
        ["pull", { LOGIN_FAIL: "1" }],
        ["pull", { PULL_FAIL: "1" }],
        ["edge", { EDGE_UP_FAIL: "1" }],
        ["release", { RELEASE_FAIL: "1" }],
        ["start", { UP_FAIL: "1" }],
        ["health", { UNHEALTHY: image("a") }],
      ];
      for (const [step, env] of cases) {
        const s = server(previewPlan({ postgres: false, processes: false, seed: null }));
        const result = s.up(42, { env });
        only(result, `failed ${step}`, 4);
        expect(s.state("routes/shop-preview-pr-42"), step).toBe("");
        expect(s.read(`${s.preview(42)}/.env`), step).toBeUndefined();
        expect(s.previewFields(42).state, step).toBe("failed");
        expect(s.log(), step).toEqual([expect.stringMatching(logLine("up", 42, "key", "failed"))]);
        expect(() => statSync(`${s.preview(42)}/.docker`), step).toThrow();
        expect(s.state("docker.log"), step).not.toContain("docker ran seed");
        noLeak(s, [result]);
      }
    });

    it("refuses a new preview at the cap, counted under the recipe's lock, and changes nothing", () => {
      const s = server(previewPlan({ postgres: false, processes: false, cap: 2 }));
      existing(s, 1);
      existing(s, 2);
      const before = s.tree();
      const result = s.up(3);
      only(result, "cap 2/2", 3);
      // Only the recipe's lock file and the log line.
      expect(changed(before, s.tree(), s.work)).toEqual([
        "srv/apps/shop-preview/.lock",
        "srv/apps/shop-preview/previews.log",
        "state/flock.log",
      ]);
      expect(s.log()).toEqual([expect.stringMatching(logLine("up", 3, "key", "cap"))]);
      expect(s.state("flock.log")).toBe("flock -w 600 8\n");

      // A preview another up created while this one waited for the lock counts.
      const t = server(previewPlan({ postgres: false, processes: false, cap: 2 }));
      existing(t, 1);
      only(t.up(3, { env: { FLOCK_MAKES: `${t.app}-pr-9` } }), "cap 2/2", 3);
      expect(() => statSync(t.preview(3))).toThrow();

      // An update of a preview that exists is never refused at the cap.
      only(s.up(2, { env: { LOGIN_FAIL: "1" } }), "failed pull", 4);
    });

    it("creates the preview again when a removal took it away while this up waited", () => {
      const s = server();
      existing(s, 42);
      const result = s.up(42, { env: { FLOCK_TAKES: `${s.app}-pr-42`, LOGIN_FAIL: "1" } });
      only(result, "failed pull", 4);
      // Its lock was the removed folder's: it went back to the recipe's lock and the cap check.
      expect(s.state("flock.log")).toBe("flock -w 600 7\nflock -w 600 8\nflock -w 600 7\n");
      expect(s.previewFields(42)).toMatchObject({ state: "failed", commit: commit("1") });
      expect(Number(s.previewFields(42).created)).toBeGreaterThan(NOW() - 600);
      expect(s.read(`${s.preview(42)}/secrets.env`)).not.toContain("db-password=00");
    });

    it("never leaves the registry login behind when the caller went away", () => {
      const s = server();
      const result = s.up(42, { env: { GONE_CALLER: "1", PULL_FAIL: "1" } });
      expect(result.stdout).toBe("");
      expect(() => statSync(`${s.preview(42)}/.docker`)).toThrow();
      expect(s.log()).toEqual([expect.stringMatching(logLine("up", 42, "key", "failed"))]);
    });

    it("says busy when a lock is held longer than 600 seconds, and changes nothing", () => {
      const s = server();
      existing(s, 42);
      only(s.up(42, { env: { FLOCK_BUSY: "7" } }), "busy 600", 6);
      expect(s.previewFields(42).commit).toBe(commit("2"));
      only(s.up(7, { env: { FLOCK_BUSY: "8" } }), "busy 600", 6);
      expect(() => statSync(s.preview(7))).toThrow();
      only(s.run({ key: "down 42", env: { FLOCK_BUSY: "7" } }), "busy 600", 6);
      expect(s.read(`${s.preview(42)}/.preview`)).toBeDefined();
      expect(s.log()).toEqual([
        expect.stringMatching(logLine("up", 42, "key", "busy")),
        expect.stringMatching(logLine("up", 7, "key", "busy")),
        expect.stringMatching(logLine("down", 42, "key", "busy")),
      ]);
    });
  });

  describe("down", () => {
    it("removes the route, the site, the containers, networks, volumes, data and folder, and can be repeated", () => {
      const s = server(FULL);
      existing(s, 42);
      existing(s, 7);
      const result = s.run({ key: "down 42" });
      only(result, "removed 42", 0);
      gone(s, 42);
      expect(s.state("kamal.log")).toContain("kamal-proxy remove shop-preview-pr-42");
      expect(s.state("docker.log")).toContain("exec -T caddy caddy reload");
      // The data goes as root, from a container of the edge's pinned Caddy image.
      expect(s.state("docker.log")).toMatch(
        /docker run --rm --network none --user 0:0 --entrypoint rm -v \S+\/srv\/data:\/d caddy:\S+@sha256:[0-9a-f]{64} -rf \/d\/shop-preview-pr-42\n/,
      );
      // Preview 7 stays.
      expect(s.previewFields(7).state).toBe("running");
      expect(s.state("containers")).toContain("shop-preview-pr-7-app-7");

      only(s.run({ args: ["down", "42"] }), "removed 42", 0);
      expect(s.log()).toEqual([
        expect.stringMatching(logLine("down", 42, "key", "removed")),
        expect.stringMatching(logLine("down", 42, "local", "removed")),
      ]);
    });

    it("finishes a removal a cancelled run left half done", () => {
      const s = server();
      existing(s, 42, { preview: false });
      // The route and site were gone already, and part of the folder.
      s.write(`${s.work}/state/routes/shop-preview-pr-42`, "");
      only(s.run({ key: "down 42" }), "removed 42", 0);
      gone(s, 42);
    });

    it("stops at a step that fails and keeps the folder, without .seeded, for the next down", () => {
      const s = server();
      existing(s, 42);
      only(s.run({ key: "down 42", env: { RM_FAIL: "1" } }), "failed start", 4);
      // A preview made again in this folder is seeded again; its containers and data stay
      // until a removal gets them.
      expect(s.read(`${s.preview(42)}/.seeded`)).toBeUndefined();
      expect(s.read(`${s.preview(42)}/.preview`)).toBeUndefined();
      expect(s.read(`${s.preview(42)}/compose.yaml`)).toBeDefined();
      expect(s.state("containers")).toContain("shop-preview-pr-42-app-42");
      only(s.run({ key: "down 42" }), "removed 42", 0);
      gone(s, 42);
      expect(s.log()).toEqual([
        expect.stringMatching(logLine("down", 42, "key", "failed")),
        expect.stringMatching(logLine("down", 42, "key", "removed")),
      ]);
    });

    it("says removed when another removal took the preview while it waited for the lock", () => {
      const s = server();
      existing(s, 42);
      only(s.run({ key: "down 42", env: { FLOCK_TAKES: `${s.app}-pr-42` } }), "removed 42", 0);
      // It removed nothing itself: the other removal does.
      expect(s.state("docker.log")).not.toMatch(/docker (rm|network rm|volume rm)/);
      expect(s.log()).toEqual([expect.stringMatching(logLine("down", 42, "key", "removed"))]);
    });
  });

  describe("list", () => {
    it("prints one line per preview, smallest number first, then the count, and changes nothing", () => {
      const s = server(previewPlan({ postgres: false, processes: false, cap: 6 }));
      existing(s, 10, { state: "seed-failed", created: 1_700_000_000, updated: 1_700_000_500 });
      existing(s, 2, { created: 1_700_000_100, updated: 1_700_000_200 });
      existing(s, 5, { preview: false });
      // A random part that is not of the form is no address.
      existing(s, 6, { created: 1_700_000_300, updated: 1_700_000_400, random: "R000000006" });
      // Not a preview of this recipe.
      s.write(`${s.work}/srv/apps/${s.app}-pr-07/x`, "");
      s.write(`${s.work}/srv/apps/${s.app}-pr-x/x`, "");
      const before = s.tree();
      const expected = [
        `2 running ${commit("2")} 1700000100 1700000200 sha256:${"2".repeat(64)} pr-2-${RANDOM(2)}.${BASE}`,
        "5 failed - - - - -",
        `6 running ${commit("6")} 1700000300 1700000400 sha256:${"6".repeat(64)} -`,
        `10 seed-failed ${commit("0")} 1700000000 1700000500 sha256:${"0".repeat(64)} pr-10-${RANDOM(10)}.${BASE}`,
        "opscrew-preview: listed 4/6",
        "",
      ].join("\n");
      for (const result of [s.run({ key: "list" }), s.run({ args: ["list"] })]) {
        expect(result).toMatchObject({ status: 0, stdout: expected, stderr: "" });
      }
      expect(s.tree()).toEqual(before);
    });
  });

  describe("gc", () => {
    it("removes each preview not updated for LIFETIME_DAYS days, logged as gc; never through the preview key", () => {
      const s = server(previewPlan({ postgres: false, processes: false, lifetimeDays: 7 }));
      existing(s, 1, { updated: NOW() - 8 * DAY });
      existing(s, 2, { updated: NOW() - 6 * DAY });
      existing(s, 3, { preview: false });
      const old = new Date((NOW() - 9 * DAY) * 1000);
      utimesSync(`${s.preview(3)}/compose.yaml`, old, old);

      const before = s.tree();
      only(s.run({ key: "gc" }), "refused command", 2);
      expect(s.tree()).toEqual(before);

      // Cron's: nothing printed when it succeeds.
      const result = s.run({ args: ["gc"] });
      expect(result).toMatchObject({ status: 0, stdout: "", stderr: "" });
      gone(s, 1);
      gone(s, 3);
      expect(s.previewFields(2).state).toBe("running");
      // Each removal under the preview's own lock (and the edge's, for its site).
      expect(s.state("flock.log")).toBe(
        "flock -w 600 7\nflock -w 600 9\nflock -w 600 7\nflock -w 600 9\n",
      );
      expect(s.log()).toEqual([
        expect.stringMatching(logLine("gc", 1, "local", "removed")),
        expect.stringMatching(logLine("gc", 3, "local", "removed")),
      ]);
    });

    it("keeps a preview whose removal fails, says so on stderr and exits non-zero; the next gc removes it", () => {
      const s = server(previewPlan({ postgres: false, processes: false, lifetimeDays: 7 }));
      existing(s, 1, { updated: NOW() - 8 * DAY });
      existing(s, 2, { updated: NOW() - 6 * DAY });
      // Its last up wrote compose.yaml then.
      const old = new Date((NOW() - 8 * DAY) * 1000);
      utimesSync(`${s.preview(1)}/compose.yaml`, old, old);
      const result = s.run({ args: ["gc"], env: { RM_FAIL: "1" } });
      expect(result).toMatchObject({
        status: 4,
        stdout: "",
        stderr: "opscrew-preview: failed start\n",
      });
      expect(s.read(`${s.preview(1)}/compose.yaml`)).toBeDefined();
      expect(s.state("containers")).toContain("shop-preview-pr-1-app-1");
      expect(s.previewFields(2).state).toBe("running");
      expect(s.log()).toEqual([expect.stringMatching(logLine("gc", 1, "local", "failed"))]);

      // Its .preview went first, yet it is still idle by its compose.yaml's time.
      expect(s.run({ args: ["gc"] })).toMatchObject({ status: 0, stdout: "", stderr: "" });
      gone(s, 1);
      expect(s.previewFields(2).state).toBe("running");
      expect(s.log().at(-1)).toMatch(logLine("gc", 1, "local", "removed"));
    });
  });

  describe("logs", () => {
    it("prints the last lines of each of the preview's containers; never through the preview key", () => {
      const s = server();
      existing(s, 42);
      const before = s.tree();
      only(s.run({ key: "logs 42" }), "refused command", 2);
      expect(s.tree()).toEqual(before);

      const result = s.run({ args: ["logs", "42"] });
      expect(result).toMatchObject({
        status: 0,
        stdout: [
          "== shop-preview-pr-42-app-42 ==",
          "last line of shop-preview-pr-42-app-42",
          "error line of shop-preview-pr-42-app-42",
          "== shop-preview-pr-42-db-420 ==",
          "last line of shop-preview-pr-42-db-420",
          "error line of shop-preview-pr-42-db-420",
          "opscrew-preview: listed 42",
          "",
        ].join("\n"),
      });
      expect(s.state("docker.log")).toContain("docker logs --tail 200 shop-preview-pr-42-app-42");
      only(s.run({ args: ["logs", "7"] }), "removed 7", 0);
      expect(s.log()).toEqual([]);
      // Reading takes no lock.
      expect(s.state("flock.log")).toBe("");
    });
  });

  describe("requests", () => {
    it("are refused before anything is read or written, naming the rule", () => {
      const s = server();
      existing(s, 42);
      const valid = `${image("a")} ${commit("1")}`;
      const refusals: [string, string | undefined, string][] = [
        // [request, stdin, detail]
        ["", TOKEN, "request"],
        [" list", undefined, "request"],
        ["list ", undefined, "request"],
        ["down  42", undefined, "request"],
        ["down\t42", undefined, "request"],
        ["down 42\nlist", undefined, "request"],
        ["down '42'", undefined, "request"],
        ['down "42"', undefined, "request"],
        ["down 42;id", undefined, "request"],
        ["down $HOME", undefined, "request"],
        ["down `id`", undefined, "request"],
        ["down 4*", undefined, "request"],
        ["Down 42", undefined, "request"],
        ["list 42", undefined, "request"],
        ["down", undefined, "request"],
        ["down 42 42", undefined, "request"],
        [`up 42 ${valid} extra`, TOKEN, "request"],
        [`up 42 ${image("a")}`, TOKEN, "request"],
        ["rm 42", undefined, "command"],
        ["sh", undefined, "command"],
        ["gc", undefined, "command"],
        ["logs 42", undefined, "command"],
        ["upgrade 42", undefined, "command"],
        ["down 0", undefined, "number"],
        ["down 042", undefined, "number"],
        ["down 1234567", undefined, "number"],
        ["down 4a", undefined, "number"],
        ["down -1", undefined, "number"],
        [`up 4x ${valid}`, TOKEN, "number"],
        [`up 42 ghcr.io/example-org/other@sha256:${"a".repeat(64)} ${commit("1")}`, TOKEN, "image"],
        [`up 42 ${IMAGE_NAME}-x@sha256:${"a".repeat(64)} ${commit("1")}`, TOKEN, "image"],
        [`up 42 ${IMAGE_NAME}:pr-42 ${commit("1")}`, TOKEN, "image"],
        [`up 42 ${IMAGE_NAME}@sha256:${"a".repeat(63)} ${commit("1")}`, TOKEN, "image"],
        [`up 42 ${IMAGE_NAME}@sha256:${"a".repeat(65)} ${commit("1")}`, TOKEN, "image"],
        [`up 42 ${IMAGE_NAME}@sha256:${"g".repeat(64)} ${commit("1")}`, TOKEN, "image"],
        [`up 42 ${IMAGE_NAME}@sha512:${"a".repeat(64)} ${commit("1")}`, TOKEN, "image"],
        [`up 42 ${image("a")} ${"1".repeat(39)}`, TOKEN, "commit"],
        [`up 42 ${image("a")} ${"1".repeat(41)}`, TOKEN, "commit"],
        [`up 42 ${image("a")} ${"z".repeat(40)}`, TOKEN, "commit"],
        [`up 42 ${valid}`, "", "token"],
        [`up 42 ${valid}`, `${TOKEN}\nmore`, "token"],
        [`up 42 ${valid}`, `${TOKEN} more`, "token"],
        [`up 42 ${valid}`, "a".repeat(4097), "token"],
        [`up 42 ${valid}`, "tok'en", "token"],
      ];
      const before = s.tree();
      for (const [request, stdin, detail] of refusals) {
        const result = s.run({ key: request, ...(stdin === undefined ? {} : { stdin }) });
        only(result, `refused ${detail}`, 2);
        expect(s.tree(), request).toEqual(before);
      }
      // Arguments as well as SSH_ORIGINAL_COMMAND through the preview key, and arguments locally.
      only(s.run({ key: "list", args: ["list"] }), "refused request", 2);
      only(s.run({ args: ["down", "42;id"] }), "refused request", 2);
      only(s.run({ args: [] }), "refused request", 2);
      expect(s.tree()).toEqual(before);
    });

    it("come from the arguments without SSH_ORIGINAL_COMMAND (the deploy key, cron)", () => {
      const s = server();
      const local = s.run({
        args: ["up", "42", image("a"), commit("1")],
        stdin: TOKEN,
        env: { LOGIN_FAIL: "1" },
      });
      only(local, "failed pull", 4);
      expect(s.log()).toEqual([expect.stringMatching(logLine("up", 42, "local", "failed"))]);
      // A token of 4096 characters is accepted.
      only(
        s.run({
          key: `up 42 ${image("a")} ${commit("1")}`,
          stdin: "a".repeat(4096),
          env: { LOGIN_FAIL: "1" },
        }),
        "failed pull",
        4,
      );
      noLeak(s, [local]);
    });

    it("are refused unless the script runs by its absolute path in an app's bin folder", () => {
      const s = server();
      existing(s, 42);
      const elsewhere = `${s.work}/elsewhere/bin/opscrew-preview`;
      s.write(elsewhere, s.read(`${s.recipe}/bin/opscrew-preview`) ?? "", 0o755);
      const before = s.tree();
      only(s.run({ key: "list", script: elsewhere }), "failed start", 4);
      const relative = spawnSync("sh", ["bin/opscrew-preview", "list"], {
        cwd: s.recipe,
        encoding: "utf8",
      });
      expect(relative).toMatchObject({ status: 4, stdout: "opscrew-preview: failed start\n" });
      expect(s.tree()).toEqual(before);
    });
  });
});
