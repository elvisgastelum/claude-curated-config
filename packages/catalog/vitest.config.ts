import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "catalog",
    include: ["test/**/*.test.ts"],
  },
});
