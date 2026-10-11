import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
  // Core is bundled; the catalog stays external so `catalogDir` points at the real data.
  noExternal: ["@claude-curated/core"],
  external: ["@claude-curated/catalog"],
});
