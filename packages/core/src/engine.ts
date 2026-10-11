import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { withPreservedBlocks } from "./blocks";
import { resolveSelection } from "./catalog";
import { type RunOptions, runArgv, which } from "./exec";
import {
  type BackupStore,
  createBackupStore,
  isLink,
  occupied,
  symlinkAtomic,
  writeFileAtomic,
} from "./fsutil";
import { changedPaths, deepMerge, findConflicts } from "./merge";
import { claudeJsonFor, resolveDest, resolveInside } from "./paths";
import {
  isSecretName,
  MissingSecretError,
  maskJson,
  maskValues,
  type SecretSpec,
  substitute,
  substituteJson,
} from "./secrets";
import type {
  ApplyResult,
  Catalog,
  CatalogModule,
  Conflict,
  ConflictPolicy,
  ModuleResult,
  ModuleState,
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
  /** Set when the step is blocked only because this secret has no value. */
  needsSecret?: string;
  /** json-merge: every difference from the current file is an undecided conflict. */
  onlyConflicts?: boolean;
  destPath?: string;
  /** Where content is written when it differs from `destPath` (a json-merge through a symlink). */
  writePath?: string;
  /** Content to write for copy and json-merge steps. */
  content?: Buffer;
  /** File mode for copied files (keeps the executable bit of scripts). */
  mode?: number;
  /** Command argv with secrets substituted (command steps). */
  argv?: string[];
  /** Environment for the command (command steps). */
  commandEnv?: NodeJS.ProcessEnv;
  /** Absolute symlink target for symlink steps. */
  linkTarget?: string;
  /** json-merge values this step would overwrite (with their resolution when decided). */
  conflicts?: Omit<Conflict, "module" | "step" | "dest">[];
}

/** Decides a conflict of `module` at a JSON pointer; undefined means "ask". */
type Decide = (module: string, path: string) => Resolution | undefined;

interface EvalContext {
  claudeDir: string;
  env: NodeJS.ProcessEnv;
  decide: Decide;
  /** Values for `${CCC_SECRET_*}` placeholders. */
  secrets: Record<string, string>;
  /** `process.platform` value used for `os` filters. */
  platform: string;
}

/** Home directory of the given environment. */
function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

/** How long a `check`/`checkShell` may run before it is killed (counts as failed). */
export const CHECK_TIMEOUT_MS = 60_000;
/** How long a command step may run before it is killed (installers can be slow). */
export const RUN_TIMEOUT_MS = 30 * 60_000;

/** Wraps a step's `shell` script for execution (pipefail so `curl ... | bash` fails on curl errors). */
function bashArgv(script: string): string[] {
  return ["bash", "-o", "pipefail", "-c", script];
}

const EXPANSION = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$HOME\b/g;

/** Names of the values a module declares (secrets and inputs). */
function declaredNames(mod: CatalogModule): Set<string> {
  return new Set([...(mod.secrets ?? []), ...(mod.inputs ?? [])].map((value) => value.name));
}

/**
 * Expands a command `env` value: `${CCC_SECRET_*}`, `${CCC_INPUT_*}` and `${NAME}` for a
 * module input (throw {@link MissingSecretError} without a value), `${CCC_CLAUDE_DIR}`,
 * `${CCC_CLAUDE_JSON}`, `$HOME`, `${HOME}`, a leading `~/`, and `${NAME:-default}` from the
 * caller's environment. Anything else is left as is.
 */
function expandValue(value: string, ctx: EvalContext, declared: Set<string>): string {
  const home = homeOf(ctx.env);
  const expanded = value.replace(EXPANSION, (whole, name?: string, fallback?: string) => {
    if (!name || name === "HOME") return home;
    if (/^CCC_(SECRET|INPUT)_/.test(name) || declared.has(name)) {
      const provided = ctx.secrets[name];
      if (provided === undefined) throw new MissingSecretError(name);
      return provided;
    }
    if (name === "CCC_CLAUDE_DIR") return ctx.claudeDir;
    if (name === "CCC_CLAUDE_JSON") return claudeJsonFor(ctx.claudeDir, home);
    if (fallback !== undefined) return ctx.env[name] || fallback;
    return whole;
  });
  return expanded.replace(/^~(?=\/|$)/, home);
}

/** The environment a command step runs with. */
function commandEnv(
  step: Extract<Step, { type: "command" }>,
  mod: CatalogModule,
  ctx: EvalContext,
): NodeJS.ProcessEnv {
  const declared = declaredNames(mod);
  const extra = Object.fromEntries(
    Object.entries(step.env ?? {}).map(([key, value]) => [key, expandValue(value, ctx, declared)]),
  );
  return {
    ...ctx.env,
    CCC_CLAUDE_DIR: ctx.claudeDir,
    CCC_CLAUDE_JSON: claudeJsonFor(ctx.claudeDir, homeOf(ctx.env)),
    ...extra,
  };
}

/** The argv shown in plans for a command step (`shell` steps as `bash -c <script>`). */
export function commandDisplay(step: Extract<Step, { type: "command" }>): string[] {
  return step.shell !== undefined ? ["bash", "-c", step.shell] : (step.run ?? []);
}

/** Last key of a JSON pointer (unescaped), used to recognise secret-looking keys. */
function lastKey(pointer: string): string {
  return (pointer.split("/").pop() ?? "").replaceAll("~1", "/").replaceAll("~0", "~");
}

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
  { claudeDir, secrets }: EvalContext,
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
  let content = readFileSync(srcPath);
  const mode = statSync(srcPath).mode & 0o777;
  if (!content.includes(0) && /\$\{CCC_(SECRET|INPUT)_/.test(content.toString("utf8"))) {
    content = Buffer.from(substitute(content.toString("utf8"), secrets));
  }
  if (!stat) {
    return {
      action: "create",
      reason: "file does not exist",
      summary: `new file (${lineCount(content.toString("utf8"))} lines)`,
      destPath,
      content,
      mode,
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      action: "update",
      reason: existsSync(destPath) ? "replace symlink with file" : "replace dangling symlink",
      summary: `replace symlink -> ${readlinkSync(destPath)}`,
      destPath,
      content,
      mode,
    };
  }
  const current = readFileSync(destPath);
  if (step.preserveBlocks && !content.includes(0) && !current.includes(0)) {
    content = Buffer.from(withPreservedBlocks(content.toString("utf8"), current.toString("utf8")));
  }
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
  { claudeDir, decide, secrets }: EvalContext,
): Evaluation {
  const raw = JSON.parse(readFileSync(resolveInside(mod.dir, step.src, "src"), "utf8"));
  const src = substituteJson(raw, secrets);
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
    // Shown to humans and agents: never echo secret values.
    const shown = {
      path: conflict.path,
      current: maskJson(conflict.current, secrets, lastKey(conflict.path)),
      catalog: maskJson(conflict.catalog, secrets, lastKey(conflict.path)),
    };
    const resolution = decide(mod.id, conflict.path);
    return resolution ? { ...shown, resolution } : shown;
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
  // Would keeping every undecided conflict leave the file as it is?
  const onlyConflicts =
    open > 0 &&
    changedPaths(
      existing,
      deepMerge(
        existing,
        src,
        new Set(conflicts.filter((c) => c.resolution !== "catalog").map((c) => c.path)),
      ),
    ).length === 0;
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
    ...(onlyConflicts ? { onlyConflicts } : {}),
  };
}

function evaluateCommand(
  step: Extract<Step, { type: "command" }>,
  mod: CatalogModule,
  ctx: EvalContext,
): Evaluation {
  const { env, secrets, platform, claudeDir } = ctx;
  const summary = step.shell ?? (step.run ?? []).join(" ");
  if (step.os && !step.os.includes(platform as never)) {
    return {
      action: "skip",
      reason: `runs only on ${step.os.join(", ")} (this is ${platform})`,
      summary,
    };
  }
  if (step.globalOnly && resolve(claudeDir) !== join(homeOf(env), ".claude")) {
    return {
      action: "skip",
      reason: `configures ~/.claude only (target is ${claudeDir})`,
      summary,
    };
  }
  const missingBin = [step.requiresBin ?? []].flat().find((bin) => !which(bin, env));
  if (missingBin) {
    return { action: "skip", reason: `"${missingBin}" not found on PATH`, summary };
  }
  const runEnv = commandEnv(step, mod, ctx);
  const argv =
    step.shell !== undefined
      ? bashArgv(substitute(step.shell, secrets))
      : (step.run ?? []).map((arg) => substitute(arg, secrets));
  const checkArgv = step.checkShell
    ? bashArgv(substitute(step.checkShell, secrets))
    : step.check?.map((arg) => substitute(arg, secrets));
  if (checkArgv) {
    const check = runArgv(checkArgv, runEnv, { timeoutMs: CHECK_TIMEOUT_MS });
    if (check.code === 0) return { action: "unchanged", reason: "check passed", summary };
    return { action: "run", reason: "check failed", summary, argv, commandEnv: runEnv };
  }
  return { action: "run", reason: "no check defined", summary, argv, commandEnv: runEnv };
}

function evaluate(step: Step, mod: CatalogModule, ctx: EvalContext): Evaluation {
  try {
    switch (step.type) {
      case "file":
        return evaluateFile(step, mod, ctx);
      case "json-merge":
        return evaluateJsonMerge(step, mod, ctx);
      case "command":
        return evaluateCommand(step, mod, ctx);
    }
  } catch (error) {
    // One unreadable file or missing secret must not abort the whole plan: the step is blocked.
    if (error instanceof MissingSecretError) {
      return {
        action: "skip",
        reason: error.message,
        summary: `needs ${error.kind} ${error.secret}`,
        blocked: true,
        needsSecret: error.secret,
      };
    }
    return {
      action: "skip",
      reason: maskValues((error as Error).message, ctx.secrets),
      summary: "blocked",
      blocked: true,
    };
  }
}

function planModule(
  mod: CatalogModule,
  ctx: EvalContext,
  conflicts: Conflict[] = [],
): PlannedModule {
  return {
    id: mod.id,
    name: mod.name,
    description: mod.description,
    dir: mod.dir,
    requires: mod.requires ?? [],
    values: [...declaredNames(mod)],
    steps: mod.steps.map((step, index) => {
      const evaluation = evaluate(step, mod, ctx);
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
      if (step.type === "command") planned.command = commandDisplay(step);
      else planned.dest = step.dest;
      if (evaluation.blocked) planned.blocked = true;
      if (evaluation.needsSecret) planned.needsSecret = evaluation.needsSecret;
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
  /** Values for the `${CCC_SECRET_*}` placeholders of the selected modules. */
  secrets?: Record<string, string>;
  /** Platform for `os` filters (default `$CCC_PLATFORM`, else `process.platform`). */
  platform?: string;
}

function platformOf(env: NodeJS.ProcessEnv, platform?: string): string {
  return platform ?? env.CCC_PLATFORM ?? process.platform;
}

/** Computes what applying the selection would do, without changing anything. */
export function plan(options: PlanOptions): Plan {
  const claudeDir = resolve(options.claudeDir);
  const env = options.env ?? process.env;
  const { resolutions = {}, onConflict = "ask" } = options;
  const secrets = options.secrets ?? {};
  const platform = platformOf(env, options.platform);
  const ctx: EvalContext = {
    claudeDir,
    env,
    decide: decider(resolutions, onConflict),
    secrets,
    platform,
  };
  const conflicts: Conflict[] = [];
  const modules = resolveSelection(options.catalog, options).map((mod) =>
    planModule(mod, ctx, conflicts),
  );
  const result: Plan = { claudeDir, modules, conflicts, resolutions, onConflict, platform };
  // Non-enumerable so a serialized plan never carries secret values.
  Object.defineProperty(result, "secretValues", { value: secrets, enumerable: false });
  return result;
}

/**
 * Secrets and inputs declared by the selected modules (and their requires), deduplicated by
 * name; `secret` is false for non-secret inputs.
 */
export function requiredSecrets(
  catalog: Catalog,
  selection: Selection,
): (SecretSpec & { module: string; secret: boolean })[] {
  const seen = new Set<string>();
  return resolveSelection(catalog, selection).flatMap((mod) =>
    [
      ...(mod.secrets ?? []).map((value) => ({ ...value, secret: true })),
      ...(mod.inputs ?? []).map((value) => ({ ...value, secret: false })),
    ]
      .filter((value) => !seen.has(value.name) && seen.add(value.name))
      .map(({ name, description, secret }) => ({ name, description, module: mod.id, secret })),
  );
}

/** Conflicts that still need a decision before the plan can be applied. */
export function unresolvedConflicts(planned: Plan): Conflict[] {
  return planned.conflicts.filter((conflict) => !conflict.resolution);
}

export interface ApplyOptions {
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The caller has a terminal: steps marked `interactive` may use it. */
  interactive?: boolean;
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
  const secrets = planToApply.secretValues ?? {};
  const ctx: EvalContext = {
    claudeDir,
    env,
    decide: decider(planToApply.resolutions, planToApply.onConflict),
    secrets,
    platform: platformOf(env, planToApply.platform),
  };
  const failedModules = new Set<string>();
  const results: ModuleResult[] = [];

  const runStep = (planned: PlannedStep, mod: PlannedModule): StepResult => {
    const base = {
      index: planned.index,
      type: planned.type,
      dest: planned.dest,
      command: planned.command,
    };
    const catalogModule: CatalogModule = {
      ...mod,
      steps: [],
      inputs: mod.values.map((name) => ({ name, description: name })),
    };
    const evaluation = evaluate(planned.step, catalogModule, ctx);
    const result = (status: StepResult["status"], message: string): StepResult => ({
      ...base,
      action: evaluation.action,
      status,
      message: maskValues(message, secrets),
    });
    if (evaluation.action === "skip") {
      // A dry run does not need secret values: the step is planned and marked.
      if (dryRun && evaluation.needsSecret) {
        return result(
          "planned",
          `needs ${isSecretName(evaluation.needsSecret) ? "secret" : "input"} ${evaluation.needsSecret}`,
        );
      }
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
        const runOptions: RunOptions = {
          inheritStdio: Boolean(step.interactive && options.interactive),
          timeoutMs: RUN_TIMEOUT_MS,
        };
        const run = runArgv(evaluation.argv ?? [], evaluation.commandEnv ?? env, runOptions);
        if (run.code === 0) return result("done", `ran ${evaluation.summary}`);
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
      else writeFileAtomic(writePath, evaluation.content as Buffer, evaluation.mode);
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
  /** Values for `${CCC_SECRET_*}` placeholders (as for {@link plan}). */
  secrets?: Record<string, string>;
  /** Conflict decisions keyed `<module>:<JSON pointer>` (as for {@link plan}). */
  resolutions?: Resolutions;
  /** Policy for conflicts without an explicit decision (default "ask"). */
  onConflict?: ConflictPolicy;
  /** Platform for `os` filters (as for {@link plan}). */
  platform?: string;
}

/**
 * Reports, for every catalog module, whether its steps are already satisfied. Decisions and
 * secret values are inputs only; nothing is remembered between runs.
 *
 * - `needs-secrets`: the module declares secrets without values, so it cannot be evaluated.
 * - `conflicts`: nothing is pending except undecided json-merge conflicts.
 */
export function status(options: StatusOptions): StatusReport {
  const claudeDir = resolve(options.claudeDir);
  const env = options.env ?? process.env;
  const secrets = options.secrets ?? {};
  const ctx: EvalContext = {
    claudeDir,
    env,
    decide: decider(options.resolutions, options.onConflict),
    secrets,
    platform: platformOf(env, options.platform),
  };
  const modules: ModuleStatus[] = options.catalog.modules.map((mod) => {
    const missingSecrets = [...declaredNames(mod)].filter((name) => secrets[name] === undefined);
    const evaluations = mod.steps.map((step) => evaluate(step, mod, ctx));
    const count = (pred: (e: Evaluation) => boolean) => evaluations.filter(pred).length;
    const satisfied = count((e) => e.action === "unchanged");
    const skipped = count((e) => e.action === "skip" && !e.blocked);
    const conflicts = count((e) => e.onlyConflicts === true);
    const pending = evaluations.length - satisfied - skipped - conflicts;
    const state: ModuleState =
      missingSecrets.length > 0
        ? "needs-secrets"
        : pending === 0 && conflicts > 0
          ? "conflicts"
          : pending === 0
            ? "applied"
            : satisfied > 0
              ? "partial"
              : "not-applied";
    return {
      id: mod.id,
      name: mod.name,
      state,
      satisfied,
      pending,
      skipped,
      conflicts,
      missingSecrets,
    };
  });
  return { claudeDir, modules };
}
