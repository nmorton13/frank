import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/dom/**/*.test.ts"],
    globals: true,
  },
});
