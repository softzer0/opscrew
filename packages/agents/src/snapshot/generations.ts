/**
 * Restores after a rotation (025 plan.md 12., FR-2512, US1 scenario 5). Only volume copies of the
 * kinds snapshotted by stopping them hold a service's logins (the databases' dumps cover only the
 * `app` database, the caches' copies are RDB and AOF files), so only theirs record a generation in
 * `about.json` (from the server's or this computer's `.snapshots/generations`), and this computer
 * keeps each earlier generation's values (`history` in the generated values, 0600, and the recovery
 * copy) while such a copy or a whole-server snapshot needs them. Once a restore puts back a volume
 * copy of a service rotated since, OpsCrew runs the service's rotation recipe with the values of
 * then as the login and the current ones as the new (MySQL's and MariaDB's root first, as their app
 * password's commands log in as root), then waits for its health check. The values reach the server
 * only on SSH's stdin and the container only as `OPSCREW_OLD` and `OPSCREW_NEW`; nothing it prints,
 * audits or asks holds one.
 */
import { isDeepStrictEqual } from "node:util";
import { listText, OpsCrewError } from "@opscrew/core";
import {
  inContainer,
  ROTATE_DIR,
  ROTATE_LOG,
  type RotationStep,
  serviceSpec,
  shellQuote,
} from "@opscrew/iac-templates";
import { type DeployPlan, ONLINE_SNAPSHOT_KINDS, type PlanService } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { type ServiceStep, serviceSteps } from "../rotate/plan";
import { assertValuesCurrent, readCredentialsRecord } from "../rotate/record";
import { HistorySchema, serviceValues } from "../rotate/values";
import { readStrict } from "../rotate/values-pending";
import { changeGenerated, generatedValuesFile, registerAppSecrets } from "../shared/app-secrets";
import { readValidJson } from "../shared/files";
import type { Holder } from "./restore-checks";
import type { SnapshotRun } from "./run";
import type { About } from "./store";
import type { SnapshotEntry } from "./types";

/** The generated values with their earlier generations, every other value kept as it is. */
const KeptHistorySchema = z.looseObject({ history: HistorySchema.optional() });

type History = z.infer<typeof HistorySchema>;

/** One entry of `about.json`'s services. */
type AboutEntry = About["services"][number];

/**
 * True for a part of `kind` whose copy holds the service's logins: a volume copy of a kind
 * snapshotted by stopping it, not a database's dump, a cache's copy, the app's SQLite files nor its
 * kept folder.
 */
export function holdsLogins(kind: string): boolean {
  return (
    kind !== "sqlite" &&
    kind !== "files" &&
    !ONLINE_SNAPSHOT_KINDS.some((online) => online === kind)
  );
}

/**
 * The generation a copied part's logins were taken under: the one `about.json` records, else 1
 * (its first values, as the record counts them); `undefined` for a part left out or one whose copy
 * holds no login ({@link holdsLogins}).
 */
function copiedGeneration(entry: AboutEntry): number | undefined {
  if (!("file" in entry) || !holdsLogins(entry.kind)) return undefined;
  return entry.generation ?? 1;
}

/** The generation the rotation record gives each credential of the environment, by its name. */
async function currentGenerations(deps: Pick<PhaseDeps, "paths">) {
  const entries = (await readCredentialsRecord(deps)).environments[deps.paths.environment] ?? {};
  return (name: string) => entries[name]?.generation ?? 1;
}

/**
 * Why the copy of `service` in the snapshot `id` can't be restored when it records a later
 * generation (`from`) than the record (`to`): the record here is behind another computer's
 * rotation, so OpsCrew can't tell the values its data logs in with. `undefined` when it is not.
 */
function aheadReason(service: string, id: string, from: number, to: number): string | undefined {
  if (from <= to) return undefined;
  return `The snapshot ${id} holds ${service} at a later generation of its values (${from}) than this computer's rotation record (${to}): another computer rotated it since, so OpsCrew can't tell which values its data logs in with.`;
}

/** What to do about a copy {@link aheadReason} names. */
function aheadHint(flags: string): string {
  return `Pull the repository's opscrew/ folder (its credentials.yaml) and bring OpsCrew's generated values from your recovery copy (\`opscrew secrets restore${flags}\`), then run the command again.`;
}

/**
 * Stops when the copy of `service` records a later generation than the record ({@link aheadReason}).
 * @throws OpsCrewError `PHASE_PRECONDITION`.
 */
function requireNotAhead(service: string, id: string, from: number, to: number, flags: string) {
  const reason = aheadReason(service, id, from, to);
  if (reason === undefined) return;
  throw new OpsCrewError("PHASE_PRECONDITION", `${reason} ${NOTHING_CHANGED}`, {
    hint: aheadHint(flags),
  });
}

/**
 * The earlier generations this computer keeps, each value registered with the redactor (none
 * without the generated values); not `strict`, `undefined` when they are missing or damaged.
 * @throws OpsCrewError `ARTIFACT_INVALID` when they are damaged and `strict`.
 */
async function keptHistory(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  strict: boolean,
): Promise<History | undefined> {
  const file = generatedValuesFile(deps);
  const read = strict
    ? ((await readStrict(file, KeptHistorySchema)) ?? {})
    : await readValidJson(file, KeptHistorySchema);
  if (read === undefined) return undefined;
  const history = read.history ?? {};
  for (const generations of Object.values(history)) {
    for (const secrets of Object.values(generations)) {
      for (const value of Object.values(secrets)) deps.redactor.addLiteral(value, "app-env");
    }
  }
  return history;
}

/** A restored service rotated since its copy was taken, and how it gets its current values. */
export interface Relogin {
  /** The server it runs on: `app`, or an extra server's name. */
  server: string;
  /** Its name in the plan. */
  service: string;
  /** The generation its copy was taken under, and the one it has now. */
  from: number;
  to: number;
  /**
   * Its recipe's steps that run in its container (a `restart` step's value is read from the env
   * at the start the restore made), the root password's first, each with the value of then
   * (`old`) and the current one (`new`); empty for a step of several secrets (Garage's key).
   */
  steps: { step: ServiceStep; values: { old: string; new: string } }[];
  /**
   * How long its commands are tried again while the service boots ({@link bootSeconds}), in
   * seconds.
   */
  seconds: number;
}

/** A margin past what the health check allows, for a slow disk or a busy server. */
const BOOT_MARGIN_SECONDS = 30;

/**
 * How long `service` may take to accept a login after it started: its health check's start period
 * and its checks' 6 tries 10 seconds apart (how the stack renders every catalog check), and a
 * margin.
 */
function bootSeconds(plan: DeployPlan, service: PlanService): number {
  const check = serviceSpec(service.kind).healthcheck({ plan, service, secretRef: () => "" });
  return (check.startSeconds ?? 0) + 6 * 10 + BOOT_MARGIN_SECONDS;
}

/**
 * The services `holders` put back whose volume copy holds logins taken under an earlier generation
 * than the record's, each with its steps and values ({@link Relogin}); none for dumps and caches'
 * copies, which hold no login.
 * @throws OpsCrewError `PHASE_PRECONDITION` when a copy is of a later generation than the record,
 * this computer's values are older than the record's (another computer rotated), or it no longer
 * keeps the values a copy was taken with; `ARTIFACT_INVALID` when the generated values are damaged.
 */
export async function restoreRelogins(
  run: SnapshotRun,
  id: string,
  holders: readonly Holder[],
): Promise<Relogin[]> {
  const { deps, plan, flags } = run;
  const generation = await currentGenerations(deps);
  const stale: Omit<Relogin, "steps" | "seconds">[] = [];
  for (const holder of holders) {
    for (const part of holder.parts) {
      const entry = holder.about.services.find((each) => each.name === part.name);
      const from = entry === undefined ? undefined : copiedGeneration(entry);
      if (from === undefined) continue;
      const to = generation(part.name);
      requireNotAhead(part.name, id, from, to, flags);
      if (from < to) stale.push({ server: holder.server, service: part.name, from, to });
    }
  }
  if (stale.length === 0) return [];
  await assertValuesCurrent(deps);
  await registerAppSecrets(deps, plan);
  const history = (await keptHistory(deps, true)) as History;
  const current = await serviceValues(deps, plan, { names: [], services: {} }, "new");
  const relogins: Relogin[] = [];
  for (const { server, service: name, from, to } of stale) {
    const service = plan.services.find((each) => each.name === name);
    if (service === undefined) throw new Error(`The plan has no service ${name}.`);
    const then = history[name]?.[String(from)];
    // The root password's step first: the others log in as root (MySQL, MariaDB).
    const steps = serviceSteps(plan, [service])
      .filter((step) => step.rotation.mode !== "restart")
      .sort(
        (a, b) =>
          Number(b.rotation.secrets.includes("root-password")) -
          Number(a.rotation.secrets.includes("root-password")),
      )
      .map((step) => {
        const [secret, ...more] = step.rotation.secrets;
        if (secret === undefined || more.length > 0) return { step, values: { old: "", new: "" } };
        const old = then?.[secret];
        const now = current[name]?.[secret];
        if (old === undefined || now === undefined) {
          throw new OpsCrewError(
            "PHASE_PRECONDITION",
            `${name} was rotated after the snapshot ${id} was taken, and this computer no longer keeps the values it had then, which its restored data logs in with: the app could not reach it. ${NOTHING_CHANGED}`,
            {
              hint: `Bring OpsCrew's generated values from your recovery copy (\`opscrew secrets restore${flags}\`), which keeps them, or restore the other services one at a time with --only.`,
            },
          );
        }
        return { step, values: { old, new: now } };
      });
    if (steps.length > 0) {
      relogins.push({
        server,
        service: name,
        from,
        to,
        steps,
        seconds: bootSeconds(plan, service),
      });
    }
  }
  return relogins;
}

/** The approval's line on `relogins`; none without one. */
export function reloginLines(relogins: readonly Relogin[]): string[] {
  if (relogins.length === 0) return [];
  const names = [...new Set(relogins.map((relogin) => relogin.service))];
  const one = names.length === 1;
  return [
    `${listText(names)} ${one ? "was" : "were"} rotated after the snapshot was taken: once ${one ? "it is" : "they are"} back, OpsCrew sets ${one ? "its" : "their"} current passwords again, logging in with those of then, which this computer keeps.`,
  ];
}

/**
 * The command and stdin that give the restored services of `relogins` (on one machine) their
 * current values (POSIX sh, in the app's folder as the deploy user), once the restore started them
 * without waiting for their health checks, which may log in: the values read from stdin, two lines
 * per step, as `rotate.sh` reads them; then per service its container found, each step's `begin`,
 * the service created again where its recipe needs it (Garage's key), each step's `finish`, and the
 * wait for its health check; each command as `rotate.sh` runs it ({@link inContainer}, its output
 * in {@link ROTATE_LOG}), tried again every 2 seconds while the service boots, for at most its
 * {@link Relogin.seconds} (the recipes are guarded, so a try again changes nothing done). A failure
 * names the service and stops.
 */
export function reloginCommand(relogins: readonly Relogin[]): { command: string; input: string } {
  const steps = relogins.flatMap((relogin) => relogin.steps);
  const container = (service: string) => [
    `s=${shellQuote(service)}`,
    'rot_c="$(docker compose ps -q "$s" | head -n 1)"',
    '[ -n "$rot_c" ] || failed',
  ];
  const run = (command: RotationStep, n: number) =>
    `retry ${shellQuote(inContainer(command, n, false))} || late`;
  let count = 0;
  const lines = [
    "umask 077",
    `failed() { printf ${shellQuote(`OpsCrew could not give %s its current passwords again; its commands' output is in ${ROTATE_LOG} in the app's folder there.\\n`)} "$s" >&2; exit 1; }`,
    `late() { printf ${shellQuote(`OpsCrew could not give %s its current passwords again within %s seconds of its start; its commands' output is in ${ROTATE_LOG} in the app's folder there.\\n`)} "$s" "$t" >&2; exit 1; }`,
    // A command again every 2 seconds until it passes, while the service may still boot (`$t`).
    'retry() { _until=$(( $(date +%s) + t )); until eval "$1"; do [ "$(date +%s)" -lt "$_until" ] || return 1; sleep 2; done; }',
    `mkdir -p ${ROTATE_DIR} || exit 1`,
    ...steps.flatMap((_, i) => [
      `IFS= read -r rot_old_${i + 1} || exit 1`,
      `IFS= read -r rot_new_${i + 1} || exit 1`,
    ]),
    ...relogins.flatMap((relogin) => {
      const numbered = relogin.steps.map((step) => ({ ...step, n: ++count }));
      const recreate = numbered.some(({ step }) => step.rotation.recreate);
      return [
        `t=${relogin.seconds}`,
        ...container(relogin.service),
        ...numbered.flatMap(({ step, n }) => step.step.begin.map((cmd) => run(cmd, n))),
        ...(recreate
          ? [
              `docker compose up -d --no-deps --force-recreate "$s" >> ${ROTATE_LOG} 2>&1 || failed`,
              ...container(relogin.service),
            ]
          : []),
        ...numbered.flatMap(({ step, n }) => step.step.finish.map((cmd) => run(cmd, n))),
        `docker compose up -d --no-deps --wait "$s" >> ${ROTATE_LOG} 2>&1 || failed`,
      ];
    }),
  ];
  const input = steps.flatMap(({ values }) => [values.old, values.new]);
  return { command: lines.join("\n"), input: `${input.join("\n")}\n` };
}

/**
 * For a rollback's snapshot (`abouts`): the services whose volume copy holds logins
 * ({@link holdsLogins}) taken under an earlier generation than the record's, by name (its run
 * restores them on the server, which has only the current values), and, when a copy is of a later
 * generation than the record, why the snapshot can't be restored at all, with what to do
 * (`flags` are the commands').
 */
export async function rotatedLogins(
  deps: Pick<PhaseDeps, "paths">,
  abouts: Iterable<About>,
  flags: string,
): Promise<{ rotated: string[]; ahead?: string }> {
  const generation = await currentGenerations(deps);
  const names = new Set<string>();
  for (const about of abouts) {
    for (const entry of about.services) {
      const from = copiedGeneration(entry);
      if (from === undefined) continue;
      const ahead = aheadReason(entry.name, about.id, from, generation(entry.name));
      if (ahead !== undefined) return { rotated: [], ahead: `${ahead} ${aheadHint(flags)}` };
      if (from < generation(entry.name)) names.add(entry.name);
    }
  }
  return { rotated: [...names] };
}

/**
 * Forgets on this computer each earlier generation of a service's values that none of `entries`
 * (every snapshot of the environment) needs: a volume copy taken under it ({@link holdsLogins}), or
 * a whole-server snapshot taken before the service's last rotation, which keeps all of its earlier
 * ones (T2520 restores from them). The recovery copy follows at its next refresh. Writes nothing
 * when each one is still needed, nor without readable generated values.
 * @throws OpsCrewError `ARTIFACT_INVALID` when the generated values are damaged, ArtifactError
 * when the rotation record is.
 */
export async function forgetUnneededGenerations(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  entries: readonly SnapshotEntry[],
): Promise<void> {
  const history = await keptHistory(deps, false);
  if (history === undefined) return;
  const record = (await readCredentialsRecord(deps)).environments[deps.paths.environment] ?? {};
  const needed = new Set(
    entries.flatMap((entry) =>
      entry.services
        .filter((service) => service.state === "copied" && holdsLogins(service.kind))
        .map((service) => `${service.name} ${service.generation ?? 1}`),
    ),
  );
  const servers = entries.filter((entry) => entry.kind === "server");
  /** True when a whole-server snapshot holds `name`'s data from before its last rotation. */
  const wholeServer = (name: string) => {
    const rotated = record[name]?.rotatedAt;
    return servers.some(
      (entry) => rotated === undefined || Date.parse(entry.taken) < Date.parse(rotated),
    );
  };
  const kept: History = {};
  for (const [name, generations] of Object.entries(history)) {
    const left = wholeServer(name)
      ? Object.entries(generations)
      : Object.entries(generations).filter(([n]) => needed.has(`${name} ${n}`));
    if (left.length > 0) kept[name] = Object.fromEntries(left);
  }
  if (isDeepStrictEqual(kept, history)) return;
  await changeGenerated(deps, ({ history: _, ...values }) =>
    Object.keys(kept).length === 0 ? values : { ...values, history: kept },
  );
}
