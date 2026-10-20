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
- Every trade pays a small fee into the weekly prize pool.
- Prices only ever move because people trade. Posts and reactions never move a price — it's up to you whether to act on them.

## Money in
- New players start with cash, and later joiners start with a bit more to catch up for the weeks they missed.
- Every week, active players get an allowance.
- You also earn a weekly "CEO bonus" based on how much of your stock other people hold — being widely held pays.

## Winning
- The leaderboard ranks everyone by growth: net worth ÷ (starting cash + allowances). Everyone starts at 1.00.
- Each week the whole prize pool goes to the player with the highest weekly growth.

## Going quiet
- If you don't sign in or trade for a few weeks you're marked idle: no allowance or bonus, and you drop off the ranking. Your stock stays tradable. Signing in brings you straight back.

## The feed
- Every trade shows up automatically. You can post alongside a trade, tag a post to a person, or just post your thoughts.
- Stories can be true or made up — that's part of the game. Work out for yourself what's worth trading on.

## Fair play
- Admins can moderate posts and, rarely, remove a player who wants out.
- Have fun and don't be a jerk.`;

export const DEFAULT_CHANGELOG = `# Change log

What's new in Stonker. Newest first.

## Short selling
- You can now bet against a stock. Open a short to sell shares you don't own; if the price falls you buy them back cheaper and keep the difference. You profit when a stock drops.
- You can short up to half your capital, and there's a small weekly fee while a short stays open. Close whenever you like.
- A short's profit only counts toward the leaderboard once you close it.

## Getting started
- The game is live: trading, the feed, posts and reactions, weekly close, the leaderboard and weekly reports.
- Add a photo to your stock from your Portfolio or stock page.
- See your wins and losses per stock, and your net worth over time, on your Portfolio.
- A Rules page and this Change log.`;

export function defaultContent(): SiteContent {
  return { rules: DEFAULT_RULES, changelog: DEFAULT_CHANGELOG, updatedAt: 0 };
}

/** Max length for each editable content field. */
export const MAX_CONTENT_LENGTH = 20000;
