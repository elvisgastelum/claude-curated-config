import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  cancel,
  confirm,
  groupMultiselect,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  text,
} from "@clack/prompts";
import {
  CAPTURE_KINDS,
  type CaptureConfig,
  type CaptureKind,
  type CaptureResult,
  type CaptureWriteResult,
  type Catalog,
  captureClaudeConfig,
  captureConfigOptions,
  collectProvided,
  DEFAULT_CAPTURE_CONFIG,
  defaultClaudeJson,
  loadCaptureConfig,
  loadCatalog,
  type ProvidedIndex,
  type Redaction,
  requiredSecrets,
  type Selection,
  writeCapture,
} from "@claude-curated/core";
import type { Context } from "./commands";
import { type Colors, EXIT, UsageError, writeJson } from "./output";

export interface CaptureFlags {
  out?: string;
  claudeJson?: string;
  include?: string[];
  dryRun?: boolean;
  yes?: boolean;
}

function parseKinds(include: string[] = []): CaptureKind[] {
  const kinds = include.flatMap((value) => value.split(","));
  for (const kind of kinds) {
    if (!(CAPTURE_KINDS as readonly string[]).includes(kind)) {
      throw new UsageError(
        "invalid_include",
        `--include "${kind}" is not a capture kind (use: ${CAPTURE_KINDS.join(", ")})`,
      );
    }
  }
  return kinds as CaptureKind[];
}

/** The installer's checkout: `$CCC_HOME`, else `~/.local/share/claude-curated-config`. */
export function installerHome(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.CCC_HOME || join(homedir(), ".local/share/claude-curated-config"));
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Root of the git work tree containing `path` (a `.git` dir or file), or null. */
export function gitRoot(path: string): string | null {
  let dir = canonical(path);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Why captured modules may not be written into `catalogDir` without an explicit `--out`, or
 * null when it is allowed: only a catalog inside a git checkout that is not the installer's
 * (a later `git pull --ff-only` update of the installer checkout would refuse local changes).
 */
export function outRefusal(
  catalogDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const root = gitRoot(catalogDir);
  if (!root) return `the catalog ${catalogDir} is not inside a git checkout`;
  if (root === canonical(installerHome(env))) {
    return `the catalog ${catalogDir} is the installer's checkout (${root}); updates would conflict with captured files`;
  }
  return null;
}

/** `<root>/packages/catalog` when `cwd` is inside a claude-curated-config clone (not the installer's). */
function cwdCatalog(cwd: string): string | null {
  const root = gitRoot(cwd);
  if (!root || root === canonical(installerHome())) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return pkg.name === "claude-curated-config" ? join(root, "packages", "catalog") : null;
  } catch {
    return null;
  }
}

export function captureDoc(capture: CaptureResult, written: CaptureWriteResult) {
  const actions = new Map(written.modules.map((m) => [m.id, m.action]));
  return {
    schema: "ccc.capture/v1",
    claudeDir: capture.claudeDir,
    claudeJson: capture.claudeJson,
    outDir: written.outDir,
    dryRun: written.dryRun,
    items: capture.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      source: item.source,
      action: actions.get(item.id) ?? "unchanged",
      files: item.files.map((f) => f.path),
      secrets: item.secrets.map((s) => s.name),
      inputs: item.inputs.map((s) => s.name),
    })),
    redactions: capture.redactions,
    privacy: capture.privacy,
    skipped: capture.skipped,
    warnings: capture.warnings,
    profile: written.profile,
  };
}

export function renderRedactions(redactions: Redaction[], c: Colors): string {
  if (redactions.length === 0) return "No secrets found.";
  return redactions
    .map((r) => `${r.module} ${c.dim(r.location)} -> ${c.yellow(r.placeholder)}`)
    .join("\n");
}

export function renderPrivacy(privacy: Redaction[], c: Colors): string {
  if (privacy.length === 0) return "No private hosts or addresses found.";
  return privacy
    .map((r) => `${r.module} ${c.dim(r.location)} -> ${c.cyan(r.placeholder)}`)
    .join("\n");
}

export function renderSkipped(capture: CaptureResult, c: Colors): string {
  return capture.skipped.map((s) => `${s.path} ${c.dim(s.reason)}`).join("\n");
}

function renderCapture(capture: CaptureResult, written: CaptureWriteResult, c: Colors): string {
  const lines = written.modules.map(
    (m) => `  ${m.action.padEnd(9)} ${m.id} ${c.dim(`(${m.files.length} files)`)}`,
  );
  lines.push(`  ${written.profile.action.padEnd(9)} profiles/${written.profile.id}.json`);
  lines.push("", c.bold("Redacted secrets"), renderRedactions(capture.redactions, c));
  lines.push(
    "",
    c.bold("Private infrastructure (inputs asked at apply)"),
    renderPrivacy(capture.privacy, c),
  );
  if (capture.skipped.length > 0) lines.push("", c.bold("Skipped"), renderSkipped(capture, c));
  for (const warning of capture.warnings) lines.push(c.yellow(`warning: ${warning}`));
  lines.push(
    "",
    written.dryRun
      ? c.dim("Dry run: nothing was written.")
      : `Wrote ${written.outDir}. Review the git diff, then commit.`,
  );
  return lines.join("\n");
}

/**
 * What the non-personal modules provide, so capture leaves it out: the union of the catalog
 * in use and the catalog in `outDir`, so the result does not depend on what earlier captures
 * wrote. A catalog that does not load is reported in `warnings` (its items may be captured).
 */
function providedBy(
  ctx: Context,
  outDir?: string,
): { provided: ProvidedIndex; warnings: string[] } {
  const catalogs: Catalog[] = [];
  const warnings: string[] = [];
  const notLoaded = (dir: string, error: unknown) =>
    warnings.push(
      `provides of the catalog ${dir} not loaded (${(error as Error).message}); what its modules install may be captured again`,
    );
  try {
    catalogs.push(ctx.catalog());
  } catch (error) {
    notLoaded(ctx.catalogPath, error);
  }
  if (
    outDir &&
    existsSync(join(outDir, "modules")) &&
    resolve(outDir) !== resolve(ctx.catalogPath)
  ) {
    try {
      catalogs.push(loadCatalog(outDir));
    } catch (error) {
      notLoaded(outDir, error);
    }
  }
  const provided = collectProvided({
    dir: "",
    modules: catalogs.flatMap((catalog) => catalog.modules),
    profiles: [],
  });
  return { provided, warnings };
}

/**
 * The capture config: `capture.config.json` of the `--out` catalog, else of the catalog in
 * use, else the built-in defaults. An invalid file throws `invalid_capture_config`.
 */
function captureConfigFor(ctx: Context, outDir?: string): CaptureConfig {
  for (const dir of outDir ? [outDir, ctx.catalogPath] : [ctx.catalogPath]) {
    const config = loadCaptureConfig(dir);
    if (config) return config;
  }
  return DEFAULT_CAPTURE_CONFIG;
}

/** Captures with what the catalogs provide; their load problems become capture warnings. */
function runCapture(
  ctx: Context,
  options: { claudeJson: string; include: CaptureKind[]; outDir?: string },
): CaptureResult {
  const config = captureConfigFor(ctx, options.outDir);
  const { provided, warnings } = providedBy(ctx, options.outDir);
  const capture = captureClaudeConfig({
    claudeDir: ctx.claudeDir,
    claudeJson: options.claudeJson,
    include: options.include,
    provided,
    ...captureConfigOptions(config, process.env),
  });
  capture.warnings.unshift(...warnings);
  return capture;
}

/** `ccc capture`: imports the current Claude config into catalog modules. */
export async function captureCommand(ctx: Context, flags: CaptureFlags): Promise<number> {
  const include = parseKinds(flags.include);
  const claudeJson = flags.claudeJson ?? defaultClaudeJson(ctx.claudeDir);
  if (ctx.interactive && !flags.yes && !flags.dryRun) {
    return captureTui(ctx, { claudeJson, out: flags.out, include });
  }
  const refusal = flags.out ? null : outRefusal(ctx.catalogPath);
  if (refusal) {
    throw new UsageError(
      "out_required",
      `${refusal}; pass --out <your clone>/packages/catalog (nothing was written)`,
    );
  }
  const outDir = resolve(flags.out ?? ctx.catalogPath);
  if (!flags.yes && !flags.dryRun) {
    throw new UsageError(
      "confirmation_required",
      "refusing to write captured modules without confirmation in non-interactive mode; pass --yes (or --dry-run to preview)",
    );
  }
  const capture = runCapture(ctx, { claudeJson, include, outDir });
  const written = writeCapture(capture, { outDir, dryRun: flags.dryRun });
  if (ctx.options.json) writeJson(captureDoc(capture, written));
  else process.stdout.write(`${renderCapture(capture, written, ctx.colors)}\n`);
  return EXIT.ok;
}

async function captureTui(
  ctx: Context,
  options: { claudeJson: string; out?: string; include: CaptureKind[] },
): Promise<number> {
  const c = ctx.colors;
  intro(c.bgCyan(c.black(" ccc capture ")));
  log.info(`Reading ${c.bold(ctx.claudeDir)} and ${c.bold(options.claudeJson)}`);
  const capture = runCapture(ctx, {
    claudeJson: options.claudeJson,
    include: options.include,
    outDir: options.out ? resolve(options.out) : undefined,
  });
  if (capture.items.length === 0) {
    outro("Nothing to capture.");
    return EXIT.ok;
  }
  const groups: Record<string, { value: string; label: string; hint: string }[]> = {};
  for (const item of capture.items) {
    groups[item.kind] ??= [];
    groups[item.kind]?.push({ value: item.id, label: item.id, hint: item.source });
  }
  const chosen = await groupMultiselect({
    message: "What should be captured? (space to toggle, enter to confirm)",
    options: groups,
    initialValues: capture.items.map((item) => item.id),
    required: true,
  });
  if (isCancel(chosen)) {
    cancel("Nothing was written.");
    return EXIT.cancelled;
  }
  const keep = new Set(chosen);
  const selected: CaptureResult = {
    ...capture,
    items: capture.items.filter((item) => keep.has(item.id)),
    redactions: capture.redactions.filter((r) => keep.has(r.module)),
    privacy: capture.privacy.filter((r) => keep.has(r.module)),
  };
  note(renderRedactions(selected.redactions, c), "Secrets replaced with placeholders");
  if (selected.privacy.length > 0) {
    note(renderPrivacy(selected.privacy, c), "Private hosts and addresses replaced with inputs");
  }
  if (selected.skipped.length > 0) note(renderSkipped(selected, c), "Not captured");
  for (const warning of selected.warnings) log.warn(warning);
  const outDir = options.out ? resolve(options.out) : await askOutDir(ctx);
  if (!outDir) {
    cancel("Nothing was written.");
    return EXIT.cancelled;
  }
  const preview = writeCapture(selected, { outDir, dryRun: true });
  note(
    preview.modules.map((m) => `${m.action.padEnd(9)} ${m.id}`).join("\n"),
    `Write to ${preview.outDir}`,
  );
  const go = await confirm({ message: "Write these modules?" });
  if (isCancel(go) || !go) {
    cancel("Nothing was written.");
    return isCancel(go) ? EXIT.cancelled : EXIT.ok;
  }
  writeCapture(selected, { outDir });
  outro(
    `Captured ${selected.items.length} module(s) and the "personal" profile. Review the git diff in ${outDir}, then commit.`,
  );
  return EXIT.ok;
}

/**
 * Asks where to write the captured modules. The default is the catalog of the
 * claude-curated-config clone in the current directory, else the catalog in use when it may
 * be written. Returns null on cancel.
 */
async function askOutDir(ctx: Context): Promise<string | null> {
  const fallback = outRefusal(ctx.catalogPath) ? null : ctx.catalogPath;
  const initial = cwdCatalog(process.cwd()) ?? fallback;
  const answer = await text({
    message: "Catalog directory to write (in your clone of claude-curated-config)",
    placeholder: "~/code/claude-curated-config/packages/catalog",
    ...(initial ? { initialValue: initial } : {}),
    validate: (value) => (value?.trim() ? undefined : "required"),
  });
  if (isCancel(answer)) return null;
  return resolve(answer.trim().replace(/^~(?=\/|$)/, homedir()));
}

/**
 * Secrets and inputs the selection declares (`secret` false for inputs), with values taken
 * from same-named environment variables.
 */
export function secretStatus(catalog: Catalog, selection: Selection) {
  const values: Record<string, string> = {};
  const required = requiredSecrets(catalog, selection).map((secret) => {
    const value = process.env[secret.name];
    if (value) values[secret.name] = value;
    return { ...secret, provided: Boolean(value) };
  });
  return { values, required };
}

/**
 * Collects the secret and input values a selection needs from the environment. Only names in
 * `needed` (when given) are required: values of steps that will not run (their check passes)
 * are never asked for. In interactive mode, missing ones are asked (secrets masked, inputs as
 * plain text); otherwise exit 2: `secrets_missing` when a secret is missing, else
 * `inputs_missing`. Returns null when the user cancels a prompt.
 */
export async function collectSecrets(
  ctx: Context,
  catalog: Catalog,
  selection: Selection,
  options: { prompt: boolean; needed?: readonly string[] } = { prompt: ctx.interactive },
): Promise<Record<string, string> | null> {
  const { values, required } = secretStatus(catalog, selection);
  const needed = options.needed ? new Set(options.needed) : null;
  const missing = required.filter(
    (secret) => !secret.provided && (needed === null || needed.has(secret.name)),
  );
  if (missing.length === 0) return values;
  if (!options.prompt) {
    const brief = ({ name, description, module }: (typeof missing)[number]) => ({
      name,
      description,
      module,
    });
    const secrets = missing.filter((value) => value.secret).map(brief);
    const inputs = missing.filter((value) => !value.secret).map(brief);
    const what = secrets.length > 0 ? "secret(s)" : "input(s)";
    throw new UsageError(
      secrets.length > 0 ? "secrets_missing" : "inputs_missing",
      `missing ${what}; set these environment variables and re-run (nothing was written): ${missing.map((s) => s.name).join(", ")}`,
      { secrets, inputs },
    );
  }
  for (const secret of missing) {
    const ask = secret.secret ? password : text;
    const value = await ask({
      message: `${secret.name} (${secret.description})`,
      validate: (input) => (input ? undefined : "required"),
    });
    if (isCancel(value)) return null;
    values[secret.name] = value;
  }
  return values;
}
