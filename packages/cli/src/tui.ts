import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import { doctor, plan, type Selection, startApply, status } from "@claude-curated/core";
import type { Context } from "./commands";
import { EXIT, pendingCount, renderPlan } from "./output";

class Cancelled extends Error {}

function unwrap<T>(value: T | symbol): Exclude<T, symbol> {
  if (isCancel(value)) throw new Cancelled();
  return value as Exclude<T, symbol>;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Interactive flow: doctor → choose profile/modules → plan → confirm → apply. */
export async function runTui(ctx: Context, version: string): Promise<number> {
  const c = ctx.colors;
  try {
    intro(`${c.bgCyan(c.black(" claude-curated-config "))} ${c.dim(`v${version}`)}`);
    log.info(`Target: ${c.bold(ctx.claudeDir)}`);

    const health = doctor({ claudeDir: ctx.claudeDir });
    for (const check of health.checks.filter((check) => !check.ok)) {
      const text = `${check.message}${check.fix ? `\n${c.dim(`fix: ${check.fix}`)}` : ""}`;
      if (check.required) log.error(text);
      else log.warn(text);
    }
    if (!health.ok) {
      outro(c.red("Fix the problems above and run ccc again."));
      return EXIT.failure;
    }

    const catalog = ctx.catalog();
    const installed = new Map(
      status({ catalog, claudeDir: ctx.claudeDir }).modules.map((m) => [m.id, m.state]),
    );

    const how = unwrap(
      await select({
        message: "What do you want to set up?",
        options: [
          { value: "profile", label: "Profile", hint: "a curated set of modules" },
          { value: "modules", label: "Pick modules", hint: "choose individual modules" },
        ],
      }),
    );

    let selection: Selection;
    if (how === "profile") {
      const profile = unwrap(
        await select({
          message: "Choose a profile",
          options: catalog.profiles.map((p) => ({
            value: p.id,
            label: p.name,
            hint: `${p.description} [${p.modules.join(", ")}]`,
          })),
        }),
      );
      selection = { profile };
    } else {
      const modules = unwrap(
        await multiselect({
          message: "Choose modules (space to toggle, enter to confirm)",
          required: true,
          options: catalog.modules.map((m) => {
            const state = installed.get(m.id);
            const badge =
              state === "applied" ? " (applied)" : state === "partial" ? " (partial)" : "";
            return { value: m.id, label: `${m.name}${badge}`, hint: m.description };
          }),
        }),
      );
      selection = { modules };
    }

    const planned = plan({ catalog, claudeDir: ctx.claudeDir, ...selection });
    note(renderPlan(planned, c), "Plan");
    if (pendingCount(planned) === 0) {
      outro(c.green("Everything is already up to date."));
      return EXIT.ok;
    }

    const go = unwrap(await confirm({ message: "Apply these changes?" }));
    if (!go) {
      cancel("Nothing was changed.");
      return EXIT.ok;
    }

    // Apply one module at a time so the spinner can render between modules.
    const run = startApply(planned);
    for (const mod of planned.modules) {
      const spin = spinner();
      spin.start(`Applying ${mod.name}`);
      await tick();
      const result = run.module(mod);
      const failed = result.steps.filter((s) => s.status === "failed");
      const skipped = result.steps.filter((s) => s.status === "skipped");
      if (!result.ok) {
        const why = failed.length > 0 ? failed : skipped;
        spin.error(`${mod.name}: ${why.map((s) => s.message).join("; ")}`);
      } else if (skipped.length > 0) {
        spin.stop(
          `${mod.name} ${c.magenta(`skipped: ${skipped.map((s) => s.message).join("; ")}`)}`,
        );
      } else {
        spin.stop(`${mod.name} ${c.green("done")}`);
      }
    }
    const { backupDir, ok } = run.finish();

    const next = [
      backupDir ? `Backups of replaced files: ${backupDir}` : "No existing files were replaced.",
      "Check the result with: ccc status",
      "Restart Claude Code to pick up the new configuration.",
    ];
    note(next.join("\n"), "Next steps");
    outro(ok ? c.green("Done.") : c.red("Finished with errors."));
    return ok ? EXIT.ok : EXIT.failure;
  } catch (error) {
    if (error instanceof Cancelled) {
      cancel("Cancelled. Nothing else was changed.");
      return EXIT.cancelled;
    }
    throw error;
  }
}
