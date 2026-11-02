/**
 * Password reset, end to end against the Auth emulator: the web app's own
 * `sendPasswordReset` (Firebase JS SDK, `sendPasswordResetEmail`), the email
 * the emulator "sends", completing the reset, and signing in with the new
 * password. No web test runner exists, so the client module is imported here.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROJECT, signUp, wipeEmulators } from "./helpers";

const AUTH = "http://127.0.0.1:9099";

type ResetModule = typeof import("../../web/src/lib/passwordReset");
let reset: ResetModule;

beforeAll(async () => {
  // web/src/lib/firebase.ts reads these at import time.
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = PROJECT;
  process.env.NEXT_PUBLIC_USE_EMULATORS = "true";
  reset = await import("../../web/src/lib/passwordReset");
});
beforeEach(wipeEmulators);

async function oobCodes(): Promise<{ email: string; oobCode: string; requestType: string }[]> {
  const r = await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`);
  return ((await r.json()) as { oobCodes?: { email: string; oobCode: string; requestType: string }[] }).oobCodes ?? [];
}

async function signIn(email: string, password: string): Promise<boolean> {
  const r = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  return r.ok;
}

describe("password reset", () => {
  it("emails a reset link to a registered address, and the new password works", async () => {
    const user = await signUp("Erin");
    expect(await reset.sendPasswordReset(user.email)).toEqual({ ok: true });

    const codes = (await oobCodes()).filter((c) => c.email === user.email && c.requestType === "PASSWORD_RESET");
    expect(codes).toHaveLength(1);
    const done = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:resetPassword?key=fake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oobCode: codes[0].oobCode, newPassword: "brand-new-pass-1" }),
    });
    expect(done.ok).toBe(true);
    expect(await signIn(user.email, "brand-new-pass-1")).toBe(true);
    expect(await signIn(user.email, "password123")).toBe(false);
  });

  it("answers exactly the same for an unknown address (no account enumeration)", async () => {
    const res = await reset.sendPasswordReset("nobody-here@example.com");
    expect(res).toEqual({ ok: true });
    expect((await oobCodes()).filter((c) => c.email === "nobody-here@example.com")).toEqual([]);
    expect(reset.RESET_SENT_MESSAGE).toMatch(/^If an account exists for that email/);
  });

  it("rejects a blank or malformed address and handles rate limits gracefully", async () => {
    expect(await reset.sendPasswordReset("   ")).toMatchObject({ ok: false });
    expect(await reset.sendPasswordReset("not-an-email")).toMatchObject({ ok: false, message: "That doesn't look like an email address." });
    expect(reset.resetResultForError("auth/too-many-requests")).toEqual({ ok: false, message: "Too many reset requests. Wait a few minutes and try again." });
    expect(reset.resetResultForError("auth/user-not-found")).toEqual({ ok: true });
    expect(reset.resetResultForError("auth/user-disabled")).toEqual({ ok: true });
    expect(reset.resetResultForError("auth/something-new")).toMatchObject({ ok: false });
  });
});
