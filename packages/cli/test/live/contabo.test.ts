/**
 * The live pass of feature 026 on Contabo (docs/e2e.md "Contabo", SC-2601, SC-2604):
 * `examples/flask-sqlite` on one Cloud VPS 4 (V153) in region EU, bought on a monthly term. Every
 * run buys a month of that server and its setup fee, so the founder is asked before any rerun
 * (research R5). The app is named after the run, so nothing of an earlier run is ever taken for
 * this one's. Steps, in order:
 * 1. the interview chooses Contabo from its four credentials alone;
 * 2. design: the plan, its dated price, its setup fee and minimum term, no provider backups;
 * 3. provision: one server, its firewall and SSH key, and no takeover;
 * 4. the first deploy, verify, and the app on its domain;
 * 5. a whole-server snapshot; 6. its restore, and verify again;
 * 7. secure and drift;
 * 8. destroy: the cancel said, the server shut down, its end date shown and audited;
 * 9. none of the four credentials in any output, log, audit entry, state file or commit.
 * The test never buys a second server: provision stops before any plan that would while Contabo
 * has one of the app. With `OPSCREW_E2E_CONTABO_PAUSE_HOURS`, a failed step from 3 to 8 waits for
 * a fix and runs again on the same server, which is paid for its month either way (research R5).
 * Whatever fails in the end after provision, the cleanup still destroys (cancels) the server, with
 * Contabo's API as the last resort; at Contabo only the cancelled server stays, until its term
 * ends.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readServerAddresses } from "@opscrew/agents";
import { cloudTarget } from "@opscrew/iac-templates";
import { readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { definition, STATIC_PRICES_AS_OF } from "@opscrew/provider-contabo";
import { describe, expect } from "vitest";
import { z } from "zod";
import { minutes } from "./cloud";
import { readValue, writeValue } from "./component-checks";
import {
  CONTABO_CREDENTIAL_VARIABLES,
  CONTABO_GATE,
  CONTABO_PLAN,
  CONTABO_REGION,
  CONTABO_VARIABLES,
  ContaboAccount,
  cancelTexts,
  contaboEnv,
  createsServer,
  dayText,
  designTexts,
  pauseMs,
  serverSnapshotId,
  shownEndDate,
  takeoverLines,
  unsaid,
  untilFixed,
} from "./contabo-support";
import { AppEnvironments } from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import {
  approvedRestore,
  type DeployRun,
  deployLogLeaks,
  listSnapshots,
  snapshotOf,
} from "./snapshots-checks";
import { approveHashes, missingVariables } from "./support";

const ENV = process.env;
/** An app with its own SQLite file, whose value shows that the restore put the snapshot back. */
const EXAMPLE = "flask-sqlite";
const SETTINGS = { ...serverSettings(ENV), app: EXAMPLE };
/** Step 3: adapt, then up to four rounds of provision; every run in it ends before this. */
const PROVISION_STEP_MS = minutes(150);
const MISSING = missingVariables(ENV, CONTABO_GATE, CONTABO_VARIABLES);
/** How long a failed step from 3 on waits for a fix, counted from step 3's start. */
const PAUSE_MS = MISSING.length > 0 ? 0 : pauseMs(ENV);
if (ENV[CONTABO_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (Contabo): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Contabo").`,
  );
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live Contabo (skipped: set ${MISSING.join(", ")}; see docs/e2e.md, "Contabo")`
    : `live Contabo: examples/${EXAMPLE} on one Cloud VPS 4 (${CONTABO_PLAN}) in ${CONTABO_REGION}`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "Contabo",
      name: "contabo",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, "");
    const { log } = run;
    const credentials = contaboEnv(ENV);
    for (const variable of Object.keys(CONTABO_CREDENTIAL_VARIABLES)) {
      run.scrubber.add(ENV[variable], variable);
    }
    const contabo = new ContaboAccount(credentials);
    const app = `e2e-cntb-${run.runId}`;
    const before = `value-${run.runId}-before`;
    const after = `value-${run.runId}-after`;
    const deployRuns: DeployRun[] = [];
    const site = () => `https://${run.appHost}`;
    const ageKey = () => join(run.work, "age-key.txt");
    /** The app's server at Contabo and its address, once provision bought it. */
    let serverId = "";
    let ipv4: string | undefined;
    let snapshot = "";
    /** Until when a failed step waits for a fix: {@link PAUSE_MS} after step 3 started. */
    let waitUntil: number | undefined;
    /** Step 3's parts a later attempt does not repeat. */
    let adapted = false;
    let provisioning = false;

    /**
     * A step on the server bought (3 to 8): with {@link PAUSE_MS}, a failed attempt waits for a fix
     * and the step runs again on the same server ({@link untilFixed}); its timeout covers the wait.
     */
    function paidStep(
      title: string,
      timeoutMs: number,
      body: (attempt: number) => Promise<void>,
    ): void {
      run.step(title, timeoutMs + PAUSE_MS, async () => {
        waitUntil ??= Date.now() + PAUSE_MS;
        await untilFixed(body, {
          folder: run.work,
          until: waitUntil,
          log,
          describe: (error) => run.cleanError(error).message,
        });
      });
    }

    /**
     * `provision` until done, as a script runs it, never buying a second server: each round plans
     * first (`--plan-only`), and a plan that creates a Contabo server while Contabo already has one
     * of the app stops the run before its apply. An apply that stops at another plan is planned
     * again. Every run is stopped by `deadline` (the step's own timeout less a margin), so no
     * apply still runs when a timed-out step's cleanup destroys. Returns every run's output.
     */
    async function provisionOnce(deadline: number): Promise<string> {
      const flags = [...run.provisionFlags, "--yes"];
      const all: string[] = [];
      /** A run of at most `cap`, stopped at the deadline; with too little time left, none starts. */
      const provision = async (cap: number, ...args: string[]) => {
        const ms = Math.min(cap, deadline - Date.now());
        if (ms < minutes(5)) throw new Error("Step 3's time is up: no provision run starts now.");
        const result = await run.opscrewWithin(ms, "provision", ...args, ...flags);
        all.push(result.output);
        return result;
      };
      const ok = (result: { exitCode: number; output: string }, what: string) => {
        if (result.exitCode !== 0) {
          throw new Error(`${what} exited with ${result.exitCode}:\n${run.tail(result.output)}`);
        }
      };
      for (let round = 1; round <= 4; round++) {
        const planned = await provision(minutes(30), "--plan-only");
        ok(planned, "opscrew provision --plan-only");
        const hashes = approveHashes(planned.output);
        if (hashes.length === 0) {
          ok(await provision(minutes(30)), "opscrew provision");
          return all.join("\n");
        }
        const servers = await contabo.appServers(app);
        if (servers.length > 0 && createsServer(planned.output)) {
          throw new Error(
            `Round ${round}'s plan creates a Contabo server, but Contabo has ${servers.length} of ${app} already (ids ${servers.map((s) => s.id).join(", ")}): the test stops before buying a second one.`,
          );
        }
        // Contabo's create may take long: an apply gets up to 75 minutes, within the step's time.
        const applied = await provision(
          minutes(75),
          ...hashes.flatMap((hash) => ["--approve", hash]),
        );
        if (applied.exitCode === 0) return all.join("\n");
        if (approveHashes(applied.output).every((hash) => hashes.includes(hash))) {
          ok(applied, "opscrew provision --approve …");
        }
        log(`provision asks for another plan; planning it (round ${round + 1})`);
      }
      throw new Error("opscrew provision did not finish after 4 rounds of plans.");
    }

    run.step(
      `1. examples/${EXAMPLE} named ${app}: init, analyze and the interview, which chooses Contabo from its four credentials alone (US1)`,
      minutes(15),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${EXAMPLE} on Contabo`,
          env: { ...credentials, CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        await envs.snapshotGithub();
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        // The run's own name (the example has none, so it would be the checkout folder's).
        const file = run.paths().files.architecture;
        const architecture = await readArtifact("architecture", file);
        await writeArtifact("architecture", file, {
          ...architecture,
          facts: { ...architecture.facts, name: app },
        });
        const answers = join(run.work, "answers.json");
        // No provider: with only Contabo's credentials set, the interview chooses it.
        await writeFile(
          answers,
          JSON.stringify({
            expectedMonthlyUsers: "<1k",
            budgetMonthly: 20,
            region: "eu-central",
            uptime: "best-effort",
            dataCriticality: "important",
            dnsProvider: "cloudflare",
            domain: run.appHost,
            keepExternalServices: { s3: false },
          }),
        );
        await run.opscrewOk("interview", "--answers", answers);
        const requirements = await readArtifact("requirements", run.paths().files.requirements);
        expect(requirements.provider, "the provider the interview chose").toBe("contabo");
      },
    );

    run.step(
      `2. design: one Cloud VPS 4 (${CONTABO_PLAN}) in ${CONTABO_REGION} priced from the table of ${STATIC_PRICES_AS_OF.slice(0, 10)}, its setup fee and minimum term said, no provider backups (US1)`,
      minutes(10),
      async () => {
        const designed = await run.opscrewOk("design");
        const plan = await envs.designed("prod");
        expect(plan.app.name, "the app's name").toBe(app);
        const target = cloudTarget(plan.target);
        expect(
          { provider: target.provider, plan: target.serverType, region: target.location },
          "the server design planned",
        ).toEqual({ provider: "contabo", plan: CONTABO_PLAN, region: CONTABO_REGION });
        expect(target.backups, "provider backups").toBe(false);
        expect(
          { source: plan.cost.source, asOf: plan.cost.asOf },
          "the price's source and date",
        ).toEqual({ source: "static", asOf: STATIC_PRICES_AS_OF });
        expect(
          plan.cost.breakdown.filter((line) => /backup/i.test(line.item)),
          "backups in the price",
        ).toEqual([]);
        expect(
          unsaid(designed.output, designTexts(STATIC_PRICES_AS_OF)),
          "what design said",
        ).toEqual([]);
        await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
        // The pass tests Contabo, not off-server copies, whose R2 bucket needs a key only the user
        // can make in Cloudflare's dashboard; the recovery copy still needs its age key, which a
        // script names, and a folder takes the copy (as the rotation passes do).
        await run.opscrewOk("snapshot", "offsite", "off");
        const copies = join(run.work, "copies");
        await mkdir(copies, { recursive: true });
        await run.opscrewOk("secrets", "folder", copies);
        run.provisionFlags = ["--key-out", ageKey()];
        log(
          `observed: ${CONTABO_PLAN} in ${CONTABO_REGION} at ${plan.cost.monthly.amount} ${plan.cost.monthly.currency} a month`,
        );
      },
    );

    paidStep(
      "3. provision: one server bought, with its Contabo firewall and SSH key, and the takeover found nothing (US1, FR-2606, FR-2607)",
      PROVISION_STEP_MS,
      async (attempt) => {
        // Every provision run ends three minutes before the attempt's own time is up.
        const deadline = Date.now() + PROVISION_STEP_MS - minutes(3);
        if (!adapted) {
          await run.adaptAndMerge();
          adapted = true;
        }
        if (!provisioning) {
          expect(
            await contabo.appServers(app),
            "the app's servers at Contabo before provision",
          ).toEqual([]);
          envs.provisioned.add("prod");
          provisioning = true;
        }
        const output = await provisionOnce(deadline);
        await envs.remember("prod");
        await run.rememberSecretFile(ageKey(), "age-identity");
        // Only the server and its address must be there for steps 4 to 8; the rest is findings,
        // which fail the run at its end without stopping it (the month is paid either way).
        const servers = await contabo.appServers(app);
        const server = servers.find((found) => found.name === app);
        if (server === undefined) throw new Error(`Contabo has no server named ${app}.`);
        serverId = server.id;
        ipv4 = (await readServerAddresses(run.paths())).deployment?.ipv4;
        if (ipv4 === undefined) throw new Error("OpsCrew recorded no address of the server.");
        const finding = (text: string) => run.findings.push(`step 3: ${text}`);
        try {
          // A later attempt takes over a server an earlier one's stopped apply created: that is
          // the takeover working (FR-2607), not a finding.
          const takeovers = takeoverLines(output);
          if (takeovers.length > 0 && attempt === 1) finding("provision printed a takeover note");
          for (const line of attempt === 1 ? [] : takeovers) log(`observed: ${line.trim()}`);
          if (servers.length !== 1) finding(`Contabo has ${servers.length} servers of the app`);
          if (server.nameOnly === true) finding("the server has no opscrew-app tag");
          if (server.cancelledUntil !== undefined) finding("the server is cancelled already");
          // Contabo's answers for firewalls and secrets are not verified yet (T2613).
          const firewall = await contabo.firewall(app);
          if (firewall === undefined) {
            finding(`Contabo has no firewall ${app}-firewall`);
          } else {
            const { status, instances } = firewall.fields;
            if (status !== "active") finding(`the firewall's status is ${String(status)}`);
            const listed = z
              .array(z.looseObject({ instanceId: z.union([z.number(), z.string()]) }))
              .safeParse(instances);
            if (!listed.success) {
              const fields = Object.keys(firewall.fields).join(", ");
              finding(`the firewall answer has no list of instances (it has ${fields})`);
            } else if (listed.data.map((i) => String(i.instanceId)).join() !== serverId) {
              finding("the firewall does not list exactly the app's server");
            }
          }
          const key = await contabo.secret(app);
          if (key === undefined) {
            finding(`Contabo has no SSH key ${app}-deploy`);
          } else {
            const { type, value } = key.fields;
            if (type !== "ssh") finding(`the SSH key's type is ${String(type)}`);
            const deployKey = (await readFile(run.paths().files.deployKeyPub, "utf8")).trim();
            if (typeof value !== "string") finding("the SSH key answer has no value to compare");
            else if (value.trim() !== deployKey) finding("the SSH key is not OpsCrew's deploy key");
          }
        } catch (error) {
          finding(`Contabo's checks: ${error instanceof Error ? error.message : String(error)}`);
        }
        log(`observed: server ${serverId}; ${run.findings.length} findings so far`);
      },
    );

    paidStep(
      "4. deploy and verify: the first deploy, and the app answers on its domain through Cloudflare",
      minutes(45),
      async () => {
        deployRuns.push({ what: "the first deploy", id: await run.deployAny("the first deploy") });
        await run.waitForHealth();
        await run.opscrewOk("verify");
        await writeValue(site(), before);
      },
    );

    paidStep(
      "5. snapshot --server: a whole-server snapshot, included in the server's price (US4)",
      minutes(30),
      async () => {
        const taken = await run.opscrewOk("snapshot", "--server");
        expect(unsaid(taken.output, ["included in the server's price"]), "its price").toEqual([]);
        const id = serverSnapshotId(taken.output);
        if (id === undefined) throw new Error(`No snapshot id:\n${run.tail(taken.output)}`);
        snapshot = id;
        const listed = snapshotOf(await listSnapshots(run), id);
        expect(listed.kind, "its kind").toBe("server");
        expect(listed.server?.name, "its server").toBe(app);
        log(`observed: the whole-server snapshot ${id}`);
      },
    );

    paidStep(
      "6. restore --server <id> after the server's name typed: the same server and address, the snapshot's data back, and verify again (SC-2601)",
      minutes(45),
      async () => {
        await writeValue(site(), after);
        const restored = await approvedRestore(run, ["--server", snapshot]);
        expect(restored.confirm, "the name the restore asks to type").toBe(app);
        expect(
          restored.applied.output.includes("and the app answers"),
          `the result says the app answers:\n${run.tail(restored.applied.output)}`,
        ).toBe(true);
        expect(
          (await contabo.appServers(app)).map((server) => server.id),
          "the app's servers after the restore",
        ).toEqual([serverId]);
        expect(
          (await readServerAddresses(run.paths())).deployment?.ipv4,
          "the server's address after the restore",
        ).toBe(ipv4);
        await run.waitForHealth();
        await readValue(site(), before);
        await run.opscrewOk("verify");
        log("observed: the restored server kept its id and address, with the snapshot's value");
      },
    );

    paidStep(
      "7. secure and drift: the Contabo firewall attached, the deploy key set, and no drift",
      minutes(20),
      async () => {
        const secure = await run.opscrew("secure");
        expect(secure.output, "secure's report").toContain("SECURITY_REPORT.md");
        const report = await readFile(run.paths().files.securityReport, "utf8");
        const { unattachedText, keylessText } = definition.texts.secops;
        expect(
          [unattachedText, keylessText].filter((text) => report.includes(text)),
          "SECURITY_REPORT.md's findings on the server",
        ).toEqual([]);
        const drift = await run.opscrew("drift");
        expect(drift.exitCode, `opscrew drift:\n${run.tail(drift.output)}`).toBe(0);
      },
    );

    paidStep(
      "8. destroy: the plan says Contabo cancels the server at the end of its term, OpsCrew shuts it down, and the end date is shown and audited; nothing else left at Contabo or in Cloudflare (US2, FR-2608)",
      minutes(40),
      async () => {
        const from = run.outputs.size;
        await envs.destroy("prod");
        const output = [...run.outputs.values()].slice(from).join("\n");
        expect(unsaid(output, cancelTexts(app)), "what destroy said").toEqual([]);
        const shown = shownEndDate(output, app);
        expect(shown, "the end date destroy showed").toBeDefined();
        const servers = await contabo.appServers(app);
        expect(
          servers.map((server) => server.id),
          "the app's servers at Contabo",
        ).toEqual([serverId]);
        const [server] = servers;
        expect(server?.cancelledUntil, "the server's end date at Contabo").toBeDefined();
        expect(dayText(server?.cancelledUntil ?? ""), "the end date shown is Contabo's").toBe(
          shown,
        );
        expect(server?.status, "the server after destroy").not.toBe("running");
        const audit = (
          await Promise.all(
            (
              await readdir(run.paths().auditDir)
            ).map((file) => readFile(join(run.paths().auditDir, file), "utf8")),
          )
        ).join("\n");
        expect(
          unsaid(audit, ['"action":"powered off"', '"action":"cancel date"', "contract ends"]),
          "the shutdown and the end date in the audit log",
        ).toEqual([]);
        expect(await contabo.left(app), "what is left at Contabo").toEqual([]);
        await run.expectCloudflareClean();
        log(
          `observed: Contabo cancelled the server ${serverId} (${server?.status}); its contract ends on ${shown}`,
        );
      },
    );

    run.step(
      "9. none of the four Contabo credentials, nor any other secret, in any output, deploy job's log, audit entry, state file, plan or commit (SC-2604)",
      minutes(10),
      async () =>
        run.expectNothingLeaked([
          ...(await envs.leaks({ cloudflare: true })),
          ...(await deployLogLeaks(run, deployRuns)),
        ]),
      { always: true },
    );

    envs.registerCleanup({
      last: async (attempt) => {
        if (run.appName === undefined) return;
        await attempt(`clean up what is left of ${app} at Contabo`, () =>
          contabo.cleanUp(app, run.destroyed, log),
        );
      },
    });
  },
);
