"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { AppNotification } from "@fsm/shared";
import { api } from "@/lib/api";
import { ago, stockHref } from "@/lib/format";
import { playSound } from "@/lib/sound";
import { useGame } from "./GameProvider";

const TOAST_MS = 6000;

/** In-app notifications (price alerts): a bell with an unread count, a list, and a toast when one arrives. */
export function NotificationBell() {
  const { notifications } = useGame();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<AppNotification | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const unread = notifications.filter((n) => !n.read);

  // Toast for notifications that arrive while the app is open (not the backlog on load).
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(notifications.map((n) => n.id));
      return;
    }
    const fresh = notifications.find((n) => !n.read && !seen.current!.has(n.id));
    for (const n of notifications) seen.current.add(n.id);
    if (fresh) {
      setToast(fresh);
      playSound("success");
    }
  }, [notifications]);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="bell" ref={rootRef}>
      <button
        type="button"
        className="bell-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={unread.length ? `Notifications, ${unread.length} unread` : "Notifications"}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread.length > 0 && <span className="bell-count" aria-hidden="true">{unread.length > 9 ? "9+" : unread.length}</span>}
      </button>
      <div id={panelId} className="bell-panel" data-open={open || undefined} role="region" aria-label="Notifications">
        <div className="row between bell-head">
          <strong>Notifications</strong>
          {unread.length > 0 && (
            <button type="button" className="link small" onClick={() => api.markNotificationsRead().catch(() => undefined)}>Mark all read</button>
          )}
        </div>
        {notifications.length === 0 ? (
          <p className="muted small bell-empty">Nothing yet. Set a price alert from any stock page.</p>
        ) : (
          <ul className="bell-list">
            {notifications.map((n) => (
              <li key={n.id} className={n.read ? undefined : "unread"}>
                <Link
                  href={n.stockId ? stockHref(n.stockId) : "/"}
                  onClick={() => {
                    setOpen(false);
                    if (!n.read) api.markNotificationsRead([n.id]).catch(() => undefined);
                  }}
                >
                  <strong>{n.title}</strong>
                  <span className="small muted">{n.body}</span>
                  <time className="small muted" dateTime={new Date(n.createdAt).toISOString()}>{ago(n.createdAt)}</time>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      {toast && (
        <div className="toast" role="status">
          <Link href={toast.stockId ? stockHref(toast.stockId) : "/"} onClick={() => setToast(null)}>
            <strong>{toast.title}</strong>
            <span className="small">{toast.body}</span>
          </Link>
          <button type="button" className="link" onClick={() => setToast(null)} aria-label="Dismiss">✕</button>
        </div>
      )}
    </div>
  );
}
