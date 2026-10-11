import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Finds an executable on the PATH of the given env. */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = isAbsolute(bin)
    ? [bin]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, bin));
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable here, keep looking
    }
  }
  return null;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Give the child the terminal (stdin/stdout/stderr inherited; output is not captured). */
  inheritStdio?: boolean;
  /** Kill the child after this many milliseconds (default 5 minutes). */
  timeoutMs?: number;
}

/**
 * Runs an argv without a shell, stdin closed (`/dev/null`) unless `inheritStdio`. Never
 * throws; spawn errors map to code 127.
 */
export function runArgv(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  options: RunOptions = {},
): RunResult {
  const [command, ...args] = argv;
  if (!command) return { code: 127, stdout: "", stderr: "empty command" };
  const executable = which(command, env) ?? command;
  const result = spawnSync(executable, args, {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: options.inheritStdio ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 5 * 60_000,
  });
  if (result.error) return { code: 127, stdout: "", stderr: result.error.message };
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
