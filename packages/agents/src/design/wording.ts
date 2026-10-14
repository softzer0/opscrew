import type { VpsProviderId } from "@opscrew/contracts";
import type { CloudProvider } from "@opscrew/plan-schema";
import { ownServerNotYet, type ProviderProfile, providerProfile } from "../providers";

/** How the design phase names a provider, its servers and its token in user-facing text. */
export interface DesignWording {
  profile: ProviderProfile;
  /** Short provider name for prose, for example `Hetzner` or `DigitalOcean`. */
  name: string;
  /** What one server is called in an option summary (`One cx23 server (...)`). */
  summaryNoun: string;
  /** Appended to option titles (Hetzner titles stay as they were before DigitalOcean). */
  titleSuffix: string;
  /** The environment variable to set for live prices. */
  tokenVar: string;
}

const TEXT: Readonly<
  Record<CloudProvider, Pick<DesignWording, "name" | "summaryNoun" | "titleSuffix">>
> = {
  hetzner: { name: "Hetzner", summaryNoun: "server", titleSuffix: "" },
  digitalocean: {
    name: "DigitalOcean",
    summaryNoun: "DigitalOcean Droplet",
    titleSuffix: " on DigitalOcean",
  },
};

/** Design wording for a provider; throws for a server the user owns. */
export function designWording(provider: VpsProviderId): DesignWording {
  if (provider === "own") throw ownServerNotYet();
  const profile = providerProfile(provider);
  return { profile, ...TEXT[provider], tokenVar: profile.tokenVars[0] ?? "the API token" };
}
