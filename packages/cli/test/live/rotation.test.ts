/**
 * The live passes of feature 025 at Hetzner (docs/e2e.md "Credential rotation", plan.md 14.), each
 * named in `OPSCREW_E2E_ROTATION` (a comma list) and with its own run id, server and cleanup:
 * - **services**: examples/node-bullmq (Valkey `queue` and its worker) with PostgreSQL `db` and
 *   MySQL `mysql` added, on staging. `opscrew rotate db mysql queue` in a script under steady
 *   requests: no request fails beyond the window the plan states, the new values log in and the
 *   old ones are refused, no service restarts, the worker runs a job, and the record is merged.
 *   Then a second rotation stopped at a step (MySQL paused) is undone with `--undo`.
 * - **keys**: `deploy-key` (with `--confirm <app>` for the key's copy at Hetzner, then a
 *   provision that replaces nothing) and `check-key`: the old keys no longer log in, the new ones
 *   do, and the next deploy works.
 * - **app**: examples/laravel-app with a session counter and an encrypted value (its own routes):
 *   `rotate app` keeps sessions and the value readable (`APP_PREVIOUS_KEYS`); `--drop-previous`
 *   asks the app's name and drops it. Then a real Better Auth with both of its variables, in Docker
 *   on this computer.
 * - **restore**: examples/s3-uploads with its bucket in Garage and RabbitMQ added: a snapshot,
 *   then both rotated, then `opscrew restore`: the app reads its files with the current key and
 *   RabbitMQ takes the current password. With `OPSCREW_E2E_ROTATION_SERVER_RESTORE=1` (once T2520
 *   is on main), also a whole-server snapshot, PostgreSQL rotated, and `restore --server`.
 * Each pass ends with the leak search: every output, commit, pull request, audit entry, saved plan
 * and state file, the deploy jobs' logs and, on the server, the rotation's log and every
 * container's log, for every value OpsCrew made, the old and the new.
 */
import { appendFile, readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { httpRequest, minutes } from "./cloud";
import { readValue, type ServerExec, serverContainers, writeValue } from "./component-checks";
import { AppEnvironments, designProd } from "./environment-checks";
import { EXAMPLES, LiveRun, serverSettings } from "./harness";
import { composeProjectOf } from "./retarget-anywhere-support";
import {
  approvedRotation,
  betterAuthCheck,
  deployAgain,
  deployLogin,
  deploysPaused,
  expectJobRuns,
  expectLogins,
  generatedValuesOf,
  hetznerKeys,
  keepKeyCopy,
  type LoginCheck,
  loginExitCode,
  mergeRecord,
  onServer,
  rememberPending,
  scriptedRotation,
  serverLogLeaks,
  shownRotation,
  underRotation,
} from "./rotation-checks";
import {
  type CookieJar,
  cookieHeader,
  cookieSessions,
  credentialOf,
  envValueScript,
  generatedSecret,
  generatesVariable,
  inContainerWithInput,
  LARAVEL_ROUTES,
  LARAVEL_STAND_INS,
  listedCredentials,
  listedWindowSeconds,
  passSkip,
  ROTATION_GATE,
  type RotationPass,
  SERVER_RESTORE_GATE,
  selectedPasses,
  statedWindowSeconds,
  withCookies,
  withGarageBucket,
  withServices,
} from "./rotation-support";
import {
  approvedRestore,
  type DeployRun,
  deployLogLeaks,
  hetznerServer,
  listSnapshots,
  removeServerSnapshots,
  snapshotOf,
} from "./snapshots-checks";
import { restartedServices, servicesIn, takenSnapshotId } from "./snapshots-support";

const ENV = process.env;
const SETTINGS = serverSettings(ENV);
const STAGING = "staging";
const PASSES = ["services", "keys", "app", "restore"] as const satisfies readonly RotationPass[];
const SKIP = Object.fromEntries(PASSES.map((pass) => [pass, passSkip(ENV, pass)])) as Record<
  (typeof PASSES)[number],
  string | undefined
>;

const { passes: NAMED, unknown: UNKNOWN } = selectedPasses(ENV[ROTATION_GATE]);
if (UNKNOWN.length > 0) {
  console.warn(
    `OpsCrew E2E (credential rotation): ${ROTATION_GATE} names ${UNKNOWN.join(", ")}, which are no passes (see docs/e2e.md, "Credential rotation").`,
  );
}
for (const pass of PASSES) {
  const skip = SKIP[pass];
  if (NAMED.includes(pass) && skip !== undefined) {
    console.warn(
      `OpsCrew E2E (rotation, ${pass}): skipped, ${skip} (see docs/e2e.md, "Credential rotation").`,
    );
  }
}

/** The pass's title: what it runs, or why it is skipped. */
function title(pass: (typeof PASSES)[number], what: string): string {
  const skip = SKIP[pass];
  return skip === undefined
    ? `live rotation, ${pass}: ${what}`
    : `live rotation, ${pass} (skipped: ${skip}; see docs/e2e.md)`;
}

/** The app's address for a health URL: its `scheme://host`. */
const originOf = (url: string) => new URL(url).origin;

/**
 * The start of each pass at Hetzner: the throwaway repository prepared (`commit` its message,
 * `files` written over the example) with the Hetzner and Cloudflare tokens, GitHub's snapshot for
 * the cleanup, and prod designed.
 */
async function startPass(
  run: LiveRun,
  envs: AppEnvironments,
  commit: string,
  files: Readonly<Record<string, string>> = {},
): Promise<DeployPlan> {
  await run.prepareRepo({
    commit,
    env: { HCLOUD_TOKEN: SETTINGS.hcloudToken, CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
    files,
  });
  await envs.snapshotGithub();
  return designProd(run, envs, SETTINGS.region);
}

/** The run's `exec` on a server: through `login()` each time (its address is read again). */
function execThrough(run: LiveRun, login: () => ReturnType<typeof deployLogin>): ServerExec {
  return async (command) => onServer(run, await login(), command);
}

// ---------------------------------------------------------------------------------------------
// The services pass.

const SERVICES_APP = "node-bullmq";

describe.skipIf(SKIP.services !== undefined)(
  title(
    "services",
    `examples/${SERVICES_APP} with PostgreSQL, MySQL, Valkey and its worker on staging at Hetzner`,
  ),
  () => {
    const run: LiveRun = new LiveRun({
      label: "rotation, services",
      name: "rot-services",
      settings: { ...SETTINGS, app: SERVICES_APP },
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const env = ["--env", STAGING];
    const value = `value-${run.runId}`;
    const deployRuns: DeployRun[] = [];
    const serverLeaks: string[] = [];
    let health = "";
    let workflow = "";
    let project = "";
    /** The services' values after the first rotation, which the undone one must leave. */
    let rotated: Passwords | undefined;
    const login = () => deployLogin(run, envs, STAGING);
    const exec = execThrough(run, login);
    const site = () => originOf(health);

    type Passwords = Record<"db" | "mysql" | "mysqlRoot" | "queue", string>;

    /** Staging's services' values on this computer now. */
    async function passwords(): Promise<Passwords> {
      const json = await generatedValuesOf(envs.paths(STAGING));
      return {
        db: generatedSecret(json, ["dbPassword"]), // PostgreSQL's is kept as dbPassword
        mysql: generatedSecret(json, ["services", "mysql", "password"]),
        mysqlRoot: generatedSecret(json, ["services", "mysql", "root-password"]),
        queue: generatedSecret(json, ["services", "queue", "password"]),
      };
    }

    /** The logins with `values` (`which` names them), each to work or be refused. */
    function logins(values: Partial<Passwords>, which: string, works: boolean): LoginCheck[] {
      const all: LoginCheck[] = [
        {
          what: `db's ${which} password`,
          service: "db",
          kind: "postgres",
          value: values.db ?? "",
          works,
        },
        {
          what: `mysql's ${which} password`,
          service: "mysql",
          kind: "mysql",
          value: values.mysql ?? "",
          works,
        },
        {
          what: `mysql's ${which} root password`,
          service: "mysql",
          kind: "mysql",
          value: values.mysqlRoot ?? "",
          works,
          as: { user: "root", database: "mysql" },
        },
        {
          what: `queue's ${which} password`,
          service: "queue",
          kind: "valkey",
          value: values.queue ?? "",
          works,
        },
      ];
      return all.filter((check) => check.value !== "");
    }

    run.step(
      `1. examples/${SERVICES_APP}: prod designed, staging at Hetzner added with PostgreSQL and MySQL in its plan, provisioned and deployed; a value written`,
      minutes(75),
      async () => {
        // Prod is designed, as `env add` starts from it, but never provisioned: only staging runs.
        await startPass(run, envs, `e2e: examples/${SERVICES_APP} for credential rotation`);
        await run.adaptAndMerge();
        await run.opscrewOk("env", "add", STAGING, "--target", "hetzner", "--from", "main");
        const file = envs.paths(STAGING).files.plan;
        await writeArtifact(
          "plan",
          file,
          withServices(await envs.readPlan(STAGING), { db: "postgres", mysql: "mysql" }),
        );
        await run.opscrewOk("design", ...env);
        const staging = await envs.designed(STAGING);
        const host = staging.dns.domain;
        if (host === undefined || host === run.appHost) {
          throw new Error("design gave staging no hostname of its own.");
        }
        health = `https://${host}${staging.app.healthPath}`;
        workflow = posix.basename(staging.cicd.workflowPath);
        project = composeProjectOf(staging);
        expect(
          staging.services.filter((s) => s.enabled).map((s) => `${s.name} (${s.kind})`),
          "the services staging's design kept",
        ).toEqual(expect.arrayContaining(["db (postgres)", "mysql (mysql)", "queue (valkey)"]));
        await envs.provision(STAGING, "staging's first deploy");
        const id = await run.deploy("staging's first deploy", [workflow]);
        if (id === undefined) throw new Error("provision opened no deploy-setup pull request.");
        deployRuns.push({ what: "staging's first deploy", id });
        await run.waitForHealth(minutes(10), true, health);
        await run.opscrewOk("verify", ...env);
        await writeValue(site(), value);
        await expectJobRuns(run, site(), `before-${run.runId}`);
      },
    );

    run.step(
      "2. opscrew rotate --json lists db as a swap, mysql and queue as seamless, each dated from the first deploy, and changes nothing (US2)",
      minutes(10),
      async () => {
        // Provision leaves a plan whose only change is its records uncommitted (T1329), so
        // compare the tree before and after the listing rather than expect a clean one.
        const before = await run.git("status", "--porcelain");
        const listed = listedCredentials((await run.opscrewOk("rotate", ...env, "--json")).stdout);
        expect(credentialOf(listed, "db").rotation.mode, "how db rotates").toBe("swap");
        expect(credentialOf(listed, "mysql").rotation.mode, "how mysql rotates").toBe("seamless");
        expect(credentialOf(listed, "queue").rotation.mode, "how queue rotates").toBe("seamless");
        for (const name of ["db", "mysql", "queue"]) {
          expect(credentialOf(listed, name).date?.source, `${name}'s date`).toBe("first-deploy");
        }
        expect(await run.git("status", "--porcelain"), "files the listing changed").toBe(before);
      },
    );

    run.step(
      "3. opscrew rotate db mysql queue in a script under load: no request fails beyond the plan's window; the new values log in, the old are refused; no service restarted; the worker runs; the record merged; the next deploy keeps the new values (US1, SC-2501)",
      minutes(40),
      async () => {
        const names = ["db", "mysql", "queue"];
        const args = [...names, ...env];
        const old = await passwords();
        const since = new Date();
        const containers = await serverContainers(exec);
        const listed = listedCredentials((await run.opscrewOk("rotate", ...env, "--json")).stdout);
        const shown = await shownRotation(run, args);
        // A script sees the plan's lines only when the plan loses something; the listing states the
        // same windows (credentialInventory).
        const window = Math.max(
          statedWindowSeconds(shown.output),
          listedWindowSeconds(listed, names),
        );
        run.log(`the rotation states a window of about ${window} seconds for new connections`);
        const done = await underRotation(
          run,
          [health, `${site()}/data`],
          "the rotation of db, mysql and queue",
          window,
          () => approvedRotation(run, args, shown.hashes),
        );
        expect(
          done.output.includes("Rotated the credentials of"),
          `the rotation's result:\n${run.tail(done.output)}`,
        ).toBe(true);
        await envs.remember(STAGING);
        const now = await passwords();
        for (const name of Object.keys(old) as (keyof Passwords)[]) {
          expect(now[name] !== old[name], `${name}'s value changed on this computer`).toBe(true);
        }
        rotated = now;
        await expectLogins(run, await login(), project, [
          ...logins(now, "new", true),
          ...logins(old, "old", false),
        ]);
        expect(
          restartedServices(containers, await serverContainers(exec), project).filter((s) =>
            ["db", "mysql", "queue"].includes(s),
          ),
          "the services the rotation started again",
        ).toEqual([]);
        await readValue(site(), value);
        await expectJobRuns(run, site(), `after-${run.runId}`);
        expect(await deploysPaused(run), "deploys paused after the rotation").toBe(false);
        expect(await rememberPending(run, envs.paths(STAGING)), "an unfinished rotation left").toBe(
          false,
        );
        await mergeRecord(run, envs.paths(STAGING), STAGING, { db: 2, mysql: 2, queue: 2 }, since);
        deployRuns.push({
          what: "the deploy after the rotation",
          id: await deployAgain(run, "the deploy after the rotation", workflow),
        });
        await run.waitForHealth(minutes(10), true, health);
        await expectLogins(run, await login(), project, logins(now, "new", true));
        await readValue(site(), value);
      },
    );

    run.step(
      "4. a second rotation of db and mysql stopped at a step (MySQL paused): it says how to undo, keeps the old values and the pause; --undo puts them back (FR-2512)",
      minutes(40),
      async () => {
        const args = ["db", "mysql", ...env];
        const kept = rotated as Passwords;
        const mysql = await exec(
          `docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=mysql | head -n 1`,
        );
        if (mysql === "") throw new Error("staging runs no mysql container.");
        const shown = await shownRotation(run, args);
        await exec(`docker pause ${mysql}`);
        let stopped: Awaited<ReturnType<typeof run.opscrew>>;
        try {
          stopped = await run.opscrew(
            "rotate",
            ...args,
            ...shown.hashes.flatMap((hash) => ["--approve", hash]),
            "--yes",
          );
        } finally {
          await exec(`docker unpause ${mysql}`);
        }
        expect(
          stopped.exitCode,
          `the stopped rotation's exit code:\n${run.tail(stopped.output)}`,
        ).not.toBe(0);
        expect(
          stopped.output.includes(`opscrew rotate db mysql --env ${STAGING} --undo`),
          `the stop names the undo:\n${run.tail(stopped.output)}`,
        ).toBe(true);
        const pendingFile = join(envs.paths(STAGING).projectHomeDir, "pending_rotation.json");
        expect(
          await rememberPending(run, envs.paths(STAGING)),
          "the unfinished rotation kept",
        ).toBe(true);
        const pending: unknown = JSON.parse(await readFile(pendingFile, "utf8"));
        const abandoned = {
          db: generatedSecret(pending, ["services", "db", "password", "new"]),
          mysql: generatedSecret(pending, ["services", "mysql", "password", "new"]),
        };
        expect(await deploysPaused(run), "deploys paused while the rotation is unfinished").toBe(
          true,
        );

        const undone = await scriptedRotation(run, [...args, "--undo"]);
        expect(
          undone.done.output.includes("Put the old values of"),
          `the undo's result:\n${run.tail(undone.done.output)}`,
        ).toBe(true);
        expect(await rememberPending(run, envs.paths(STAGING)), "an unfinished rotation left").toBe(
          false,
        );
        expect(await passwords(), "the values on this computer after the undo").toEqual(kept);
        await expectLogins(run, await login(), project, [
          ...logins(kept, "current", true),
          ...logins(abandoned, "undone", false),
        ]);
        expect(await deploysPaused(run), "deploys paused after the undo").toBe(false);
        await run.waitForHealth(minutes(5), true, health);
        await readValue(site(), value);
        await expectJobRuns(run, site(), `undone-${run.runId}`);
      },
    );

    run.step(
      "5. the rotation's log and every container's log on staging's server hold no old or new value (SC-2503)",
      minutes(10),
      async () => {
        serverLeaks.push(
          ...(await serverLogLeaks(run, await login(), "staging's server", {
            plan: await envs.readPlan(STAGING),
            projects: [project],
          })),
        );
      },
    );

    run.step(
      "6. destroy leaves nothing at Hetzner, in Cloudflare or at GitHub",
      minutes(30),
      async () => {
        const secrets = await envs.expectSecretsPlaced(STAGING);
        await envs.destroy(STAGING);
        await envs.expectNothingLeft(STAGING);
        await envs.expectSecretsGone(STAGING, secrets);
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "7. no old or new value in any output, deploy job's log, audit entry, commit, pull request, plan or state file (SC-2503)",
      minutes(10),
      async () => {
        run.expectNothingLeaked([
          ...(await envs.leaks({ cloudflare: true })),
          ...(await deployLogLeaks(run, deployRuns)),
          ...serverLeaks,
        ]);
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

// ---------------------------------------------------------------------------------------------
// The keys pass.

const KEYS_APP = "flask-sqlite";

describe.skipIf(SKIP.keys !== undefined)(
  title("keys", `examples/${KEYS_APP} at Hetzner: the deploy key and the check key`),
  () => {
    const run: LiveRun = new LiveRun({
      label: "rotation, keys",
      name: "rot-keys",
      settings: { ...SETTINGS, app: KEYS_APP },
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const deployRuns: DeployRun[] = [];
    const serverLeaks: string[] = [];
    const login = () => deployLogin(run, envs);
    const copies = () => ({
      deploy: join(run.work, "old-keys", "deploy"),
      check: join(run.work, "old-keys", "check"),
    });

    run.step(
      `1. examples/${KEYS_APP} at Hetzner: provision and the first deploy; copies of the deploy and check keys kept, each logging in`,
      minutes(60),
      async () => {
        await startPass(run, envs, `e2e: examples/${KEYS_APP} for the key rotations`);
        await run.adaptAndMerge();
        await envs.provision("prod", "prod");
        deployRuns.push({ what: "the first deploy", id: await run.deployAny("the first deploy") });
        await run.waitForHealth();
        const { files } = envs.paths();
        if (!(await run.rememberSecretFile(files.checkKey, "check-private-key"))) {
          throw new Error("prod has no check key: design turned no scheduled check on.");
        }
        await keepKeyCopy(files.deployKey, copies().deploy);
        await keepKeyCopy(files.checkKey, copies().check);
        expect(
          await loginExitCode(run, await login(), copies().deploy),
          "the deploy key's copy logs in",
        ).toBe(0);
        expect(
          await loginExitCode(run, await login(), copies().check),
          "the check key's copy is let in (its forced command runs)",
        ).not.toBe(255);
      },
    );

    run.step(
      "2. opscrew rotate deploy-key in a script, with --confirm <app> for its copy at Hetzner: the old key no longer logs in, the new one does, Hetzner holds the new one, provision then replaces nothing, and the next deploy works (US3, SC-2502)",
      minutes(60),
      async () => {
        const since = new Date();
        const { done } = await scriptedRotation(run, ["deploy-key"], { confirm: envs.app() });
        expect(
          done.output.includes("Replaced the deploy key"),
          `the rotation's result:\n${run.tail(done.output)}`,
        ).toBe(true);
        const { files } = envs.paths();
        await run.rememberSecretFile(files.deployKey, "deploy-private-key");
        expect(
          await loginExitCode(run, await login(), copies().deploy),
          "the old deploy key's login",
        ).toBe(255);
        expect(
          await loginExitCode(run, await login(), files.deployKey),
          "the new deploy key's login",
        ).toBe(0);
        const fresh = (await readFile(files.deployKeyPub, "utf8"))
          .trim()
          .split(/\s+/)
          .slice(0, 2)
          .join(" ");
        expect(
          await hetznerKeys(SETTINGS.hcloudToken, envs.app()),
          "the deploy key's copy at Hetzner",
        ).toEqual([fresh]);
        await mergeRecord(run, envs.paths(), "prod", { "deploy-key": 2 }, since);
        // As the rotation says to: provision writes the new key into terraform.tfvars.json.
        const provisioned = await envs.provision(
          "prod",
          "provision after the deploy key's rotation",
        );
        expect(
          provisioned.includes("This plan deletes or replaces resources"),
          "provision after the rotation plans a replacement",
        ).toBe(false);
        // OpsCrew's own files start no deploy: the merge, then the next deploy by hand.
        await run.mergeDeploySetup("provision's files after the deploy key's rotation");
        deployRuns.push({
          what: "the deploy after the deploy key's rotation",
          id: await deployAgain(run, "the deploy after the deploy key's rotation"),
        });
        await run.waitForHealth();
      },
    );

    run.step(
      "3. opscrew rotate check-key in a script: proven by a check run, the old key is no longer let in, the new one is (US3)",
      minutes(40),
      async () => {
        const since = new Date();
        const { done } = await scriptedRotation(run, ["check-key"]);
        expect(
          done.output.includes("Replaced the scheduled check's key"),
          `the rotation's result:\n${run.tail(done.output)}`,
        ).toBe(true);
        const { files } = envs.paths();
        await run.rememberSecretFile(files.checkKey, "check-private-key");
        expect(
          await loginExitCode(run, await login(), copies().check),
          "the old check key's login",
        ).toBe(255);
        expect(
          await loginExitCode(run, await login(), files.checkKey),
          "the new check key's login",
        ).not.toBe(255);
        await mergeRecord(run, envs.paths(), "prod", { "check-key": 2 }, since);
      },
    );

    run.step(
      "4. the next deploy, a merged change, works with the new keys (SC-2502)",
      minutes(30),
      async () => {
        deployRuns.push({
          what: "a change after the key rotations",
          id: await run.mergeChange("e2e: a change after the key rotations"),
        });
        await run.waitForHealth();
        serverLeaks.push(
          ...(await serverLogLeaks(run, await login(), "the app's server", {
            projects: [composeProjectOf(await run.readPlan())],
          })),
        );
      },
    );

    run.step("5. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
      await envs.destroy("prod");
      await envs.expectNothingLeft("prod");
      await run.expectCloudflareClean();
    });

    run.step(
      "6. no key, old or new, in any output, deploy job's log, audit entry, commit, pull request, plan or state file (SC-2503)",
      minutes(10),
      async () => {
        run.expectNothingLeaked([
          ...(await envs.leaks({ cloudflare: true })),
          ...(await deployLogLeaks(run, deployRuns)),
          ...serverLeaks,
        ]);
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

// ---------------------------------------------------------------------------------------------
// The app pass.

const APP_EXAMPLE = "laravel-app";

describe.skipIf(SKIP.app !== undefined)(
  title(
    "app",
    `examples/${APP_EXAMPLE} at Hetzner: APP_KEY kept as the previous key, then dropped; Better Auth`,
  ),
  () => {
    const run: LiveRun = new LiveRun({
      label: "rotation, app",
      name: "rot-app",
      settings: { ...SETTINGS, app: APP_EXAMPLE },
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const deployRuns: DeployRun[] = [];
    const serverLeaks: string[] = [];
    const login = () => deployLogin(run, envs);
    const site = () => `https://${run.appHost}`;
    /** The browser's cookies now, and as they were before the first rotation (the old key's). */
    let jar: CookieJar = {};
    let firstJar: CookieJar = {};
    /** A value the app encrypted with the first key. */
    let encrypted = "";
    let since = new Date();

    /** The session's counter after one more request with `cookies` (`jar` when it is the jar). */
    async function sessionCount(cookies: CookieJar, keep: boolean): Promise<string> {
      const answer = await httpRequest(`${site()}/e2e-session`, {
        headers: { cookie: cookieHeader(cookies) },
      });
      if (answer.status !== 200) throw new Error(`/e2e-session answered ${answer.status}.`);
      if (keep) jar = withCookies(cookies, answer.headers["set-cookie"]);
      return answer.body.trim();
    }

    /** What the app says of the first encrypted value: `readable`, or HTTP 409 `unreadable`. */
    async function decrypted(): Promise<string> {
      const answer = await httpRequest(`${site()}/e2e-decrypt?v=${encodeURIComponent(encrypted)}`);
      return answer.status === 200 || answer.status === 409
        ? answer.body.trim()
        : `HTTP ${answer.status}`;
    }

    /** What the app's container holds in `name`: `same` as `value`, `other` or `unset`. */
    async function inApp(name: string, value: string): Promise<string> {
      const plan = await run.readPlan();
      return onServer(
        run,
        await login(),
        inContainerWithInput(composeProjectOf(plan), "app", envValueScript(name)),
        `${value}\n`,
      );
    }

    const appKey = async () =>
      generatedSecret(await generatedValuesOf(envs.paths()), ["env", "APP_KEY"]);

    run.step(
      `1. examples/${APP_EXAMPLE} with a session counter and an encrypted value, sessions in their cookie: provision and deploy; a session of two requests, a value encrypted`,
      minutes(75),
      async () => {
        const session = await readFile(join(EXAMPLES, APP_EXAMPLE, "config/session.php"), "utf8");
        const plan = await startPass(run, envs, `e2e: examples/${APP_EXAMPLE} for app secrets`, {
          "routes/web.php": LARAVEL_ROUTES,
          "config/session.php": cookieSessions(session),
        });
        expect(generatesVariable(plan, "APP_KEY"), "OpsCrew generates APP_KEY").toBe(true);
        // The example's .env.example names these; provision asks a script for their values.
        await appendFile(join(run.work, "production.env"), LARAVEL_STAND_INS);
        // Only the secret-named ones are searched for: a region or a name may be committed.
        for (const line of LARAVEL_STAND_INS.split("\n")) {
          const name = line.slice(0, line.indexOf("="));
          const value = line.slice(line.indexOf("=") + 1);
          if (/KEY|SECRET|PASSWORD/.test(name) && value.length >= 8) {
            run.scrubber.add(value, "app-env-value");
          }
        }
        await run.adaptAndMerge();
        await envs.provision("prod", "prod");
        deployRuns.push({ what: "the first deploy", id: await run.deployAny("the first deploy") });
        await run.waitForHealth();
        expect(await sessionCount({}, true), "the session's first request").toBe("1");
        expect(await sessionCount(jar, true), "the session's second request").toBe("2");
        firstJar = jar;
        const answer = await httpRequest(`${site()}/e2e-encrypt`);
        expect(answer.status, "GET /e2e-encrypt").toBe(200);
        encrypted = answer.body.trim();
        expect(await decrypted(), "the encrypted value, read back").toBe("readable");
      },
    );

    run.step(
      "2. opscrew rotate app in a script asks no name: APP_KEY changes, the old one stays in APP_PREVIOUS_KEYS, the session goes on and the value stays readable (US4, FR-2507)",
      minutes(40),
      async () => {
        const old = await appKey();
        since = new Date();
        const { shown, done } = await scriptedRotation(run, ["app"]);
        expect(shown.includes(`--confirm ${envs.app()}`), "the plan asks the app's name").toBe(
          false,
        );
        expect(
          done.output.includes("Rotated the credentials of"),
          `the result:\n${run.tail(done.output)}`,
        ).toBe(true);
        await envs.remember("prod");
        const fresh = await appKey();
        expect(fresh !== old, "APP_KEY changed on this computer").toBe(true);
        expect(await inApp("APP_KEY", fresh), "the app's APP_KEY").toBe("same");
        expect(await inApp("APP_PREVIOUS_KEYS", old), "the app's APP_PREVIOUS_KEYS").toBe("same");
        expect(await sessionCount(jar, true), "the session's request after the rotation").toBe("3");
        expect(await decrypted(), "the value encrypted before the rotation").toBe("readable");
        await mergeRecord(run, envs.paths(), "prod", { "app:APP_KEY": 2 }, since);
      },
    );

    run.step(
      "3. opscrew rotate app --drop-previous: refused in a script without --confirm <app>, then with it the old key is gone: the old session starts again and the old value can no longer be read (US4)",
      minutes(40),
      async () => {
        const args = ["app", "--drop-previous"];
        const shown = await shownRotation(run, args);
        expect(
          shown.output.includes(`--confirm ${envs.app()}`),
          `the plan asks the app's name:\n${run.tail(shown.output)}`,
        ).toBe(true);
        const unnamed = await run.opscrew(
          "rotate",
          ...args,
          ...shown.hashes.flatMap((h) => ["--approve", h]),
        );
        expect(unnamed.exitCode, `approved without the name:\n${run.tail(unnamed.output)}`).toBe(1);
        const done = await approvedRotation(run, args, shown.hashes, { confirm: envs.app() });
        expect(done.exitCode, "the drop's exit code").toBe(0);
        expect(await inApp("APP_PREVIOUS_KEYS", ""), "the app's APP_PREVIOUS_KEYS").toBe("unset");
        expect(await decrypted(), "the value encrypted with the dropped key").toBe("unreadable");
        expect(await sessionCount(firstJar, false), "a request with the old key's cookie").toBe(
          "1",
        );
        expect(await sessionCount(jar, true), "the session on the new key").toBe("4");
        await mergeRecord(run, envs.paths(), "prod", { "app:APP_KEY": 2 }, since);
        deployRuns.push({
          what: "the deploy after the drop",
          id: await deployAgain(run, "the deploy after the drop"),
        });
        await run.waitForHealth();
        expect(await sessionCount(jar, true), "the session after the next deploy").toBe("5");
      },
    );

    run.step(
      "4. Better Auth, the latest on npm, starts with both BETTER_AUTH_SECRET and BETTER_AUTH_SECRETS, keeps the session made before and makes new ones (T2509; Docker on this computer)",
      minutes(20),
      async () => {
        run.log(`Better Auth said:\n${await betterAuthCheck(run)}`);
      },
    );

    run.step("5. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
      serverLeaks.push(
        ...(await serverLogLeaks(run, await login(), "the app's server", {
          plan: await run.readPlan(),
          projects: [composeProjectOf(await run.readPlan())],
        })),
      );
      await envs.destroy("prod");
      await envs.expectNothingLeft("prod");
      await run.expectCloudflareClean();
    });

    run.step(
      "6. no app secret, old or new, in any output, deploy job's log, audit entry, commit, pull request, plan, state file or server log (SC-2503)",
      minutes(10),
      async () => {
        run.expectNothingLeaked([
          ...(await envs.leaks({ cloudflare: true })),
          ...(await deployLogLeaks(run, deployRuns)),
          ...serverLeaks,
        ]);
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

// ---------------------------------------------------------------------------------------------
// The restore pass.

const RESTORE_APP = "s3-uploads";
/** RabbitMQ, a kind snapshotted by stopping it, added to the plan. */
const BROKER = "mq";

describe.skipIf(SKIP.restore !== undefined)(
  title(
    "restore",
    `examples/${RESTORE_APP} at Hetzner with its bucket in Garage and RabbitMQ: a snapshot from before a rotation, restored`,
  ),
  () => {
    const run: LiveRun = new LiveRun({
      label: "rotation, restore",
      name: "rot-restore",
      settings: { ...SETTINGS, app: RESTORE_APP },
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const deployRuns: DeployRun[] = [];
    const serverLeaks: string[] = [];
    const before = `value-${run.runId}-before`;
    const after = `value-${run.runId}-after`;
    const wholeServer = ENV[SERVER_RESTORE_GATE] === "1";
    let snapshot = "";
    let project = "";
    let serverId: number | undefined;
    /** RabbitMQ's password before the rotation, then after it. */
    let brokerOld = "";
    let brokerNew = "";
    const login = () => deployLogin(run, envs);
    const site = () => `https://${run.appHost}`;
    const secret = async (service: string, name = "password") =>
      generatedSecret(
        await generatedValuesOf(envs.paths()),
        // PostgreSQL's password (db) is kept as dbPassword, the others under services.
        service === "db" ? ["dbPassword"] : ["services", service, name],
      );

    run.step(
      `1. examples/${RESTORE_APP} with its bucket in Garage and RabbitMQ${wholeServer ? " and PostgreSQL" : ""} added: provision, the first deploy, a file written through the app`,
      minutes(75),
      async () => {
        const plan = await startPass(
          run,
          envs,
          `e2e: examples/${RESTORE_APP} for restores after a rotation`,
        );
        await writeArtifact(
          "plan",
          run.paths().files.plan,
          withServices(withGarageBucket(plan), {
            [BROKER]: "rabbitmq",
            ...(wholeServer ? { db: "postgres" } : {}),
          }),
        );
        await run.opscrewOk("design");
        const designed = await envs.designed("prod");
        expect(designed.storage?.objectStorage?.provider, "where the bucket is").toBe("garage");
        expect(
          designed.services.filter((s) => s.enabled).map((s) => s.kind),
          "the services design kept",
        ).toEqual(expect.arrayContaining(["garage", "rabbitmq"]));
        project = composeProjectOf(designed);
        await run.adaptAndMerge();
        await envs.provision("prod", "prod");
        serverId = (await hetznerServer(SETTINGS.hcloudToken, run.app())).id;
        deployRuns.push({ what: "the first deploy", id: await run.deployAny("the first deploy") });
        await run.waitForHealth();
        await writeValue(site(), before);
      },
    );

    run.step(
      "2. opscrew snapshot --allow-downtime copies Garage and RabbitMQ, each stopped alone",
      minutes(20),
      async () => {
        const taken = await run.opscrewOk("snapshot", "--allow-downtime");
        const id = takenSnapshotId(taken.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(taken.output)}`);
        snapshot = id;
        const copied = servicesIn(snapshotOf(await listSnapshots(run), id));
        expect(copied, "the services it copied").toEqual(
          expect.arrayContaining(["garage", BROKER]),
        );
      },
    );

    run.step(
      "3. opscrew rotate garage mq in a script: the app reads and writes its files with the new key; RabbitMQ takes the new password and refuses the old",
      minutes(40),
      async () => {
        brokerOld = await secret(BROKER);
        const keyOld = await secret("garage", "secret-key");
        const since = new Date();
        const { done } = await scriptedRotation(run, ["garage", BROKER]);
        expect(
          done.output.includes("Rotated the credentials of"),
          `the result:\n${run.tail(done.output)}`,
        ).toBe(true);
        await envs.remember("prod");
        brokerNew = await secret(BROKER);
        expect(brokerNew !== brokerOld, "RabbitMQ's password changed on this computer").toBe(true);
        expect((await secret("garage", "secret-key")) !== keyOld, "Garage's key changed").toBe(
          true,
        );
        await readValue(site(), before);
        await writeValue(site(), after);
        await readValue(site(), after);
        await expectLogins(run, await login(), project, [
          {
            what: "RabbitMQ's new password",
            service: BROKER,
            kind: "rabbitmq",
            value: brokerNew,
            works: true,
          },
          {
            what: "RabbitMQ's old password",
            service: BROKER,
            kind: "rabbitmq",
            value: brokerOld,
            works: false,
          },
        ]);
        await mergeRecord(run, envs.paths(), "prod", { garage: 2, [BROKER]: 2 }, since);
      },
    );

    run.step(
      "4. opscrew restore of the snapshot from before the rotation: the app reads the snapshot's file with the current key (Garage's re-login), and RabbitMQ takes the current password, not the old (FR-2512, SC-2504)",
      minutes(40),
      async () => {
        const restored = await approvedRestore(run, [snapshot]);
        expect(
          restored.applied.output.includes(`Restored the snapshot ${snapshot}`),
          `the result:\n${run.tail(restored.applied.output)}`,
        ).toBe(true);
        await run.waitForHealth(minutes(5));
        await readValue(site(), before);
        await writeValue(site(), `${after}-restored`);
        await expectLogins(run, await login(), project, [
          {
            what: "RabbitMQ's current password",
            service: BROKER,
            kind: "rabbitmq",
            value: brokerNew,
            works: true,
          },
          {
            what: "RabbitMQ's password of the snapshot",
            service: BROKER,
            kind: "rabbitmq",
            value: brokerOld,
            works: false,
          },
        ]);
      },
    );

    const serverSkip = wholeServer
      ? {}
      : {
          skip: `set ${SERVER_RESTORE_GATE}=1 once T2520 (whole-server restores after a rotation) is on main`,
        };

    run.step(
      "W. a whole-server snapshot, PostgreSQL rotated, restore --server: the restored server's PostgreSQL takes the current password, not the old (T2520)",
      minutes(75),
      async () => {
        const taken = await run.opscrewOk("snapshot", "--server");
        const id = takenSnapshotId(taken.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(taken.output)}`);
        const old = await secret("db");
        await scriptedRotation(run, ["db"]);
        await envs.remember("prod");
        const fresh = await secret("db");
        const restored = await approvedRestore(run, ["--server", id]);
        expect(restored.confirm, "the name the restore asks to type").toBe(run.app());
        await run.waitForHealth();
        await expectLogins(run, await login(), project, [
          {
            what: "PostgreSQL's current password",
            service: "db",
            kind: "postgres",
            value: fresh,
            works: true,
          },
          {
            what: "PostgreSQL's password of the snapshot",
            service: "db",
            kind: "postgres",
            value: old,
            works: false,
          },
        ]);
        await readValue(site(), before);
        await run.opscrewOk("snapshot", "delete", id, "--confirm", id);
      },
      serverSkip,
    );

    run.step("5. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
      serverLeaks.push(
        ...(await serverLogLeaks(run, await login(), "the app's server", {
          plan: await run.readPlan(),
          projects: [project],
        })),
      );
      await envs.destroy("prod");
      await envs.expectNothingLeft("prod");
      await run.expectCloudflareClean();
    });

    run.step(
      "6. no value, old or new, in any output, deploy job's log, audit entry, commit, pull request, plan, state file or server log (SC-2503)",
      minutes(10),
      async () => {
        run.expectNothingLeaked([
          ...(await envs.leaks({ cloudflare: true })),
          ...(await deployLogLeaks(run, deployRuns)),
          ...serverLeaks,
        ]);
      },
      { always: true },
    );

    envs.registerCleanup({
      last: async (attempt) => {
        if (run.appName === undefined) return;
        const app = run.appName;
        await attempt(`delete this run's whole-server snapshots of ${app}`, () =>
          removeServerSnapshots(SETTINGS.hcloudToken, app, serverId, run.startedAt),
        );
      },
    });
  },
);
