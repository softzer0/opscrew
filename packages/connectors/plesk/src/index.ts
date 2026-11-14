/**
 * @opscrew/connector-plesk: a Plesk customer's subscription as a `HostingPanel` (feature 027,
 * ADR 0030), through Plesk's XML API. What the customer API can't do is a step in the panel.
 */

export {
  FAKE_PLESK_URL,
  type FakePleskDatabase,
  type FakePleskOptions,
  type FakePleskRequest,
  type FakePleskSite,
  type FakePleskSubscription,
  fakePlesk,
} from "./fake";
export { PleskPanel } from "./panel";
