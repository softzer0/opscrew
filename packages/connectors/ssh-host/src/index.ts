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
 * privilege), and with it the network's filter, which lets only the app's servers and the granted
 * devices reach what Docker publishes on the private address; `readWireGuard` reads the
 * network's peers and `readNetworkFilter` its filter. `planPublicSsh` closes or opens public SSH
 * on such a server, and `planGrant` gives a device its own login to one of the app's databases.
 * Self-hosted monitoring (feature 020): `planAddon("monitoring")` runs the stack (Prometheus, Loki,
 * Grafana and its front) as root on any server, Grafana's password in a root-only file; `alloy`
 * runs on any server of the app with its destinations; and `planGrant`'s `monitor` access makes
 * the Postgres login `opscrew_monitor` (`MONITOR_LOGIN`) that Alloy reads Postgres's figures with.
 * `planNetworkRemoval` takes one network's interface off a server, such as the monitoring server
 * another environment owns once this one stops sending to it.
 * Preview environments (feature 022): `planAddon("previews")` installs a preview environment's
 * recipe in `/srv/apps/<app>`, its values (supplied at apply as `previewValues`), the preview key
 * (`previewKeyLine`, which can run only the recipe's `opscrew-preview`) and the deploy user's cron
 * line for idle previews, in a plan that deletes data; `inspectHost` lists each recipe's previews.
 * See `specs/009-own-server/contracts/host-adapter.md`,
 * `specs/013-component-model/contracts/components.md`,
 * `specs/015-environments-runners/contracts/runners.md`,
 * `specs/017-observability/contracts/observability.md`,
 * `specs/018-split-placement/contracts/split-placement.md` and
 * `specs/020-self-hosted-monitoring/contracts/monitoring.md`.
 */

export { applyHostPlan, HostApplyError } from "./apply";
export {
  ADDON_PROJECTS,
  type AddonKind,
  ALLOY_DESTINATIONS_FILE,
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
  previewKeyLine,
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
export { type GrantParams, GrantParamsSchema, MONITOR_LOGIN } from "./grant";
export { hostPlanHash } from "./hash";
export { inspectHost, inspectRunners, probePrivilege, readGrant } from "./inspect";
export { localExec } from "./local";
export { type NetworkStepParams, NetworkStepParamsSchema } from "./network";
export { networkFileHashes, networkFilterFileHashes, networkUfwRules } from "./network-files";
export {
  type NetworkFilterParams,
  NetworkFilterParamsSchema,
  type NetworkFilterRule,
  readNetworkFilter,
} from "./network-filter";
export { canonicalSshSource, isPublicAddress } from "./parse";
export {
  type AddonConnector,
  type AddonEnable,
  type AddonPlanKind,
  planAddon,
  planGrant,
  planHost,
  planNetwork,
  planNetworkRemoval,
  planPortainer,
  planPublicSsh,
  planRunner,
  planRunnerHost,
  planTeardown,
  planUndo,
} from "./plan";
export type { HostPrivilege } from "./privilege";
export { type PublicSshParams, PublicSshParamsSchema } from "./public-ssh";
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
