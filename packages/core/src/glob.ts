const cache = new Map<string, RegExp>();

/**
 * Converts a glob to an anchored RegExp: `**` matches across `/`, `*` and `?` do not.
 * Everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
  let re = cache.get(glob);
  if (re) return re;
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] as string;
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re = new RegExp(`^${source}$`);
  cache.set(glob, re);
  return re;
}

/** Whether a relative path matches `glob` itself or lies below a directory it matches. */
export function pathMatches(path: string, glob: string): boolean {
  const clean = path.replace(/\/+$/, "");
  if (globToRegExp(glob).test(clean)) return true;
  const parts = clean.split("/");
  for (let n = parts.length - 1; n > 0; n -= 1) {
    if (globToRegExp(glob).test(parts.slice(0, n).join("/"))) return true;
  }
  return false;
}
