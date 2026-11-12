/**
 * @opscrew/connector-cpanel: a cPanel account through UAPI and API2 (feature 027, ADR 0030):
 * `CpanelPanel` implements the `HostingPanel` contract, and `fakeCpanel` replays the answers the
 * spikes saw on a real account, for tests.
 */

export {
  type FakeCpanel,
  type FakeCpanelCall,
  type FakeCpanelCertificate,
  type FakeCpanelEntry,
  type FakeCpanelOptions,
  type FakeCpanelState,
  fakeCpanel,
} from "./fake";
export { CpanelPanel, type CpanelPanelOptions } from "./panel";
