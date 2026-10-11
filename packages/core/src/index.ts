export type {
  CapturedFile,
  CaptureItem,
  CaptureKind,
  CaptureLimits,
  CaptureOptions,
  CaptureResult,
  CaptureSkip,
  CaptureWriteResult,
  WriteAction,
  WriteCaptureOptions,
} from "./capture";
export {
  CAPTURE_KINDS,
  captureClaudeConfig,
  DEFAULT_CAPTURE_LIMITS,
  defaultClaudeJson,
  MAX_WALK_DEPTH,
  PERSONAL_PROFILE_ID,
  writeCapture,
} from "./capture";
export { loadCatalog, resolveSelection } from "./catalog";
export type { DoctorOptions } from "./doctor";
export { compareVersions, doctor, MIN_NODE_VERSION } from "./doctor";
export type { ApplyOptions, ApplyRun, PlanOptions, StatusOptions } from "./engine";
export {
  apply,
  BACKUP_DIR_NAME,
  conflictKey,
  plan,
  requiredSecrets,
  startApply,
  status,
  unresolvedConflicts,
} from "./engine";
export type { CatalogErrorCode } from "./errors";
export { CatalogError } from "./errors";
export { runArgv, which } from "./exec";
export type { BackupStore } from "./fsutil";
export { createBackupStore, writeFileAtomic } from "./fsutil";
export type { Json, MergeConflict } from "./merge";
export { changedPaths, deepMerge, findConflicts, pointerJoin } from "./merge";
export { resolveClaudeDir, resolveDest, resolveInside } from "./paths";
export type { Redaction, SecretSpec } from "./secrets";
export {
  findSecrets,
  isSecretKey,
  MissingSecretError,
  maskJson,
  maskValues,
  SECRET_KEY,
  substitute,
} from "./secrets";
export type * from "./types";
