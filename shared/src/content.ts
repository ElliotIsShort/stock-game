/**
 * Editable site content: the Rules page and the Change log. Both live in one
 * Firestore doc (content/global) so the admin edits them in one place, and
 * each renders on its own page. Markdown-ish plain text; the pages render it
 * with simple paragraph/heading/list handling.
 */
export interface SiteContent {
  /** Rules page body. */
  rules: string;
  /** Change log body (newest entries at the top). */
  changelog: string;
  /** Last edit time (epoch ms), 0 if never edited. */
  updatedAt: number;
}

export const DEFAULT_RULES = `# How Stonker works

Everyone in the group is a tradable stock, named after them. You trade each other with play money. There is no real money, ever.

## Trading
- You buy and sell shares in other people against an automated market maker, not against each other directly. Each stock has a pool of cash and shares; the price is cash ÷ shares.
- Buying pushes a price up, selling pushes it down. Bigger trades move the price more.
- You can't trade your own stock. You can hold, buy and sell anyone else's.
- Every stock has a ticker, like $JOE. You get one from your name and can pick your own on your stock page.
- Every trade pays a small fee into the weekly prize pool.
- Prices only ever move because people trade. Posts and reactions never move a price. It's up to you whether to act on them.

## Short selling
- Think someone's stock will fall? Open a short: you sell shares you don't own and get the cash now. Later you close it by buying them back. If the price dropped you keep the difference; if it rose you take the loss.
- You can short anyone except yourself, up to half your capital (your cash plus the value of what you hold).
- Open shorts pay a small weekly fee. Close whenever you like.
- A losing short counts against your net worth straight away. A winning one only counts once you close it, so nobody can inflate their score with a last-minute short.

## Money in
- New players start with cash, and later joiners start with a bit more to catch up for the weeks they missed.
- Every week, active players get an allowance.
- You also earn a weekly "CEO bonus" based on how much of your stock other people hold. Being widely held pays.

## Winning
- The leaderboard ranks everyone by growth: net worth ÷ (starting cash + allowances). Everyone starts at 1.00.
- Each week the whole prize pool is shared by the top three weekly growers: 60% to first, 25% to second and 15% to third. If fewer than three people qualify, the shares are scaled up so the whole pool still gets paid out.
- Each week also hands out awards, just for bragging rights: Biggest Mover, Bag Holder, Diamond Hands, Most Reacted Post and Worst Take. They show up as badges on your profile.

## Going bankrupt
- If you can't afford to buy back a short, your shares are sold to cover it. If that still isn't enough, you're bankrupt: you sit out until the next weekly close. Your stock stays tradable while you're out.

## Going quiet
- If you don't sign in or trade for a few weeks you're marked idle: no allowance or bonus, and you drop off the ranking. Your stock stays tradable. Signing in brings you straight back.

## The feed
- Every trade shows up automatically. You can post alongside a trade, tag a post to a person, or just post your thoughts.
- Stories can be true or made up. That's part of the game. Work out for yourself what's worth trading on.

## Staying in the loop
- Set price alerts on any stock page, like "tell me when James drops below £50". You'll get a notification in the app, and on Discord if you want.
- Big trades, new listings, record highs and lows and the weekly results are posted to our Discord. Add your Discord ID on your profile to get tagged when someone trades your stock.

## Fair play
- Admins can moderate posts and, rarely, remove a player who wants out.
- Have fun and don't be a jerk.`;

/**
 * The change log written before the dev diary existed, newest first. Each
 * "# " heading is one entry; an optional "Date: YYYY-MM-DD" line under it
 * sets its date. Shown (split into entries) until the first diary entry is
 * created, and importable as entries from the Admin page.
 */
export const DEFAULT_CHANGELOG = `# Change log

# Profiles, awards and Discord
Date: 2026-10-28

## Pick your ticker
Every stock now has a ticker, like $JOE. You've been given one from your name, and you can change it on your stock page.

## Ticker tape and countdown
Prices scroll across the top of every page, next to a countdown to the weekly close and who's winning the week right now.

## Player profiles
Tap anyone's name to see their profile: badges, net worth over time, weekly results and their best and worst calls.

## Weekly awards
Every close now hands out Biggest Mover, Bag Holder, Diamond Hands, Most Reacted Post and Worst Take. Win one and it becomes a badge on your profile.

## Weekly results
After each close you'll see where you finished, who won and the awards. Win the week or take #1 on the leaderboard and there's confetti.

## Welcome back
Been away for a couple of days? You'll get a quick catch-up: how your net worth and rank changed, and who bought or shorted you while you were gone.

## Price alerts
Set an alert on any stock page, like "tell me when James drops below £50". The new bell at the top tells you when it happens.

## Discord
Big trades, shorts, new listings, record highs and lows, bankruptcies and the weekly results now post to our Discord. Add your Discord ID on your profile to get tagged when someone trades your stock.

## Better on your phone
A new tab bar along the bottom, and you can now install Stonker like an app. On iPhone tap Share, then Add to Home Screen. On Android tap Install app.

## Light mode and sounds
Tap your picture, then Preferences, to switch between light, dark or match your phone. You can turn on sounds there too (they're off unless you do).

## A livelier feed
Trade cards show the ticker, how much the price moved and a mini price chart. Reactions animate, and the feed comes in pages.

## More charts
See where your money is on your Portfolio, who owns each stock on its page, and the market index and money flow on Reports. Drag across any chart to see its values.

## Prize split
The weekly prize is now shared by the top three: 60% to first, 25% to second and 15% to third.

## Fairer shorts
A short that's losing money now counts against your net worth straight away. Profits still only count once you close.

# Short selling is here
Date: 2026-10-20

You can now bet that someone's stock will go down, not just up.

Open a short and you sell shares you don't own at today's price, pocketing the cash now. Later you close it by buying those shares back — if the price dropped, you buy back cheaper and keep the difference. If it went up, you take the loss. You can short anyone except yourself.

## The details:

You can short up to half your capital (your cash plus the value of what you hold).

A small weekly fee is charged on any short you keep open, so shorts are meant for a view, not for sitting on forever.

Close whenever you like, whether you're up or down — you're never trapped.

A short's profit only counts toward the leaderboard once you've closed it, so nobody can open a last-minute short to inflate their net worth and swoop the weekly prize.

Attach a post when you open or close, to tell everyone why.

Fair warning: if a stock you've shorted rockets and you can't afford to buy back, you can go bankrupt — your assets get sold off to cover it.

# Welcome to Stonker
Date: 2026-10-20

The game is now called Stonker. New name across the whole site.

## See how each of your stocks is doing

Your Portfolio now shows your profit or loss on every stock you hold — how much it's up or down since you bought it, in pounds and as a percentage. Tap a holding to see its value over time as a graph.

## Your net worth over time

Your Portfolio has a graph tracking your total net worth week by week, so you can watch your progress.

## A Rules page

New players can read how the game works, straight from the menu.

## A Change log page

This page — where you'll see what's new whenever something changes.

## Clearer posting

When you write a post you can now clearly tag who it's about, and the box shows who the post is about before you share it.

## Use your real name

The sign-up screen now asks you to register with your real name.

## Bankruptcy rule

If a player ever ends up owing more than they can cover from their cash and shares, their account is deactivated and whatever they have is shared out among the people they owe. Their stock stays tradable, so others can still buy and sell it, and they come back at the start of the next week. (This is groundwork for future features like borrowing and short selling, so it won't affect anyone yet.)`;

export function defaultContent(): SiteContent {
  return { rules: DEFAULT_RULES, changelog: DEFAULT_CHANGELOG, updatedAt: 0 };
}

/** Max length for each editable content field. */
export const MAX_CONTENT_LENGTH = 20000;

// ---------- Dev diary ----------

/** Stored at devlog/{id}. One update post; the body uses the same markup as the Rules page. */
export interface DevlogEntry {
  id: string;
  title: string;
  body: string;
  /** The date shown on the entry (epoch ms, noon UTC of that day). Entries sort by this, newest first. */
  date: number;
  createdAt: number;
  updatedAt: number;
}

export const MAX_DEVLOG_TITLE = 100;

/** "2026-10-28" → noon UTC that day, so it shows as the same date in every UK/EU timezone. */
export function devlogDateFromIso(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const d = new Date(t);
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null;
}

export function devlogDateToIso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export type DevlogCheck = { ok: true; title: string; body: string } | { ok: false; error: string };

export function validateDevlogEntry(title: unknown, body: unknown, date: unknown): DevlogCheck {
  if (typeof title !== "string" || title.trim().length === 0) return { ok: false, error: "Give the entry a title." };
  if (title.trim().length > MAX_DEVLOG_TITLE) return { ok: false, error: `Keep the title under ${MAX_DEVLOG_TITLE} characters.` };
  if (typeof body !== "string" || body.trim().length === 0) return { ok: false, error: "Write something in the entry." };
  if (body.length > MAX_CONTENT_LENGTH) return { ok: false, error: `Keep the entry under ${MAX_CONTENT_LENGTH} characters.` };
  // 2020 → 2100: catches typos and nonsense without fussing.
  if (typeof date !== "number" || !Number.isFinite(date) || date < Date.UTC(2020, 0, 1) || date > Date.UTC(2100, 0, 1)) {
    return { ok: false, error: "Pick a valid date." };
  }
  return { ok: true, title: title.trim().replace(/\s+/g, " "), body: body.trim() };
}

/** Newest first; same-day entries by when they were created. */
export function sortDevlog<T extends Pick<DevlogEntry, "date" | "createdAt">>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.date - a.date || b.createdAt - a.createdAt);
}

/** First paragraph of plain text in the body, for the list view. */
export function devlogExcerpt(body: string, max = 160): string {
  const line = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#") && !/^Date:/i.test(l));
  const text = (line ?? "").replace(/^- /, "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Split a single-page change log into entries: each "# " heading starts one
 * (a leading "# Change log" title is skipped), and an optional
 * "Date: YYYY-MM-DD" line right under it sets its date. Keeps text order
 * (newest first).
 */
export function splitLegacyChangelog(text: string): { title: string; body: string; date: number | null }[] {
  const out: { title: string; body: string[]; date: number | null }[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) {
      const title = line.slice(2).trim().replace(/[.:]+$/, "");
      if (out.length === 0 && /^change ?log$/i.test(title)) continue;
      out.push({ title, body: [], date: null });
      continue;
    }
    const cur = out.at(-1);
    if (!cur) continue;
    const dateLine = /^Date:\s*(\d{4}-\d{2}-\d{2})\s*$/i.exec(line);
    if (dateLine && cur.body.every((l) => l.trim() === "")) {
      cur.date = devlogDateFromIso(dateLine[1]);
      continue;
    }
    cur.body.push(line);
  }
  return out
    .map((e) => ({ title: e.title.slice(0, MAX_DEVLOG_TITLE), body: e.body.join("\n").trim(), date: e.date }))
    .filter((e) => e.title && e.body);
}
