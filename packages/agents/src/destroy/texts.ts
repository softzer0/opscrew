import type { VpsProviderId } from "@opscrew/contracts";
import { providerProfile } from "../providers";

/**
 * Teardown wording that differs per provider. The Hetzner texts are exactly those of feature 003;
 * names, nouns and token variables come from the provider profile.
 */
export interface DestroyTexts {
  /** `Hetzner Cloud` or `DigitalOcean`. */
  displayName: string;
  /** What the provider calls the server: `server` or `Droplet`. */
  noun: string;
  /** The provider as a company, for example `Hetzner`. */
  company: string;
  /** Where the user manages servers and snapshots, for example `the Hetzner Cloud Console`. */
  console: string;
  /** How a snapshot is referred to, for example `Hetzner image 9001`. */
  snapshotRef(id: string): string;
  /** Snapshot pricing as a clause, for example `Hetzner bills snapshots per GB per month`. */
  snapshotBilling: string;
  /** Snapshot pricing for the approval, for example `billed per GB per month`. */
  snapshotBilled: string;
  /** How the app's servers are found, for example `labelled managed-by=opscrew,app=shop`. */
  lookup(app: string): string;
  /** Hint when the provider token is missing. */
  tokenHint: string;
  /** Data lost with the server when backups are on and the provider deletes them with it. */
  deletedBackups?: string;
  /** What happens to the automatic backups when the provider keeps them after the deletion. */
  keptBackups?: string;
  /** "What remains" entry for automatic backups the provider keeps after the deletion. */
  keptBackupsRemaining?: string;
}

function hetznerTexts(): DestroyTexts {
  const profile = providerProfile("hetzner");
  return {
    displayName: profile.displayName,
    noun: profile.serverNoun,
    company: "Hetzner",
    console: "the Hetzner Cloud Console",
    snapshotRef: (id) => `Hetzner image ${id}`,
    snapshotBilling: "Hetzner bills snapshots per GB per month",
    snapshotBilled: "billed per GB per month",
    lookup: (app) => `labelled managed-by=opscrew,app=${app}`,
    tokenHint:
      "Create a Read & Write API token in the Hetzner Cloud Console (your project → Security → API tokens).",
    deletedBackups: "Hetzner's automatic backups of the server",
  };
}

function digitalOceanTexts(): DestroyTexts {
  const profile = providerProfile("digitalocean");
  return {
    displayName: profile.displayName,
    noun: profile.serverNoun,
    company: "DigitalOcean",
    console: "the DigitalOcean control panel",
    snapshotRef: (id) => `DigitalOcean snapshot ${id}`,
    snapshotBilling: "DigitalOcean bills snapshots at $0.06 per GB per month",
    snapshotBilled: "billed at $0.06 per GB per month",
    lookup: (app) => `tagged opscrew-app:${app} and managed-by:opscrew`,
    tokenHint: `Create a custom-scoped token at ${profile.tokenUrl}, then set it as ${profile.tokenVars[0]} and run \`opscrew destroy\` again.`,
    keptBackups:
      "DigitalOcean keeps the Droplet's automatic backups until they expire, four weeks after they were taken",
    keptBackupsRemaining:
      "The Droplet's automatic backups. DigitalOcean keeps them until they expire, four weeks after they were taken; you can delete them earlier in the DigitalOcean control panel.",
  };
}

/** The teardown wording for `provider`. */
export function destroyTexts(provider: VpsProviderId): DestroyTexts {
  return provider === "digitalocean" ? digitalOceanTexts() : hetznerTexts();
}
