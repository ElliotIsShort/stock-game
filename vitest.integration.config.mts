import { defineConfig } from "vitest/config";

// End-to-end tests against the Firebase emulators (auth, firestore, functions).
// Run via `npm run test:integration`, which starts the emulators around them.
// Files share one emulator, and each test wipes it first, so they run one at a time.
export default defineConfig({
  test: {
    include: ["functions/test/**/*.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
