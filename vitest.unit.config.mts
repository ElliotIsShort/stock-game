import { defineConfig } from "vitest/config";

// Pure game-logic tests. No Firebase needed; runs in a second or two.
export default defineConfig({
  test: {
    include: ["shared/test/**/*.test.ts"],
  },
});
