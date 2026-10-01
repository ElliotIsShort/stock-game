"use client";

import { useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api";
import { useGame } from "./GameProvider";

/** Shown to signed-in users who aren't players yet (§4.3). */
export function RegistrationGate() {
  const { registration, user, signOut } = useGame();
  const [name, setName] = useState(user?.displayName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.register(name);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (registration?.status === "pending") {
    return (
      <div className="card narrow">
        <h1>Waiting for approval</h1>
        <p>
          You&apos;ve asked to join as <strong>{registration.displayName}</strong>. An admin needs to approve you before you get
          your starting cash and your stock lists.
        </p>
        <button type="button" onClick={signOut}>Sign out</button>
      </div>
    );
  }

  return (
    <div className="card narrow">
      <h1>Join the market</h1>
      {registration?.status === "rejected" && <p className="error">Your previous request was declined. You can ask again.</p>}
      <p className="muted">Pick the name your stock will trade under. An admin will approve you.</p>
      <form onSubmit={submit} className="stack">
        <label>
          Display name
          <input required minLength={2} maxLength={30} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <button type="submit" className="primary" disabled={busy}>Request to join</button>
      </form>
      <button type="button" className="link" onClick={signOut}>Sign out</button>
    </div>
  );
}
