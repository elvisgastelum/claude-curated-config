import { cancel, confirm, isCancel } from "@clack/prompts";
import { catalogDir as bundledCatalogDir } from "@claude-curated/catalog";
import {
  apply,
  type Catalog,
  doctor,
  loadCatalog,
  plan,
  resolveClaudeDir,
  type Selection,
  status,
  unresolvedConflicts,
} from "@claude-curated/core";
import { collectSecrets, secretStatus } from "./capture";
import { askConflicts, type ConflictFlags, conflictsError, parseConflictFlags } from "./conflicts";
import {
  applyDoc,
  type Colors,
  doctorDoc,
  EXIT,
  listDoc,
  makeColors,
  pendingCount,
  planDoc,
  renderApply,
  renderDoctor,
  renderList,
  renderPlan,
  renderStatus,
  statusDoc,
  UsageError,
  writeJson,
} from "./output";

export interface GlobalOptions {
  cli?: boolean;
  tui?: boolean;
  json?: boolean;
  claudeDir?: string;
  catalog?: string;
  color?: boolean;
}

export interface SelectionOptions {
  profile?: string;
  module?: string[];
}

export interface PlanFlags extends SelectionOptions, ConflictFlags {}

export interface ApplyFlags extends PlanFlags {
  yes?: boolean;
  dryRun?: boolean;
}

export interface Context {
  options: GlobalOptions;
  claudeDir: string;
  catalogPath: string;
  colors: Colors;
  /** True when prompts may be shown (TTY on both ends, no --cli, no --json). */
  interactive: boolean;
  catalog(): Catalog;
}

export function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function createContext(options: GlobalOptions): Context {
  let cached: Catalog | undefined;
  const catalogPath = options.catalog ?? bundledCatalogDir;
  return {
    options,
    claudeDir: resolveClaudeDir(options.claudeDir),
    catalogPath,
    colors: makeColors(options.color !== false),
    interactive: isTty() && !options.cli && !options.json,
    catalog: () => {
      cached ??= loadCatalog(catalogPath);
      return cached;
    },
  };
}

/** Human output goes to stdout; logs (progress, warnings) go to stderr. */
function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function toSelection(flags: SelectionOptions): Selection {
  const selection: Selection = {};
  if (flags.profile) selection.profile = flags.profile;
  if (flags.module?.length) selection.modules = flags.module;
  if (!selection.profile && !selection.modules) {
    throw new UsageError(
      "missing_selection",
      "select what to apply with --profile <id> and/or --module <id> (see `ccc list`)",
    );
  }
  return selection;
}

export async function listCommand(ctx: Context): Promise<number> {
  const catalog = ctx.catalog();
  if (ctx.options.json) writeJson(listDoc(catalog));
  else print(renderList(catalog, ctx.colors));
  return EXIT.ok;
}

export async function planCommand(ctx: Context, flags: PlanFlags): Promise<number> {
  const selection = toSelection(flags);
  const secrets = secretStatus(ctx.catalog(), selection);
  const result = plan({
    catalog: ctx.catalog(),
    claudeDir: ctx.claudeDir,
    ...selection,
    ...parseConflictFlags(flags),
    secrets: secrets.values,
  });
  if (ctx.options.json) writeJson(planDoc(result, selection, secrets.required));
  else print(`Claude dir: ${ctx.claudeDir}\n\n${renderPlan(result, ctx.colors)}`);
  return EXIT.ok;
}

export async function applyCommand(ctx: Context, flags: ApplyFlags): Promise<number> {
  const selection = toSelection(flags);
  const conflictOptions = parseConflictFlags(flags);
  const secrets = await collectSecrets(ctx, ctx.catalog(), selection);
  if (!secrets) {
    cancel("Nothing was changed.");
    return EXIT.cancelled;
  }
  const planFor = () =>
    plan({
      catalog: ctx.catalog(),
      claudeDir: ctx.claudeDir,
      ...selection,
      ...conflictOptions,
      secrets,
    });
  let planned = planFor();
  const open = unresolvedConflicts(planned);
  if (open.length > 0) {
    if (!ctx.interactive) throw conflictsError(planned);
    const decisions = await askConflicts(open, ctx.colors);
    if (!decisions) {
      cancel("Nothing was changed.");
      return EXIT.cancelled;
    }
    Object.assign(conflictOptions.resolutions, decisions);
    planned = planFor();
  }
  const pending = pendingCount(planned);

  if (!flags.yes && !flags.dryRun && pending > 0) {
    if (!ctx.interactive) {
      throw new UsageError(
        "confirmation_required",
        "refusing to apply without confirmation in non-interactive mode; pass --yes (or --dry-run to preview)",
      );
    }
    print(`Claude dir: ${ctx.claudeDir}\n\n${renderPlan(planned, ctx.colors)}\n`);
    const ok = await confirm({ message: "Apply these changes?" });
    if (isCancel(ok) || !ok) {
      cancel("Nothing was changed.");
      return isCancel(ok) ? EXIT.cancelled : EXIT.ok;
    }
  }

  const result = apply(planned, {
    dryRun: flags.dryRun,
    onModuleStart: (mod) => {
      if (!ctx.options.json) process.stderr.write(ctx.colors.dim(`→ ${mod.id}\n`));
    },
  });
  if (ctx.options.json) writeJson(applyDoc(result, selection));
  else print(renderApply(result, ctx.colors));
  return result.ok ? EXIT.ok : EXIT.failure;
}

export async function statusCommand(ctx: Context): Promise<number> {
  const report = status({ catalog: ctx.catalog(), claudeDir: ctx.claudeDir });
  if (ctx.options.json) writeJson(statusDoc(report));
  else print(renderStatus(report, ctx.colors));
  return EXIT.ok;
}

export async function doctorCommand(ctx: Context): Promise<number> {
  const report = doctor({ claudeDir: ctx.claudeDir });
  if (ctx.options.json) writeJson(doctorDoc(report));
  else print(renderDoctor(report, ctx.colors));
  return report.ok ? EXIT.ok : EXIT.failure;
}
