import { globToRegExp } from "./glob";

/** A top-level managed block in a markdown file such as CLAUDE.md. */
export interface ManagedBlock {
  name: string;
  /** Offset of the opening marker. */
  start: number;
  /** Offset just after the closing marker (and its line break). */
  end: number;
  text: string;
}

/**
 * Opening markers in the two styles installers use:
 * `<!-- BEGIN name[: note] -->` ... `<!-- END name -->` and `<!-- name -->` ... `<!-- /name -->`.
 */
const OPEN =
  /^<!--\s*(?:BEGIN\s+([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)[^>]*?|([A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+))\s*-->[ \t]*$/gm;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds the top-level managed blocks (nested blocks belong to their parent). An opening marker
 * without a matching closing marker is ignored.
 */
export function findManagedBlocks(text: string): ManagedBlock[] {
  const blocks: ManagedBlock[] = [];
  OPEN.lastIndex = 0;
  for (let match = OPEN.exec(text); match; match = OPEN.exec(text)) {
    const begin = match[1];
    const name = (begin ?? match[2]) as string;
    const close = begin
      ? new RegExp(`^<!--\\s*END\\s+${escapeRegExp(name)}\\s*-->[ \\t]*$`, "m")
      : new RegExp(`^<!--\\s*/${escapeRegExp(name)}\\s*-->[ \\t]*$`, "m");
    const rest = text.slice(match.index + match[0].length);
    const closing = close.exec(rest);
    if (!closing) continue;
    let end = match.index + match[0].length + closing.index + closing[0].length;
    if (text[end] === "\n") end += 1;
    blocks.push({ name, start: match.index, end, text: text.slice(match.index, end) });
    OPEN.lastIndex = end;
  }
  return blocks;
}

/** Whether `name` matches one of `patterns` (globs with `*`). */
export function blockMatches(name: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => globToRegExp(pattern).test(name));
}

/**
 * Removes the top-level blocks whose name matches `patterns` and collapses the blank lines
 * they leave behind.
 */
export function stripManagedBlocks(
  text: string,
  patterns: string[],
): { text: string; removed: string[] } {
  const removed: string[] = [];
  let out = "";
  let cursor = 0;
  for (const block of findManagedBlocks(text)) {
    if (!blockMatches(block.name, patterns)) continue;
    out += text.slice(cursor, block.start);
    cursor = block.end;
    removed.push(block.name);
  }
  out += text.slice(cursor);
  if (removed.length === 0) return { text, removed };
  const cleaned = out.replace(/\n{3,}/g, "\n\n").replace(/^\s*\n/, "");
  return { text: cleaned.trim() === "" ? "" : `${cleaned.trimEnd()}\n`, removed };
}

/**
 * `content` followed by every managed block of `current` that `content` does not already
 * contain (by name), so installer-managed sections survive a file copy.
 */
export function withPreservedBlocks(content: string, current: string): string {
  const own = new Set(findManagedBlocks(content).map((block) => block.name));
  const extra = findManagedBlocks(current).filter((block) => !own.has(block.name));
  if (extra.length === 0) return content;
  const base = content === "" ? "" : `${content.trimEnd()}\n\n`;
  return `${base}${extra.map((block) => block.text.trimEnd()).join("\n\n")}\n`;
}
