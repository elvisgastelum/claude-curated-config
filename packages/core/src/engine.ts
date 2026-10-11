import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveSelection } from "./catalog";
import { runArgv, which } from "./exec";
import {
  type BackupStore,
  createBackupStore,
  isLink,
  occupied,
  symlinkAtomic,
  writeFileAtomic,
} from "./fsutil";
import { changedPaths, deepMerge, findConflicts } from "./merge";
import { resolveDest, resolveInside } from "./paths";
import type {
  ApplyResult,
  Catalog,
  CatalogModule,
  Conflict,
  ConflictPolicy,
  ModuleResult,
  ModuleStatus,
  Plan,
  PlanAction,
  PlannedModule,
  PlannedStep,
  Resolution,
  Resolutions,
  Selection,
  StatusReport,
  Step,
  StepResult,
} from "./types";

export { BACKUP_DIR_NAME } from "./fsutil";

interface Evaluation {
  action: PlanAction;
  reason: string;
  summary: string;
  blocked?: boolean;
  destPath?: string;
  /** Where content is written when it differs from `destPath` (a json-merge through a symlink). */
  writePath?: string;
  /** Content to write for copy and json-merge steps. */
  content?: Buffer;
  /** Absolute symlink target for symlink steps. */
  linkTarget?: string;
  /** json-merge values this step would overwrite (with their resolution when decided). */
  conflicts?: Omit<Conflict, "module" | "step" | "dest">[];
}

/** Decides a conflict of `module` at a JSON pointer; undefined means "ask". */
type Decide = (module: string, path: string) => Resolution | undefined;

export function conflictKey(module: string, path: string): string {
  return `${module}:${path}`;
}

function decider(resolutions: Resolutions = {}, onConflict: ConflictPolicy = "ask"): Decide {
  return (module, path) =>
    resolutions[conflictKey(module, path)] ?? (onConflict === "ask" ? undefined : onConflict);
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
}

function lineDiff(before: string, after: string): string {
  const oldLines = new Set(before.split("\n"));
  const newLines = new Set(after.split("\n"));
  const added = [...newLines].filter((line) => !oldLines.has(line)).length;
  const removed = [...oldLines].filter((line) => !newLines.has(line)).length;
  return `+${added} -${removed} lines`;
}

function describePaths(paths: string[]): string {
  const shown = paths.slice(0, 4).join(", ");
  return paths.length > 4 ? `${shown}, +${paths.length - 4} more` : shown;
}

function evaluateFile(
  step: Extract<Step, { type: "file" }>,
  mod: CatalogModule,
  claudeDir: string,
): Evaluation {
  const srcPath = resolveInside(mod.dir, step.src, "src");
  const destPath = resolveDest(claudeDir, step.dest);
  // lstat: a dangling symlink is "there" (and replaceable) even though existsSync says no.
  const stat = occupied(destPath) ? lstatSync(destPath) : null;
  if (stat?.isDirectory()) {
    return {
      action: "skip",
      reason: `${step.dest} is a directory`,
      summary: "blocked",
      blocked: true,
      destPath,
    };
  }
  if (step.mode === "symlink") {
    const linkTarget = resolve(srcPath);
    if (stat?.isSymbolicLink() && readlinkSync(destPath) === linkTarget) {
      return { action: "unchanged", reason: "symlink already in place", summary: "", destPath };
    }
    return {
      action: stat ? "update" : "create",
      reason: stat ? "replace with symlink" : "new symlink",
      summary: `-> ${linkTarget}`,
      destPath,
      linkTarget,
    };
  }
  const content = readFileSync(srcPath);
  if (!stat) {
    return {
      action: "create",
      reason: "file does not exist",
      summary: `new file (${lineCount(content.toString("utf8"))} lines)`,
      destPath,
      content,
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      action: "update",
      reason: existsSync(destPath) ? "replace symlink with file" : "replace dangling symlink",
      summary: `replace symlink -> ${readlinkSync(destPath)}`,
      destPath,
      content,
    };
  }
  const current = readFileSync(destPath);
  if (current.equals(content)) {
    return { action: "unchanged", reason: "identical content", summary: "", destPath };
  }
  return {
    action: "update",
    reason: "content differs",
    summary: lineDiff(current.toString("utf8"), content.toString("utf8")),
    destPath,
    content,
  };
}

function evaluateJsonMerge(
  step: Extract<Step, { type: "json-merge" }>,
  mod: CatalogModule,
  claudeDir: string,
  decide: Decide,
): Evaluation {
  const src = JSON.parse(readFileSync(resolveInside(mod.dir, step.src, "src"), "utf8"));
  const destPath = resolveDest(claudeDir, step.dest);
  const link = isLink(destPath);
  const exists = existsSync(destPath);
  if (exists && lstatSync(destPath).isDirectory()) {
    return {
      action: "skip",
      reason: `${step.dest} is a directory`,
      summary: "blocked",
      blocked: true,
      destPath,
    };
  }
  // A live symlink (e.g. into a dotfiles repo) is merged through; a dangling one is replaced.
  const writePath = link && exists ? realpathSync(destPath) : destPath;
  let existing: unknown = {};
  if (exists) {
    try {
      existing = JSON.parse(readFileSync(destPath, "utf8"));
    } catch {
      return {
        action: "skip",
        reason: `${step.dest} is not valid JSON; fix or remove it first`,
        summary: "blocked",
        blocked: true,
        destPath,
      };
    }
  }
  const conflicts: NonNullable<Evaluation["conflicts"]> = (
    exists ? findConflicts(existing, src) : []
  ).map((conflict) => {
    const resolution = decide(mod.id, conflict.path);
    return resolution ? { ...conflict, resolution } : conflict;
  });
  const keep = new Set(conflicts.filter((c) => c.resolution === "keep").map((c) => c.path));
  const merged = deepMerge(existing, src, keep);
  const content = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`);
  if (link && !exists) {
    return {
      action: "update",
      reason: "replace dangling symlink",
      summary: `replace symlink -> ${readlinkSync(destPath)}`,
      destPath,
      content,
    };
  }
  const changes = changedPaths(exists ? existing : undefined, merged);
  if (exists && changes.length === 0) {
    return { action: "unchanged", reason: "all keys already present", summary: "", destPath };
  }
  const open = conflicts.filter((c) => !c.resolution).length;
  return {
    action: exists ? "update" : "create",
    reason: exists ? "merge new keys" : "file does not exist",
    summary: exists
      ? `merges ${describePaths(changes)}${open ? ` (${open} conflict${open > 1 ? "s" : ""} to resolve)` : ""}`
      : "new JSON file",
    destPath,
    writePath,
    content,
    ...(conflicts.length ? { conflicts } : {}),
  };
}

function evaluateCommand(
  step: Extract<Step, { type: "command" }>,
  env: NodeJS.ProcessEnv,
): Evaluation {
  const summary = step.run.join(" ");
  if (step.requiresBin && !which(step.requiresBin, env)) {
    return { action: "skip", reason: `"${step.requiresBin}" not found on PATH`, summary };
  }
  if (step.check) {
    const check = runArgv(step.check, env);
    if (check.code === 0) return { action: "unchanged", reason: "check passed", summary };
    return { action: "run", reason: "check failed", summary };
  }
  return { action: "run", reason: "no check defined", summary };
}

function evaluate(
  step: Step,
  mod: CatalogModule,
  claudeDir: string,
  env: NodeJS.ProcessEnv,
  decide: Decide,
): Evaluation {
  try {
    switch (step.type) {
      case "file":
        return evaluateFile(step, mod, claudeDir);
      case "json-merge":
        return evaluateJsonMerge(step, mod, claudeDir, decide);
      case "command":
        return evaluateCommand(step, env);
    }
  } catch (error) {
    // One unreadable file must not abort the whole plan: the step is reported as blocked.
    return {
      action: "skip",
      reason: (error as Error).message,
      summary: "blocked",
      blocked: true,
    };
  }
}

function planModule(
  mod: CatalogModule,
  claudeDir: string,
  env: NodeJS.ProcessEnv,
  decide: Decide,
  conflicts: Conflict[] = [],
): PlannedModule {
  return {
    id: mod.id,
    name: mod.name,
    description: mod.description,
    dir: mod.dir,
    requires: mod.requires ?? [],
    steps: mod.steps.map((step, index) => {
      const evaluation = evaluate(step, mod, claudeDir, env, decide);
      for (const conflict of evaluation.conflicts ?? []) {
        conflicts.push({
          module: mod.id,
          step: index,
          dest: (step as { dest: string }).dest,
          ...conflict,
        });
      }
      const planned: PlannedStep = {
        index,
        type: step.type,
        action: evaluation.action,
        reason: evaluation.reason,
        summary: evaluation.summary,
        step,
      };
      if (step.type === "command") planned.command = step.run;
      else planned.dest = step.dest;
      if (evaluation.blocked) planned.blocked = true;
      return planned;
    }),
  };
}

export interface PlanOptions extends Selection {
  catalog: Catalog;
  claudeDir: string;
  env?: NodeJS.ProcessEnv;
  /** Explicit conflict decisions keyed `<module>:<JSON pointer>`. */
  resolutions?: Resolutions;
  /** Policy for conflicts without an explicit decision (default "ask": leave unresolved). */
  onConflict?: ConflictPolicy;
}

/** Computes what applying the selection would do, without changing anything. */
export function plan(options: PlanOptions): Plan {
  const claudeDir = resolve(options.claudeDir);
  const env = options.env ?? process.env;
  const { resolutions = {}, onConflict = "ask" } = options;
  const decide = decider(resolutions, onConflict);
  const conflicts: Conflict[] = [];
  const modules = resolveSelection(options.catalog, options).map((mod) =>
    planModule(mod, claudeDir, env, decide, conflicts),
  );
  return { claudeDir, modules, conflicts, resolutions, onConflict };
}

/** Conflicts that still need a decision before the plan can be applied. */
export function unresolvedConflicts(planned: Plan): Conflict[] {
  return planned.conflicts.filter((conflict) => !conflict.resolution);
}

export interface ApplyOptions {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  onModuleStart?: (mod: PlannedModule) => void;
  onModuleEnd?: (result: ModuleResult) => void;
}

export interface ApplyRun {
  /** Applies one planned module (in plan order) and returns its result. */
  module(mod: PlannedModule): ModuleResult;
  /** The full report of every module applied so far. */
  finish(): ApplyResult;
}

/**
 * Starts an apply run that executes a plan one module at a time (the TUI renders between
 * modules). Steps are re-evaluated against the current disk state, so applying a stale plan
 * never clobbers changes made in between. Existing files that would be replaced are copied
 * to `<claudeDir>/.ccc-backups/<timestamp>/<dest>` first; every write is atomic.
 *
 * A failing step never aborts the run: it is recorded as `failed`, the remaining steps of its
 * module and every module that requires it are `skipped`, and other modules continue.
 */
export function startApply(planToApply: Plan, options: ApplyOptions = {}): ApplyRun {
  const { claudeDir } = planToApply;
  const env = options.env ?? process.env;
  const dryRun = options.dryRun ?? false;
  const backups: BackupStore = createBackupStore(claudeDir, (options.now ?? (() => new Date()))());
  const decide = decider(planToApply.resolutions, planToApply.onConflict);
  const failedModules = new Set<string>();
  const results: ModuleResult[] = [];

  const runStep = (planned: PlannedStep, mod: PlannedModule): StepResult => {
    const base = {
      index: planned.index,
      type: planned.type,
      dest: planned.dest,
      command: planned.command,
    };
    const catalogModule: CatalogModule = { ...mod, steps: [] };
    const evaluation = evaluate(planned.step, catalogModule, claudeDir, env, decide);
    const result = (status: StepResult["status"], message: string): StepResult => ({
      ...base,
      action: evaluation.action,
      status,
      message,
    });
    if (evaluation.action === "skip") {
      return result(evaluation.blocked ? "failed" : "skipped", evaluation.reason);
    }
    if (evaluation.action === "unchanged") return result("unchanged", evaluation.reason);
    const open = (evaluation.conflicts ?? []).filter((c) => !c.resolution).map((c) => c.path);
    if (open.length > 0) {
      return result("failed", `unresolved conflicts in ${planned.dest}: ${open.join(", ")}`);
    }
    if (dryRun) return result("planned", evaluation.summary || evaluation.reason);
    try {
      if (evaluation.action === "run") {
        const step = planned.step as Extract<Step, { type: "command" }>;
        const run = runArgv(step.run, env);
        if (run.code === 0) return result("done", `ran ${step.run.join(" ")}`);
        const output = (run.stderr || run.stdout).trim().split("\n").slice(-5).join("\n");
        return result("failed", `exit ${run.code}: ${output}`);
      }
      const destPath = evaluation.destPath as string;
      const writePath = evaluation.writePath ?? destPath;
      let backupPath: string | undefined;
      if (evaluation.action === "update" && occupied(writePath)) {
        backupPath = backups.save(writePath, planned.dest as string);
      }
      if (evaluation.linkTarget) symlinkAtomic(evaluation.linkTarget, destPath);
      else writeFileAtomic(writePath, evaluation.content as Buffer);
      const done = result("done", evaluation.summary || evaluation.reason);
      if (backupPath) done.backup = backupPath;
      return done;
    } catch (error) {
      return result("failed", (error as Error).message);
    }
  };

  const skippedStep = (planned: PlannedStep, message: string): StepResult => ({
    index: planned.index,
    type: planned.type,
    action: planned.action,
    status: "skipped",
    message,
    dest: planned.dest,
    command: planned.command,
  });

  return {
    module(mod) {
      options.onModuleStart?.(mod);
      const failedDep = mod.requires.find((id) => failedModules.has(id));
      let abort = failedDep ? `requires failed module "${failedDep}"` : null;
      const steps: StepResult[] = [];
      for (const planned of mod.steps) {
        if (abort) {
          steps.push(skippedStep(planned, abort));
          continue;
        }
        const stepResult = runStep(planned, mod);
        steps.push(stepResult);
        if (stepResult.status === "failed") abort = `an earlier step of "${mod.id}" failed`;
      }
      const ok = !failedDep && steps.every((s) => s.status !== "failed");
      if (!ok) failedModules.add(mod.id);
      const moduleResult: ModuleResult = { id: mod.id, name: mod.name, ok, steps };
      results.push(moduleResult);
      options.onModuleEnd?.(moduleResult);
      return moduleResult;
    },
    finish() {
      return {
        claudeDir,
        dryRun,
        ok: results.every((m) => m.ok),
        backupDir: backups.dir,
        modules: [...results],
      };
    },
  };
}

/** Executes a whole plan; see {@link startApply}. Always returns the full report. */
export function apply(planToApply: Plan, options: ApplyOptions = {}): ApplyResult {
  const run = startApply(planToApply, options);
  for (const mod of planToApply.modules) run.module(mod);
  return run.finish();
}

export interface StatusOptions {
  catalog: Catalog;
  claudeDir: string;
  env?: NodeJS.ProcessEnv;
}

/** Reports, for every catalog module, whether its steps are already satisfied. */
export function status(options: StatusOptions): StatusReport {
  const claudeDir = resolve(options.claudeDir);
  const env = options.env ?? process.env;
  const modules: ModuleStatus[] = options.catalog.modules.map((mod) => {
    const planned = planModule(mod, claudeDir, env, decider());
    const count = (pred: (s: PlannedStep) => boolean) => planned.steps.filter(pred).length;
    const satisfied = count((s) => s.action === "unchanged");
    const skipped = count((s) => s.action === "skip" && !s.blocked);
    const pending = planned.steps.length - satisfied - skipped;
    const state = pending === 0 ? "applied" : satisfied > 0 ? "partial" : "not-applied";
    return { id: mod.id, name: mod.name, state, satisfied, pending, skipped };
  });
  return { claudeDir, modules };
}
