// Bundles the functions (and the @fsm/shared workspace package) into a single
// file, so deployment doesn't need the shared package published anywhere.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: "lib/index.js",
  sourcemap: true,
  // Installed by Cloud Build from package.json at deploy time.
  external: ["firebase-admin", "firebase-functions"],
  logLevel: "info",
});
