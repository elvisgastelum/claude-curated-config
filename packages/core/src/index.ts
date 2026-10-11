export type { ManagedBlock } from "./blocks";
export { findManagedBlocks, stripManagedBlocks, withPreservedBlocks } from "./blocks";
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
  CAPTURE_IGNORE,
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
  CHECK_TIMEOUT_MS,
  commandDisplay,
  conflictKey,
  plan,
  RUN_TIMEOUT_MS,
  requiredSecrets,
  startApply,
  status,
  unresolvedConflicts,
} from "./engine";
export type { CatalogErrorCode } from "./errors";
export { CatalogError } from "./errors";
export type { RunOptions } from "./exec";
export { runArgv, which } from "./exec";
export type { BackupStore } from "./fsutil";
export { createBackupStore, writeFileAtomic } from "./fsutil";
export type { Json, MergeConflict } from "./merge";
export { changedPaths, deepMerge, findConflicts, pointerJoin } from "./merge";
export { claudeJsonFor, resolveClaudeDir, resolveDest, resolveInside } from "./paths";
export type { ProvidedEntry, ProvidedIndex } from "./provides";
export { collectProvided, PROVIDES_KINDS } from "./provides";
export type { Redaction, RedactorOptions, SecretSpec } from "./secrets";
export {
  DEFAULT_PRIVATE_DOMAINS,
  findPrivate,
  findSecrets,
  isSecretKey,
  isSecretName,
  MissingSecretError,
  maskJson,
  maskValues,
  privateDomainsFromEnv,
  SECRET_KEY,
  substitute,
} from "./secrets";
export type * from "./types";
export { STEP_OS } from "./types";
