import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { findManagedBlocks, stripManagedBlocks } from "./blocks";
import { writeFileAtomic } from "./fsutil";
import { pathMatches } from "./glob";
import { isPlainObject, type Json } from "./merge";
import {
  blockProvider,
  emptyProvided,
  hookProvider,
  itemMatches,
  mcpProvider,
  type ProvidedEntry,
  type ProvidedIndex,
  pathProvider,
  settingProvider,
} from "./provides";
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

/**
 * Paths (relative to the Claude dir, globs allowed) never captured: Claude-managed synced
 * skills, and skills that must not go into a public catalog.
 */
export const CAPTURE_IGNORE: readonly string[] = [
  "skills/synced",
  "skills/homelab-service-manager",
];

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
  /**
   * What catalog modules already provide (see `collectProvided`): those items, settings,
   * hooks, CLAUDE.md blocks and MCP servers are left out and reported as skipped.
   */
  provided?: ProvidedIndex;
  /** Paths never captured (default {@link CAPTURE_IGNORE}). */
  ignore?: readonly string[];
}

/** Removes the value at a JSON pointer (object keys only); returns whether it existed. */
function removePointer(doc: Json, pointer: string): boolean {
  const keys = pointerKeys(pointer);
  let node: Json = doc;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node) || !(key in node)) return false;
    node = node[key] as Json;
  }
  const last = keys.at(-1);
  if (last === undefined || !isPlainObject(node) || !(last in node)) return false;
  delete node[last];
  return true;
}

function pointerKeys(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((key) => key.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * Drops the string items of the array at `entry.value` that the entry covers. An array left
 * empty is removed, and so are the objects that removal leaves empty.
 */
function removeItems(doc: Json, entry: ProvidedEntry, report: (item: string) => void): void {
  const keys = pointerKeys(entry.value);
  const chain: Record<string, Json>[] = [];
  let node: Json = doc;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(node) || !isPlainObject(node[key])) return;
    chain.push(node);
    node = node[key] as Json;
  }
  const last = keys.at(-1);
  if (last === undefined || !isPlainObject(node) || !Array.isArray(node[last])) return;
  const kept = (node[last] as Json[]).filter((item) => {
    const drop = typeof item === "string" && itemMatches(entry, item);
    if (drop) report(item);
    return !drop;
  });
  if (kept.length > 0) {
    node[last] = kept;
    return;
  }
  delete node[last];
  // Remove parents emptied by the removal, innermost first.
  for (let depth = chain.length - 1; depth >= 0; depth -= 1) {
    const parent = chain[depth] as Record<string, Json>;
    const key = keys[depth] as string;
    if (isPlainObject(parent[key]) && Object.keys(parent[key]).length === 0) delete parent[key];
    else break;
  }
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
  const provided = options.provided ?? emptyProvided();
  const ignore = options.ignore ?? CAPTURE_IGNORE;
  const relOf = (abs: string) => relative(claudeDir, abs).split(sep).join("/");
  const skip = (abs: string, reason: string, dir = false) =>
    skipped.push({ path: `${relOf(abs)}${dir ? "/" : ""}`, reason });
  /** Why a path relative to the Claude dir is left out (ignored or provided), if it is. */
  const excluded = (rel: string): string | undefined => {
    if (ignore.some((glob) => pathMatches(rel, glob))) return "ignored (never captured)";
    const provider = pathProvider(provided, rel);
    return provider ? `provided by ${provider}` : undefined;
  };

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

  const claudeMdPath = join(claudeDir, "CLAUDE.md");
  if (wanted.has("claude-md") && existsSync(claudeMdPath)) {
    let text: string | null = null;
    try {
      text = readFileSync(claudeMdPath, "utf8");
    } catch (error) {
      skip(claudeMdPath, `unreadable (${errorCode(error)})`);
    }
    const reason = excluded("CLAUDE.md");
    if (reason) skip(claudeMdPath, reason);
    else if (text !== null) {
      const owned = findManagedBlocks(text).flatMap((block) => {
        const provider = blockProvider(provided, block.name);
        if (!provider) return [];
        skipped.push({
          path: `CLAUDE.md <!-- ${block.name} -->`,
          reason: `provided by ${provider}`,
        });
        return [block.name];
      });
      const personal = stripManagedBlocks(text, owned).text;
      if (personal.trim() !== "") {
        add(
          "claude-md",
          "personal-claude-md",
          "CLAUDE_MD",
          {
            name: "Personal CLAUDE.md",
            description:
              "Your global CLAUDE.md instructions (captured); sections managed by installers are kept on apply.",
            source: "CLAUDE.md",
          },
          (r) => ({
            files: [
              {
                path: "CLAUDE.md",
                content: Buffer.from(r.redactDocument(personal, "CLAUDE.md")),
                mode: 0o644,
              },
            ],
            steps: [{ type: "file", src: "CLAUDE.md", dest: "CLAUDE.md", preserveBlocks: true }],
          }),
        );
      }
    }
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
    const doc = withoutProvided(structuredClone(settings), provided, (path, reason) =>
      skipped.push({ path, reason }),
    );
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
        if (Object.keys(doc).length === 0) return null;
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
    const scriptReason = script ? excluded(script.rel) : undefined;
    const lineProvider = settingProvider(provided, "/statusLine");
    if (script && scriptReason) {
      skip(join(claudeDir, script.rel), scriptReason);
    } else if (script && lineProvider) {
      if (!wanted.has("settings")) {
        skipped.push({ path: "settings.json /statusLine", reason: `provided by ${lineProvider}` });
      }
    } else if (script) {
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

  /** False (and recorded as skipped) when a file is ignored or provided. */
  const keep = (abs: string): boolean => {
    const reason = excluded(relOf(abs));
    if (reason) skip(abs, reason);
    return !reason;
  };

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
            const reason = excluded(`skills/${name}`);
            if (reason) {
              skip(join(dir, name), reason, true);
              return [];
            }
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
      list: (dir) => mdFiles(listDir, dir, "agents").filter((e) => keep(join(dir, e.slug))),
    },
    {
      kind: "command",
      dir: "commands",
      label: "command",
      list: (dir) =>
        (walkItem(dir) ?? [])
          .filter((rel) => rel.endsWith(".md") && keep(join(dir, rel)))
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
      list: (dir) => mdFiles(listDir, dir, "output-styles").filter((e) => keep(join(dir, e.slug))),
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
      const provider = mcpProvider(provided, name);
      if (provider) {
        skipped.push({
          path: `.claude.json /mcpServers/${name}`,
          reason: `provided by ${provider}`,
        });
        continue;
      }
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

/**
 * Drops the settings and hook commands that catalog modules provide (reported through
 * `report`), and the hook groups and events left empty.
 */
function withoutProvided(
  doc: Record<string, Json>,
  provided: ProvidedIndex,
  report: (path: string, reason: string) => void,
): Record<string, Json> {
  for (const entry of provided.settings) {
    const { value, module } = entry;
    if (entry.items || entry.match) {
      removeItems(doc, entry, (item) =>
        report(`settings.json ${value} ${item}`, `provided by ${module}`),
      );
    } else if (removePointer(doc, value)) {
      report(`settings.json ${value}`, `provided by ${module}`);
    }
  }
  const hooks = doc.hooks;
  if (!isPlainObject(hooks)) return doc;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap((group) => {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return [group];
      const entries = group.hooks.filter((entry) => {
        const command = isPlainObject(entry) ? entry.command : undefined;
        const provider = typeof command === "string" ? hookProvider(provided, command) : undefined;
        if (provider) report(`settings.json /hooks/${event} ${command}`, `provided by ${provider}`);
        return !provider;
      });
      return entries.length > 0 ? [{ ...group, hooks: entries }] : [];
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete doc.hooks;
  return doc;
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
  const personalIds = [...new Set([...previous, ...capture.items.map((item) => item.id)])].sort();
  const profilePath = join(outDir, "profiles", `${PERSONAL_PROFILE_ID}.json`);
  const current = readSafe(profilePath);
  const existing = parseProfile(current);
  // Merge into an existing profile (e.g. installer modules listed by hand): keep its fields and
  // module order, append captured modules it does not list yet.
  const base = existing?.modules ?? [];
  const ids = [...base, ...personalIds.filter((id) => !base.includes(id))];
  const profileText = `${JSON.stringify(
    {
      ...(existing ?? {}),
      id: PERSONAL_PROFILE_ID,
      name: existing?.name ?? "Personal",
      description: existing?.description ?? "Your own setup, captured with `ccc capture`.",
      order: existing?.order ?? PERSONAL_PROFILE_ORDER,
      modules: ids,
    },
    null,
    2,
  )}\n`;
  let profileAction: WriteAction = !current
    ? "create"
    : current.toString("utf8") === profileText || (existing && ids.length === base.length)
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

interface ProfileDoc {
  name?: string;
  description?: string;
  order?: number;
  modules: string[];
  [key: string]: unknown;
}

function parseProfile(content: Buffer | null): ProfileDoc | null {
  if (!content) return null;
  try {
    const doc = JSON.parse(content.toString("utf8"));
    if (!isPlainObject(doc) || !Array.isArray(doc.modules)) return null;
    return { ...doc, modules: doc.modules.filter((id): id is string => typeof id === "string") };
  } catch {
    return null;
  }
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
