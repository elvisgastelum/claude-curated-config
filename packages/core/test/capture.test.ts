import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    expect(findSecrets("3f2c1a9b8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b")).toEqual([]);
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
