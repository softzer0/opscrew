/** The Beszel and Grafana Cloud add-ons. */

export {
  GRAFANA_FREE_TIER,
  type GrafanaEstimate,
  grafanaEstimate,
  type ServerReading,
} from "./estimate";
export {
  type AddonDisableOptions,
  type AddonEnableOptions,
  type AddonQuestion,
  type AddonResult,
  type AddonRunOptions,
  type AddonServices,
  addonDisable,
  addonEnable,
} from "./run";
export { BESZEL_EMAIL } from "./secrets";
export { ADDON_NAMES, type BeszelRequest } from "./settings";
export {
  type AddonContainer,
  type AddonState,
  type AddonStatus,
  addonOpen,
  addonStatus,
  addonStatusOf,
  BESZEL_LOCAL_URL,
  describeAddonStatus,
} from "./status";
