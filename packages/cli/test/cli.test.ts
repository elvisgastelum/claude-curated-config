import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_SECRETS, writeClaudeFixture } from "../../core/test/capture-fixture";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccc-cli-"));
  temps.push(dir);
  return dir;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  json: () => Record<string, unknown>;
}

/** Runs the built bin with piped (non-TTY) stdio and a PATH without the real `claude`. */
function ccc(args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    input: "",
    encoding: "utf8",
    env: {
      HOME: temp(),
      PATH: "/usr/bin:/bin",
      NO_COLOR: "1",
      ...env,
    },
  });
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    json: () => JSON.parse(result.stdout),
  };
}

type Mod = { id: string; steps: { action?: string; status?: string }[] };
const actions = (doc: Record<string, unknown>) =>
  (doc.modules as Mod[]).flatMap((m) => m.steps.map((s) => s.action));
const statuses = (doc: Record<string, unknown>) =>
  (doc.modules as Mod[]).flatMap((m) => m.steps.map((s) => s.status));

describe("ccc --cli", () => {
  it("prints the version", () => {
    const run = ccc(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists the catalog as ccc.list/v1", () => {
    const run = ccc(["--cli", "list", "--json"]);
    expect(run.code).toBe(0);
    const doc = run.json();
    expect(doc.schema).toBe("ccc.list/v1");
    expect((doc.profiles as { id: string }[]).map((p) => p.id).slice(0, 2)).toEqual([
      "minimal",
      "full",
    ]);
    expect((doc.modules as { id: string }[]).map((m) => m.id)).toContain("core-settings");
  });

  it("prints JSON list without a subcommand in non-TTY json mode, help otherwise", () => {
    expect(ccc(["--json"]).json().schema).toBe("ccc.list/v1");
    const help = ccc([]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage:");
  });

  it("plans with the ccc.plan/v1 shape", () => {
    const claudeDir = join(temp(), "claude");
    const run = ccc(["--cli", "plan", "--profile", "minimal", "--json", "--claude-dir", claudeDir]);
    expect(run.code).toBe(0);
    const doc = run.json();
    expect(doc.schema).toBe("ccc.plan/v1");
    expect(doc.claudeDir).toBe(claudeDir);
    expect(doc.selection).toEqual({ profile: "minimal", modules: [] });
    expect(doc.summary).toMatchObject({ create: 2, update: 0, unchanged: 0 });
    const first = (doc.modules as Record<string, unknown>[])[0] ?? {};
    expect(first).toMatchObject({ id: "core-settings" });
    expect((first.steps as Record<string, unknown>[])[0]).toMatchObject({
      index: 0,
      type: "json-merge",
      action: "create",
      dest: "settings.json",
    });
    expect(existsSync(claudeDir)).toBe(false);
  });

  it("applies the minimal profile and is idempotent", () => {
    const claudeDir = join(temp(), "claude");
    const args = ["--cli", "apply", "--profile", "minimal", "--yes", "--json"];
    const first = ccc([...args, "--claude-dir", claudeDir]);
    expect(first.code).toBe(0);
    const doc = first.json();
    expect(doc.schema).toBe("ccc.apply/v1");
    expect(doc.ok).toBe(true);
    expect(statuses(doc)).toEqual(["done", "done"]);
    expect(readFileSync(join(claudeDir, "CLAUDE.md"), "utf8")).toContain("EDIT ME");
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.permissions.deny).toContain("Read(**/.env)");

    const second = ccc([...args, "--claude-dir", claudeDir]);
    expect(second.code).toBe(0);
    expect(statuses(second.json())).toEqual(["unchanged", "unchanged"]);
    expect(second.json().backupDir).toBeNull();
  });

  it("supports --dry-run without writing", () => {
    const claudeDir = join(temp(), "claude");
    const run = ccc([
      "--cli",
      "apply",
      "--profile",
      "minimal",
      "--dry-run",
      "--json",
      "--claude-dir",
      claudeDir,
    ]);
    expect(run.code).toBe(0);
    expect(run.json().dryRun).toBe(true);
    expect(existsSync(claudeDir)).toBe(false);
  });

  it("refuses a non-interactive apply without --yes (exit 2, ccc.error/v1)", () => {
    const claudeDir = join(temp(), "claude");
    const run = ccc(["apply", "--profile", "minimal", "--json", "--claude-dir", claudeDir]);
    expect(run.code).toBe(2);
    const doc = run.json();
    expect(doc.schema).toBe("ccc.error/v1");
    expect((doc.error as { code: string }).code).toBe("confirmation_required");
    expect(existsSync(claudeDir)).toBe(false);
    const human = ccc(["apply", "--profile", "minimal", "--claude-dir", claudeDir]);
    expect(human.code).toBe(2);
    expect(human.stderr).toContain("--yes");
  });

  it("exits 3 for an unknown module", () => {
    const run = ccc(["--cli", "plan", "--module", "does-not-exist", "--json"]);
    expect(run.code).toBe(3);
    const doc = run.json();
    expect(doc.schema).toBe("ccc.error/v1");
    expect((doc.error as { code: string }).code).toBe("unknown_module");
  });

  it("exits 2 for usage errors", () => {
    expect(ccc(["--cli", "frobnicate", "--json"]).code).toBe(2);
    expect(ccc(["--cli", "plan", "--json"]).code).toBe(2);
  });

  it("reports status and doctor documents", () => {
    const claudeDir = join(temp(), "claude");
    ccc(["--cli", "apply", "--profile", "minimal", "--yes", "--claude-dir", claudeDir]);
    const status = ccc(["--cli", "status", "--json", "--claude-dir", claudeDir]).json();
    expect(status.schema).toBe("ccc.status/v1");
    const states = Object.fromEntries(
      (status.modules as { id: string; state: string }[]).map((m) => [m.id, m.state]),
    );
    expect(states["core-settings"]).toBe("applied");
    expect(states["skill-commit"]).toBe("not-applied");

    const doctor = ccc(["--cli", "doctor", "--json", "--claude-dir", claudeDir]);
    expect(doctor.code).toBe(0);
    expect(doctor.json().schema).toBe("ccc.doctor/v1");
  });

  it("refuses unresolved settings conflicts (exit 2) and applies them once resolved", () => {
    const claudeDir = join(temp(), "claude");
    mkdirSync(claudeDir);
    const original = JSON.stringify({ $schema: "https://example.com/mine.json" });
    writeFileSync(join(claudeDir, "settings.json"), original);
    const args = ["--cli", "apply", "--profile", "minimal", "--yes", "--json"];

    const refused = ccc([...args, "--claude-dir", claudeDir]);
    expect(refused.code).toBe(2);
    const doc = refused.json();
    expect(doc.schema).toBe("ccc.error/v1");
    const error = doc.error as {
      code: string;
      message: string;
      conflicts: Record<string, unknown>[];
    };
    expect(error.code).toBe("conflicts_unresolved");
    expect(error.conflicts).toEqual([
      expect.objectContaining({
        module: "core-settings",
        path: "/$schema",
        current: "https://example.com/mine.json",
        flags: {
          catalog: "--resolve 'core-settings:/$schema=catalog'",
          keep: "--resolve 'core-settings:/$schema=keep'",
        },
      }),
    ]);
    expect(error.message).toContain("--on-conflict");
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe(original);
    expect(existsSync(join(claudeDir, "CLAUDE.md"))).toBe(false);

    const plan = ccc([
      "--cli",
      "plan",
      "--profile",
      "minimal",
      "--json",
      "--claude-dir",
      claudeDir,
    ]);
    expect((plan.json().conflicts as unknown[]).length).toBe(1);
    const keepPlan = ccc([
      "--cli",
      "plan",
      "--profile",
      "minimal",
      "--json",
      "--on-conflict",
      "keep",
      "--claude-dir",
      claudeDir,
    ]).json();
    expect((keepPlan.conflicts as { resolution: string }[])[0]?.resolution).toBe("keep");

    const kept = ccc([...args, "--on-conflict", "keep", "--claude-dir", claudeDir]);
    expect(kept.code).toBe(0);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(settings.$schema).toBe("https://example.com/mine.json");
    expect(settings.permissions.deny).toContain("Read(**/.env)");

    const replaced = ccc([
      ...args,
      "--resolve",
      "core-settings:/$schema=catalog",
      "--claude-dir",
      claudeDir,
    ]);
    expect(replaced.code).toBe(0);
    const after = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    expect(after.$schema).toContain("schemastore");
  });

  it("rejects a malformed --resolve with exit 2", () => {
    const run = ccc(["--cli", "plan", "--profile", "minimal", "--resolve", "nope", "--json"]);
    expect(run.code).toBe(2);
    expect((run.json().error as { code: string }).code).toBe("invalid_resolve");
  });

  it("runs command steps through a fake claude and skips them without it", () => {
    const binDir = temp();
    const log = join(binDir, "calls.log");
    const fake = join(binDir, "claude");
    writeFileSync(
      fake,
      `#!/bin/sh\necho "$@" >> '${log}'\nif [ "$2" = "get" ]; then exit 1; fi\nexit 0\n`,
    );
    chmodSync(fake, 0o755);
    const claudeDir = join(temp(), "claude");
    mkdirSync(claudeDir);
    const args = ["--cli", "apply", "--module", "mcp-context7", "--yes", "--json"];

    const skipped = ccc([...args, "--claude-dir", claudeDir]);
    expect(statuses(skipped.json())).toEqual(["skipped"]);

    const ran = ccc([...args, "--claude-dir", claudeDir], { PATH: `${binDir}:/usr/bin:/bin` });
    expect(ran.code).toBe(0);
    expect(actions(ran.json())).toEqual(["run"]);
    expect(readFileSync(log, "utf8")).toContain("mcp add --scope user context7");
  });

  it("captures a claude dir into a catalog without leaking secrets, then applies it", () => {
    const home = temp();
    const claudeDir = join(home, ".claude");
    writeClaudeFixture(claudeDir, join(home, ".claude.json"), "~/.claude/statusline.sh");
    mkdirSync(join(claudeDir, "skills/mine"), { recursive: true });
    writeFileSync(join(claudeDir, "skills/mine/SKILL.md"), "---\nname: mine\n---\n");
    writeFileSync(join(claudeDir, "skills/mine/run.sh"), "#!/bin/sh\necho mine\n");
    chmodSync(join(claudeDir, "skills/mine/run.sh"), 0o755);
    const out = join(temp(), "catalog");
    mkdirSync(out);
    const env = { HOME: home };
    const base = ["--cli", "capture", "--json", "--claude-dir", claudeDir, "--out", out];

    const refused = ccc(base, env);
    expect(refused.code).toBe(2);
    expect((refused.json().error as { code: string }).code).toBe("confirmation_required");

    const dry = ccc([...base, "--dry-run"], env);
    expect(dry.code).toBe(0);
    expect(dry.json().dryRun).toBe(true);
    expect(readdirSync(out)).toEqual([]);

    const run = ccc([...base, "--yes"], env);
    expect(run.code).toBe(0);
    const doc = run.json();
    expect(doc.schema).toBe("ccc.capture/v1");
    const ids = (doc.items as { id: string }[]).map((i) => i.id);
    expect(ids).toContain("personal-mcp-github");
    // Provided by catalog installer modules, so not captured again.
    for (const id of ["personal-statusline", "personal-skill-commit", "personal-mcp-context7"]) {
      expect(ids).not.toContain(id);
    }
    expect(doc.skipped).toEqual(
      expect.arrayContaining([
        { path: "statusline.sh", reason: "provided by statusline" },
        { path: "skills/commit/", reason: "provided by skill-commit" },
        { path: ".claude.json /mcpServers/context7", reason: "provided by mcp-context7" },
      ]),
    );
    expect((doc.redactions as unknown[]).length).toBeGreaterThan(0);
    for (const secret of FAKE_SECRETS) {
      expect(run.stdout).not.toContain(secret);
      expect(run.stderr).not.toContain(secret);
    }
    for (const file of readdirSync(out, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const text = readFileSync(join(file.parentPath, file.name), "utf8");
      for (const secret of FAKE_SECRETS) expect(text).not.toContain(secret);
    }
    const again = ccc([...base, "--yes"], env).json();
    expect((again.items as { action: string }[]).every((item) => item.action === "unchanged")).toBe(
      true,
    );

    const target = join(temp(), "claude");
    const applyArgs = [
      "--cli",
      "apply",
      "--profile",
      "personal",
      "--yes",
      "--json",
      "--catalog",
      out,
      "--claude-dir",
      target,
    ];
    const dryApply = ccc([...applyArgs, "--dry-run"], env);
    expect(dryApply.code).toBe(0);
    expect(dryApply.json().ok).toBe(true);
    expect(dryApply.stdout).toContain("needs secret CCC_SECRET_SETTINGS_ANTHROPIC_API_KEY");
    expect(existsSync(target)).toBe(false);

    const missing = ccc(applyArgs, env);
    expect(missing.code).toBe(2);
    const error = missing.json().error as { code: string; secrets: { name: string }[] };
    expect(error.code).toBe("secrets_missing");
    expect(error.secrets.map((s) => s.name)).toContain("CCC_SECRET_SETTINGS_ANTHROPIC_API_KEY");
    expect(existsSync(target)).toBe(false);

    const planned = ccc(
      [
        "--cli",
        "plan",
        "--profile",
        "personal",
        "--json",
        "--catalog",
        out,
        "--claude-dir",
        target,
      ],
      env,
    ).json();
    expect((planned.secrets as { provided: boolean }[]).every((s) => !s.provided)).toBe(true);

    const values = Object.fromEntries(error.secrets.map((s) => [s.name, `env-${s.name}`]));
    const applied = ccc(applyArgs, { ...env, ...values });
    expect(applied.code).toBe(0);
    expect(applied.stdout).not.toContain("env-CCC_SECRET");
    const settings = JSON.parse(readFileSync(join(target, "settings.json"), "utf8"));
    expect(settings.env.ANTHROPIC_API_KEY).toBe("env-CCC_SECRET_SETTINGS_ANTHROPIC_API_KEY");
    expect(statSync(join(target, "skills/mine/run.sh")).mode & 0o100).toBe(0o100);
  });

  it("requires --out when the catalog is the installer checkout or not in a git checkout", () => {
    const home = temp();
    const claudeDir = join(home, ".claude");
    writeClaudeFixture(claudeDir, join(home, ".claude.json"), "~/.claude/statusline.sh");
    const checkout = temp();
    mkdirSync(join(checkout, ".git"));
    const catalog = join(checkout, "packages/catalog");
    mkdirSync(join(catalog, "modules"), { recursive: true });
    mkdirSync(join(catalog, "profiles"));
    const args = (cat: string) => [
      "--cli",
      "capture",
      "--json",
      "--dry-run",
      "--claude-dir",
      claudeDir,
      "--catalog",
      cat,
    ];

    const installed = ccc(args(catalog), { HOME: home, CCC_HOME: checkout });
    expect(installed.code).toBe(2);
    expect((installed.json().error as { code: string }).code).toBe("out_required");

    const defaultHome = join(home, ".local/share/claude-curated-config");
    mkdirSync(join(defaultHome, ".git"), { recursive: true });
    mkdirSync(join(defaultHome, "packages/catalog"), { recursive: true });
    const viaDefault = ccc(args(join(defaultHome, "packages/catalog")), { HOME: home });
    expect((viaDefault.json().error as { code: string }).code).toBe("out_required");

    const loose = temp();
    const notGit = ccc(args(loose), { HOME: home });
    expect(notGit.code).toBe(2);
    expect((notGit.json().error as { code: string }).code).toBe("out_required");

    const clone = ccc(args(catalog), { HOME: home });
    expect(clone.code).toBe(0);
    expect(clone.json().outDir).toBe(catalog);

    const explicit = ccc([...args(loose), "--out", join(loose, "out")], {
      HOME: home,
      CCC_HOME: checkout,
    });
    expect(explicit.code).toBe(0);
  });

  it("status honors --on-conflict/--resolve and reports conflicts", () => {
    const claudeDir = join(temp(), "claude");
    ccc(["--cli", "apply", "--profile", "minimal", "--yes", "--claude-dir", claudeDir]);
    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    settings.$schema = "https://example.com/mine.json";
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(settings));
    const state = (extra: string[]) =>
      (
        ccc(["--cli", "status", "--json", "--claude-dir", claudeDir, ...extra]).json().modules as {
          id: string;
          state: string;
        }[]
      ).find((m) => m.id === "core-settings")?.state;
    expect(state([])).toBe("conflicts");
    expect(state(["--on-conflict", "keep"])).toBe("applied");
    expect(state(["--resolve", "core-settings:/$schema=keep"])).toBe("applied");
  });

  it("warns when a catalog's provides cannot be loaded and refuses an invalid personal profile", () => {
    const home = temp();
    const claudeDir = join(home, ".claude");
    writeClaudeFixture(claudeDir, join(home, ".claude.json"), "~/.claude/statusline.sh");
    const out = join(temp(), "catalog");
    mkdirSync(join(out, "modules/broken"), { recursive: true });
    writeFileSync(join(out, "modules/broken/module.json"), "{ nope");
    const base = ["--cli", "capture", "--json", "--claude-dir", claudeDir, "--out", out];

    const dry = ccc([...base, "--dry-run"], { HOME: home });
    expect(dry.code).toBe(0);
    expect(dry.json().warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/provides of .*catalog.* not loaded/)]),
    );

    mkdirSync(join(out, "profiles"), { recursive: true });
    writeFileSync(join(out, "profiles/personal.json"), "{ broken");
    const refused = ccc([...base, "--yes"], { HOME: home });
    expect(refused.code).toBe(3);
    const error = refused.json().error as { code: string; message: string };
    expect(error.code).toBe("invalid_profile");
    expect(error.message).toMatch(/fix or remove it/);
    expect(readFileSync(join(out, "profiles/personal.json"), "utf8")).toBe("{ broken");
  });

  it("reads module inputs from the env and exits 2 inputs_missing without them", () => {
    const catalog = temp();
    const log = join(temp(), "log");
    mkdirSync(join(catalog, "modules/svc"), { recursive: true });
    mkdirSync(join(catalog, "profiles"));
    writeFileSync(
      join(catalog, "modules/svc/module.json"),
      JSON.stringify({
        id: "svc",
        name: "Service",
        description: "Registers a service by URL.",
        inputs: [{ name: "SVC_URL", description: "Base URL of your service" }],
        steps: [
          {
            type: "command",
            shell: `echo "$SVC_URL" >> '${log}'`,
            env: { SVC_URL: `\${SVC_URL}` },
          },
        ],
      }),
    );
    const args = ["--cli", "--catalog", catalog, "--claude-dir", join(temp(), "c"), "--json"];

    const plan = ccc([...args, "plan", "-m", "svc"]).json();
    expect(plan.secrets).toEqual([
      {
        name: "SVC_URL",
        description: "Base URL of your service",
        module: "svc",
        secret: false,
        provided: false,
      },
    ]);
    const missing = ccc([...args, "apply", "-m", "svc", "--yes"]);
    expect(missing.code).toBe(2);
    const error = missing.json().error as { code: string; inputs: { name: string }[] };
    expect(error.code).toBe("inputs_missing");
    expect(error.inputs.map((i) => i.name)).toEqual(["SVC_URL"]);
    expect(existsSync(log)).toBe(false);

    const ok = ccc([...args, "apply", "-m", "svc", "--yes"], {
      SVC_URL: "https://svc.example.test",
    });
    expect(ok.code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe("https://svc.example.test\n");
  });

  it("flags private infrastructure in capture output using CCC_PRIVATE_DOMAINS", () => {
    const home = temp();
    const claudeDir = join(home, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# Me\n- API at api.example-private.com\n");
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { svc: { type: "http", url: "http://192.168.7.7:8080/mcp" } } }),
    );
    const out = join(temp(), "catalog");
    const run = ccc(
      ["--cli", "capture", "--json", "--claude-dir", claudeDir, "--out", out, "--yes"],
      { HOME: home, CCC_PRIVATE_DOMAINS: "example-private.com" },
    );
    expect(run.code).toBe(0);
    expect(run.stdout).not.toMatch(/example-private|192\.168\.7\.7/);
    const doc = run.json();
    const privacy = doc.privacy as { module: string; location: string; placeholder: string }[];
    expect(privacy.map((p) => p.module).sort()).toEqual(["personal-claude-md", "personal-mcp-svc"]);
    const items = doc.items as { id: string; inputs: string[] }[];
    expect(items.find((i) => i.id === "personal-mcp-svc")?.inputs).toEqual([
      "CCC_INPUT_MCP_SVC_URL",
    ]);
    const files = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
      .join("\n");
    expect(files).not.toMatch(/example-private|192\.168\.7\.7/);
    expect(files).toContain("CCC_INPUT_");
  });

  it("rejects an unknown capture kind with exit 2", () => {
    const run = ccc(["--cli", "capture", "--include", "nope", "--dry-run", "--json"]);
    expect(run.code).toBe(2);
    expect((run.json().error as { code: string }).code).toBe("invalid_include");
  });
});

/** Fake tool scripts: each records its argv in `log`, then simulates what the real tool does. */
const TOOL_FAKES: Record<string, string> = {
  "gentle-ai": `if [ "$1" = install ]; then mkdir -p "$HOME/.gentle-ai"; echo '{"installed_agents":["claude-code"]}' > "$HOME/.gentle-ai/state.json"; fi`,
  engram: `if [ "$1" = setup ]; then echo '"engram"' >> "$HOME/.claude.json"; fi`,
  codegraph: `if [ "$1" = install ]; then echo '"codegraph"' >> "$HOME/.claude.json"; fi`,
  herdr: [
    `case "$1 $2" in`,
    `  "integration install") touch "$HOME/.herdr-claude" ;;`,
    `  "integration status") [ -f "$HOME/.herdr-claude" ] && echo "claude: current (v10)" ;;`,
    "esac",
    "exit 0",
  ].join("\n"),
};

/** What the fake `curl` prints for each installer URL (run by the real bash/sh). */
const CURL_FAKE = [
  `case "$*" in`,
  `  *claude-commit-skill*) echo 'mkdir -p "$CLAUDE_DIR/skills/commit" "$CLAUDE_DIR/hooks" && touch "$CLAUDE_DIR/skills/commit/SKILL.md" "$CLAUDE_DIR/hooks/commit-guard.sh" && printf "<!-- BEGIN claude-commit-skill -->\\nno ai\\n<!-- END claude-commit-skill -->\\n" >> "$CLAUDE_DIR/CLAUDE.md"' ;;`,
  `  *kaneo-work-tracking-skill*) echo 'mkdir -p "$CLAUDE_DIR/skills/kaneo-work-tracking" && touch "$CLAUDE_DIR/skills/kaneo-work-tracking/SKILL.md" && echo "\\"kaneo\\" $KANEO_URL" >> "$CLAUDE_JSON"' ;;`,
  `  *claude-continue-skill*) echo 'mkdir -p "$CLAUDE_DIR/skills/continue" && touch "$CLAUDE_DIR/skills/continue/SKILL.md"' ;;`,
  `  *claude-statusline*) echo 'touch "$CLAUDE_CONFIG_DIR/statusline.sh" && echo "{\\"statusLine\\":{\\"command\\":\\"bash statusline.sh\\"}}" > "$CLAUDE_CONFIG_DIR/settings.json"' ;;`,
  `  *herdr-config*) echo 'mkdir -p "$HOME/.local/bin" && printf "#!/bin/sh\\n" > "$HOME/.local/bin/herdr-config" && chmod +x "$HOME/.local/bin/herdr-config"' ;;`,
  "esac",
].join("\n");

/**
 * A PATH dir with fake brew, npm, npx and curl. `brew install` and `npm install -g` "install"
 * the matching fake tool into the dir, so setup modules only find their tool after the install.
 */
function fakeToolbox(home: string): { bin: string; log: string } {
  const bin = join(home, "bin");
  const tools = join(home, "tool-fakes");
  const log = join(home, "calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(tools, { recursive: true });
  const write = (dir: string, name: string, body: string) => {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${log}'\n${body}\n`);
    chmodSync(file, 0o755);
  };
  for (const [name, body] of Object.entries(TOOL_FAKES)) write(tools, name, body);
  write(bin, "brew", `name=$(basename "$2"); cp '${tools}'/"$name" '${bin}'/"$name"`);
  write(bin, "npm", `cp '${tools}/codegraph' '${bin}/codegraph'`);
  write(
    bin,
    "npx",
    `mkdir -p "$HOME/.claude/skills/configure-env" && touch "$HOME/.claude/skills/configure-env/SKILL.md"`,
  );
  write(bin, "curl", CURL_FAKE);
  return { bin, log };
}

describe("personal profile with fake installers", () => {
  const RAW = "https://raw.githubusercontent.com/elvisgastelum";

  it("installs tools before their setup, runs the installers, and is idempotent", () => {
    const home = temp();
    const { bin, log } = fakeToolbox(home);
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin`, KANEO_URL: "https://kaneo.test" };
    const args = ["--cli", "apply", "--profile", "personal", "--yes", "--json"];

    const first = ccc(args, env);
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const at = (prefix: string) => {
      const index = calls.findIndex((call) => call.startsWith(prefix));
      expect(index, prefix).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at("brew install gentleman-programming/tap/gentle-ai")).toBeLessThan(
      at("gentle-ai install --agent claude-code --scope global --preset full-gentleman"),
    );
    expect(at("brew install gentleman-programming/tap/engram")).toBeLessThan(
      at("engram setup claude-code"),
    );
    expect(at("npm install -g @colbymchenry/codegraph@1.6.0")).toBeLessThan(
      at("codegraph install --yes --target claude --location global"),
    );
    expect(at("brew install herdr")).toBeLessThan(at("herdr integration install claude"));
    for (const repo of [
      "claude-commit-skill",
      "kaneo-work-tracking-skill",
      "claude-continue-skill",
      "claude-statusline",
      "herdr-config",
    ]) {
      at(`curl -fsSL ${RAW}/${repo}/main/install.sh`);
    }
    at("npx -y @elvisgastelum/configure-env install skill --ci --scope user --mode copy");

    // Installers got the target dirs and the overridable Kaneo URL through env.
    const claudeDir = join(home, ".claude");
    expect(existsSync(join(claudeDir, "skills/commit/SKILL.md"))).toBe(true);
    expect(existsSync(join(claudeDir, "statusline.sh"))).toBe(true);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toContain(
      '"kaneo" https://kaneo.test',
    );

    const doc = first.json();
    const context7 = (doc.modules as { id: string; steps: { status: string }[] }[]).find(
      (m) => m.id === "mcp-context7",
    );
    expect(context7?.steps[0]?.status).toBe("skipped");

    const before = calls.length;
    const second = ccc(args, env);
    expect(second.code).toBe(0);
    expect(new Set(statuses(second.json()))).toEqual(new Set(["unchanged", "skipped"]));
    const again = readFileSync(log, "utf8").trim().split("\n").slice(before);
    expect(again.every((call) => call === "herdr integration status")).toBe(true);
  });

  it("skips tool installs on an unsupported OS and ~/.claude-only setups for another dir", () => {
    const home = temp();
    const { bin } = fakeToolbox(home);
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
    type Step = { action: string; reason: string };
    const steps = (doc: Record<string, unknown>) =>
      Object.fromEntries(
        (doc.modules as { id: string; steps: Step[] }[]).map((m) => [m.id, m.steps[0]]),
      ) as Record<string, Step>;

    const win = steps(
      ccc(["--cli", "plan", "--profile", "personal", "--json"], {
        ...env,
        CCC_PLATFORM: "win32",
      }).json(),
    );
    for (const id of ["tool-gentle-ai", "tool-engram", "tool-codegraph", "tool-herdr"]) {
      expect(win[id]?.action, id).toBe("skip");
      expect(win[id]?.reason, id).toMatch(/runs only on darwin, linux \(this is win32\)/);
    }

    const other = steps(
      ccc(["--cli", "plan", "--profile", "personal", "--json", "--claude-dir", join(home, "x")], {
        ...env,
        PATH: `${bin}:${join(home, "tool-fakes")}:/usr/bin:/bin`,
      }).json(),
    );
    for (const id of ["gentle-ai-claude", "engram-claude", "codegraph-claude", "herdr-claude"]) {
      expect(other[id]?.action, id).toBe("skip");
      expect(other[id]?.reason, id).toMatch(/configures ~\/\.claude only/);
    }
    expect(other["skill-commit"]?.action).toBe("run");
  });
});
