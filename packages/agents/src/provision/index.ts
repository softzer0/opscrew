// The own-server connection helpers live in `shared/own-server.ts`; they are exported here so the
// package root offers them (design's callers, drift, destroy and Portainer use them).
export {
  type ConnectOwnServerOptions,
  connectOwnServer,
  type InspectedOwnServer,
  inspectOwnServer,
  OWN_SERVER_DAMAGED_HINT,
  type OwnServerDeps,
  type OwnServerSession,
  ownServerFacts,
  ownServerKeyFile,
  ownServerLogin,
  ownServerLoginCheck,
  ownServerNotSetUp,
  ownServerPublicAddress,
  readOwnServerRecord,
  requireOwnServerKey,
} from "../shared/own-server";
export {
  type CloudflareSetup,
  checkProvider,
  type GitHubSetup,
  OWN_SERVER_CONNECT_HINT,
  setupCloudflare,
  setupGitHub,
} from "./credentials";
export { type MoveInProgress, moveInProgress, requireNoMoveInProgress } from "./guard";
export {
  applyOwnHostPlan,
  desiredHost,
  ensurePortainerPassword,
  type OwnServerRun,
  ownDeployTarget,
  ownEngineEnv,
  ownTarget,
  portainerPasswordFile,
  prepareOwnServer,
  removeOldAccessMode,
} from "./own";
export {
  describePlan,
  findSavedPlan,
  isMovesOnly,
  type PlanAndApplyOptions,
  type PlanAndApplyResult,
  planAndApply,
  REMOVAL_PLAN_SUFFIX,
} from "./plan-apply";
export { maskBySensitivity, maskSensitivePlanJson, SENSITIVE_VALUE } from "./plan-json";
export { REGISTRY_TOKEN_VAR, REPOSITORY_TOKEN_VAR, stackPlanFile } from "./portainer";
export {
  chooseDeployBranch,
  DEPLOY_SETUP_BRANCH,
  type DeployBranch,
  deploySetupPullRequestBody,
  localDeployBranch,
  type PublishPhase,
  type PublishResult,
  publishDeploySetup,
} from "./publish";
export {
  committedTfvars,
  type DeploymentPreview,
  deploymentFiles,
  deploymentRenderContext,
  type OwnRenderInput,
  ownRenderFromTfvars,
  previewDeploymentFiles,
  readRequirements,
} from "./render";
export { type PhaseFlowExtras, runPhaseFlow, runProvision } from "./run";
export {
  buildAppEnvironment,
  deploySecrets,
  deploySecretsStoredFor,
  generatedValuesFile,
  setDeploySecrets,
} from "./secrets";
export { describeStackPlan, ROUTE_CHANGE_NOTE } from "./stack-plan";
export type {
  CloudflareApi,
  GitHubApi,
  OwnServerServices,
  ProvisionOptions,
  ProvisionResult,
  ProvisionServices,
  SavedPlan,
} from "./types";
export {
  CLOUDFLARE_TUNNEL_PERMISSIONS,
  cloudflareZeroTrust,
  createZeroTrustOrganization,
  tunnelTokenPermissions,
  type ZeroTrustApi,
} from "./zero-trust";
