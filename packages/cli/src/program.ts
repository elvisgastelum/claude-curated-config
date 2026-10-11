import { CatalogError } from "@claude-curated/core";
import { Command, CommanderError } from "commander";
import pkg from "../package.json" with { type: "json" };
import {
  type ApplyFlags,
  applyCommand,
  type Context,
  createContext,
  doctorCommand,
  type GlobalOptions,
  isTty,
  listCommand,
  type PlanFlags,
  planCommand,
  statusCommand,
} from "./commands";
import { EXIT, errorDoc, listDoc, UsageError, writeJson } from "./output";
import { runTui } from "./tui";

export const VERSION: string = pkg.version;

const collect = (value: string, previous: string[] = []) => [...previous, value];

function buildProgram(setExit: (code: number) => void, json: boolean): Command {
  const program = new Command("ccc")
    .description(
      "Configure Claude Code from a curated catalog.\n" +
        "Runs an interactive TUI in a terminal; use --cli/--json for scripts and agents.",
    )
    .version(VERSION, "-v, --version")
    .option("--cli", "force non-interactive mode")
    .option("--tui", "force the interactive TUI")
    .option("--json", "print one JSON document to stdout (implies non-interactive)")
    .option(
      "--claude-dir <path>",
      "target Claude config dir (default: $CLAUDE_CONFIG_DIR or ~/.claude)",
    )
    .option("--catalog <path>", "catalog directory (default: the bundled catalog)")
    .option("--no-color", "disable colors")
    .showHelpAfterError(!json)
    .exitOverride()
    .configureOutput({
      writeErr: (text) => {
        if (!json) process.stderr.write(text);
      },
    });

  const ctx = (cmd: Command): Context => createContext(cmd.optsWithGlobals() as GlobalOptions);
  const selectionFlags = (cmd: Command) =>
    cmd
      .option("-p, --profile <id>", "profile to use")
      .option("-m, --module <id>", "module to include (repeatable)", collect)
      .option(
        "--on-conflict <policy>",
        "settings that differ from the catalog: ask (default), catalog or keep",
      )
      .option(
        "--resolve <module:pointer=decision>",
        "decide one conflict, e.g. core-settings:/model=keep (repeatable)",
        collect,
      );

  program.action(async (_opts, cmd: Command) => {
    const options = cmd.opts() as GlobalOptions;
    const context = createContext(options);
    if (options.tui || (!options.cli && !options.json && isTty())) {
      if (!isTty()) throw new UsageError("tty_required", "--tui needs an interactive terminal");
      setExit(await runTui(context, VERSION));
    } else if (options.json) {
      writeJson(listDoc(context.catalog()));
      setExit(EXIT.ok);
    } else {
      process.stdout.write(program.helpInformation());
      setExit(EXIT.ok);
    }
  });

  program
    .command("list")
    .description("list catalog profiles and modules")
    .action(async (_opts, cmd: Command) => setExit(await listCommand(ctx(cmd))));

  selectionFlags(program.command("plan").description("show what apply would change")).action(
    async (opts: PlanFlags, cmd: Command) => setExit(await planCommand(ctx(cmd), opts)),
  );

  selectionFlags(program.command("apply").description("apply a profile and/or modules"))
    .option("-y, --yes", "apply without asking for confirmation")
    .option("--dry-run", "report what would happen without writing")
    .action(async (opts: ApplyFlags, cmd: Command) => setExit(await applyCommand(ctx(cmd), opts)));

  program
    .command("status")
    .description("show which modules are applied")
    .action(async (_opts, cmd: Command) => setExit(await statusCommand(ctx(cmd))));

  program
    .command("doctor")
    .description("check node, git, claude and the target dir")
    .action(async (_opts, cmd: Command) => setExit(await doctorCommand(ctx(cmd))));

  return program;
}

function fail(
  json: boolean,
  code: string,
  message: string,
  exitCode: number,
  details: Record<string, unknown> = {},
): number {
  if (json) writeJson(errorDoc(code, message, exitCode, details));
  else process.stderr.write(`error: ${message}\n`);
  return exitCode;
}

/** Parses argv, runs the selected command and returns the process exit code. */
export async function run(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  let exitCode: number = EXIT.ok;
  const program = buildProgram((code) => {
    exitCode = code;
  }, json);
  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return EXIT.ok;
      }
      const message = error.message.replace(/^error: /, "");
      return json ? fail(true, "usage", message, EXIT.usage) : EXIT.usage;
    }
    if (error instanceof UsageError) {
      return fail(json, error.code, error.message, EXIT.usage, error.details);
    }
    if (error instanceof CatalogError) return fail(json, error.code, error.message, EXIT.catalog);
    const message = error instanceof Error ? error.message : String(error);
    return fail(json, "internal_error", message, EXIT.failure);
  }
}
