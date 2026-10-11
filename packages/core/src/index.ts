export { loadCatalog, resolveSelection } from "./catalog";
export type { DoctorOptions } from "./doctor";
export { doctor, MIN_NODE_MAJOR } from "./doctor";
export type { ApplyOptions, ApplyRun, PlanOptions, StatusOptions } from "./engine";
export {
  apply,
  BACKUP_DIR_NAME,
  conflictKey,
  plan,
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
export type * from "./types";
