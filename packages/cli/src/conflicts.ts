import { isCancel, note, select } from "@clack/prompts";
import type {
  Conflict,
  ConflictPolicy,
  Json,
  Plan,
  Resolution,
  Resolutions,
} from "@claude-curated/core";
import { conflictKey, unresolvedConflicts } from "@claude-curated/core";
import { type Colors, UsageError } from "./output";

const POLICIES: ConflictPolicy[] = ["ask", "catalog", "keep"];

export interface ConflictFlags {
  onConflict?: string;
  resolve?: string[];
}

export interface ConflictOptions {
  onConflict: ConflictPolicy;
  resolutions: Resolutions;
}

/** Parses `--on-conflict` and repeatable `--resolve <module>:<pointer>=<catalog|keep>`. */
export function parseConflictFlags(flags: ConflictFlags): ConflictOptions {
  const onConflict = (flags.onConflict ?? "ask") as ConflictPolicy;
  if (!POLICIES.includes(onConflict)) {
    throw new UsageError(
      "invalid_on_conflict",
      `--on-conflict must be one of ${POLICIES.join(", ")} (got "${flags.onConflict}")`,
    );
  }
  const resolutions: Resolutions = {};
  for (const spec of flags.resolve ?? []) {
    const match = /^([a-z0-9][a-z0-9-]*):(.*)=(catalog|keep)$/.exec(spec);
    if (!match) {
      throw new UsageError(
        "invalid_resolve",
        `--resolve "${spec}" must look like <module>:<json-pointer>=<catalog|keep>, e.g. core-settings:/model=keep`,
      );
    }
    const [, module, path, decision] = match as unknown as [string, string, string, Resolution];
    resolutions[conflictKey(module, path)] = decision;
  }
  return { onConflict, resolutions };
}

/** Quotes a shell word when it contains anything beyond a conservative safe set. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function resolveFlag(conflict: Conflict, decision: Resolution): string {
  return `--resolve ${shellQuote(`${conflictKey(conflict.module, conflict.path)}=${decision}`)}`;
}

/** Error raised when a non-interactive apply meets conflicts nobody decided. */
export function conflictsError(planned: Plan): UsageError {
  const open = unresolvedConflicts(planned);
  const lines = open.map(
    (c) =>
      `  ${c.module} ${c.dest} ${c.path}: current ${preview(c.current, 60)}, catalog ${preview(c.catalog, 60)}\n` +
      `    ${resolveFlag(c, "catalog")}  |  ${resolveFlag(c, "keep")}`,
  );
  return new UsageError(
    "conflicts_unresolved",
    `${open.length} setting(s) in your files differ from the catalog; nothing was written.\n` +
      `${lines.join("\n")}\n` +
      "Decide each with the --resolve flags above, or all at once with --on-conflict catalog|keep.",
    {
      conflicts: open.map((c) => ({
        ...c,
        flags: { catalog: resolveFlag(c, "catalog"), keep: resolveFlag(c, "keep") },
      })),
    },
  );
}

/** Compact pretty JSON for display, truncated to `max` characters. */
export function preview(value: Json, max = 400): string {
  const text = JSON.stringify(value, null, 2) ?? "undefined";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Asks, one conflict at a time, whether to use the catalog value or keep the current one,
 * with "all remaining" shortcuts. Returns the decisions keyed for `plan({ resolutions })`,
 * or null when the user cancels.
 */
export async function askConflicts(conflicts: Conflict[], c: Colors): Promise<Resolutions | null> {
  const decisions: Resolutions = {};
  let all: Resolution | undefined;
  for (const [i, conflict] of conflicts.entries()) {
    const key = conflictKey(conflict.module, conflict.path);
    if (all) {
      decisions[key] = all;
      continue;
    }
    note(
      `${c.dim("current:")}\n${preview(conflict.current)}\n\n${c.dim("catalog:")}\n${preview(conflict.catalog)}`,
      `Conflict ${i + 1}/${conflicts.length}: ${conflict.dest} ${conflict.path} (${conflict.module})`,
    );
    const remaining = conflicts.length - i - 1;
    const choice = await select({
      message: `${conflict.dest} ${conflict.path}`,
      options: [
        { value: "catalog", label: "Use catalog value" },
        { value: "keep", label: "Keep my value" },
        ...(remaining > 0
          ? [
              { value: "all-catalog", label: `Use catalog value for this and ${remaining} more` },
              { value: "all-keep", label: `Keep my value for this and ${remaining} more` },
            ]
          : []),
      ],
    });
    if (isCancel(choice)) return null;
    const decision = (choice.startsWith("all-") ? choice.slice(4) : choice) as Resolution;
    if (choice.startsWith("all-")) all = decision;
    decisions[key] = decision;
  }
  return decisions;
}
