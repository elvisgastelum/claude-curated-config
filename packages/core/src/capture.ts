import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { writeFileAtomic } from "./fsutil";
import { isPlainObject, type Json } from "./merge";
import { type Redaction, Redactor, type SecretSpec } from "./secrets";
import type { Step } from "./types";

export const CAPTURE_KINDS = [
  "claude-md",
  "settings",
  "statusline",
  "skill",
  "agent",
  "command",
  "output-style",
  "mcp",
] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const PERSONAL_PROFILE_ID = "personal";
export const PERSONAL_PROFILE_ORDER = 30;
const MAX_FILE_BYTES = 1024 * 1024;
/** How deep a captured directory is walked. */
export const MAX_WALK_DEPTH = 8;
/** Default per-item caps: an item over either one is skipped whole, with a reason. */
export const DEFAULT_CAPTURE_LIMITS: CaptureLimits = { maxFiles: 500, maxBytes: 5 * 1024 * 1024 };
/**
 * Names never captured inside walked directories: VCS, dependencies, virtualenvs, build
 * output, caches, logs, locks and history.
 */
const IGNORED_NAME =
  /^(\.git|node_modules|__pycache__|\.DS_Store|\.venv|venv|dist|build|target|\.next|\.cache|coverage)$|^history|\.log$|\.lock$/;

export interface CaptureLimits {
  maxFiles: number;
  maxBytes: number;
}

/** A path that was not captured, and why. */
export interface CaptureSkip {
  /** Path relative to the Claude dir (directories end with `/` when they are a whole item). */
  path: string;
  reason: string;
}

class ItemTooLarge extends Error {}

function formatBytes(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes % mb === 0 ? `${bytes / mb} MB` : `${bytes} bytes`;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? (error as Error).message;
}

export interface CapturedFile {
  /** Path relative to the module directory. */
  path: string;
  content: Buffer;
  mode: number;
}

export interface CaptureItem {
  /** Module id, `personal-<kind>[-<slug>]`. */
  id: string;
  kind: CaptureKind;
  name: string;
  description: string;
  /** Where it was found, e.g. `skills/commit/` or `.claude.json /mcpServers/github`. */
  source: string;
  files: CapturedFile[];
  steps: Step[];
  secrets: SecretSpec[];
}

export interface CaptureResult {
  claudeDir: string;
  claudeJson: string;
  items: CaptureItem[];
  /** Every replaced secret (location and placeholder only, never the value). */
  redactions: Redaction[];
  /** Paths left out (symlinked dirs, unreadable entries, oversized items), with reasons. */
  skipped: CaptureSkip[];
  warnings: string[];
}

export interface CaptureOptions {
  claudeDir: string;
  /** Path of `.claude.json` (user-scope MCP servers). */
  claudeJson: string;
  include?: CaptureKind[];
  /** Per-item caps (default {@link DEFAULT_CAPTURE_LIMITS}). */
  limits?: CaptureLimits;
}

/** Default `.claude.json`: `~/.claude.json` for `~/.claude`, else `<claudeDir>/.claude.json`. */
export function defaultClaudeJson(claudeDir: string): string {
  const home = homedir();
  return resolve(claudeDir) === join(home, ".claude")
    ? join(home, ".claude.json")
    : join(resolve(claudeDir), ".claude.json");
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/\.md$/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

function isText(content: Buffer): boolean {
  return !content.includes(0) && Buffer.from(content.toString("utf8"), "utf8").equals(content);
}

function moduleJson(item: CaptureItem): string {
  const doc = {
    id: item.id,
    name: item.name,
    description: item.description,
    tags: ["personal", item.kind],
    ...(item.secrets.length > 0 ? { secrets: item.secrets } : {}),
    steps: item.steps,
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Reads the Claude config and turns each item into a catalog module (in memory only).
 * Secrets in captured text and JSON are replaced with `${CCC_SECRET_*}` placeholders.
 */
export function captureClaudeConfig(options: CaptureOptions): CaptureResult {
  const claudeDir = resolve(options.claudeDir);
  const claudeJson = resolve(options.claudeJson);
  const wanted = new Set<CaptureKind>(options.include?.length ? options.include : CAPTURE_KINDS);
  const items: CaptureItem[] = [];
  const redactions: Redaction[] = [];
  const warnings: string[] = [];
  const skipped: CaptureSkip[] = [];
  const limits = options.limits ?? DEFAULT_CAPTURE_LIMITS;
  const takenNames = new Set<string>();
  const skip = (abs: string, reason: string, dir = false) =>
    skipped.push({
      path: `${relative(claudeDir, abs).split(sep).join("/")}${dir ? "/" : ""}`,
      reason,
    });

  /** Directory entries (sorted, ignored names removed); an unreadable dir is skipped. */
  const listDir = (dir: string, filter: (name: string) => boolean = () => true): string[] => {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((name) => !IGNORED_NAME.test(name) && filter(name))
        .sort();
    } catch (error) {
      skip(dir, `unreadable (${errorCode(error)})`);
      return [];
    }
  };

  /**
   * Lists regular files under `root` (relative paths). Symlinked files are followed, symlinked
   * directories are not (they are recorded as skipped), unreadable entries are skipped, and
   * more than `limits` files or bytes throws {@link ItemTooLarge}.
   */
  const walk = (root: string): string[] => {
    const out: string[] = [];
    let bytes = 0;
    const visit = (dir: string, rel: string, depth: number) => {
      if (depth > MAX_WALK_DEPTH) {
        skip(dir, `deeper than ${MAX_WALK_DEPTH} levels`);
        return;
      }
      for (const name of listDir(dir)) {
        const full = join(dir, name);
        const relPath = rel ? join(rel, name) : name;
        let stat: ReturnType<typeof statSync>;
        try {
          const link = lstatSync(full);
          stat = link.isSymbolicLink() ? statSync(full) : link;
          if (link.isSymbolicLink() && stat.isDirectory()) {
            skip(full, "symlinked directory (not followed)");
            continue;
          }
        } catch (error) {
          skip(full, `unreadable (${errorCode(error)})`);
          continue;
        }
        if (stat.isDirectory()) {
          visit(full, relPath, depth + 1);
        } else if (stat.isFile()) {
          out.push(relPath);
          bytes += stat.size;
          if (out.length > limits.maxFiles) {
            throw new ItemTooLarge(`more than ${limits.maxFiles} files`);
          }
          if (bytes > limits.maxBytes) {
            throw new ItemTooLarge(`more than ${formatBytes(limits.maxBytes)} in total`);
          }
        }
      }
    };
    visit(root, "", 0);
    return out;
  };

  /** Walks an item's directory; an oversized item is skipped whole (null). */
  const walkItem = (root: string): string[] | null => {
    try {
      return walk(root);
    } catch (error) {
      if (!(error instanceof ItemTooLarge)) throw error;
      skip(root, error.message, true);
      return null;
    }
  };
  const takenIds = new Set<string>();

  const uniqueId = (base: string) => {
    let id = base;
    for (let n = 2; takenIds.has(id); n += 1) id = `${base}-${n}`;
    takenIds.add(id);
    return id;
  };

  /** Reads a file under the Claude dir and redacts it when it is text. */
  const readAsset = (redactor: Redactor, abs: string, path: string): CapturedFile | null => {
    const rel = relative(claudeDir, abs);
    let stat: ReturnType<typeof statSync>;
    let raw: Buffer;
    try {
      stat = statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        skip(abs, "larger than 1 MiB");
        return null;
      }
      raw = readFileSync(abs);
    } catch (error) {
      skip(abs, `unreadable (${errorCode(error)})`);
      return null;
    }
    const mode = stat.mode & 0o777;
    if (!isText(raw)) {
      warnings.push(`${rel}: binary file copied without a secret scan`);
      return { path, content: raw, mode };
    }
    const text = redactor.redactDocument(raw.toString("utf8"), rel);
    return { path, content: Buffer.from(text), mode };
  };

  const add = (
    kind: CaptureKind,
    idBase: string,
    prefix: string,
    meta: { name: string; description: string; source: string },
    build: (redactor: Redactor) => { files: CapturedFile[]; steps: Step[] } | null,
  ) => {
    const id = uniqueId(idBase);
    const redactor = new Redactor(id, prefix, takenNames);
    const built = build(redactor);
    if (!built || built.steps.length === 0) return;
    redactions.push(...redactor.redactions);
    items.push({ id, kind, ...meta, ...built, secrets: redactor.secrets });
  };

  /** A module made of files copied to `<destDir>/<path>`. */
  const fileModule = (
    redactor: Redactor,
    files: { abs: string; path: string }[],
    destDir: string,
  ) => {
    const captured = files
      .map(({ abs, path }) => readAsset(redactor, abs, path))
      .filter((file): file is CapturedFile => file !== null);
    return {
      files: captured,
      steps: captured.map(
        (file): Step => ({
          type: "file",
          src: file.path,
          dest: destDir ? `${destDir}/${file.path.split(sep).join("/")}` : file.path,
        }),
      ),
    };
  };

  if (wanted.has("claude-md") && existsSync(join(claudeDir, "CLAUDE.md"))) {
    add(
      "claude-md",
      "personal-claude-md",
      "CLAUDE_MD",
      {
        name: "Personal CLAUDE.md",
        description: "Your global CLAUDE.md instructions (captured).",
        source: "CLAUDE.md",
      },
      (r) => fileModule(r, [{ abs: join(claudeDir, "CLAUDE.md"), path: "CLAUDE.md" }], ""),
    );
  }

  let settings: Json | undefined;
  const settingsPath = join(claudeDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      warnings.push("settings.json: not valid JSON, skipped");
    }
  }
  if (wanted.has("settings") && isPlainObject(settings)) {
    const doc = settings;
    add(
      "settings",
      "personal-settings",
      "SETTINGS",
      {
        name: "Personal settings",
        description: "Your settings.json (permissions, env, hooks, plugins), merged on apply.",
        source: "settings.json",
      },
      (r) => {
        const redacted = r.redactJson(doc, "settings.json");
        const content = Buffer.from(`${JSON.stringify(redacted, null, 2)}\n`);
        return {
          files: [{ path: "settings.json", content, mode: 0o644 }],
          steps: [{ type: "json-merge", src: "settings.json", dest: "settings.json" }],
        };
      },
    );
  }

  if (wanted.has("statusline") && isPlainObject(settings)) {
    const statusLine = settings.statusLine;
    const command = isPlainObject(statusLine) ? statusLine.command : undefined;
    const script = typeof command === "string" ? findScript(command, claudeDir) : null;
    if (script) {
      if (isAbsolute(script.token)) {
        warnings.push(
          `settings.json statusLine.command uses the absolute path ${script.token}; prefer ~/.claude/${script.rel} so it works on other machines`,
        );
      }
      add(
        "statusline",
        "personal-statusline",
        "STATUSLINE",
        {
          name: "Personal status line",
          description: `The status line script ${script.rel} referenced by settings.json.`,
          source: script.rel,
        },
        (r) => fileModule(r, [{ abs: join(claudeDir, script.rel), path: script.rel }], ""),
      );
    }
  }

  const dirKinds: {
    kind: CaptureKind;
    dir: string;
    label: string;
    list: (
      dir: string,
    ) => { slug: string; files: { abs: string; path: string }[]; dest: string; source: string }[];
  }[] = [
    {
      kind: "skill",
      dir: "skills",
      label: "skill",
      // A skill dir may itself be a symlink (e.g. into a dotfiles repo): the item root is
      // followed once; symlinked directories inside it are not.
      list: (dir) =>
        listDir(dir, (name) => statSafe(join(dir, name))?.isDirectory() ?? false).flatMap(
          (name) => {
            const files = walkItem(join(dir, name));
            if (!files) return [];
            return [
              {
                slug: name,
                files: files.map((rel) => ({ abs: join(dir, name, rel), path: rel })),
                dest: `skills/${name}`,
                source: `skills/${name}/`,
              },
            ];
          },
        ),
    },
    {
      kind: "agent",
      dir: "agents",
      label: "agent",
      list: (dir) => mdFiles(listDir, dir, "agents"),
    },
    {
      kind: "command",
      dir: "commands",
      label: "command",
      list: (dir) =>
        (walkItem(dir) ?? [])
          .filter((rel) => rel.endsWith(".md"))
          .map((rel) => ({
            slug: rel.split(sep).join("-"),
            files: [{ abs: join(dir, rel), path: rel }],
            dest: "commands",
            source: `commands/${rel.split(sep).join("/")}`,
          })),
    },
    {
      kind: "output-style",
      dir: "output-styles",
      label: "output style",
      list: (dir) => mdFiles(listDir, dir, "output-styles"),
    },
  ];
  for (const { kind, dir, label, list } of dirKinds) {
    if (!wanted.has(kind) || !existsSync(join(claudeDir, dir))) continue;
    for (const entry of list(join(claudeDir, dir))) {
      const slug = slugify(entry.slug);
      add(
        kind,
        `personal-${kind}-${slug}`,
        `${kind}_${slug}`,
        {
          name: `Personal ${label} ${entry.slug.replace(/\.md$/, "")}`,
          description: `Your ${label} ${entry.source} (captured).`,
          source: entry.source,
        },
        (r) => fileModule(r, entry.files, entry.dest),
      );
    }
  }

  if (wanted.has("mcp") && existsSync(claudeJson)) {
    let servers: Json | undefined;
    try {
      const doc = JSON.parse(readFileSync(claudeJson, "utf8"));
      servers = isPlainObject(doc) ? doc.mcpServers : undefined;
    } catch {
      warnings.push(`${claudeJson}: not valid JSON, MCP servers skipped`);
    }
    for (const [name, config] of Object.entries(isPlainObject(servers) ? servers : {})) {
      if (!isPlainObject(config)) continue;
      const slug = slugify(name);
      add(
        "mcp",
        `personal-mcp-${slug}`,
        `mcp_${slug}`,
        {
          name: `Personal MCP server ${name}`,
          description: `Registers your user-scope MCP server "${name}" with the claude CLI.`,
          source: `.claude.json /mcpServers/${name}`,
        },
        (r) => {
          const redacted = r.redactJson(config, ".claude.json", `/mcpServers/${name}`);
          return {
            files: [],
            steps: [
              {
                type: "command",
                run: [
                  "claude",
                  "mcp",
                  "add-json",
                  "--scope",
                  "user",
                  name,
                  JSON.stringify(redacted),
                ],
                check: ["claude", "mcp", "get", name],
                requiresBin: "claude",
              },
            ],
          };
        },
      );
    }
  }

  return { claudeDir, claudeJson, items, redactions, skipped, warnings };
}

function statSafe(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function mdFiles(
  listDir: (dir: string, filter: (name: string) => boolean) => string[],
  dir: string,
  destDir: string,
) {
  return listDir(
    dir,
    (name) => name.endsWith(".md") && (statSafe(join(dir, name))?.isFile() ?? false),
  ).map((name) => ({
    slug: name,
    files: [{ abs: join(dir, name), path: name }],
    dest: destDir,
    source: `${destDir}/${name}`,
  }));
}

/** Finds the first token of a shell command that names a file inside the Claude dir. */
function findScript(command: string, claudeDir: string): { token: string; rel: string } | null {
  const home = homedir();
  for (const raw of command.split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, "");
    const expanded = token
      .replace(/^\$\{?CLAUDE_CONFIG_DIR\}?(?=\/)/, claudeDir)
      .replace(/^(~|\$\{?HOME\}?)(?=\/)/, home);
    if (!isAbsolute(expanded)) continue;
    const rel = relative(claudeDir, expanded);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) continue;
    if (statSafe(expanded)?.isFile()) return { token, rel };
  }
  return null;
}

export type WriteAction = "create" | "update" | "unchanged";

export interface CaptureWriteResult {
  outDir: string;
  dryRun: boolean;
  modules: { id: string; kind: CaptureKind; action: WriteAction; files: string[] }[];
  profile: { id: string; path: string; action: WriteAction; modules: string[] };
}

export interface WriteCaptureOptions {
  /** Catalog directory to write `modules/` and `profiles/personal.json` into. */
  outDir: string;
  dryRun?: boolean;
}

function readSafe(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Writes captured items as catalog modules plus `profiles/personal.json`. Idempotent:
 * unchanged files are not rewritten, files no longer produced are removed from a captured
 * module, and personal modules from earlier captures stay in the profile.
 */
export function writeCapture(
  capture: CaptureResult,
  options: WriteCaptureOptions,
): CaptureWriteResult {
  const outDir = resolve(options.outDir);
  const dryRun = options.dryRun ?? false;
  const modulesDir = join(outDir, "modules");

  const modules = capture.items.map((item) => {
    const dir = join(modulesDir, item.id);
    const desired = new Map<string, { content: Buffer; mode: number }>([
      ["module.json", { content: Buffer.from(moduleJson(item)), mode: 0o644 }],
      ...item.files.map((f): [string, { content: Buffer; mode: number }] => [f.path, f]),
    ]);
    const existing = existsSync(dir) ? walkAll(dir) : [];
    const stale = existing.filter((rel) => !desired.has(rel));
    const changed = [...desired].filter(([rel, f]) => !readSafe(join(dir, rel))?.equals(f.content));
    const action: WriteAction = !existsSync(dir)
      ? "create"
      : changed.length > 0 || stale.length > 0
        ? "update"
        : "unchanged";
    if (!dryRun && action !== "unchanged") {
      for (const [rel, file] of changed) writeFileAtomic(join(dir, rel), file.content, file.mode);
      for (const rel of stale) rmSync(join(dir, rel));
      pruneEmptyDirs(dir);
    }
    return { id: item.id, kind: item.kind, action, files: [...desired.keys()] };
  });

  const previous = existsSync(modulesDir)
    ? readdirSync(modulesDir).filter(
        (name) => name.startsWith("personal-") && existsSync(join(modulesDir, name, "module.json")),
      )
    : [];
  const ids = [...new Set([...previous, ...capture.items.map((item) => item.id)])].sort();
  const profilePath = join(outDir, "profiles", `${PERSONAL_PROFILE_ID}.json`);
  const profileText = `${JSON.stringify(
    {
      id: PERSONAL_PROFILE_ID,
      name: "Personal",
      description: "Your own setup, captured with `ccc capture`.",
      order: PERSONAL_PROFILE_ORDER,
      modules: ids,
    },
    null,
    2,
  )}\n`;
  const current = readSafe(profilePath);
  let profileAction: WriteAction = !current
    ? "create"
    : current.toString("utf8") === profileText
      ? "unchanged"
      : "update";
  if (ids.length === 0) profileAction = "unchanged"; // nothing captured: no profile is written
  if (!dryRun && profileAction !== "unchanged") {
    writeFileAtomic(profilePath, profileText);
  }
  return {
    outDir,
    dryRun,
    modules,
    profile: { id: PERSONAL_PROFILE_ID, path: profilePath, action: profileAction, modules: ids },
  };
}

/** Every regular file under `dir`, relative to it (no symlinks followed). */
function walkAll(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
    const path = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) return walkAll(dir, path);
    return entry.isFile() ? [path] : [];
  });
}

function pruneEmptyDirs(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(dir, entry.name);
    pruneEmptyDirs(sub);
    if (readdirSync(sub).length === 0) rmSync(sub, { recursive: true });
  }
}
