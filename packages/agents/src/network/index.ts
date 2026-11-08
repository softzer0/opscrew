/**
 * The private network of an app's servers and the user's devices (feature 018, ADR 0022):
 * allocation, keys, each server's host steps, its state and a device's configuration. A plan that
 * sends to another environment's monitoring server (feature 020) has that server as a member too,
 * on an interface of its own there.
 */
export {
  allocateNetwork,
  moveAppMember,
  type NetworkHostFacts,
  nextDeviceAddress,
} from "./allocate";
export {
  applyNetworkPlansTogether,
  type NetworkPlanInputs,
  networkPlanInputs,
  networkPlanStep,
} from "./apply";
export { deviceConfig } from "./device";
export { hasPublicAddress, PREVIOUS_MEMBER, publicEndpoints } from "./endpoints";
export { networkHostPlan, publicSshHostPlan } from "./host-plans";
export { serverNetworkInputs } from "./inputs";
export { type KeyMaker, type WireGuardKeyPair, x25519KeyPair } from "./keys";
export { type MonitoringOwner, monitoringOwner } from "./owner";
export {
  type NetworkLink,
  type ReadNetworkServices,
  readNetwork,
} from "./read";
export { networkFilterRules, networkRemovalSteps, networkSteps } from "./steps";
