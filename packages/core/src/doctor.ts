import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import rootPkg from "../../../package.json" with { type: "json" };
import { which } from "./exec";
import type { DoctorCheck, DoctorReport } from "./types";

/** Minimum Node.js major, read from the root package.json `engines.node` (single source). */
export const MIN_NODE_MAJOR = Number(/\d+/.exec(rootPkg.engines.node)?.[0] ?? "20");

function writableDir(path: string): { ok: boolean; message: string } {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    if (!statSync(current).isDirectory()) {
      return { ok: false, message: `${current} exists and is not a directory` };
    }
    accessSync(current, constants.W_OK);
  } catch (error) {
    return { ok: false, message: `${current} is not writable (${(error as Error).message})` };
  }
  const suffix = current === resolve(path) ? "" : ` (will be created under ${current})`;
  return { ok: true, message: `${resolve(path)} is writable${suffix}` };
}

export interface DoctorOptions {
  claudeDir: string;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
}

/** Checks the machine prerequisites. `ok` is false only when a required check fails. */
export function doctor(options: DoctorOptions): DoctorReport {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const major = Number(nodeVersion.split(".")[0]);
  const claude = which("claude", env);
  const git = which("git", env);
  const dir = writableDir(options.claudeDir);
  const checks: DoctorCheck[] = [
    {
      id: "node",
      ok: major >= MIN_NODE_MAJOR,
      required: true,
      message: `node ${nodeVersion}`,
      ...(major >= MIN_NODE_MAJOR
        ? {}
        : {
            fix: `install Node.js >= ${MIN_NODE_MAJOR} (e.g. via nvm, fnm or your package manager)`,
          }),
    },
    {
      id: "claude",
      ok: claude !== null,
      required: false,
      message: claude ? `claude found at ${claude}` : "claude CLI not found on PATH",
      ...(claude
        ? {}
        : {
            fix: "install Claude Code: npm install -g @anthropic-ai/claude-code (command steps are skipped until then)",
          }),
    },
    {
      id: "git",
      ok: git !== null,
      required: false,
      message: git ? `git found at ${git}` : "git not found on PATH",
      ...(git ? {} : { fix: "install git from https://git-scm.com/downloads" }),
    },
    {
      id: "claude-dir",
      ok: dir.ok,
      required: true,
      message: dir.message,
      ...(dir.ok ? {} : { fix: "pass a writable --claude-dir or fix the directory permissions" }),
    },
  ];
  return { ok: checks.every((check) => check.ok || !check.required), checks };
}
