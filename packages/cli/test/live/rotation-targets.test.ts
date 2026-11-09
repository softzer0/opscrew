/**
 * The live passes of feature 025 on the targets OpsCrew does not create (docs/e2e.md "Credential
 * rotation"), each named in `OPSCREW_E2E_ROTATION`:
 * - **own**: examples/node-bullmq with PostgreSQL added, on a throwaway Hetzner server set up as
 *   the user's own (as the own-server pass gets one), DNS only: `rotate db queue` under load, then
 *   `deploy-key` through the server's host plans (both keys, then the new one alone), each by hash.
 * - **tunnel**: examples/flask-sqlite on such a server in tunnel mode: `rotate tunnel-token` is
 *   refused in a script, then runs in a terminal (a pty with `script`, or by hand with
 *   `OPSCREW_E2E_ROTATION_TERMINAL=1`): every connection from before Cloudflare's PATCH is still up
 *   after it, the connector restarts on the new token, and requests fail for one restart at most.
 * - **portainer**: examples/nextjs-postgres (Better Auth's secret listed in its `.env.example`)
 *   with Valkey added, in a Portainer set up as the user's: `rotate db cache app` through
 *   Portainer's Docker exec and the stack plan; the stack's Env reaches `BETTER_AUTH_SECRETS`, which
 *   its compose file names bare.
 * Each pass ends with the leak search, the server's container logs included.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { underLoad } from "./builder-checks";
import { minutes, sleep, waitFor } from "./cloud";
import { readValue, writeValue } from "./component-checks";
import { AppEnvironments, opscrewUntilApproved } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { repoInfo } from "./portainer-cloud";
import { portainerAnswers } from "./portainer-support";
import {
  execOn,
  expectProjectGone,
  type PortainerHost,
  setUpPortainer,
} from "./retarget-anywhere-checks";
import { composeProjectOf } from "./retarget-anywhere-support";
import {
  approvedRotation,
  connectionsOf,
  deployAgain,
  deploysPaused,
  expectJobRuns,
  expectLogins,
  generatedValuesOf,
  inTerminal,
  keepKeyCopy,
  type LoginCheck,
  loginExitCode,
  mergeRecord,
  onServer,
  rootLogin,
  type ServerLogin,
  scriptedRotation,
  serverLogLeaks,
  shownRotation,
  terminalMode,
  tunnelIdOf,
  underRotation,
  waitForAudit,
} from "./rotation-checks";
import {
  envValueScript,
  generatedSecret,
  generatesVariable,
  inContainerWithInput,
  listedCredentials,
  listedWindowSeconds,
  passSkip,
  ROTATION_GATE,
  type RotationPass,
  selectedPasses,
  TERMINAL_GATE,
  TUNNEL_GAP_SECONDS,
  windowAcceptor,
  withExampleVariables,
  withServices,
} from "./rotation-support";

const ENV = process.env;
const SETTINGS = serverSettings(ENV, "OPSCREW_E2E_ROTATION_SERVER_TYPE");
/** The app with PostgreSQL on your own server needs more than the cheapest type's 1 GB. */
const OWN_MEMORY_GB = 2;

/**
 * These passes test rotation, not off-server copies, whose R2 bucket needs a key only the user can
 * make in Cloudflare's dashboard: they turn them off. The recovery copy still needs its age key:
 * a script names the key's file, and a public repository gets no committed copy in a script, so a
 * folder takes it.
 */
async function keepRecoveryKey(run: LiveRun): Promise<void> {
  await run.opscrewOk("snapshot", "offsite", "off");
  const copies = join(run.work, "copies");
  await mkdir(copies, { recursive: true });
  await run.opscrewOk("secrets", "folder", copies);
  run.provisionFlags = ["--key-out", join(run.work, "age-key.txt")];
}

const PASSES = ["own", "tunnel", "portainer"] as const satisfies readonly RotationPass[];
const SKIP = Object.fromEntries(PASSES.map((pass) => [pass, passSkip(ENV, pass)])) as Record<
  (typeof PASSES)[number],
  string | undefined
>;
const NAMED = selectedPasses(ENV[ROTATION_GATE]).passes;
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

/** The tunnel's and the Access service token's secrets, for the leak search. */
const TUNNEL_OUTPUTS = [
  "tunnel_token",
  "deploy_service_token_client_secret",
  "deploy_service_token_client_id",
];

/**
 * As a user starts the app on a server they own: the interview (the throwaway server, root, the
 * test key, `serve`) and design with the pinned host key; returns the plan, which must be on it.
 */
async function designOwn(
  run: LiveRun,
  serve: "dns-only" | "tunnel",
  hostKey: string,
): Promise<DeployPlan> {
  const answers = join(run.work, "answers.json");
  await writeFile(
    answers,
    JSON.stringify({
      provider: "own",
      expectedMonthlyUsers: "<1k",
      budgetMonthly: 20,
      uptime: "best-effort",
      dataCriticality: "important",
      dnsProvider: "cloudflare",
      domain: run.appHost,
      keepExternalServices: { s3: false },
      "server.host": run.ipv4(),
      "server.port": 22,
      "server.user": "root",
      "server.key": run.keyFile,
      "server.reachable": true,
      "server.serve": serve,
    }),
  );
  await run.opscrewOk("interview", "--answers", answers);
  await run.opscrewOk("design", "--host-key", hostKey);
  const plan = await run.readPlan();
  if (plan.target.provider !== "own") {
    throw new Error(`design planned ${plan.target.provider}, not the user's own server.`);
  }
  run.appName = plan.app.name;
  return plan;
}

/** OpsCrew's deploy login on the user's own server, with its deploy key (or `keyFile`). */
function ownDeployLogin(run: LiveRun, keyFile?: string): ServerLogin {
  return { ...rootLogin(run), keyFile: keyFile ?? run.paths().files.deployKey, user: "deploy" };
}

/** `destroy --confirm <app> --undo-host`, each host plan approved by its hash, as a user ends. */
async function destroyOwn(run: LiveRun, envs: AppEnvironments): Promise<void> {
  await opscrewUntilApproved(run, ["destroy", "--confirm", run.app(), "--undo-host"]);
  run.destroyed = true;
  envs.destroyed.add("prod");
  await run.expectCloudflareClean();
}

// ---------------------------------------------------------------------------------------------
// The own pass.

const OWN_APP = "node-bullmq";

describe.skipIf(SKIP.own !== undefined)(
  title("own", `examples/${OWN_APP} with PostgreSQL on a throwaway server as your own`),
  () => {
    const run: LiveRun = new LiveRun({
      label: "rotation, own server",
      name: "rot-own",
      settings: { ...SETTINGS, app: OWN_APP },
    });
    const envs = new AppEnvironments(run, "");
    const value = `value-${run.runId}`;
    const serverLeaks: string[] = [];
    let hostKey = "";
    let project = "";
    const site = () => `https://${run.appHost}`;
    const health = async () => run.healthUrl();
    const secret = async (service: string) =>
      generatedSecret(
        await generatedValuesOf(run.paths()),
        // PostgreSQL's password (db) is kept as dbPassword, the others under services.
        service === "db" ? ["dbPassword"] : ["services", service, "password"],
      );

    run.step(
      "1. a throwaway Hetzner server with its own SSH key, outside OpsCrew",
      minutes(30),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${OWN_APP} on your own server, for credential rotation`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        await envs.snapshotGithub();
        hostKey = await run.createServer(undefined, undefined, OWN_MEMORY_GB);
      },
    );

    run.step(
      "2. DNS only, PostgreSQL added: interview, design, adapt, provision, the first deploy; a value written",
      minutes(75),
      async () => {
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        const plan = await designOwn(run, "dns-only", hostKey);
        await writeArtifact("plan", run.paths().files.plan, withServices(plan, { db: "postgres" }));
        await run.opscrewOk("design", "--host-key", hostKey);
        project = composeProjectOf(await run.readPlan());
        await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
        await keepRecoveryKey(run);
        await run.adaptAndMerge();
        envs.provisioned.add("prod");
        await run.provisionUntilDone("your own server");
        await run.rememberSecretFile(run.paths().files.deployKey, "deploy-private-key");
        await run.rememberSecretFile(run.paths().files.statePassphrase, "state-passphrase");
        await run.rememberGeneratedValues();
        await run.deployAny("the first deploy");
        await run.waitForHealth(minutes(15), false);
        await writeValue(site(), value);
      },
    );

    run.step(
      "3. opscrew rotate db queue in a script under load: no request fails beyond the window, the new values log in and the old are refused, the worker runs (US1)",
      minutes(40),
      async () => {
        const names = ["db", "queue"];
        const old = { db: await secret("db"), queue: await secret("queue") };
        const since = new Date();
        const listed = listedCredentials((await run.opscrewOk("rotate", "--json")).stdout);
        const shown = await shownRotation(run, names);
        await underRotation(
          run,
          [await health(), `${site()}/data`],
          "the rotation on your own server",
          listedWindowSeconds(listed, names),
          () => approvedRotation(run, names, shown.hashes),
        );
        await run.rememberGeneratedValues();
        const fresh = { db: await secret("db"), queue: await secret("queue") };
        const checks = (values: typeof old, which: string, works: boolean): LoginCheck[] => [
          {
            what: `db's ${which} password`,
            service: "db",
            kind: "postgres",
            value: values.db,
            works,
          },
          {
            what: `queue's ${which} password`,
            service: "queue",
            kind: "valkey",
            value: values.queue,
            works,
          },
        ];
        await expectLogins(run, rootLogin(run), project, [
          ...checks(fresh, "new", true),
          ...checks(old, "old", false),
        ]);
        await readValue(site(), value);
        await expectJobRuns(run, site(), `own-${run.runId}`);
        expect(await deploysPaused(run), "deploys paused after the rotation").toBe(false);
        await mergeRecord(run, run.paths(), "prod", { db: 2, queue: 2 }, since);
      },
    );

    run.step(
      "4. opscrew rotate deploy-key through the server's host plans, each approved by its hash: the old key no longer logs in, the new one does, and the next deploy works (US3, SC-2502)",
      minutes(60),
      async () => {
        const copy = join(run.work, "old-keys", "deploy");
        await keepKeyCopy(run.paths().files.deployKey, copy);
        expect(await loginExitCode(run, ownDeployLogin(run), copy), "the deploy key's copy").toBe(
          0,
        );
        const since = new Date();
        const { done } = await scriptedRotation(run, ["deploy-key"]);
        expect(
          done.output.includes("Replaced the deploy key"),
          `the rotation's result:\n${run.tail(done.output)}`,
        ).toBe(true);
        await run.rememberSecretFile(run.paths().files.deployKey, "deploy-private-key");
        expect(await loginExitCode(run, ownDeployLogin(run), copy), "the old deploy key").toBe(255);
        expect(
          await loginExitCode(run, ownDeployLogin(run), run.paths().files.deployKey),
          "the new deploy key",
        ).toBe(0);
        await mergeRecord(run, run.paths(), "prod", { "deploy-key": 2 }, since);
        await deployAgain(run, "the deploy after the deploy key's rotation");
        await run.waitForHealth(minutes(10), false);
        await readValue(site(), value);
      },
    );

    run.step(
      "5. destroy and --undo-host leave nothing of the app in Cloudflare",
      minutes(40),
      async () => {
        serverLeaks.push(
          ...(await serverLogLeaks(run, rootLogin(run), "your own server", {
            plan: await run.readPlan(),
            projects: [project],
          })),
        );
        await destroyOwn(run, envs);
      },
    );

    run.step(
      "6. no value, old or new, in any output, audit entry, commit, pull request, plan, state file or server log (SC-2503)",
      minutes(10),
      async () => {
        run.expectNothingLeaked([...(await envs.leaks({ cloudflare: true })), ...serverLeaks]);
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

// ---------------------------------------------------------------------------------------------
// The tunnel pass.

const TUNNEL_APP = "flask-sqlite";
/** How the tunnel token's rotation runs here, or why its step is skipped. */
const TERMINAL = terminalMode();

describe.skipIf(SKIP.tunnel !== undefined)(
  title("tunnel", `examples/${TUNNEL_APP} on a throwaway server as your own, in tunnel mode`),
  () => {
    const run: LiveRun = new LiveRun({
      label: "rotation, tunnel",
      name: "rot-tunnel",
      settings: { ...SETTINGS, app: TUNNEL_APP },
    });
    const envs = new AppEnvironments(run, "");
    const serverLeaks: string[] = [];
    let hostKey = "";

    run.step(
      "1. a throwaway Hetzner server with its own SSH key, outside OpsCrew",
      minutes(30),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${TUNNEL_APP} in tunnel mode, for the tunnel token's rotation`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        await envs.snapshotGithub();
        hostKey = await run.createServer(undefined, undefined, OWN_MEMORY_GB);
      },
    );

    run.step(
      "2. tunnel mode: interview, design, adapt, provision, the first deploy, answering through Cloudflare",
      minutes(75),
      async () => {
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        await designOwn(run, "tunnel", hostKey);
        await run.snapshotCloudflare((zone) => [
          run.appHost,
          `www.${run.appHost}`,
          `ssh-${run.app()}.${zone.name}`,
        ]);
        await keepRecoveryKey(run);
        await run.adaptAndMerge();
        envs.provisioned.add("prod");
        await run.provisionUntilDone("tunnel mode");
        await run.rememberSecretFile(run.paths().files.deployKey, "deploy-private-key");
        await run.rememberSecretFile(run.paths().files.statePassphrase, "state-passphrase");
        await run.rememberOutputs(TUNNEL_OUTPUTS);
        await run.deployAny("the first deploy");
        await run.waitForHealth();
      },
    );

    run.step(
      "3. in a script, opscrew rotate tunnel-token is refused, with or without --approve, and changes nothing",
      minutes(10),
      async () => {
        const plain = await run.opscrew("rotate", "tunnel-token");
        expect(plain.exitCode, `the run in a script:\n${run.tail(plain.output)}`).not.toBe(0);
        expect(
          plain.output.includes("runs only in a terminal"),
          `it says why:\n${run.tail(plain.output)}`,
        ).toBe(true);
        const approved = await run.opscrew("rotate", "tunnel-token", "--approve", "0".repeat(64));
        expect(approved.exitCode, `the run with --approve:\n${run.tail(approved.output)}`).toBe(2);
        expect(
          approved.output.includes("rotates only in a terminal"),
          `it says why:\n${run.tail(approved.output)}`,
        ).toBe(true);
      },
    );

    run.step(
      "4. in a terminal: every connection from before Cloudflare's PATCH is up after it, the connector restarts on the new token, and requests fail for one restart at most (R11, T2511)",
      minutes(45),
      async () => {
        const mode = TERMINAL as "pty" | "hand";
        const tunnel = await tunnelIdOf(run, `opscrew-${run.app()}`);
        const before = await connectionsOf(run, tunnel);
        expect(before.connections.length, "the tunnel's connections before").toBeGreaterThan(0);
        const since = new Date();
        // The audit entry right after Cloudflare's PATCH: the connections are read then, before
        // the next prompt (the state's refresh) is answered and the connector restarts.
        const patch = (timeoutMs?: number) =>
          waitForAudit(run.paths(), "change the Cloudflare Tunnel's secret", since, timeoutMs);
        const patched = patch().then(async () => {
          const now = await connectionsOf(run, tunnel);
          expect(
            before.connections.filter((id) => !now.connections.includes(id)),
            "connections from before the PATCH that closed after it",
          ).toEqual([]);
          run.log(
            `observed: after the PATCH, all ${before.connections.length} connections are still up`,
          );
        });
        patched.catch(() => undefined);
        const afterPatch = async () => {
          if (
            await patch(0).then(
              () => true,
              () => false,
            )
          )
            await patched;
        };
        const accept = windowAcceptor(TUNNEL_GAP_SECONDS);
        const done = await underLoad(
          [await run.healthUrl()],
          "the tunnel token's rotation",
          run.log,
          async () => {
            const terminal = await inTerminal(run, ["rotate", "tunnel-token"], mode, afterPatch);
            await Promise.race([
              patched,
              sleep(minutes(1)).then(() => {
                throw new Error("The rotation ended without an audit entry of Cloudflare's PATCH.");
              }),
            ]);
            return terminal;
          },
          async (failure) => accept(failure.at),
        );
        expect(done.exitCode, "the rotation in a terminal").toBe(0);
        const after = await waitFor(
          "the connector restarted on the new token",
          minutes(3),
          async () => {
            const now = await connectionsOf(run, tunnel);
            return now.connectors.some((id) => !before.connectors.includes(id)) &&
              now.connections.length > 0
              ? now
              : undefined;
          },
          10_000,
        );
        run.log(`observed: ${after.connectors.length} connector(s) on the new token`);
        await run.rememberOutputs(["tunnel_token"]);
        await mergeRecord(run, run.paths(), "prod", { "tunnel-token": 2 }, since);
        await run.waitForHealth();
      },
      TERMINAL === undefined
        ? {
            skip: `it needs a terminal: \`script\` (Linux, macOS, WSL) for a pty, or ${TERMINAL_GATE}=1 to run it by hand`,
          }
        : {},
    );

    run.step(
      "5. destroy and --undo-host leave nothing of the app in Cloudflare",
      minutes(40),
      async () => {
        serverLeaks.push(
          ...(await serverLogLeaks(run, rootLogin(run), "your own server", {
            projects: [composeProjectOf(await run.readPlan())],
          })),
        );
        await destroyOwn(run, envs);
      },
    );

    run.step(
      "6. no tunnel token, old or new, in any output, audit entry, commit, pull request, plan, state file or server log (SC-2503)",
      minutes(10),
      async () => {
        run.expectNothingLeaked([...(await envs.leaks({ cloudflare: true })), ...serverLeaks]);
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);

// ---------------------------------------------------------------------------------------------
// The portainer pass.

const PORTAINER_APP = "nextjs-postgres";

describe.skipIf(SKIP.portainer !== undefined)(
  title(
    "portainer",
    `examples/${PORTAINER_APP} with Valkey and Better Auth's secret in your Portainer`,
  ),
  () => {
    const repoReadToken = ENV.OPSCREW_E2E_REPO_READ_TOKEN?.trim() ?? "";
    const ghcrReadToken = ENV.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";
    const run: LiveRun = new LiveRun({
      label: "rotation, Portainer",
      name: "rot-portainer",
      settings: { ...SETTINGS, app: PORTAINER_APP },
    });
    const envs = new AppEnvironments(run, "");
    const serverLeaks: string[] = [];
    let portainer: PortainerHost | undefined;
    let project = "";
    const values = async () => {
      const json = await generatedValuesOf(run.paths());
      return {
        db: generatedSecret(json, ["dbPassword"]), // PostgreSQL's is kept as dbPassword
        cache: generatedSecret(json, ["services", "cache", "password"]),
        auth: generatedSecret(json, ["env", "BETTER_AUTH_SECRET"]),
      };
    };

    /** What the app's container holds in `name`: `same` as `value`, `other` or `unset`. */
    const inApp = (name: string, value: string) =>
      onServer(
        run,
        rootLogin(run),
        inContainerWithInput(project, "app", envValueScript(name)),
        `${value}\n`,
      );

    run.step(
      "P1. a throwaway Hetzner server with Portainer CE: an admin, the local environment and its API key",
      minutes(40),
      async () => {
        run.scrubber.add(ghcrReadToken, "OPSCREW_GHCR_READ_TOKEN");
        run.scrubber.add(repoReadToken, "OPSCREW_REPO_READ_TOKEN");
        const repo = await repoInfo(run.github);
        if (repo.private && repoReadToken === "") {
          throw new Error(
            "The throwaway repository is private, so Portainer needs a read-only token for it: set OPSCREW_E2E_REPO_READ_TOKEN (docs/e2e.md).",
          );
        }
        await run.prepareRepo({
          commit: `e2e: examples/${PORTAINER_APP} in your Portainer, for credential rotation`,
          env: {
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            OPSCREW_GHCR_READ_TOKEN: ghcrReadToken,
            ...(repo.private ? { OPSCREW_REPO_READ_TOKEN: repoReadToken } : {}),
          },
          drop: ["PORTAINER_API_KEY", ...(repo.private ? [] : ["OPSCREW_REPO_READ_TOKEN"])],
          // As a user lists the variables the app reads: Better Auth's secret, which OpsCrew makes.
          files: {
            ".env.example": withExampleVariables("", ["DATABASE_URL", "BETTER_AUTH_SECRET"]),
          },
        });
        await envs.snapshotGithub();
        portainer = await setUpPortainer(run);
        run.env.PORTAINER_API_KEY = portainer.token;
      },
    );

    run.step(
      "P2. the app in your Portainer (the updater, the tunnel) with Valkey added: provision and the first deploy",
      minutes(60),
      async () => {
        const host = portainer as PortainerHost;
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        const answers = join(run.work, "answers.json");
        await writeFile(
          answers,
          JSON.stringify(
            portainerAnswers({
              domain: run.appHost,
              url: host.url,
              redeploy: "updater",
              web: "tunnel",
            }),
          ),
        );
        await run.opscrewOk(
          "interview",
          "--answers",
          answers,
          "--portainer-cert",
          host.fingerprint,
        );
        await run.opscrewOk("design");
        await writeArtifact(
          "plan",
          run.paths().files.plan,
          withServices(await run.readPlan(), { cache: "valkey" }),
        );
        await run.opscrewOk("design");
        const plan = await envs.designed("prod");
        expect(plan.target.provider, "the plan's target").toBe("portainer");
        expect(
          generatesVariable(plan, "BETTER_AUTH_SECRET"),
          "OpsCrew generates BETTER_AUTH_SECRET",
        ).toBe(true);
        project = composeProjectOf(plan);
        await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
        await keepRecoveryKey(run);
        await run.adaptAndMerge();
        envs.provisioned.add("prod");
        await run.provisionUntilDone("the app in your Portainer");
        await run.rememberGeneratedValues();
        await run.deploy("the first deploy in your Portainer");
        await run.waitForHealth();
      },
    );

    run.step(
      "P3. opscrew rotate db cache app in a script under load, through Portainer: the new values log in and the old are refused; the stack's Env reaches BETTER_AUTH_SECRETS, named bare in the compose file (T2507, T2509)",
      minutes(45),
      async () => {
        const names = ["db", "cache", "app"];
        const old = await values();
        const since = new Date();
        const listed = listedCredentials((await run.opscrewOk("rotate", "--json")).stdout);
        const shown = await shownRotation(run, names);
        await underRotation(
          run,
          [await run.healthUrl()],
          "the rotation in your Portainer",
          listedWindowSeconds(listed, names),
          () => approvedRotation(run, names, shown.hashes),
        );
        await run.rememberGeneratedValues();
        const fresh = await values();
        await expectLogins(run, rootLogin(run), project, [
          {
            what: "db's new password",
            service: "db",
            kind: "postgres",
            value: fresh.db,
            works: true,
          },
          {
            what: "cache's new password",
            service: "cache",
            kind: "valkey",
            value: fresh.cache,
            works: true,
          },
          {
            what: "db's old password",
            service: "db",
            kind: "postgres",
            value: old.db,
            works: false,
          },
          {
            what: "cache's old password",
            service: "cache",
            kind: "valkey",
            value: old.cache,
            works: false,
          },
        ]);
        expect(fresh.auth !== old.auth, "BETTER_AUTH_SECRET changed on this computer").toBe(true);
        expect(await inApp("BETTER_AUTH_SECRET", fresh.auth), "the app's BETTER_AUTH_SECRET").toBe(
          "same",
        );
        expect(
          await inApp("BETTER_AUTH_SECRETS", `2:${fresh.auth},1:${old.auth}`),
          "the app's BETTER_AUTH_SECRETS, from the stack's Env",
        ).toBe("same");
        expect(await deploysPaused(run), "deploys paused after the rotation").toBe(false);
        await mergeRecord(
          run,
          run.paths(),
          "prod",
          { db: 2, cache: 2, "app:BETTER_AUTH_SECRET": 2 },
          since,
        );
        await deployAgain(run, "the deploy after the rotation in your Portainer");
        await run.waitForHealth(minutes(10));
        await expectLogins(run, rootLogin(run), project, [
          {
            what: "db's new password after the deploy",
            service: "db",
            kind: "postgres",
            value: fresh.db,
            works: true,
          },
        ]);
      },
    );

    run.step(
      "P4. destroy --delete-data removes the app's stacks and volumes, and nothing of the app stays in Cloudflare",
      minutes(30),
      async () => {
        serverLeaks.push(
          ...(await serverLogLeaks(run, rootLogin(run), "the Portainer host", {
            projects: [project],
          })),
        );
        await opscrewUntilApproved(run, ["destroy", "--confirm", run.app(), "--delete-data"]);
        run.destroyed = true;
        envs.destroyed.add("prod");
        await expectProjectGone(execOn(run.shell()), project);
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "P5. no value, old or new, in any output, audit entry, commit, pull request, plan, state file or container log (SC-2503)",
      minutes(10),
      async () => {
        run.expectNothingLeaked([...(await envs.leaks({ cloudflare: true })), ...serverLeaks]);
      },
      { always: true },
    );

    envs.registerCleanup();
  },
);
