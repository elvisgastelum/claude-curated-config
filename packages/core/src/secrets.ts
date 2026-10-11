import { isPlainObject, type Json, pointerJoin } from "./merge";

/** Key names whose string values are treated as secrets. */
export const SECRET_KEY =
  /token|secret|password|passwd|api[_-]?key|auth|credential|private[_-]?key|cookie|session/i;

/** `${CCC_SECRET_NAME}`: a placeholder filled at plan/apply time from a secret value. */
export const PLACEHOLDER = /\$\{(CCC_SECRET_[A-Z0-9_]+)\}/g;
export const SECRET_NAME = /^CCC_SECRET_[A-Z0-9_]+$/;
const HAS_PLACEHOLDER = /\$\{CCC_SECRET_[A-Z0-9_]+\}/;

const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[po]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
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
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape)) add(match.index, match.index + match[0].length);
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

  /** Redacts `key: value` / `KEY=value` lines with secret-looking keys, then token shapes. */
  redactDocument(text: string, file: string): string {
    const lineOf = (offset: number) => `${file} line ${text.slice(0, offset).split("\n").length}`;
    const keyed = text.replace(
      /^(\s*(?:[-*]\s+)?["']?)([\w.-]+)(["']?\s*[:=]\s*["']?)([^\s"'#]{8,})/gm,
      (whole, lead: string, key: string, sep: string, value: string, offset: number) => {
        if (!SECRET_KEY.test(key) || isEnvReference(value) || HAS_PLACEHOLDER.test(value)) {
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
      if (key && SECRET_KEY.test(key) && value !== "" && !isEnvReference(value)) {
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
    if (match?.[2] && match[3] && SECRET_KEY.test(match[2]) && !isEnvReference(match[3])) {
      return `${match[1] ?? ""}${match[2]}=${this.placeholder(match[3], match[2], `${file} ${path}`)}`;
    }
    return this.redactJson(item, file, path);
  }
}

/** Replaces `${CCC_SECRET_*}` placeholders; throws naming the first missing value. */
export function substitute(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`missing secret ${name} (set it to apply this step)`);
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
    if (key && SECRET_KEY.test(key) && value !== "" && !isEnvReference(value)) return "<redacted>";
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
