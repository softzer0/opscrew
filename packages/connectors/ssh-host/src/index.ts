/**
 * @opscrew/connector-ssh-host: the typed host adapter for servers the user already owns
 * (feature 009). Read-only inspection, host plans of fixed steps, and an apply bound to the
 * plan's SHA-256 hash, with SSH and firewall changes under a dead-man switch on the server.
 * See `specs/009-own-server/contracts/host-adapter.md`.
 */

export { applyHostPlan } from "./apply";
export {
  APP_DIR,
  DEFAULT_DEAD_MAN_SECONDS,
  HASHED_RUNTIME_FILES,
  MIN_DOCKER_MAJOR,
  PORTAINER_DIR,
  PORTAINER_PORT,
  PORTAINER_PROJECT,
  RUNTIME_FILE_NAMES,
  type RuntimeFileName,
  SECRET_RUNTIME_FILES,
  TUNNEL_APP_PORT,
  TUNNEL_DIR,
  TUNNEL_PROJECT,
  UFW_SSH_COMMENT,
  UFW_WEB_COMMENT,
} from "./constants";
export {
  HOST_ADAPTER_VERSION,
  type HostFacts,
  HostFactsSchema,
  type HostRecord,
  HostRecordSchema,
  MARKER_PATH,
  NO_WEB_FILTER,
  RECORD_PATH,
  type RuntimeFileFact,
  type WebFilterFacts,
  webFilterFacts,
} from "./facts";
export { canonicalJson, hostPlanHash } from "./hash";
export { inspectHost } from "./inspect";
export { planHost, planTeardown, planUndo } from "./plan";
export { planPortainer } from "./steps";
export {
  type ApplyOptions,
  type ApplyResult,
  type DesiredHost,
  HOST_PLAN_SCHEMA_VERSION,
  type HostFinding,
  type HostPlan,
  HostPlanSchema,
  type HostStep,
  type HostStepId,
} from "./types";
export {
  WEB_FILTER_CHAIN,
  WEB_FILTER_SERVICE,
  type WebFilterRanges,
  webFilterFileHashes,
} from "./web-filter";
