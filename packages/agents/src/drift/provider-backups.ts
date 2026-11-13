import { type DeployPlan, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import { readProviderBackups, wantedBackups } from "../shared/provider-backups";
import type { DriftedResource } from "./types";

/** The provider of `terraform_data`, which describes the backups the connector turns on. */
const BUILTIN_PROVIDER = "terraform.io/builtin/terraform";

/**
 * How the automated backups the providers' connectors turn on (Contabo's Auto Backup) differ from
 * the ones the state's outputs want (`outputs`), with a note that says what they are compared
 * with: OpsCrew's own record of turning them on, since the provider's API doesn't say whether they
 * are on (027 R15). Each difference is drift of the resource describing them
 * (`module.<server>.terraform_data.backup`), in plain English. None, without reading the outputs,
 * when no server of `plan` is at such a provider.
 */
export async function providerBackupsDrift(
  deps: Pick<PhaseDeps, "paths">,
  plan: Pick<DeployPlan, "target" | "servers">,
  outputs: () => Promise<Record<string, unknown> | undefined>,
): Promise<{ drift: DriftedResource[]; notes: string[] }> {
  const targets = [plan.target, ...(plan.servers ?? []).map((server) => server.target)];
  const providers = [
    ...new Set(
      targets.flatMap(({ provider }) =>
        isCloudProvider(provider) && cloudProvider(provider).terraform.connectorBackups === true
          ? [provider]
          : [],
      ),
    ),
  ];
  if (providers.length === 0) return { drift: [], notes: [] };
  const notes = providers.map((provider) => {
    const { name } = cloudProvider(provider);
    return `${name}'s automated backups are compared with OpsCrew's record of turning them on, not with ${name}: its API doesn't say which add-on they are.`;
  });
  const drift: DriftedResource[] = [];
  for (const wanted of wantedBackups((await outputs()) ?? {})) {
    const record = await readProviderBackups(deps, wanted);
    const { name, texts } = cloudProvider(wanted.provider);
    const what = `${name}'s automated backups of server ${wanted.serverId}`;
    const difference = wanted.on
      ? record === undefined
        ? `The plan has ${what} on, and OpsCrew has no record of turning them on.`
        : record.state === "sent"
          ? `The plan has ${what} on, and OpsCrew's request to turn them on got no clear answer.`
          : undefined
      : record === undefined
        ? undefined
        : `The plan has ${what} off, but OpsCrew turned them on: they stay on until you cancel them in ${texts.destroy.console}.`;
    if (difference === undefined) continue;
    drift.push({
      address: `module.${wanted.module}.terraform_data.backup`,
      type: "terraform_data",
      name: "backup",
      provider: BUILTIN_PROVIDER,
      action: "update",
      attributes: [],
      differences: [difference],
    });
  }
  return { drift, notes };
}
