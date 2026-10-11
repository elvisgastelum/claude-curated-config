import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CatalogError } from "./errors";
import { isPlainObject } from "./merge";
import { resolveInside } from "./paths";
import type { Catalog, CatalogModule, Profile, Selection, Step } from "./types";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const VIRTUAL_CLAUDE_DIR = "/__claude_dir__";

function readJson(file: string, code: "invalid_module" | "invalid_profile"): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CatalogError(code, `${file}: ${(error as Error).message}`);
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "");
}

function validateStep(raw: unknown, moduleDir: string, where: string): Step {
  const fail = (message: string): never => {
    throw new CatalogError("invalid_module", `${where}: ${message}`);
  };
  if (!isPlainObject(raw)) return fail("step must be an object");
  const checkPaths = (src: unknown, dest: unknown) => {
    if (typeof src !== "string" || typeof dest !== "string") fail("src and dest must be strings");
    try {
      const srcPath = resolveInside(moduleDir, src as string, "src");
      if (!existsSync(srcPath) || !statSync(srcPath).isFile()) {
        fail(`src "${src}" does not exist in ${moduleDir}`);
      }
      resolveInside(VIRTUAL_CLAUDE_DIR, dest as string, "dest");
    } catch (error) {
      if (error instanceof CatalogError && error.code === "unsafe_path") {
        fail(error.message.replace(VIRTUAL_CLAUDE_DIR, "the Claude dir"));
      }
      throw error;
    }
  };
  switch (raw.type) {
    case "file":
      checkPaths(raw.src, raw.dest);
      if (raw.mode !== undefined && raw.mode !== "copy" && raw.mode !== "symlink") {
        fail(`mode must be "copy" or "symlink"`);
      }
      return raw as unknown as Step;
    case "json-merge":
      checkPaths(raw.src, raw.dest);
      if (!String(raw.src).endsWith(".json")) fail("json-merge src must be a .json file");
      try {
        JSON.parse(readFileSync(join(moduleDir, String(raw.src)), "utf8"));
      } catch (error) {
        fail(`src "${raw.src}" is not valid JSON: ${(error as Error).message}`);
      }
      return raw as unknown as Step;
    case "command":
      if (!isStringArray(raw.run) || raw.run.length === 0) fail("run must be a non-empty argv");
      if (raw.check !== undefined && (!isStringArray(raw.check) || raw.check.length === 0)) {
        fail("check must be a non-empty argv");
      }
      if (raw.requiresBin !== undefined && typeof raw.requiresBin !== "string") {
        fail("requiresBin must be a string");
      }
      return raw as unknown as Step;
    default:
      return fail(`unknown step type ${JSON.stringify(raw.type)}`);
  }
}

function loadModule(dir: string, dirName: string): CatalogModule {
  const file = join(dir, "module.json");
  if (!existsSync(file)) throw new CatalogError("invalid_module", `${dir}: missing module.json`);
  const raw = readJson(file, "invalid_module");
  const fail = (message: string): never => {
    throw new CatalogError("invalid_module", `module "${dirName}": ${message}`);
  };
  if (!isPlainObject(raw)) return fail("module.json must be an object");
  if (raw.id !== dirName) fail(`id ${JSON.stringify(raw.id)} must match its directory name`);
  if (!ID_PATTERN.test(dirName)) fail("id must be lowercase kebab-case");
  for (const key of ["name", "description"] as const) {
    if (typeof raw[key] !== "string" || raw[key] === "") fail(`${key} must be a non-empty string`);
  }
  if (raw.tags !== undefined && !isStringArray(raw.tags)) fail("tags must be strings");
  if (raw.requires !== undefined && !isStringArray(raw.requires)) fail("requires must be strings");
  if (!Array.isArray(raw.steps)) fail("steps must be an array");
  const steps = (raw.steps as unknown[]).map((step, index) =>
    validateStep(step, dir, `module "${dirName}" step ${index + 1}`),
  );
  return {
    id: dirName,
    name: raw.name as string,
    description: raw.description as string,
    tags: raw.tags as string[] | undefined,
    requires: raw.requires as string[] | undefined,
    steps,
    dir,
  };
}

function loadProfile(file: string, id: string, known: Set<string>): Profile {
  const raw = readJson(file, "invalid_profile");
  const fail = (message: string): never => {
    throw new CatalogError("invalid_profile", `profile "${id}": ${message}`);
  };
  if (!isPlainObject(raw)) return fail("profile must be an object");
  if (raw.id !== id) fail(`id ${JSON.stringify(raw.id)} must match its file name`);
  if (typeof raw.name !== "string" || typeof raw.description !== "string") {
    fail("name and description must be strings");
  }
  if (!isStringArray(raw.modules) || raw.modules.length === 0) fail("modules must be non-empty");
  for (const moduleId of raw.modules as string[]) {
    if (!known.has(moduleId)) fail(`unknown module "${moduleId}"`);
  }
  return {
    id,
    name: raw.name as string,
    description: raw.description as string,
    modules: raw.modules as string[],
  };
}

/** Orders modules so that every module comes after the modules it requires. */
function topoSort(roots: string[], byId: Map<string, CatalogModule>): CatalogModule[] {
  const ordered: CatalogModule[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];
  const visit = (id: string) => {
    if (done.has(id)) return;
    const mod = byId.get(id);
    if (!mod) throw new CatalogError("unknown_module", `unknown module "${id}"`);
    if (visiting.includes(id)) {
      const cycle = [...visiting.slice(visiting.indexOf(id)), id].join(" -> ");
      throw new CatalogError("cyclic_requires", `cyclic requires: ${cycle}`);
    }
    visiting.push(id);
    for (const dep of mod.requires ?? []) visit(dep);
    visiting.pop();
    done.add(id);
    ordered.push(mod);
  };
  for (const id of roots) visit(id);
  return ordered;
}

/** Loads and validates a catalog directory (`modules/<id>/module.json`, `profiles/<id>.json`). */
export function loadCatalog(dir: string): Catalog {
  const root = resolve(dir);
  const modulesDir = join(root, "modules");
  if (!existsSync(modulesDir)) {
    throw new CatalogError("invalid_catalog", `${root}: missing modules/ directory`);
  }
  const modules = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => loadModule(join(modulesDir, name), name));
  const byId = new Map(modules.map((mod) => [mod.id, mod]));
  for (const mod of modules) {
    for (const dep of mod.requires ?? []) {
      if (!byId.has(dep)) {
        throw new CatalogError("invalid_module", `module "${mod.id}" requires unknown "${dep}"`);
      }
    }
  }
  topoSort(
    modules.map((mod) => mod.id),
    byId,
  );

  const profilesDir = join(root, "profiles");
  const profiles = existsSync(profilesDir)
    ? readdirSync(profilesDir)
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) =>
          loadProfile(join(profilesDir, name), name.slice(0, -5), new Set(byId.keys())),
        )
    : [];
  return { dir: root, modules, profiles };
}

/** Expands a profile and/or module ids (plus their requires) into apply order. */
export function resolveSelection(catalog: Catalog, selection: Selection): CatalogModule[] {
  const ids: string[] = [];
  if (selection.profile) {
    const profile = catalog.profiles.find((p) => p.id === selection.profile);
    if (!profile) {
      const known = catalog.profiles.map((p) => p.id).join(", ") || "none";
      throw new CatalogError(
        "unknown_profile",
        `unknown profile "${selection.profile}" (known: ${known})`,
      );
    }
    ids.push(...profile.modules);
  }
  const byId = new Map(catalog.modules.map((mod) => [mod.id, mod]));
  for (const id of selection.modules ?? []) {
    if (!byId.has(id)) {
      const known = catalog.modules.map((m) => m.id).join(", ");
      throw new CatalogError("unknown_module", `unknown module "${id}" (known: ${known})`);
    }
    ids.push(id);
  }
  if (ids.length === 0) {
    throw new CatalogError("empty_selection", "select a profile or at least one module");
  }
  return topoSort(ids, byId);
}
