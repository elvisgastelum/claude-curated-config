import { isPlainObject, type Json, pointerJoin } from "./merge";

/** Key-name fragments that mark a value as secret in structured data. */
export const SECRET_KEY =
  /token|secret|password|passwd|api[_-]?key|auth(?!or(?!i[sz]ation))|credential|private[_-]?key|cookie|session|database[_-]?url|connection[_-]?string/i;
/** `OPENAI_KEY`, `x-key`, `key`: a `key` suffix after a separator. */
const KEY_SUFFIX = /(?:^|[_-])key$/i;
/** `openaiKey`: a camelCase `Key` suffix (case-sensitive, so `monkey` does not match). */
const CAMEL_KEY_SUFFIX = /[a-z0-9]Key$/;
/**
 * In prose (markdown, plain text) only an unambiguous name marks a secret, so frontmatter
 * like `author:` or `session_notes:` is never redacted; value shapes still apply.
 */
const PROSE_SECRET_KEY =
  /^(?:[\w.-]*[_.-])?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)$/i;
const PROSE_FILE = /\.(md|markdown|mdx|txt)$/i;

/** True when a key in structured data (JSON keys, env maps, headers, argv flags) names a secret. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) || KEY_SUFFIX.test(key) || CAMEL_KEY_SUFFIX.test(key);
}

/**
 * `${CCC_SECRET_NAME}` / `${CCC_INPUT_NAME}`: a placeholder filled at plan/apply time from a
 * secret or a (non-secret) input value.
 */
export const PLACEHOLDER = /\$\{(CCC_(?:SECRET|INPUT)_[A-Z0-9_]+)\}/g;
export const SECRET_NAME = /^CCC_SECRET_[A-Z0-9_]+$/;
/** Module input names: upper-case env var names that are not secrets. */
export const INPUT_NAME = /^(?!CCC_SECRET_)[A-Z][A-Z0-9_]*$/;
const HAS_PLACEHOLDER = /\$\{CCC_(?:SECRET|INPUT)_[A-Z0-9_]+\}/;

/** A credential shape; with `group`, only that capture group is the secret. */
interface Shape {
  re: RegExp;
  group?: number;
  accept?: (match: string) => boolean;
}

// Order matters: earlier shapes win when spans overlap.
const SHAPES: Shape[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g }, // OpenAI, Anthropic (sk-ant-)
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { re: /\bxox[abp]-[A-Za-z0-9-]{10,}/g },
  { re: /\bAKIA[0-9A-Z]{16}\b/g },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { re: /\bnpm_[A-Za-z0-9]{20,}/g },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { re: /\bhf_[A-Za-z0-9]{20,}/g },
  // `Bearer <token>`: keep the scheme, redact the credential.
  { re: /\bBearer\s+([A-Za-z0-9._~+/-]{8,}=*)/gi, group: 1 },
  // `scheme://user:password@host`: the password.
  { re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@$][^\s/@]*)@/gi, group: 1 },
  // `?token=...`, `&api_key=...`, `&password=...` in URLs.
  {
    re: /[?&][\w-]*(?:token|key|secret|password|passwd|pwd|sig|signature|auth)=([^&#\s"'<>$][^&#\s"'<>]*)/gi,
    group: 1,
  },
  // Long hex (API keys, hashes; git SHAs too: redaction errs on the safe side).
  { re: /\b[0-9a-fA-F]{32,}\b/g, accept: (m) => /[a-fA-F]/.test(m) && /\d/.test(m) },
];
/** Long base64/base64url-ish tokens; kept only when high-entropy. */
const LONG_TOKEN = /[A-Za-z0-9+_=-]{32,}/g;
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** A long token mixing letters and digits with more than 4 bits of entropy per char. */
function highEntropy(token: string): boolean {
  return /[A-Za-z]/.test(token) && /\d/.test(token) && entropy(token) > 4;
}

export interface Span {
  start: number;
  end: number;
}

/** Finds substrings that look like credentials (known token shapes, high-entropy strings). */
export function findSecrets(text: string): Span[] {
  const spans: Span[] = [];
  const add = (start: number, end: number) => {
    if (!spans.some((s) => start < s.end && end > s.start)) spans.push({ start, end });
  };
  for (const { re, group, accept } of SHAPES) {
    for (const match of text.matchAll(re)) {
      if (accept && !accept(match[0])) continue;
      if (group === undefined) {
        add(match.index, match.index + match[0].length);
        continue;
      }
      const value = match[group] ?? "";
      // The credential is the last occurrence of the group inside the match.
      const start = match.index + match[0].lastIndexOf(value);
      if (value) add(start, start + value.length);
    }
  }
  for (const match of text.matchAll(LONG_TOKEN)) {
    if (highEntropy(match[0])) add(match.index, match.index + match[0].length);
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** True when a value only refers to environment variables (`${VAR}`, `$VAR`) and is not a literal. */
function isEnvReference(value: string): boolean {
  return /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(value) && findSecrets(value).length === 0;
}

export function toSecretName(...parts: string[]): string {
  const body = parts
    .join("_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `CCC_SECRET_${body || "VALUE"}`;
}

export interface Redaction {
  module: string;
  /** Where the value was found, e.g. `settings.json /env/API_KEY` or `CLAUDE.md line 3`. */
  location: string;
  placeholder: string;
}

export interface SecretSpec {
  name: string;
  description: string;
}

/**
 * Replaces secrets with `${CCC_SECRET_*}` placeholders for one module and records each
 * redaction (never the value). The same value always maps to the same placeholder.
 */
export class Redactor {
  readonly redactions: Redaction[] = [];
  readonly secrets: SecretSpec[] = [];
  private readonly byValue = new Map<string, string>();

  constructor(
    private readonly module: string,
    private readonly prefix: string,
    private readonly taken: Set<string>,
  ) {}

  private placeholder(value: string, hint: string, location: string): string {
    let name = this.byValue.get(value);
    if (!name) {
      const base = toSecretName(this.prefix, hint);
      name = base;
      for (let n = 2; this.taken.has(name); n += 1) name = `${base}_${n}`;
      this.taken.add(name);
      this.byValue.set(value, name);
      this.secrets.push({ name, description: `${location} (${this.module})` });
    }
    const placeholder = `\${${name}}`;
    this.redactions.push({ module: this.module, location, placeholder });
    return placeholder;
  }

  /** Redacts credential-shaped substrings of a string. */
  redactText(text: string, hint: string, location: (offset: number) => string): string {
    let out = "";
    let last = 0;
    for (const span of findSecrets(text)) {
      out += text.slice(last, span.start);
      out += this.placeholder(text.slice(span.start, span.end), hint, location(span.start));
      last = span.end;
    }
    return out + text.slice(last);
  }

  /**
   * Redacts `key: value` / `KEY=value` lines with secret-looking keys, then token shapes.
   * Markdown and plain-text files only use unambiguous key names (see PROSE_SECRET_KEY).
   */
  redactDocument(text: string, file: string): string {
    const lineOf = (offset: number) => `${file} line ${text.slice(0, offset).split("\n").length}`;
    const secretKey = PROSE_FILE.test(file)
      ? (key: string) => PROSE_SECRET_KEY.test(key)
      : isSecretKey;
    const keyed = text.replace(
      /^(\s*(?:[-*]\s+)?(?:export\s+)?["']?)([\w.-]+)(["']?\s*[:=]\s*["']?)([^\s"'#]{8,})/gm,
      (whole, lead: string, key: string, sep: string, value: string, offset: number) => {
        if (!secretKey(key) || isEnvReference(value) || HAS_PLACEHOLDER.test(value)) {
          return whole;
        }
        return `${lead}${key}${sep}${this.placeholder(value, key, lineOf(offset))}`;
      },
    );
    return this.redactText(keyed, "TOKEN", lineOf);
  }

  /**
   * Redacts a JSON document: string values under secret-looking keys are replaced whole
   * (unless they only reference env vars), other strings lose credential-shaped substrings,
   * and an argv value following a `--secret-flag` is replaced.
   */
  redactJson(value: Json, file: string, path = "", key = ""): Json {
    const where = (p: string) => `${file} ${p || "/"}`.trim();
    if (typeof value === "string") {
      if (HAS_PLACEHOLDER.test(value)) return value;
      if (key && isSecretKey(key) && value !== "" && !isEnvReference(value)) {
        // Keep an auth scheme ("Bearer <token>") so the placeholder holds only the credential.
        const scheme = /^(Bearer|Basic|Token)\s+(\S+)$/i.exec(value);
        if (scheme?.[1] && scheme[2]) {
          return `${scheme[1]} ${this.placeholder(scheme[2], key, where(path))}`;
        }
        return this.placeholder(value, key, where(path));
      }
      return this.redactText(value, key || "TOKEN", () => where(path));
    }
    if (Array.isArray(value)) {
      let flag = "";
      return value.map((item, index) => {
        const itemPath = pointerJoin(path, String(index));
        const out =
          typeof item === "string" && flag
            ? this.redactJson(item, file, itemPath, flag)
            : this.redactArgFlag(item, file, itemPath);
        flag = typeof item === "string" && /^--?[\w-]+$/.test(item) ? item.replace(/^-+/, "") : "";
        return out;
      });
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          this.redactJson(v, file, pointerJoin(path, k), k),
        ]),
      );
    }
    return value;
  }

  /** `--api-key=VALUE` and `API_KEY=VALUE` argv items. */
  private redactArgFlag(item: Json, file: string, path: string): Json {
    if (typeof item !== "string") return this.redactJson(item, file, path, "");
    const match = /^(--?)?([\w-]+)=(.+)$/.exec(item);
    if (match?.[2] && match[3] && isSecretKey(match[2]) && !isEnvReference(match[3])) {
      return `${match[1] ?? ""}${match[2]}=${this.placeholder(match[3], match[2], `${file} ${path}`)}`;
    }
    return this.redactJson(item, file, path);
  }
}

/** A `${CCC_SECRET_*}` placeholder has no value. */
/** Whether a value name is a secret (`CCC_SECRET_*`) rather than a non-secret input. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** A secret or input value a step needs was not provided. */
export class MissingSecretError extends Error {
  /** "secret" for `CCC_SECRET_*` names, else "input". */
  readonly kind: "secret" | "input";

  constructor(readonly secret: string) {
    const kind = isSecretName(secret) ? "secret" : "input";
    super(`missing ${kind} ${secret} (set it to apply this step)`);
    this.name = "MissingSecretError";
    this.kind = kind;
  }
}

/** Replaces `${CCC_SECRET_*}` and `${CCC_INPUT_*}` placeholders; throws {@link MissingSecretError} for the first missing value. */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new MissingSecretError(name);
    return value;
  });
}

export function substituteJson(value: Json, values: Record<string, string>): Json {
  if (typeof value === "string") return substitute(value, values);
  if (Array.isArray(value)) return value.map((item) => substituteJson(item, values));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteJson(v, values)]),
    );
  }
  return value;
}

/** Hides provided secret values (longest first) behind their placeholders. */
export function maskValues(text: string, values: Record<string, string>): string {
  const entries = Object.entries(values)
    .filter(([, value]) => value.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  let out = text;
  for (const [name, value] of entries) out = out.replaceAll(value, `\${${name}}`);
  return out;
}

/** Masks secret-looking values in a JSON value for display (`<redacted>`). */
export function maskJson(value: Json, values: Record<string, string> = {}, key = ""): Json {
  if (typeof value === "string") {
    if (key && isSecretKey(key) && value !== "" && !isEnvReference(value)) return "<redacted>";
    let out = maskValues(value, values);
    for (const span of findSecrets(out).reverse()) {
      out = `${out.slice(0, span.start)}<redacted>${out.slice(span.end)}`;
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((item) => maskJson(item, values));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskJson(v, values, k)]));
  }
  return value;
}
