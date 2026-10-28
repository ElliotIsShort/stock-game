// The functions emulator reads secrets from functions/.secret.local.
// Create/extend it for local runs and CI (never used in production):
// - CRON_SECRET for the weekly-close endpoint.
// - DISCORD_WEBHOOK_URL pointing at the local capture server the integration
//   tests start (functions/test/discord.test.ts). Swap in a real webhook URL to
//   see posts in Discord while running `npm run emulators`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const path = new URL("../functions/.secret.local", import.meta.url);
const defaults = {
  CRON_SECRET: "local-emulator-secret-123456",
  DISCORD_WEBHOOK_URL: "http://127.0.0.1:8199/webhook",
};
const current = existsSync(path) ? readFileSync(path, "utf8") : "";
const missing = Object.entries(defaults).filter(([k]) => !new RegExp(`^${k}=`, "m").test(current));
if (missing.length) {
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  writeFileSync(path, current + prefix + missing.map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  console.log(`functions/.secret.local: added ${missing.map(([k]) => k).join(", ")} for the emulator.`);
}
