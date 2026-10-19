/**
 * @opscrew/connector-ssh-host: the typed host adapter for servers the user already owns
 * (feature 009). Read-only inspection, host plans of fixed steps, and an apply bound to the
 * plan's SHA-256 hash, with SSH and firewall changes under a dead-man switch on the server.
 * Several OpsCrew apps share a server (feature 013): each has its own record, folders, deploy key
 * and Cloudflare Tunnel connector, and the shared edge goes with the last one.
 * See `specs/009-own-server/contracts/host-adapter.md` and
 * `specs/013-component-model/contracts/components.md`.
 */

export { applyHostPlan, HostApplyError } from "./apply";
export {
  appDirs,
  EDGE_DIR,
  EDGE_PROJECT,
  HASHED_RUNTIME_FILES,
  MIN_DOCKER_MAJOR,
  PORTAINER_DIR,
  PORTAINER_PROJECT,
  type RuntimeFileName,
  runtimeFilePath,
  SECRET_RUNTIME_FILES,
  SHARED_DIRS,
  tunnelDir,
  tunnelProject,
  UFW_SSH_COMMENT,
  UFW_WEB_COMMENT,
} from "./constants";
export {
  type AppRecord,
  type HostFacts,
  HostFactsSchema,
  otherActiveApps,
  readableRecords,
  tunnelOf,
} from "./facts";
export { hostPlanHash } from "./hash";
export { inspectHost } from "./inspect";
export { isPublicAddress } from "./parse";
export { planHost, planPortainer, planTeardown, planUndo } from "./plan";
export {
  type ApplyOptions,
  type ApplyResult,
  type DesiredHost,
  type HostPlan,
  HostPlanSchema,
  type HostStep,
  type HostStepId,
} from "./types";
export { webFilterFileHashes } from "./web-filter";
