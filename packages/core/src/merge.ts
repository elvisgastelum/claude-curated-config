export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function isPlainObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Appends one key to a JSON pointer (RFC 6901: `~` -> `~0`, `/` -> `~1`). */
export function pointerJoin(pointer: string, key: string): string {
  return `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

export interface MergeConflict {
  /** JSON pointer of the conflicting value (`""` is the document root). */
  path: string;
  current: Json;
  catalog: Json;
}

/**
 * Lists the values a merge would overwrite: leaves where `existing` already has a value
 * that differs from `src`. Objects recurse, arrays are unioned (never a conflict), and
 * keys missing from `existing` are additions, not conflicts.
 */
export function findConflicts(existing: unknown, src: unknown, path = ""): MergeConflict[] {
  if (isPlainObject(existing) && isPlainObject(src)) {
    return Object.entries(src).flatMap(([key, value]) =>
      key in existing ? findConflicts(existing[key], value, pointerJoin(path, key)) : [],
    );
  }
  if (Array.isArray(existing) && Array.isArray(src)) return [];
  if (JSON.stringify(existing) === JSON.stringify(src)) return [];
  return [{ path, current: existing as Json, catalog: src as Json }];
}

/**
 * Deep-merges `src` into `existing`: objects merge recursively, arrays are unioned
 * (existing items first, structural dedupe), scalars from `src` win unless their JSON
 * pointer is in `keep`, and keys only present in `existing` are preserved.
 */
export function deepMerge(
  existing: unknown,
  src: unknown,
  keep: ReadonlySet<string> = new Set(),
  path = "",
): Json {
  if (isPlainObject(existing) && isPlainObject(src)) {
    const out: Record<string, Json> = { ...existing };
    for (const [key, value] of Object.entries(src)) {
      out[key] =
        key in existing ? deepMerge(existing[key], value, keep, pointerJoin(path, key)) : value;
    }
    return out;
  }
  if (Array.isArray(existing) && Array.isArray(src)) {
    const seen = new Set(existing.map((item) => JSON.stringify(item)));
    const out: Json[] = [...existing];
    for (const item of src) {
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(item);
      }
    }
    return out;
  }
  return keep.has(path) ? (existing as Json) : (src as Json);
}

/** Lists dotted paths whose values differ between two JSON documents. */
export function changedPaths(before: unknown, after: unknown, prefix = ""): string[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].flatMap((key) =>
      changedPaths(before[key], after[key], prefix ? `${prefix}.${key}` : key),
    );
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (Array.isArray(before) && Array.isArray(after) && after.length > before.length) {
    return [`${prefix}[+${after.length - before.length}]`];
  }
  return [prefix || "(root)"];
}
