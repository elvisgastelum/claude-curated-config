import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CommandStep, collectProvided, loadCatalog, plan } from "@claude-curated/core";
import { describe, expect, it } from "vitest";
import { catalogDir } from "../index.js";

const TOOLS = ["tool-gentle-ai", "tool-engram", "tool-codegraph", "tool-herdr"];
const SETUPS: Record<string, string> = {
  "gentle-ai-claude": "tool-gentle-ai",
  "engram-claude": "tool-engram",
  "codegraph-claude": "tool-codegraph",
  "herdr-claude": "tool-herdr",
  "herdr-config": "tool-herdr",
};
const INSTALLERS = [
  "skill-commit",
  "skill-kaneo",
  "skill-continue",
  "statusline",
  "skill-configure-env",
];

describe("seed catalog", () => {
  const catalog = loadCatalog(catalogDir);

  // Captured `personal-*` modules may be committed next to the seed modules.
  const seed = catalog.modules.filter((m) => !m.id.startsWith("personal-"));
  const byId = new Map(catalog.modules.map((m) => [m.id, m]));
  const commands = (id: string) =>
    (byId.get(id)?.steps ?? []).filter((s): s is CommandStep => s.type === "command");

  it("validates and exposes the seed modules", () => {
    expect(seed.map((m) => m.id)).toEqual([
      "codegraph-claude",
      "core-settings",
      "engram-claude",
      "gentle-ai-claude",
      "global-instructions",
      "herdr-claude",
      "herdr-config",
      "mcp-context7",
      "skill-commit",
      "skill-configure-env",
      "skill-continue",
      "skill-kaneo",
      "statusline",
      "tool-codegraph",
      "tool-engram",
      "tool-gentle-ai",
      "tool-herdr",
    ]);
    for (const mod of seed) expect(mod.description.length, mod.id).toBeGreaterThan(40);
  });

  it("defines minimal, full and personal profiles in that order", () => {
    const profiles = Object.fromEntries(catalog.profiles.map((p) => [p.id, p.modules]));
    expect(profiles.minimal).toEqual(["core-settings", "global-instructions"]);
    expect(profiles.full).toEqual([
      "core-settings",
      "global-instructions",
      "mcp-context7",
      "skill-commit",
    ]);
    expect(catalog.profiles.map((p) => [p.id, p.order]).slice(0, 3)).toEqual([
      ["minimal", 10],
      ["full", 20],
      ["personal", 30],
    ]);
    const personal = profiles.personal ?? [];
    for (const id of [...TOOLS, ...Object.keys(SETUPS), ...INSTALLERS, "mcp-context7"]) {
      expect(personal, id).toContain(id);
    }
    // Every setup module comes after the tool it needs.
    for (const [setup, tool] of Object.entries(SETUPS)) {
      expect(personal.indexOf(tool), setup).toBeLessThan(personal.indexOf(setup));
    }
  });

  it("makes every command step idempotent and every tool install OS-aware", () => {
    for (const mod of seed) {
      for (const step of commands(mod.id)) {
        expect(step.check ?? step.checkShell, mod.id).toBeTruthy();
        expect(step.requiresBin, mod.id).toBeTruthy();
      }
    }
    for (const id of TOOLS) {
      expect(commands(id)[0]?.os, id).toEqual(["darwin", "linux"]);
    }
    for (const [setup, tool] of Object.entries(SETUPS)) {
      expect(byId.get(setup)?.requires, setup).toEqual([tool]);
    }
    for (const id of ["gentle-ai-claude", "engram-claude", "codegraph-claude", "herdr-claude"]) {
      expect(commands(id)[0]?.globalOnly, id).toBe(true);
    }
    expect(commands("gentle-ai-claude")[0]?.run).toEqual([
      "gentle-ai",
      "install",
      "--agent",
      "claude-code",
      "--scope",
      "global",
      "--preset",
      "full-gentleman",
    ]);
  });

  it("declares what installer modules provide", () => {
    const provided = collectProvided(catalog);
    const owner = (kind: keyof typeof provided, value: string) =>
      provided[kind].find((entry) => entry.value === value)?.module;
    expect(owner("claudeMdBlocks", "claude-commit-skill")).toBe("skill-commit");
    expect(owner("claudeMdBlocks", "kaneo-work-tracking-skill")).toBe("skill-kaneo");
    expect(owner("claudeMdBlocks", "gentle-ai:*")).toBe("gentle-ai-claude");
    expect(owner("settings", "/statusLine")).toBe("statusline");
    expect(owner("settings", "/includeCoAuthoredBy")).toBe("skill-commit");
    expect(owner("mcpServers", "kaneo")).toBe("skill-kaneo");
    expect(owner("mcpServers", "codegraph")).toBe("codegraph-claude");
    expect(owner("mcpServers", "engram")).toBe("gentle-ai-claude");
    expect(owner("mcpServers", "context7")).toBe("mcp-context7");
    expect(owner("hooks", "herdr-agent-state.sh")).toBe("herdr-claude");
    expect(owner("paths", "skills/sdd-*")).toBe("gentle-ai-claude");
    // herdr-config writes outside the Claude dir; engram-claude is a fallback for what
    // gentle-ai-claude provides.
    for (const id of [...INSTALLERS, ...Object.keys(SETUPS)].filter(
      (id) => id !== "herdr-config" && id !== "engram-claude",
    )) {
      expect(byId.get(id)?.provides, id).toBeTruthy();
    }
  });

  it("plans the full profile against an empty claude dir", () => {
    const p = plan({
      catalog,
      claudeDir: "/nonexistent/ccc-catalog-test",
      profile: "full",
      env: { PATH: "/nonexistent" },
    });
    const actions = Object.fromEntries(p.modules.map((m) => [m.id, m.steps[0]?.action]));
    expect(actions).toEqual({
      "core-settings": "create",
      "global-instructions": "create",
      "mcp-context7": "skip",
      "skill-commit": "skip",
    });
  });

  it("keeps installer-managed CLAUDE.md blocks in the starter instructions", () => {
    expect(byId.get("global-instructions")?.steps[0]).toMatchObject({ preserveBlocks: true });
    const md = readFileSync(join(catalogDir, "modules/global-instructions/CLAUDE.md"), "utf8");
    expect(md.length).toBeGreaterThan(0);
  });
});
