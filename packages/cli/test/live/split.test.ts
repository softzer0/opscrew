/**
 * The live test of feature 018 (docs/e2e.md "Split placement and the private network", quickstart
 * "1."–"6."), with `OPSCREW_E2E_SPLIT=1`: `examples/nextjs-postgres` at Hetzner behind Cloudflare,
 * its deploys on the server's own runner, in the private throwaway repository. Postgres, with
 * seeded rows, moves to a second server (Hetzner, or DigitalOcean with
 * `OPSCREW_E2E_DIGITALOCEAN_TOKEN`) through design, provision and its maintenance window, and back.
 * Between the two moves: `status`' link, a deploy across both servers, a reboot of each, a device on
 * the private network, public SSH closed and opened again from the device, and a read-only grant.
 * Then destroy, leaving nothing. The device is a privileged Linux container on this computer
 * (`DeviceComputer`), which also runs the built CLI as "this computer" while public SSH is closed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { appDir, checkEnvironmentKey, runnerLabel } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { canConnect, minutes, waitFor } from "./cloud";
import {
  AppEnvironments,
  designProd,
  expectNoRunner,
  opscrewUntilApproved,
  waitForRunner,
} from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { repoInfo } from "./portainer-cloud";
import {
  COUNT_SQL,
  checkoutOpenDeploySetup,
  clearDeployPause,
  DeviceComputer,
  DIGEST_SQL,
  deployPauseExperiment,
  hetznerFirewall,
  hetznerServerExists,
  psql,
  rebootHetzner,
  rebootServer,
  rememberExtraServer,
  secondServer,
  seedRows,
  serverIpv4,
  serverShell,
  WRITE_SQL,
  waitForDatabasePage,
  watchOutage,
} from "./split-checks";
import {
  DATABASE,
  EXTRA_SERVER,
  estimatedRoundTrip,
  grantConnection,
  linkState,
  placeService,
  SC_1803_MS,
  SC_1804_MS,
  SPLIT_GATE,
  SPLIT_VARIABLES,
  windowMinutes,
  withinFactor,
} from "./split-support";
import { missingVariables } from "./support";

const MISSING = missingVariables(process.env, SPLIT_GATE, SPLIT_VARIABLES);
/** The default example: its Postgres service and its page that reads it are what the test checks. */
const SETTINGS = { ...serverSettings(process.env), app: "nextjs-postgres" };
const DIGITALOCEAN_TOKEN = process.env.OPSCREW_E2E_DIGITALOCEAN_TOKEN?.trim() ?? "";
const SECOND = secondServer(SETTINGS.hcloudToken, DIGITALOCEAN_TOKEN);
/** The runner's folder of an app on its server (ssh-host's `runnerDir`). */
const runnerDir = (app: string) => `/srv/runners/${app}`;
/** The device of step 6, and this computer's device of steps 7 and 8. */
const LAPTOP = "laptop";
const WORKSTATION = "workstation";
const SERVERS = ["app", EXTRA_SERVER] as const;

if (process.env[SPLIT_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (split placement): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Split placement and the private network").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live split placement (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live split placement: examples/${SETTINGS.app} at Hetzner, Postgres on a second server at ${SECOND.name}`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "split placement",
      name: "split",
      settings: SETTINGS,
      afterCli: () => remember(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken, { restoreMain: true });
    const device = new DeviceComputer(run, envs, () => remember());
    const { log } = run;
    let label = "";
    /** The seeded rows' `<count>:<checksum>`, before the first move. */
    let rows = "";
    /** Design's estimated round trip of a query to the second server (ms). */
    let estimateMs: number | undefined;
    /** The deploy pause variable's key of the app (`<app>/prod`), once known. */
    let pauseKey: string | undefined;

    async function remember(): Promise<void> {
      await envs.rememberServers();
      await rememberExtraServer(run, envs);
    }

    /** `opscrew/plan.yaml` with Postgres on `server` (`undefined`: the app's server), then design. */
    async function placeDatabase(server: string | undefined): Promise<string> {
      const file = run.paths().files.plan;
      const text = await readFile(file, "utf8");
      await writeFile(
        file,
        placeService(text, DATABASE, server, server === undefined ? undefined : SECOND.entry),
      );
      return (await run.opscrewOk("design")).output;
    }

    /**
     * A move of Postgres after its design: provision (the servers and the files), the deploy that
     * starts the new copy, `before` (the pause experiment), then the window under a watch of the
     * page, the rows compared on the server it moved to, and `--finish-move` deleting the old copy.
     * `shown` is the window design showed.
     */
    async function move(
      to: string,
      shown: number | undefined,
      before?: (plan: DeployPlan) => Promise<void>,
    ): Promise<void> {
      const planned = await run.readPlan();
      expect(planned.move, "the move design planned").toMatchObject({
        service: DATABASE,
        to,
        step: "started",
      });
      await envs.provision("prod", `the move to ${to}: its servers and files`);
      await run.deploy(`the move to ${to}: the deployment files`);
      await before?.(await run.readPlan());
      const watch = watchOutage(run);
      let window = "";
      try {
        window = await envs.provision("prod", `the move to ${to}: the window`, [
          "--allow-downtime",
        ]);
      } finally {
        const outage = await watch.stop();
        const minutesShown = shown ?? windowMinutes(window);
        log(
          `observed: the page did not answer for at most ${Math.round(outage / 1000)} s during the window (shown: ${minutesShown ?? "?"} minutes)`,
        );
        if (minutesShown === undefined) {
          run.findings.push(`neither design nor provision showed the window of the move to ${to}`);
        } else if (outage > minutesShown * 60_000) {
          run.findings.push(
            `SC-1802: the app did not answer for ${Math.round(outage / 1000)} s in the move to ${to}, longer than the ${minutesShown} minutes shown`,
          );
        }
      }
      expect((await run.readPlan()).move?.step, "the move after its window").toBe("switched");
      const plan = await run.readPlan();
      expect(
        await psql(await serverShell(run, envs, to), plan, DIGEST_SQL),
        `the rows' count and checksum on server ${to}`,
      ).toBe(rows);
      await waitForDatabasePage(run);
      await run.opscrewOk("provision", "--finish-move", "--confirm", DATABASE);
      expect((await run.readPlan()).move, "the move after --finish-move").toBeUndefined();
    }

    /** Whether SSH answers each server's private address over the device's tunnel. */
    async function deviceReaches(): Promise<boolean[]> {
      const network = (await run.readPlan()).network;
      const reached: boolean[] = [];
      for (const name of SERVERS) {
        const member = network?.members.find((m) => m.name === name);
        if (member === undefined) throw new Error(`Server ${name} is not on the private network.`);
        reached.push(await device.reachesSsh(member.address, await serverIpv4(envs, name)));
      }
      return reached;
    }

    /** Waits until the device's SSH reaches every server (SC-1804), and logs how long it took. */
    async function expectDeviceReachesAll(name: string, since: number): Promise<void> {
      await waitFor(
        `device ${name} reaching SSH on every server`,
        SC_1804_MS,
        async () => ((await deviceReaches()).every(Boolean) ? true : undefined),
        5_000,
      );
      log(
        `observed: device ${name} reached SSH on both servers ${Math.round((Date.now() - since) / 1000)} s after its tunnel came up`,
      );
    }

    run.step(
      "1. examples/nextjs-postgres at Hetzner, its deploys on the server's own runner, with 5,000 seeded rows in Postgres",
      minutes(60),
      async () => {
        run.scrubber.add(DIGITALOCEAN_TOKEN, "digitalocean-token");
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app}, Postgres on a second server`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
            ...SECOND.env,
          },
        });
        if (!(await repoInfo(run.github)).private) {
          throw new Error(
            "The split placement test runs only on a private repository: OPSCREW_E2E_GITHUB_REPO is public, and closing public SSH needs the deploys on the server's own runner, which OpsCrew refuses for a public repository. Point OPSCREW_E2E_GITHUB_REPO at a private throwaway repository.",
          );
        }
        // Before any server: the device needs Docker with WireGuard here.
        await device.build();
        await designProd(run, envs, SETTINGS.region);
        const file = run.paths().files.plan;
        const designed = await run.readPlan();
        await writeArtifact("plan", file, {
          ...designed,
          environment: {
            deploySource: { from: "main" },
            ...designed.environment,
            runner: "server",
          },
        });
        label = runnerLabel(await run.readPlan());
        await run.adaptAndMerge();
        await envs.provision("prod", "the app's server");
        await waitForRunner(run.github, label);
        await envs.rememberRunnerCredentials(await envs.shell(), runnerDir(envs.app()));
        await run.deployAny("the first deploy");
        await run.waitForHealth();
        await waitForDatabasePage(run);
        rows = await seedRows(await serverShell(run, envs, "app"), await run.readPlan());
        log(`seeded the rows: ${rows.split(":")[0]} rows`);
      },
    );

    run.step(
      `2. Postgres moved to server ${EXTRA_SERVER} at ${SECOND.name} by design, provision and its window: the rows and their checksum kept, its port closed to the internet (SC-1801, SC-1802)`,
      minutes(90),
      async () => {
        const design = await placeDatabase(EXTRA_SERVER);
        estimateMs = estimatedRoundTrip(design);
        log(`design estimates ${estimateMs ?? "no"} ms a query to server ${EXTRA_SERVER}`);
        pauseKey = checkEnvironmentKey(await run.readPlan());
        await move(EXTRA_SERVER, windowMinutes(design), async (plan) => {
          log(`observed: ${await deployPauseExperiment(run, plan)}`);
        });
        const plan = await run.readPlan();
        expect(plan.deployment.placement?.[DATABASE], "where Postgres runs").toBe(EXTRA_SERVER);
        // Provision publishes the plan without the old copy.
        await envs.provision("prod", "the plan after the move");
        await run.deploy("the plan after the move");
        await waitForDatabasePage(run);
        for (const name of SERVERS) {
          expect(
            await canConnect(await serverIpv4(envs, name), 5432),
            `Postgres' port on server ${name} from the internet`,
          ).toBe(false);
        }
        const port = plan.network?.members.find((m) => m.name === EXTRA_SERVER)?.port;
        expect(await SECOND.firewall(envs.app()), "server data's cloud firewall").toEqual(
          ["icmp", "tcp/22", `udp/${port}`].sort(),
        );
        await run.opscrewOk("verify");
      },
    );

    run.step(
      "3. status shows the link between the servers up with its round trip; logs, drift and secure cover both servers (SC-1808)",
      minutes(20),
      async () => {
        const link = await waitFor(
          `status showing the link to server ${EXTRA_SERVER} up`,
          minutes(3),
          async () => {
            const state = linkState((await run.opscrewOk("status")).output, "app", EXTRA_SERVER);
            return state?.up === true && state.roundTripMs !== undefined ? state : undefined;
          },
          20_000,
        );
        const measured = link.roundTripMs as number;
        log(
          `observed: round trip ${measured} ms measured, ${estimateMs ?? "no"} ms estimated by design`,
        );
        if (estimateMs === undefined || !withinFactor(estimateMs, measured, 2)) {
          run.findings.push(
            `SC-1808: design estimated ${estimateMs ?? "nothing"} ms a query to server ${EXTRA_SERVER}; status measured ${measured} ms`,
          );
        }
        const logs = await run.opscrewOk("logs", "--service", DATABASE);
        expect(logs.output, "logs name the server the lines are from").toContain(
          `server ${EXTRA_SERVER}`,
        );
        await run.opscrewOk("drift");
        expect((await run.opscrew("secure")).output).toContain("SECURITY_REPORT.md");
      },
    );

    run.step(
      `4. a deploy across both servers: Postgres' new memory limit reaches server ${EXTRA_SERVER}`,
      minutes(45),
      async () => {
        const file = run.paths().files.plan;
        const plan = await run.readPlan();
        const before = plan.services.find((s) => s.name === DATABASE)?.memoryMb as number;
        await writeArtifact("plan", file, {
          ...plan,
          services: plan.services.map((s) =>
            s.name === DATABASE ? { ...s, memoryMb: before - 64 } : s,
          ),
        });
        await run.opscrewOk("design");
        const designed = await run.readPlan();
        const after = designed.services.find((s) => s.name === DATABASE)?.memoryMb as number;
        expect(after, "design kept the new memory limit").not.toBe(before);
        await envs.provision("prod", "the new memory limit");
        await run.deploy("the new memory limit");
        const limit = await (await serverShell(run, envs, EXTRA_SERVER)).ok(
          `cd ${appDir(designed)} && docker inspect -f '{{.HostConfig.Memory}}' $(docker compose ps -q ${DATABASE})`,
        );
        expect(Number(limit), `Postgres' memory limit on server ${EXTRA_SERVER}`).toBe(
          after * 1024 * 1024,
        );
        await waitForDatabasePage(run);
      },
    );

    run.step(
      "5. each server rebooted: the app answers with its database within 5 minutes (SC-1803)",
      minutes(30),
      async () => {
        const app = envs.app();
        for (const name of SERVERS) {
          const asked = await rebootServer(run, envs, name, (ipv4) =>
            name === "app"
              ? rebootHetzner(SETTINGS.hcloudToken, app, ipv4)
              : SECOND.reboot(app, ipv4),
          );
          await waitForDatabasePage(run);
          const took = Date.now() - asked;
          log(
            `observed: the app answered with its database ${Math.round(took / 1000)} s after server ${name}'s reboot`,
          );
          expect(took, `the app back after server ${name}'s reboot (ms)`).toBeLessThanOrEqual(
            SC_1803_MS,
          );
        }
        await waitFor(
          "verify passing with both servers and their link back",
          minutes(3),
          async () => ((await run.opscrew("verify")).exitCode === 0 ? true : undefined),
          30_000,
        );
      },
    );

    run.step(
      `6. device ${LAPTOP} on the private network reaches SSH on both servers within a minute, and is removed (SC-1804)`,
      minutes(20),
      async () => {
        await opscrewUntilApproved(run, ["vpn", "add", LAPTOP]);
        await device.tunnelUp(LAPTOP);
        await expectDeviceReachesAll(LAPTOP, Date.now());
        expect((await run.opscrewOk("vpn", "list")).output).toContain(LAPTOP);
        await opscrewUntilApproved(run, ["vpn", "remove", LAPTOP]);
        await waitFor(
          `device ${LAPTOP} reaching no server`,
          minutes(1),
          async () => ((await deviceReaches()).some(Boolean) ? undefined : true),
          5_000,
        );
        await device.tunnelDown(LAPTOP);
      },
    );

    run.step(
      "7. public SSH closed from this computer's tunnel: port 22 refused from outside, a push still deploys, status, logs and drift over the network; then opened again (SC-1805)",
      minutes(120),
      async () => {
        const app = envs.app();
        await opscrewUntilApproved(run, ["vpn", "add", WORKSTATION, "--this-computer"]);
        await device.tunnelUp(WORKSTATION);
        await expectDeviceReachesAll(WORKSTATION, Date.now());
        expect((await device.opscrew("vpn", "list")).output).toContain("this computer");

        await opscrewUntilApproved(run, ["secure", "--close-public-ssh", "--yes"], device.opscrew);
        await checkoutOpenDeploySetup(run);
        await run.deploy("closing public SSH");
        for (const name of SERVERS) {
          const ipv4 = await serverIpv4(envs, name);
          await waitFor(
            `port 22 of server ${name} refused from outside`,
            minutes(3),
            async () => ((await canConnect(ipv4, 22)) ? undefined : true),
            10_000,
          );
        }
        expect(await hetznerFirewall(SETTINGS.hcloudToken, `${app}-firewall`)).not.toContain(
          "tcp/22",
        );
        expect(await SECOND.firewall(app)).not.toContain("tcp/22");
        await run.mergeChange("e2e: a push while public SSH is closed");
        await waitForDatabasePage(run);
        const status = await device.opscrew("status");
        expect(status.exitCode, run.tail(status.output)).toBe(0);
        expect(status.output).toContain("Public SSH: closed");
        for (const args of [["logs", "--service", DATABASE], ["drift"]]) {
          const result = await device.opscrew(...args);
          expect(
            result.exitCode,
            `opscrew ${args.join(" ")} on the device:\n${run.tail(result.output)}`,
          ).toBe(0);
        }

        await opscrewUntilApproved(run, ["secure", "--open-public-ssh", "--yes"], device.opscrew);
        await checkoutOpenDeploySetup(run);
        await run.deploy("opening public SSH");
        for (const name of SERVERS) {
          const ipv4 = await serverIpv4(envs, name);
          await waitFor(
            `port 22 of server ${name} answering again`,
            minutes(3),
            async () => ((await canConnect(ipv4, 22)) ? true : undefined),
            10_000,
          );
        }
        expect((await run.opscrewOk("status")).output).toContain("Public SSH: open");
      },
    );

    run.step(
      `8. a read-only grant to Postgres: the device reads and is refused a write; revoked, its login is gone (SC-1806)`,
      minutes(30),
      async () => {
        const granted = await opscrewUntilApproved(run, ["vpn", "grant", WORKSTATION, DATABASE]);
        const connection = grantConnection(granted.output);
        if (connection === undefined)
          throw new Error("opscrew vpn grant printed no connection details.");
        // Printed once on purpose (SC-1807's exception): kept out of the leak search's outputs.
        for (const [key, text] of run.outputs) {
          if (!text.includes(connection.password)) continue;
          run.outputs.set(
            key,
            text
              .split(connection.url)
              .join("[the grant's URL]")
              .split(connection.password)
              .join("[the grant's password]"),
          );
        }
        await run.rememberGeneratedValues();
        const login = new URL(connection.url).username;
        if (!/^[a-z0-9_-]+$/.test(login)) throw new Error("The grant's login name is not plain.");
        const read = await device.psql(connection.url, COUNT_SQL);
        expect(read.exitCode, "the device's read through its grant").toBe(0);
        expect(read.stdout.trim()).toBe(rows.split(":")[0]);
        const write = await device.psql(connection.url, WRITE_SQL);
        expect(write.exitCode, "the device's write through its read-only grant").not.toBe(0);
        expect(write.stderr).toMatch(/permission denied/);

        await opscrewUntilApproved(run, ["vpn", "revoke", WORKSTATION, DATABASE]);
        const after = await device.psql(connection.url, COUNT_SQL);
        expect(after.exitCode, "the device's read after the revoke").not.toBe(0);
        const roles = await psql(
          await serverShell(run, envs, EXTRA_SERVER),
          await run.readPlan(),
          `select count(*) from pg_roles where rolname = '${login}'`,
        );
        expect(roles, "the grant's login after the revoke").toBe("0");
        await opscrewUntilApproved(run, ["vpn", "remove", WORKSTATION]);
        await device.tunnelDown(WORKSTATION);
      },
    );

    run.step(
      `9. Postgres moved back to the app's server (the rows and their checksum kept), --finish-move, and server ${EXTRA_SERVER} deleted after its typed name`,
      minutes(90),
      async () => {
        const app = envs.app();
        const design = await placeDatabase(undefined);
        await move("app", windowMinutes(design));
        expect((await run.readPlan()).servers, "servers after the last move").toBeUndefined();
        // The plan deletes the server: its printed command confirms `<app>-data` (and the app's
        // name when the plan deletes or replaces anything else).
        await envs.provision("prod", `the deletion of server ${EXTRA_SERVER}`);
        await run.deploy("the app back on one server");
        await waitForDatabasePage(run);
        const gone =
          SECOND.provider === "hetzner"
            ? !(await hetznerServerExists(SETTINGS.hcloudToken, `${app}-${EXTRA_SERVER}`))
            : (await SECOND.left(app)).length === 0;
        expect(gone, `server ${EXTRA_SERVER} at ${SECOND.name} after its deletion`).toBe(true);
      },
    );

    run.step(
      "10. destroy leaves nothing at the providers, Cloudflare or GitHub's runners",
      minutes(30),
      async () => {
        await envs.destroy("prod");
        await expectNoRunner(run.github, label);
        await envs.expectNothingLeft("prod");
        expect(await SECOND.left(envs.app()), `what is left at ${SECOND.name}`).toEqual([]);
        await run.expectCloudflareClean();
      },
    );

    run.step(
      "11. no secret (tokens, keys, WireGuard keys, passwords, the runner's credentials) or server address in any output, commit, pull request, audit entry, plan or state file",
      minutes(10),
      async () => {
        run.expectNothingLeaked(await envs.leaks({ cloudflare: true }));
      },
      { always: true },
    );

    // After the harness's cleanup of Cloudflare: the device, the deploy pause, and what is left at
    // DigitalOcean (at Hetzner the harness's cleanup deletes it by the app's labels).
    envs.registerCleanup({
      last: async (attempt) => {
        await attempt("remove the device", () => device.remove());
        const key = pauseKey;
        if (key !== undefined) {
          await attempt("clear the deploy pause", () => clearDeployPause(run.github, key));
        }
        const app = envs.apps.get("prod");
        if (app === undefined || SECOND.provider !== "digitalocean") return;
        await attempt(`delete what is left of ${app} at ${SECOND.name}`, async () => {
          await SECOND.deleteLeft(app);
          const left = await SECOND.left(app);
          return left.length === 0 ? [] : [`${SECOND.name} still lists ${left.join(", ")}`];
        });
      },
    });
  },
);
