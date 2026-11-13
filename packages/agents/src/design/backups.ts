/**
 * The provider's automated daily backups (`target.backups`) as design sets them: on by default
 * only in prod, while the interview says the data matters; dev, staging and previews rely on
 * OpsCrew's own snapshots. The plan's own `target.backups` decides over the default.
 */
import { isCloudProvider, type Requirements } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";

/** Why the backups are on or off: the plan says, prod with data that matters, no data, not prod. */
export type BackupsReason = "plan" | "prod" | "data" | "environment";

/** The backups design plans for a server, with why. */
export interface DesignedBackups {
  on: boolean;
  why: BackupsReason;
}

/** The environment where the provider's backups are on by default. */
const BACKUPS_ENVIRONMENT = "prod";

/** True when design turns the provider's backups on by default: prod, with data that matters. */
export function backupsByDefault(
  requirements: Pick<Requirements, "dataCriticality">,
  environment: string,
): boolean {
  return environment === BACKUPS_ENVIRONMENT && requirements.dataCriticality !== "none";
}

/** The backups of `environment`: the plan's `planned` setting when it has one, else the default. */
export function designedBackups(
  requirements: Pick<Requirements, "dataCriticality">,
  environment: string,
  planned: boolean | undefined,
): DesignedBackups {
  if (planned !== undefined) return { on: planned, why: "plan" };
  if (environment !== BACKUPS_ENVIRONMENT) return { on: false, why: "environment" };
  return backupsByDefault(requirements, environment)
    ? { on: true, why: "prod" }
    : { on: false, why: "data" };
}

/**
 * Design's sentence on the backups: which, and why. A preview environment's releases take no
 * snapshot, so only the others are said to rely on them.
 */
export function backupsText(
  backups: DesignedBackups,
  environment: string,
  preview: boolean,
): string {
  const state = backups.on ? "on" : "off";
  switch (backups.why) {
    case "plan":
      return `Automated backups are ${state}, as target.backups in the plan says.`;
    case "prod":
      return "Automated backups are on in prod, as the data matters.";
    case "data":
      return "Automated backups are off.";
    case "environment":
      return preview
        ? `Automated backups are off in ${environment}: they are on by default only in prod.`
        : `Automated backups are off in ${environment}: they are on by default only in prod, and ${environment} relies on OpsCrew's own snapshot before each release.`;
  }
}

/**
 * True when `provider` prices its automated backups only on its order page (`backupsPrice:
 * "order-page"`, Contabo's Auto Backup, 027 R15): they are never counted in a monthly sum.
 */
export function backupsOnOrderPage(provider: string): boolean {
  return (
    isCloudProvider(provider) && cloudProvider(provider).offering.backupsPrice === "order-page"
  );
}

/**
 * The sentence for backups priced only on `provider`'s order page, left out of `what` (`this
 * price`, `this estimate`): `Contabo's automated backups are not in this price: they are priced on
 * Contabo's order page.`
 */
export function orderPageBackupsText(provider: string, what: string): string {
  const { name } = cloudProvider(provider);
  return `${name}'s automated backups are not in ${what}: they are priced on ${name}'s order page.`;
}
