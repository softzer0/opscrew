/**
 * @opscrew/connector-ssh-host: the typed host adapter for servers the user already owns
 * (feature 009). Read-only inspection, host plans of fixed steps, and an apply bound to the
 * plan's SHA-256 hash, with SSH and firewall changes under a dead-man switch on the server.
 * Several OpsCrew apps share a server (feature 013): each has its own record, folders, deploy key
 * and Cloudflare Tunnel connector, and the shared edge goes with the last one. An app's GitHub
 * Actions runner (feature 015) is deploy's systemd user service there and, through `planRunner`
 * as the deploy user, on the servers OpsCrew creates. A runner machine (a machine of the user's
 * that only runs the environments' runners) has a host plan of its own, `planRunnerHost`, and is
 * taken back with `planUndo`. No plan replaces or removes another repository's runner.
 * See `specs/009-own-server/contracts/host-adapter.md`,
 * `specs/013-component-model/contracts/components.md` and
 * `specs/015-environments-runners/contracts/runners.md`.
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
  RUNNERS_DIR,
  type RuntimeFileName,
  runnerDir,
  runtimeFilePath,
  SECRET_RUNTIME_FILES,
  SHARED_DIRS,
  sshdDropIn,
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
  type RunnerFact,
  type RunnerFacts,
  readableRecords,
  runnerOf,
  tunnelOf,
} from "./facts";
export { hostPlanHash } from "./hash";
export { inspectHost, inspectRunners } from "./inspect";
export { localExec } from "./local";
export { isPublicAddress } from "./parse";
export {
  planHost,
  planPortainer,
  planRunner,
  planRunnerHost,
  planTeardown,
  planUndo,
} from "./plan";
export {
  type ApplyOptions,
  type ApplyResult,
  type DesiredHost,
  type DesiredRunner,
  type DesiredRunnerHost,
  type HostPlan,
  HostPlanSchema,
  type HostStep,
  type HostStepId,
} from "./types";
export { webFilterFileHashes } from "./web-filter";
