import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandStep, collectProvided, loadCatalog } from "@claude-curated/core";
import { afterEach, describe, expect, it } from "vitest";
import { catalogDir } from "../index.js";
import { rewritePins } from "../scripts/bump-installers.mjs";

const SHA = /^[0-9a-f]{40}$/;
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-catalog-"));
  temps.push(dir);
  return dir;
}

const catalog = loadCatalog(catalogDir);
const byId = new Map(catalog.modules.map((m) => [m.id, m]));
const command = (id: string) =>
  byId.get(id)?.steps.find((s): s is CommandStep => s.type === "command") as CommandStep;

/** Runs a step's checkShell like the engine does (bash with pipefail). */
function check(id: string, env: NodeJS.ProcessEnv): number | null {
  const script = command(id).checkShell as string;
  return spawnSync("bash", ["-o", "pipefail", "-c", script], {
    env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin", ...env },
    stdio: "ignore",
  }).status;
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("installer pins", () => {
  const REMOTE = ["skill-commit", "skill-continue", "skill-kaneo", "statusline", "herdr-config"];

  it("pins every remote installer URL to a commit and passes the same ref", () => {
    for (const id of REMOTE) {
      const step = command(id);
      const match =
        /raw\.githubusercontent\.com\/elvisgastelum\/([\w.-]+)\/([^/]+)\/install\.sh/.exec(
          step.shell ?? "",
        );
      expect(match, id).toBeTruthy();
      const sha = match?.[2] ?? "";
      expect(sha, id).toMatch(SHA);
      if (step.env?.REF !== undefined) expect(step.env.REF, id).toBe(sha);
    }
    for (const id of ["skill-commit", "skill-continue", "skill-kaneo"]) {
      expect(command(id).env?.REF, id).toMatch(SHA);
    }
    const statusline = command("statusline");
    expect(statusline.env?.CLAUDE_STATUSLINE_RAW_URL).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/elvisgastelum\/claude-statusline\/[0-9a-f]{40}$/,
    );
    for (const file of allFiles(join(catalogDir, "modules"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /githubusercontent\.com\/[^"\s]+\/main\//,
      );
    }
  });

  it("rewrites pinned SHAs and refs for a repo", () => {
    const old = "a".repeat(40);
    const next = "b".repeat(40);
    const text = JSON.stringify({
      shell: `curl -fsSL https://raw.githubusercontent.com/elvisgastelum/repo-x/${old}/install.sh | bash`,
      env: {
        REF: old,
        CLAUDE_STATUSLINE_RAW_URL: `https://raw.githubusercontent.com/elvisgastelum/repo-x/${old}`,
      },
      other: `https://raw.githubusercontent.com/elvisgastelum/repo-y/${"c".repeat(40)}/install.sh`,
    });
    const { text: out, pins } = rewritePins(text, { "repo-x": next });
    expect(pins).toEqual([
      { repo: "repo-x", sha: old },
      { repo: "repo-y", sha: "c".repeat(40) },
    ]);
    expect(out).not.toContain(`repo-x/${old}`);
    expect(out.match(new RegExp(next, "g"))?.length).toBe(3);
    expect(out).toContain(`repo-y/${"c".repeat(40)}`);
  });
});

describe("kaneo stays private", () => {
  it("has no Kaneo URL in the catalog and asks for KANEO_URL as an input", () => {
    // Assembled at runtime so this file does not contain the host itself.
    const host = ["kaneo", "elvisgastelum", "com"].join(".");
    const files = [
      ...allFiles(join(catalogDir, "modules")),
      ...allFiles(join(catalogDir, "profiles")),
      ...allFiles(join(catalogDir, "test")),
      join(catalogDir, "README.md"),
      join(catalogDir, "../../README.md"),
      join(catalogDir, "../../AGENTS.md"),
    ];
    for (const file of files) expect(readFileSync(file, "utf8"), file).not.toContain(host);
    const kaneo = byId.get("skill-kaneo");
    expect(kaneo?.inputs).toEqual([{ name: "KANEO_URL", description: expect.any(String) }]);
    expect(command("skill-kaneo").env?.KANEO_URL).toBe(`\${KANEO_URL}`);
  });
});

describe("jq-based checks", () => {
  const json = (dir: string, doc: unknown) => {
    const file = join(dir, "claude.json");
    writeFileSync(file, JSON.stringify(doc));
    return file;
  };

  it("checks user-scope MCP servers with jq, not a text grep", () => {
    for (const [id, server] of [
      ["engram-claude", "engram"],
      ["codegraph-claude", "codegraph"],
    ] as const) {
      const dir = temp();
      expect([command(id).requiresBin].flat(), id).toContain("jq");
      const env = (doc: unknown) => ({ HOME: dir, CCC_CLAUDE_JSON: json(dir, doc) });
      expect(check(id, env({ mcpServers: { [server]: { command: server } } })), id).toBe(0);
      expect(check(id, env({ projects: { "/x": { mcpServers: { [server]: {} } } } })), id).not.toBe(
        0,
      );
      expect(check(id, env({ note: `"${server}"` })), id).not.toBe(0);
      expect(check(id, { HOME: dir, CCC_CLAUDE_JSON: join(dir, "missing.json") }), id).not.toBe(0);
    }
    const dir = temp();
    mkdirSync(join(dir, "skills/kaneo-work-tracking"), { recursive: true });
    writeFileSync(join(dir, "skills/kaneo-work-tracking/SKILL.md"), "x");
    expect([command("skill-kaneo").requiresBin].flat()).toContain("jq");
    const kaneo = (doc: unknown) =>
      check("skill-kaneo", { HOME: dir, CCC_CLAUDE_DIR: dir, CCC_CLAUDE_JSON: json(dir, doc) });
    expect(kaneo({ mcpServers: { kaneo: { type: "http" } } })).toBe(0);
    expect(kaneo({ projects: { "/x": { mcpServers: { kaneo: {} } } } })).not.toBe(0);
  });

  it("checks gentle-ai state with jq on installed_agents", () => {
    expect([command("gentle-ai-claude").requiresBin].flat()).toContain("jq");
    const state = (doc: unknown) => {
      const home = temp();
      mkdirSync(join(home, ".gentle-ai"));
      writeFileSync(join(home, ".gentle-ai/state.json"), JSON.stringify(doc));
      return check("gentle-ai-claude", { HOME: home });
    };
    expect(state({ installed_agents: ["opencode", "claude-code"] })).toBe(0);
    expect(state({ installed_agents: ["opencode"], note: "claude-code" })).not.toBe(0);
    expect(check("gentle-ai-claude", { HOME: temp() })).not.toBe(0);
  });

  it("reads herdr integration status without SIGPIPE under pipefail", () => {
    const bin = temp();
    const fake = (body: string) => {
      writeFileSync(join(bin, "herdr"), `#!/bin/bash\n${body}\n`);
      chmodSync(join(bin, "herdr"), 0o755);
    };
    const env = { HOME: temp(), PATH: `${bin}:/usr/bin:/bin` };
    // Much more output than a pipe buffer after the matching line.
    fake(`echo "claude: current (v10)"; yes "other: not installed" | head -n 200000`);
    expect(check("herdr-claude", env)).toBe(0);
    fake(`echo "claude: not installed"; echo "pi: current"`);
    expect(check("herdr-claude", env)).not.toBe(0);
    fake("exit 3");
    expect(check("herdr-claude", env)).not.toBe(0);
  });
});

describe("tool ownership", () => {
  it("gives gentle-ai the engram MCP server and its permission rules; codegraph its allow rules", () => {
    const provided = collectProvided(catalog);
    expect(provided.mcpServers.find((e) => e.value === "engram")?.module).toBe("gentle-ai-claude");
    expect(byId.get("engram-claude")?.provides?.mcpServers ?? []).not.toContain("engram");
    const deny = provided.settings.find(
      (e) => e.module === "gentle-ai-claude" && e.value === "/permissions/deny",
    );
    expect(deny?.items).toEqual(expect.arrayContaining(["Bash(rm -rf /)", "Read(**/*.pem)"]));
    expect(deny?.items).toHaveLength(24);
    const allow = provided.settings.find(
      (e) => e.module === "codegraph-claude" && e.value === "/permissions/allow",
    );
    expect(allow?.match).toEqual(["mcp__codegraph__*"]);
    // engram setup only runs when gentle-ai did not register engram (same jq check).
    expect(command("engram-claude").checkShell).toContain(".mcpServers.engram");
  });

  it("puts core-settings in the personal profile", () => {
    const personal = catalog.profiles.find((p) => p.id === "personal");
    expect(personal?.modules).toContain("core-settings");
  });
});
