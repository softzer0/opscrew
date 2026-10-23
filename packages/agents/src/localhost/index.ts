/**
 * The localhost target (feature 015, contracts/localhost.md "Agents"): the app's production stack
 * in this computer's Docker, through the local preflight, a local plan approved by its hash, the
 * production scripts run by the local executor and OpsCrew's local CA. Provision, verify, status,
 * drift and destroy reach it through their own entry points.
 */
export { applyLocal } from "./apply";
export { caFiles } from "./ca";
export type { LocalRequest, LocalRequestInput, LocalResponse } from "./https";
export type { LocalImage, LocalRegistry } from "./image";
export {
  describeLocalPlan,
  type LocalDeploy,
  type LocalFile,
  type LocalItem,
  type LocalPlan,
  LocalPlanSchema,
  localChanges,
  localPlanFile,
  localPlanHash,
  planLocal,
  readSavedLocalPlan,
  savedLocalPlanChanges,
  savedLocalPlanPurpose,
} from "./plan";
export { localPreflight } from "./preflight";
export { type LocalhostServices, localRoots } from "./services";
export { localAddress, localSite } from "./site";
export { localTrust } from "./trust";
