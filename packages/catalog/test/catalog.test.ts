import { loadCatalog, plan } from "@claude-curated/core";
import { describe, expect, it } from "vitest";
import { catalogDir } from "../index.js";

describe("seed catalog", () => {
  const catalog = loadCatalog(catalogDir);

  // Captured `personal-*` modules may be committed next to the seed modules.
  const seed = catalog.modules.filter((m) => !m.id.startsWith("personal-"));

  it("validates and exposes the seed modules", () => {
    expect(seed.map((m) => m.id)).toEqual([
      "core-settings",
      "global-instructions",
      "mcp-context7",
      "skill-commit",
    ]);
  });

  it("defines minimal and full profiles", () => {
    const profiles = Object.fromEntries(catalog.profiles.map((p) => [p.id, p.modules]));
    expect(profiles.minimal).toEqual(["core-settings", "global-instructions"]);
    expect(profiles.full).toEqual(seed.map((m) => m.id));
  });

  it("lists minimal before full", () => {
    expect(catalog.profiles.map((p) => [p.id, p.order]).slice(0, 2)).toEqual([
      ["minimal", 10],
      ["full", 20],
    ]);
  });

  it("plans the full profile against an empty claude dir", () => {
    const p = plan({
      catalog,
      claudeDir: "/nonexistent/ccc-catalog-test",
      profile: "full",
      env: { PATH: "/usr/bin:/bin" },
    });
    const actions = Object.fromEntries(p.modules.map((m) => [m.id, m.steps[0]?.action]));
    expect(actions).toEqual({
      "core-settings": "create",
      "global-instructions": "create",
      "mcp-context7": "skip",
      "skill-commit": "create",
    });
  });

  it("ships a skill with valid frontmatter", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const skill = readFileSync(join(catalogDir, "modules/skill-commit/SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: commit\ndescription: .+\n---\n/);
  });
});
