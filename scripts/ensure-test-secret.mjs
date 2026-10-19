// The functions emulator reads CRON_SECRET from functions/.secret.local.
// Create one for local runs/CI if it doesn't exist (never used in production).
import { existsSync, writeFileSync } from "node:fs";

const path = new URL("../functions/.secret.local", import.meta.url);
if (!existsSync(path)) {
  writeFileSync(path, "CRON_SECRET=local-emulator-secret-123456\n");
  console.log("Created functions/.secret.local for the emulator.");
}
