import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import rootPkg from "../../../package.json" with { type: "json" };
import { which } from "./exec";
import type { DoctorCheck, DoctorReport } from "./types";

/** Minimum Node.js version, read from the root package.json `engines.node` (single source). */
export const MIN_NODE_VERSION: string =
  /\d+\.\d+\.\d+/.exec(rootPkg.engines.node)?.[0] ?? "20.12.0";

/** Compares two `major.minor.patch` versions (a leading `v` is ignored): <0, 0 or >0. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (x[i] || 0) - (y[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

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
  /** Platform for the package-manager check (default `$CCC_PLATFORM`, else `process.platform`). */
  platform?: string;
}

/** Tools the installer modules use; all optional (their steps are skipped without them). */
const INSTALLER_TOOLS: { bin: string; why: string; fix: string }[] = [
  { bin: "bash", why: "runs installer scripts", fix: "install bash with your package manager" },
  {
    bin: "curl",
    why: "downloads installer scripts",
    fix: "install curl with your package manager",
  },
  {
    bin: "jq",
    why: "used by several installers to edit JSON",
    fix: "install jq (https://jqlang.org/download/)",
  },
  {
    bin: "npm",
    why: "installs npm-based tools (codegraph)",
    fix: "install Node.js with npm (https://nodejs.org)",
  },
  {
    bin: "npx",
    why: "runs npm-based installers (configure-env, MCP servers)",
    fix: "install Node.js with npm (https://nodejs.org)",
  },
];

function toolCheck(id: string, path: string | null, why: string, fix: string): DoctorCheck {
  return {
    id,
    ok: path !== null,
    required: false,
    message: path ? `${id} found at ${path}` : `${id} not found on PATH (${why})`,
    ...(path ? {} : { fix }),
  };
}

function brewCheck(env: NodeJS.ProcessEnv, platform: string): DoctorCheck {
  const brew = which("brew", env);
  const install = "install Homebrew from https://brew.sh";
  if (platform === "darwin") {
    return toolCheck("brew", brew, "installs gentle-ai, engram and herdr on macOS", install);
  }
  if (platform === "linux") {
    return {
      id: "brew",
      ok: brew !== null,
      required: false,
      message: brew
        ? `brew found at ${brew} (Homebrew on Linux installs gentle-ai, engram and herdr)`
        : "brew not found on PATH: on Linux the gentle-ai, engram and herdr installs are skipped; install them with your package manager or Homebrew on Linux",
      ...(brew ? {} : { fix: `${install} (Homebrew on Linux), or install the tools manually` }),
    };
  }
  return {
    id: "brew",
    ok: false,
    required: false,
    message: `tool installs support macOS and Linux only (this is ${platform})`,
  };
}

/** Checks the machine prerequisites. `ok` is false only when a required check fails. */
export function doctor(options: DoctorOptions): DoctorReport {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? env.CCC_PLATFORM ?? process.platform;
  const nodeOk = compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0;
  const claude = which("claude", env);
  const git = which("git", env);
  const dir = writableDir(options.claudeDir);
  const checks: DoctorCheck[] = [
    {
      id: "node",
      ok: nodeOk,
      required: true,
      message: `node ${nodeVersion}`,
      ...(nodeOk
        ? {}
        : {
            fix: `install Node.js >= ${MIN_NODE_VERSION} (e.g. via nvm, fnm or your package manager)`,
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
    ...INSTALLER_TOOLS.map(({ bin, why, fix }) => toolCheck(bin, which(bin, env), why, fix)),
    brewCheck(env, platform),
  ];
  return { ok: checks.every((check) => check.ok || !check.required), checks };
}
