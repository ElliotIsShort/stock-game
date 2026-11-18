"use client";

import { useServerDocs } from "@/lib/serverNames";
import { useGame } from "./GameProvider";

/**
 * Shown only to someone with two or more memberships and no `?s=` / last-used
 * server to go on. Single-membership players never see this: they're sent
 * straight into their only server.
 */
export function ServerPicker() {
  const { memberships, switchServer, signOut } = useGame();
  const { docs, loading } = useServerDocs(memberships);
  return (
    <div className="card narrow stack">
      <h1>Choose a server</h1>
      {loading && <p className="muted" aria-live="polite">Loading…</p>}
      <ul className="server-picker" aria-label="Your servers">
        {memberships.map((id) => {
          const s = docs.get(id);
          return (
            <li key={id}>
              <button type="button" className="primary" onClick={() => switchServer(id)}>
                {s?.name ?? id}
              </button>
              {s?.status === "archived" && <span className="muted small"> · ended</span>}
            </li>
          );
        })}
      </ul>
      <button type="button" className="link" onClick={signOut}>Sign out</button>
    </div>
  );
}
