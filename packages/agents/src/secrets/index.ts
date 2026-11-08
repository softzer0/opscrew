// `opscrew rotate recovery-key` (025) took over the key's rotation; the CLI's `opscrew secrets
// rotate` imports it from here until T2515 removes that command.
export { publishRotatedKey, type RotatedKeyResult } from "../rotate/addons";
export {
  type RecoveryStatus,
  type RefreshRecoveryOptions,
  type RefreshRecoveryResult,
  recoveryStatus,
  recoveryStatusLines,
  refreshRecoveryCopy,
  rotateRecoveryKey,
} from "./copy";
export { COPY_PATH, copyPath } from "./files";
export { type RestoreResult, restoreConflictText, restoreRecoveryCopy } from "./restore";
export { type KeyHandover, keyHandoverNote, SOPS_CONFIG_PATH, setRecoveryFolder } from "./store";
