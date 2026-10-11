import type { Json } from "./merge";

/** Copies (or symlinks) a file from the module directory into the Claude dir. */
export interface FileStep {
  type: "file";
  /** Path relative to the module directory. */
  src: string;
  /** Path relative to the Claude dir. */
  dest: string;
  mode?: "copy" | "symlink";
  /**
   * Keep managed blocks (`<!-- BEGIN name -->`...`<!-- END name -->` or `<!-- name -->`...
   * `<!-- /name -->`) that installers added to the destination: they are appended to the
   * copied content, so re-applying is idempotent. Copy mode only.
   */
  preserveBlocks?: boolean;
}

/** Deep-merges a JSON file from the module directory into a JSON file in the Claude dir. */
export interface JsonMergeStep {
  type: "json-merge";
  src: string;
  dest: string;
}

/** Operating systems a command step can be limited to (`process.platform` values). */
export const STEP_OS = ["darwin", "linux", "win32"] as const;
export type StepOs = (typeof STEP_OS)[number];

/**
 * Runs an argv (`run`, no shell) or a bash script (`shell`, run as `bash -o pipefail -c`).
 * Stdin is closed, so installers never prompt, unless `interactive` is set and the caller
 * runs with a terminal. Skipped when `check`/`checkShell` exits 0, `requiresBin` is missing,
 * the OS is not in `os`, or `globalOnly` is set and the target is not `~/.claude`.
 *
 * Every command gets `CCC_CLAUDE_DIR` (the target Claude dir) and `CCC_CLAUDE_JSON` (its
 * `.claude.json`) in its environment. `env` values expand `${CCC_SECRET_*}`,
 * `${CCC_CLAUDE_DIR}`, `${CCC_CLAUDE_JSON}`, `~/`, `$HOME`, `${HOME}` and
 * `${NAME:-default}` (from the caller's environment).
 */
export interface CommandStep {
  type: "command";
  /** Exactly one of `run` and `shell`. */
  run?: string[];
  shell?: string;
  /** At most one of `check` (argv) and `checkShell` (bash script). */
  check?: string[];
  checkShell?: string;
  requiresBin?: string;
  os?: StepOs[];
  env?: Record<string, string>;
  /** Let the step use the terminal when the caller is interactive (TUI). */
  interactive?: boolean;
  /** The tool always writes to `~/.claude`: skip the step for any other target dir. */
  globalOnly?: boolean;
}

export type Step = FileStep | JsonMergeStep | CommandStep;

/** A value a module needs at apply time, referenced as `${NAME}` in its assets and args. */
export interface ModuleSecret {
  /** Environment variable name, `CCC_SECRET_*`. */
  name: string;
  description: string;
}

/**
 * What a module owns in the Claude config. `ccc capture` leaves these out, so captured
 * personal modules never duplicate what an installer module sets up.
 */
/**
 * Items of a settings.json array that a module adds (e.g. permission rules): capture drops
 * only those items from the array, never the whole key. At least one of `items` and `match`.
 */
export interface ProvidedSettingItems {
  /** JSON pointer of the array, e.g. `/permissions/allow`. */
  pointer: string;
  /** Exact item values. */
  items?: string[];
  /** Wildcard patterns where `*` matches any characters, e.g. `mcp__codegraph__*`. */
  match?: string[];
}

export interface ModuleProvides {
  /** Globs relative to the Claude dir (`*`, `**`, `?`); a match also covers everything below it. */
  paths?: string[];
  /** JSON pointers in settings.json (the whole value), or array items under a pointer. */
  settings?: (string | ProvidedSettingItems)[];
  /** Substrings of settings.json hook commands. */
  hooks?: string[];
  /** Managed CLAUDE.md block names (globs allowed, e.g. `gentle-ai:*`). */
  claudeMdBlocks?: string[];
  /** User-scope MCP server names in `.claude.json`. */
  mcpServers?: string[];
}

export interface Module {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  requires?: string[];
  /** Secrets substituted into json-merge sources, text files and command args. */
  secrets?: ModuleSecret[];
  provides?: ModuleProvides;
  steps: Step[];
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  /** Display order: lower first; profiles without one come last; ties sort by id. */
  order?: number;
  modules: string[];
}

export interface CatalogModule extends Module {
  /** Absolute path of the module directory. */
  dir: string;
}

export interface Catalog {
  dir: string;
  modules: CatalogModule[];
  profiles: Profile[];
}

export interface Selection {
  profile?: string;
  modules?: string[];
}

export type PlanAction = "create" | "update" | "unchanged" | "run" | "skip";

export interface PlannedStep {
  index: number;
  type: Step["type"];
  action: PlanAction;
  /** Why this action was chosen. */
  reason: string;
  /** Short human-readable change summary. */
  summary: string;
  /** Destination relative to the Claude dir (file and json-merge steps). */
  dest?: string;
  /** Command argv (command steps). */
  command?: string[];
  /** True when the step cannot be applied (e.g. existing file is invalid JSON). */
  blocked?: boolean;
  /** Set when the step is blocked only because this secret has no value. */
  needsSecret?: string;
  step: Step;
}

export interface PlannedModule {
  id: string;
  name: string;
  description: string;
  dir: string;
  /** Ids of the modules this one requires (they come earlier in the plan). */
  requires: string[];
  steps: PlannedStep[];
}

/** How a json-merge conflict is settled: take the catalog value or keep the current one. */
export type Resolution = "catalog" | "keep";

/** Default policy for conflicts without an explicit resolution. */
export type ConflictPolicy = "ask" | Resolution;

/** Explicit decisions keyed `<module>:<JSON pointer>`. */
export type Resolutions = Record<string, Resolution>;

/** A value in an existing JSON file that a json-merge step would overwrite. */
export interface Conflict {
  module: string;
  /** Step index inside the module. */
  step: number;
  dest: string;
  /** JSON pointer inside `dest`. */
  path: string;
  current: Json;
  catalog: Json;
  /** Set when a resolution or a non-"ask" policy decides this conflict. */
  resolution?: Resolution;
}

export interface Plan {
  claudeDir: string;
  modules: PlannedModule[];
  /** Every json-merge conflict, in plan order. */
  conflicts: Conflict[];
  /** Decisions used to plan; apply re-evaluates with the same ones. */
  resolutions?: Resolutions;
  onConflict?: ConflictPolicy;
  /** Secret values used to plan (non-enumerable: never serialized). */
  readonly secretValues?: Record<string, string>;
  /** Platform used for `os` filters; apply re-evaluates with the same one. */
  platform?: string;
}

export type StepStatus = "done" | "unchanged" | "skipped" | "failed" | "planned";

export interface StepResult {
  index: number;
  type: Step["type"];
  action: PlanAction;
  status: StepStatus;
  message: string;
  dest?: string;
  command?: string[];
  /** Backup path when an existing file was replaced. */
  backup?: string;
}

export interface ModuleResult {
  id: string;
  name: string;
  ok: boolean;
  steps: StepResult[];
}

export interface ApplyResult {
  claudeDir: string;
  dryRun: boolean;
  ok: boolean;
  backupDir: string | null;
  modules: ModuleResult[];
}

export type ModuleState =
  | "applied"
  | "partial"
  | "not-applied"
  /** Nothing pending except undecided json-merge conflicts. */
  | "conflicts"
  /** Declares secrets that were not provided, so the module cannot be evaluated. */
  | "needs-secrets";

export interface ModuleStatus {
  id: string;
  name: string;
  state: ModuleState;
  satisfied: number;
  pending: number;
  skipped: number;
  /** json-merge steps whose only differences are undecided conflicts. */
  conflicts: number;
  /** Declared secrets without a value. */
  missingSecrets: string[];
}

export interface StatusReport {
  claudeDir: string;
  modules: ModuleStatus[];
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  /** Whether a failure blocks applying the catalog. */
  required: boolean;
  message: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}
