import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
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
  findConflicts,
  loadCatalog,
  MIN_NODE_VERSION,
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

describe("findConflicts", () => {
  it("reports differing leaves as JSON pointers; arrays and new keys never conflict", () => {
    const existing = {
      model: "opus",
      permissions: { deny: ["a"], defaultMode: "plan" },
      "a/b": { "c~d": 1 },
      x: 1,
    };
    const src = {
      model: "sonnet",
      permissions: { deny: ["b"], defaultMode: "plan" },
      "a/b": { "c~d": 2 },
      y: 2,
    };
    expect(findConflicts(existing, src)).toEqual([
      { path: "/model", current: "opus", catalog: "sonnet" },
      { path: "/a~1b/c~0d", current: 1, catalog: 2 },
    ]);
  });

  it("reports a type change as one conflict at that path", () => {
    expect(findConflicts({ hooks: "none" }, { hooks: { a: 1 } })).toEqual([
      { path: "/hooks", current: "none", catalog: { a: 1 } },
    ]);
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

describe("profile order", () => {
  it("sorts profiles by order (lower first), then id, with unordered profiles last", () => {
    const dir = writeCatalog(
      [{ id: "a", steps: [] }],
      [
        { id: "zeta", modules: ["a"] },
        { id: "big", modules: ["a"], order: 20 },
        { id: "alpha", modules: ["a"] },
        { id: "small", modules: ["a"], order: 10 },
        { id: "also-small", modules: ["a"], order: 10 },
      ],
    );
    expect(loadCatalog(dir).profiles.map((p) => p.id)).toEqual([
      "also-small",
      "small",
      "big",
      "alpha",
      "zeta",
    ]);
  });

  it("rejects a non-numeric order", () => {
    const dir = writeCatalog([{ id: "a", steps: [] }], [{ id: "p", modules: ["a"], order: "1" }]);
    expect(() => loadCatalog(dir)).toThrow(/order/);
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

describe("json-merge conflicts", () => {
  const setup = () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = tempDir();
    const original = JSON.stringify({ theme: "light", permissions: { deny: ["Bash(rm:*)"] } });
    writeFileSync(join(claudeDir, "settings.json"), original);
    return { catalog, claudeDir, original };
  };
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

  it("lists unresolved conflicts in the plan and refuses to apply them", () => {
    const { catalog, claudeDir, original } = setup();
    const p = plan({ catalog, claudeDir, modules: ["settings"], env: NO_BINS });
    expect(p.conflicts).toEqual([
      {
        module: "settings",
        step: 0,
        dest: "settings.json",
        path: "/theme",
        current: "light",
        catalog: "dark",
      },
    ]);
    const result = apply(p, { env: NO_BINS });
    expect(result.ok).toBe(false);
    expect(result.modules[0]?.steps[0]?.status).toBe("failed");
    expect(result.modules[0]?.steps[0]?.message).toMatch(/\/theme/);
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe(original);
  });

  it("keeps the user's value when resolved as keep, and is then idempotent", () => {
    const { catalog, claudeDir } = setup();
    const p = plan({
      catalog,
      claudeDir,
      modules: ["settings"],
      env: NO_BINS,
      resolutions: { "settings:/theme": "keep" },
    });
    expect(p.conflicts[0]?.resolution).toBe("keep");
    expect(apply(p, { env: NO_BINS }).ok).toBe(true);
    expect(read(claudeDir)).toEqual({
      theme: "light",
      permissions: { deny: ["Bash(rm:*)", "Read(./.env)"] },
    });
    const again = plan({
      catalog,
      claudeDir,
      modules: ["settings"],
      env: NO_BINS,
      onConflict: "keep",
    });
    expect(again.modules[0]?.steps[0]?.action).toBe("unchanged");
  });

  it("uses the catalog value with onConflict catalog; explicit resolutions win", () => {
    const { catalog, claudeDir } = setup();
    const p = plan({
      catalog,
      claudeDir,
      modules: ["settings"],
      env: NO_BINS,
      onConflict: "catalog",
    });
    expect(p.conflicts[0]?.resolution).toBe("catalog");
    apply(p, { env: NO_BINS });
    expect(read(claudeDir).theme).toBe("dark");

    const other = setup();
    const q = plan({
      catalog: other.catalog,
      claudeDir: other.claudeDir,
      modules: ["settings"],
      env: NO_BINS,
      onConflict: "catalog",
      resolutions: { "settings:/theme": "keep" },
    });
    apply(q, { env: NO_BINS });
    expect(read(other.claudeDir).theme).toBe("light");
  });
});

describe("hardening", () => {
  const NOW = () => new Date("2026-01-02T03:04:05.000Z");

  it("uses a unique backup dir per run and never overwrites an existing backup", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = tempDir();
    writeFileSync(join(claudeDir, "CLAUDE.md"), "first\n");
    const one = apply(plan({ catalog, claudeDir, modules: ["notes"], env: NO_BINS }), {
      env: NO_BINS,
      now: NOW,
    });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "second\n");
    const two = apply(plan({ catalog, claudeDir, modules: ["notes"], env: NO_BINS }), {
      env: NO_BINS,
      now: NOW,
    });
    expect(one.backupDir).not.toBeNull();
    expect(two.backupDir).not.toBeNull();
    expect(two.backupDir).not.toBe(one.backupDir);
    expect(readFileSync(join(one.backupDir ?? "", "CLAUDE.md"), "utf8")).toBe("first\n");
    expect(readFileSync(join(two.backupDir ?? "", "CLAUDE.md"), "utf8")).toBe("second\n");
  });

  it("surfaces blocked steps in dry-run results", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = tempDir();
    writeFileSync(join(claudeDir, "settings.json"), "{ not json");
    const result = apply(plan({ catalog, claudeDir, modules: ["settings"], env: NO_BINS }), {
      dryRun: true,
      env: NO_BINS,
    });
    expect(result.ok).toBe(false);
    expect(result.modules[0]?.steps[0]?.status).toBe("failed");
    expect(result.modules[0]?.steps[0]?.message).toMatch(/not valid JSON/);
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe("{ not json");
  });

  it("replaces a dangling symlink and backs up its target text", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = tempDir();
    const outside = join(tempDir(), "missing", "settings.json");
    symlinkSync("/nonexistent/ccc/CLAUDE.md", join(claudeDir, "CLAUDE.md"));
    symlinkSync(outside, join(claudeDir, "settings.json"));
    const p = plan({ catalog, claudeDir, profile: "minimal", env: NO_BINS });
    expect(p.modules.flatMap((m) => m.steps.map((s) => s.action))).toEqual(["update", "update"]);
    const result = apply(p, { env: NO_BINS });
    expect(result.ok).toBe(true);
    for (const name of ["CLAUDE.md", "settings.json"]) {
      expect(lstatSync(join(claudeDir, name)).isFile()).toBe(true);
    }
    expect(readlinkSync(join(result.backupDir ?? "", "CLAUDE.md"))).toBe(
      "/nonexistent/ccc/CLAUDE.md",
    );
    expect(existsSync(outside)).toBe(false);
  });

  it("records a step error, skips the rest of the module and its dependents, and continues", () => {
    const dir = writeCatalog([
      {
        id: "broken",
        steps: [
          { type: "file", src: "gone.md", dest: "gone.md" },
          { type: "file", src: "ok.md", dest: "ok.md" },
        ],
        files: { "gone.md": "x", "ok.md": "ok" },
      },
      {
        id: "dependent",
        requires: ["broken"],
        steps: [{ type: "file", src: "d.md", dest: "d.md" }],
        files: { "d.md": "d" },
      },
      {
        id: "independent",
        steps: [{ type: "file", src: "i.md", dest: "i.md" }],
        files: { "i.md": "i" },
      },
    ]);
    const catalog = loadCatalog(dir);
    rmSync(join(dir, "modules", "broken", "gone.md"));
    const claudeDir = tempDir();
    const p = plan({ catalog, claudeDir, modules: ["dependent", "independent"], env: NO_BINS });
    expect(p.modules[0]?.steps[0]).toMatchObject({ action: "skip", blocked: true });
    const result = apply(p, { env: NO_BINS });
    expect(result.ok).toBe(false);
    const byId = Object.fromEntries(result.modules.map((m) => [m.id, m]));
    expect(byId.broken?.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);
    expect(byId.broken?.steps[0]?.message).toMatch(/gone\.md|ENOENT/);
    expect(byId.dependent?.ok).toBe(false);
    expect(byId.dependent?.steps.map((s) => s.status)).toEqual(["skipped"]);
    expect(byId.dependent?.steps[0]?.message).toMatch(/broken/);
    expect(byId.independent?.steps.map((s) => s.status)).toEqual(["done"]);
    expect(existsSync(join(claudeDir, "ok.md"))).toBe(false);
    expect(readFileSync(join(claudeDir, "i.md"), "utf8")).toBe("i");
  });

  it("writes atomically, preserving the file mode and leaving no temp files", () => {
    const catalog = loadCatalog(basicCatalog());
    const claudeDir = tempDir();
    writeFileSync(join(claudeDir, "settings.json"), "{}");
    chmodSync(join(claudeDir, "settings.json"), 0o600);
    apply(plan({ catalog, claudeDir, modules: ["settings"], env: NO_BINS }), { env: NO_BINS });
    expect(statSync(join(claudeDir, "settings.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(claudeDir).filter((n) => n.includes(".tmp"))).toEqual([]);
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

describe("status inputs", () => {
  const NAME = "CCC_SECRET_DEMO_TOKEN";

  function secretCatalog() {
    return loadCatalog(
      writeCatalog([
        {
          id: "needs",
          secrets: [{ name: NAME, description: "demo" }],
          steps: [{ type: "json-merge", src: "s.json", dest: "settings.json" }],
          files: { "s.json": JSON.stringify({ env: { TOKEN: `\${${NAME}}` } }) },
        },
      ]),
    );
  }

  it("reports needs-secrets (not blocked) until the values are provided", () => {
    const catalog = secretCatalog();
    const claudeDir = tempDir();
    const missing = status({ catalog, claudeDir, env: NO_BINS }).modules[0];
    expect(missing).toMatchObject({ state: "needs-secrets", missingSecrets: [NAME] });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ env: { TOKEN: "v" } }));
    const provided = status({ catalog, claudeDir, env: NO_BINS, secrets: { [NAME]: "v" } });
    expect(provided.modules[0]).toMatchObject({ state: "applied", missingSecrets: [] });
  });

  it("reports conflicts when the only differences are conflicts, and honors keep", () => {
    const catalog = loadCatalog(
      writeCatalog([
        {
          id: "s",
          steps: [{ type: "json-merge", src: "s.json", dest: "settings.json" }],
          files: { "s.json": JSON.stringify({ model: "opus" }) },
        },
        {
          id: "more",
          steps: [{ type: "json-merge", src: "m.json", dest: "other.json" }],
          files: { "m.json": JSON.stringify({ model: "opus", extra: 1 }) },
        },
      ]),
    );
    const claudeDir = tempDir();
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ model: "sonnet" }));
    writeFileSync(join(claudeDir, "other.json"), JSON.stringify({ model: "sonnet" }));
    const states = (report: ReturnType<typeof status>) =>
      Object.fromEntries(report.modules.map((m) => [m.id, m.state]));
    expect(states(status({ catalog, claudeDir, env: NO_BINS }))).toEqual({
      s: "conflicts",
      more: "not-applied",
    });
    expect(states(status({ catalog, claudeDir, env: NO_BINS, onConflict: "keep" }))).toEqual({
      s: "applied",
      more: "not-applied",
    });
    expect(
      states(status({ catalog, claudeDir, env: NO_BINS, resolutions: { "s:/model": "keep" } })).s,
    ).toBe("applied");
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

  it("reads the minimum Node version from the root package.json engines", async () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    );
    const cli = JSON.parse(
      readFileSync(new URL("../../cli/package.json", import.meta.url), "utf8"),
    );
    expect(root.engines.node).toBe(`>=${MIN_NODE_VERSION}`);
    expect(MIN_NODE_VERSION).toBe("20.12.0");
    expect(cli.engines.node).toBe(root.engines.node);
    const ok = (nodeVersion: string) => doctor({ claudeDir: tempDir(), nodeVersion }).ok;
    expect(ok("19.9.0")).toBe(false);
    expect(ok("20.11.1")).toBe(false);
    expect(ok("20.12.0")).toBe(true);
    expect(ok("20.13.0")).toBe(true);
    expect(ok("22.0.0")).toBe(true);
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
