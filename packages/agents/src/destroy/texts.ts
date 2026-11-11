import type { ProviderDestroyTexts, VpsProviderId } from "@opscrew/contracts";
import { type CloudProvider, isCloudProvider, isServerlessProvider } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { providerProfile } from "../providers";
import type { DeletionProvider } from "./types";

/**
 * Teardown wording that differs per provider: a cloud provider's comes from its definition
 * (`texts.destroy`, with its names and what it calls a server); a server the user owns has its own.
 */
export interface DestroyTexts extends Omit<ProviderDestroyTexts, "storageConsole"> {
  /** `Hetzner Cloud` or `DigitalOcean`. */
  displayName: string;
  /** What the provider calls the server: `server` or `Droplet`. */
  noun: string;
  /** The provider as a company, for example `Hetzner`. */
  company: string;
}

/** A cloud provider's teardown wording, from its definition. */
function cloudTexts(provider: CloudProvider): DestroyTexts {
  const definition = cloudProvider(provider);
  const { storageConsole: _bucketConsole, ...texts } = definition.texts.destroy;
  return {
    displayName: definition.displayName,
    noun: definition.serverNoun,
    company: definition.name,
    ...texts,
  };
}

/**
 * A server the user owns: OpsCrew never deletes it and has no snapshots or provider backups there
 * (backups are the user's responsibility), so the snapshot texts say that instead.
 */
function ownTexts(): DestroyTexts {
  const profile = providerProfile("own");
  return {
    displayName: profile.displayName,
    noun: profile.serverNoun,
    company: "",
    console: "your server",
    snapshotRef: () => "no snapshot (OpsCrew cannot take snapshots of your own server)",
    snapshotBilling:
      "OpsCrew cannot take snapshots of your own server; backups are your responsibility",
    snapshotBilled: "not available on your own server",
    lookup: (app) => `marked as running the OpsCrew app ${app} (/etc/opscrew/app.json)`,
    tokenHint: () =>
      "No API token is needed for your own server: OpsCrew connects over SSH with the login from `opscrew interview`.",
  };
}

/**
 * The minimum term in months when `provider` cancels a server at the end of its term instead of
 * deleting it (its definition's `removal`, Contabo's); `undefined` where the server is deleted at
 * once (Hetzner, DigitalOcean) and anywhere OpsCrew created no server.
 */
export function cancelTerm(provider: string): number | undefined {
  if (!isCloudProvider(provider)) return undefined;
  const { removal } = cloudProvider(provider).offering;
  return removal.kind === "cancel-at-term-end" ? removal.minimumTermMonths : undefined;
}

/** True when `provider`'s whole-server snapshots outlive the server, so one is worth taking first. */
export function snapshotsOutlive(provider: CloudProvider): boolean {
  return cloudProvider(provider).offering.serverSnapshotsOutliveServer;
}

/**
 * What goes when a cancelled server's term ends, for the typed questions: its disk, and its
 * provider snapshots unless they outlive it (`snapshotsOutlive`).
 */
export function goneAtTermEnd(provider: CloudProvider): string {
  return snapshotsOutlive(provider)
    ? "its disk goes when the term ends"
    : `its disk and its ${cloudProvider(provider).name} snapshots go when the term ends`;
}

/**
 * The question before a teardown, asking for the name to type. OpsCrew's servers are named after
 * the app; on a server the user owns the app's name is typed, and the server itself stays; on a
 * server-less target the app's name is typed too. Where the provider cancels the server instead
 * of deleting it, the question says it stays billed to the end of its term.
 */
export function destroyConfirmPrompt(name: string, provider: DeletionProvider): string {
  if (provider === "portainer") {
    return `Type ${name} (the app's name) to remove the app as listed above; your Portainer and its other stacks stay (anything else cancels)`;
  }
  if (isServerlessProvider(provider)) {
    return `Type ${name} (the app's name) to remove the app as listed above (anything else cancels)`;
  }
  if (provider === "own") {
    return `Type ${name} (the app's name) to remove the app as listed above; your server itself stays (anything else cancels)`;
  }
  if (isCloudProvider(provider) && cancelTerm(provider) !== undefined) {
    const texts = destroyTexts(provider);
    return `Type ${name} to cancel the ${texts.company} ${texts.noun}, billed until the end of its term, and delete the rest listed above; ${goneAtTermEnd(provider)} (anything else stops with nothing changed)`;
  }
  return `Type ${name} to delete everything listed above (anything else cancels)`;
}

/** The teardown wording for `provider`, including a server the user owns. */
export function destroyTexts(provider: VpsProviderId): DestroyTexts {
  return provider === "own" ? ownTexts() : cloudTexts(provider);
}
