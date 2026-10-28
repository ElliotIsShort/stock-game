/**
 * Weekly awards, computed at the close and stored on the report. They become
 * badges on player profiles. Pure; the close supplies the week's data.
 */

export type AwardKey = "biggestMover" | "bagHolder" | "diamondHands" | "mostReacted" | "worstTake";

export const AWARD_META: Record<AwardKey, { title: string; emoji: string; blurb: string }> = {
  biggestMover: { title: "Biggest Mover", emoji: "🚀", blurb: "Their stock moved the most this week" },
  bagHolder: { title: "Bag Holder", emoji: "💼", blurb: "Biggest paper loss on a single holding" },
  diamondHands: { title: "Diamond Hands", emoji: "💎", blurb: "Held a position the longest without selling" },
  mostReacted: { title: "Most Reacted Post", emoji: "🔥", blurb: "The post with the most reactions" },
  worstTake: { title: "Worst Take", emoji: "👎", blurb: "The post with the most 👎" },
};
export const AWARD_KEYS = Object.keys(AWARD_META) as AwardKey[];

export interface Award {
  key: AwardKey;
  title: string;
  emoji: string;
  playerId: string;
  name: string;
  /** Short human summary, e.g. "+42.1% ($JOE)". */
  detail: string;
  /** The number the award was decided on (for sorting / display). */
  value: number;
  stockId?: string;
  postId?: string;
}

export interface AwardInputs {
  /** Week start; Diamond Hands needs to have held since before this. */
  weekStartedAt: number;
  now: number;
  nameOf: (uid: string) => string | undefined;
  tickerOf: (stockId: string) => string;
  stocks: { id: string; name: string; weekOpenPrice: number; price: number }[];
  /** Holdings with a known cost basis, marked at current price. */
  holdings: { uid: string; stockId: string; shares: number; costBasis: number; holdingSince: number; price: number }[];
  /** This week's non-system posts. */
  posts: { id: string; authorId: string; text: string; reactionCount: number; down: number; createdAt: number }[];
}

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const DAY_MS = 86_400_000;
/** Ignore holdings worth less than this (dust). */
const MIN_HOLDING_VALUE = 1;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return `"${flat.length > 60 ? `${flat.slice(0, 59)}…` : flat}"`;
}

function make(key: AwardKey, a: Omit<Award, "key" | "title" | "emoji">): Award {
  return { key, title: AWARD_META[key].title, emoji: AWARD_META[key].emoji, ...a };
}

/** Best by `score` (higher wins), ties to the earliest `tie`. */
function best<T>(items: T[], score: (t: T) => number, tie: (t: T) => number): T | undefined {
  let out: T | undefined;
  for (const it of items) {
    if (!out || score(it) > score(out) || (score(it) === score(out) && tie(it) < tie(out))) out = it;
  }
  return out;
}

export function computeAwards(inp: AwardInputs): Award[] {
  const awards: Award[] = [];
  const name = (uid: string) => inp.nameOf(uid) ?? "Unknown";

  const movers = inp.stocks
    .filter((s) => s.weekOpenPrice > 0 && inp.nameOf(s.id) !== undefined)
    .map((s) => ({ s, move: s.price / s.weekOpenPrice - 1 }))
    .filter((m) => Math.abs(m.move) > 1e-6);
  const mover = best(movers, (m) => Math.abs(m.move), () => 0);
  if (mover) {
    awards.push(make("biggestMover", { playerId: mover.s.id, name: name(mover.s.id), stockId: mover.s.id, value: mover.move, detail: `${pct(mover.move)} ($${inp.tickerOf(mover.s.id)})` }));
  }

  const live = inp.holdings.filter((h) => h.shares * h.price >= MIN_HOLDING_VALUE && inp.nameOf(h.uid) !== undefined);
  const losers = live.map((h) => ({ h, loss: h.costBasis - h.shares * h.price })).filter((x) => x.loss > 0.005);
  const bag = best(losers, (x) => x.loss, (x) => x.h.holdingSince);
  if (bag) {
    const lossPct = bag.h.costBasis > 0 ? -bag.loss / bag.h.costBasis : 0;
    awards.push(make("bagHolder", { playerId: bag.h.uid, name: name(bag.h.uid), stockId: bag.h.stockId, value: bag.loss, detail: `down ${money(bag.loss)} on $${inp.tickerOf(bag.h.stockId)} (${pct(lossPct)})` }));
  }

  const holders = live.filter((h) => h.holdingSince <= inp.weekStartedAt);
  const diamond = best(holders, (h) => -h.holdingSince, (h) => -h.shares * h.price);
  if (diamond) {
    const days = Math.max(1, Math.floor((inp.now - diamond.holdingSince) / DAY_MS));
    awards.push(make("diamondHands", { playerId: diamond.uid, name: name(diamond.uid), stockId: diamond.stockId, value: days, detail: `held $${inp.tickerOf(diamond.stockId)} for ${days} day${days === 1 ? "" : "s"} without selling` }));
  }

  const authored = inp.posts.filter((p) => inp.nameOf(p.authorId) !== undefined);
  const loved = best(authored.filter((p) => p.reactionCount > 0), (p) => p.reactionCount, (p) => p.createdAt);
  if (loved) {
    awards.push(make("mostReacted", { playerId: loved.authorId, name: name(loved.authorId), postId: loved.id, value: loved.reactionCount, detail: `${quote(loved.text)}, ${loved.reactionCount} reaction${loved.reactionCount === 1 ? "" : "s"}` }));
  }
  const worst = best(authored.filter((p) => p.down > 0), (p) => p.down, (p) => p.createdAt);
  if (worst) {
    awards.push(make("worstTake", { playerId: worst.authorId, name: name(worst.authorId), postId: worst.id, value: worst.down, detail: `${quote(worst.text)}, ${worst.down} 👎` }));
  }
  return awards;
}

export interface BadgeCount {
  key: AwardKey | "weeklyWin" | "podium" | "founder";
  title: string;
  emoji: string;
  count: number;
  /** Weeks it was earned, newest first. */
  weeks: number[];
}

/** Profile badges from stored reports: weekly wins, podiums and awards, plus Founder. */
export function badgesFor(
  uid: string,
  reports: { week: number; winners: { playerId: string }[]; awards?: Award[] }[],
  joinWeek: number,
): BadgeCount[] {
  const map = new Map<BadgeCount["key"], BadgeCount>();
  const add = (key: BadgeCount["key"], title: string, emoji: string, week: number) => {
    const b = map.get(key) ?? { key, title, emoji, count: 0, weeks: [] };
    b.count++;
    b.weeks.push(week);
    map.set(key, b);
  };
  const ordered = [...reports].sort((a, b) => b.week - a.week);
  for (const r of ordered) {
    const place = r.winners.findIndex((w) => w.playerId === uid);
    if (place === 0) add("weeklyWin", "Weekly winner", "🏆", r.week);
    else if (place > 0) add("podium", "Prize winner", "🥈", r.week);
    for (const a of r.awards ?? []) if (a.playerId === uid) add(a.key, a.title, a.emoji, r.week);
  }
  const out = [...map.values()];
  if (joinWeek === 1) out.push({ key: "founder", title: "Founder", emoji: "🌱", count: 1, weeks: [1] });
  return out;
}
