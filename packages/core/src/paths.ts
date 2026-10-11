import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { CatalogError } from "./errors";

/** Resolves the target Claude dir: flag > $CLAUDE_CONFIG_DIR > ~/.claude. */
export function resolveClaudeDir(flag?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (flag) return resolve(flag);
  if (env.CLAUDE_CONFIG_DIR) return resolve(env.CLAUDE_CONFIG_DIR);
  return join(homedir(), ".claude");
}

/**
 * The `.claude.json` (user-scope MCP servers) that goes with a Claude dir: `~/.claude.json`
 * for `~/.claude`, else `<claudeDir>/.claude.json`.
 */
export function claudeJsonFor(claudeDir: string, home: string = homedir()): string {
  return resolve(claudeDir) === join(home, ".claude")
    ? join(home, ".claude.json")
    : join(resolve(claudeDir), ".claude.json");
}

/** Joins a relative path onto a base dir, refusing absolute paths and `..` escapes. */
export function resolveInside(base: string, rel: string, what = "path"): string {
  if (!rel || isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new CatalogError("unsafe_path", `${what} "${rel}" must be a relative path`);
  }
  const normalized = normalize(rel);
  const target = resolve(base, normalized);
  const fromBase = relative(resolve(base), target);
  if (
    fromBase === "" ||
    fromBase === ".." ||
    fromBase.startsWith(`..${sep}`) ||
    isAbsolute(fromBase)
  ) {
    throw new CatalogError("unsafe_path", `${what} "${rel}" points outside ${base}`);
  }
  return target;
}

/** Resolves a step destination inside the Claude dir. */
export function resolveDest(claudeDir: string, dest: string): string {
  return resolveInside(claudeDir, dest, "dest");
}
