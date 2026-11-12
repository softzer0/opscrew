/**
 * The firewalls a provider's Terraform cannot manage, which its connector applies instead (ADR
 * 0029, D8): each server module of such a provider describes the firewall it wants, and the root
 * module lists them in its `wanted_firewalls` output, by module, with the provider. After an apply
 * OpsCrew makes each provider's firewall exactly the wanted one, and deletes the firewalls of the
 * servers the apply removed.
 */
import type {
  FirewallApi,
  PhaseName,
  WantedFirewall,
  WantedFirewallOutput,
} from "@opscrew/contracts";
import { listText, OpsCrewError, upperFirst, zodIssues } from "@opscrew/core";
import { type CloudProvider, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { vpsConnector } from "../providers";
import { hintOf, reasonOf } from "./errors";

/** Each provider's firewalls, where tests pass fakes (default: the provider connector's). */
export type FirewallApis = Partial<Record<CloudProvider, FirewallApi>>;

/** A firewall a root wants: its server module and the provider whose connector applies it. */
export interface ModuleFirewall {
  module: string;
  provider: CloudProvider;
  wanted: WantedFirewall;
}

/** What the firewall steps after an apply need of the run. */
export interface FirewallRun {
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version" | "reporter" | "audit">;
  /** Phase recorded in the audit entries. */
  phase: PhaseName;
  /** The command that sets the firewalls again after a failure, e.g. `opscrew provision`. */
  command: string;
  firewalls?: FirewallApis | undefined;
}

/** A provider whose connector applies its firewalls. */
const ProviderSchema = z
  .string()
  .refine((id) => isCloudProvider(id) && cloudProvider(id).terraform.connectorFirewall, {
    message: "not a provider whose connector applies its firewalls",
  })
  .transform((id) => id as CloudProvider);

const FirewallOutputSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  server_ids: z.array(z.string().min(1)),
  rules: z.array(
    z.object({
      protocol: z.enum(["tcp", "udp", "icmp"]),
      ports: z.array(z.string()),
      ipv4: z.array(z.string()),
      ipv6: z.array(z.string()),
    }),
  ),
}) satisfies z.ZodType<WantedFirewallOutput>;

/** The root's `wanted_firewalls` output after an apply (iac-templates renders it). */
const WantedFirewallsSchema = z.record(
  z.string(),
  z.object({ provider: ProviderSchema, firewall: FirewallOutputSchema }),
);

/**
 * The output's value before the plan, as the plan JSON's `output_changes` gives it: only the
 * providers and names are read, which is all a deletion needs.
 */
const PlannedOutputsSchema = z.looseObject({
  output_changes: z
    .looseObject({
      wanted_firewalls: z
        .looseObject({
          before: z
            .record(
              z.string(),
              z.object({
                provider: ProviderSchema,
                firewall: z.object({ name: z.string().min(1) }),
              }),
            )
            .nullish(),
        })
        .optional(),
    })
    .optional(),
});

function unreadable(error: z.ZodError): OpsCrewError {
  return new OpsCrewError(
    "ENGINE_FAILED",
    `OpsCrew could not read the firewalls the servers want from the infrastructure's outputs (${zodIssues(error)}).`,
    {
      hint: "Undo manual edits under opscrew/infra (they are regenerated), then run the command again.",
    },
  );
}

/** The firewalls a root's outputs want (`wanted_firewalls`); none without that output. */
export function wantedFirewalls(outputs: Readonly<Record<string, unknown>>): ModuleFirewall[] {
  if (outputs.wanted_firewalls === undefined || outputs.wanted_firewalls === null) return [];
  const parsed = WantedFirewallsSchema.safeParse(outputs.wanted_firewalls);
  if (!parsed.success) throw unreadable(parsed.error);
  return Object.entries(parsed.data).map(([module, { provider, firewall }]) => ({
    module,
    provider,
    wanted: {
      name: firewall.name,
      description: firewall.description,
      serverIds: firewall.server_ids,
      rules: firewall.rules,
    },
  }));
}

/** `Contabo's firewall shop-firewall`. */
function firewallLabel(provider: CloudProvider, name: string): string {
  return `${cloudProvider(provider).displayName}'s firewall ${name}`;
}

/**
 * The firewalls of `provider`: the one the run was given, else its connector's.
 * @throws OpsCrewError `CREDENTIALS_MISSING` when its credentials are not set.
 */
export function firewallApi(
  run: {
    deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">;
    firewalls?: FirewallApis | undefined;
  },
  provider: CloudProvider,
): FirewallApi {
  const api = run.firewalls?.[provider] ?? vpsConnector(provider, run.deps).firewalls;
  if (api !== undefined) return api;
  const { displayName, credentials } = cloudProvider(provider);
  throw new OpsCrewError(
    "CREDENTIALS_MISSING",
    `OpsCrew cannot reach ${displayName}: its credentials (${listText(credentials.envVars)}) are not set.`,
  );
}

/**
 * Makes each firewall `outputs` wants exactly that at its provider, says and audits what changed.
 * Run after every successful apply, and by a run that plans nothing new.
 * @throws OpsCrewError `PROVIDER_ERROR` at the first that fails: its server may not be protected
 * yet, and running `run.command` again sets it again.
 */
export async function syncFirewalls(
  run: FirewallRun,
  outputs: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { deps } = run;
  for (const { provider, wanted } of wantedFirewalls(outputs)) {
    const label = firewallLabel(provider, wanted.name);
    const target = `${provider} firewall ${wanted.name}`;
    deps.reporter.step(`Setting ${label}`);
    let changes: string[];
    try {
      changes = await firewallApi(run, provider).sync(wanted);
    } catch (error) {
      const reason = reasonOf(error);
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "firewall sync failed",
        phase: run.phase,
        target,
        detail: deps.redactor.redact(reason),
      });
      const hint = hintOf(error);
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        deps.redactor.redact(
          `Setting ${label} failed: ${reason}. The ${cloudProvider(provider).serverNoun} may not be protected yet.`,
        ),
        {
          hint: deps.redactor.redact(
            `${hint}${hint === "" ? "Run" : "Then run"} \`${run.command}\` again: it plans nothing new and sets the firewall again.`,
          ),
          cause: error,
        },
      );
    }
    if (changes.length === 0) {
      deps.reporter.info(`${upperFirst(label)} is as the plan wants it.`);
      continue;
    }
    for (const change of changes) deps.reporter.success(deps.redactor.redact(change));
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "sync firewall",
      phase: run.phase,
      target,
      detail: deps.redactor.redact(changes.join(" ")),
    });
  }
}

/**
 * After an apply that removed servers: deletes each firewall the root wanted before the plan
 * (`planJson`'s `output_changes`) and wants no more (`outputs`, after the apply), then says and
 * audits it. A deletion that fails is said and audited as a warning with where to delete it by
 * hand: its servers are gone, and the rest of the run goes on.
 */
export async function removeFirewalls(
  run: Omit<FirewallRun, "command">,
  planJson: unknown,
  outputs: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { deps } = run;
  if (planJson === undefined) return;
  const parsed = PlannedOutputsSchema.safeParse(planJson);
  if (!parsed.success) throw unreadable(parsed.error);
  const before = Object.values(parsed.data.output_changes?.wanted_firewalls?.before ?? {});
  const kept = new Set(
    wantedFirewalls(outputs).map(({ provider, wanted }) => `${provider} ${wanted.name}`),
  );
  for (const { provider, firewall } of before) {
    const { name } = firewall;
    if (kept.has(`${provider} ${name}`)) continue;
    const label = firewallLabel(provider, name);
    const target = `${provider} firewall ${name}`;
    deps.reporter.step(`Deleting ${label}`);
    try {
      if (!(await firewallApi(run, provider).remove(name))) {
        deps.reporter.info(`${upperFirst(label)} was gone already.`);
        continue;
      }
    } catch (error) {
      const reason = reasonOf(error);
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "firewall deletion failed",
        phase: run.phase,
        target,
        detail: deps.redactor.redact(reason),
      });
      deps.reporter.warn(
        deps.redactor.redact(
          `OpsCrew could not delete ${label}: ${reason}. No server of this app needs it any more; delete it in ${cloudProvider(provider).texts.destroy.console}.`,
        ),
      );
      continue;
    }
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: "delete firewall",
      phase: run.phase,
      target,
      detail: "its servers were removed by the apply",
    });
    deps.reporter.success(`Deleted ${label}.`);
  }
}
