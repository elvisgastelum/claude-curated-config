import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apply,
  CAPTURE_IGNORE,
  captureClaudeConfig,
  collectProvided,
  doctor,
  findManagedBlocks,
  loadCatalog,
  neededValues,
  plan,
  requiredSecrets,
  status,
  stripManagedBlocks,
  writeCapture,
} from "../src/index";
import { fakeBin, tempDir, writeCatalog } from "./helpers";

function put(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** A fake bin that appends its name and argv to `log`, then exits with `code`. */
function recorder(log: string, names: string[], code = 0): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => [name, `echo "${name} $*" >> '${log}'\nexit ${code}`]),
  );
}

describe("command step validation", () => {
  const load = (step: unknown) =>
    loadCatalog(writeCatalog([{ id: "m", steps: [{ type: "command", ...(step as object) }] }]));

  it("requires exactly one of run and shell", () => {
    expect(() => load({})).toThrow(/exactly one of run or shell/);
    expect(() => load({ run: ["x"], shell: "x" })).toThrow(/exactly one of run or shell/);
    expect(() => load({ shell: "" })).toThrow(/shell must be a non-empty string/);
    expect(() => load({ shell: "echo hi" })).not.toThrow();
  });

  it("validates os, env, checkShell, interactive and globalOnly", () => {
    expect(() => load({ run: ["x"], os: ["plan9"] })).toThrow(/os must be/);
    expect(() => load({ run: ["x"], os: [] })).toThrow(/os must be/);
    expect(() => load({ run: ["x"], env: { "BAD-NAME": "x" } })).toThrow(/env/);
    expect(() => load({ run: ["x"], env: { OK: 1 } })).toThrow(/env/);
    expect(() => load({ run: ["x"], check: ["y"], checkShell: "y" })).toThrow(
      /check or checkShell/,
    );
    expect(() => load({ run: ["x"], interactive: "yes" })).toThrow(/interactive/);
    expect(() => load({ run: ["x"], globalOnly: 1 })).toThrow(/globalOnly/);
    expect(() =>
      load({
        run: ["x"],
        os: ["darwin", "linux"],
        env: { A: "b" },
        checkShell: "true",
        interactive: true,
        globalOnly: true,
      }),
    ).not.toThrow();
  });

  it("validates provides", () => {
    const withProvides = (provides: unknown) =>
      loadCatalog(writeCatalog([{ id: "m", steps: [], provides: provides as never }]));
    expect(() => withProvides({ paths: "x" })).toThrow(/provides/);
    expect(() => withProvides({ bogus: ["x"] })).toThrow(/provides/);
    expect(() => withProvides({ settings: ["no-slash"] })).toThrow(/JSON pointer/);
    expect(() => withProvides({ paths: ["../x"] })).toThrow(/relative/);
    const catalog = withProvides({
      paths: ["skills/x"],
      settings: ["/theme"],
      hooks: ["gentle-ai "],
      claudeMdBlocks: ["gentle-ai:*"],
      mcpServers: ["kaneo"],
    });
    expect(catalog.modules[0]?.provides?.mcpServers).toEqual(["kaneo"]);
  });

  it("validates array-item settings provides", () => {
    const withSettings = (settings: unknown) =>
      loadCatalog(writeCatalog([{ id: "m", steps: [], provides: { settings } as never }]));
    expect(() => withSettings([{ pointer: "/permissions/allow" }])).toThrow(/items or match/);
    expect(() => withSettings([{ pointer: "nope", items: ["x"] }])).toThrow(/JSON pointer/);
    expect(() => withSettings([{ pointer: "/a", items: "x" }])).toThrow(/items/);
    expect(() => withSettings([{ pointer: "/a", match: [1] }])).toThrow(/match/);
    expect(() => withSettings([{ pointer: "/a", items: ["x"], extra: 1 }])).toThrow(/extra/);
    const catalog = withSettings([
      "/theme",
      { pointer: "/permissions/allow", match: ["mcp__codegraph__*"] },
      { pointer: "/permissions/deny", items: ["Read(.env)"] },
    ]);
    expect(catalog.modules[0]?.provides?.settings).toHaveLength(3);
    const provided = collectProvided(catalog);
    expect(provided.settings[1]).toEqual({
      value: "/permissions/allow",
      module: "m",
      match: ["mcp__codegraph__*"],
    });
  });
});

describe("command step os filter", () => {
  const catalog = () =>
    loadCatalog(
      writeCatalog([
        { id: "mac", steps: [{ type: "command", shell: "true", os: ["darwin"] }] },
        { id: "any", steps: [{ type: "command", shell: "true" }] },
      ]),
    );

  it("skips a step for another OS with a reason", () => {
    const p = plan({
      catalog: catalog(),
      claudeDir: tempDir(),
      modules: ["mac", "any"],
      platform: "linux",
    });
    expect(p.modules[0]?.steps[0]).toMatchObject({ action: "skip" });
    expect(p.modules[0]?.steps[0]?.reason).toMatch(/only on darwin.*linux/);
    expect(p.modules[1]?.steps[0]?.action).toBe("run");
    const result = apply(p);
    expect(result.ok).toBe(true);
    expect(result.modules[0]?.steps[0]?.status).toBe("skipped");
  });

  it("runs the step on a matching OS", () => {
    const p = plan({
      catalog: catalog(),
      claudeDir: tempDir(),
      modules: ["mac"],
      platform: "darwin",
    });
    expect(p.modules[0]?.steps[0]?.action).toBe("run");
  });
});

describe("shell steps and env", () => {
  it("runs shell with bash, stdin closed, pipefail on, and expands env values", () => {
    const out = tempDir();
    const claudeDir = tempDir();
    const log = join(out, "env.log");
    const catalog = loadCatalog(
      writeCatalog([
        {
          id: "sh",
          secrets: [{ name: "CCC_SECRET_TOKEN", description: "t" }],
          steps: [
            {
              type: "command",
              shell: `echo "$DIR|$CFG|$HOMEISH|$TILDE|$TOKEN|$URL|$OVERRIDE|$CCC_CLAUDE_DIR" > '${log}'; read -r line || echo "stdin-empty" >> '${log}'`,
              env: {
                DIR: `\${CCC_CLAUDE_DIR}`,
                CFG: `\${CCC_CLAUDE_JSON}`,
                HOMEISH: "$HOME/x",
                TILDE: "~/y",
                TOKEN: `\${CCC_SECRET_TOKEN}`,
                URL: `\${CCC_TEST_UNSET:-https://example.test}`,
                OVERRIDE: `\${CCC_TEST_SET:-default}`,
              },
            },
          ],
        },
      ]),
    );
    const home = tempDir();
    const env = { PATH: "/usr/bin:/bin", HOME: home, CCC_TEST_SET: "from-env" };
    const p = plan({
      catalog,
      claudeDir,
      modules: ["sh"],
      env,
      secrets: { CCC_SECRET_TOKEN: "s3" },
    });
    expect(p.modules[0]?.steps[0]?.command?.slice(0, 2)).toEqual(["bash", "-c"]);
    const result = apply(p, { env });
    expect(result.ok).toBe(true);
    const [line, stdin] = readFileSync(log, "utf8").trim().split("\n");
    expect(line?.split("|")).toEqual([
      claudeDir,
      join(claudeDir, ".claude.json"),
      `${home}/x`,
      `${home}/y`,
      "s3",
      "https://example.test",
      "from-env",
      claudeDir,
    ]);
    expect(stdin).toBe("stdin-empty");
  });

  it("fails a piped shell step when an earlier command in the pipe fails", () => {
    const catalog = loadCatalog(
      writeCatalog([{ id: "pipe", steps: [{ type: "command", shell: "false | cat" }] }]),
    );
    const result = apply(plan({ catalog, claudeDir: tempDir(), modules: ["pipe"] }));
    expect(result.modules[0]?.steps[0]?.status).toBe("failed");
  });

  it("uses checkShell for idempotency", () => {
    const marker = join(tempDir(), "installed");
    const catalog = loadCatalog(
      writeCatalog([
        {
          id: "once",
          steps: [
            { type: "command", shell: `touch '${marker}'`, checkShell: `test -f '${marker}'` },
          ],
        },
      ]),
    );
    const claudeDir = tempDir();
    const first = plan({ catalog, claudeDir, modules: ["once"] });
    expect(first.modules[0]?.steps[0]?.action).toBe("run");
    expect(apply(first).modules[0]?.steps[0]?.status).toBe("done");
    expect(plan({ catalog, claudeDir, modules: ["once"] }).modules[0]?.steps[0]?.action).toBe(
      "unchanged",
    );
  });

  it("skips globalOnly steps unless the target is ~/.claude", () => {
    const home = tempDir();
    const log = join(home, "calls.log");
    const env = { ...fakeBin(recorder(log, ["tool"])), HOME: home };
    const catalog = loadCatalog(
      writeCatalog([
        { id: "g", steps: [{ type: "command", run: ["tool", "setup"], globalOnly: true }] },
      ]),
    );
    const other = plan({ catalog, claudeDir: tempDir(), modules: ["g"], env });
    expect(other.modules[0]?.steps[0]?.action).toBe("skip");
    expect(other.modules[0]?.steps[0]?.reason).toMatch(/~\/\.claude/);
    const global = plan({ catalog, claudeDir: join(home, ".claude"), modules: ["g"], env });
    expect(global.modules[0]?.steps[0]?.action).toBe("run");
    expect(apply(global, { env }).ok).toBe(true);
    expect(readFileSync(log, "utf8")).toBe("tool setup\n");
  });
});

describe("managed CLAUDE.md blocks", () => {
  const text = [
    "<!-- gentle-ai:engram -->",
    "engram rules",
    "<!-- /gentle-ai:engram -->",
    "",
    "# Mine",
    "keep me",
    "",
    "<!-- gentle-ai:routing -->",
    "<!-- gentle-ai:inner -->",
    "nested",
    "<!-- /gentle-ai:inner -->",
    "<!-- /gentle-ai:routing -->",
    "",
    "<!-- BEGIN claude-commit-skill: managed by install.sh -->",
    "## No AI attribution",
    "<!-- END claude-commit-skill -->",
    "",
    "## Also mine",
    "",
  ].join("\n");

  it("finds top-level blocks in both marker styles", () => {
    expect(findManagedBlocks(text).map((b) => b.name)).toEqual([
      "gentle-ai:engram",
      "gentle-ai:routing",
      "claude-commit-skill",
    ]);
  });

  it("strips matching blocks (globs allowed) and keeps the rest", () => {
    const stripped = stripManagedBlocks(text, ["gentle-ai:*", "claude-commit-skill"]);
    expect(stripped.text).toBe("# Mine\nkeep me\n\n## Also mine\n");
    expect(stripped.removed).toEqual([
      "gentle-ai:engram",
      "gentle-ai:routing",
      "claude-commit-skill",
    ]);
    expect(stripManagedBlocks(text, ["gentle-ai:engram"]).text).toContain("claude-commit-skill");
  });

  it("file steps with preserveBlocks keep managed blocks already in the destination", () => {
    const claudeDir = tempDir();
    const catalog = loadCatalog(
      writeCatalog([
        {
          id: "md",
          files: { "CLAUDE.md": "# Mine\nkeep me\n" },
          steps: [{ type: "file", src: "CLAUDE.md", dest: "CLAUDE.md", preserveBlocks: true }],
        },
      ]),
    );
    put(claudeDir, "CLAUDE.md", `old\n\n${text}`);
    const first = apply(plan({ catalog, claudeDir, modules: ["md"] }));
    expect(first.modules[0]?.steps[0]?.status).toBe("done");
    const written = readFileSync(join(claudeDir, "CLAUDE.md"), "utf8");
    expect(written.startsWith("# Mine\nkeep me\n")).toBe(true);
    expect(written).not.toContain("old");
    expect(findManagedBlocks(written).map((b) => b.name)).toEqual([
      "gentle-ai:engram",
      "gentle-ai:routing",
      "claude-commit-skill",
    ]);
    expect(plan({ catalog, claudeDir, modules: ["md"] }).modules[0]?.steps[0]?.action).toBe(
      "unchanged",
    );
  });
});

describe("provides-aware capture", () => {
  function setup() {
    const root = tempDir("ccc-provides-");
    const claudeDir = join(root, "claude");
    const claudeJson = join(root, "claude.json");
    put(
      claudeDir,
      "CLAUDE.md",
      "<!-- gentle-ai:orchestrator -->\nrules\n<!-- /gentle-ai:orchestrator -->\n\n# Personal\nmine\n\n<!-- BEGIN claude-commit-skill: managed -->\nno ai\n<!-- END claude-commit-skill -->\n",
    );
    put(
      claudeDir,
      "settings.json",
      JSON.stringify({
        theme: "custom:gentleman",
        includeCoAuthoredBy: false,
        statusLine: { type: "command", command: `bash ${join(claudeDir, "statusline.sh")}` },
        model: "opus",
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "gentle-ai sdd-preflight-hook --agent claude-code" },
                { type: "command", command: "~/.claude/hooks/commit-guard.sh" },
              ],
            },
          ],
          Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }],
        },
      }),
    );
    put(claudeDir, "statusline.sh", "#!/bin/sh\necho hi\n");
    put(claudeDir, "skills/sdd-apply/SKILL.md", "---\nname: sdd-apply\n---\n");
    put(claudeDir, "skills/mine/SKILL.md", "---\nname: mine\n---\n");
    put(claudeDir, "skills/synced/docx/SKILL.md", "---\nname: docx\n---\n");
    put(claudeDir, "skills/homelab-service-manager/SKILL.md", "---\nname: h\n---\n");
    put(claudeDir, "agents/sdd-apply.md", "# sdd\n");
    put(claudeDir, "agents/mine.md", "# mine\n");
    put(claudeDir, "commands/gentle-sdd-new.md", "x\n");
    put(
      dirname(claudeJson),
      "claude.json",
      JSON.stringify({
        mcpServers: { kaneo: { type: "http", url: "https://k" }, own: { command: "own" } },
      }),
    );
    const catalogDir = writeCatalog([
      {
        id: "gentle",
        steps: [],
        provides: {
          paths: ["skills/sdd-*", "agents/sdd-*.md", "commands/gentle-sdd-*"],
          settings: ["/theme"],
          hooks: ["gentle-ai "],
          claudeMdBlocks: ["gentle-ai:*"],
        },
      },
      {
        id: "commit",
        steps: [],
        provides: {
          settings: ["/includeCoAuthoredBy"],
          hooks: ["hooks/commit-guard.sh"],
          claudeMdBlocks: ["claude-commit-skill"],
        },
      },
      {
        id: "status",
        steps: [],
        provides: { paths: ["statusline.sh"], settings: ["/statusLine"] },
      },
      { id: "kaneo", steps: [], provides: { mcpServers: ["kaneo"] } },
      // Personal modules never hide anything from a capture.
      { id: "personal-skill-mine", steps: [], provides: { paths: ["skills/mine"] } },
    ]);
    return { root, claudeDir, claudeJson, catalogDir };
  }

  it("collects provides from non-personal modules", () => {
    const { catalogDir } = setup();
    const provided = collectProvided(loadCatalog(catalogDir));
    expect(provided.paths.map((p) => p.module)).not.toContain("personal-skill-mine");
    expect(provided.mcpServers).toEqual([{ value: "kaneo", module: "kaneo" }]);
  });

  it("skips provided and ignored items, drops provided settings, hooks and MCP servers", () => {
    const { claudeDir, claudeJson, catalogDir } = setup();
    const provided = collectProvided(loadCatalog(catalogDir));
    const result = captureClaudeConfig({ claudeDir, claudeJson, provided });
    expect(result.items.map((i) => i.id).sort()).toEqual([
      "personal-agent-mine",
      "personal-claude-md",
      "personal-mcp-own",
      "personal-settings",
      "personal-skill-mine",
    ]);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));
    expect(reasons).toMatchObject({
      "skills/sdd-apply/": "provided by gentle",
      "agents/sdd-apply.md": "provided by gentle",
      "commands/gentle-sdd-new.md": "provided by gentle",
      "skills/synced/": "ignored (never captured)",
      "skills/homelab-service-manager/": "ignored (never captured)",
      "statusline.sh": "provided by status",
      ".claude.json /mcpServers/kaneo": "provided by kaneo",
      "settings.json /theme": "provided by gentle",
      "settings.json /includeCoAuthoredBy": "provided by commit",
      "settings.json /statusLine": "provided by status",
      "CLAUDE.md <!-- gentle-ai:orchestrator -->": "provided by gentle",
      "CLAUDE.md <!-- claude-commit-skill -->": "provided by commit",
    });
    expect(CAPTURE_IGNORE).toEqual(["skills/synced", "skills/homelab-service-manager"]);

    const settings = JSON.parse(
      result.items.find((i) => i.id === "personal-settings")?.files[0]?.content.toString() ?? "{}",
    );
    expect(settings).toEqual({
      model: "opus",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }] },
    });
    const md = result.items.find((i) => i.id === "personal-claude-md");
    expect(md?.files[0]?.content.toString()).toBe("# Personal\nmine\n");
    expect(md?.steps[0]).toMatchObject({ type: "file", dest: "CLAUDE.md", preserveBlocks: true });
  });

  it("drops provided array items from captured settings and keeps the rest", () => {
    const root = tempDir("ccc-items-");
    const claudeDir = join(root, "claude");
    put(
      claudeDir,
      "settings.json",
      JSON.stringify({
        permissions: {
          allow: ["mcp__codegraph__*", "mcp__codegraph__codegraph_explore", "Bash(ls:*)"],
          deny: ["Read(.env)", "Read(.ssh/*)", "Read(.ssh/id_mine)"],
          defaultMode: "auto",
        },
        env: { ONLY: ["mcp__codegraph__x"] },
      }),
    );
    const catalog = loadCatalog(
      writeCatalog([
        {
          id: "codegraph",
          steps: [],
          provides: {
            settings: [{ pointer: "/permissions/allow", match: ["mcp__codegraph__*"] }] as never,
          },
        },
        {
          id: "gentle",
          steps: [],
          provides: {
            settings: [
              { pointer: "/permissions/deny", items: ["Read(.env)", "Read(.ssh/*)"] },
              { pointer: "/env/ONLY", match: ["mcp__*"] },
            ] as never,
          },
        },
      ]),
    );
    const result = captureClaudeConfig({
      claudeDir,
      claudeJson: join(root, "none.json"),
      provided: collectProvided(catalog),
    });
    const settings = JSON.parse(
      result.items.find((i) => i.id === "personal-settings")?.files[0]?.content.toString() ?? "{}",
    );
    // `items` match exactly (Read(.ssh/id_mine) stays); `match` is a wildcard pattern.
    expect(settings).toEqual({
      permissions: { allow: ["Bash(ls:*)"], deny: ["Read(.ssh/id_mine)"], defaultMode: "auto" },
    });
    const reasons = result.skipped.map((s) => `${s.path} => ${s.reason}`);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "settings.json /permissions/allow mcp__codegraph__* => provided by codegraph",
        "settings.json /permissions/allow mcp__codegraph__codegraph_explore => provided by codegraph",
        "settings.json /permissions/deny Read(.env) => provided by gentle",
        "settings.json /env/ONLY mcp__codegraph__x => provided by gentle",
      ]),
    );
  });

  it("reports the status line script as skipped when /statusLine is provided", () => {
    const { claudeDir, claudeJson } = setup();
    const catalog = loadCatalog(
      writeCatalog([{ id: "status", steps: [], provides: { settings: ["/statusLine"] } }]),
    );
    const result = captureClaudeConfig({
      claudeDir,
      claudeJson,
      provided: collectProvided(catalog),
    });
    expect(result.items.map((i) => i.id)).not.toContain("personal-statusline");
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: "statusline.sh", reason: "provided by status" },
        { path: "settings.json /statusLine", reason: "provided by status" },
      ]),
    );
  });

  it("only treats documented marker styles as managed blocks", () => {
    const text = [
      "<!-- BEGIN a.b: note -->",
      "x",
      "<!-- END a.b -->",
      "<!-- ns:y -->",
      "y",
      "<!-- /ns:y -->",
      "<!-- plain -->",
      "z",
      "<!-- /plain -->",
      "",
    ].join("\n");
    expect(findManagedBlocks(text).map((b) => b.name)).toEqual(["a.b", "ns:y"]);
  });

  it("captures everything except the ignore list without provides", () => {
    const { claudeDir, claudeJson } = setup();
    const result = captureClaudeConfig({ claudeDir, claudeJson });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain("personal-skill-sdd-apply");
    expect(ids).not.toContain("personal-skill-synced");
    expect(ids).not.toContain("personal-skill-homelab-service-manager");
  });

  it("merges into an existing personal profile instead of overwriting it", () => {
    const { claudeDir, claudeJson, catalogDir } = setup();
    writeFileSync(
      join(catalogDir, "profiles/personal.json"),
      JSON.stringify({
        id: "personal",
        name: "My machine",
        description: "Installers plus leftovers.",
        order: 30,
        modules: ["gentle", "commit"],
      }),
    );
    const provided = collectProvided(loadCatalog(catalogDir));
    const result = captureClaudeConfig({ claudeDir, claudeJson, provided });
    const written = writeCapture(result, { outDir: catalogDir });
    expect(written.profile.action).toBe("update");
    const profile = JSON.parse(readFileSync(join(catalogDir, "profiles/personal.json"), "utf8"));
    expect(profile.name).toBe("My machine");
    expect(profile.modules.slice(0, 2)).toEqual(["gentle", "commit"]);
    expect(profile.modules).toContain("personal-settings");
    expect(profile.modules).toContain("personal-skill-mine");
    expect(writeCapture(result, { outDir: catalogDir }).profile.action).toBe("unchanged");
    expect(() => loadCatalog(catalogDir)).not.toThrow();
  });
});

describe("doctor installer prerequisites", () => {
  it("checks curl, jq, bash, npm and brew on macOS", () => {
    const env = fakeBin({
      curl: "exit 0",
      jq: "exit 0",
      bash: "exit 0",
      npm: "exit 0",
      npx: "exit 0",
    });
    const report = doctor({ claudeDir: tempDir(), env: { PATH: env.PATH }, platform: "darwin" });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.curl?.ok).toBe(true);
    expect(byId.jq?.ok).toBe(true);
    expect(byId.npm?.ok).toBe(true);
    expect(byId.brew?.ok).toBe(false);
    expect(byId.brew?.required).toBe(false);
    expect(byId.brew?.fix).toMatch(/brew\.sh/);
  });

  it("explains the package manager situation on Linux", () => {
    const report = doctor({
      claudeDir: tempDir(),
      env: { PATH: "/nonexistent" },
      platform: "linux",
    });
    const brew = report.checks.find((c) => c.id === "brew");
    expect(brew?.ok).toBe(false);
    expect(brew?.message).toMatch(/Linux/);
    expect(report.checks.find((c) => c.id === "curl")?.ok).toBe(false);
  });
});

describe("module inputs", () => {
  const inputModule = (log: string) => ({
    id: "kaneo",
    inputs: [{ name: "SERVICE_URL", description: "Base URL of your instance" }],
    steps: [
      {
        type: "command",
        shell: `echo "url=$SERVICE_URL" >> '${log}'`,
        env: { SERVICE_URL: `\${SERVICE_URL}` },
      },
    ],
  });

  it("validates input names", () => {
    const load = (inputs: unknown) =>
      loadCatalog(writeCatalog([{ id: "m", steps: [], inputs: inputs as never }]));
    expect(() => load([{ name: "lower", description: "x" }])).toThrow(/inputs/);
    expect(() => load([{ name: "CCC_SECRET_X", description: "x" }])).toThrow(/inputs/);
    expect(() => load([{ name: "PATH", description: "x" }])).toThrow(/reserved/);
    expect(() => load([{ name: "SERVICE_URL" }])).toThrow(/inputs/);
    expect(load([{ name: "SERVICE_URL", description: "x" }]).modules[0]?.inputs).toEqual([
      { name: "SERVICE_URL", description: "x" },
    ]);
  });

  it("lists inputs as non-secret values and expands them in command env", () => {
    const log = join(tempDir(), "log");
    const catalog = loadCatalog(writeCatalog([inputModule(log)]));
    const env = { PATH: "/usr/bin:/bin" };
    expect(requiredSecrets(catalog, { modules: ["kaneo"] })).toEqual([
      {
        name: "SERVICE_URL",
        description: "Base URL of your instance",
        module: "kaneo",
        secret: false,
      },
    ]);

    const missing = plan({ catalog, claudeDir: tempDir(), modules: ["kaneo"], env });
    const step = missing.modules[0]?.steps[0];
    expect(step).toMatchObject({ action: "skip", blocked: true, needsSecret: "SERVICE_URL" });
    expect(step?.reason).toMatch(/missing input SERVICE_URL/);
    const dry = apply(missing, { dryRun: true, env });
    expect(dry.modules[0]?.steps[0]).toMatchObject({
      status: "planned",
      message: "needs input SERVICE_URL",
    });

    const values = { SERVICE_URL: "https://svc.example.test" };
    const result = apply(
      plan({ catalog, claudeDir: tempDir(), modules: ["kaneo"], env, secrets: values }),
      { env },
    );
    expect(result.modules[0]?.steps[0]?.status).toBe("done");
    expect(readFileSync(log, "utf8")).toBe("url=https://svc.example.test\n");
    // A caller env var of the same name is not used: inputs come only from values.
    const ignored = plan({
      catalog,
      claudeDir: tempDir(),
      modules: ["kaneo"],
      env: { ...env, SERVICE_URL: "https://elsewhere.test" },
    });
    expect(ignored.modules[0]?.steps[0]?.needsSecret).toBe("SERVICE_URL");
  });

  it("needs no input for a step whose check passes, only for steps that will run", () => {
    const claudeDir = tempDir();
    const log = join(tempDir(), "log");
    const catalog = loadCatalog(
      writeCatalog([
        {
          ...inputModule(log),
          steps: [
            {
              ...inputModule(log).steps[0],
              checkShell: 'test -f "$CCC_CLAUDE_DIR/installed"',
            },
          ],
        },
      ]),
    );
    const env = { PATH: "/usr/bin:/bin" };
    const pending = plan({ catalog, claudeDir, modules: ["kaneo"], env });
    expect(pending.modules[0]?.steps[0]).toMatchObject({
      blocked: true,
      needsSecret: "SERVICE_URL",
      needsValues: ["SERVICE_URL"],
    });
    expect(neededValues(pending)).toEqual(["SERVICE_URL"]);
    expect(status({ catalog, claudeDir, env }).modules[0]).toMatchObject({
      state: "needs-secrets",
      missingSecrets: ["SERVICE_URL"],
    });

    writeFileSync(join(claudeDir, "installed"), "");
    const satisfied = plan({ catalog, claudeDir, modules: ["kaneo"], env });
    const step = satisfied.modules[0]?.steps[0];
    expect(step).toMatchObject({ action: "unchanged", reason: "check passed" });
    expect(step?.blocked).toBeUndefined();
    expect(step?.needsSecret).toBeUndefined();
    expect(neededValues(satisfied)).toEqual([]);
    const result = apply(satisfied, { env });
    expect(result.ok).toBe(true);
    expect(result.modules[0]?.steps[0]?.status).toBe("unchanged");
    expect(status({ catalog, claudeDir, env }).modules[0]).toMatchObject({
      state: "applied",
      missingSecrets: [],
    });
  });

  it("blocks a step whose check references a missing input", () => {
    const catalog = loadCatalog(
      writeCatalog([
        {
          id: "env-check",
          inputs: [{ name: "SERVICE_URL", description: "url" }],
          steps: [
            {
              type: "command",
              shell: "true",
              env: { SERVICE_URL: `\${SERVICE_URL}` },
              checkShell: 'test -n "$SERVICE_URL"',
            },
          ],
        },
        {
          id: "placeholder-check",
          inputs: [{ name: "CCC_INPUT_HOST", description: "host" }],
          steps: [{ type: "command", shell: "true", checkShell: `test -n "\${CCC_INPUT_HOST}"` }],
        },
      ]),
    );
    // A same-named caller variable must not satisfy the check either.
    const env = { PATH: "/usr/bin:/bin", SERVICE_URL: "https://elsewhere.test" };
    const planned = plan({
      catalog,
      claudeDir: tempDir(),
      modules: ["env-check", "placeholder-check"],
      env,
    });
    expect(planned.modules.map((m) => m.steps[0])).toMatchObject([
      { action: "skip", blocked: true, needsSecret: "SERVICE_URL" },
      { action: "skip", blocked: true, needsSecret: "CCC_INPUT_HOST" },
    ]);
    expect(neededValues(planned)).toEqual(["SERVICE_URL", "CCC_INPUT_HOST"]);
  });

  it("substitutes CCC_INPUT_* placeholders like secrets", () => {
    const claudeDir = tempDir();
    const catalog = loadCatalog(
      writeCatalog([
        {
          id: "hosts",
          inputs: [{ name: "CCC_INPUT_HOST", description: "a host" }],
          files: { "notes.md": `host: \${CCC_INPUT_HOST}\n` },
          steps: [{ type: "file", src: "notes.md", dest: "notes.md" }],
        },
      ]),
    );
    const secrets = { CCC_INPUT_HOST: "box.example.test" };
    apply(plan({ catalog, claudeDir, modules: ["hosts"], secrets }));
    expect(readFileSync(join(claudeDir, "notes.md"), "utf8")).toBe("host: box.example.test\n");
  });
});

describe("requiresBin lists", () => {
  it("skips a step when any listed binary is missing, naming it", () => {
    const load = (requiresBin: unknown) =>
      loadCatalog(
        writeCatalog([{ id: "m", steps: [{ type: "command", run: ["true"], requiresBin }] }]),
      );
    expect(() => load(["jq", 1])).toThrow(/requiresBin/);
    expect(() => load([])).toThrow(/requiresBin/);
    const env = fakeBin({ toola: "exit 0" });
    const step = (requiresBin: unknown) =>
      plan({ catalog: load(requiresBin), claudeDir: tempDir(), modules: ["m"], env }).modules[0]
        ?.steps[0];
    expect(step(["toola", "missing-jq"])).toMatchObject({
      action: "skip",
      reason: '"missing-jq" not found on PATH',
    });
    expect(step(["toola"])?.action).toBe("run");
  });
});
