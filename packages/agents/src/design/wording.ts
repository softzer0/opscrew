import type { VpsProviderId } from "@opscrew/contracts";
import { cloudProvider } from "@opscrew/providers";
import { type ProviderProfile, providerProfile } from "../providers";

/** How the design phase names a provider, its servers and its token in user-facing text. */
export interface DesignWording {
  profile: ProviderProfile;
  /** Short provider name for prose, for example `Hetzner`, `DigitalOcean` or `your own server`. */
  name: string;
  /** What one server is called in an option summary (`One cx23 server (...)`). */
  summaryNoun: string;
  /** Appended to option titles (Hetzner titles stay as they were before DigitalOcean). */
  titleSuffix: string;
  /**
   * The environment variable to set for live prices; absent where there are none (a provider with
   * no price API, or a server the user owns).
   */
  tokenVar?: string;
}

/**
 * Design wording for a provider, including a server the user owns (which has no token); a cloud
 * provider's comes from its definition.
 */
export function designWording(provider: VpsProviderId): DesignWording {
  const profile = providerProfile(provider);
  if (provider === "own") {
    return { profile, name: "your own server", summaryNoun: "server", titleSuffix: "" };
  }
  const { name, texts } = cloudProvider(provider);
  const { summaryNoun, titleSuffix, livePricesVar } = texts.design;
  return {
    profile,
    name,
    summaryNoun,
    titleSuffix,
    ...(livePricesVar === undefined ? {} : { tokenVar: livePricesVar }),
  };
}
