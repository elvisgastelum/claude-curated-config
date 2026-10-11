import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveSelection } from "./catalog";
import { runArgv, which } from "./exec";
import { changedPaths, deepMerge } from "./merge";
import { resolveDest, resolveInside } from "./paths";
import type {
  ApplyResult,
  Catalog,
  CatalogModule,
  ModuleResult,
  ModuleStatus,
  Plan,
  PlanAction,
  PlannedModule,
  PlannedStep,
  Selection,
  StatusReport,
  Step,
  StepResult,
} from "./types";

export const BACKUP_DIR_NAME = ".ccc-backups";

interface Evaluation {
  action: PlanAction;
  reason: string;
  summary: string;
  blocked?: boolean;
  destPath?: string;
  /** Content to write for copy and json-merge steps. */
  content?: Buffer;
  /** Absolute symlink target for symlink steps. */
  linkTarget?: string;
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
  const stat = existsSync(destPath) || isLink(destPath) ? lstatSync(destPath) : null;
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
  const current = readFileSync(destPath);
  if (!stat.isSymbolicLink() && current.equals(content)) {
    return { action: "unchanged", reason: "identical content", summary: "", destPath };
  }
  return {
    action: "update",
    reason: stat.isSymbolicLink() ? "replace symlink with file" : "content differs",
    summary: lineDiff(current.toString("utf8"), content.toString("utf8")),
    destPath,
    content,
  };
}

function evaluateJsonMerge(
  step: Extract<Step, { type: "json-merge" }>,
  mod: CatalogModule,
  claudeDir: string,
): Evaluation {
  const src = JSON.parse(readFileSync(resolveInside(mod.dir, step.src, "src"), "utf8"));
  const destPath = resolveDest(claudeDir, step.dest);
  const exists = existsSync(destPath);
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
  const merged = deepMerge(existing, src);
  const changes = changedPaths(exists ? existing : undefined, merged);
  if (exists && changes.length === 0) {
    return { action: "unchanged", reason: "all keys already present", summary: "", destPath };
  }
  return {
    action: exists ? "update" : "create",
    reason: exists ? "merge new keys" : "file does not exist",
    summary: exists ? `merges ${describePaths(changes)}` : "new JSON file",
    destPath,
    content: Buffer.from(`${JSON.stringify(merged, null, 2)}\n`),
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
): Evaluation {
  switch (step.type) {
    case "file":
      return evaluateFile(step, mod, claudeDir);
    case "json-merge":
      return evaluateJsonMerge(step, mod, claudeDir);
    case "command":
      return evaluateCommand(step, env);
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function planModule(mod: CatalogModule, claudeDir: string, env: NodeJS.ProcessEnv): PlannedModule {
  return {
    id: mod.id,
    name: mod.name,
    description: mod.description,
    dir: mod.dir,
    steps: mod.steps.map((step, index) => {
      const evaluation = evaluate(step, mod, claudeDir, env);
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
}

/** Computes what applying the selection would do, without changing anything. */
export function plan(options: PlanOptions): Plan {
  const claudeDir = resolve(options.claudeDir);
  const env = options.env ?? process.env;
  const modules = resolveSelection(options.catalog, options);
  return { claudeDir, modules: modules.map((mod) => planModule(mod, claudeDir, env)) };
}

export interface ApplyOptions {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  onModuleStart?: (mod: PlannedModule) => void;
  onModuleEnd?: (result: ModuleResult) => void;
}

/**
 * Executes a plan. Steps are re-evaluated against the current disk state, so applying
 * a stale plan never clobbers changes made in between. Existing files that would be
 * replaced are moved to `<claudeDir>/.ccc-backups/<timestamp>/<dest>` first.
 */
export function apply(planToApply: Plan, options: ApplyOptions = {}): ApplyResult {
  const { claudeDir } = planToApply;
  const env = options.env ?? process.env;
  const dryRun = options.dryRun ?? false;
  const stamp = (options.now ?? (() => new Date()))().toISOString().replaceAll(":", "-");
  const backupRoot = join(claudeDir, BACKUP_DIR_NAME, stamp);
  let backupUsed = false;

  const backup = (destPath: string, dest: string): string => {
    const target = resolveInside(backupRoot, dest, "backup");
    mkdirSync(dirname(target), { recursive: true });
    if (isLink(destPath)) renameSync(destPath, target);
    else copyFileSync(destPath, target);
    backupUsed = true;
    return target;
  };

  const runStep = (planned: PlannedStep, mod: PlannedModule): StepResult => {
    const base = {
      index: planned.index,
      type: planned.type,
      dest: planned.dest,
      command: planned.command,
    };
    const catalogModule: CatalogModule = { ...mod, steps: [] };
    const evaluation = evaluate(planned.step, catalogModule, claudeDir, env);
    const result = (status: StepResult["status"], message: string): StepResult => ({
      ...base,
      action: evaluation.action,
      status,
      message,
    });
    if (dryRun) {
      return result(
        evaluation.action === "unchanged" ? "unchanged" : "planned",
        evaluation.summary || evaluation.reason,
      );
    }
    switch (evaluation.action) {
      case "unchanged":
        return result("unchanged", evaluation.reason);
      case "skip":
        return result(evaluation.blocked ? "failed" : "skipped", evaluation.reason);
      case "run": {
        const step = planned.step as Extract<Step, { type: "command" }>;
        const run = runArgv(step.run, env);
        if (run.code === 0) return result("done", `ran ${step.run.join(" ")}`);
        const output = (run.stderr || run.stdout).trim().split("\n").slice(-5).join("\n");
        return result("failed", `exit ${run.code}: ${output}`);
      }
      case "create":
      case "update": {
        const destPath = evaluation.destPath as string;
        const dest = planned.dest as string;
        let backupPath: string | undefined;
        try {
          if (evaluation.action === "update" && (existsSync(destPath) || isLink(destPath))) {
            backupPath = backup(destPath, dest);
          }
          mkdirSync(dirname(destPath), { recursive: true });
          if (evaluation.linkTarget) {
            // A regular file was copied to the backup above; a symlink was moved there.
            if (isLink(destPath) || existsSync(destPath)) unlinkSync(destPath);
            symlinkSync(evaluation.linkTarget, destPath);
          } else {
            writeFileSync(destPath, evaluation.content as Buffer);
          }
        } catch (error) {
          return result("failed", (error as Error).message);
        }
        const done = result("done", evaluation.summary || evaluation.reason);
        if (backupPath) done.backup = backupPath;
        return done;
      }
    }
  };

  const modules = planToApply.modules.map((mod) => {
    options.onModuleStart?.(mod);
    const steps = mod.steps.map((planned) => runStep(planned, mod));
    const moduleResult: ModuleResult = {
      id: mod.id,
      name: mod.name,
      ok: steps.every((s) => s.status !== "failed"),
      steps,
    };
    options.onModuleEnd?.(moduleResult);
    return moduleResult;
  });

  return {
    claudeDir,
    dryRun,
    ok: modules.every((m) => m.ok),
    backupDir: backupUsed ? backupRoot : null,
    modules,
  };
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
    const planned = planModule(mod, claudeDir, env);
    const count = (pred: (s: PlannedStep) => boolean) => planned.steps.filter(pred).length;
    const satisfied = count((s) => s.action === "unchanged");
    const skipped = count((s) => s.action === "skip" && !s.blocked);
    const pending = planned.steps.length - satisfied - skipped;
    const state = pending === 0 ? "applied" : satisfied > 0 ? "partial" : "not-applied";
    return { id: mod.id, name: mod.name, state, satisfied, pending, skipped };
  });
  return { claudeDir, modules };
}
