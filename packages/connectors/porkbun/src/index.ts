// porkbun connector (feature 007): client and registrar adapter.
export {
  isPorkbunSandboxKey,
  PORKBUN_API,
  PORKBUN_BULK_CHECK_LIMIT,
  type PorkbunAvailability,
  type PorkbunBulkCheck,
  PorkbunClient,
  type PorkbunClientOptions,
  type PorkbunCreated,
  type PorkbunCreateOptions,
  type PorkbunCreatePreview,
  type PorkbunDnsRecord,
  type PorkbunDomain,
  type PorkbunPing,
  type PorkbunTldRequirements,
} from "./client";
export {
  PORKBUN_API_SETTINGS_URL,
  PORKBUN_CREDIT_URL,
  PORKBUN_DASHBOARD_URL,
  PURCHASE_REJECTION_CODES,
} from "./problems";
export {
  PorkbunRegistrar,
  type PorkbunRegistrarApi,
  type PorkbunRegistrarOptions,
} from "./registrar";
