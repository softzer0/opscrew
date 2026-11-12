import { type DeployPlan, isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import { type FirewallApis, firewallApi, wantedFirewalls } from "../shared/firewalls";
import type { DriftedResource } from "./types";

/** The provider of `terraform_data`, which describes a firewall the connector applies. */
const BUILTIN_PROVIDER = "terraform.io/builtin/terraform";

/**
 * How the firewalls the providers' connectors apply (ADR 0029, D8) differ from the ones the state's
 * outputs want (`outputs`): each that differs is drift of the resource describing it
 * (`firewallResourceType`, `module.<server>.terraform_data.firewall`), with the differences in
 * plain English. None, without reading the outputs, when no server of `plan` is at such a
 * provider.
 */
export async function firewallDrift(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  plan: Pick<DeployPlan, "target" | "servers">,
  outputs: () => Promise<Record<string, unknown> | undefined>,
  firewalls: FirewallApis | undefined,
): Promise<DriftedResource[]> {
  const targets = [plan.target, ...(plan.servers ?? []).map((server) => server.target)];
  const applied = targets.some(
    ({ provider }) =>
      isCloudProvider(provider) && cloudProvider(provider).terraform.connectorFirewall,
  );
  if (!applied) return [];
  const drift: DriftedResource[] = [];
  for (const { module, provider, wanted } of wantedFirewalls((await outputs()) ?? {})) {
    const differences = await firewallApi({ deps, firewalls }, provider).differences(wanted);
    if (differences.length === 0) continue;
    const resource = cloudProvider(provider).terraform.firewallResourceType;
    const [type = resource, name = resource] = resource.split(".");
    drift.push({
      address: `module.${module}.${resource}`,
      type,
      name,
      provider: BUILTIN_PROVIDER,
      action: "update",
      attributes: [],
      differences: differences.map((difference) => deps.redactor.redact(difference)),
    });
  }
  return drift;
}
