/**
 * The live test of feature 021 (docs/e2e.md "Advise", plan.md "7."), with `OPSCREW_E2E_ADVISE=1`:
 * `examples/nextjs-postgres` at Hetzner behind Cloudflare, on the smallest type with backups off
 * and the interview's data important, deployed first. A ballast container makes the server short
 * of memory on one reading. `advise --json` within 60 seconds (SC-2101) lists the backups, larger
 * server and Dependabot proposals (and the GitHub token's when it expires within 30 days), each
 * price matching Hetzner's live price list (SC-2104); advise changed nothing (the plan, the
 * repository, the server, and only reads in the audit log). `advise --apply` writes only the
 * plan's two fields; `provision`, approved by its hash, resizes the server and turns backups on;
 * the next `advise` lists neither (SC-2102). Then destroy, and the leak search (SC-2105).
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AdviceReport, Proposal } from "@opscrew/agents";
import { GitHubClient } from "@opscrew/connector-github";
import { hetznerConnector } from "@opscrew/connector-hetzner";
import type { ComputeOffer, ProviderExtras } from "@opscrew/contracts";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import {
  ADVISE_GATE,
  ADVISE_VARIABLES,
  adviceReport,
  BALLAST_REACHED,
  BALLAST_RUNNING,
  ballastCommand,
  ballastMb,
  expectedMonthly,
  headingOf,
  memoryShare,
  newAuditLines,
  notReads,
  SC_2101_MS,
  SMALLEST_TYPE,
  tokenDue,
  URGENCY_HEADINGS,
  unexpectedNotRead,
} from "./advise-support";
import { api, HETZNER_API, minutes, waitFor } from "./cloud";
import { AppEnvironments, designProd } from "./environment-checks";
import { type CliRun, LiveRun, serverSettings } from "./harness";
import { waitForDatabasePage, watchOutage } from "./split-checks";
import { duration, leakedLabels, missingVariables } from "./support";

const MISSING = missingVariables(process.env, ADVISE_GATE, ADVISE_VARIABLES);
/** The default example: its Postgres holds the data the interview marks important. */
const SETTINGS = { ...serverSettings(process.env), app: "nextjs-postgres" };
/** The proposals the pass makes happen, by id. */
const BACKUPS = "reliability.app.backups";
const LARGER = "size.app.larger";
const DEPENDABOT_OFF = "security.env.dependabot-off";
const GITHUB_TOKEN_EXPIRY = "upkeep.env.github-token";

if (process.env[ADVISE_GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (advise): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "Advise").`,
  );
}

/** The plan's Hetzner server target; anything else stops the run. */
function hetznerTarget(plan: DeployPlan): Extract<DeployPlan["target"], { serverType: string }> {
  const { target } = plan;
  if (target.provider !== "hetzner") throw new Error(`The plan targets ${target.provider}.`);
  return target;
}

/** `percent` of a share, to a tenth. */
const percent = (share: number) => `${Math.round(share * 1000) / 10}%`;

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live advise (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live advise: examples/${SETTINGS.app} at Hetzner on ${SMALLEST_TYPE}`,
  () => {
    const run: LiveRun = new LiveRun({
      label: "advise",
      name: "advise",
      settings: SETTINGS,
      afterCli: () => envs.rememberServers(),
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken);
    const { log } = run;
    /** Every audit line an advise run added, for the leak search. */
    const adviseAudit: string[] = [];
    /** Step 3's state before advise ran, and the audit lines its runs added, for step 4. */
    let before: { plan: string; head: string; status: string; server: HetznerServer } | undefined;
    let firstAudit: string[] = [];
    /** The type step 3's larger proposal moves the server to. */
    let proposedType = "";

    /** The app server's type and backups as Hetzner reports them. */
    interface HetznerServer {
      type: string;
      backups: boolean;
    }

    /** The app's one server at Hetzner, by OpsCrew's labels. */
    async function hetznerServer(): Promise<HetznerServer> {
      const selector = encodeURIComponent(`managed-by=opscrew,app=${envs.app()}`);
      const listed = await api(
        HETZNER_API,
        SETTINGS.hcloudToken,
        "GET",
        `/servers?label_selector=${selector}`,
      );
      const servers =
        (
          listed.json as
            | { servers?: { server_type?: { name?: string }; backup_window?: string | null }[] }
            | undefined
        )?.servers ?? [];
      const [server] = servers;
      if (listed.status !== 200 || server === undefined || servers.length !== 1) {
        throw new Error(
          `Hetzner lists ${servers.length} servers of the app (HTTP ${listed.status}).`,
        );
      }
      // Hetzner gives a backup window only while backups are on.
      return { type: server.server_type?.name ?? "", backups: server.backup_window != null };
    }

    /**
     * Hetzner's live offers and extras where the plan's server runs, read now through OpsCrew's
     * connector with the run's token (a new catalogue each time: it keeps what it read).
     */
    async function livePrices(
      location: string,
    ): Promise<{ offers: ComputeOffer[]; extras: ProviderExtras }> {
      const catalog = hetznerConnector({ env: { HCLOUD_TOKEN: SETTINGS.hcloudToken } }).catalog();
      const [offers, extras] = await Promise.all([
        catalog.listOffers(location),
        catalog.extras(location),
      ]);
      if (offers.some((offer) => offer.source !== "live") || extras.source !== "live") {
        throw new Error("Hetzner's catalogue answered with its static list, not the live one.");
      }
      return { offers, extras };
    }

    /** Each audit file's lines now (none before the first command). */
    async function auditFiles(): Promise<Map<string, string[]>> {
      const dir = run.paths().auditDir;
      const files = existsSync(dir) ? (await readdir(dir)).sort() : [];
      return new Map(
        await Promise.all(
          files.map(async (file): Promise<[string, string[]]> => {
            const text = await readFile(join(dir, file), "utf8");
            return [file, text.split(/\r?\n/).filter((line) => line.trim() !== "")];
          }),
        ),
      );
    }

    /** `opscrew advise <args>`, timed, with the audit lines it added (kept for the leak search). */
    async function advise(
      ...args: string[]
    ): Promise<{ run: CliRun; ms: number; audit: string[] }> {
      const counts = new Map(
        [...(await auditFiles())].map(([file, lines]) => [file, lines.length]),
      );
      const started = Date.now();
      const result = await run.opscrewOk("advise", ...args);
      const ms = Date.now() - started;
      const audit = newAuditLines(counts, await auditFiles());
      adviseAudit.push(...audit);
      return { run: result, ms, audit };
    }

    /**
     * SC-2104: each plan proposal's price before and after, against Hetzner's live price list for
     * the types it names, as `<id>: <problem>`; the other priced proposals are logged, not compared
     * (they price another provider).
     */
    function priceProblems(
      report: AdviceReport,
      plan: DeployPlan,
      prices: {
        offers: ComputeOffer[];
        extras: ProviderExtras;
      },
    ): string[] {
      const target = hetznerTarget(plan);
      const offer = (type: string) => {
        const found = prices.offers.find((o) => o.id === type);
        if (found === undefined) throw new Error(`Hetzner's live list has no ${type}.`);
        return found;
      };
      const problems: string[] = [];
      for (const proposal of report.proposals) {
        const { price, apply } = proposal;
        if (price === undefined) continue;
        const change = apply.kind === "plan" ? apply.change : undefined;
        if (change?.kind !== "backups" && change?.kind !== "server-type") {
          log(`observed: ${proposal.id} is priced from another list; not compared`);
          continue;
        }
        const current = offer(target.serverType);
        const expected =
          change.kind === "backups"
            ? {
                before: expectedMonthly(current, prices.extras, false),
                after: expectedMonthly(current, prices.extras, true),
              }
            : {
                before: expectedMonthly(current, prices.extras, target.backups),
                after: expectedMonthly(offer(change.serverType), prices.extras, target.backups),
              };
        const off = (shown: number, wanted: number) => Math.abs(shown - wanted) >= 0.005;
        if (off(price.before, expected.before) || off(price.after, expected.after)) {
          problems.push(
            `${proposal.id}: shows ${price.before} → ${price.after}, Hetzner's live list gives ${expected.before} → ${expected.after}`,
          );
        }
        if (price.source !== "live")
          problems.push(`${proposal.id}: priced from the ${price.source} list`);
        if (price.currency !== current.monthly.currency) {
          problems.push(
            `${proposal.id}: priced in ${price.currency}, not ${current.monthly.currency}`,
          );
        }
        log(
          `observed: ${proposal.id} costs ${price.before} → ${price.after} ${price.currency} a month (live: ${expected.before} → ${expected.after})`,
        );
      }
      return problems;
    }

    run.step(
      `1. examples/nextjs-postgres at Hetzner behind Cloudflare on ${SMALLEST_TYPE}, backups off, the data important: deployed`,
      minutes(60),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${SETTINGS.app} for advise`,
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken,
          },
        });
        await envs.snapshotGithub();
        // The interview's answers say the data is important.
        const designed = await designProd(run, envs, SETTINGS.region);
        const target = hetznerTarget(designed);
        const { offers } = await livePrices(target.location);
        if (offers.find((o) => o.id === SMALLEST_TYPE)?.available !== true) {
          throw new Error(
            `Hetzner offers no ${SMALLEST_TYPE} in ${target.location} now: set OPSCREW_E2E_REGION to another region.`,
          );
        }
        log(
          `observed: design chose ${target.serverType} in ${target.location}, backups ${target.backups ? "on" : "off"}; the plan now says ${SMALLEST_TYPE}, backups off`,
        );
        // As a user edits opscrew/plan.yaml: the smallest type, and no backups.
        await writeArtifact("plan", run.paths().files.plan, {
          ...designed,
          target: { ...target, serverType: SMALLEST_TYPE, backups: false },
        });
        await run.adaptAndMerge();
        await envs.provision("prod", "prod");
        await run.deployAny("the first deploy");
        await run.waitForHealth();
        await waitForDatabasePage(run);
        expect(await hetznerServer(), "the server at Hetzner").toEqual({
          type: SMALLEST_TYPE,
          backups: false,
        });
      },
    );

    run.step(
      "2. the server short of memory on one reading: a labelled ballast container with no restart policy holds memory until more than 85% is in use",
      minutes(10),
      async () => {
        const shell = await envs.shell();
        const mb = ballastMb(await shell.ok("cat /proc/meminfo"));
        await shell.ok(ballastCommand(mb, IMAGES.nodeAlpine.ref), minutes(5));
        const share = await waitFor(
          `more than ${percent(BALLAST_REACHED)} of the server's memory in use`,
          minutes(3),
          async () => {
            if ((await shell.ok(BALLAST_RUNNING)) === "") {
              throw new Error("The ballast container is not running (killed for memory?).");
            }
            const now = memoryShare(await shell.ok("cat /proc/meminfo"));
            return now >= BALLAST_REACHED ? now : undefined;
          },
          5_000,
        );
        log(`observed: a ballast of ${mb} MiB; ${percent(share)} of the server's memory in use`);
      },
    );

    run.step(
      `3. advise --json within 60 seconds (SC-2101) lists ${BACKUPS}, ${LARGER} on one reading and ${DEPENDABOT_OFF} (and ${GITHUB_TOKEN_EXPIRY} when the token expires within 30 days), every price Hetzner's live one (SC-2104); the text groups them by urgency`,
      minutes(10),
      async () => {
        const plan = await run.readPlan();
        before = {
          plan: await readFile(run.paths().files.plan, "utf8"),
          head: await run.git("rev-parse", "HEAD"),
          status: await run.git("status", "--porcelain"),
          server: await hetznerServer(),
        };
        const json = await advise("--json");
        const report = adviceReport(json.run.stdout);
        const ids = report.proposals.map((p) => p.id);
        log(
          `observed: advise --json took ${duration(json.ms)} (SC-2101: at most ${duration(SC_2101_MS)}) and listed ${ids.join(", ")}`,
        );
        if (json.ms > SC_2101_MS) {
          run.findings.push(`SC-2101: advise --json took ${duration(json.ms)}, over 60 seconds`);
        }
        for (const id of [BACKUPS, LARGER, DEPENDABOT_OFF]) {
          expect(
            ids,
            `advise's proposals (the repository must keep Dependabot alerts off)`,
          ).toContain(id);
        }
        expect(report.basis.app?.kind, "the basis of server app's figures").toBe("one-reading");

        const larger = report.proposals.find((p) => p.id === LARGER) as Proposal;
        if (larger.apply.kind !== "plan" || larger.apply.change.kind !== "server-type") {
          throw new Error(`${LARGER} doesn't change the server's type in the plan.`);
        }
        proposedType = larger.apply.change.serverType;
        expect(
          larger.reasons.some((r) => r.basis.kind === "one-reading"),
          `${LARGER} gives a reason from one reading`,
        ).toBe(true);
        const prices = await livePrices(hetznerTarget(plan).location);
        const sizes = (type: string) => prices.offers.find((o) => o.id === type);
        const [from, to] = [sizes(SMALLEST_TYPE), sizes(proposedType)];
        expect(to?.memoryGb ?? 0, `${proposedType}'s memory`).toBeGreaterThan(from?.memoryGb ?? 0);
        expect(to?.diskGb ?? 0, `${proposedType}'s disk`).toBeGreaterThanOrEqual(from?.diskGb ?? 0);
        expect(priceProblems(report, plan, prices), "prices against Hetzner's live list").toEqual(
          [],
        );

        const expiry = await new GitHubClient({ token: SETTINGS.githubToken, fetch }).tokenExpiry();
        const due = tokenDue(expiry, new Date());
        log(
          `observed: the GitHub token expires ${expiry === undefined ? "never" : `on ${expiry.slice(0, 10)}`}, so ${GITHUB_TOKEN_EXPIRY} is ${due ? "" : "not "}due`,
        );
        expect(ids.includes(GITHUB_TOKEN_EXPIRY), `${GITHUB_TOKEN_EXPIRY} listed`).toBe(due);
        for (const line of unexpectedNotRead(report.notRead)) {
          run.findings.push(`advise couldn't read: ${line}`);
        }

        const text = await advise();
        log(`observed: advise took ${duration(text.ms)}`);
        if (text.ms > SC_2101_MS) {
          run.findings.push(`SC-2101: advise took ${duration(text.ms)}, over 60 seconds`);
        }
        for (const proposal of report.proposals) {
          expect(
            headingOf(text.run.stdout, proposal.id),
            `the heading ${proposal.id} is under in advise's text`,
          ).toBe(URGENCY_HEADINGS[proposal.urgency]);
        }
        firstAudit = [...json.audit, ...text.audit];
      },
    );

    run.step(
      "4. advise changed nothing: the plan, the repository and the server at Hetzner as they were, and only reads in the audit log (SC-2101)",
      minutes(5),
      async () => {
        const was = before;
        if (was === undefined) throw new Error("Step 3 kept no state from before advise.");
        expect(await readFile(run.paths().files.plan, "utf8"), "opscrew/plan.yaml").toBe(was.plan);
        expect(await run.git("rev-parse", "HEAD"), "the repository's commit").toBe(was.head);
        expect(await run.git("status", "--porcelain"), "the repository's files").toBe(was.status);
        expect(await hetznerServer(), "the server at Hetzner").toEqual(was.server);
        expect(firstAudit.length, "advise's audit entries").toBeGreaterThan(0);
        expect(notReads(firstAudit), "advise's audit entries that aren't reads").toEqual([]);
        log(`observed: advise's two runs added ${firstAudit.length} audit entries, all reads`);
      },
    );

    run.step(
      `5. advise --apply ${BACKUPS} and --apply ${LARGER} change only those plan fields; provision, approved by its hash, resizes the server and turns backups on; the ballast is gone after the restart (SC-2102)`,
      minutes(45),
      async () => {
        const plan = await run.readPlan();
        const target = hetznerTarget(plan);
        const backups = await advise("--apply", BACKUPS);
        for (const shown of ["target.backups from off to on", "a month", "opscrew provision"]) {
          expect(backups.run.output, `advise --apply ${BACKUPS} shows "${shown}"`).toContain(shown);
        }
        // The plan's writer sets updatedAt on every write.
        const withBackups = await run.readPlan();
        expect(withBackups, "the plan after the backups").toEqual({
          ...plan,
          updatedAt: withBackups.updatedAt,
          target: { ...target, backups: true },
        });
        const larger = await advise("--apply", LARGER);
        for (const shown of [
          `target.serverType from ${SMALLEST_TYPE} to ${proposedType}`,
          "a month",
          "opscrew provision",
        ]) {
          expect(larger.run.output, `advise --apply ${LARGER} shows "${shown}"`).toContain(shown);
        }
        const after = await run.readPlan();
        expect(after, "the plan after the larger server").toEqual({
          ...withBackups,
          updatedAt: after.updatedAt,
          target: { ...target, backups: true, serverType: proposedType },
        });
        expect(await hetznerServer(), "the server at Hetzner after advise --apply").toEqual({
          type: SMALLEST_TYPE,
          backups: false,
        });

        const watch = watchOutage(run);
        const started = Date.now();
        let outage = 0;
        try {
          await envs.provision("prod", "the larger server and backups");
          await run.deploy("the larger server and backups");
        } finally {
          outage = await watch.stop();
        }
        log(
          `observed: provision took ${duration(Date.now() - started)}; the page answered without the database for at most ${duration(outage)}`,
        );
        await run.waitForHealth();
        await waitForDatabasePage(run);
        expect(await hetznerServer(), "the server at Hetzner after provision").toEqual({
          type: proposedType,
          backups: true,
        });
        const shell = await envs.shell();
        expect(await shell.ok(BALLAST_RUNNING), "the ballast after the restart").toBe("");
        log(
          `observed: ${percent(memoryShare(await shell.ok("cat /proc/meminfo")))} of the server's memory in use on ${proposedType}`,
        );
      },
    );

    run.step(
      `6. advise again lists neither ${BACKUPS} nor ${LARGER} (SC-2102)`,
      minutes(10),
      async () => {
        const json = await advise("--json");
        const ids = adviceReport(json.run.stdout).proposals.map((p) => p.id);
        log(
          `observed: advise --json took ${duration(json.ms)} and listed ${ids.join(", ") || "nothing"}`,
        );
        const text = await advise();
        for (const id of [BACKUPS, LARGER]) {
          expect(ids, "advise's proposals after provision").not.toContain(id);
          expect(text.run.stdout, "advise's text after provision").not.toContain(`[${id}]`);
        }
      },
    );

    run.step("7. destroy leaves nothing at Hetzner or in Cloudflare", minutes(30), async () => {
      await envs.destroy("prod");
      await envs.expectNothingLeft("prod");
      await run.expectCloudflareClean();
    });

    run.step(
      "8. no secret in any output, commit, pull request, audit entry, plan or state file, and no server address in an advise output, its JSON or its audit entries (SC-2105)",
      minutes(10),
      async () => {
        const problems = await envs.leaks({ cloudflare: true });
        const addresses = run.scrubber.entries().filter(({ label }) => label.startsWith("server-"));
        for (const [label, output] of run.outputs) {
          if (!label.includes(" opscrew advise")) continue;
          const found = leakedLabels(output, addresses);
          if (found.length > 0)
            problems.push(`the output of ${label} contains: ${found.join(", ")}`);
        }
        const audited = leakedLabels(adviseAudit.join("\n"), run.scrubber.entries());
        if (audited.length > 0) {
          problems.push(`advise's audit entries contain: ${audited.join(", ")}`);
        }
        run.expectNothingLeaked(problems);
      },
      { always: true },
    );

    // The harness's cleanup: destroy if needed, then Hetzner's API by the app's labels (the server
    // with its backups and the ballast on it), GitHub's leftovers and Cloudflare.
    envs.registerCleanup();
  },
);
