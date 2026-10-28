import { describe, expect, it } from "vitest";
import {
  bigTradeMessage,
  digestMessage,
  escapeUserText,
  rateDecision,
  renderWebhookBody,
  weeklyCloseMessage,
  type MentionTarget,
} from "../src/discord";

const people: Record<string, MentionTarget> = {
  joe: { name: "Joe Bloggs", discordId: "123456789012345678" },
  kal: { name: "Kalen" },
};
const resolve = (uid: string) => people[uid];

describe("discord messages", () => {
  it("turns tokens into pings for linked players and bold names otherwise", () => {
    const body = renderWebhookBody({ ping: "{@joe} and {@kal} and {@ghost}", title: "Hi {@joe}", color: 1 }, resolve);
    expect(body.content).toBe("<@123456789012345678> and **Kalen** and someone");
    expect(body.allowed_mentions).toEqual({ parse: [], users: ["123456789012345678"] });
    // Mentions in the embed render but don't add to the ping list on their own.
    expect(body.embeds[0].title).toBe("Hi <@123456789012345678>");
  });

  it("never lets user text ping or inject tokens", () => {
    const text = escapeUserText("@everyone {@joe} look\n\nhere");
    expect(text).toBe("@everyone { @joe} look here");
    const body = renderWebhookBody({ title: "x", description: text, color: 1 }, resolve);
    expect(body.allowed_mentions.users).toEqual([]);
    expect(body.allowed_mentions.parse).toEqual([]);
    expect(escapeUserText("a".repeat(400)).length).toBe(300);
  });

  it("builds a big-trade message that pings the stock's owner", () => {
    const msg = bigTradeMessage({
      kind: "buy", traderName: "Kalen", ownerId: "joe", stockName: "Joe Bloggs", ticker: "JOE",
      cash: 420, shares: 8.4, priceBefore: 50, priceAfter: 56.15, postText: "divorce incoming {@joe}",
    });
    const body = renderWebhookBody(msg, resolve);
    expect(body.content).toBe("<@123456789012345678>, Kalen just bought £420.00 of your stock.");
    expect(body.embeds[0].title).toBe("Big buy · $JOE ▲ +12.3%");
    expect(body.embeds[0].description).toContain("> divorce incoming { @joe}");
  });

  it("summarises the weekly close with winners, index and awards", () => {
    const msg = weeklyCloseMessage({
      week: 4, prizePaid: 100, index: 112.3, indexChange: 2.1,
      winners: [{ playerId: "joe", growth: 0.123, prizeAmount: 60 }, { playerId: "kal", growth: 0.05, prizeAmount: 40 }],
      awards: [{ emoji: "🚀", title: "Biggest Mover", playerId: "kal", detail: "+40.0% ($KAL)" }],
    });
    const body = renderWebhookBody(msg, resolve);
    expect(body.content).toBe("Week 4 winners: <@123456789012345678> **Kalen** 🎉");
    expect(body.embeds[0].description).toContain("🥇 <@123456789012345678> 12.30% · £60.00");
    expect(body.embeds[0].fields?.[0]).toEqual({ name: "Market index", value: "112.3 (+2.1)", inline: true });
    expect(body.embeds[0].fields?.[1].value).toBe("🚀 **Biggest Mover**: **Kalen** (+40.0% ($KAL))");
  });

  it("digests held-back posts into one message", () => {
    const d = digestMessage([{ title: "A", color: 1 }, { title: "B", color: 1 }]);
    expect(d.title).toBe("Busy market: 2 more updates");
    expect(d.description).toBe("• A\n• B");
    expect(d.ping).toBeUndefined();
  });

  it("rate-limits routine posts per clock hour", () => {
    const h = 3_600_000;
    const t = 10 * h + 5;
    let s = rateDecision(undefined, t, 2);
    expect(s.allow).toBe(true);
    s = rateDecision(s.next, t + 1, 2);
    expect(s.allow).toBe(true);
    expect(rateDecision(s.next, t + 2, 2).allow).toBe(false);
    // A new hour resets the count.
    expect(rateDecision(s.next, 11 * h, 2)).toEqual({ allow: true, next: { windowStart: 11 * h, sent: 1 } });
    expect(rateDecision(undefined, t, 0).allow).toBe(false);
  });
});
