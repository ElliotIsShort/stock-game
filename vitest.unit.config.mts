import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pure game-logic tests (shared/) and the web app's static checks and
// concealment render tests (web/test/). No Firebase needed; runs in seconds.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./web/src", import.meta.url)) } },
  test: {
    include: ["shared/test/**/*.test.ts", "web/test/**/*.test.{ts,tsx}"],
  },
});
