import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Builds the CLI when dist is missing so the integration tests can run standalone. */
export default function setup(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  if (!existsSync(new URL("../dist/index.js", import.meta.url))) {
    execFileSync("pnpm", ["exec", "tsup"], { cwd: root, stdio: "inherit" });
  }
}
