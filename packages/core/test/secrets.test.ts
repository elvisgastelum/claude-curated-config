import { describe, expect, it } from "vitest";
import { findSecrets, isSecretKey, Redactor } from "../src/secrets";

// Assembled at runtime so secret scanners never see a token literal.
const HEX40 = ["9f86d081884c7d659a2f", "eaa0c55ad015a3bf4f1b"].join("");
const SHAPES = [
  HEX40,
  ["npm", "FAKEabcdefghijklmnopqrstuvwxyz012345"].join("_"),
  ["glpat", "FAKEabcdefghij0123456789"].join("-"),
  ["AIza", "SyFAKE0123456789abcdefghijklmnopqrs"].join(""),
  ["sk", "ant", "api03-FAKE0123456789abcdef"].join("-"),
  ["hf", "FAKEabcdefghijklmnopqrstuvwxyz0123"].join("_"),
];

const spanTexts = (text: string) => findSecrets(text).map((s) => text.slice(s.start, s.end));
const placeholder = /^\$\{CCC_SECRET_[A-Z0-9_]+\}$/;

describe("findSecrets value shapes", () => {
  it("detects long hex, npm, GitLab, Google, Anthropic and Hugging Face tokens", () => {
    for (const shape of SHAPES) expect(spanTexts(`x ${shape} y`), shape).toEqual([shape]);
  });

  it("finds only the credential part of bearer values and credential URLs", () => {
    expect(spanTexts("Authorization: Bearer abc123def456ghi")).toEqual(["abc123def456ghi"]);
    expect(spanTexts("postgres://user:pa55word@db.example.com/app")).toEqual(["pa55word"]);
    expect(spanTexts("postgres://u:p@h/db")).toEqual(["p"]);
    expect(spanTexts("https://api.example.com/v1?token=t0ken-value&x=1")).toEqual(["t0ken-value"]);
    expect(spanTexts("https://x.io/?api_key=abcd1234")).toEqual(["abcd1234"]);
    expect(spanTexts("https://x.io/?password=hunter22&key=k3y-value")).toEqual([
      "hunter22",
      "k3y-value",
    ]);
  });

  it("leaves ordinary text, env references and identifiers alone", () => {
    for (const text of [
      "author: Someone Name Here Long",
      "https://example.com/path?page=2&sort=asc",
      "postgres://localhost:5432/db",
      `postgres://u:\${DB_PASSWORD}@h/db`,
      `Bearer \${TOKEN}`,
      "123e4567-e89b-12d3-a456-426614174000",
      "mcp__plugin_engram_engram__mem_search_everything",
      "/Users/dev/.claude/skills/commit/SKILL.md",
      "deadbeef",
    ]) {
      expect(findSecrets(text), text).toEqual([]);
    }
  });
});

describe("isSecretKey", () => {
  it("matches *_KEY, credential and connection-string names, not look-alikes", () => {
    for (const key of [
      "OPENAI_KEY",
      "BRAVE_KEY",
      "FOO_KEY",
      "key",
      "x-api-key",
      "apiKey",
      "openaiKey",
      "Authorization",
      "DATABASE_URL",
      "DB_CONNECTION_STRING",
      "password",
      "GITHUB_TOKEN",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ["monkey", "author", "authors", "keyboard", "keys", "APP_URL", "model"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe("Redactor", () => {
  const redactor = () => new Redactor("m", "P", new Set());

  it("redacts structured values by key name, and credentials inside *_URL values", () => {
    const r = redactor();
    const out = r.redactJson(
      {
        env: {
          OPENAI_KEY: "plainvalue1",
          BRAVE_KEY: "x-brave-value",
          FOO_KEY: "foo",
          apiKey: "camel-value",
          DATABASE_URL: "postgres://u:p@h/db",
          DB_CONNECTION_STRING: "Server=x;Password=y",
          REDIS_URL: "redis://bob:s3cret@cache:6379/0",
          APP_URL: "https://example.com",
          monkey: "banana",
          author: "Some One",
        },
      },
      "settings.json",
    ) as { env: Record<string, string> };
    for (const key of [
      "OPENAI_KEY",
      "BRAVE_KEY",
      "FOO_KEY",
      "apiKey",
      "DATABASE_URL",
      "DB_CONNECTION_STRING",
    ]) {
      expect(out.env[key], key).toMatch(placeholder);
    }
    expect(out.env.REDIS_URL).toMatch(/^redis:\/\/bob:\$\{CCC_SECRET_P_[A-Z_]+\}@cache:6379\/0$/);
    expect(out.env.APP_URL).toBe("https://example.com");
    expect(out.env.monkey).toBe("banana");
    expect(out.env.author).toBe("Some One");
  });

  it("applies only value shapes to markdown, so frontmatter names stay untouched", () => {
    const r = redactor();
    const text = [
      "---",
      "name: reviewer",
      "author: Someone Name Here Long",
      "session_notes: keep-this-text",
      "monkey_key: banana-banana",
      "---",
      "password: hunter2-fake",
      `hash ${HEX40}`,
      "",
    ].join("\n");
    const out = r.redactDocument(text, "agents/reviewer.md");
    expect(out).toContain("author: Someone Name Here Long");
    expect(out).toContain("session_notes: keep-this-text");
    expect(out).toContain("monkey_key: banana-banana");
    expect(out).not.toContain(HEX40);
    // An explicit password line is still a secret in prose.
    expect(out).not.toContain("hunter2-fake");
  });

  it("redacts KEY=value lines by name in non-markdown text files", () => {
    const out = redactor().redactDocument(
      "export OPENAI_KEY=plainvalue12\necho done\n",
      "statusline.sh",
    );
    expect(out).not.toContain("plainvalue12");
    expect(out).toContain("echo done");
  });

  it("redacts secrets in argv items, env and headers", () => {
    const r = redactor();
    const out = JSON.stringify(
      r.redactJson(
        {
          command: "npx",
          args: ["-y", "brave-mcp", "--key", "brave-secret-1", "--api-key=brave-secret-2", HEX40],
          env: { BRAVE_KEY: "brave-secret-3" },
          headers: { "X-Api-Key": "brave-secret-4", Authorization: "Bearer brave-secret-5" },
        },
        ".claude.json",
      ),
    );
    for (const n of [1, 2, 3, 4, 5]) expect(out).not.toContain(`brave-secret-${n}`);
    expect(out).not.toContain(HEX40);
    expect(out).toContain("Bearer ${CCC_SECRET_");
  });
});
