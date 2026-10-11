import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "cli",
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 30_000,
  },
});
