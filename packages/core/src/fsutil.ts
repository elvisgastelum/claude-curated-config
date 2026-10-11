import { randomBytes } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveInside } from "./paths";

export const BACKUP_DIR_NAME = ".ccc-backups";

export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** True when something (a file, a directory or a possibly dangling symlink) is at `path`. */
export function occupied(path: string): boolean {
  return existsSync(path) || isLink(path);
}

function tempSibling(path: string): string {
  return join(dirname(path), `.${basename(path)}.ccc-${randomBytes(6).toString("hex")}.tmp`);
}

/**
 * Writes `content` to a temp file next to `path`, then renames it over `path`, so readers
 * never see a half-written file. Uses `mode` when given, else keeps the mode of an existing
 * regular file.
 */
export function writeFileAtomic(path: string, content: Buffer | string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempSibling(path);
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    if (mode !== undefined) chmodSync(tmp, mode);
    else if (existsSync(path) && !isLink(path)) chmodSync(tmp, statSync(path).mode & 0o7777);
    renameSync(tmp, path);
  } catch (error) {
    if (occupied(tmp)) unlinkSync(tmp);
    throw error;
  }
}

/** Points `path` at `target` by renaming a fresh symlink over whatever is there. */
export function symlinkAtomic(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tempSibling(path);
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, path);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}

export interface BackupStore {
  /** Backup directory of this run, or null while nothing was backed up. */
  readonly dir: string | null;
  /**
   * Copies the file at `absPath` to `<backup dir>/<rel>` (a symlink is recreated with the
   * same target text, even when dangling) and returns the backup path. Existing backups are
   * never overwritten: a second backup of the same path gets a numeric suffix.
   */
  save(absPath: string, rel: string): string;
}

/**
 * Creates the backup store of one apply run. The directory is
 * `<claudeDir>/.ccc-backups/<timestamp>` and is claimed lazily on the first backup; when
 * another run already used that timestamp, `-1`, `-2`, ... is appended.
 */
export function createBackupStore(claudeDir: string, now: Date = new Date()): BackupStore {
  const stamp = now.toISOString().replaceAll(":", "-");
  const parent = join(claudeDir, BACKUP_DIR_NAME);
  let dir: string | null = null;

  const claim = (): string => {
    if (dir) return dir;
    mkdirSync(parent, { recursive: true });
    for (let n = 0; ; n += 1) {
      const candidate = join(parent, n === 0 ? stamp : `${stamp}-${n}`);
      try {
        mkdirSync(candidate);
        dir = candidate;
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  };

  return {
    get dir() {
      return dir;
    },
    save(absPath, rel) {
      const base = resolveInside(claim(), rel, "backup");
      mkdirSync(dirname(base), { recursive: true });
      for (let n = 0; ; n += 1) {
        const target = n === 0 ? base : `${base}.${n}`;
        if (occupied(target)) continue;
        if (isLink(absPath)) symlinkSync(readlinkSync(absPath), target);
        else copyFileSync(absPath, target, constants.COPYFILE_EXCL);
        return target;
      }
    },
  };
}
