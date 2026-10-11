import { blockMatches } from "./blocks";
import { pathMatches } from "./glob";
import type { Catalog, ModuleProvides, ProvidedSettingItems } from "./types";

/** One `provides` value and the module that declares it. */
export interface ProvidedEntry {
  value: string;
  module: string;
  /** Settings only: exact array items under the `value` pointer (not the whole value). */
  items?: string[];
  /** Settings only: wildcard patterns for array items under the `value` pointer. */
  match?: string[];
}

/** Everything the catalog's non-personal modules provide, by kind. */
export type ProvidedIndex = Record<keyof ModuleProvides, ProvidedEntry[]>;

export const PROVIDES_KINDS = [
  "paths",
  "settings",
  "hooks",
  "claudeMdBlocks",
  "mcpServers",
] as const satisfies readonly (keyof ModuleProvides)[];

export function emptyProvided(): ProvidedIndex {
  return { paths: [], settings: [], hooks: [], claudeMdBlocks: [], mcpServers: [] };
}

/**
 * Collects the `provides` of every catalog module whose id does not start with
 * `excludeModulePrefix` (captured personal modules never hide anything from a capture).
 */
export function collectProvided(
  catalog: Catalog,
  excludeModulePrefix = "personal-",
): ProvidedIndex {
  const index = emptyProvided();
  for (const mod of catalog.modules) {
    if (excludeModulePrefix && mod.id.startsWith(excludeModulePrefix)) continue;
    for (const kind of PROVIDES_KINDS) {
      for (const value of mod.provides?.[kind] ?? []) {
        index[kind].push(
          typeof value === "string"
            ? { value, module: mod.id }
            : { ...itemsEntry(value), module: mod.id },
        );
      }
    }
  }
  return index;
}

function itemsEntry(value: ProvidedSettingItems): Omit<ProvidedEntry, "module"> {
  return {
    value: value.pointer,
    ...(value.items ? { items: value.items } : {}),
    ...(value.match ? { match: value.match } : {}),
  };
}

/** Whether a provided array item entry covers `item`: exact `items`, or `match` (`*` = anything). */
export function itemMatches(entry: ProvidedEntry, item: string): boolean {
  if (entry.items?.includes(item)) return true;
  return (entry.match ?? []).some((pattern) => wildcard(pattern).test(item));
}

function wildcard(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** The module providing a path relative to the Claude dir, if any. */
export function pathProvider(index: ProvidedIndex, path: string): string | undefined {
  return index.paths.find((entry) => pathMatches(path, entry.value))?.module;
}

/** The module providing a settings.json pointer (or a parent of it), if any. */
export function settingProvider(index: ProvidedIndex, pointer: string): string | undefined {
  return index.settings.find(
    (entry) =>
      !entry.items &&
      !entry.match &&
      (pointer === entry.value || pointer.startsWith(`${entry.value}/`)),
  )?.module;
}

/** The module owning a hook command (substring match), if any. */
export function hookProvider(index: ProvidedIndex, command: string): string | undefined {
  return index.hooks.find((entry) => command.includes(entry.value))?.module;
}

export function blockProvider(index: ProvidedIndex, name: string): string | undefined {
  return index.claudeMdBlocks.find((entry) => blockMatches(name, [entry.value]))?.module;
}

export function mcpProvider(index: ProvidedIndex, name: string): string | undefined {
  return index.mcpServers.find((entry) => entry.value === name)?.module;
}
