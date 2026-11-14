import type { DeployPlan } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import {
  connectorBackupsProvider,
  label,
  panel,
  readProviderBackups,
  wantedBackups,
} from "../shared/provider-backups";

/**
 * What OpsCrew knows of the automated backups the providers' connectors turn on (Contabo's Auto
 * Backup), as notes: they are compared with the state's outputs (`outputs`) through OpsCrew's own
 * record of ordering them only, since the provider's API doesn't say whether they are on (027 R15),
 * and `opscrew provision` can neither check nor undo a difference, so none is drift it would undo.
 * None, without reading the outputs, when no server of `plan` is at such a provider.
 */
export async function providerBackupsNotes(
  deps: Pick<PhaseDeps, "paths">,
  plan: Pick<DeployPlan, "target" | "servers">,
  outputs: () => Promise<Record<string, unknown> | undefined>,
): Promise<string[]> {
  const targets = [plan.target, ...(plan.servers ?? []).map((server) => server.target)];
  const providers = [
    ...new Set(targets.map(({ provider }) => provider).filter(connectorBackupsProvider)),
  ];
  if (providers.length === 0) return [];
  const notes = providers.map((provider) => {
    const { name } = cloudProvider(provider);
    return `${name}'s automated backups are compared with OpsCrew's record of ordering them, not with ${name}: its API doesn't say which add-on they are.`;
  });
  for (const wanted of wantedBackups((await outputs()) ?? {})) {
    const record = await readProviderBackups(deps, wanted);
    const what = label(wanted);
    const where = panel(wanted);
    const note = wanted.on
      ? record === undefined
        ? `The plan has ${what} on, and OpsCrew has no record of turning them on on this computer: check the server in ${where}.`
        : record.state === "wanted"
          ? `The plan has ${what} on, and OpsCrew's order of them hasn't gone through yet: the next \`opscrew provision\` sends it again.`
          : record.state === "sent"
            ? `The plan has ${what} on, and OpsCrew's order of them got no clear answer, so they may not be on: check the server in ${where}.`
            : undefined
      : record === undefined || record.state === "wanted"
        ? undefined
        : record.state === "sent"
          ? `The plan has ${what} off, and OpsCrew's order of them got no clear answer, so they may be on: check the server in ${where}, and cancel them there if they are.`
          : `The plan has ${what} off, but OpsCrew turned them on: they stay on, and billed, until you cancel them in ${where}.`;
    if (note !== undefined) notes.push(note);
  }
  return notes;
}
