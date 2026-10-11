import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apply,
  captureClaudeConfig,
  findSecrets,
  loadCatalog,
  plan,
  requiredSecrets,
  writeCapture,
} from "../src/index";
import { FAKE_SECRETS, writeClaudeFixture } from "./capture-fixture";
import { fakeBin, tempDir } from "./helpers";

const NO_BINS: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function expectNoSecrets(text: string): void {
  for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
}

function fixture() {
  const root = tempDir("ccc-capture-");
  const claudeDir = join(root, "claude");
  const claudeJson = join(root, "claude.json");
  writeClaudeFixture(claudeDir, claudeJson, `bash ${join(claudeDir, "statusline.sh")}`);
  const out = join(root, "catalog");
  return { root, claudeDir, claudeJson, out };
}

describe("findSecrets", () => {
  it("detects known token shapes and long high-entropy strings, not ordinary text", () => {
    for (const secret of FAKE_SECRETS.filter((s) => !/api-key|hunter|ctx7sk/.test(s))) {
      expect(findSecrets(`x ${secret} y`).length, secret).toBe(1);
    }
    expect(findSecrets(["AKIA", "ABCDEFGHIJKLMNOP"].join(""))).toHaveLength(1);
    expect(findSecrets(["xoxb", "1234567890-abcdefghij"].join("-"))).toHaveLength(1);
    expect(
      findSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----"),
    ).toHaveLength(1);
    expect(findSecrets("mcp__plugin_engram_engram__mem_search_everything")).toEqual([]);
    // Long hex strings (including git SHAs) are treated as secrets: redaction errs on the safe side.
    expect(findSecrets("3f2c1a9b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b")).toHaveLength(1);
    expect(findSecrets("/Users/dev/.claude/skills/commit/SKILL.md")).toEqual([]);
  });
});

describe("capture", () => {
  it("finds config items and ignores caches and state", () => {
    const { claudeDir, claudeJson } = fixture();
    const result = captureClaudeConfig({ claudeDir, claudeJson });
    expect(result.items.map((item) => item.id).sort()).toEqual([
      "personal-agent-reviewer",
      "personal-claude-md",
      "personal-command-git-commit",
      "personal-mcp-context7",
      "personal-mcp-env-ref",
      "personal-mcp-github",
      "personal-output-style-terse",
      "personal-settings",
      "personal-skill-commit",
      "personal-statusline",
    ]);
    const skill = result.items.find((item) => item.id === "personal-skill-commit");
    expect(skill?.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
    expectNoSecrets(JSON.stringify(result));
  });

  it("filters by kind", () => {
    const { claudeDir, claudeJson } = fixture();
    const result = captureClaudeConfig({ claudeDir, claudeJson, include: ["mcp", "settings"] });
    expect(new Set(result.items.map((item) => item.kind))).toEqual(new Set(["mcp", "settings"]));
  });

  it("writes modules and a personal profile with secrets replaced by placeholders", () => {
    const { claudeDir, claudeJson, out } = fixture();
    const result = captureClaudeConfig({ claudeDir, claudeJson });
    const written = writeCapture(result, { outDir: out });
    expect(written.modules.every((m) => m.action === "create")).toBe(true);
    for (const file of allFiles(out)) expectNoSecrets(readFileSync(file, "utf8"));
    expectNoSecrets(JSON.stringify(written));

    const placeholders = result.redactions.map((r) => r.placeholder);
    expect(placeholders.every((p) => /^\$\{CCC_SECRET_[A-Z0-9_]+\}$/.test(p))).toBe(true);
    expect(result.redactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module: "personal-settings",
          location: "settings.json /env/ANTHROPIC_API_KEY",
        }),
        expect.objectContaining({ module: "personal-mcp-github" }),
        expect.objectContaining({ module: "personal-mcp-context7" }),
        expect.objectContaining({ module: "personal-claude-md" }),
        expect.objectContaining({ module: "personal-agent-reviewer" }),
      ]),
    );
    for (const redaction of result.redactions)
      expect(Object.keys(redaction).sort()).toEqual(["location", "module", "placeholder"]);

    const settings = JSON.parse(
      readFileSync(join(out, "modules/personal-settings/settings.json"), "utf8"),
    );
    expect(settings.env.PLAIN).toBe("visible");
    expect(settings.env.GH).toBe(`\${GITHUB_TOKEN}`);
    expect(settings.env.ANTHROPIC_API_KEY).toMatch(/^\$\{CCC_SECRET_/);
    expect(settings.includeCoAuthoredBy).toBe(false);

    const catalog = loadCatalog(out);
    const profile = catalog.profiles.find((p) => p.id === "personal");
    expect(profile?.order).toBe(30);
    expect(profile?.modules.sort()).toEqual(result.items.map((i) => i.id).sort());
    const mcp = catalog.modules.find((m) => m.id === "personal-mcp-github");
    expect(mcp?.steps[0]).toMatchObject({
      type: "command",
      check: ["claude", "mcp", "get", "github"],
      requiresBin: "claude",
    });
    expect((mcp?.steps[0] as { run: string[] } | undefined)?.run.slice(0, 5)).toEqual([
      "claude",
      "mcp",
      "add-json",
      "--scope",
      "user",
    ]);
    expect(mcp?.secrets?.[0]?.name).toMatch(/^CCC_SECRET_/);
    const envRef = catalog.modules.find((m) => m.id === "personal-mcp-env-ref");
    expect(envRef?.secrets ?? []).toEqual([]);
    expect(catalog.modules.find((m) => m.id === "personal-statusline")?.steps).toEqual([
      { type: "file", src: "statusline.sh", dest: "statusline.sh" },
    ]);
  });

  it("is idempotent, updates changed modules and prunes removed files", () => {
    const { claudeDir, claudeJson, out } = fixture();
    writeCapture(captureClaudeConfig({ claudeDir, claudeJson }), { outDir: out });
    const before = statSync(join(out, "modules/personal-settings/module.json")).mtimeMs;
    const again = writeCapture(captureClaudeConfig({ claudeDir, claudeJson }), { outDir: out });
    expect(again.modules.every((m) => m.action === "unchanged")).toBe(true);
    expect(again.profile.action).toBe("unchanged");
    expect(statSync(join(out, "modules/personal-settings/module.json")).mtimeMs).toBe(before);

    rmSync(join(claudeDir, "skills/commit/scripts"), { recursive: true });
    writeFileSync(
      join(claudeDir, "skills/commit/SKILL.md"),
      "---\nname: commit\ndescription: y\n---\n",
    );
    const changed = writeCapture(captureClaudeConfig({ claudeDir, claudeJson }), { outDir: out });
    const actions = Object.fromEntries(changed.modules.map((m) => [m.id, m.action]));
    expect(actions["personal-skill-commit"]).toBe("update");
    expect(actions["personal-settings"]).toBe("unchanged");
    expect(
      allFiles(join(out, "modules/personal-skill-commit"))
        .map((f) => f.split("/").pop())
        .sort(),
    ).toEqual(["SKILL.md", "module.json"]);
  });

  it("does not write in dry-run mode", () => {
    const { claudeDir, claudeJson, out } = fixture();
    const result = writeCapture(captureClaudeConfig({ claudeDir, claudeJson }), {
      outDir: out,
      dryRun: true,
    });
    expect(result.modules.every((m) => m.action === "create")).toBe(true);
    expect(() => statSync(out)).toThrow();
  });
});

describe("secrets at apply time", () => {
  it("requires every declared secret and substitutes values from the caller", () => {
    const { claudeDir, claudeJson, out } = fixture();
    const captured = captureClaudeConfig({ claudeDir, claudeJson });
    writeCapture(captured, { outDir: out });
    const catalog = loadCatalog(out);
    const required = requiredSecrets(catalog, { modules: ["personal-settings"] });
    expect(required).toHaveLength(1);
    const name = required[0]?.name ?? "";
    expect(name).toMatch(/^CCC_SECRET_SETTINGS_ANTHROPIC_API_KEY$/);

    const target = tempDir();
    const blocked = plan({
      catalog,
      claudeDir: target,
      modules: ["personal-settings"],
      env: NO_BINS,
    });
    expect(blocked.modules[0]?.steps[0]).toMatchObject({ blocked: true });
    expect(blocked.modules[0]?.steps[0]?.reason).toContain(name);

    const p = plan({
      catalog,
      claudeDir: target,
      modules: ["personal-settings", "personal-claude-md"],
      env: NO_BINS,
      secrets: Object.fromEntries(
        requiredSecrets(catalog, { modules: ["personal-settings", "personal-claude-md"] }).map(
          (s) => [s.name, `value-of-${s.name}`],
        ),
      ),
    });
    const result = apply(p, { env: NO_BINS });
    expect(result.ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
    expect(settings.env.ANTHROPIC_API_KEY).toBe(`value-of-${name}`);
    expect(readFileSync(join(target, "CLAUDE.md"), "utf8")).toMatch(
      /test key: value-of-CCC_SECRET_/,
    );
    expect(JSON.stringify(result)).not.toContain("value-of-");
  });

  it("substitutes secrets into command args", () => {
    const { claudeDir, claudeJson, out } = fixture();
    writeCapture(captureClaudeConfig({ claudeDir, claudeJson, include: ["mcp"] }), { outDir: out });
    const catalog = loadCatalog(out);
    const log = join(tempDir(), "calls.log");
    const env = fakeBin({
      claude: `printf '%s\\n' "$@" >> '${log}'\nif [ "$2" = "get" ]; then exit 1; fi\nexit 0`,
    });
    const secrets = Object.fromEntries(
      requiredSecrets(catalog, { modules: ["personal-mcp-github"] }).map((s) => [
        s.name,
        "tok-123",
      ]),
    );
    const result = apply(
      plan({ catalog, claudeDir: tempDir(), modules: ["personal-mcp-github"], env, secrets }),
      { env },
    );
    expect(result.ok).toBe(true);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("add-json");
    expect(calls, calls).toContain('"Authorization":"Bearer tok-123"');
  });
});

describe("capture review 2", () => {
  it("uses the mcp_ placeholder prefix and keeps every MCP secret out of argv", () => {
    const { root, claudeDir, out } = fixture();
    const claudeJson = join(root, "other.json");
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          brave: {
            command: "npx",
            args: ["-y", "brave-mcp", "--key", "brave-secret-1"],
            env: { BRAVE_KEY: "brave-secret-2" },
          },
          remote: {
            type: "http",
            url: "https://mcp.example.com/?token=brave-secret-3",
            headers: { "X-Api-Key": "brave-secret-4" },
          },
        },
      }),
    );
    const result = captureClaudeConfig({ claudeDir, claudeJson, include: ["mcp"] });
    writeCapture(result, { outDir: out });
    for (const file of allFiles(out)) {
      const text = readFileSync(file, "utf8");
      for (const n of [1, 2, 3, 4]) expect(text).not.toContain(`brave-secret-${n}`);
    }
    const names = result.items.flatMap((item) => item.secrets.map((s) => s.name));
    expect(names.length).toBe(4);
    expect(names.every((name) => /^CCC_SECRET_MCP_(BRAVE|REMOTE)_/.test(name))).toBe(true);
  });

  it("does not follow symlinked directories and ignores build and venv dirs", () => {
    const { root, claudeDir, claudeJson } = fixture();
    const skill = join(claudeDir, "skills/commit");
    mkdirSync(join(root, "elsewhere"));
    writeFileSync(join(root, "elsewhere/leak.md"), "outside\n");
    symlinkSync(join(root, "elsewhere"), join(skill, "linked"));
    symlinkSync(".", join(skill, "loop"));
    for (const dir of [".venv", "venv", "dist", "build", "target", ".next", ".cache", "coverage"]) {
      mkdirSync(join(skill, dir));
      writeFileSync(join(skill, dir, "x.txt"), "x\n");
    }
    const result = captureClaudeConfig({ claudeDir, claudeJson, include: ["skill"] });
    const files = result.items.find((item) => item.id === "personal-skill-commit")?.files;
    expect(files?.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/run.sh"]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "skills/commit/linked", reason: "symlinked directory (not followed)" },
        { path: "skills/commit/loop", reason: "symlinked directory (not followed)" },
      ]),
    );
  });

  it("skips an item over the file or byte cap with a reason", () => {
    const { claudeDir, claudeJson } = fixture();
    const many = join(claudeDir, "skills/many");
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 4; i += 1) writeFileSync(join(many, `f${i}.md`), "x\n");
    const big = join(claudeDir, "skills/big");
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, "SKILL.md"), "y".repeat(200));
    const result = captureClaudeConfig({
      claudeDir,
      claudeJson,
      include: ["skill"],
      limits: { maxFiles: 3, maxBytes: 100 },
    });
    const ids = result.items.map((item) => item.id);
    expect(ids).not.toContain("personal-skill-many");
    expect(ids).not.toContain("personal-skill-big");
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "skills/many/", reason: "more than 3 files" },
        { path: "skills/big/", reason: "more than 100 bytes in total" },
      ]),
    );
  });

  it("reports an unreadable entry and keeps capturing the rest", () => {
    const { claudeDir, claudeJson } = fixture();
    const locked = join(claudeDir, "skills/commit/locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "a.md"), "a\n");
    chmodSync(locked, 0o000);
    const secret = join(claudeDir, "agents/private.md");
    writeFileSync(secret, "p\n");
    chmodSync(secret, 0o000);
    try {
      const result = captureClaudeConfig({ claudeDir, claudeJson });
      const ids = result.items.map((item) => item.id);
      expect(ids).toContain("personal-skill-commit");
      expect(ids).toContain("personal-agent-reviewer");
      expect(ids).not.toContain("personal-agent-private");
      const paths = result.skipped.map((s) => s.path);
      expect(paths).toContain("skills/commit/locked");
      expect(paths).toContain("agents/private.md");
      expect(result.skipped.every((s) => s.reason.length > 0)).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
      chmodSync(secret, 0o644);
    }
  });

  it("reports the personal profile as unchanged when nothing is written", () => {
    const out = join(tempDir(), "catalog");
    const empty = captureClaudeConfig({
      claudeDir: join(tempDir(), "none"),
      claudeJson: join(tempDir(), "none.json"),
    });
    const written = writeCapture(empty, { outDir: out });
    expect(written.profile.action).toBe("unchanged");
    expect(written.profile.modules).toEqual([]);
    expect(() => statSync(out)).toThrow();
  });
});

describe("dry-run without secret values", () => {
  it("reports steps that need a secret as planned, not failed", () => {
    const { claudeDir, claudeJson, out } = fixture();
    writeCapture(captureClaudeConfig({ claudeDir, claudeJson, include: ["settings"] }), {
      outDir: out,
    });
    const catalog = loadCatalog(out);
    const p = plan({ catalog, claudeDir: tempDir(), modules: ["personal-settings"], env: NO_BINS });
    const dry = apply(p, { dryRun: true, env: NO_BINS });
    expect(dry.ok).toBe(true);
    expect(dry.modules[0]?.steps[0]?.status).toBe("planned");
    expect(dry.modules[0]?.steps[0]?.message).toMatch(/^needs secret CCC_SECRET_SETTINGS_/);
    const real = apply(p, { env: NO_BINS });
    expect(real.ok).toBe(false);
  });
});
