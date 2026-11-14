/**
 * The automated backups a provider's Terraform cannot turn on, which its connector turns on instead
 * (`terraform.connectorBackups`: Contabo's Auto Backup, 027 research R15), as its firewalls are
 * applied (./firewalls): each server module of such a provider describes them in a
 * `terraform_data.backup` (`{ server_id, on }`), so the plan and its approval cover them, and the
 * root module lists them in its `wanted_backups` output, by module, with the provider.
 *
 * OpsCrew orders them only for a server whose `terraform_data.backup` an approved plan created or
 * updated to on: right after that apply it records them as `wanted` for the server
 * ({@link markWantedBackups}), then orders them ({@link syncProviderBackups}); an order that didn't
 * go through stays `wanted` and is sent again by a later run, under the approval that put `on`
 * into the state. A server with `on` in the state and no record is never ordered. No API call
 * turns them off: when the plan turns off backups OpsCrew ordered, it says how to cancel them in
 * the provider's panel and changes nothing.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  PhaseName,
  ProviderBackupsApi,
  VpsProviderId,
  WantedBackupOutput,
} from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths } from "@opscrew/core";
import { type CloudProvider, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { vpsConnector } from "../providers";
import { credentialsMissing, reasonOf, unreadableOutputs } from "./errors";
import { readRecord, writeRecord } from "./records";

/** Each provider's automated backups, where tests pass fakes (default: its connector's). */
export type ProviderBackupsApis = Partial<Record<CloudProvider, ProviderBackupsApi>>;

/** The backups a root wants for one server: its module, provider, server id and whether on. */
export interface ModuleBackup {
  module: string;
  provider: CloudProvider;
  serverId: string;
  on: boolean;
}

/** What the backups steps after an apply need of the run. */
export interface ProviderBackupsRun {
  deps: Pick<
    PhaseDeps,
    "env" | "fetch" | "redactor" | "version" | "reporter" | "audit" | "paths" | "clock"
  >;
  /** Phase recorded in the audit entries. */
  phase: PhaseName;
  /** The command that runs the step again, e.g. `opscrew provision`. */
  command: string;
  backups?: ProviderBackupsApis | undefined;
}

/** A provider whose connector turns its backups on. */
const ProviderSchema = z
  .string()
  .refine((id) => isCloudProvider(id) && cloudProvider(id).terraform.connectorBackups === true, {
    message: "not a provider whose connector turns its backups on",
  })
  .transform((id) => id as CloudProvider);

/** The root's `wanted_backups` output after an apply (iac-templates renders it). */
const WantedBackupsSchema = z.record(
  z.string(),
  z.object({
    provider: ProviderSchema,
    // The id names the record's file, so only letters, digits and dashes.
    backup: z.object({
      server_id: z.string().regex(/^[A-Za-z0-9-]+$/),
      on: z.boolean(),
    }) satisfies z.ZodType<WantedBackupOutput>,
  }),
);

/** The backups a root's outputs want (`wanted_backups`); none without that output. */
export function wantedBackups(outputs: Readonly<Record<string, unknown>>): ModuleBackup[] {
  if (outputs.wanted_backups === undefined || outputs.wanted_backups === null) return [];
  const parsed = WantedBackupsSchema.safeParse(outputs.wanted_backups);
  if (!parsed.success) {
    throw unreadableOutputs("the automated backups the servers want", parsed.error);
  }
  return Object.entries(parsed.data).map(([module, { provider, backup }]) => ({
    module,
    provider,
    serverId: backup.server_id,
    on: backup.on,
  }));
}

/**
 * OpsCrew's record of one server's automated backups, all it knows of them, since the provider
 * can't be asked whether they are on (Contabo's API doesn't say which of an instance's add-ons is
 * Auto Backup, R15): `wanted` once an approved plan turned them on, until the order goes through;
 * `sent` while the provider's answer to the order is unknown (they may be on); `on` once the
 * provider took it. It is kept on this computer only: a run on another computer has no record, and
 * never orders them.
 */
const BackupsRecordSchema = z.object({
  provider: z.string(),
  serverId: z.string(),
  state: z.enum(["wanted", "sent", "on"]),
  at: z.string(),
});
export type ProviderBackupsRecord = z.infer<typeof BackupsRecordSchema>;

/** Where the record of `serverId`'s backups at `provider` is kept, one file per server. */
export function providerBackupsFile(
  paths: Pick<ProjectPaths, "projectHomeDir">,
  provider: VpsProviderId,
  serverId: string,
): string {
  return join(paths.projectHomeDir, `provider-backups-${provider}-${serverId}.json`);
}

/** The record of a server's backups, or undefined; a damaged one stops. */
export function readProviderBackups(
  deps: Pick<PhaseDeps, "paths">,
  server: { provider: VpsProviderId; serverId: string },
): Promise<ProviderBackupsRecord | undefined> {
  const file = providerBackupsFile(deps.paths, server.provider, server.serverId);
  return readRecord(
    file,
    BackupsRecordSchema,
    () =>
      new OpsCrewError(
        "ARTIFACT_INVALID",
        `OpsCrew's record of the automated backups of server ${server.serverId} (${file}) is damaged, so OpsCrew stopped. Nothing was changed.`,
        {
          hint: `Check the server in ${cloudProvider(server.provider).texts.destroy.console}. If its automated backups are on there, write {"provider":"${server.provider}","serverId":"${server.serverId}","state":"on","at":"<today>"} into that file; if they are off, delete it. Then run the command again.`,
        },
      ),
  );
}

function recordBackups(
  deps: ProviderBackupsRun["deps"],
  wanted: ModuleBackup,
  state: ProviderBackupsRecord["state"],
): Promise<void> {
  const record: ProviderBackupsRecord = {
    provider: wanted.provider,
    serverId: wanted.serverId,
    state,
    at: deps.clock.now().toISOString(),
  };
  return writeRecord(providerBackupsFile(deps.paths, wanted.provider, wanted.serverId), record);
}

/** The plan JSON's changes, as far as {@link markWantedBackups} reads them. */
const PlannedBackupsSchema = z.looseObject({
  resource_changes: z
    .array(
      z.looseObject({
        address: z.string(),
        change: z.looseObject({ actions: z.array(z.string()), after: z.unknown() }),
      }),
    )
    .optional(),
});

/** A `terraform_data.backup`'s values after a change that has them on. */
const OnSchema = z.looseObject({ input: z.looseObject({ on: z.literal(true) }) });

/** The modules whose `terraform_data.backup` `planJson` creates or updates with `on`. */
function modulesTurnedOn(planJson: unknown): Set<string> {
  const parsed = PlannedBackupsSchema.safeParse(planJson);
  const modules = new Set<string>();
  for (const { address, change } of parsed.success ? (parsed.data.resource_changes ?? []) : []) {
    const module = /^module\.([^.[]+)\.terraform_data\.backup$/.exec(address)?.[1];
    const changed = change.actions.includes("create") || change.actions.includes("update");
    if (module !== undefined && changed && OnSchema.safeParse(change.after).success) {
      modules.add(module);
    }
  }
  return modules;
}

/**
 * Right after the apply of the approved `planJson`, before anything that can fail: records as
 * `wanted` the backups of each server whose `terraform_data.backup` the plan created or updated to
 * on (its id from `outputs`), unless a record of them is there. Returns those servers' ids.
 */
export async function markWantedBackups(
  run: Pick<ProviderBackupsRun, "deps">,
  planJson: unknown,
  outputs: Readonly<Record<string, unknown>>,
): Promise<string[]> {
  const modules = modulesTurnedOn(planJson);
  if (modules.size === 0) return [];
  const marked: string[] = [];
  for (const wanted of wantedBackups(outputs)) {
    if (!wanted.on || !modules.has(wanted.module)) continue;
    if ((await readProviderBackups(run.deps, wanted)) === undefined) {
      await recordBackups(run.deps, wanted, "wanted");
    }
    marked.push(wanted.serverId);
  }
  return marked;
}

/**
 * The automated backups of `provider`: the run's, else its connector's.
 * @throws OpsCrewError `CREDENTIALS_MISSING` when its credentials are not set.
 */
function backupsApi(run: ProviderBackupsRun, provider: CloudProvider): ProviderBackupsApi {
  const api = run.backups?.[provider] ?? vpsConnector(provider, run.deps).backups;
  if (api !== undefined) return api;
  throw credentialsMissing(provider);
}

/** `Contabo's automated backups of server 202611001`. */
function label({ provider, serverId }: ModuleBackup): string {
  return `${cloudProvider(provider).name}'s automated backups of server ${serverId}`;
}

/** Where the user checks a server's backups: `the Contabo Customer Control Panel`. */
function panel(wanted: ModuleBackup): string {
  return cloudProvider(wanted.provider).texts.destroy.console;
}

/** What to do about an order whose outcome is unknown: check the panel, then fix the record. */
function checkSent(run: ProviderBackupsRun, wanted: ModuleBackup): string {
  const file = providerBackupsFile(run.deps.paths, wanted.provider, wanted.serverId);
  return `Check the server in ${panel(wanted)}. If its automated backups are on there, change "sent" to "on" in ${file}; if they are off, delete that file. Then run \`${run.command}\` again.`;
}

/**
 * Orders the backups `wanted` names when the record says so (`wanted`): `sent` is recorded first,
 * so an order without a clear answer is never sent again, `on` after the provider took it; a
 * refusal leaves them `wanted`, for the next run to send again. Never without a record.
 */
async function turnOn(
  run: ProviderBackupsRun,
  wanted: ModuleBackup,
  record: ProviderBackupsRecord | undefined,
  fresh: boolean,
): Promise<void> {
  const { deps } = run;
  const what = label(wanted);
  if (record === undefined) {
    deps.reporter.warn(
      `OpsCrew has no record of turning on ${what} on this computer, so it doesn't order them: check the server in ${panel(wanted)}.`,
    );
    return;
  }
  if (record.state === "on") {
    deps.reporter.info(
      `${what} are on since ${record.at.slice(0, 10)}, when OpsCrew turned them on.`,
    );
    return;
  }
  if (record.state === "sent") {
    deps.reporter.warn(
      deps.redactor.redact(
        `OpsCrew's order of ${what} got no clear answer, so it isn't sent again. ${checkSent(run, wanted)}`,
      ),
    );
    return;
  }
  const api = backupsApi(run, wanted.provider);
  const { name, offering } = cloudProvider(wanted.provider);
  const target = `${wanted.provider} server ${wanted.serverId}`;
  deps.reporter.step(
    fresh
      ? `Turning on ${what}`
      : `Turning on ${what}: an earlier run's order didn't go through, so OpsCrew sends it again`,
  );
  await recordBackups(deps, wanted, "sent");
  let answer: { refused: string } | undefined;
  try {
    answer = await api.turnOn(wanted.serverId);
  } catch (error) {
    const reason = reasonOf(error);
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "backups unclear",
      phase: run.phase,
      target,
      detail: deps.redactor.redact(reason),
    });
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      deps.redactor.redact(
        `Turning on ${what} got no clear answer (${reason}), so they may be on. OpsCrew won't ask again.`,
      ),
      { hint: deps.redactor.redact(checkSent(run, wanted)), cause: error },
    );
  }
  if (answer !== undefined) {
    await recordBackups(deps, wanted, "wanted");
    const refused = deps.redactor.redact(answer.refused);
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "backups refused",
      phase: run.phase,
      target,
      detail: refused,
    });
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${name} refused to turn on its automated backups of server ${wanted.serverId}, so nothing was turned on: ${refused}`,
      {
        hint: `Fix what ${name} named, then run \`${run.command}\` again: it sends the order again.`,
      },
    );
  }
  await recordBackups(deps, wanted, "on");
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "turn on backups",
    phase: run.phase,
    target,
    detail: "the approved plan has them on",
  });
  const price =
    offering.backupsPrice === "order-page"
      ? `: they cost extra, priced on ${name}'s order page`
      : "";
  deps.reporter.success(`Turned on ${what}${price}.`);
}

/**
 * Backups the plan now has off: when OpsCrew ordered them (`on`, or `sent`: they may be on), says
 * how to cancel them in the provider's panel and changes nothing at the provider; one never
 * ordered (`wanted`) is only forgotten. The record goes, so this is said once and a plan that
 * turns them on again orders them again.
 */
async function leftOn(
  run: ProviderBackupsRun,
  wanted: ModuleBackup,
  record: ProviderBackupsRecord,
): Promise<void> {
  const { deps } = run;
  const { name } = cloudProvider(wanted.provider);
  const what = label(wanted);
  if (record.state !== "wanted") {
    deps.reporter.warn(
      record.state === "on"
        ? `The plan turns ${what} off, but ${name}'s API can't turn them off, so OpsCrew changed nothing. Cancel them in ${panel(wanted)}: they stay on, and billed, until you do.`
        : `The plan turns ${what} off. OpsCrew's order of them got no clear answer, so they may be on: check the server in ${panel(wanted)} and cancel them there if they are. ${name}'s API can't turn them off, so OpsCrew changed nothing.`,
    );
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "backups left on",
      phase: run.phase,
      target: `${wanted.provider} server ${wanted.serverId}`,
      detail: `the plan has them off; only ${panel(wanted)} turns them off`,
    });
  }
  await rm(providerBackupsFile(deps.paths, wanted.provider, wanted.serverId), { force: true });
}

/**
 * After an apply, and in a run that plans nothing new: orders each server's automated backups the
 * outputs want on and the record has `wanted` (`fresh`: the servers this run's plan turned on,
 * {@link markWantedBackups}; any other is an earlier run's order sent again), says what it knows of
 * the others, and how to cancel in the panel the ones OpsCrew ordered that the plan now has off.
 * @throws OpsCrewError `PROVIDER_ERROR` at the first order the provider refused or left unclear.
 */
export async function syncProviderBackups(
  run: ProviderBackupsRun,
  outputs: Readonly<Record<string, unknown>>,
  fresh: readonly string[] = [],
): Promise<void> {
  for (const wanted of wantedBackups(outputs)) {
    const record = await readProviderBackups(run.deps, wanted);
    if (wanted.on) await turnOn(run, wanted, record, fresh.includes(wanted.serverId));
    else if (record !== undefined) await leftOn(run, wanted, record);
  }
}
