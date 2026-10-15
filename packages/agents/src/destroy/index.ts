export {
  assertModulePrefix,
  type DeletionBounds,
  type DeletionPlanProblems,
  dataWarning,
  deletesServer,
  deletesUnconfirmedServer,
  deletionPlanIsBounded,
  deletionPlanProblems,
  describeChanges,
  removeHostKeys,
  serverIdsInPlan,
  unprotectPlanProblems,
} from "./checks";
export {
  applyApprovedPlan,
  assertDeletionPlan,
  confirmDeletion,
  type DeletionPreview,
  type DeletionScope,
  type DeletionSession,
  discardPlan,
  forgetHostKeys,
  infraDeclaresVariable,
  type LiftProtectionInput,
  liftProtection,
  previewDeletion,
  remainingAfterDeletion,
  removeSnapshotRecord,
  type SnapshotBeforeDeleteInput,
  type SnapshotPurpose,
  savePlan,
  snapshotKeptNote,
  snapshotRecordPath,
  snapshotWanted,
  takeSnapshotBeforeDelete,
} from "./deletion";
export { savedHostPlanPurpose } from "./own";
export { runDestroy } from "./run";
export { type DestroyTexts, destroyConfirmPrompt, destroyTexts } from "./texts";
export type {
  DestroyCloudflareApi,
  DestroyGitHubApi,
  DestroyOptions,
  DestroyPreview,
  DestroyResult,
  DestroyServices,
} from "./types";
