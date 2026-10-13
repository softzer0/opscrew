// Namecheap connector (feature 007): XML API client and registrar adapter.
export {
  isClearRejection,
  NAMECHEAP_API,
  NAMECHEAP_CHECK_BATCH,
  NAMECHEAP_SANDBOX_API,
  type NamecheapBalance,
  type NamecheapCheckResult,
  NamecheapClient,
  type NamecheapClientOptions,
  type NamecheapCreateRequest,
  type NamecheapCreateResult,
  type NamecheapDnsList,
  type NamecheapDomain,
  type NamecheapDomainInfo,
  type NamecheapHost,
  type NamecheapHostList,
  type NamecheapPrice,
  namecheapDate,
  normalizeDomain,
  splitDomain,
} from "./client";
export { normalizePhone } from "./contacts";
export {
  NAMECHEAP_API_ELIGIBILITY,
  NAMECHEAP_DASHBOARD_URLS,
  NAMECHEAP_SANDBOX_DASHBOARD_URLS,
  type NamecheapDashboardUrls,
} from "./errors";
export {
  NAMECHEAP_EXTENDED_ATTRIBUTE_TLDS,
  NamecheapRegistrar,
  type NamecheapRegistrarApi,
  priceFor,
} from "./registrar";
