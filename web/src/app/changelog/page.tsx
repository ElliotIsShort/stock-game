"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { devlogExcerpt, type DevlogEntry } from "@fsm/shared";
import { SimpleMarkdown } from "@/components/SimpleMarkdown";
import { devlogSeenAt, formatDevlogDate, isNewSince, markDevlogSeen, useDevlog } from "@/lib/devlog";

/** The dev diary: a list of updates, each opening on its own (/changelog/?id=…). */
export default function DevDiaryPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <DevDiary />
    </Suspense>
  );
}

function entryHref(id: string): string {
  return `/changelog/?id=${encodeURIComponent(id)}`;
}

function DevDiary() {
  const id = useSearchParams().get("id");
  const { entries, loading } = useDevlog();
  // Captured before this visit marks everything seen, so "New" shows this once.
  const [seenAt] = useState(devlogSeenAt);
  useEffect(() => {
    if (!loading) markDevlogSeen(entries[0]);
  }, [loading, entries]);

  if (loading) return <p className="muted" aria-live="polite">Loading…</p>;
  if (id) {
    const i = entries.findIndex((e) => e.id === id);
    if (i < 0) {
      return (
        <div className="stack">
          <p className="muted">That update doesn&apos;t exist any more.</p>
          <Link href="/changelog/">← All updates</Link>
        </div>
      );
    }
    return <EntryView entry={entries[i]} newer={entries[i - 1]} older={entries[i + 1]} />;
  }

  return (
    <div className="stack">
      <div>
        <h1>Dev diary</h1>
        <p className="muted">What&apos;s changed in Stonker, newest first.</p>
      </div>
      {entries.length === 0 ? (
        <p className="muted">No updates yet.</p>
      ) : (
        <ol className="diary-list">
          {entries.map((e) => (
            <li key={e.id}>
              <Link href={entryHref(e.id)} className="card diary-card">
                <span className="diary-meta small muted">
                  {formatDevlogDate(e.date)}
                  {isNewSince(e, seenAt) && <span className="diary-new">New</span>}
                </span>
                <strong className="diary-title">{e.title}</strong>
                <span className="small muted">{devlogExcerpt(e.body)}</span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EntryView({ entry, newer, older }: { entry: DevlogEntry; newer?: DevlogEntry; older?: DevlogEntry }) {
  return (
    <article className="stack diary-entry">
      <Link href="/changelog/" className="small">← All updates</Link>
      <header>
        {entry.date > 0 && <p className="muted small diary-date">{formatDevlogDate(entry.date)}</p>}
        <h1>{entry.title}</h1>
      </header>
      <SimpleMarkdown text={entry.body} />
      {(newer || older) && (
        <nav className="diary-nav" aria-label="More updates">
          {older ? (
            <Link href={entryHref(older.id)} className="card diary-nav-link">
              <span className="small muted">← Older</span>
              <span>{older.title}</span>
            </Link>
          ) : <span />}
          {newer && (
            <Link href={entryHref(newer.id)} className="card diary-nav-link next">
              <span className="small muted">Newer →</span>
              <span>{newer.title}</span>
            </Link>
          )}
        </nav>
      )}
    </article>
  );
}
