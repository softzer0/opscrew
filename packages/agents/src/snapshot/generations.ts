/**
 * Restores after a rotation (025 plan.md 12., FR-2512, US1 scenario 5). Only volume copies of the
 * kinds snapshotted by stopping them hold a service's logins (the databases' dumps cover only the
 * `app` database, the caches' copies are RDB and AOF files), so only theirs record a generation in
 * `about.json` (from the server's or this computer's `.snapshots/generations`), and this computer
 * keeps each earlier generation's values (`history` in the generated values, 0600, and the recovery
 * copy) while such a copy or a whole-server snapshot needs them. Once a restore puts back a volume
 * copy of a service rotated since, OpsCrew runs the service's rotation recipe with the values of
 * then as the login and the current ones as the new (MySQL's and MariaDB's root first, as their app
 * password's commands log in as root), then waits for its health check; Garage's key instead loses
 * its restored key of then by its ID. The values reach the server only on SSH's stdin and the
 * container only as `OPSCREW_OLD` and `OPSCREW_NEW` (Garage's key IDs, no secret, as `garage`'s
 * arguments); nothing it prints, audits or asks holds one.
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
function holdsLogins(kind: string): boolean {
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

/** The rotation record's entries of the environment, by credential name. */
async function recordEntries(deps: Pick<PhaseDeps, "paths">) {
  return (await readCredentialsRecord(deps)).environments[deps.paths.environment] ?? {};
}

/**
 * Of `copies`, those whose logins were taken under an earlier generation (`from`) than the
 * record's (`to`); or, at the first one of a later generation, why ({@link aheadReason}).
 */
async function staleCopies<C extends { id: string; entry: AboutEntry }>(
  deps: Pick<PhaseDeps, "paths">,
  copies: readonly C[],
): Promise<{ stale: (C & Pick<Relogin, "from" | "to">)[] } | { ahead: string }> {
  const entries = await recordEntries(deps);
  const stale: (C & Pick<Relogin, "from" | "to">)[] = [];
  for (const copy of copies) {
    const from = copiedGeneration(copy.entry);
    if (from === undefined) continue;
    const to = entries[copy.entry.name]?.generation ?? 1;
    const ahead = aheadReason(copy.entry.name, copy.id, from, to);
    if (ahead !== undefined) return { ahead };
    if (from < to) stale.push({ ...copy, from, to });
  }
  return { stale };
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
 * Stops when the copy of `service` records a later generation than the record ({@link aheadReason}),
 * the message ending with `after` (what is true then; nothing changed by default).
 * @throws OpsCrewError `PHASE_PRECONDITION`.
 */
export function requireNotAhead(
  service: string,
  id: string,
  from: number,
  to: number,
  flags: string,
  after = NOTHING_CHANGED,
) {
  const reason = aheadReason(service, id, from, to);
  if (reason === undefined) return;
  throw new OpsCrewError("PHASE_PRECONDITION", `${reason} ${after}`, {
    hint: aheadHint(flags),
  });
}

/**
 * The earlier generations this computer keeps, each value registered with the redactor (none
 * without the generated values); not `strict`, `undefined` when they are missing or damaged.
 * @throws OpsCrewError `ARTIFACT_INVALID` when they are damaged and `strict`.
 */
export async function keptHistory(
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
   * (`old`) and the current one (`new`); for Garage's key, its key IDs ({@link isGarageKey}).
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
export function bootSeconds(plan: DeployPlan, service: PlanService): number {
  const check = serviceSpec(service.kind).healthcheck({ plan, service, secretRef: () => "" });
  return (check.startSeconds ?? 0) + 6 * 10 + BOOT_MARGIN_SECONDS;
}

/**
 * `steps` with the root password's first, each service's others in their order: the others log in
 * as root (MySQL, MariaDB), with the root password of the restored data.
 */
export function rootFirst(steps: readonly ServiceStep[]): ServiceStep[] {
  return [...steps].sort(
    (a, b) =>
      Number(b.rotation.secrets.includes("root-password")) -
      Number(a.rotation.secrets.includes("root-password")),
  );
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
  const found = await staleCopies(
    deps,
    holders.flatMap(({ server, about, parts }) =>
      parts.flatMap((part) =>
        about.services
          .filter((entry) => entry.name === part.name)
          .map((entry) => ({ id, entry, server })),
      ),
    ),
  );
  if ("ahead" in found) {
    throw new OpsCrewError("PHASE_PRECONDITION", `${found.ahead} ${NOTHING_CHANGED}`, {
      hint: aheadHint(flags),
    });
  }
  const { stale } = found;
  if (stale.length === 0) return [];
  await assertValuesCurrent(deps);
  await registerAppSecrets(deps, plan);
  const history = (await keptHistory(deps, true)) as History;
  const current = await serviceValues(deps, plan, { names: [], services: {} }, "new");
  const relogins: Relogin[] = [];
  for (const { server, entry, from, to } of stale) {
    const { name } = entry;
    const service = plan.services.find((each) => each.name === name);
    if (service === undefined) throw new Error(`The plan has no service ${name}.`);
    const then = history[name]?.[String(from)];
    const steps = rootFirst(serviceSteps(plan, [service]))
      .filter((step) => step.rotation.mode !== "restart")
      .map((step) => {
        // Garage's key: its key ID, which names it; its secret key never leaves this computer.
        const secret = isGarageKey(step) ? "key-id" : step.rotation.secrets[0];
        if (secret === undefined) throw new Error(`${name} has a rotation of no secret.`);
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

/** True for Garage's key, whose restore {@link garageRelogin} handles. */
function isGarageKey(step: ServiceStep): boolean {
  return step.service.kind === "garage" && step.rotation.secrets.includes("key-id");
}

/**
 * Garage's key once the restore started it from the current env: its restored data holds the key
 * of then under the name its start gives the env's key, which the start made beside it and allows
 * on the plan's bucket, so a rotation's `begin` (a rename by that name) matches no one key. Instead,
 * once Garage holds the env's key, the key of then is deleted by its ID, only while Garage holds it
 * and never when it is the env's: run again, it changes nothing. Step `n`'s values are the key IDs
 * (`$rot_old_<n>`, `$rot_new_<n>`), which name the keys and are no secret: the image has no shell,
 * so the host's shell puts them on `garage`'s command line; the secret keys never leave this
 * computer.
 */
function garageRelogin(n: number): string[] {
  const garage = (args: string) =>
    `docker exec "$rot_c" /garage key ${args} < /dev/null >> ${ROTATE_LOG} 2>&1`;
  return [
    garage(`info "$rot_new_${n}"`),
    `if [ "$rot_old_${n}" != "$rot_new_${n}" ] && ${garage(`info "$rot_old_${n}"`)}; then ${garage(`delete --yes "$rot_old_${n}"`)}; fi`,
  ].map((line) => `retry ${shellQuote(line)} || late`);
}

/**
 * The command and stdin that give the restored services of `relogins` (on one machine) their
 * current values (POSIX sh, in the app's folder as the deploy user), once the restore started them
 * from their current env files without waiting for their health checks, which may log in: the
 * values read from stdin, two lines per step, as `rotate.sh` reads them; then per service its
 * container found, each step's `begin` (Garage's key: {@link garageRelogin}), each step's `finish`,
 * and the wait for its health check; each command as `rotate.sh` runs it ({@link inContainer}, its
 * output in {@link ROTATE_LOG}), tried again every 2 seconds while the service boots, for at most
 * its {@link Relogin.seconds} (the recipes are guarded, so a try again changes nothing done). A
 * failure names the service and stops.
 */
export function reloginCommand(relogins: readonly Relogin[]): { command: string; input: string } {
  const steps = relogins.flatMap((relogin) => relogin.steps);
  const container = (service: string) => [
    `s=${shellQuote(service)}`,
    'rot_c="$(docker compose ps -q "$s" | head -n 1)"',
    '[ -n "$rot_c" ] || failed',
  ];
  const run = (commands: readonly RotationStep[], n: number) =>
    commands.map((command) => `retry ${shellQuote(inContainer(command, n, false))} || late`);
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
      return [
        `t=${relogin.seconds}`,
        ...container(relogin.service),
        ...numbered.flatMap(({ step, n }) =>
          isGarageKey(step) ? garageRelogin(n) : run(step.step.begin, n),
        ),
        ...numbered.flatMap(({ step, n }) => (isGarageKey(step) ? [] : run(step.step.finish, n))),
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
  const found = await staleCopies(
    deps,
    [...abouts].flatMap((about) => about.services.map((entry) => ({ id: about.id, entry }))),
  );
  if ("ahead" in found) return { rotated: [], ahead: `${found.ahead} ${aheadHint(flags)}` };
  return { rotated: [...new Set(found.stale.map(({ entry }) => entry.name))] };
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
  const record = await recordEntries(deps);
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
