/** Copies (or symlinks) a file from the module directory into the Claude dir. */
export interface FileStep {
  type: "file";
  /** Path relative to the module directory. */
  src: string;
  /** Path relative to the Claude dir. */
  dest: string;
  mode?: "copy" | "symlink";
}

/** Deep-merges a JSON file from the module directory into a JSON file in the Claude dir. */
export interface JsonMergeStep {
  type: "json-merge";
  src: string;
  dest: string;
}

/** Runs an argv (no shell). Skipped when `check` exits 0 or `requiresBin` is missing. */
export interface CommandStep {
  type: "command";
  run: string[];
  check?: string[];
  requiresBin?: string;
}

export type Step = FileStep | JsonMergeStep | CommandStep;

export interface Module {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  requires?: string[];
  steps: Step[];
}

export interface Profile {
  id: string;
  name: string;
  description: string;
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

export interface Plan {
  claudeDir: string;
  modules: PlannedModule[];
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

export type ModuleState = "applied" | "partial" | "not-applied";

export interface ModuleStatus {
  id: string;
  name: string;
  state: ModuleState;
  satisfied: number;
  pending: number;
  skipped: number;
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
