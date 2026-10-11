import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apply,
  CatalogError,
  deepMerge,
  doctor,
  loadCatalog,
  plan,
  resolveClaudeDir,
  resolveDest,
  resolveSelection,
  status,
} from "../src/index";
import { fakeBin, tempDir, writeCatalog } from "./helpers";

const NO_BINS: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };

function basicCatalog() {
  return writeCatalog(
    [
      {
        id: "settings",
        steps: [{ type: "json-merge", src: "settings.json", dest: "settings.json" }],
        files: {
          "settings.json": JSON.stringify({
            permissions: { deny: ["Read(./.env)"] },
            theme: "dark",
          }),
        },
      },
      {
        id: "notes",
        requires: ["settings"],
        steps: [{ type: "file", src: "CLAUDE.md", dest: "CLAUDE.md" }],
        files: { "CLAUDE.md": "# Rules\n- be concise\n" },
      },
    ],
    [{ id: "minimal", modules: ["notes"] }],
  );
}

describe("deepMerge", () => {
  it("merges objects, unions arrays without duplicates and keeps existing keys", () => {
    const existing = { a: 1, keep: true, list: [1, 2], nested: { x: "old", y: 1 } };
    const src = { a: 2, list: [2, 3], nested: { x: "new", z: [{ k: 1 }] } };
    expect(deepMerge(existing, src)).toEqual({
      a: 2,
      keep: true,
      list: [1, 2, 3],
      nested: { x: "new", y: 1, z: [{ k: 1 }] },
    });
  });

  it("dedupes structurally equal array items", () => {
    expect(deepMerge({ l: [{ a: 1 }] }, { l: [{ a: 1 }, { a: 2 }] })).toEqual({
      l: [{ a: 1 }, { a: 2 }],
    });
  });
});

describe("resolveClaudeDir", () => {
  it("prefers flag, then CLAUDE_CONFIG_DIR, then ~/.claude", () => {
    expect(resolveClaudeDir("/x/flag", { CLAUDE_CONFIG_DIR: "/x/env" })).toBe("/x/flag");
    expect(resolveClaudeDir(undefined, { CLAUDE_CONFIG_DIR: "/x/env" })).toBe("/x/env");
    expect(resolveClaudeDir(undefined, {})).toBe(join(homedir(), ".claude"));
  });
});

describe("resolveDest", () => {
  it("rejects absolute and escaping destinations", () => {
    expect(() => resolveDest("/tmp/claude", "../evil")).toThrow(CatalogError);
    expect(() => resolveDest("/tmp/claude", "a/../../evil")).toThrow(CatalogError);
    expect(() => resolveDest("/tmp/claude", "/etc/passwd")).toThrow(CatalogError);
    expect(resolveDest("/tmp/claude", "skills/x/SKILL.md")).toBe("/tmp/claude/skills/x/SKILL.md");
  });
});

describe("loadCatalog", () => {
  it("rejects a module whose dest escapes the claude dir", () => {
    const dir = writeCatalog([
      {
        id: "evil",
        steps: [{ type: "file", src: "a.txt", dest: "../outside.txt" }],
        files: { "a.txt": "x" },
      },
    ]);
    expect(() => loadCatalog(dir)).toThrow(/outside/);
  });

  it("reports a missing src file", () => {
    const dir = writeCatalog([
      { id: "m", steps: [{ type: "file", src: "nope.md", dest: "a.md" }] },
    ]);
    expect(() => loadCatalog(dir)).toThrow(/nope\.md/);
  });

  it("reports unknown required modules and cycles", () => {
    const unknown = writeCatalog([{ id: "a", requires: ["ghost"], steps: [] }]);
    expect(() => loadCatalog(unknown)).toThrow(/ghost/);
    const cyclic = writeCatalog([
      { id: "a", requires: ["b"], steps: [] },
      { id: "b", requires: ["a"], steps: [] },
    ]);
    expect(() => loadCatalog(cyclic)).toThrow(/cycl/i);
  });

  it("reports profiles referencing unknown modules", () => {
    const dir = writeCatalog([{ id: "a", steps: [] }], [{ id: "p", modules: ["a", "zzz"] }]);
    expect(() => loadCatalog(dir)).toThrow(/zzz/);
  });
});

describe("resolveSelection", () => {
  it("adds required modules first in topological order", () => {
    const catalog = loadCatalog(basicCatalog());
    expect(resolveSelection(catalog, { profile: "minimal" }).map((m) => m.id)).toEqual([
      "settings",
      "notes",
    ]);
    expect(resolveSelection(catalog, { modules: ["notes", "settings"] }).map((m) => m.id)).toEqual([
      "settings",
      "notes",
    ]);
  });

  it("throws a CatalogError for unknown modules and profiles", () => {
    const catalog = loadCatalog(basicCatalog());
    try {
      resolveSelection(catalog, { modules: ["ghost"] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).code).toBe("unknown_module");
    }
    expect(() => resolveSelection(catalog, { profile: "ghost" })).toThrow(/ghost/);
    expect(() => resolveSelection(catalog, {})).toThrow(CatalogError);
  });
});

describe("plan and apply", () => {
  it("creates files, then reports everything unchanged on the second run", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = join(tempDir(), "claude");

    const first = plan({ catalog, claudeDir, profile: "minimal", env: NO_BINS });
    expect(first.modules.flatMap((m) => m.steps.map((s) => s.action))).toEqual([
      "create",
      "create",
    ]);

    const result = apply(first, { env: NO_BINS });
    expect(result.ok).toBe(true);
    expect(result.backupDir).toBeNull();
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).toContain("be concise");
    expect(JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"))).toEqual({
      permissions: { deny: ["Read(./.env)"] },
      theme: "dark",
    });

    const second = plan({ catalog, claudeDir, profile: "minimal", env: NO_BINS });
    expect(second.modules.flatMap((m) => m.steps.map((s) => s.action))).toEqual([
      "unchanged",
      "unchanged",
    ]);
    const again = apply(second, { env: NO_BINS });
    expect(again.modules.flatMap((m) => m.steps.map((s) => s.status))).toEqual([
      "unchanged",
      "unchanged",
    ]);
  });

  it("merges into existing JSON and backs up the previous file", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = tempDir();
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ model: "opus", permissions: { deny: ["Bash(rm:*)"] } }),
    );

    const p = plan({ catalog, claudeDir, modules: ["settings"], env: NO_BINS });
    expect(p.modules[0]?.steps[0]?.action).toBe("update");
    expect(p.modules[0]?.steps[0]?.summary).toMatch(/permissions\.deny|theme/);

    const result = apply(p, { env: NO_BINS, now: () => new Date("2026-01-02T03:04:05.000Z") });
    expect(result.backupDir).toBe(join(claudeDir, ".ccc-backups", "2026-01-02T03-04-05.000Z"));
    const merged = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(merged).toEqual({
      model: "opus",
      permissions: { deny: ["Bash(rm:*)", "Read(./.env)"] },
      theme: "dark",
    });
    const backup = JSON.parse(readFileSync(join(result.backupDir ?? "", "settings.json"), "utf8"));
    expect(backup.model).toBe("opus");
    expect(backup.theme).toBeUndefined();
  });

  it("backs up a different existing file before overwriting it", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = tempDir();
    writeFileSync(join(claudeDir, "CLAUDE.md"), "mine\n");
    const p = plan({ catalog, claudeDir, modules: ["notes"], env: NO_BINS });
    const notesStep = p.modules.find((m) => m.id === "notes")?.steps[0];
    expect(notesStep?.action).toBe("update");
    const result = apply(p, { env: NO_BINS });
    expect(result.backupDir).not.toBeNull();
    expect(readFileSync(join(result.backupDir ?? "", "CLAUDE.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).toContain("be concise");
  });

  it("does not touch the disk in dry-run mode", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = join(tempDir(), "claude");
    const result = apply(plan({ catalog, claudeDir, profile: "minimal", env: NO_BINS }), {
      dryRun: true,
      env: NO_BINS,
    });
    expect(result.dryRun).toBe(true);
    expect(result.modules.flatMap((m) => m.steps.map((s) => s.status))).toEqual([
      "planned",
      "planned",
    ]);
    expect(existsSync(claudeDir)).toBe(false);
  });

  it("creates and recognises symlinks", () => {
    const dir = writeCatalog([
      {
        id: "link",
        steps: [{ type: "file", src: "agent.md", dest: "agents/agent.md", mode: "symlink" }],
        files: { "agent.md": "agent" },
      },
    ]);
    const catalog = loadCatalog(dir);
    const claudeDir = tempDir();
    apply(plan({ catalog, claudeDir, modules: ["link"], env: NO_BINS }), { env: NO_BINS });
    const dest = join(claudeDir, "agents", "agent.md");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(join(dir, "modules", "link", "agent.md"));
    const again = plan({ catalog, claudeDir, modules: ["link"], env: NO_BINS });
    expect(again.modules[0]?.steps[0]?.action).toBe("unchanged");
  });
});

describe("command steps", () => {
  const commandCatalog = () =>
    writeCatalog([
      {
        id: "mcp",
        steps: [
          {
            type: "command",
            run: ["claude", "mcp", "add", "thing"],
            check: ["claude", "mcp", "get", "thing"],
            requiresBin: "claude",
          },
        ],
      },
    ]);

  it("skips with a reason when the required binary is missing", () => {
    const catalog = loadCatalog(commandCatalog());
    const p = plan({ catalog, claudeDir: tempDir(), modules: ["mcp"], env: NO_BINS });
    const step = p.modules[0]?.steps[0];
    expect(step?.action).toBe("skip");
    expect(step?.reason).toMatch(/claude/);
    const result = apply(p, { env: NO_BINS });
    expect(result.ok).toBe(true);
    expect(result.modules[0]?.steps[0]?.status).toBe("skipped");
  });

  it("is unchanged when the check command succeeds", () => {
    const catalog = loadCatalog(commandCatalog());
    const env = fakeBin({ claude: "exit 0" });
    const p = plan({ catalog, claudeDir: tempDir(), modules: ["mcp"], env });
    expect(p.modules[0]?.steps[0]?.action).toBe("unchanged");
  });

  it("runs the command without a shell when the check fails", () => {
    const catalog = loadCatalog(commandCatalog());
    const log = join(tempDir(), "calls.log");
    const env = fakeBin({
      claude: `echo "$@" >> '${log}'\nif [ "$2" = "get" ]; then exit 1; fi\nexit 0`,
    });
    const p = plan({ catalog, claudeDir: tempDir(), modules: ["mcp"], env });
    expect(p.modules[0]?.steps[0]?.action).toBe("run");
    const result = apply(p, { env });
    expect(result.ok).toBe(true);
    expect(result.modules[0]?.steps[0]?.status).toBe("done");
    expect(readFileSync(log, "utf8")).toContain("mcp add thing");
  });

  it("reports a failed command and marks the result not ok", () => {
    const catalog = loadCatalog(commandCatalog());
    const env = fakeBin({ claude: "echo boom >&2; exit 1" });
    const result = apply(plan({ catalog, claudeDir: tempDir(), modules: ["mcp"], env }), { env });
    expect(result.ok).toBe(false);
    expect(result.modules[0]?.steps[0]?.status).toBe("failed");
    expect(result.modules[0]?.steps[0]?.message).toContain("boom");
  });
});

describe("status", () => {
  it("reports applied, partial and not-applied modules", () => {
    const dir = writeCatalog([
      {
        id: "two",
        steps: [
          { type: "file", src: "a.md", dest: "a.md" },
          { type: "file", src: "b.md", dest: "b.md" },
        ],
        files: { "a.md": "a", "b.md": "b" },
      },
      { id: "one", steps: [{ type: "file", src: "c.md", dest: "c.md" }], files: { "c.md": "c" } },
      { id: "none", steps: [{ type: "file", src: "d.md", dest: "d.md" }], files: { "d.md": "d" } },
    ]);
    const catalog = loadCatalog(dir);
    const claudeDir = tempDir();
    writeFileSync(join(claudeDir, "a.md"), "a");
    writeFileSync(join(claudeDir, "c.md"), "c");
    const report = status({ catalog, claudeDir, env: NO_BINS });
    const states = Object.fromEntries(report.modules.map((m) => [m.id, m.state]));
    expect(states).toEqual({ none: "not-applied", one: "applied", two: "partial" });
  });
});

describe("doctor", () => {
  it("reports checks with fixes and a writable claude dir", () => {
    const claudeDir = join(tempDir(), "new-claude");
    const report = doctor({ claudeDir, env: NO_BINS });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.node?.ok).toBe(true);
    expect(byId.claude?.ok).toBe(false);
    expect(byId.claude?.fix).toBeTruthy();
    expect(byId["claude-dir"]?.ok).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("flags an unwritable claude dir", () => {
    const parent = tempDir();
    const file = join(parent, "file");
    writeFileSync(file, "x");
    mkdirSync(join(parent, "ok"));
    const report = doctor({ claudeDir: join(file, "claude"), env: NO_BINS });
    expect(report.checks.find((c) => c.id === "claude-dir")?.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(readdirSync(parent)).toEqual(["file", "ok"]);
  });
});
