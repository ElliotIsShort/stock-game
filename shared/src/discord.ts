/**
 * Discord webhook messages. Pure: builders return a `DiscordMessage` that is
 * stored in the outbox, and `renderWebhookBody` turns it into the JSON Discord
 * expects at send time, resolving `{@uid}` tokens into @mentions for players
 * who linked their Discord ID (or their bold name if they haven't).
 *
 * Mentions only ping from `ping` (the message content). `allowed_mentions`
 * lists exactly the users we resolved, so @everyone/@here or a stray
 * <@id> in someone's post can never ping anyone.
 */

export interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordMessage {
  /** Text above the embed; the only part that pings. May contain {@uid} tokens. */
  ping?: string;
  title: string;
  description?: string;
  fields?: DiscordField[];
  /** 0xRRGGBB. */
  color: number;
}

export const DISCORD_COLOR = {
  up: 0x3fb950,
  down: 0xf85149,
  warn: 0xd29922,
  info: 0x58a6ff,
  award: 0xbc8cff,
} as const;

export interface MentionTarget {
  name: string;
  discordId?: string;
}

/** Discord user IDs are 17–20 digit snowflakes. */
export const DISCORD_ID_RE = /^\d{17,20}$/;

export function mention(uid: string): string {
  return `{@${uid}}`;
}

const TOKEN_RE = /\{@([A-Za-z0-9_-]{1,128})\}/g;

/** Make user-written text safe to embed: it can't smuggle in mention tokens, and stays a sensible length. */
export function escapeUserText(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim().replace(/\{@/g, "{ @");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Discord user IDs referenced by `{@uid}` tokens, for players who've linked one. */
function resolveTokens(text: string, resolve: (uid: string) => MentionTarget | undefined, pinged: Set<string>, ping: boolean): string {
  return text.replace(TOKEN_RE, (_, uid: string) => {
    const t = resolve(uid);
    if (!t) return "someone";
    if (t.discordId && DISCORD_ID_RE.test(t.discordId)) {
      if (ping) pinged.add(t.discordId);
      return `<@${t.discordId}>`;
    }
    return `**${t.name.replace(/[*_~`|]/g, "")}**`;
  });
}

export interface WebhookBody {
  username: string;
  content?: string;
  embeds: {
    title: string;
    description?: string;
    color: number;
    fields?: DiscordField[];
    timestamp?: string;
    footer?: { text: string };
  }[];
  allowed_mentions: { parse: never[]; users: string[] };
}

/** The JSON body to POST to the webhook. Respects Discord's length limits. */
export function renderWebhookBody(msg: DiscordMessage, resolve: (uid: string) => MentionTarget | undefined, at?: number): WebhookBody {
  const pinged = new Set<string>();
  const content = msg.ping ? clip(resolveTokens(msg.ping, resolve, pinged, true), 2000) : undefined;
  const unpinged = new Set<string>();
  const embed: WebhookBody["embeds"][0] = {
    title: clip(resolveTokens(msg.title, resolve, unpinged, false), 256),
    color: msg.color,
    footer: { text: "Stonker" },
  };
  if (msg.description) embed.description = clip(resolveTokens(msg.description, resolve, unpinged, false), 4000);
  if (msg.fields?.length) {
    embed.fields = msg.fields.slice(0, 25).map((f) => ({
      name: clip(resolveTokens(f.name, resolve, unpinged, false), 256),
      value: clip(resolveTokens(f.value, resolve, unpinged, false), 1024) || "—",
      ...(f.inline ? { inline: true } : {}),
    }));
  }
  if (at !== undefined) embed.timestamp = new Date(at).toISOString();
  return {
    username: "Stonker",
    ...(content ? { content } : {}),
    embeds: [embed],
    allowed_mentions: { parse: [], users: [...pinged].slice(0, 100) },
  };
}

/** One message summarising routine posts that were held back by the rate limit. Never pings. */
export function digestMessage(items: DiscordMessage[]): DiscordMessage {
  const lines = items.map((m) => `• ${m.title}`);
  const shown: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (length + line.length + 1 > 3800) break;
    shown.push(line);
    length += line.length + 1;
  }
  const more = lines.length - shown.length;
  return {
    title: `Busy market: ${items.length} more update${items.length === 1 ? "" : "s"}`,
    description: shown.join("\n") + (more > 0 ? `\n…and ${more} more` : ""),
    color: DISCORD_COLOR.info,
  };
}

// ---------- Rate limiting ----------

export interface DiscordRateState {
  /** Start of the current hour bucket (epoch ms). */
  windowStart: number;
  sent: number;
}

const HOUR_MS = 3_600_000;

/** Whether a routine post may go out now, and the rate state to store if it does. Fixed hourly buckets. */
export function rateDecision(state: DiscordRateState | undefined, now: number, maxPerHour: number): { allow: boolean; next: DiscordRateState } {
  const windowStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const sent = state && state.windowStart === windowStart ? state.sent : 0;
  if (sent >= maxPerHour) return { allow: false, next: { windowStart, sent } };
  return { allow: true, next: { windowStart, sent: sent + 1 } };
}

// ---------- Message builders ----------

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signedPct = (n: number) => `${n > 0 ? "▲ +" : n < 0 ? "▼ " : ""}${(n * 100).toFixed(1)}%`;

export type TradeKind = "buy" | "sell" | "openShort" | "closeShort";

export function bigTradeMessage(t: {
  kind: TradeKind;
  traderName: string;
  ownerId: string;
  stockName: string;
  ticker: string;
  cash: number;
  shares: number;
  priceBefore: number;
  priceAfter: number;
  postText?: string | null;
}): DiscordMessage {
  const move = t.priceAfter / t.priceBefore - 1;
  const phrase = {
    buy: `just bought ${money(t.cash)} of your stock`,
    sell: `just sold ${money(t.cash)} of your stock`,
    openShort: `just opened a ${money(t.cash)} short on you`,
    closeShort: `just covered a ${money(t.cash)} short on you`,
  }[t.kind];
  const label = { buy: "Big buy", sell: "Big sell", openShort: "Big short", closeShort: "Short covered" }[t.kind];
  const verb = { buy: "bought", sell: "sold", openShort: "shorted", closeShort: "bought back" }[t.kind];
  const lines = [
    `${t.traderName} ${verb} ${t.shares.toFixed(2)} shares of ${t.stockName} for ${money(t.cash)}`,
    `${money(t.priceBefore)} → ${money(t.priceAfter)}`,
  ];
  if (t.postText) lines.push(`> ${escapeUserText(t.postText)}`);
  return {
    ping: `${mention(t.ownerId)}, ${t.traderName} ${phrase}.`,
    title: `${label} · $${t.ticker} ${signedPct(move)}`,
    description: lines.join("\n"),
    color: t.kind === "buy" || t.kind === "closeShort" ? DISCORD_COLOR.up : DISCORD_COLOR.down,
  };
}

export function listingMessage(uid: string, name: string, ticker: string, price: number): DiscordMessage {
  return {
    ping: `Welcome to the market, ${mention(uid)}!`,
    title: `New listing: ${name} ($${ticker})`,
    description: `Listed at ${money(price)}. Get in early.`,
    color: DISCORD_COLOR.info,
  };
}

export function bankruptcyMessage(uid: string, name: string, debt: number, shortfall: number): DiscordMessage {
  return {
    ping: `${mention(uid)} has gone bankrupt.`,
    title: `💥 Bankrupt: ${name}`,
    description: `Couldn't cover a ${money(debt)} short buy-back (${money(shortfall)} short). Holdings liquidated; back in the game at the next weekly close.`,
    color: DISCORD_COLOR.down,
  };
}

export function recordMessage(ownerId: string, ticker: string, kind: "high" | "low", price: number): DiscordMessage {
  return {
    ping: `${mention(ownerId)}, your stock just hit an all-time ${kind}.`,
    title: `${kind === "high" ? "📈 All-time high" : "📉 All-time low"} · $${ticker} ${money(price)}`,
    color: kind === "high" ? DISCORD_COLOR.up : DISCORD_COLOR.down,
  };
}

export function alertMessage(uid: string, ticker: string, direction: "above" | "below", target: number, price: number): DiscordMessage {
  return {
    ping: `${mention(uid)}, $${ticker} is now ${direction} ${money(target)} (${money(price)}).`,
    title: `🔔 Price alert · $${ticker}`,
    color: direction === "above" ? DISCORD_COLOR.up : DISCORD_COLOR.down,
  };
}

export interface CloseMessageInput {
  week: number;
  prizePaid: number;
  winners: { playerId: string; growth: number; prizeAmount: number }[];
  index: number;
  indexChange: number | null;
  awards: { emoji: string; title: string; playerId: string; detail: string }[];
}

export function weeklyCloseMessage(r: CloseMessageInput): DiscordMessage {
  const medals = ["🥇", "🥈", "🥉"];
  const winnerLines = r.winners.map(
    (w, i) => `${medals[i] ?? `${i + 1}.`} ${mention(w.playerId)} ${(w.growth * 100).toFixed(2)}% · ${money(w.prizeAmount)}`,
  );
  const indexText = `${r.index.toFixed(1)}${r.indexChange === null ? "" : ` (${r.indexChange >= 0 ? "+" : ""}${r.indexChange.toFixed(1)})`}`;
  const fields: DiscordField[] = [{ name: "Market index", value: indexText, inline: true }];
  if (r.awards.length) {
    fields.push({ name: "Awards", value: r.awards.map((a) => `${a.emoji} **${a.title}**: ${mention(a.playerId)} (${a.detail})`).join("\n") });
  }
  return {
    ping: r.winners.length ? `Week ${r.week} winners: ${r.winners.map((w) => mention(w.playerId)).join(" ")} 🎉` : undefined,
    title: `🔔 Week ${r.week} closed`,
    description: r.winners.length
      ? `The ${money(r.prizePaid)} prize pool goes to:\n${winnerLines.join("\n")}`
      : "No eligible winner; the prize pool rolls over.",
    fields,
    color: DISCORD_COLOR.award,
  };
}

/** Every uid referenced by a {@uid} token in the message (to look up Discord IDs at send time). */
export function mentionUids(msg: DiscordMessage): string[] {
  const text = [msg.ping ?? "", msg.title, msg.description ?? "", ...(msg.fields ?? []).flatMap((f) => [f.name, f.value])].join("\n");
  return [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]))];
}

export function testMessage(adminId: string): DiscordMessage {
  return {
    ping: `Test from ${mention(adminId)}.`,
    title: "✅ Stonker is connected",
    description: "Big trades, listings, bankruptcies, record highs and lows, alerts and the weekly close will appear here.",
    color: DISCORD_COLOR.info,
  };
}
