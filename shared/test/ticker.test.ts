import { describe, expect, it } from "vitest";
import { assignTickers, defaultTicker, normaliseTicker, tickerCandidates, validateTicker } from "../src/ticker";

describe("tickers", () => {
  it("normalises case, whitespace and a leading $", () => {
    expect(normaliseTicker("  $joe ")).toBe("JOE");
  });

  it("accepts 2–5 letters and rejects everything else", () => {
    expect(validateTicker("joe")).toEqual({ ok: true, ticker: "JOE" });
    expect(validateTicker("BLG")).toEqual({ ok: true, ticker: "BLG" });
    expect(validateTicker("AB")).toMatchObject({ ok: true });
    expect(validateTicker("ABCDE")).toMatchObject({ ok: true });
    for (const bad of ["A", "ABCDEF", "J0E", "JO E", "JOÉ", "", "$", "🚀🚀"]) expect(validateTicker(bad)).toMatchObject({ ok: false });
    expect(validateTicker(42)).toMatchObject({ ok: false });
  });

  it("suggests defaults from the name, best first", () => {
    expect(tickerCandidates("Joe Bloggs")).toEqual(["JOE", "BLO", "JBL", "JB", "JOEB", "JOEBL"]);
    expect(tickerCandidates("Alice")).toEqual(["ALI", "ALIC", "ALICE"]);
    expect(tickerCandidates("Zoë O'Neil")).toEqual(["ZOE", "ONE", "ZON", "ZO", "ZOEO", "ZOEON"]);
    expect(tickerCandidates("Al")).toEqual(["AL"]);
    expect(tickerCandidates("42")).toEqual([]);
  });

  it("picks the first free default and falls back to suffixed letters", () => {
    expect(defaultTicker("Joe Bloggs", new Set())).toBe("JOE");
    expect(defaultTicker("Joe Bloggs", new Set(["JOE"]))).toBe("BLO");
    expect(defaultTicker("Al", new Set(["AL"]))).toBe("ALA");
    expect(defaultTicker("42", new Set())).toBe("STKA");
    const allAli = new Set(["ALI", "ALIC", "ALICE", "ALIA"]);
    expect(defaultTicker("Alice", allAli)).toBe("ALIB");
  });

  it("keeps stored tickers and gives legacy stocks unique defaults in listing order", () => {
    const map = assignTickers([
      { id: "b", displayName: "Joe Smith", listedAt: 2 },
      { id: "a", displayName: "Joe Bloggs", listedAt: 1 },
      { id: "c", displayName: "Kalen", listedAt: 3, ticker: "JOE" },
    ]);
    expect(map.get("c")).toBe("JOE");
    expect(map.get("a")).toBe("BLO");
    expect(map.get("b")).toBe("SMI");
    expect(new Set(map.values()).size).toBe(3);
  });
});
