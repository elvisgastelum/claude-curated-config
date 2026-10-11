import { run } from "./program";

process.on("SIGINT", () => {
  process.stderr.write("\nCancelled.\n");
  process.exit(130);
});

run(process.argv).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  },
);
