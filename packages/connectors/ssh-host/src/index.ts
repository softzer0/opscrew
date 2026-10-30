/**
 * @opscrew/connector-ssh-host: the typed host adapter for servers the user already owns
 * (feature 009). Read-only inspection, host plans of fixed steps, and an apply bound to the
 * plan's SHA-256 hash, with SSH and firewall changes under a dead-man switch on the server.
 * Several OpsCrew apps share a server (feature 013): each has its own record, folders, deploy key
 * and Cloudflare Tunnel connector, and the shared edge goes with the last one. An app's GitHub
 * Actions runner (feature 015) is deploy's systemd user service there and, through `planRunner`
 * as the deploy user, on the servers OpsCrew creates. A runner machine (a machine of the user's
 * that only runs the environments' runners) has a host plan of its own, `planRunnerHost`, hardened
 * only when asked (SSH hardening, and OpsCrew's own nftables table for port 22), and is taken back
 * with `planUndo`. No plan replaces or removes another repository's runner.
 * `planAddon` (feature 017) adds the scheduled check's key, which can run only `df`, and runs the
 * Beszel and Grafana Alloy add-ons as the deploy user, one of each per server.
 * `planNetwork` (feature 018) joins a server to the app's private WireGuard network, also on the
 * servers OpsCrew creates, where the deploy user becomes root through Docker (the `docker`
 * privilege); `readWireGuard` reads the network's peers.
 * See `specs/009-own-server/contracts/host-adapter.md`,
 * `specs/013-component-model/contracts/components.md`,
 * `specs/015-environments-runners/contracts/runners.md`,
 * `specs/017-observability/contracts/observability.md` and
 * `specs/018-split-placement/contracts/split-placement.md`.
 */

export { applyHostPlan, HostApplyError } from "./apply";
export {
  ADDON_PROJECTS,
  type AddonKind,
  addonDir,
  appDirs,
  checkKeyComment,
  checkKeyLine,
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
export { inspectHost, inspectRunners, probePrivilege } from "./inspect";
export { localExec } from "./local";
export { type NetworkStepParams, NetworkStepParamsSchema } from "./network";
export { canonicalSshSource, isPublicAddress } from "./parse";
export {
  type AddonConnector,
  type AddonEnable,
  type AddonPlanKind,
  planAddon,
  planHost,
  planNetwork,
  planPortainer,
  planRunner,
  planRunnerHost,
  planTeardown,
  planUndo,
} from "./plan";
export type { HostPrivilege } from "./privilege";
export {
  type ApplyOptions,
  type ApplyResult,
  type ApplySecrets,
  type DesiredHost,
  type DesiredRunner,
  type DesiredRunnerHost,
  type HostPlan,
  HostPlanSchema,
  type HostStep,
  type HostStepId,
  MAX_SSH_SOURCES,
} from "./types";
export { webFilterFileHashes } from "./web-filter";
export { readWireGuard, type WireGuardPeer } from "./wireguard";
