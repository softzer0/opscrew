/**
 * Feature 014's live checks (docs/e2e.md "Origin TLS, the recovery copy and the deeper checks"):
 * the Hetzner passes of `live.test.ts`, one per run with `OPSCREW_E2E_TLS` (`proxied`, `live`,
 * `dns-only`, `recovery`), and what the own-server and Portainer passes share with them: the origin
 * check from the server (with its fallback from a container on the edge's network), the deeper
 * checks read from the report, the zone's minimum TLS decision, and the leak search over the run's
 * outputs, commits, plans, reports, state and audit entries. Messages name labels, hostnames,
 * certificate ids and counts, never a key or an address.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readServerAddresses } from "@opscrew/agents";
import { type SharedRecord, SharedRecordSchema } from "@opscrew/connector-cloudflare";
import type { CommandResult } from "@opscrew/contracts";
import { NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { appDir, CAA_ISSUERS, type EdgeProxy, IMAGES, siteHosts } from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact } from "@opscrew/plan-schema";
import { type DeepTool, originHostChecks } from "@opscrew/secops";
import { expect } from "vitest";
import { knownSecrets, LOAD_RPS, underLoad } from "./builder-checks";
import { Cloudflare, type CloudflareZone, httpRequest, minutes, sleep } from "./cloud";
import type { DeployedRun } from "./component-checks";
import { leakSourcesOf, localLeakSources } from "./harness";
import { approveHashes, type LoadFailure, leakedLabels, newRunId, steadyLoad } from "./support";
import {
  caaAt,
  cloudflareSideProblems,
  deepProblems,
  fromEdgeNetwork,
  longestInterruption,
  type MinTlsDecision,
  minTlsDecision,
  otherRecordChanges,
  type ZoneRecord,
  type ZoneTls,
} from "./tls-support";

const runner = new NodeCommandRunner();

/** SC-1403: `secure --deep` finishes within 5 minutes on the smallest server. */
export const DEEP_TARGET_MS = minutes(5);
/** SC-1402: from a fresh clone to the finished provision within 5 minutes. */
const RESTORE_TARGET_MS = minutes(5);

// ---------------------------------------------------------------------------------------------
// Shared by every pass of feature 014.

/** Runs a command on the server and returns its result (as `deploy`, or as root). */
export type ServerRun = (command: string) => Promise<CommandResult>;

/** The app's record of its shared Cloudflare resources (`.opscrew/cloudflare.json`), if any. */
export async function readTlsRecord(
  paths: ReturnType<typeof resolveProjectPaths>,
): Promise<SharedRecord | undefined> {
  const file = paths.files.cloudflareRecord;
  if (!existsSync(file)) return undefined;
  return SharedRecordSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/**
 * The origin check from the server (FR-1423), with `opscrew secure`'s own commands and verdicts:
 * for each of `hostnames`, `openssl s_client` to 127.0.0.1:443 without the client certificate is
 * refused and the certificate served is from Cloudflare's Origin CA, and an unknown hostname is
 * refused. When the server cannot connect to 127.0.0.1:443 at all (under OpsCrew's web filter),
 * the same check runs from a throwaway container on the edge's network (research "Spike results"
 * 14), and that is a finding: `opscrew secure` then needs the same fallback. `proxy` is the
 * server's edge; `undefined` for a Portainer stack, which has no edge network (and no web filter).
 * Returns the failed checks and the findings.
 */
export async function originCheck(
  run: ServerRun,
  hostnames: readonly string[],
  proxy: EdgeProxy | undefined,
  log: (message: string) => void,
): Promise<{ problems: string[]; findings: string[] }> {
  const problems: string[] = [];
  const findings: string[] = [];
  const image = IMAGES.testssl.ref;
  for (const check of originHostChecks(hostnames)) {
    const direct = await run(check.command);
    let result = check.evaluate(direct);
    const unreachable =
      ![124, 127].includes(direct.exitCode) && !/^CONNECTED\(/m.test(direct.stdout);
    if (unreachable && proxy !== undefined) {
      log(`${check.title}: 127.0.0.1:443 could not be reached; checking from the edge's network`);
      const absent = (await run(`docker image inspect ${image} >/dev/null 2>&1`)).exitCode !== 0;
      result = check.evaluate(await run(fromEdgeNetwork(check.command, proxy, image)));
      if (absent) await run(`docker image rm ${image} >/dev/null 2>&1`);
      findings.push(
        `${check.title}: the server could not connect to 127.0.0.1:443 under OpsCrew's web filter; from a container on the edge's network the check gave "${result.status}", so opscrew secure needs that fallback (research "Spike results" 14)`,
      );
    }
    if (result.status !== "pass") problems.push(`${check.title}: ${result.message}`);
    else log(`from the server: ${result.message}`);
  }
  return { problems, findings };
}

/**
 * `opscrew secure --deep` as a user runs it, timed (SC-1403): it must not stop with an error (a
 * failed check is exit 1, which the report then explains), and its report's deeper checks must
 * meet `expected` ({@link deepProblems}). Returns how long it took.
 */
export async function secureDeep(
  opscrew: (...args: string[]) => Promise<{ exitCode: number; output: string }>,
  reportFile: string,
  expected: { ran: readonly DeepTool[]; skipped?: readonly DeepTool[] },
  tail: (text: string) => string = (text) => text.slice(-3_000),
): Promise<number> {
  const started = Date.now();
  const secure = await opscrew("secure", "--deep");
  const took = Date.now() - started;
  expect([0, 1], `opscrew secure --deep ended with an error:\n${tail(secure.output)}`).toContain(
    secure.exitCode,
  );
  const report = await readFile(reportFile, "utf8");
  expect(deepProblems(report, expected), "the deeper checks in SECURITY_REPORT.md").toEqual([]);
  return took;
}

/**
 * Runs `body` (a proxy switch's deploy) under the steady load of {@link LOAD_RPS} requests per
 * second on `url`, as `underLoad` does, but only measures: returns the longest stretch of failed
 * requests (`longestInterruption`), how many failed and how many were sent.
 */
export async function interruptionOf(
  url: string,
  body: () => Promise<unknown>,
): Promise<{ longestMs: number; failed: number; sent: number }> {
  const load = steadyLoad(
    async () => {
      const answer = await fetch(url, {
        headers: { "User-Agent": "opscrew-e2e" },
        signal: AbortSignal.timeout(10_000),
      });
      await answer.arrayBuffer();
      return answer.status;
    },
    LOAD_RPS,
    () => undefined,
  );
  let summary: { sent: number; failures: LoadFailure[] } = { sent: 0, failures: [] };
  try {
    await body();
  } finally {
    summary = await load.stop();
  }
  return {
    longestMs: longestInterruption(summary.failures, 1000 / LOAD_RPS),
    failed: summary.failures.length,
    sent: summary.sent,
  };
}

/**
 * Stops when Docker does not answer on this computer: `opscrew secure --deep` runs ssh-audit and
 * testssl.sh in it. `what` names the pass in the message.
 */
export async function requireDocker(what: string): Promise<void> {
  const docker = await runner
    .run("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 60_000 })
    .catch(() => ({ exitCode: -1 }));
  if (docker.exitCode !== 0) {
    throw new Error(
      `${what} runs \`opscrew secure --deep\`, whose ssh-audit and testssl.sh need Docker on this computer (\`docker version\` failed); start Docker and run it again.`,
    );
  }
}

/**
 * What the zone's minimum TLS version shows of the plan's `decision` (research R4; the test never
 * sets it back): raised to 1.2 and recorded in `.opscrew/cloudflare.json` when the zone qualified,
 * unchanged otherwise.
 */
export function minTlsProblems(
  decision: MinTlsDecision,
  before: ZoneTls["minTls"],
  now: ZoneTls["minTls"],
  record: SharedRecord | undefined,
): string[] {
  const recorded = record?.zoneSettings?.minTlsVersion !== undefined;
  if (decision === "raise") {
    return now.value === "1.2" && recorded
      ? []
      : [
          `the zone qualified for TLS 1.2, but its minimum is ${now.value}${recorded ? "" : " and the record does not say OpsCrew set it"}`,
        ];
  }
  return now.value === before.value && !recorded
    ? []
    : [
        `the zone's minimum TLS went from ${before.value} to ${now.value}, though the plan had to ${decision === "advise" ? "only advise it" : "leave it"}`,
      ];
}

/**
 * The leak search's known values of a run that made the recovery copy: `known`, and the age
 * identity in `keyFile` (a finding when the file is missing: the first copy's key was not
 * written).
 */
export async function withAgeIdentity(
  known: readonly { label: string; value: string }[],
  keyFile: string,
  findings: string[],
): Promise<{ label: string; value: string }[]> {
  if (!existsSync(keyFile)) {
    findings.push(
      "the recovery copy's key file was not written, so the leak search misses the age identity",
    );
    return [...known];
  }
  return [...known, { label: "age-identity", value: (await readFile(keyFile, "utf8")).trim() }];
}

// ---------------------------------------------------------------------------------------------
// The Hetzner passes.

/** The Hetzner passes of feature 014, one per run (`OPSCREW_E2E_TLS`). */
export const TLS_PASSES = ["proxied", "live", "dns-only", "recovery"] as const;
export type TlsPassName = (typeof TLS_PASSES)[number];

/** What a Hetzner pass of feature 014 needs from its variables. */
export interface TlsSettings {
  pass: TlsPassName;
  cloudflareToken: string;
  domain: string;
  /** `live`: a token for the zone without SSL and Certificates and Zone Settings. */
  noTlsToken?: string;
}

/** The app the recovery pass writes its row into (its Postgres service). */
const RECOVERY_APP = "nextjs-postgres";

/**
 * The pass `OPSCREW_E2E_TLS` names for `app` (an example name, `undefined` for a GitHub
 * repository); `{ skip }` with the reason the run is skipped (a missing variable, an app the pass
 * cannot use); or the line the Hetzner pass logs when the variable is not set.
 */
export function tlsSettings(
  app: string | undefined,
  env: Record<string, string | undefined>,
): TlsSettings | { skip: string } | string {
  const pass = env.OPSCREW_E2E_TLS?.trim() ?? "";
  if (pass === "") {
    return `not checked: the origin TLS passes of feature 014 (set OPSCREW_E2E_TLS to ${TLS_PASSES.join(", ")}; see docs/e2e.md)`;
  }
  if (!(TLS_PASSES as readonly string[]).includes(pass)) {
    return { skip: `OPSCREW_E2E_TLS="${pass}" is not one of ${TLS_PASSES.join(", ")}` };
  }
  const cloudflareToken = env.OPSCREW_E2E_CLOUDFLARE_TOKEN ?? "";
  const domain = (env.OPSCREW_E2E_DOMAIN ?? "").trim().toLowerCase();
  if (cloudflareToken === "" || domain === "") {
    return {
      skip: "the origin TLS passes need the Cloudflare zone: set OPSCREW_E2E_CLOUDFLARE_TOKEN and OPSCREW_E2E_DOMAIN",
    };
  }
  if (pass === "recovery" && app !== RECOVERY_APP) {
    return {
      skip: `the recovery pass checks a row in the app's Postgres, so it runs with OPSCREW_E2E_APP=${RECOVERY_APP} (the default)`,
    };
  }
  const noTlsToken = env.OPSCREW_E2E_CLOUDFLARE_TOKEN_NO_TLS ?? "";
  if (pass === "live" && noTlsToken === "") {
    return {
      skip: "the live pass deploys first without origin protection: set OPSCREW_E2E_CLOUDFLARE_TOKEN_NO_TLS, a token for the zone without SSL and Certificates and Zone Settings (docs/e2e.md)",
    };
  }
  return {
    pass: pass as TlsPassName,
    cloudflareToken,
    domain,
    ...(noTlsToken ? { noTlsToken } : {}),
  };
}

/**
 * Stops before any GitHub or cloud change when the pass could not run: Docker on this computer
 * for the deeper checks (`proxied`), and for `live` a token that really cannot read the zone's
 * origin certificates (else the first deploy would already get origin protection).
 */
export async function tlsPreflight(settings: TlsSettings): Promise<void> {
  if (settings.pass === "proxied") await requireDocker("The proxied pass");
  if (settings.pass === "live") {
    const zone = await new Cloudflare(settings.cloudflareToken).zoneOf(settings.domain);
    const read = await new Cloudflare(settings.noTlsToken ?? "").call(
      "GET",
      `/certificates?zone_id=${zone.id}`,
    );
    if (read.status === 200) {
      throw new Error(
        "OPSCREW_E2E_CLOUDFLARE_TOKEN_NO_TLS can read the zone's origin certificates, so the first deploy would get origin protection already: remove SSL and Certificates (and Zone Settings) from that token (docs/e2e.md).",
      );
    }
  }
}

/** What `live.test.ts` needs from the pass before and around its run. */
export interface PreparedRun {
  repo: string;
  env: Record<string, string | undefined>;
  opscrew: DeployedRun["opscrew"];
}

/** The pass's hooks into `deployAndTearDown` of `live.test.ts`. */
export interface TlsPassHooks {
  /** More variables for every CLI run (the narrower token of `live`). */
  env: Record<string, string>;
  /** `--key-out <file>` for every provision: the recovery copy's first key. */
  provisionFlags: string[];
  /** A change to `opscrew/plan.yaml` after design, which design would undo (`dns-only`). */
  finalPlanEdit?: (plan: DeployPlan) => DeployPlan;
  /** After adapt, before the first provision: the folder copy, and the zone as it was. */
  beforeProvision: (run: PreparedRun) => Promise<void>;
  afterDeploy: (run: DeployedRun) => Promise<void>;
  /**
   * After the teardown: removes what of the run's origin TLS is left (a problem after a finished
   * destroy), and checks that nothing else in the zone changed. Returns the problems.
   */
  afterTeardown: (destroyed: boolean) => Promise<string[]>;
}

/**
 * The hooks of one Hetzner pass of feature 014. `tokens` are the tokens the leak search looks for.
 * Every pass makes the recovery copy (its key to a file of the test's own, its folder copy next to
 * it), and ends with the minimum-TLS decision and the leak search; the teardown then revokes and
 * removes what the run left at Cloudflare and checks that nothing else in the zone changed.
 */
export function tlsPass(
  settings: TlsSettings,
  tokens: readonly { label: string; value: string | undefined }[],
): TlsPassHooks {
  const log = (message: string) => console.log(`OpsCrew E2E (TLS, ${settings.pass}): ${message}`);
  const cloudflare = new Cloudflare(settings.cloudflareToken);
  // Outside the repository and OpsCrew's folder, as the key file must be; created before provision.
  const dir = join(tmpdir(), `opscrew-e2e-tls-${newRunId()}`);
  const keyFile = join(dir, "age-key.txt");
  const copies = join(dir, "copies");
  let zone: CloudflareZone | undefined;
  let hostnames: string[] = [];
  let before: { tls: ZoneTls; records: ZoneRecord[] } | undefined;
  let decision: MinTlsDecision = "none";

  return {
    env: settings.pass === "live" ? { CLOUDFLARE_API_TOKEN: settings.noTlsToken ?? "" } : {},
    provisionFlags: ["--key-out", keyFile],
    ...(settings.pass === "dns-only"
      ? {
          finalPlanEdit: (plan: DeployPlan): DeployPlan => ({
            ...plan,
            dns: { ...plan.dns, proxied: false },
            security: { ...plan.security, httpAllowedFrom: "any" },
          }),
        }
      : {}),

    async beforeProvision(run) {
      await mkdir(copies, { recursive: true });
      const folder = await run.opscrew("secrets", "folder", copies);
      expect(folder.exitCode, `opscrew secrets folder:\n${folder.output}`).toBe(0);
      hostnames = siteHosts(await readArtifact("plan", join(run.repo, "opscrew/plan.yaml")));
      zone = await cloudflare.zoneOf(settings.domain);
      before = {
        tls: await cloudflare.zoneTls(zone, hostnames),
        records: await cloudflare.zoneRecords(zone),
      };
      decision = minTlsDecision(before.tls.minTls, before.records);
      log(
        `the zone's minimum TLS is ${before.tls.minTls.value}; the plan must ${{ raise: "raise it to 1.2", advise: "only advise raising it", none: "leave it" }[decision]}`,
      );
    },

    async afterDeploy(run) {
      const z = zone as CloudflareZone;
      const was = before as { tls: ZoneTls; records: ZoneRecord[] };
      const paths = () => resolveProjectPaths(run.repo, { env: run.env });
      const record = () => readTlsRecord(paths());
      const plan = await readArtifact("plan", join(run.repo, "opscrew/plan.yaml"));
      const ipv4 = (await readServerAddresses(paths())).deployment?.ipv4 as string;
      const exec: ServerRun = (command) => run.sshRun(ipv4, command);
      const health = `https://${plan.dns.domain}${plan.app.healthPath}`;
      const findings: string[] = [];

      if (settings.pass === "proxied") {
        await expectSite(health, true);
        expect(
          cloudflareSideProblems(await cloudflare.zoneTls(z, hostnames), await record(), hostnames),
          "the app's origin TLS at Cloudflare",
        ).toEqual([]);
        const origin = await originCheck(exec, hostnames, "caddy", log);
        findings.push(...origin.findings);
        expect(origin.problems, "the origin check from the server").toEqual([]);
        const took = await secureDeep(run.opscrew, paths().files.securityReport, {
          ran: ["lynis", "ssh-audit", "testssl"],
        });
        log(`opscrew secure --deep took ${Math.round(took / 1000)} s`);
        if (took > DEEP_TARGET_MS) {
          findings.push(`opscrew secure --deep took ${Math.round(took / 1000)} s, over 5 minutes`);
        }
        const report = await readFile(paths().files.securityReport, "utf8");
        const rows = report
          .split(/\r?\n/)
          .filter((line) => line.includes("accepts only Cloudflare"));
        expect(rows.length, "secure checked origin TLS from the server").toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.startsWith("| Pass |"), `secure's origin check: ${row}`).toBe(true);
        }
      }

      if (settings.pass === "live") {
        await expectSite(health, true);
        expect(
          (await record())?.tls?.gap,
          "without the permissions, provision recorded the gap for secure (FR-1405)",
        ).toBe("permission");
        expect((await record())?.tls?.origin, "no origin certificate yet").toBeUndefined();
        // The user adds the permissions and provisions again, while visitors keep coming.
        run.env.CLOUDFLARE_API_TOKEN = settings.cloudflareToken;
        await underLoad([health], "turning on origin protection on the live app", log, () =>
          provisionAndDeploy(run, ["--key-out", keyFile], log),
        );
        await expectSite(health, true);
        expect(
          cloudflareSideProblems(await cloudflare.zoneTls(z, hostnames), await record(), hostnames),
          "the app's origin TLS at Cloudflare",
        ).toEqual([]);
        const origin = await originCheck(exec, hostnames, "caddy", log);
        findings.push(...origin.findings);
        expect(origin.problems, "the origin check from the server").toEqual([]);
      }

      if (settings.pass === "dns-only") {
        await expectSite(health, false);
        const records = await cloudflare.zoneRecords(z);
        const domain = plan.dns.domain as string;
        expect(caaAt(records, domain), `the CAA records at ${domain}`).toEqual(
          [...CAA_ISSUERS.caddy].sort().map((issuer) => ({ issuer, opscrew: true })),
        );
        expect(caaAt(records, z.name), "the CAA records at the zone's apex are unchanged").toEqual(
          caaAt(was.records, z.name),
        );
        expect((await record())?.tls?.origin, "no origin certificate for DNS only").toBeUndefined();
      }

      if (settings.pass === "recovery") {
        findings.push(...(await recoveryChecks(run, plan, ipv4, { keyFile, copies, log })));
      }

      const now = await cloudflare.zoneTls(z, hostnames);
      expect(
        minTlsProblems(decision, was.tls.minTls, now.minTls, await record()),
        "the zone's minimum TLS",
      ).toEqual([]);

      const known = await withAgeIdentity(await knownSecrets(run, plan, tokens), keyFile, findings);
      if (settings.pass !== "dns-only") {
        const generated = JSON.parse(
          await readFile(join(paths().projectHomeDir, "generated_values.json"), "utf8"),
        ) as { originTls?: { ORIGIN_TLS_KEY?: string; ORIGIN_PULL_KEY?: string } };
        if (!generated.originTls?.ORIGIN_TLS_KEY || !generated.originTls.ORIGIN_PULL_KEY) {
          findings.push("OpsCrew kept no origin TLS keys, so the leak search misses them");
        }
      }
      const problems = await leakProblems(run, known, [join(copies, `${plan.app.name}.sops.json`)]);
      for (const problem of problems) log(`leak: ${problem}`);
      expect(problems, "nothing leaked").toEqual([]);
      log(`none of the ${known.length} known secret values leaked`);
      for (const finding of findings) log(`finding: ${finding}`);
      expect(findings, "findings of the pass").toEqual([]);
    },

    async afterTeardown(destroyed) {
      const problems: string[] = [];
      try {
        if (zone === undefined || before === undefined) return problems;
        const removal = await cloudflare.removeTlsOfRun(zone, before.tls, hostnames, log);
        problems.push(...removal.problems);
        if (destroyed) {
          problems.push(
            ...removal.removed.map((what) => `destroy left ${what}; the test removed it`),
          );
        }
        const now = await cloudflare.zoneTls(zone, hostnames);
        problems.push(
          ...otherRecordChanges(before.records, await cloudflare.zoneRecords(zone), hostnames).map(
            (change) => `in the zone, ${change} during the run`,
          ),
        );
        const ours = new Set(hostnames);
        const others = (tls: ZoneTls) =>
          tls.originCertificates
            .filter((cert) => !cert.hostnames.some((host) => ours.has(host.toLowerCase())))
            .map((cert) => cert.id)
            .sort();
        if (JSON.stringify(others(now)) !== JSON.stringify(others(before.tls))) {
          problems.push("the zone's other origin certificates changed during the run");
        }
        if (
          JSON.stringify([...now.clientCertificates].sort()) !==
          JSON.stringify([...before.tls.clientCertificates].sort())
        ) {
          problems.push("the zone's client certificates are not as before the run");
        }
        // Only the raise the plan had to make (checked against the record after the deploy).
        const changed = now.minTls.value !== before.tls.minTls.value;
        if (changed && !(decision === "raise" && now.minTls.value === "1.2")) {
          problems.push(
            `the zone's minimum TLS went from ${before.tls.minTls.value} to ${now.minTls.value}`,
          );
        }
        return problems;
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

/** Waits up to 5 minutes until `url` answers 200, through Cloudflare (`cf-ray`) or straight. */
async function expectSite(url: string, throughCloudflare: boolean): Promise<void> {
  const deadline = Date.now() + minutes(5);
  let last = "";
  while (Date.now() < deadline) {
    const answer = await httpRequest(url).catch((error: unknown) => {
      last = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (answer !== undefined) {
      const ray = answer.headers["cf-ray"] !== undefined;
      if (answer.status === 200 && ray === throughCloudflare) return;
      last = `HTTP ${answer.status}${ray ? " with" : " without"} Cloudflare's cf-ray header`;
    }
    await sleep(10_000);
  }
  throw new Error(
    `The site did not answer 200 ${throughCloudflare ? "through" : "without"} Cloudflare within 5 minutes (last: ${last}).`,
  );
}

/**
 * `provision --plan-only`, then `provision --approve <each printed hash>` (with `flags`), then its
 * deploy: the deploy-setup pull request it left checked out merged and its run, or the deploy
 * workflow it started itself (a renewed certificate or a changed secret alone). Either must
 * succeed.
 */
async function provisionAndDeploy(
  run: DeployedRun,
  flags: readonly string[],
  log: (message: string) => void,
): Promise<void> {
  const planned = await run.opscrew("provision", "--plan-only", ...flags, "--yes");
  expect(planned.exitCode, planned.output).toBe(0);
  const hashes = approveHashes(planned.output);
  expect(hashes.length, `provision planned the origin TLS:\n${planned.output}`).toBeGreaterThan(0);
  const since = new Date();
  const applied = await run.opscrew(
    "provision",
    ...hashes.flatMap((hash) => ["--approve", hash]),
    ...flags,
    "--yes",
  );
  expect(applied.exitCode, applied.output).toBe(0);
  const head = await run.git("rev-parse", "--abbrev-ref", "HEAD");
  let deployed: Awaited<ReturnType<DeployedRun["github"]["waitForDeploy"]>>;
  if (head.startsWith("opscrew/deploy-setup")) {
    const pull = await run.github.openPullRequest(head);
    expect(pull, `an open pull request from ${head}`).toBeDefined();
    log(`merging the deploy pull request #${pull} and waiting for its deploy run`);
    const sha = await run.github.merge(pull as number);
    await run.git("fetch", "-q", "origin");
    await run.git("checkout", "-q", "-B", "main", "origin/main");
    deployed = await run.github.waitForDeploy({ headSha: sha }, minutes(25));
  } else {
    log("provision committed nothing; waiting for the deploy run it started");
    deployed = await run.github.waitForDeploy(
      { headSha: await run.git("rev-parse", "HEAD"), event: "workflow_dispatch", since },
      minutes(25),
    );
  }
  expect(deployed.conclusion, `the deploy run ${deployed.id}`).toBe("success");
}

/**
 * The leak search of a pass (SC-1406): none of `known` is in the run's CLI outputs, its commits,
 * pull requests and audit entries, its saved plans, reports, record and state, or `extra` (the
 * folder copy). Returns the problems, by label only.
 */
async function leakProblems(
  run: DeployedRun,
  known: readonly { label: string; value: string }[],
  extra: readonly string[],
): Promise<string[]> {
  const paths = resolveProjectPaths(run.repo, { env: run.env });
  const problems: string[] = [];
  for (const [index, output] of run.outputs.entries()) {
    const found = leakedLabels(output, known);
    if (found.length > 0) problems.push(`CLI run #${index + 1} printed: ${found.join(", ")}`);
  }
  const sources = [
    ...(await leakSourcesOf({
      git: run.git,
      github: run.github,
      startedAt: run.startedAt,
      auditDir: paths.auditDir,
    })),
    ...(await localLeakSources(paths, extra)),
  ];
  for (const { where, text } of sources) {
    const found = leakedLabels(text, known);
    if (found.length > 0) problems.push(`${where} contains: ${found.join(", ")}`);
  }
  return problems;
}

/** The files of the project's folder a restore must bring back unchanged (nothing regenerated). */
const KEPT_FILES = ["generated_values.json", "deploy_key", "state_passphrase"];

/**
 * The recovery copy (quickstart "Live" 4, SC-1402): a row written into the app's database; the
 * project's folder and the whole checkout deleted, as on a new computer; a fresh clone,
 * `opscrew secrets restore --key-file` (from the repository's copy, or the folder copy when the
 * repository is public and the copy was not committed); then `provision --plan-only` with nothing
 * to apply, `provision`, the same generated values, deploy key and state passphrase, and the row
 * still there, within 5 minutes. Returns findings (the time over target, a deploy branch opened).
 */
async function recoveryChecks(
  run: DeployedRun,
  plan: DeployPlan,
  ipv4: string,
  files: { keyFile: string; copies: string; log: (message: string) => void },
): Promise<string[]> {
  const { log } = files;
  const findings: string[] = [];
  const paths = resolveProjectPaths(run.repo, { env: run.env });
  const marker = `opscrew-e2e-${randomBytes(6).toString("hex")}`;
  const psql = (sql: string) =>
    `cd ${appDir(plan)} && docker compose exec -T db psql -U app -d app -tAc "${sql}"`;
  await run.ssh(ipv4, psql("create table if not exists opscrew_e2e (v text)"));
  await run.ssh(ipv4, psql(`insert into opscrew_e2e values ('${marker}')`));
  const kept = new Map<string, string>();
  for (const name of KEPT_FILES) {
    const file = join(paths.projectHomeDir, name);
    expect(existsSync(file), `OpsCrew kept ${name}`).toBe(true);
    kept.set(name, await readFile(file, "utf8"));
  }
  const folderCopy = join(files.copies, `${plan.app.name}.sops.json`);

  log("deleting the project's folder and the checkout, as on a new computer");
  const started = Date.now();
  await rm(paths.projectHomeDir, { recursive: true, force: true });
  await rm(run.repo, { recursive: true, force: true });
  const repository = run.github.name;
  const basic = Buffer.from(`x-access-token:${run.env.GITHUB_TOKEN ?? ""}`).toString("base64");
  const header = `AUTHORIZATION: basic ${basic}`;
  const cloned = await runner.run(
    "git",
    [
      "-c",
      `http.https://github.com/.extraheader=${header}`,
      "clone",
      "-q",
      `https://github.com/${repository}.git`,
      run.repo,
    ],
    { env: run.env, timeoutMs: minutes(5) },
  );
  expect(cloned.exitCode, `git clone: ${cloned.stderr.slice(-500)}`).toBe(0);
  await run.git("config", "user.name", "OpsCrew E2E");
  await run.git("config", "user.email", "e2e@example.invalid");
  await run.git("config", "commit.gpgsign", "false");
  await run.git("config", "http.https://github.com/.extraheader", header);
  const committed = existsSync(join(run.repo, "opscrew/secrets.sops.json"));
  log(
    committed
      ? "the fresh clone holds the recovery copy; restoring from it"
      : "the repository has no committed copy (a public repository in a script); restoring from the folder copy",
  );
  if (!committed) expect(existsSync(folderCopy), "the folder copy was written").toBe(true);
  const restore = await run.opscrew(
    "secrets",
    "restore",
    "--key-file",
    files.keyFile,
    ...(committed ? [] : ["--from", folderCopy]),
  );
  expect(restore.exitCode, `opscrew secrets restore:\n${restore.output}`).toBe(0);
  const planned = await run.opscrew("provision", "--plan-only", "--yes");
  expect(planned.exitCode, planned.output).toBe(0);
  expect(approveHashes(planned.output), `nothing to approve:\n${planned.output}`).toEqual([]);
  expect(/Nothing to apply/.test(planned.output), `nothing to apply:\n${planned.output}`).toBe(
    true,
  );
  const provisioned = await run.opscrew("provision", "--yes");
  expect(provisioned.exitCode, provisioned.output).toBe(0);
  const took = Date.now() - started;
  log(`from the fresh clone to the finished provision: ${Math.round(took / 1000)} s`);
  if (took > RESTORE_TARGET_MS) {
    findings.push(`the restore and provision took ${Math.round(took / 1000)} s, over 5 minutes`);
  }
  const head = await run.git("rev-parse", "--abbrev-ref", "HEAD");
  if (head !== "main") findings.push(`provision after the restore left ${head} checked out`);
  for (const [name, content] of kept) {
    const file = join(paths.projectHomeDir, name);
    const now = existsSync(file) ? await readFile(file, "utf8") : undefined;
    // Compared without printing either side (they are secrets); JSON by its values.
    const same = name.endsWith(".json")
      ? now !== undefined && isDeepStrictEqual(JSON.parse(now), JSON.parse(content))
      : now?.trim() === content.trim();
    expect(same, `${name} is restored as it was (nothing regenerated)`).toBe(true);
  }
  expect(
    await run.ssh(ipv4, psql("select v from opscrew_e2e")),
    "the row is still there",
  ).toContain(marker);
  log("restored on a fresh clone: nothing to apply, nothing regenerated, the data intact");
  return findings;
}
