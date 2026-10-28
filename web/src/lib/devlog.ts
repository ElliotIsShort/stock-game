"use client";

import { useMemo } from "react";
import { collection, doc, orderBy, query } from "firebase/firestore";
import { DEFAULT_CHANGELOG, sortDevlog, splitLegacyChangelog, type DevlogEntry, type SiteContent } from "@fsm/shared";
import { fb } from "./firebase";
import { useDoc, useQuery } from "./hooks";

const SEEN_KEY = "fsm:devlogSeen";

/**
 * Dev diary entries, newest first. Until the first real entry exists, the old
 * single-page change log is shown split into entries (ids "legacy-N"), so the
 * page never goes blank while switching over.
 */
export function useDevlog(): { entries: DevlogEntry[]; loading: boolean; legacy: boolean } {
  const db = fb().db;
  const q = useQuery<DevlogEntry>(query(collection(db, "devlog"), orderBy("date", "desc")), []);
  const content = useDoc<SiteContent>(doc(db, "content", "global"), []);
  return useMemo(() => {
    if (q.loading) return { entries: [], loading: true, legacy: false };
    if (q.data.length > 0) return { entries: sortDevlog(q.data), loading: false, legacy: false };
    if (content.loading) return { entries: [], loading: true, legacy: true };
    const entries = splitLegacyChangelog(content.data?.changelog ?? DEFAULT_CHANGELOG).map((e, i) => ({
      id: `legacy-${i}`,
      title: e.title,
      body: e.body,
      date: e.date ?? 0,
      createdAt: -i,
      updatedAt: 0,
    }));
    return { entries, loading: false, legacy: true };
  }, [q.loading, q.data, content.loading, content.data]);
}

export function formatDevlogDate(t: number): string {
  if (!t) return "";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** When you last opened the dev diary on this device (0 = never). */
export function devlogSeenAt(): number {
  if (typeof window === "undefined") return 0;
  return Number(localStorage.getItem(SEEN_KEY) ?? 0);
}

export function markDevlogSeen(latest: DevlogEntry | undefined): void {
  if (!latest || latest.id.startsWith("legacy-")) return;
  const mark = Math.max(latest.date, latest.createdAt);
  if (mark > devlogSeenAt()) localStorage.setItem(SEEN_KEY, String(mark));
}

/** An entry is new to you if it was dated or posted after your last visit. Never on your first visit. */
export function isNewSince(entry: DevlogEntry, seenAt: number): boolean {
  return seenAt > 0 && !entry.id.startsWith("legacy-") && Math.max(entry.date, entry.createdAt) > seenAt;
}
