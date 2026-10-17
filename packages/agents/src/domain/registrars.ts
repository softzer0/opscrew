import { CLOUDFLARE_TOKEN_PAGE } from "@opscrew/connector-cloudflare";
import {
  GODADDY_DASHBOARD_URLS,
  GoDaddyClient,
  GoDaddyRegistrar,
} from "@opscrew/connector-godaddy";
import {
  NAMECHEAP_DASHBOARD_URLS,
  NAMECHEAP_SANDBOX_DASHBOARD_URLS,
  NamecheapClient,
  NamecheapRegistrar,
} from "@opscrew/connector-namecheap";
import {
  isPorkbunSandboxKey,
  PORKBUN_API_SETTINGS_URL,
  PORKBUN_DASHBOARD_URL,
  PorkbunClient,
  PorkbunRegistrar,
} from "@opscrew/connector-porkbun";
import type { Registrar, RegistrarId } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { DASHBOARD } from "./common";

/** Registrars other than Cloudflare: one account each, set up from environment variables. */
export type OtherRegistrarId = Exclude<RegistrarId, "cloudflare">;

/** The registrars other than Cloudflare, in the order OpsCrew lists them. */
export const OTHER_REGISTRAR_IDS = [
  "porkbun",
  "namecheap",
  "godaddy",
] as const satisfies readonly OtherRegistrarId[];

/** Every registrar, in the order OpsCrew lists them (a tuple, for `z.enum`). */
export const REGISTRAR_IDS = [
  "cloudflare",
  ...OTHER_REGISTRAR_IDS,
] as const satisfies readonly RegistrarId[];

/** Display names. */
export const REGISTRAR_NAMES: Readonly<Record<RegistrarId, string>> = {
  cloudflare: "Cloudflare",
  porkbun: "Porkbun",
  namecheap: "Namecheap",
  godaddy: "GoDaddy",
};

/** Environment variables a registrar needs (all of them must be set). */
export const REGISTRAR_ENV: Readonly<Record<RegistrarId, readonly string[]>> = {
  cloudflare: ["CLOUDFLARE_API_TOKEN"],
  porkbun: ["PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY"],
  namecheap: ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY"],
  godaddy: ["GODADDY_API_TOKEN"],
};

/** Where a registrar's settings are changed by hand (plain-English page descriptions with URLs). */
export interface RegistrarLinks {
  /** The domain list: auto-renew, DNSSEC, nameservers and anything the API cannot change. */
  domains: string;
  /** Where API access and keys are managed. */
  api: string;
  /** Where the registrant contact is kept (registrars that need one). */
  contacts?: string;
}

/** `cloudflare`, `porkbun`, `namecheap` or `godaddy` (case-insensitive); anything else stops. */
export function parseRegistrarId(input: string): RegistrarId {
  const id = input.trim().toLowerCase();
  if ((REGISTRAR_IDS as readonly string[]).includes(id)) return id as RegistrarId;
  throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not know the registrar "${input}".`, {
    hint: `Use one of ${REGISTRAR_IDS.join(", ")}.`,
  });
}

/** True when the environment variable is set to something other than blanks. */
export function hasEnv(env: Record<string, string | undefined>, name: string): boolean {
  return (env[name]?.trim() ?? "") !== "";
}

/** Registrars whose credentials are set, in {@link REGISTRAR_IDS} order. */
export function configuredRegistrars(env: Record<string, string | undefined>): RegistrarId[] {
  return REGISTRAR_IDS.filter((id) => REGISTRAR_ENV[id].every((name) => hasEnv(env, name)));
}

/**
 * True when `id` runs against its registrar's test system: `OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX=1`,
 * Porkbun sandbox keys (`pk1_sb_`) or `NAMECHEAP_SANDBOX=1`. GoDaddy has none.
 */
export function registrarSandbox(
  id: RegistrarId,
  env: Record<string, string | undefined>,
): boolean {
  switch (id) {
    case "cloudflare":
      return env.OPSCREW_CLOUDFLARE_REGISTRAR_SANDBOX === "1";
    case "porkbun":
      return isPorkbunSandboxKey(env.PORKBUN_API_KEY?.trim() ?? "");
    case "namecheap":
      return env.NAMECHEAP_SANDBOX === "1";
    case "godaddy":
      return false;
  }
}

/** Dashboard pages per registrar (the sandbox pages for Namecheap's sandbox). */
export function registrarLinks(
  id: RegistrarId,
  env: Record<string, string | undefined> = {},
): RegistrarLinks {
  switch (id) {
    case "cloudflare":
      return { domains: DASHBOARD, api: CLOUDFLARE_TOKEN_PAGE };
    case "porkbun":
      return { domains: PORKBUN_DASHBOARD_URL, api: PORKBUN_API_SETTINGS_URL };
    case "namecheap": {
      const urls = registrarSandbox("namecheap", env)
        ? NAMECHEAP_SANDBOX_DASHBOARD_URLS
        : NAMECHEAP_DASHBOARD_URLS;
      return { domains: urls.domainList, api: urls.apiAccess, contacts: urls.addressBook };
    }
    case "godaddy":
      return {
        domains: GODADDY_DASHBOARD_URLS.portfolio,
        api: GODADDY_DASHBOARD_URLS.apiAccess,
        contacts: GODADDY_DASHBOARD_URLS.contactProfiles,
      };
  }
}

function requireEnv(deps: PhaseDeps, id: OtherRegistrarId): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of REGISTRAR_ENV[id]) {
    const value = deps.env[name]?.trim();
    if (value) values[name] = value;
    else missing.push(name);
  }
  if (missing.length > 0) {
    const name = REGISTRAR_NAMES[id];
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `${name} is not set up: ${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} missing.`,
      {
        hint: `Create API credentials at ${registrarLinks(id, deps.env).api}, set ${REGISTRAR_ENV[id].join(" and ")}, then try again.`,
      },
    );
  }
  return values;
}

/**
 * The registrar adapter for `id`, built from its environment variables with the run's `fetch`.
 * Secrets are registered with the redactor first. Porkbun sandbox keys (`pk1_sb_`) and
 * `NAMECHEAP_SANDBOX=1` select the registrars' test systems (with a warning). Namecheap's
 * `ClientIp` comes from `NAMECHEAP_CLIENT_IP`, else Namecheap's client detects it once;
 * GoDaddy uses `GODADDY_PROFILE_ID` when set. Missing credentials stop with what to set.
 */
export function registrarFor(id: OtherRegistrarId, deps: PhaseDeps): Registrar {
  const env = requireEnv(deps, id);
  switch (id) {
    case "porkbun": {
      const apiKey = env.PORKBUN_API_KEY as string;
      const secretApiKey = env.PORKBUN_SECRET_API_KEY as string;
      deps.redactor.addLiteral(apiKey, "porkbun-api-key");
      deps.redactor.addLiteral(secretApiKey, "porkbun-secret-key");
      if (isPorkbunSandboxKey(apiKey)) {
        deps.reporter.warn(
          "Using Porkbun's sandbox (the API key starts with pk1_sb_): purchases and changes are simulated. Use a live key to buy real domains.",
        );
      }
      return new PorkbunRegistrar(new PorkbunClient({ apiKey, secretApiKey, fetch: deps.fetch }));
    }
    case "namecheap": {
      const apiKey = env.NAMECHEAP_API_KEY as string;
      deps.redactor.addLiteral(apiKey, "namecheap-api-key");
      const sandbox = registrarSandbox("namecheap", deps.env);
      if (sandbox) {
        deps.reporter.warn(
          "Using Namecheap's sandbox (NAMECHEAP_SANDBOX=1) with a sandbox account: purchases are simulated. Unset it to buy real domains.",
        );
      }
      return new NamecheapRegistrar(
        new NamecheapClient({
          apiUser: env.NAMECHEAP_API_USER as string,
          apiKey,
          userName: deps.env.NAMECHEAP_USERNAME,
          clientIp: deps.env.NAMECHEAP_CLIENT_IP,
          sandbox,
          fetch: deps.fetch,
        }),
      );
    }
    case "godaddy": {
      const token = env.GODADDY_API_TOKEN as string;
      deps.redactor.addLiteral(token, "godaddy-token");
      const profileId = deps.env.GODADDY_PROFILE_ID?.trim();
      return new GoDaddyRegistrar(
        new GoDaddyClient({ token, fetch: deps.fetch }),
        profileId ? { profileId } : {},
      );
    }
  }
}
