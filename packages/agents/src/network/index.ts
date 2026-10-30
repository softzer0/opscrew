/**
 * The private network of an app's servers and the user's devices (feature 018, ADR 0022):
 * allocation, keys, each server's host steps, its state and a device's configuration.
 */
export {
  type AllocatedNetwork,
  allocateNetwork,
  type NetworkHostFacts,
  networkRange,
  nextDeviceAddress,
} from "./allocate";
export { deviceConfig } from "./device";
export { hasPublicAddress, publicEndpoints } from "./endpoints";
export { type KeyMaker, type WireGuardKeyPair, x25519KeyPair } from "./keys";
export {
  type NetworkLink,
  type ReadNetworkServices,
  readNetwork,
  type WireGuardPeerState,
  type WireGuardPrivilege,
  type WireGuardReader,
} from "./read";
export {
  KEEPALIVE_SECONDS,
  type NetworkFilterParams,
  type NetworkPeer,
  type NetworkStepParams,
  networkSteps,
  type ServerNetworkFacts,
  wireGuardEndpoint,
} from "./steps";
