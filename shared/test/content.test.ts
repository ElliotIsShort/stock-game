import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANGELOG,
  MAX_CONTENT_LENGTH,
  devlogDateFromIso,
  devlogDateToIso,
  devlogExcerpt,
  sortDevlog,
  splitLegacyChangelog,
  validateDevlogEntry,
} from "../src/content";

describe("dev diary", () => {
  it("splits a one-page change log into dated entries, newest first", () => {
    const entries = splitLegacyChangelog(DEFAULT_CHANGELOG);
    expect(entries.map((e) => e.title)).toEqual(["Profiles, awards and Discord", "Short selling is here", "Welcome to Stonker"]);
    expect(entries.map((e) => devlogDateToIso(e.date!))).toEqual(["2026-10-28", "2026-10-20", "2026-10-20"]);
    expect(entries[0].body.startsWith("## Pick your ticker")).toBe(true);
    expect(entries[2].body).not.toContain("Date:");
  });

  it("handles change logs without a title or dates", () => {
    expect(splitLegacyChangelog("# One\nHello\n\n# Two.\n- a")).toEqual([
      { title: "One", body: "Hello", date: null },
      { title: "Two", body: "- a", date: null },
    ]);
    expect(splitLegacyChangelog("just text, no headings")).toEqual([]);
    expect(splitLegacyChangelog("# Empty\n\n# Full\nx")).toEqual([{ title: "Full", body: "x", date: null }]);
  });

  it("parses dates as noon UTC and rejects impossible ones", () => {
    expect(devlogDateFromIso("2026-10-28")).toBe(Date.UTC(2026, 9, 28, 12));
    expect(devlogDateFromIso("2026-02-30")).toBeNull();
    expect(devlogDateFromIso("28/10/2026")).toBeNull();
  });

  it("validates entries", () => {
    const d = Date.UTC(2026, 9, 28, 12);
    expect(validateDevlogEntry("  New   stuff ", " body ", d)).toEqual({ ok: true, title: "New stuff", body: "body" });
    expect(validateDevlogEntry("", "body", d)).toMatchObject({ ok: false });
    expect(validateDevlogEntry("x".repeat(101), "body", d)).toMatchObject({ ok: false });
    expect(validateDevlogEntry("t", "  ", d)).toMatchObject({ ok: false });
    expect(validateDevlogEntry("t", "x".repeat(MAX_CONTENT_LENGTH + 1), d)).toMatchObject({ ok: false });
    expect(validateDevlogEntry("t", "b", Number.NaN)).toMatchObject({ ok: false });
    expect(validateDevlogEntry("t", "b", 0)).toMatchObject({ ok: false });
  });

  it("sorts by date then creation, and makes short excerpts", () => {
    const sorted = sortDevlog([
      { id: "a", date: 1, createdAt: 5 },
      { id: "b", date: 2, createdAt: 1 },
      { id: "c", date: 1, createdAt: 9 },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(["b", "c", "a"]);
    expect(devlogExcerpt("## Heading\n\n- First point\nSecond")).toBe("First point");
    expect(devlogExcerpt("x".repeat(200), 20)).toHaveLength(20);
  });
});
