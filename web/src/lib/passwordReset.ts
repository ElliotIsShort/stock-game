"use client";

import { sendPasswordResetEmail } from "firebase/auth";
import { fb } from "./firebase";

/** Shown whether or not the address has an account, so the form can't be used to find out who's registered. */
export const RESET_SENT_MESSAGE = "If an account exists for that email, a reset link is on its way. It can take a few minutes, and may land in spam.";

export type ResetResult = { ok: true } | { ok: false; message: string };

function codeOf(err: unknown): string {
  return err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
}

/**
 * Send Firebase's password reset email (default template and sender). The link
 * returns to this site afterwards when its domain is in Firebase Auth's
 * authorised domains; if it isn't, the email is sent without the return link.
 * "No such user" is reported as success on purpose.
 */
export async function sendPasswordReset(email: string): Promise<ResetResult> {
  const auth = fb().auth;
  const address = email.trim();
  if (!address) return { ok: false, message: "Enter your email address." };
  // Checked here too: some backends (e.g. the emulator) answer "no such user" for a malformed address.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return resetResultForError("auth/invalid-email");
  const continueUrl = typeof window !== "undefined" ? `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/` : undefined;
  try {
    try {
      await sendPasswordResetEmail(auth, address, continueUrl ? { url: continueUrl } : undefined);
    } catch (err) {
      const code = codeOf(err);
      if (code !== "auth/unauthorized-continue-uri" && code !== "auth/invalid-continue-uri" && code !== "auth/missing-continue-uri") throw err;
      await sendPasswordResetEmail(auth, address);
    }
    return { ok: true };
  } catch (err) {
    return resetResultForError(codeOf(err));
  }
}

/**
 * How a Firebase Auth error code is reported to the user. An unknown or
 * disabled account looks exactly like success, so the form never reveals
 * which emails are registered.
 */
export function resetResultForError(code: string): ResetResult {
  if (code === "auth/user-not-found" || code === "auth/user-disabled") return { ok: true };
  if (code === "auth/invalid-email" || code === "auth/missing-email") return { ok: false, message: "That doesn't look like an email address." };
  if (code === "auth/too-many-requests" || code === "auth/quota-exceeded") {
    return { ok: false, message: "Too many reset requests. Wait a few minutes and try again." };
  }
  if (code === "auth/network-request-failed") return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  return { ok: false, message: "Couldn't send the reset email right now. Try again in a minute." };
}
