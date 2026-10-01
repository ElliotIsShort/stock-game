"use client";

import { useState, type FormEvent } from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
} from "firebase/auth";
import { fb } from "@/lib/firebase";
import { errorMessage } from "@/lib/api";

export function SignIn() {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") await signInWithEmailAndPassword(fb().auth, email, password);
      else await createUserWithEmailAndPassword(fb().auth, email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function google() {
    setError(null);
    try {
      await signInWithPopup(fb().auth, new GoogleAuthProvider());
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div className="card narrow">
      <h1>Friend Stock Market</h1>
      <p className="muted">Everyone&apos;s a stock. Trade your friends with play money.</p>
      <form onSubmit={submit} className="stack">
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>
          {mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button type="button" onClick={google} className="full">
        Continue with Google
      </button>
      <p className="muted small">
        {mode === "signin" ? "New here? " : "Already have an account? "}
        <button type="button" className="link" onClick={() => setMode(mode === "signin" ? "signup" : "signin")}>
          {mode === "signin" ? "Create an account" : "Sign in"}
        </button>
      </p>
    </div>
  );
}
