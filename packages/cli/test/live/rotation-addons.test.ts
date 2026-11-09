/**
 * The live pass of feature 025's add-ons (docs/e2e.md "Credential rotation"), with `addons` in
 * `OPSCREW_E2E_ROTATION`: examples/nextjs-postgres at Hetzner with self-hosted monitoring on its
 * own server, Beszel in hub mode and Portainer, each turned on as a user does. Then:
 * - `rotate monitoring`: Grafana's admin password changed in its read-only container (Grafana
 *   13.3's `reset-admin-password --password-from-stdin`), and the monitoring's login to
 *   PostgreSQL; the new ones work, the old are refused, and Alloy still sends PostgreSQL's figures;
 * - `rotate beszel`: the dashboard's user and its superuser take the new password and refuse the
 *   old (both PATCHed through the hub's API with curl's configuration on stdin), and the system
 *   shows up again (the agent's new token through config sync, the hub's new `id_ed25519`);
 * - `rotate portainer`: Portainer's admin takes the new password and refuses the old.
 * Each through host plans or its own plan, approved by hash in a script. Then the leak search,
 * both servers' container logs included.
 */
import { readFile } from "node:fs/promises";
import { BESZEL_EMAIL } from "@opscrew/agents";
import { ADDON_PROJECTS } from "@opscrew/connector-ssh-host";
import { PORTAINER_PORT } from "@opscrew/iac-templates";
import { MONITORING_GRAFANA_PORT, MONITORING_SERVER } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { minutes, waitFor } from "./cloud";
import { AppEnvironments, designProd } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { planServers, withoutData } from "./monitoring-support";
import { composeProjectOf } from "./retarget-anywhere-support";
import {
  deployLogin,
  expectLogins,
  generatedValuesOf,
  mergeRecord,
  onServer,
  type ServerLogin,
  scriptedRotation,
  serverLogLeaks,
} from "./rotation-checks";
import {
  basicAuthStatusScript,
  beszelStatuses,
  beszelStatusScript,
  generatedSecret,
  passSkip,
  postStatusScript,
  ROTATION_GATE,
  selectedPasses,
} from "./rotation-support";
import { type DeployRun, deployLogLeaks } from "./snapshots-checks";
import { serverIpv4 } from "./split-checks";
import { approveHashes, jsonStrings } from "./support";

const ENV = process.env;
const SETTINGS = { ...serverSettings(ENV), app: "nextjs-postgres" };
const SKIP = passSkip(ENV, "addons");
if (selectedPasses(ENV[ROTATION_GATE]).passes.includes("addons") && SKIP !== undefined) {
  console.warn(
    `OpsCrew E2E (rotation, addons): skipped, ${SKIP} (see docs/e2e.md, "Credential rotation").`,
  );
}

/** Beszel's hub on the app's server's loopback. */
const BESZEL_HUB = "http://127.0.0.1:8090";
/** The monitoring's own login to PostgreSQL. */
const MONITOR_LOGIN = { user: "opscrew_monitor", database: "postgres" };

describe.skipIf(SKIP !== undefined)(
  SKIP === undefined
    ? `live rotation, addons: examples/${SETTINGS.app} at Hetzner with monitoring, Beszel and Portainer`
    : `live rotation, addons (skipped: ${SKIP}; see docs/e2e.md)`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "rotation, add-ons",
      name: "rot-addons",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const deployRuns: DeployRun[] = [];
    const serverLeaks: string[] = [];
    let passwordFile = "";
    const login = () => deployLogin(run, envs);

    /** deploy's login to the monitoring server. */
    async function monitoringLogin(): Promise<ServerLogin> {
      return { ...(await login()), host: await serverIpv4(envs, MONITORING_SERVER) };
    }

    /** The monitoring server's address on the private network, where Grafana listens. */
    async function monitoringAddress(): Promise<string> {
      const member = (await run.readPlan()).network?.members.find(
        (m) => m.name === MONITORING_SERVER,
      );
      if (member === undefined) throw new Error("The monitoring server is not on the network.");
      return member.address;
    }

    /** Beszel's dashboard password on this computer (`beszel_secrets.json`), its values remembered. */
    async function beszelPassword(): Promise<string> {
      const json: unknown = JSON.parse(await readFile(envs.paths().files.beszelSecrets, "utf8"));
      for (const value of jsonStrings(json)) run.scrubber.add(value, "beszel-secret");
      return generatedSecret(json, ["password"]);
    }

    /** Portainer's admin password on this computer, remembered. */
    async function portainerPassword(): Promise<string> {
      const value = (await readFile(passwordFile, "utf8")).trim();
      run.scrubber.add(value, "portainer-password");
      return value;
    }

    /** The HTTP status `script` printed on the server through `server`, with `input` on stdin. */
    async function status(server: ServerLogin, script: string, input: string): Promise<string> {
      return (await onServer(run, server, script, `${input}\n`)).trim();
    }

    /** Waits up to 5 minutes until the stack has figures and logs of the app's server again. */
    async function expectFigures(what: string): Promise<void> {
      const expected = planServers(await run.readPlan());
      await waitFor(
        `every server's figures and logs in the stack ${what}`,
        minutes(5),
        async () => {
          const shown = await run.opscrewOk("addon", "status", "--env", "prod", "--json");
          return withoutData(shown.stdout, expected).length === 0 ? true : undefined;
        },
        15_000,
      );
    }

    /** `opscrew <args> --plan-only --yes`, then the same with every hash it printed, as a script runs it. */
    async function planned(args: readonly string[]): Promise<void> {
      const plan = await run.opscrewOk(...args, "--plan-only", "--yes");
      const hashes = approveHashes(plan.output);
      if (hashes.length === 0) throw new Error(`opscrew ${args.join(" ")} planned nothing.`);
      await run.opscrewOk(...args, ...hashes.flatMap((hash) => ["--approve", hash]), "--yes");
    }

    run.step(
      `1. examples/${SETTINGS.app} at Hetzner, deployed; monitoring on its own server, Beszel in hub mode and Portainer turned on`,
      minutes(120),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} with add-ons, for credential rotation`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
          },
        });
        await envs.snapshotGithub();
        await designProd(run, envs, SETTINGS.region);
        await run.adaptAndMerge();
        await envs.provision("prod", "the app's server");
        deployRuns.push({ what: "the first deploy", id: await run.deployAny("the first deploy") });
        await run.waitForHealth();
        await run.opscrewOk("addon", "enable", "monitoring", "--env", "prod");
        await envs.provision("prod", "monitoring");
        const id = await run.deploy("monitoring's files");
        if (id !== undefined) deployRuns.push({ what: "monitoring's files", id });
        await expectFigures("after monitoring was turned on");
        await planned(["addon", "enable", "beszel"]);
        await planned(["portainer", "enable"]);
        const portainer = JSON.parse(
          (await run.opscrewOk("portainer", "status", "--json")).stdout,
        ) as {
          passwordFile: string;
        };
        passwordFile = portainer.passwordFile;
        await portainerPassword();
        await beszelPassword();
        await envs.remember("prod");
      },
    );

    run.step(
      "2. opscrew rotate monitoring in a script, its host plans by hash: Grafana (read-only, 13.3) and the monitoring's PostgreSQL login take the new passwords and refuse the old; Alloy still sends figures (US8, T2519)",
      minutes(45),
      async () => {
        const path = (name: string) => ["monitoring", name];
        const before = await generatedValuesOf(envs.paths());
        const old = {
          grafana: generatedSecret(before, path("grafanaAdminPassword")),
          postgres: generatedSecret(before, path("postgresPassword")),
        };
        const since = new Date();
        const { done } = await scriptedRotation(run, ["monitoring"]);
        expect(
          done.output.includes("Rotated the monitoring's"),
          `the result:\n${run.tail(done.output)}`,
        ).toBe(true);
        await envs.remember("prod");
        const after = await generatedValuesOf(envs.paths());
        const fresh = {
          grafana: generatedSecret(after, path("grafanaAdminPassword")),
          postgres: generatedSecret(after, path("postgresPassword")),
        };
        const monitoring = await monitoringLogin();
        const grafana = await onServer(
          run,
          monitoring,
          `c=$(docker ps -q --filter label=com.docker.compose.project=${ADDON_PROJECTS.monitoring} --filter label=com.docker.compose.service=grafana | head -n 1); docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.Config.Image}}' "$c"`,
        );
        run.log(`observed: Grafana's container (read-only, image): ${grafana}`);
        expect(grafana.startsWith("true "), "Grafana's container is read-only").toBe(true);
        const api = basicAuthStatusScript(
          `http://${await monitoringAddress()}:${MONITORING_GRAFANA_PORT}/api/user`,
        );
        expect(await status(monitoring, api, fresh.grafana), "Grafana with the new password").toBe(
          "200",
        );
        expect(await status(monitoring, api, old.grafana), "Grafana with the old password").toBe(
          "401",
        );
        await expectLogins(run, await login(), composeProjectOf(await run.readPlan()), [
          {
            what: "the monitoring's new login",
            service: "db",
            kind: "postgres",
            value: fresh.postgres,
            works: true,
            as: MONITOR_LOGIN,
          },
          {
            what: "the monitoring's old login",
            service: "db",
            kind: "postgres",
            value: old.postgres,
            works: false,
            as: MONITOR_LOGIN,
          },
        ]);
        await expectFigures("after the rotation");
        await mergeRecord(run, envs.paths(), "prod", { monitoring: 2 }, since);
      },
    );

    run.step(
      "3. opscrew rotate beszel in a script, its host plan by hash: the dashboard's user and superuser take the new password and refuse the old, and the system is up again on the new token and key (US8, T2519)",
      minutes(30),
      async () => {
        const old = await beszelPassword();
        const since = new Date();
        const { done } = await scriptedRotation(run, ["beszel"]);
        expect(
          done.output.includes("Rotated Beszel's"),
          `the result:\n${run.tail(done.output)}`,
        ).toBe(true);
        const fresh = await beszelPassword();
        expect(fresh !== old, "Beszel's password changed on this computer").toBe(true);
        const server = await login();
        const body = (password: string) => JSON.stringify({ identity: BESZEL_EMAIL, password });
        for (const collection of ["users", "_superusers"]) {
          const signIn = postStatusScript(
            `${BESZEL_HUB}/api/collections/${collection}/auth-with-password`,
          );
          expect(
            await status(server, signIn, body(fresh)),
            `${collection} with the new password`,
          ).toBe("200");
          expect(
            await status(server, signIn, body(old)),
            `${collection} with the old password`,
          ).toBe("400");
        }
        const statuses = await waitFor(
          "Beszel's system up on the new token and key",
          minutes(3),
          async () => {
            const said = beszelStatuses(
              await onServer(
                run,
                server,
                beszelStatusScript(BESZEL_HUB, BESZEL_EMAIL),
                `${fresh}\n`,
              ),
            );
            return said.length > 0 && said.every((s) => s === "up") ? said : undefined;
          },
          10_000,
        );
        run.log(`observed: Beszel shows ${statuses.length} system(s) up after the rotation`);
        await mergeRecord(run, envs.paths(), "prod", { beszel: 2 }, since);
      },
    );

    run.step(
      "4. opscrew rotate portainer in a script: Portainer's admin takes the new password and refuses the old (US8)",
      minutes(20),
      async () => {
        const old = await portainerPassword();
        const since = new Date();
        const { done } = await scriptedRotation(run, ["portainer"]);
        expect(
          done.output.includes("Rotated Portainer's admin password"),
          `the result:\n${run.tail(done.output)}`,
        ).toBe(true);
        const fresh = await portainerPassword();
        const signIn = postStatusScript(`https://127.0.0.1:${PORTAINER_PORT}/api/auth`, true);
        const body = (password: string) => JSON.stringify({ username: "admin", password });
        expect(
          await status(await login(), signIn, body(fresh)),
          "Portainer with the new password",
        ).toBe("200");
        expect(
          await status(await login(), signIn, body(old)),
          "Portainer with the old password",
        ).not.toBe("200");
        await mergeRecord(run, envs.paths(), "prod", { portainer: 2 }, since);
      },
    );

    run.step("5. destroy leaves nothing at Hetzner or in Cloudflare", minutes(40), async () => {
      const plan = await run.readPlan();
      serverLeaks.push(
        ...(await serverLogLeaks(run, await login(), "the app's server", {
          projects: [composeProjectOf(plan), ADDON_PROJECTS.beszel],
        })),
        ...(await serverLogLeaks(run, await monitoringLogin(), "the monitoring server", {
          projects: [ADDON_PROJECTS.monitoring],
        })),
      );
      await envs.destroy("prod");
      await envs.expectNothingLeft("prod");
      await run.expectCloudflareClean();
    });

    run.step(
      "6. no password, old or new, in any output, deploy job's log, audit entry, commit, pull request, plan, state file or container log (SC-2503)",
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
