import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
    expect((doc.profiles as { id: string }[]).map((p) => p.id)).toContain("minimal");
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
});
