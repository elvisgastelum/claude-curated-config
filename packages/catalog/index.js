import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the bundled catalog (contains `modules/` and `profiles/`). */
export const catalogDir = dirname(fileURLToPath(import.meta.url));
