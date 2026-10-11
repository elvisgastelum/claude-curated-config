export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export function isPlainObject(value: unknown): value is Record<string, Json> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges `src` into `existing`: objects merge recursively, arrays are unioned
 * (existing items first, structural dedupe), scalars from `src` win, and keys only
 * present in `existing` are preserved.
 */
export function deepMerge(existing: unknown, src: unknown): Json {
  if (isPlainObject(existing) && isPlainObject(src)) {
    const out: Record<string, Json> = { ...existing };
    for (const [key, value] of Object.entries(src)) {
      out[key] = key in existing ? deepMerge(existing[key], value) : value;
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
  return src as Json;
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
