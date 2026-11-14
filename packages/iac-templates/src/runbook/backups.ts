/**
 * Automated backups that only the provider's order page prices (`offering.backupsPrice:
 * "order-page"`, Contabo's Auto Backup: no price per plan, 027 R15). OpsCrew never counts them in
 * a monthly sum and says so, in these words, wherever it shows one: the runbook, design, provision
 * and advise.
 */
import { isCloudProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";

/** True when `provider` prices its automated backups only on its order page. */
export function backupsOnOrderPage(provider: string): boolean {
  return (
    isCloudProvider(provider) && cloudProvider(provider).offering.backupsPrice === "order-page"
  );
}

/** The providers of `servers` with backups on that only their order page prices, each once. */
export function orderPageProviders(
  servers: Iterable<{ provider: string; backups?: boolean | undefined }>,
): string[] {
  const providers = new Set<string>();
  for (const { provider, backups } of servers) {
    if (backups === true && backupsOnOrderPage(provider)) providers.add(provider);
  }
  return [...providers];
}

/**
 * The sentence for backups only `provider`'s order page prices: left out of `what` (`this price`),
 * or without `what`, where their price is.
 */
export function orderPageBackupsText(provider: string, what?: string): string {
  const { name, sizeNoun } = cloudProvider(provider);
  return what === undefined
    ? `${name}'s automated backups are priced on ${name}'s order page: ${name} publishes no price per ${sizeNoun} for them.`
    : `${name}'s automated backups are not in ${what}: they are priced on ${name}'s order page.`;
}
