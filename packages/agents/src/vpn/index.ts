/** `opscrew vpn`: the user's devices on an app's private network (feature 018, US3). */
export {
  deviceConfigFile,
  type VpnAddOptions,
  type VpnAddResult,
  type VpnRemoveOptions,
  type VpnRemoveResult,
  vpnAdd,
  vpnRemove,
} from "./devices";
export {
  type VpnDevice,
  type VpnDeviceLink,
  type VpnListResult,
  vpnList,
} from "./list";
export type { VpnServices } from "./servers";
