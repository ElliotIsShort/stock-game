"use client";

import { useState, type ReactNode } from "react";
import { errorMessage } from "./api";

/** Run an async admin action, tracking busy state and showing its success/error message. */
export function useAction(): { busy: boolean; run: (fn: () => Promise<string>) => Promise<void>; view: ReactNode } {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (err) {
      setMsg({ ok: false, text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }
  const view = msg && <p className={msg.ok ? "success" : "error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>;
  return { busy, run, view };
}
