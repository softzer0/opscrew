// GoDaddy connector (feature 007): Domains API v3 client and registrar adapter.
export {
  GODADDY_API,
  GODADDY_MAX_BATCH,
  GoDaddyClient,
  type GoDaddyClientOptions,
  type GoDaddyQuoteInput,
  type GoDaddyRegisterInput,
} from "./client";
export {
  GODADDY_DASHBOARD_URLS,
  type GoDaddyAvailability,
  type GoDaddyDnsRecord,
  type GoDaddyDomain,
  type GoDaddyOperation,
  type GoDaddyQuote,
  type GoDaddyRegistration,
  type GoDaddySuggestion,
} from "./parse";
export {
  GoDaddyRegistrar,
  type GoDaddyRegistrarApi,
  type GoDaddyRegistrarOptions,
} from "./registrar";
