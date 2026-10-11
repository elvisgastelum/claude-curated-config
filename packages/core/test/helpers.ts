import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(prefix = "ccc-core-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export interface FixtureModule {
  id: string;
  requires?: string[];
  secrets?: { name: string; description: string }[];
  inputs?: { name: string; description: string }[];
  provides?: Record<string, string[]>;
  providesBins?: unknown;
  steps: unknown[];
  files?: Record<string, string>;
}

/** Writes a catalog directory with the given modules and profiles. */
export function writeCatalog(
  modules: FixtureModule[],
  profiles: { id: string; modules: string[]; order?: unknown }[] = [],
): string {
  const root = tempDir("ccc-catalog-");
  for (const mod of modules) {
    const dir = join(root, "modules", mod.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "module.json"),
      JSON.stringify({
        id: mod.id,
        name: `Module ${mod.id}`,
        description: `Fixture module ${mod.id}`,
        requires: mod.requires,
        secrets: mod.secrets,
        inputs: mod.inputs,
        provides: mod.provides,
        providesBins: mod.providesBins,
        steps: mod.steps,
      }),
    );
    for (const [rel, content] of Object.entries(mod.files ?? {})) {
      const file = join(dir, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
  }
  mkdirSync(join(root, "profiles"), { recursive: true });
  for (const profile of profiles) {
    writeFileSync(
      join(root, "profiles", `${profile.id}.json`),
      JSON.stringify({ ...profile, name: profile.id, description: `Profile ${profile.id}` }),
    );
  }
  return root;
}

/** Creates a directory holding fake executables; returns an env whose PATH contains only it. */
export function fakeBin(scripts: Record<string, string>): NodeJS.ProcessEnv {
  const dir = tempDir("ccc-bin-");
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return { PATH: `${dir}:/usr/bin:/bin` };
}
