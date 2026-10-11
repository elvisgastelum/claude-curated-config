import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Always rebuilds the CLI so the integration tests never run a stale dist. */
export default function setup(): void {
  const root = fileURLToPath(new URL("..", import.meta.url));
  execFileSync("pnpm", ["exec", "tsup", "--silent"], { cwd: root, stdio: "inherit" });
}
