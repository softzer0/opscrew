/**
 * The automated backups a provider's Terraform cannot turn on, which its connector turns on instead
 * (`terraform.connectorBackups`: Contabo's Auto Backup, 027 research R15), as its firewalls are
 * applied (./firewalls): each server module of such a provider describes them in a
 * `terraform_data.backup` (`{ server_id, on }`), so the plan and its approval cover them, and the
 * root module lists them in its `wanted_backups` output, by module, with the provider. After an
 * apply OpsCrew turns on the ones the state wants on, and records each, so a re-run never orders
 * them again. No API call turns them off: when the plan turns off backups OpsCrew turned on, it
 * says how to turn them off in the provider's panel and changes nothing.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  PhaseName,
  ProviderBackupsApi,
  VpsProviderId,
  WantedBackupOutput,
} from "@opscrew/contracts";
import {
  listText,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  writeFileAtomic,
  zodIssues,
} from "@opscrew/core";
import { type CloudProvider, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { vpsConnector } from "../providers";
import { reasonOf } from "./errors";

/** Each provider's automated backups, where tests pass fakes (default: its connector's). */
export type ProviderBackupsApis = Partial<Record<CloudProvider, ProviderBackupsApi>>;

/** The backups a root wants for one server: its module, provider, server id and whether on. */
export interface ModuleBackup {
  module: string;
  provider: CloudProvider;
  serverId: string;
  on: boolean;
}

/** What the backups step after an apply needs of the run. */
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
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `OpsCrew could not read the automated backups the servers want from the infrastructure's outputs (${zodIssues(parsed.error)}).`,
      {
        hint: "Undo manual edits under opscrew/infra (they are regenerated), then run the command again.",
      },
    );
  }
  return Object.entries(parsed.data).map(([module, { provider, backup }]) => ({
    module,
    provider,
    serverId: backup.server_id,
    on: backup.on,
  }));
}

/**
 * OpsCrew's record of the automated backups it turned on for one server: `sent` while the
 * provider's answer is unknown (they may be on), `on` once the provider took the order. The
 * provider can't be asked whether they are on (Contabo's API doesn't say which of an instance's
 * add-ons is Auto Backup, R15), so this record is all OpsCrew knows. It is kept on this computer
 * only: a run from another computer has no record and sends the order again, and whether that is
 * harmless at Contabo is unverified (R15).
 */
const BackupsRecordSchema = z.object({
  provider: z.string(),
  serverId: z.string(),
  state: z.enum(["sent", "on"]),
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
export async function readProviderBackups(
  deps: Pick<PhaseDeps, "paths">,
  server: { provider: VpsProviderId; serverId: string },
): Promise<ProviderBackupsRecord | undefined> {
  const file = providerBackupsFile(deps.paths, server.provider, server.serverId);
  const text = await readTextIfExists(file);
  if (text === undefined) return undefined;
  try {
    return BackupsRecordSchema.parse(JSON.parse(text));
  } catch {
    throw new OpsCrewError(
      "ARTIFACT_INVALID",
      `OpsCrew's record of the automated backups of server ${server.serverId} (${file}) is damaged, so OpsCrew stopped. Nothing was changed.`,
      {
        hint: `Check the server in ${cloudProvider(server.provider).texts.destroy.console}. If its automated backups are on there, write {"provider":"${server.provider}","serverId":"${server.serverId}","state":"on","at":"<today>"} into that file; if they are off, delete it. Then run the command again.`,
      },
    );
  }
}

async function writeRecord(
  deps: ProviderBackupsRun["deps"],
  wanted: ModuleBackup,
  state: ProviderBackupsRecord["state"],
): Promise<void> {
  const file = providerBackupsFile(deps.paths, wanted.provider, wanted.serverId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const record: ProviderBackupsRecord = {
    provider: wanted.provider,
    serverId: wanted.serverId,
    state,
    at: deps.clock.now().toISOString(),
  };
  await writeFileAtomic(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/**
 * The automated backups of `provider`: the run's, else its connector's.
 * @throws OpsCrewError `CREDENTIALS_MISSING` when its credentials are not set.
 */
function backupsApi(run: ProviderBackupsRun, provider: CloudProvider): ProviderBackupsApi {
  const api = run.backups?.[provider] ?? vpsConnector(provider, run.deps).backups;
  if (api !== undefined) return api;
  const { displayName, credentials } = cloudProvider(provider);
  throw new OpsCrewError(
    "CREDENTIALS_MISSING",
    `OpsCrew cannot reach ${displayName}: its credentials (${listText(credentials.envVars)}) are not set.`,
    { hint: "Set them, then run the command again." },
  );
}

/** `Contabo's automated backups of server 202611001`. */
function label({ provider, serverId }: ModuleBackup): string {
  return `${cloudProvider(provider).name}'s automated backups of server ${serverId}`;
}

/** What to do about an order whose outcome is unknown: check the panel, then fix the record. */
function checkSent(run: ProviderBackupsRun, wanted: ModuleBackup): string {
  const file = providerBackupsFile(run.deps.paths, wanted.provider, wanted.serverId);
  const panel = cloudProvider(wanted.provider).texts.destroy.console;
  return `Check the server in ${panel}. If its automated backups are on there, change "sent" to "on" in ${file}; if they are off, delete that file. Then run \`${run.command}\` again.`;
}

/**
 * Turns on the backups `wanted` names, unless the record says OpsCrew did: the record is written
 * before the order, so an order without a clear answer is never sent again, and removed when the
 * provider refused it (nothing was turned on).
 */
async function turnOn(
  run: ProviderBackupsRun,
  wanted: ModuleBackup,
  record: ProviderBackupsRecord | undefined,
): Promise<void> {
  const { deps } = run;
  const what = label(wanted);
  if (record?.state === "on") {
    deps.reporter.info(
      `${what} are on since ${record.at.slice(0, 10)}, when OpsCrew turned them on.`,
    );
    return;
  }
  if (record?.state === "sent") {
    deps.reporter.warn(
      deps.redactor.redact(
        `OpsCrew's request to turn on ${what} got no clear answer, so it isn't sent again. ${checkSent(run, wanted)}`,
      ),
    );
    return;
  }
  const api = backupsApi(run, wanted.provider);
  const { name, offering } = cloudProvider(wanted.provider);
  const target = `${wanted.provider} server ${wanted.serverId}`;
  deps.reporter.step(`Turning on ${what}`);
  await writeRecord(deps, wanted, "sent");
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
    await rm(providerBackupsFile(deps.paths, wanted.provider, wanted.serverId), { force: true });
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
      { hint: `Fix what ${name} named, then run \`${run.command}\` again.` },
    );
  }
  await writeRecord(deps, wanted, "on");
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
 * The backups OpsCrew turned on (or may have: `sent`) and the plan now has off: says how to turn
 * them off in the provider's panel, changes nothing at the provider, and drops the record, so it
 * is said once and a plan that turns them on again orders them again.
 */
async function leftOn(run: ProviderBackupsRun, wanted: ModuleBackup): Promise<void> {
  const { deps } = run;
  const { name, texts } = cloudProvider(wanted.provider);
  deps.reporter.warn(
    `The plan turns ${label(wanted)} off, but ${name}'s API can't turn them off, so OpsCrew changed nothing. Cancel them in ${texts.destroy.console}: they stay on, and billed, until you do.`,
  );
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "backups left on",
    phase: run.phase,
    target: `${wanted.provider} server ${wanted.serverId}`,
    detail: `the plan has them off; only ${texts.destroy.console} turns them off`,
  });
  await rm(providerBackupsFile(deps.paths, wanted.provider, wanted.serverId), { force: true });
}

/**
 * Turns on each server's automated backups the root's outputs want on, once (recorded), and says
 * how to turn off in the panel the ones OpsCrew turned on that the plan now has off. Run after
 * every successful apply, and by a run that plans nothing new.
 * @throws OpsCrewError `PROVIDER_ERROR` at the first order the provider refused or left unclear.
 */
export async function syncProviderBackups(
  run: ProviderBackupsRun,
  outputs: Readonly<Record<string, unknown>>,
): Promise<void> {
  for (const wanted of wantedBackups(outputs)) {
    const record = await readProviderBackups(run.deps, wanted);
    if (wanted.on) await turnOn(run, wanted, record);
    else if (record !== undefined) await leftOn(run, wanted);
  }
}
